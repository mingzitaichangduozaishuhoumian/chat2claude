import { inspect } from 'node:util';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionChatGptBackend, type ChatGptCompletionRequest, type ChatGptReplayItem } from '@chatgpt-to-claude/chatgpt-backend';
import { createApp } from '../app.js';
import { apiKeyAuth } from '../middleware/auth.js';
import { AccountPool } from '../services/account-pool.js';
import { ModelRegistry } from '../services/model-registry.js';
import { ReasoningReplayStore } from '../services/reasoning-replay-store.js';
import { RequestLog } from '../services/request-log.js';
import { RuntimeApiKeys } from '../services/runtime-api-keys.js';
import { createMessagesRoute } from './messages.js';
import { createOpenAiChatRoute } from './openai-chat.js';

const canary = 'ROUTE_ENCRYPTED_REPLAY_CANARY';
const reasoning = (n: number) => ({ type: 'reasoning', id: `rs_${n}`, summary: [], encrypted_content: `${canary}_${n}` });
const calls = (n: number, parallel = false) => [
  { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'lookup', arguments: ` { "q": ${n} } ` },
  ...(parallel ? [{ type: 'function_call', id: `fc_${n}_b`, call_id: `call_${n}_b`, name: 'lookup', arguments: `{"q":${n + 10}}` }] : []),
];
type Protocol = 'claude' | 'chat';
function body(protocol: Protocol, rounds = 0, parallel = false, stream = false) {
  const messages: unknown[] = [{ role: 'user', content: 'hello' }];
  for (let n = 1; n <= rounds; n++) {
    const tools = calls(n, parallel);
    if (protocol === 'claude') messages.push(
      { role: 'assistant', content: tools.map((call) => ({ type: 'tool_use', id: call.call_id, name: call.name, input: JSON.parse(call.arguments) })) },
      { role: 'user', content: tools.map((call) => ({ type: 'tool_result', tool_use_id: call.call_id, content: 'result' })) },
    );
    else messages.push(
      { role: 'assistant', content: null, tool_calls: tools.map((call) => ({ id: call.call_id, type: 'function', function: { name: call.name, arguments: JSON.stringify(JSON.parse(call.arguments)) } })) },
      ...tools.map((call) => ({ role: 'tool', tool_call_id: call.call_id, content: 'result' })),
    );
  }
  return { model: 'model', max_tokens: 128, messages, stream,
    ...(protocol === 'claude' ? { tools: [{ name: 'lookup', input_schema: { type: 'object' } }], tool_choice: { type: 'auto', disable_parallel_tool_use: !parallel } }
      : { tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }], parallel_tool_calls: parallel }),
  };
}
function setup(protocol: Protocol, options: { parallel?: boolean; mode?: string; store?: ReasoningReplayStore; authenticated?: boolean } = {}) {
  const pool = new AccountPool({ seedMockAccount: false });
  const registry = new ModelRegistry();
  const add = (id: string) => {
    pool.add({ id, provider: 'chatgpt-session', secret: { accessToken: `token-${id}` } });
    registry.replaceAccountModels({ accountId: id, createdAt: pool.get(id)!.createdAt }, [{ id: 'model' }, { id: 'other-model' }]);
  };
  add('a'); add('b');
  const store = options.store ?? new ReasoningReplayStore();
  const logs = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const captured: Array<{ body: Record<string, any>; authorization: string | null }> = [];
  const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
    const n = captured.length + 1;
    captured.push({ body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('authorization') });
    const output = [reasoning(n), ...calls(n, options.parallel)];
    const frames = [{ type: 'response.output_item.done', output_index: 0, item: reasoning(n) }];
    if (options.mode === 'mixed') output.push({ type: 'message', content: [] } as any);
    const terminal = ['response.failed', 'response.incomplete', 'error'].includes(options.mode ?? '')
      ? { type: options.mode, response: { error: { message: canary }, output } }
      : { type: 'response.completed', response: { status: 'completed', output } };
    return new Response([...frames, ...(options.mode === 'EOF' ? [] : [terminal])].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
  } });
  const keys = new RuntimeApiKeys();
  const app = new Hono();
  if (options.authenticated !== false) app.use('*', apiKeyAuth(['owner-a', 'owner-b'], keys));
  const deps = { backend, accountPool: pool, modelRegistry: registry, requestLog: new RequestLog(), backendProvider: 'session' as const, reasoningReplayStore: store, accountAcquireTimeoutMs: 200, logger: logs };
  app.route('/', protocol === 'claude' ? createMessagesRoute(deps) : createOpenAiChatRoute(deps));
  const post = (payload: unknown, key = 'owner-a', signal?: AbortSignal) => app.request(protocol === 'claude' ? '/v1/messages' : '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(payload), signal,
  });
  return { pool, registry, store, captured, post, keys, add, logs, requestLog: deps.requestLog };
}
afterEach(() => vi.restoreAllMocks());

