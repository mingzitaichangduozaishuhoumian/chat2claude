import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChatGptBackendError,
  WebGatewayChatGptBackend,
  type ChatGptBackendClient,
  type ChatGptBackendRequestContext,
  type ChatGptCompletionRequest,
  type ChatGptCompletionResponse,
  type ChatGptDiscoveredModel,
  type ChatGptStreamEvent,
} from '@chatgpt-to-claude/chatgpt-backend';
import { createApp, type Chat2ClaudeApp } from './app.js';
import { loadEnv } from './config/env.js';
import type { AccountPool } from './services/account-pool.js';
import { WEB_GATEWAY_ACCOUNT_ID } from './services/web-gateway-account.js';
import { RuntimeStateStore } from './services/runtime-state-store.js';

const MODEL = 'shared-text-model';
const KEY = 'test-admin-key';
const applications: Chat2ClaudeApp[] = [];
const directories: string[] = [];
const endpoints = ['/v1/messages', '/v1/chat/completions', '/v1/responses'] as const;
type Endpoint = typeof endpoints[number];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.dispose()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class SyntheticBackend implements ChatGptBackendClient {
  readonly calls: Array<{ request: ChatGptCompletionRequest; accountId?: string; provider?: string; stream: boolean }> = [];
  failStream = false;
  reasoningEffort?: string;

  constructor(readonly channel: 'codex' | 'web') {}

  async listModels(): Promise<ChatGptDiscoveredModel[]> {
    return [{ id: MODEL, controls: {
      reasoning: { metadataKnown: true, supported: this.reasoningEffort ? [{ effort: this.reasoningEffort }] : [], ...(this.reasoningEffort ? { defaultEffort: this.reasoningEffort } : {}) },
      serviceTier: { metadataKnown: true, supported: [], fastMode: false },
    } }];
  }

  async complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse> {
    this.record(request, context, false);
    return { text: `${this.channel} answer`, finishReason: 'stop', terminalSuccessful: true };
  }

  async *stream(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): AsyncIterable<ChatGptStreamEvent> {
    this.record(request, context, true);
    yield { type: 'upstream_ready' };
    yield { type: 'text_delta', text: `${this.channel} partial` };
    if (this.failStream) throw new ChatGptBackendError('Synthetic stream failure.', 'upstream_error', { status: 503 });
    yield { type: 'done', finishReason: 'stop', terminalSuccessful: true };
  }

  private record(request: ChatGptCompletionRequest, context: ChatGptBackendRequestContext | undefined, stream: boolean) {
    this.calls.push({ request: structuredClone(request), accountId: context?.account?.id, provider: context?.account?.provider, stream });
  }
}

function fixture(withCodex = true, runtimeStateStore: RuntimeStateStore | null = null, webBackend?: ChatGptBackendClient, codexReasoningEffort?: string, environment: NodeJS.ProcessEnv = {}) {
  const codex = new SyntheticBackend('codex');
  codex.reasoningEffort = codexReasoningEffort;
  const web = new SyntheticBackend('web');
  let pool!: AccountPool;
  const app = createApp(loadEnv({ CHATGPT_BACKEND: 'session', API_KEYS: KEY, LOG_LEVEL: 'error', ACCOUNT_ACQUIRE_TIMEOUT_MS: '0', ...environment }), {
    runtimeStateStore,
    operationalState: null,
    webBackend: webBackend ?? web,
    backendFactory(accountPool) {
      pool = accountPool;
      if (withCodex) pool.add({ id: 'synthetic-codex', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'SYNTHETIC_TOKEN' } });
      return codex;
    },
  });
  applications.push(app);
  const patch = (body: unknown) => app.request('http://api.test:3000/admin/api/backend-routing', {
    method: 'PATCH', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(body),
  });
  const configure = (mode: 'auto' | 'codex' | 'web' = 'auto', supportsTools = false) => patch({
    mode, autoPreference: 'codex', gateway: { baseUrl: 'http://gateway.test:8090/v1', apiKey: 'PRIVATE_GATEWAY_KEY', models: [MODEL], supportsTools },
  });
  const request = (endpoint: Endpoint, mode?: string, extra: Record<string, unknown> = {}) => app.request(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY, ...(mode === undefined ? {} : { 'x-chat2claude-backend': mode }) },
    body: JSON.stringify({ ...payload(endpoint), ...extra }),
  });
  return { app, codex, web, pool, patch, configure, request };
}

