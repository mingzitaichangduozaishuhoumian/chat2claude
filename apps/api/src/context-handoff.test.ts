import { afterEach, describe, expect, it } from 'vitest';
import type { ChatGptBackendClient, ChatGptBackendRequestContext, ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptDiscoveredModel, ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
import { createApp, type Chat2ClaudeApp } from './app.js';
import { loadEnv } from './config/env.js';
import type { AccountPool } from './services/account-pool.js';

const CIPHER = 'HANDOFF_PRIVATE_REASONING_CANARY';
const OWNER = 'handoff-owner';
const OTHER = 'other-owner';
const apps: Chat2ClaudeApp[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.dispose())); });

class Backend implements ChatGptBackendClient {
  calls: ChatGptCompletionRequest[] = [];
  mode: 'text' | 'tools' | 'unknown' | 'failed' = 'text';
  constructor(private label: string) {}
  async listModels(): Promise<ChatGptDiscoveredModel[]> {
    return ['native-model', 'other-native-model'].map((id) => ({ id, controls: {
      reasoning: { metadataKnown: true, supported: [{ effort: 'medium' }], defaultEffort: 'medium' },
      serviceTier: { metadataKnown: true, supported: [], fastMode: false },
    } }));
  }
  async complete(request: ChatGptCompletionRequest, _context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse> {
    this.calls.push(structuredClone(request));
    if (this.mode === 'failed') throw new Error('FAILED_TURN_CANARY');
    const reasoning = { type: 'reasoning' as const, id: 'rs_native', encrypted_content: CIPHER, summary: [] };
    if (this.mode === 'tools') {
      const call = { type: 'function_call' as const, id: 'fc_native', call_id: 'call_public', name: 'lookup', arguments: ' {"q":1} ' };
      return { text: '', terminalSuccessful: true, finishReason: 'tool_calls', toolCalls: [{ id: 'call_public', name: 'lookup', input: { q: 1 }, rawArguments: call.arguments }],
        outputItems: [reasoning, call], replayItems: [reasoning, call], replayEligible: true };
    }
    return { text: `${this.label} answer`, terminalSuccessful: true, finishReason: 'stop', outputItems: [
      reasoning, { type: 'message', id: `msg_${this.label}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `${this.label} answer`, annotations: [] }] },
    ] };
  }
  async *stream(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): AsyncIterable<ChatGptStreamEvent> {
    yield { type: 'upstream_ready' };
    const result = await this.complete(request, context);
    if (result.text) yield { type: 'text_delta', text: result.text };
    for (const toolCall of result.toolCalls ?? []) yield { type: 'tool_call', toolCall };
    yield { type: 'done', ...result };
  }
}

function fixture() {
  const codex = new Backend('codex');
  const web = new Backend('web');
  let pool!: AccountPool;
  const app = createApp(loadEnv({ CHATGPT_BACKEND: 'session', API_KEYS: `${OWNER},${OTHER}`, LOG_LEVEL: 'error', ACCOUNT_ACQUIRE_TIMEOUT_MS: '0' }), {
    runtimeStateStore: null, operationalState: null, webBackend: web,
    backendFactory(accountPool) { pool = accountPool; pool.add({ id: 'codex-account', provider: 'chatgpt-session' }); return codex; },
  });
  apps.push(app);
  const headers = (owner = OWNER) => ({ 'content-type': 'application/json', 'x-api-key': owner });
  const configure = (contextHandoff = true) => app.request('/admin/api/backend-routing', { method: 'PATCH', headers: headers(), body: JSON.stringify({
    contextHandoff, mode: 'auto', webEnabled: true, gateway: { baseUrl: 'http://gateway.test', models: ['web-model'], supportsTools: true, modelMappings: { sonnet: 'web-model' } },
  }) });
  const send = (backend: 'codex' | 'web', extra: Record<string, unknown> = {}, owner = OWNER, endpoint = '/v1/responses') => app.request(endpoint, {
    method: 'POST', headers: { ...headers(owner), 'x-chat2claude-backend': backend }, body: JSON.stringify({
      model: 'sonnet', max_output_tokens: 32, input: 'inspect project', ...extra,
    }),
  });
  return { app, pool, codex, web, configure, send };
}

describe('owner-scoped public context handoff through API routes', () => {
  it('continues Responses on web and back to Codex using public messages while keeping native continuation intact', async () => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    const first = await f.send('codex');
    expect(first.status).toBe(200);
    const initial = await first.json() as { id: string };
    const native = await f.send('codex', { previous_response_id: initial.id, input: 'same backend' });
    expect(native.status).toBe(200);
    expect(JSON.stringify(f.codex.calls[1])).toContain(CIPHER);
    const handoff = await f.send('web', { previous_response_id: initial.id, input: 'continue on web' });
    expect(handoff.status).toBe(200);
    const webResponse = await handoff.json() as { id: string };
    expect(JSON.stringify(f.web.calls[0])).toContain('codex answer');
    expect(JSON.stringify(f.web.calls[0])).not.toMatch(/HANDOFF_PRIVATE|rs_native|msg_codex|encrypted_content/);
    expect(f.web.calls[0].model).toBe('web-model');
    const back = await f.send('codex', { previous_response_id: webResponse.id, input: 'finish work' });
    expect(back.status).toBe(200);
    expect(JSON.stringify(f.codex.calls[2])).toContain('web answer');
    expect(JSON.stringify(f.codex.calls[2])).not.toContain(CIPHER);
    expect(f.codex.calls).toHaveLength(3);
    expect(f.web.calls).toHaveLength(1);
  });

  it('keeps default provider affinity and isolates every stored history by API owner', async () => {
    const f = fixture();
    expect((await f.configure(false)).status).toBe(200);
    const first = await f.send('codex');
    const initial = await first.json() as { id: string };
    expect((await f.send('web', { previous_response_id: initial.id, input: 'blocked' })).status).toBe(503);
    expect((await f.configure()).status).toBe(200);
    expect((await f.send('web', { previous_response_id: initial.id, input: 'wrong owner' }, OTHER)).status).toBe(404);
    expect(f.web.calls).toHaveLength(0);
  });

  it('permits an explicit model switch on the same provider using only visible history', async () => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    const first = await f.send('codex');
    const { id } = await first.json() as { id: string };
    const next = await f.send('codex', { model: 'other-native-model', previous_response_id: id, input: 'different model' });
    expect(next.status).toBe(200);
    expect(f.codex.calls[1].model).toBe('other-native-model');
    expect(JSON.stringify(f.codex.calls[1])).not.toContain(CIPHER);
  });

  it('requires complete tool result sets and preserves public tool IDs and argument bytes on Responses handoff', async () => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    f.codex.mode = 'tools';
    const first = await f.send('codex');
    const { id } = await first.json() as { id: string };
    expect((await f.send('web', { previous_response_id: id, input: 'missing tool result' })).status).toBe(503);
    const next = await f.send('web', { previous_response_id: id, input: [{ type: 'function_call_output', call_id: 'call_public', output: 'file content' }] });
    expect(next.status).toBe(200);
    expect(f.web.calls[0].inputItems).toContainEqual({ type: 'replay', item: expect.objectContaining({ type: 'function_call', call_id: 'call_public', arguments: ' {"q":1} ' }) });
    expect(f.web.calls[0].inputItems).toContainEqual({ type: 'function_call_output', callId: 'call_public', output: 'file content' });
    expect(JSON.stringify(f.web.calls[0])).not.toMatch(/HANDOFF_PRIVATE|rs_native|fc_native/);
    expect(f.web.calls).toHaveLength(1);
  });

  it.each(['/v1/messages', '/v1/chat/completions'])('hands a completed implicit tool cycle from Codex to web without private replay at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    f.codex.mode = 'tools';
    const tool = endpoint === '/v1/messages' ? { name: 'lookup', input_schema: { type: 'object' } }
      : { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } };
    const first = await f.send('codex', { max_tokens: 32, messages: [{ role: 'user', content: 'inspect project' }], tools: [tool] }, OWNER, endpoint);
    expect(first.status).toBe(200);
    await first.text();
    const messages = endpoint === '/v1/messages' ? [
      { role: 'user', content: 'inspect project' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_public', name: 'lookup', input: { q: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_public', content: 'file content' }] },
    ] : [
      { role: 'user', content: 'inspect project' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_public', type: 'function', function: { name: 'lookup', arguments: ' {"q":1} ' } }] },
      { role: 'tool', tool_call_id: 'call_public', content: 'file content' },
    ];
    const next = await f.send('web', { max_tokens: 32, messages, tools: [tool] }, OWNER, endpoint);
    expect(next.status).toBe(200);
    expect(f.web.calls).toHaveLength(1);
    expect(JSON.stringify(f.web.calls[0])).not.toContain(CIPHER);
    expect(f.web.calls[0].inputItems).toContainEqual(expect.objectContaining({ type: 'function_call', callId: 'call_public' }));
    expect(f.codex.calls).toHaveLength(1);
  });

  it('never publishes a previous response ID or transferable history for a failed turn', async () => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    f.codex.mode = 'failed';
    const response = await f.send('codex');
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.text();
    expect(body).not.toContain('FAILED_TURN_CANARY');
    expect(body).not.toMatch(/resp_[A-Za-z0-9]/);
    expect(f.web.calls).toHaveLength(0);
  });
});