it('wires one app-local replay store across authenticated Claude and Chat routes and clears it on disposal', async () => {
  const captured: ChatGptCompletionRequest[] = [];
  const app = createApp({
    port: 3000, host: '127.0.0.1', apiKeys: ['owner-a'], allowAnonymousBootstrap: false, localContainerBootstrap: false,
    logLevel: 'error', mockResponsePrefix: '', chatGptBackend: 'mock', chatGptBaseUrl: 'https://chatgpt.test', chatGptRequestTimeoutMs: 1000,
    defaultReasoningEffort: 'medium', defaultResponseSpeed: 'balanced', dataDir: '', runtimeStatePath: '', operationalStatePath: '',
  }, { runtimeStateStore: null, operationalState: null, backend: {
    async complete(request) {
      captured.push(request);
      return { text: '', finishReason: 'tool_calls', replayEligible: true, replayItems: [reasoning(1), ...calls(1)] as ChatGptReplayItem[], toolCalls: [{ id: 'call_1', name: 'lookup', input: { q: 1 } }] };
    },
    async *stream() { yield { type: 'done' }; },
    async listModels() { return [{ id: 'model' }]; },
  } });
  const post = (protocol: Protocol, rounds: number) => app.request(protocol === 'claude' ? '/v1/messages' : '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'owner-a' }, body: JSON.stringify(body(protocol, rounds)),
  });
  try {
    expect((await post('claude', 0)).status).toBe(200);
    expect((await post('chat', 1)).status).toBe(200);
    expect(captured[1].inputItems).toContainEqual({ type: 'replay', item: reasoning(1) });
  } finally { await app.dispose(); }
  expect((await post('chat', 1)).status).toBe(200);
  expect(captured[2].inputItems?.some((item) => item.type === 'replay')).toBe(false);
});

