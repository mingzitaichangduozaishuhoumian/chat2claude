import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { accessLog } from './middleware/access-log.js';
import { createOpenAiChatRoute } from './routes/openai-chat.js';
import { createOpenAiResponsesRoute } from './routes/openai-responses.js';
import { AdminOperationalState } from './services/admin-operational-state.js';
import { SessionChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { parseClaudeMessagesRequest, parseClaudeCountTokensRequest } from '@chatgpt-to-claude/claude-protocol';
import { mapClaudeRequestToChatGpt, mapOpenAiResponsesRequestToChatGpt } from '@chatgpt-to-claude/protocol-mapper';
import { createMessagesRoute } from './routes/messages.js';
import { AccountPool } from './services/account-pool.js';
import { ModelRegistry } from './services/model-registry.js';
import { RequestLog } from './services/request-log.js';

const context = { account: { id: 'session', provider: 'chatgpt-session' as const, secret: { type: 'chatgpt-session' as const, accessToken: 'TOKEN_CANARY' } } };
const unsupported = ['max_output_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'truncation', 'prompt_cache_options', 'prompt_cache_retention', 'context_management'];
const base = { model: 'model-1', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] };

function capture() {
  const bodies: Record<string, any>[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');
  });
  return { bodies, fetch, backend: new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch }) };
}

