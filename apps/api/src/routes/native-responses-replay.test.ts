import { inspect } from 'node:util';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { SessionChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { apiKeyAuth } from '../middleware/auth.js';
import { AccountPool } from '../services/account-pool.js';
import { ModelRegistry } from '../services/model-registry.js';
import { ResponsesStore } from '../services/responses-store.js';
import { RequestLog } from '../services/request-log.js';
import { RuntimeApiKeys } from '../services/runtime-api-keys.js';
import { createOpenAiResponsesRoute } from './openai-responses.js';

const canary = 'NATIVE_ROUTE_SECRET_CANARY';
const reasoning = (n = 1) => ({ type: 'reasoning', id: `rs_${n}`, summary: [], encrypted_content: `${canary}_${n}` });
const calls = (n: number) => [0, 1].map((i) => ({ type: 'function_call', id: `fc_${n}_${i}`, call_id: `call_${n}_${i}`, name: 'lookup', arguments: ` {"n":${n},"i":${i}} ` }));
const message = (n: number) => ({ type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `answer-${n}`, annotations: [] }] });
const output = (n: number) => [reasoning(n), message(n), ...calls(n)];
function setup(options: { mode?: string; authenticated?: boolean; store?: ResponsesStore; gate?: Promise<void>; started?: () => void } = {}) {
  const pool = new AccountPool({ seedMockAccount: false });
  const registry = new ModelRegistry();
  const add = (id: string) => {
    pool.add({ id, provider: 'chatgpt-session', secret: { accessToken: `token-${id}` } });
    registry.replaceAccountModels({ accountId: id, createdAt: pool.get(id)!.createdAt }, [{ id: 'model' }, { id: 'other' }]);
  };
  add('a'); add('b');
  const captured: Array<{ input: any[]; authorization: string | null }> = [];
  const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
    captured.push({ ...JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('authorization') });
    const n = captured.length;
    options.started?.();
    if (options.gate) await options.gate;
    const frames: unknown[] = options.mode === 'completed-only' ? [] : output(n).map((item, output_index) => ({ type: 'response.output_item.done', output_index, item }));
    if (options.mode !== 'EOF') frames.push({ type: options.mode && ['response.failed', 'response.incomplete', 'error'].includes(options.mode) ? options.mode : 'response.completed', response: { output: options.mode === 'done-only' ? undefined : output(n), ...(options.mode && ['response.failed', 'response.incomplete', 'error'].includes(options.mode) ? { error: { message: canary } } : {}) } });
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
  } });
  const store = options.store ?? new ResponsesStore();
  const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const keys = new RuntimeApiKeys();
  const app = new Hono();
  if (options.authenticated !== false) app.use('*', apiKeyAuth(['owner-a', 'owner-b'], keys));
  app.route('/', createOpenAiResponsesRoute({ backend, accountPool: pool, modelRegistry: registry, responsesStore: store, requestLog: new RequestLog(), backendProvider: 'session', accountAcquireTimeoutMs: 150, logger: logs }));
  const post = (body: Record<string, unknown>, key = 'owner-a', signal?: AbortSignal) => app.request('/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ model: 'model', input: 'hello', ...body }), signal });
  return { post, pool, store, captured, logs, keys, add };
}
async function responseBody(response: Response, stream: boolean) {
  expect(response.status).toBe(200);
  if (!stream) return response.json();
  const text = await response.text();
  const events = text.split('\n\n').filter((x) => x.startsWith('event:')).map((x) => JSON.parse(x.split('\ndata: ')[1]));
  const completed = events.find((x) => x.type === 'response.completed');
  expect(completed.response.output).toEqual(events.filter((x) => x.type === 'response.output_item.done').map((x) => x.item));
  return completed.response;
}