describe.each(['claude', 'chat'] as const)('%s implicit reasoning replay routes', (protocol) => {
  it.each([false, true])('replays two consecutive single/parallel rounds with stream=%s and never leaks', async (stream) => {
    for (const parallel of [false, true]) {
      const f = setup(protocol, { parallel });
      for (let round = 0; round < 3; round++) {
        const response = await f.post(body(protocol, round, parallel, stream));
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toMatch(/ROUTE_ENCRYPTED_REPLAY_CANARY|encrypted_content|replayItems|replayEligible|signature/);
        expect(f.captured[round].body.parallel_tool_calls).toBe(parallel);
        if (round) {
          const input = f.captured[round].body.input;
          expect(input.filter((item: any) => item.type === 'reasoning')).toEqual([reasoning(round)]);
          for (const call of calls(round, parallel)) expect(input.filter((item: any) => item.type === 'function_call' && item.call_id === call.call_id)).toEqual([call]);
          expect(input.slice(-calls(round, parallel).length).every((item: any) => item.type === 'function_call_output')).toBe(true);
        }
      }
      expect(inspect([f.store, f.logs, f.requestLog, f.pool.list(), f.registry.adminView()], { depth: null, showHidden: true })).not.toContain(canary);
    }
  });

  it.each(['other-owner', 'missing-owner', 'runtime-recreated', 'other-model', 'different-name', 'different-arguments'] as const)('does not replay across %s', async (mode) => {
    const f = setup(protocol, { authenticated: mode !== 'missing-owner' });
    if (mode === 'runtime-recreated') f.keys.add('runtime-key');
    await (await f.post(body(protocol), mode === 'runtime-recreated' ? 'runtime-key' : 'owner-a')).text();
    if (mode === 'runtime-recreated') { f.keys.revoke(f.keys.listSafe()[0].id); f.keys.add('runtime-key'); }
    const next: any = body(protocol, 1);
    next.ownerId = 'owner-a'; next.reasoningReplayOwner = 'owner-a';
    if (mode === 'other-model') next.model = 'other-model';
    if (mode.startsWith('different-')) {
      if (protocol === 'claude') Object.assign(next.messages[1].content[0], mode === 'different-name' ? { name: 'other' } : { input: { q: 99 } });
      else Object.assign(next.messages[1].tool_calls[0].function, mode === 'different-name' ? { name: 'other' } : { arguments: '{"q":99}' });
    }
    const response = await f.post(next, mode === 'other-owner' ? 'owner-b' : mode === 'runtime-recreated' ? 'runtime-key' : 'owner-a');
    await response.text();
    expect(f.captured.at(-1)!.body.input.some((item: any) => item.type === 'reasoning')).toBe(false);
  });

  it('pins the original account and waits when it is busy instead of using a free peer', async () => {
    const f = setup(protocol);
    f.pool.acquire({ eligible: (account) => account.id === 'a' });
    await (await f.post(body(protocol))).text();
    expect(f.captured[0].authorization).toBe('Bearer token-b');
    f.pool.release('a');
    f.pool.acquire({ eligible: (account) => account.id === 'b' });
    const pending = f.post(body(protocol, 1));
    await vi.waitFor(() => expect(f.pool.pendingAcquisitions).toBe(1));
    expect(f.captured).toHaveLength(1);
    f.pool.release('b');
    expect((await pending).status).toBe(200);
    expect(f.captured[1].authorization).toBe('Bearer token-b');
    expect(f.captured[1].body.input).toContainEqual(reasoning(1));
  });

  it.each(['abort', 'timeout', 'unhealthy'] as const)('never falls back when an affinity wait ends with %s', async (mode) => {
    const f = setup(protocol);
    f.pool.acquire({ eligible: (account) => account.id === 'a' });
    await (await f.post(body(protocol))).text();
    f.pool.release('a');
    f.pool.acquire({ eligible: (account) => account.id === 'b' });
    const controller = new AbortController();
    const pending = f.post(body(protocol, 1), 'owner-a', controller.signal);
    await vi.waitFor(() => expect(f.pool.pendingAcquisitions).toBe(1));
    if (mode === 'abort') controller.abort();
    if (mode === 'unhealthy') f.pool.update('b', { status: 'unhealthy' });
    const response = await pending;
    // Acquisition intentionally keeps the existing overloaded 503 on cancellation.
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(canary);
    expect(f.captured).toHaveLength(1);
    expect(f.pool.pendingAcquisitions).toBe(0);
    expect(f.store.stats().records).toBe(1);
    f.pool.release('b');
  });

  it.each(['unhealthy', 'disabled', 'deleted', 'recreated', 'provider-changed'] as const)('does not switch accounts after %s', async (mode) => {
    const f = setup(protocol);
    f.pool.acquire({ eligible: (account) => account.id === 'a' });
    await (await f.post(body(protocol))).text();
    f.pool.release('a');
    if (mode === 'deleted' || mode === 'recreated') f.pool.remove('b');
    if (mode === 'recreated') f.add('b');
    if (mode === 'disabled') f.pool.update('b', { enabled: false });
    if (mode === 'unhealthy') f.pool.update('b', { status: 'unhealthy' });
    if (mode === 'provider-changed') f.pool.update('b', { provider: 'mock' });
    const response = await f.post(body(protocol, 1));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(canary);
    expect(f.captured).toHaveLength(1);
  });

  it.each(['response.failed', 'response.incomplete', 'error', 'EOF', 'mixed'])('does not cache %s for stream or nonstream', async (mode) => {
    for (const stream of [false, true]) {
      const f = setup(protocol, { mode });
      const response = await f.post(body(protocol, 0, false, stream));
      expect(await response.text()).not.toContain(canary);
      expect(f.store.stats().records).toBe(0);
      expect(inspect(f.logs, { depth: null, showHidden: true })).not.toContain(canary);
    }
  });

  it('falls back to visible history after TTL expiration', async () => {
    let now = 0;
    const f = setup(protocol, { store: new ReasoningReplayStore({ now: () => now, ttlMs: 100 }) });
    await (await f.post(body(protocol))).text();
    now = 100;
    await (await f.post(body(protocol, 1))).text();
    expect(f.captured[1].body.input.some((item: any) => item.type === 'reasoning')).toBe(false);
  });
});