describe('Codex private endpoint cross-layer compatibility', () => {
  it.each([undefined, false, true])('normalizes Claude parser -> mapper -> wire with disable_parallel=%s', async (disable) => {
    const { bodies, backend } = capture();
    const parsed = parseClaudeMessagesRequest({ ...base, system: 'system', temperature: 0.5, top_p: 0.8, stop_sequences: ['stop'],
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }], tool_choice: { type: 'auto', disable_parallel_tool_use: disable },
      messages: [
        { role: 'developer', content: 'developer' },
        { role: 'user', content: [{ type: 'text', text: 'question' }, { type: 'image', source: { type: 'url', url: 'https://image.test/u' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'image', source: { type: 'url', url: 'https://image.test/a' } }, { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'result' }] },
      ],
    });
    const ir = mapClaudeRequestToChatGpt(parsed, {}, { resolvedControls: { serviceTier: 'default' }, backendOptions: {
      responsesBody: Object.fromEntries(unsupported.map((key) => [key, 'DROP_CANARY'])),
    } });
    const snapshot = JSON.stringify(ir);
    await backend.complete(ir, context);
    const body = bodies[0];
    for (const field of unsupported) expect(body).not.toHaveProperty(field);
    expect(body).not.toHaveProperty('service_tier');
    expect(body).toMatchObject({ stream: true, store: false, include: ['reasoning.encrypted_content'], parallel_tool_calls: disable !== true,
      tools: [{ type: 'function', name: 'lookup', strict: false, parameters: { type: 'object' } }] });
    expect(body.input[0]).toMatchObject({ role: 'developer', content: 'system\ndeveloper' });
    expect(body.input[1].content[0]).toEqual({ type: 'input_text', text: 'question' });
    expect(body.input[2].content[0]).toEqual({ type: 'output_text', text: 'answer' });
    expect(body.input[3]).toEqual({ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' });
    expect(body.input[4]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'result' });
    expect(JSON.stringify(ir)).toBe(snapshot);
    expect(ir.maxTokens).toBe(64);
    expect(ir.temperature).toBe(0.5);
  });

  it.each([undefined, false, true])('preserves Chat Completions parser -> mapper -> IR -> wire parallel_tool_calls=%s', async (parallel_tool_calls) => {
    const { bodies, backend } = capture();
    const pool = new AccountPool();
    pool.add(context.account);
    const registry = new ModelRegistry({ discoveredModels: [{ id: base.model }] });
    registry.replaceAccountModels({ accountId: context.account.id, createdAt: pool.get(context.account.id)!.createdAt }, [{ id: base.model }]);
    const app = createOpenAiChatRoute({ backend, backendProvider: 'session', requestLog: new RequestLog(), modelRegistry: registry, accountPool: pool });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: base.model, messages: base.messages, tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }], parallel_tool_calls }),
    });

    expect(response.status).toBe(200);
    expect(bodies[0].parallel_tool_calls).toBe(parallel_tool_calls ?? true);
  });

  it.each(['priority', 'default', 'standard', 'auto', 'fast', 'FaSt'])('only sends canonical priority tier (%s)', async (serviceTier) => {
    const { bodies, backend } = capture();
    await backend.complete(mapClaudeRequestToChatGpt(parseClaudeMessagesRequest(base), {}, { resolvedControls: { serviceTier } }), context);
    expect(bodies[0].service_tier).toBe(serviceTier === 'priority' ? 'priority' : undefined);
    expect(bodies[0]).not.toHaveProperty('parallel_tool_calls');
  });

  it.each([undefined, false, true])('preserves Responses hosted tools and parallel setting %s', async (parallel_tool_calls) => {
    const { bodies, backend } = capture();
    const tools = [{ type: 'web_search_preview' as const, search_context_size: 'low' }, { type: 'function' as const, name: 'lookup', parameters: { type: 'object' } }];
    await backend.complete(mapOpenAiResponsesRequestToChatGpt({ model: 'model-1', input: [{ role: 'developer', content: [{ type: 'input_text', text: 'rules' }] }], tools, parallel_tool_calls, truncation: 'auto', max_output_tokens: 50 }), context);
    expect(bodies[0].tools).toEqual(expect.arrayContaining([tools[0], { ...tools[1], strict: false }]));
    expect(bodies[0].parallel_tool_calls).toBe(parallel_tool_calls ?? true);
    expect(bodies[0].input[0]).toMatchObject({ role: 'developer', content: 'rules' });
    for (const field of unsupported) expect(bodies[0]).not.toHaveProperty(field);
  });

  it.each([
    { tools: [{ name: '', input_schema: {} }] }, { tools: [{ name: '  ', input_schema: {} }] },
    { tools: [{ name: 42, input_schema: {} }] }, { tools: [{ name: 'lookup' }] },
    ...[null, [], 'TOOL_CANARY', 1].map((input_schema) => ({ tools: [{ name: 'lookup', input_schema }] })),
    ...[null, [], 'TOOL_CANARY', 1].map((input) => ({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input }] }] })),
  ])('rejects malformed Claude tools before fetch %#', async (patch) => {
    const { backend, fetch: fetchSpy } = capture();
    const app = createMessagesRoute({ backend, requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels: [{ id: 'model-1' }] }), accountPool: new AccountPool() });
    const response = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, ...patch }) });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('CANARY');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(() => parseClaudeMessagesRequest({ ...base, ...patch })).toThrow();
  });

  it.each([
    [createMessagesRoute, '/v1/messages', base],
    [createOpenAiChatRoute, '/v1/chat/completions', { model: base.model, messages: base.messages }],
    [createOpenAiResponsesRoute, '/v1/responses', { model: base.model, input: 'PROMPT_CANARY' }],
  ] as const)('keeps real session failures/cancellation safe through route %#', async (createRoute, path, body) => {
    for (const mode of ['http-error', 'cancelled', 'upstream-abort'] as const) {
      const controller = new AbortController();
      const pool = new AccountPool();
      pool.add(context.account);
      const release = vi.spyOn(pool, 'release');
      const state = new AdminOperationalState({ path: 'unused.json', debounceMs: 60_000 });
      const registry = new ModelRegistry({ discoveredModels: [{ id: base.model }] });
      registry.replaceAccountModels({ accountId: context.account.id, createdAt: pool.get(context.account.id)!.createdAt }, [{ id: base.model }]);
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), access: vi.fn() };
      const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => {
        if (mode !== 'http-error') {
          if (mode === 'cancelled') controller.abort();
          throw new DOMException('PROVIDER_CANARY', 'AbortError');
        }
        return Response.json({ error: { code: 'unsupported_parameter', type: 'invalid_request_error', param: 'max_output_tokens', message: 'PROVIDER_CANARY', detail: 'TOKEN_CANARY' } }, { status: 400 });
      } });
      const app = new Hono();
      app.use('*', accessLog(logger));
      app.route('/', createRoute({ backend, backendProvider: 'session', requestLog: new RequestLog(), modelRegistry: registry, accountPool: pool, operationalState: state, logger }));
      const response = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      const status = mode === 'cancelled' ? 499 : mode === 'http-error' ? 400 : 500;
      expect(response.status).toBe(status);
      expect(logger.access).toHaveBeenCalledWith(expect.objectContaining({ status }), 'text');
      expect(state.snapshot().accounts[0]?.requestStats).toMatchObject({ totalRequests: 1, successfulRequests: 0, failedRequests: mode === 'cancelled' ? 0 : 1, cancelledRequests: mode === 'cancelled' ? 1 : 0, inFlight: 0 });
      expect(release).toHaveBeenCalledTimes(1);
      if (mode === 'http-error') expect(logger.access).toHaveBeenCalledWith(expect.objectContaining({ httpStatus: 400, failurePhase: 'response_headers', responseErrorCode: 'unsupported_parameter', responseErrorType: 'invalid_request_error', responseErrorParam: 'max_output_tokens' }), 'text');
      if (mode === 'cancelled') expect(logger.access).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'cancelled' }), 'text');
      expect(logger.access).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
      expect(await response.text() + JSON.stringify([logger.info.mock.calls, logger.error.mock.calls, logger.access.mock.calls, state.snapshot()])).not.toContain('CANARY');
    }
  });

  it('keeps max_tokens mandatory for messages and count_tokens fragment semantics', () => {
    expect(() => parseClaudeMessagesRequest({ ...base, max_tokens: undefined })).toThrow('max_tokens');
    expect(() => parseClaudeCountTokensRequest({ ...base, max_tokens: undefined, tools: [{ name: 'fragment' }], messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'fragment' }] }] })).not.toThrow();
  });
});