function payload(endpoint: Endpoint): Record<string, unknown> {
  return endpoint === '/v1/responses' ? { model: MODEL, input: 'hello', max_output_tokens: 16 }
    : { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] };
}

function toolPayload(endpoint: Endpoint): unknown[] {
  const parameters = { type: 'object', properties: { query: { type: 'string' } } };
  if (endpoint === '/v1/messages') return [{ name: 'lookup', input_schema: parameters }];
  if (endpoint === '/v1/responses') return [{ type: 'function', name: 'lookup', parameters }];
  return [{ type: 'function', function: { name: 'lookup', parameters } }];
}

it('keeps an explicitly disabled gateway disabled when its credentials change', async () => {
  const f = fixture(false);
  expect((await f.configure('web')).status).toBe(200);
  f.pool.update(WEB_GATEWAY_ACCOUNT_ID, { enabled: false });
  expect((await f.patch({ gateway: { apiKey: 'REPLACEMENT_GATEWAY_KEY' } })).status).toBe(200);
  expect(f.pool.get(WEB_GATEWAY_ACCOUNT_ID)?.enabled).toBe(false);
  expect((await f.request('/v1/chat/completions')).status).toBe(503);
  expect(f.web.calls).toHaveLength(0);
});

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Record<string, unknown>;
}