describe('native Responses replay route', () => {
  it.each([false, true])('preserves ordered include output and all three rounds of input, stream=%s', async (stream) => {
    const f = setup();
    const first = await responseBody(await f.post({ stream, input: 'first user', include: ['reasoning.encrypted_content'] }), stream);
    expect(first.output).toEqual(output(1));
    expect(first.output_text).toBe('answer-1');
    const results = (n: number) => calls(n).map((call) => ({ type: 'function_call_output', call_id: call.call_id, output: `result-${n}` }));
    const second = await responseBody(await f.post({ stream, previous_response_id: first.id, input: [...results(1), { type: 'message', role: 'user', content: 'second user' }] }), stream);
    expect(JSON.stringify(second)).not.toContain(canary);
    await responseBody(await f.post({ stream, previous_response_id: second.id, input: [...results(2), { type: 'message', role: 'user', content: 'third user' }] }), stream);
    expect(f.captured[2].input.filter((x) => x.type === 'reasoning')).toEqual([reasoning(1), reasoning(2)]);
    expect(JSON.stringify(f.captured[2].input)).toContain('first user');
    expect(JSON.stringify(f.captured[2].input)).toContain('second user');
    expect(JSON.stringify(f.captured[2].input)).toContain('third user');
    expect(f.captured[2].input.filter((x) => x.type === 'function_call')).toEqual([...calls(1), ...calls(2)]);
    expect(f.captured[2].input.filter((x) => x.type === 'function_call_output')).toEqual([...results(1), ...results(2)]);
    expect(f.captured.map((x) => x.authorization)).toEqual(Array(3).fill(f.captured[0].authorization));
    expect(inspect([f.store, f.logs], { showHidden: true, depth: null })).not.toContain(canary);
  });
  it('supports stateless explicit reasoning without storing or stringifying', async () => {
    const f = setup();
    const response = await f.post({ store: false, input: [reasoning(), ...calls(1)] });
    expect(response.status).toBe(200);
    expect(f.captured[0].input[0]).toEqual(reasoning());
    expect(f.captured[0].input.slice(1)).toEqual(calls(1));
    expect(f.captured[0].input.some((x) => x.type === 'message')).toBe(false);
    expect(f.store.count()).toBe(0);
  });
  it.each([undefined, null, true, false])('uses standard local store default, store=%s', async (store) => {
    const f = setup();
    await (await f.post({ store })).text();
    expect(f.store.count()).toBe(store === false ? 0 : 1);
  });
  it('does not store without authenticated identity', async () => {
    const f = setup({ authenticated: false });
    await (await f.post({ store: true })).text();
    expect(f.store.count()).toBe(0);
  });
  it.each(['owner-b', 'runtime-recreated'])('isolates previous IDs for %s', async (mode) => {
    const f = setup();
    if (mode === 'runtime-recreated') f.keys.add('runtime-key');
    const key = mode === 'runtime-recreated' ? 'runtime-key' : 'owner-a';
    const first = await responseBody(await f.post({}, key), false);
    if (mode === 'runtime-recreated') { f.keys.revoke(f.keys.listSafe()[0].id); f.keys.add('runtime-key'); }
    const response = await f.post({ previous_response_id: first.id }, mode === 'owner-b' ? 'owner-b' : key);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(first.id);
    expect(f.captured).toHaveLength(1);
  });
  it('does not inject replay twice when client repeats previous output', async () => {
    const f = setup();
    const first = await responseBody(await f.post({ include: ['reasoning.encrypted_content'] }), false);
    await responseBody(await f.post({ previous_response_id: first.id, input: [...first.output, { type: 'function_call_output', call_id: 'call_1_0', output: 'ok' }] }), false);
    expect(f.captured[1].input.filter((x) => x.type === 'reasoning')).toHaveLength(1);
    expect(f.captured[1].input.filter((x) => x.type === 'function_call')).toHaveLength(2);
  });
  it.each(['unhealthy', 'disabled', 'recreated', 'model'])('refuses affinity mismatch %s', async (mode) => {
    const f = setup();
    f.pool.acquire({ eligible: (a) => a.id === 'a' });
    const first = await responseBody(await f.post({}), false);
    f.pool.release('a');
    if (mode === 'unhealthy') f.pool.update('b', { status: 'unhealthy' });
    if (mode === 'disabled') f.pool.update('b', { enabled: false });
    if (mode === 'recreated') { f.pool.remove('b'); f.add('b'); }
    const response = await f.post({ previous_response_id: first.id, ...(mode === 'model' ? { model: 'other' } : {}) });
    expect(response.status).toBe(503);
    expect(f.captured).toHaveLength(1);
  });
  it('waits for original busy account instead of switching', async () => {
    const f = setup();
    f.pool.acquire({ eligible: (a) => a.id === 'a' });
    const first = await responseBody(await f.post({}), false);
    f.pool.release('a');
    f.pool.acquire({ eligible: (a) => a.id === 'b' });
    const pending = f.post({ previous_response_id: first.id });
    await vi.waitFor(() => expect(f.pool.pendingAcquisitions).toBe(1));
    expect(f.captured).toHaveLength(1);
    f.pool.release('b');
    expect((await pending).status).toBe(200);
    expect(f.captured[1].authorization).toBe('Bearer token-b');
  });
  it.each(['response.failed', 'response.incomplete', 'error', 'EOF'])('never stores %s', async (mode) => {
    for (const stream of [false, true]) {
      const f = setup({ mode });
      const text = await (await f.post({ stream })).text();
      expect(text).not.toContain('response.completed');
      expect(text).not.toContain(canary);
      expect(f.store.count()).toBe(0);
      expect(inspect(f.logs, { depth: null, showHidden: true })).not.toContain(canary);
    }
  });
  it.each(['nonstream-abort', 'stream-abort', 'consumer-cancel'])('does not store after HTTP %s', async (mode) => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const f = setup({ gate, started });
    const controller = new AbortController();
    const pending = f.post({ stream: mode !== 'nonstream-abort', include: ['reasoning.encrypted_content'] }, 'owner-a', controller.signal);
    if (mode === 'nonstream-abort') {
      await entered;
      controller.abort(); release();
      expect((await pending).status).toBe(499);
    } else {
      const response = await pending;
      const reader = response.body!.getReader();
      await reader.read(); // response.created
      const next = reader.read();
      await entered;
      if (mode === 'consumer-cancel') {
        const cancelled = reader.cancel(); release(); await cancelled;
      } else { controller.abort(); release(); }
      await next.catch(() => undefined);
    }
    await vi.waitFor(() => expect(f.pool.list().every((a) => a.currentConcurrency === 0)).toBe(true));
    expect(f.store.count()).toBe(0);
    expect(inspect([f.store, f.logs], { showHidden: true, depth: null })).not.toContain(canary);
  });
  it.each(['ciphertext', 'arguments', 'namespace', 'reordered'])('rejects conflicting repeated output: %s', async (mode) => {
    const f = setup();
    const first = await responseBody(await f.post({ include: ['reasoning.encrypted_content'] }), false);
    const input = structuredClone(first.output);
    if (mode === 'ciphertext') input[0].encrypted_content = 'different';
    if (mode === 'arguments') input[2].arguments = '{"changed":true}';
    if (mode === 'namespace') input[2].namespace = 'other';
    if (mode === 'reordered') input.reverse();
    const response = await f.post({ previous_response_id: first.id, input });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(canary);
    expect(f.captured).toHaveLength(1);
  });
  it.each(['completed-only', 'done-only'])('adapts %s without fabricating missing replay', async (mode) => {
    const f = setup({ mode });
    const response = await responseBody(await f.post({ stream: true, include: ['reasoning.encrypted_content'] }), true);
    expect(response.output.filter((x: any) => x.type === 'reasoning')).toHaveLength(mode === 'completed-only' ? 1 : 0);
    expect(response.output.filter((x: any) => x.type === 'function_call')).toHaveLength(2);
  });
  it('expires with fixed not-found error', async () => {
    let now = 0;
    const f = setup({ store: new ResponsesStore({ ttlMs: 10, now: () => now }) });
    const first = await responseBody(await f.post({}), false);
    now = 10;
    const response = await f.post({ previous_response_id: first.id });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { message: 'Previous response not found.' } });
  });
  it.each([
    { include: ['unsafe'] }, { include: 'reasoning.encrypted_content' }, { include: ['reasoning.encrypted_content', 'reasoning.encrypted_content'] },
    { previous_response_id: 'bad secret ID' }, { previous_response_id: 'resp_' + 'x'.repeat(256) },
    ...[undefined, null, 1, '', 'x'.repeat(256 * 1024)].map((encrypted_content) => ({ input: [{ ...reasoning(), encrypted_content }] })),
    { input: [{ ...reasoning(), extra: canary }] }, { input: [{ ...reasoning(), summary: [{ type: 'summary_text', text: 1 }] }] },
    { input: Array.from({ length: 129 }, () => reasoning()) },
  ])('rejects invalid bounded protocol input without echoing payload %#', async (payload) => {
    const f = setup();
    const response = await f.post(payload);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(canary);
    expect(f.captured).toHaveLength(0);
  });
});