describe('web gateway routing through the application', () => {
  it.each(['codex', 'auto'])('binds sonnet to the discovered Codex model before an environment gateway auto model in %s mode', async (mode) => {
    const f = fixture(true, null, undefined, 'medium', {
      CHATGPT_ROUTING_MODE: mode,
      CHATGPT_WEB_BASE_URL: 'http://gateway.test:8090',
      CHATGPT_WEB_MODELS: 'auto',
    });
    const response = await f.request('/v1/messages', undefined, { model: 'sonnet' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('codex');
    expect(f.codex.calls).toHaveLength(1);
    expect(f.codex.calls[0].request).toMatchObject({ model: MODEL, reasoningEffort: 'medium' });
    expect(f.web.calls).toHaveLength(0);
  });

  it.each(endpoints)('honors manual channel overrides and selects Codex first in auto at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    for (const mode of ['web', 'codex', 'auto'] as const) {
      const response = await f.request(endpoint, mode);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-chat2claude-backend')).toBe(mode === 'web' ? 'web' : 'codex');
      expect(await response.text()).toContain(mode === 'web' ? 'web answer' : 'codex answer');
    }
    expect(f.codex.calls).toHaveLength(2);
    expect(f.web.calls).toHaveLength(1);
    expect(f.web.calls[0]).toMatchObject({ accountId: WEB_GATEWAY_ACCOUNT_ID, provider: 'chatgpt-web', request: { model: MODEL } });
    expect(f.codex.calls[0]).toMatchObject({ accountId: 'synthetic-codex', provider: 'chatgpt-session' });
  });

  it.each(endpoints)('automatically uses the web gateway when Codex is busy or disabled at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    const lease = f.pool.acquire({ provider: 'chatgpt-session' });
    expect(lease?.id).toBe('synthetic-codex');
    try {
      const busy = await f.request(endpoint);
      expect(busy.status).toBe(200);
      expect(busy.headers.get('x-chat2claude-backend')).toBe('web');
      await busy.text();
    } finally { if (lease) f.pool.release(lease); }
    f.pool.update('synthetic-codex', { enabled: false });
    const disabled = await f.request(endpoint);
    expect(disabled.status).toBe(200);
    expect(disabled.headers.get('x-chat2claude-backend')).toBe('web');
    expect(f.web.calls).toHaveLength(2);
    expect(f.codex.calls).toHaveLength(0);
  });

  it.each(endpoints)('filters unsupported tools in auto and rejects a forced web request at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    const auto = await f.request(endpoint, 'auto', { tools: toolPayload(endpoint) });
    expect(auto.status).toBe(200);
    expect(auto.headers.get('x-chat2claude-backend')).toBe('codex');
    const manual = await f.request(endpoint, 'web', { tools: toolPayload(endpoint) });
    expect(manual.status).toBe(400);
    expect(f.codex.calls).toHaveLength(1);
    expect(f.web.calls).toHaveLength(0);
  });

  it.each(endpoints)('allows explicitly configured tool support through the web gateway at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure('web', true)).status).toBe(200);
    const response = await f.request(endpoint, undefined, { tools: toolPayload(endpoint) });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('web');
    expect(f.web.calls[0].request.tools).toEqual([expect.objectContaining({ name: 'lookup' })]);
    expect(f.codex.calls).toHaveLength(0);
  });

  it.each(endpoints)('resolves implicit alias reasoning per channel while retaining explicit requirements at %s', async (endpoint) => {
    const f = fixture(true, null, undefined, 'medium');
    expect((await f.configure()).status).toBe(200);
    const primary = await f.request(endpoint, 'codex', { model: 'sonnet' });
    expect(primary.status).toBe(200);
    expect(f.codex.calls[0].request.reasoningEffort).toBe('medium');
    const manual = await f.request(endpoint, 'web', { model: 'sonnet' });
    expect(manual.status).toBe(200);
    expect(manual.headers.get('x-chat2claude-backend')).toBe('web');
    expect(f.web.calls[0].request.reasoningEffort).toBeUndefined();
    f.pool.update('synthetic-codex', { enabled: false });
    const auto = await f.request(endpoint, 'auto', { model: 'sonnet' });
    expect(auto.status).toBe(200);
    expect(auto.headers.get('x-chat2claude-backend')).toBe('web');
    expect(f.web.calls[1].request.reasoningEffort).toBeUndefined();
    const explicit = { model: 'sonnet', reasoning_effort: 'medium' };
    expect((await f.request(endpoint, 'web', explicit)).status).toBeGreaterThanOrEqual(400);
    expect((await f.request(endpoint, 'auto', explicit)).status).toBe(503);
    expect(f.web.calls).toHaveLength(2);
    expect(f.codex.calls).toHaveLength(1);
  });

  it('keeps exact model IDs when selecting a channel instead of substituting a different model', async () => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    expect((await f.patch({ gateway: { models: ['web-only-model'] } })).status).toBe(200);
    const primary = await f.request('/v1/messages', 'auto');
    expect(primary.status).toBe(200);
    expect(primary.headers.get('x-chat2claude-backend')).toBe('codex');
    expect((await f.request('/v1/messages', 'web')).status).toBe(400);
    expect((await f.request('/v1/messages', 'codex', { model: 'web-only-model' })).status).toBe(503);
    const web = await f.request('/v1/messages', 'auto', { model: 'web-only-model' });
    expect(web.status).toBe(200);
    expect(web.headers.get('x-chat2claude-backend')).toBe('web');
    expect(f.codex.calls[0].request.model).toBe(MODEL);
    expect(f.web.calls[0].request.model).toBe('web-only-model');
  });

  it.each(endpoints)('serves web-only installations and validates request channel headers at %s', async (endpoint) => {
    const f = fixture(false);
    expect((await f.configure('web')).status).toBe(200);
    const response = await f.request(endpoint);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('web');
    expect((await f.request(endpoint, 'invalid-channel')).status).toBe(400);
    expect((await f.request(endpoint, 'codex')).status).toBe(503);
    expect(f.web.calls).toHaveLength(1);
    expect(f.codex.calls).toHaveLength(0);
  });

  it('redacts gateway credentials, retains an empty key, clears null, and removes the gateway', async () => {
    const f = fixture();
    const configured = await f.configure('web');
    expect(configured.status).toBe(200);
    expect(await configured.json()).toEqual({ mode: 'web', autoPreference: 'codex', contextHandoff: false, webEnabled: true, configured: true, gateway: {
      baseUrl: 'http://gateway.test:8090', models: [MODEL], supportsTools: false, supportsImages: false, apiKeyConfigured: true,
    } });
    const retained = await f.patch({ gateway: { apiKey: '' } });
    expect(record(record(await retained.json()).gateway).apiKeyConfigured).toBe(true);
    const cleared = await f.patch({ gateway: { apiKey: null } });
    expect(record(record(await cleared.json()).gateway).apiKeyConfigured).toBe(false);
    const status = await f.app.request('/admin/api/backend-routing', { headers: { 'x-api-key': KEY } });
    expect(await status.text()).not.toContain('PRIVATE_GATEWAY_KEY');
    expect((await f.patch({ gateway: null })).status).toBe(200);
    expect(f.pool.get(WEB_GATEWAY_ACCOUNT_ID)).toBeUndefined();
    expect((await f.request('/v1/messages')).status).toBe(503);
    expect(f.web.calls).toHaveLength(0);
  });

  it.each(['http://api.test:3000/v1', 'http://api.test:3000'])('rejects a gateway pointing to this API (%s)', async (baseUrl) => {
    const f = fixture();
    const response = await f.patch({ gateway: { baseUrl } });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('separate service');
    expect(f.pool.get(WEB_GATEWAY_ACCOUNT_ID)).toBeUndefined();
  });

  it('retains a strict-tool opt-out when Admin saves the visible gateway form fields', async () => {
    const f = fixture();
    expect((await f.configure('auto', true)).status).toBe(200);
    expect((await f.patch({ gateway: { supportsStrictTools: false } })).status).toBe(200);
    const saved = await f.patch({ gateway: { baseUrl: 'http://gateway.test:8090', models: [MODEL], supportsTools: true,
      supportsImages: false, modelMappings: {} } });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ gateway: { supportsStrictTools: false, apiKeyConfigured: true } });
    const response = await f.app.request('/admin/api/backend-routing', { headers: { 'x-api-key': KEY } });
    const view = await response.text();
    expect(JSON.parse(view)).toMatchObject({ gateway: { supportsStrictTools: false } });
    expect(view).not.toContain('PRIVATE_GATEWAY_KEY');
    expect((await f.patch({ gateway: { supportsStrictTools: 'PRIVATE_VALUE' } })).status).toBe(400);
  });

  it('pins Responses history to the original web account and rejects cross-channel continuation', async () => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    const first = await f.request('/v1/responses', 'web');
    expect(first.status).toBe(200);
    const previous = record(await first.json()).id;
    expect(previous).toMatch(/^resp_/);
    const second = await f.request('/v1/responses', 'auto', { input: 'follow-up', previous_response_id: previous });
    expect(second.status).toBe(200);
    expect(second.headers.get('x-chat2claude-backend')).toBe('web');
    expect(f.web.calls[1].request.inputItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'message', role: 'user', content: 'hello' }),
      expect.objectContaining({ type: 'message', role: 'assistant', content: 'web answer' }),
      expect.objectContaining({ type: 'message', role: 'user', content: 'follow-up' }),
    ]));
    expect((await f.request('/v1/responses', 'codex', { input: 'cross-channel', previous_response_id: previous })).status).toBe(503);
    f.pool.update(WEB_GATEWAY_ACCOUNT_ID, { enabled: false });
    expect((await f.request('/v1/responses', 'auto', { input: 'unavailable', previous_response_id: previous })).status).toBe(503);
    expect(f.codex.calls).toHaveLength(0);
    expect(f.web.calls).toHaveLength(2);
  });

  it('preserves history across a mode change but invalidates it when gateway configuration changes', async () => {
    const f = fixture();
    expect((await f.configure('web')).status).toBe(200);
    const first = await f.request('/v1/responses');
    expect(first.status).toBe(200);
    const previous = record(await first.json()).id;
    const identity = f.pool.get(WEB_GATEWAY_ACCOUNT_ID)!.incarnation;
    expect((await f.patch({ mode: 'auto', gateway: { apiKey: '' } })).status).toBe(200);
    expect(f.pool.get(WEB_GATEWAY_ACCOUNT_ID)!.incarnation).toBe(identity);
    expect((await f.request('/v1/responses', undefined, { input: 'same gateway', previous_response_id: previous })).status).toBe(200);
    expect((await f.patch({ gateway: { baseUrl: 'http://replacement-gateway.test:8090' } })).status).toBe(200);
    expect(f.pool.get(WEB_GATEWAY_ACCOUNT_ID)!.incarnation).not.toBe(identity);
    expect((await f.request('/v1/responses', undefined, { input: 'new gateway', previous_response_id: previous })).status).toBe(503);
    expect(f.web.calls).toHaveLength(2);
    expect(f.codex.calls).toHaveLength(0);
  });

  it('continues a Responses tool round through the real web adapter using only gateway credentials', async () => {
    const wire: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const gateway = new WebGatewayChatGptBackend({
      getConfiguration: () => ({ baseUrl: 'http://gateway.test:8090', apiKey: 'PRIVATE_GATEWAY_KEY', models: [MODEL], supportsTools: true }),
      fetch: async (input, init) => {
        wire.push({ url: String(input), headers: new Headers(init?.headers), body: record(JSON.parse(String(init?.body))) });
        const toolRound = wire.length === 1;
        return Response.json({
          id: `chatcmpl_gateway_${wire.length}`, object: 'chat.completion', created: 1, model: MODEL,
          choices: [{ index: 0, finish_reason: toolRound ? 'tool_calls' : 'stop', message: toolRound ? {
            role: 'assistant', content: null, tool_calls: [{ id: 'call_web_1', type: 'function', function: { name: 'lookup', arguments: '{"query":"weather"}' } }],
          } : { role: 'assistant', content: 'The weather is sunny.' } }],
        });
      },
    });
    const f = fixture(true, null, gateway);
    expect((await f.configure('web', true)).status).toBe(200);
    const first = await f.request('/v1/responses', undefined, { input: 'Check the weather.', tools: toolPayload('/v1/responses') });
    expect(first.status).toBe(200);
    const firstBody = record(await first.json());
    expect(firstBody.output).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call_web_1', name: 'lookup', arguments: '{"query":"weather"}' }));
    const second = await f.request('/v1/responses', undefined, {
      previous_response_id: firstBody.id,
      input: [{ type: 'function_call_output', call_id: 'call_web_1', output: 'sunny' }],
      tools: toolPayload('/v1/responses'),
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('The weather is sunny.');
    expect(wire).toHaveLength(2);
    expect(wire[1].body.messages).toEqual([
      { role: 'user', content: 'Check the weather.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_web_1', type: 'function', function: { name: 'lookup', arguments: '{"query":"weather"}' } }] },
      { role: 'tool', tool_call_id: 'call_web_1', content: 'sunny' },
    ]);
    for (const call of wire) {
      expect(call.url).toBe('http://gateway.test:8090/v1/chat/completions');
      expect(call.headers.get('authorization')).toBe('Bearer PRIVATE_GATEWAY_KEY');
      expect(call.headers.has('x-api-key')).toBe(false);
      expect(JSON.stringify([...call.headers])).not.toContain(KEY);
      expect(JSON.stringify([...call.headers])).not.toContain('SYNTHETIC_TOKEN');
    }
    expect(f.codex.calls).toHaveLength(0);
  });

  it('applies a slow mode-only admin patch to the latest gateway configuration', async () => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    let finishBody!: () => void;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('{"mode":')); },
      pull(controller) {
        bodyStarted();
        return new Promise<void>((resolve) => {
          finishBody = () => { controller.enqueue(encoder.encode('"web"}')); controller.close(); resolve(); };
        });
      },
    });
    const slow = f.app.request(new Request('http://api.test:3000/admin/api/backend-routing', {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body, duplex: 'half',
    } as RequestInit & { duplex: 'half' }));
    await started;
    const fast = await f.patch({ gateway: { baseUrl: 'http://updated-gateway.test:8091' } });
    expect(fast.status).toBe(200);
    const updatedIdentity = f.pool.get(WEB_GATEWAY_ACCOUNT_ID)!.incarnation;
    finishBody();
    const final = await slow;
    expect(final.status).toBe(200);
    expect(await final.json()).toMatchObject({ mode: 'web', gateway: { baseUrl: 'http://updated-gateway.test:8091', apiKeyConfigured: true } });
    expect(f.pool.get(WEB_GATEWAY_ACCOUNT_ID)!.incarnation).toBe(updatedIdentity);
  });

  it('restores the configured web-only mode after restarting the application', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat2claude-web-routing-'));
    directories.push(directory);
    const store = new RuntimeStateStore({ path: join(directory, 'state.json'), encryptionKey: Buffer.alloc(32, 5) });
    const first = fixture(false, store);
    expect((await first.configure('web')).status).toBe(200);
    const originalIdentity = first.pool.get(WEB_GATEWAY_ACCOUNT_ID)!.createdAt;
    await first.app.dispose();
    applications.splice(applications.indexOf(first.app), 1);
    const restarted = fixture(false, store);
    expect(restarted.pool.get(WEB_GATEWAY_ACCOUNT_ID)?.createdAt).toBe(originalIdentity);
    const configuration = await restarted.app.request('/admin/api/backend-routing', { headers: { 'x-api-key': KEY } });
    expect(await configuration.json()).toMatchObject({ mode: 'web', configured: true, gateway: { apiKeyConfigured: true, models: [MODEL] } });
    const response = await restarted.request('/v1/messages');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('web');
    expect(restarted.web.calls).toHaveLength(1);
    expect(restarted.codex.calls).toHaveLength(0);
  });

  it.each(endpoints)('does not retry through another provider after a stream starts at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    f.codex.failStream = true;
    const response = await f.request(endpoint, 'auto', { stream: true });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('codex partial');
    expect(text).toContain('error');
    expect(text).not.toContain('web partial');
    expect(f.codex.calls).toHaveLength(1);
    expect(f.web.calls).toHaveLength(0);
  });
});
