import { afterEach, expect, it, vi } from 'vitest';
import { serve } from '@hono/node-server';
import { request as httpRequest } from 'node:http';
import { Hono } from 'hono';
import { ChatGptBackendError, SessionChatGptBackend, type ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { createMessagesRoute } from './messages.js';
import { createOpenAiChatRoute } from './openai-chat.js';
import { createOpenAiResponsesRoute } from './openai-responses.js';
import { AccountPool } from '../services/account-pool.js';
import { ModelRegistry } from '../services/model-registry.js';
import { RequestLog } from '../services/request-log.js';
import { AdminOperationalState } from '../services/admin-operational-state.js';
import { accessLog } from '../middleware/access-log.js';
import { RefreshAwareChatGptBackend } from '../services/refresh-aware-backend.js';
import { SessionCredentialManager } from '../services/session-credential-manager.js';
import { CodexOAuthClient } from '../services/codex-oauth-client.js';
const routes = [
  [createMessagesRoute, '/v1/messages', { model: 'sonnet', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], stream: true }],
  [createOpenAiChatRoute, '/v1/chat/completions', { model: 'sonnet', messages: [{ role: 'user', content: 'hi' }], stream: true }],
  [createOpenAiResponsesRoute, '/v1/responses', { model: 'sonnet', input: 'hi', stream: true }],
] as const;
it('Responses mapper failure after done retains usage but cannot record success', async () => {
  const backend = { stream: async function* () {
    yield { type: 'done', usage: { inputTokens: 2, outputTokens: 3 }, outputItems: [{ type: 'message', content: null }] };
  } } as unknown as ChatGptBackendClient;
  const f = fixture(createOpenAiResponsesRoute, backend);
  const response = await post(f.app, '/v1/responses', { model: 'sonnet', input: 'hi', stream: true });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('event: response.failed');
  assertTerminal(f, 'failure', 200);
  expect(f.state.snapshot().accounts[0]?.requestStats).toMatchObject({ inputTokens: 2, outputTokens: 3 });
});
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const created = frame({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } });
const completed = frame({ type: 'response.completed', response: { status: 'completed', output: [] } });
const encode = (text: string) => new TextEncoder().encode(text);
const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), access: vi.fn() });
function fixture(createRoute: typeof createMessagesRoute | typeof createOpenAiChatRoute | typeof createOpenAiResponsesRoute, backend: ChatGptBackendClient, extra: Partial<Parameters<typeof createMessagesRoute>[0] & Parameters<typeof createOpenAiChatRoute>[0] & Parameters<typeof createOpenAiResponsesRoute>[0]> = {}) {
  const pool = new AccountPool();
  pool.add({ id: 'session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'CANARY' } });
  const modelRegistry = new ModelRegistry({ discoveredModels: [{ id: 'model' }] });
  modelRegistry.update('sonnet', { backendModel: 'model' });
  modelRegistry.replaceAccountModels({ accountId: 'session', createdAt: pool.get('session')!.createdAt }, [{ id: 'model' }]);
  const state = new AdminOperationalState({ path: 'unused.json', debounceMs: 60000 });
  const log = logger();
  const app = new Hono();
  app.use('*', accessLog(log));
  app.route('/', createRoute({ backend, accountPool: pool, modelRegistry, requestLog: new RequestLog(), operationalState: state, logger: log, backendProvider: 'session', ...extra }));
  return { app, pool, state, log, release: vi.spyOn(pool, 'release') };
}
function post(app: Hono, path: string, body: unknown, signal?: AbortSignal) {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
}
function assertTerminal(f: ReturnType<typeof fixture>, outcome: string, status: number) {
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.pool.get('session')?.currentConcurrency).toBe(0);
  expect(f.state.snapshot().accounts[0]?.requestStats).toMatchObject({ totalRequests: 1, inFlight: 0, successfulRequests: outcome === 'success' ? 1 : 0, failedRequests: outcome === 'failure' ? 1 : 0, cancelledRequests: outcome === 'cancelled' ? 1 : 0 });
  const entries = f.log.access.mock.calls.map(([entry]) => entry as { phase?: string; outcome?: string; status: number });
  const hasStreamTerminal = entries.length === 3;
  expect(entries.map(entry => entry.phase)).toEqual(hasStreamTerminal
    ? ['request_started', 'response_ready', 'stream_terminal']
    : ['request_started', 'response_ready']);
  expect(entries[1]).toMatchObject({ phase: 'response_ready' });
  if (hasStreamTerminal) expect(entries[2]).toMatchObject({ phase: 'stream_terminal', outcome });
  // A JSON non-stream failure carries terminal diagnostics on response readiness.
  // Normal SSE success/cancellation stays terminal-silent in text mode.
  else if (entries[1].status !== 200) expect(entries[1]).toMatchObject({ status, outcome });
  expect(JSON.stringify(f.log.access.mock.calls)).not.toContain('CANARY');
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('real node /v1/messages delivers content_block_delta before terminal through route wrappers', async () => {
  await assertRealNodeIncrementalDelivery(createMessagesRoute, '/v1/messages', { model: 'sonnet', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], stream: true }, 'content_block_delta', 'message_stop');
});

it('real node /v1/chat/completions delivers delta before delayed terminal through route wrappers', async () => {
  await assertRealNodeIncrementalDelivery(createOpenAiChatRoute, '/v1/chat/completions', { model: 'sonnet', messages: [{ role: 'user', content: 'hi' }], stream: true }, '"content":"incremental-token"', '"finish_reason":"stop"');
});

it('real node /v1/responses delivers output_text delta before delayed terminal through route wrappers', async () => {
  await assertRealNodeIncrementalDelivery(createOpenAiResponsesRoute, '/v1/responses', { model: 'sonnet', input: 'hi', stream: true }, 'response.output_text.delta', 'response.completed');
});

it('real node /v1/responses reconciles mixed authoritative output after incremental text', async () => {
  const output = [
    { type: 'message', id: 'msg_authoritative_route', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'incremental-token', annotations: [] }] },
    { type: 'reasoning', id: 'rs_authoritative_route', summary: [], encrypted_content: 'CANARY' },
    { type: 'function_call', id: 'fc_authoritative_route', call_id: 'call_authoritative_route', name: 'lookup_route', arguments: '{"ok":true}' },
  ];
  const backend = { stream: async function* () {
    yield { type: 'upstream_ready' };
    await new Promise(resolve => setTimeout(resolve, 20));
    yield { type: 'text_delta', text: 'incremental-token' };
    yield { type: 'tool_call', toolCall: { id: 'call_authoritative_route', name: 'lookup_route', input: { ok: true } } };
    await new Promise(resolve => setTimeout(resolve, 60));
    yield { type: 'done', finishReason: 'tool_calls', outputItems: output, replayItems: output.slice(1) };
  } } as unknown as ChatGptBackendClient;
  const f = fixture(createOpenAiResponsesRoute, backend);
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server.listening ? r() : server.once('listening', r));
  const chunks: Array<{ text: string; at: number }> = [];
  const started = Date.now();
  const client = httpRequest({ hostname: '127.0.0.1', port: (server.address() as { port: number }).port, path: '/v1/responses', method: 'POST', headers: { 'content-type': 'application/json' } });
  const finished = new Promise<string>((resolve, reject) => {
    client.on('response', response => { let text = ''; response.on('data', c => { const chunk = String(c); text += chunk; chunks.push({ text: chunk, at: Date.now() - started }); }); response.on('end', () => resolve(text)); response.on('error', reject); });
    client.on('error', reject);
  });
  client.end(JSON.stringify({ model: 'sonnet', input: 'hi', stream: true }));
  try {
    const text = await finished;
    const events = text.split('\n\n').filter((x) => x.startsWith('event:')).map((x) => JSON.parse(x.split('\ndata: ')[1]));
    const completed = events.find((x) => x.type === 'response.completed');
    const added = events.filter((x) => x.type === 'response.output_item.added');
    const done = events.filter((x) => x.type === 'response.output_item.done');
    expect(completed.response.output.map((item: { type: string }) => item.type)).toEqual(['message', 'reasoning', 'function_call']);
    expect(done).toHaveLength(added.length);
    for (const itemAdded of added) {
      const itemDone = done.find((x) => x.output_index === itemAdded.output_index);
      expect(itemDone).toBeTruthy();
      expect(itemDone!.item.id).toBe(itemAdded.item.id);
      expect(completed.response.output[itemDone!.output_index]).toMatchObject({ id: itemDone!.item.id, type: itemDone!.item.type });
    }
    expect(added.filter((x) => x.item.type === 'message')).toHaveLength(1);
    expect(completed.response.output.filter((item: { type: string }) => item.type === 'message')).toHaveLength(1);
    const deltaAt = chunks.find(chunk => chunk.text.includes('response.output_text.delta'))?.at;
    const terminalAt = chunks.find(chunk => chunk.text.includes('response.completed'))?.at;
    expect(deltaAt).toEqual(expect.any(Number));
    expect(terminalAt).toEqual(expect.any(Number));
    expect(deltaAt!).toBeLessThan(terminalAt!);
    expect(terminalAt! - deltaAt!).toBeGreaterThanOrEqual(40);
    expect(text).not.toContain('CANARY');
    assertTerminal(f, 'success', 200);
  } finally { client.destroy(); (server as import('node:http').Server).closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

async function assertRealNodeIncrementalDelivery(createRoute: typeof createMessagesRoute | typeof createOpenAiChatRoute | typeof createOpenAiResponsesRoute, path: string, body: unknown, deltaMarker: string, terminalMarker: string) {
  const backend = { stream: async function* () {
    yield { type: 'upstream_ready' };
    await new Promise(resolve => setTimeout(resolve, 20));
    yield { type: 'text_delta', text: 'incremental-token' };
    await new Promise(resolve => setTimeout(resolve, 60));
    yield { type: 'done', finishReason: 'stop' };
  } } as unknown as ChatGptBackendClient;
  const f = fixture(createRoute, backend);
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server.listening ? r() : server.once('listening', r));
  const chunks: Array<{ text: string; at: number }> = [];
  const started = Date.now();
  const client = httpRequest({ hostname: '127.0.0.1', port: (server.address() as { port: number }).port, path, method: 'POST', headers: { 'content-type': 'application/json' } });
  const finished = new Promise<string>((resolve, reject) => {
    client.on('response', response => { let text = ''; response.on('data', c => { const chunk = String(c); text += chunk; chunks.push({ text: chunk, at: Date.now() - started }); }); response.on('end', () => resolve(text)); response.on('error', reject); });
    client.on('error', reject);
  });
  client.end(JSON.stringify(body));
  try {
    const text = await finished;
    const deltaAt = chunks.find(chunk => chunk.text.includes(deltaMarker))?.at;
    const terminalAt = chunks.find(chunk => chunk.text.includes(terminalMarker))?.at;
    expect(text).toContain('incremental-token');
    expect(deltaAt).toEqual(expect.any(Number));
    expect(terminalAt).toEqual(expect.any(Number));
    expect(deltaAt!).toBeLessThan(terminalAt!);
    expect(terminalAt! - deltaAt!).toBeGreaterThanOrEqual(40);
    assertTerminal(f, 'success', 200);
  } finally { client.destroy(); (server as import('node:http').Server).closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}

for (const [createRoute, path, body] of routes) {
  it.each([false, true])(`${path}: upstream AbortError remains failure before/after readiness (%s)`, async ready => {
    const caller = new AbortController();
    const backend = { stream: async function* () {
      if (ready) yield { type: 'upstream_ready' };
      throw new DOMException('CANARY', 'AbortError');
    } } as unknown as ChatGptBackendClient;
    const f = fixture(createRoute, backend);
    const response = await post(f.app, path, body, caller.signal);
    await response.text();
    expect(caller.signal.aborted).toBe(false);
    assertTerminal(f, 'failure', ready ? 200 : 500);
  });

  it(`${path}: explicit unsuccessful done cannot emit successful finish`, async () => {
    const backend = { stream: async function* () {
      yield { type: 'text_delta', text: 'hello' };
      yield { type: 'done', terminalSuccessful: false };
    } } as unknown as ChatGptBackendClient;
    const f = fixture(createRoute, backend);
    const response = await post(f.app, path, body);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toMatch(/event: message_stop|"finish_reason":"stop"|event: response.completed/);
    assertTerminal(f, 'failure', 200);
    expect(f.log.access).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_response' }), 'text');
  });

  it.each([
    ['data: {CANARY\n\n', 'malformed_sse_json'],
    [frame({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'CANARY' } } }), 'response_incomplete'],
    ['', 'missing_terminal'],
    ['data: [DONE]\n\n', 'missing_terminal'],
  ])(`${path}: late protocol failure is actionable (%s)`, async (suffix, protocolReason) => {
    const f = fixture(createRoute, new SessionChatGptBackend({ baseUrl: 'https://test', fetch: async () => new Response(created + suffix) }));
    const response = await post(f.app, path, body);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toMatch(/CANARY|event: message_stop|event: response.completed|"finish_reason":"stop"/);
    assertTerminal(f, 'failure', 200);
    expect(f.log.access).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_response', protocolStage: expect.any(String), protocolReason }), 'text');
  });

  it(`${path}: unknown future event after readiness stays ignored`, async () => {
    const f = fixture(createRoute, new SessionChatGptBackend({ baseUrl: 'https://test', fetch: async () => new Response(created + frame({ type: 'response.future_event', detail: 'CANARY' }) + completed) }));
    const response = await post(f.app, path, body);
    expect(await response.text()).not.toContain('CANARY');
    assertTerminal(f, 'success', 200);
  });

  it(`${path}: configured keepalive comments flow during silence and stop at terminal`, async () => {
    const backend = { stream: async function* () {
      yield { type: 'upstream_ready' };
      await new Promise(resolve => setTimeout(resolve, 35));
      yield { type: 'text_delta', text: 'after-silence' };
      await new Promise(resolve => setTimeout(resolve, 35));
      yield { type: 'done', finishReason: 'stop' };
    } } as unknown as ChatGptBackendClient;
    const f = fixture(createRoute, backend, { sseKeepaliveIntervalMs: 10 });
    const response = await post(f.app, path, body);
    const text = await response.text();
    expect(text).toContain(': keepalive\n\n');
    expect(text).toContain('after-silence');
    const terminalIndex = Math.max(text.lastIndexOf('message_stop'), text.lastIndexOf('[DONE]'), text.lastIndexOf('response.completed'));
    expect(terminalIndex).toBeGreaterThan(-1);
    expect(text.slice(terminalIndex)).not.toContain(': keepalive');
    assertTerminal(f, 'success', 200);
  });

  it(`${path}: real silent-stream client disconnect is graceful without AbortError stderr`, async () => {
    const cancel = vi.fn();
    const stderr: string[] = [];
    // Vitest virtualizes console; capture that path as well as actual process stderr.
    const errorLog = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr.push(args.map(String).join(' ')); });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const backend = new SessionChatGptBackend({ baseUrl: 'https://test', fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(encode(created)); }, cancel })) });
    const f = fixture(createRoute, backend);
    const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>(r => server.listening ? r() : server.once('listening', r));
    const client = httpRequest({ hostname: '127.0.0.1', port: (server.address() as { port: number }).port, path, method: 'POST', headers: { 'content-type': 'application/json' } });
    const received = new Promise<import('node:http').IncomingMessage>((resolve, reject) => { client.on('response', resolve); client.on('error', reject); });
    client.end(JSON.stringify(body));
    try {
      const response = await received;
      await new Promise<void>(resolve => response.once('data', () => resolve()));
      response.destroy(); client.destroy();
      await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1));
      await new Promise(r => setTimeout(r, 30));
      assertTerminal(f, 'cancelled', 200);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(stderr.join('')).not.toMatch(/AbortError|DOMException|Request was cancelled/);
    } finally {
      client.destroy();
      (server as import('node:http').Server).closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
      write.mockRestore();
      errorLog.mockRestore();
    }
  });
  it(`${path}: real node-server sends no headers until valid created, then 200 before terminal`, async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    let fetched!: () => void;
    const started = new Promise<void>(r => { fetched = r; });
    const backend = new SessionChatGptBackend({ baseUrl: 'https://test', fetch: async () => { fetched(); return new Response(new ReadableStream({ start(c) { upstream = c; } })); } });
    const f = fixture(createRoute, backend);
    const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise<void>(r => server.listening ? r() : server.once('listening', r));
    const address = server.address() as { port: number };
    let receivedHeaders = false;
    const client = httpRequest({ hostname: '127.0.0.1', port: address.port, path, method: 'POST', headers: { 'content-type': 'application/json' } });
    const headers = new Promise<import('node:http').IncomingMessage>((resolve, reject) => { client.on('response', response => { receivedHeaders = true; resolve(response); }); client.on('error', reject); });
    client.end(JSON.stringify(body));
    try {
      await started;
      upstream.enqueue(encode(': heartbeat\n\n' + frame({ type: 'extension', delta: 'CANARY' })));
      await new Promise(r => setTimeout(r, 30));
      expect(receivedHeaders).toBe(false);
      upstream.enqueue(encode(created));
      const response = await headers;
      expect(response.statusCode).toBe(200);
      expect(f.release).not.toHaveBeenCalled();
      const finished = new Promise<string>((resolve, reject) => { let text = ''; response.on('data', c => { text += c; }); response.on('end', () => resolve(text)); response.on('error', reject); });
      upstream.enqueue(encode(frame({ type: 'response.output_text.delta', delta: 'hello' }) + completed));
      upstream.close();
      expect(await finished).not.toContain('upstream_ready');
      assertTerminal(f, 'success', 200);
    } finally { client.destroy(); (server as import('node:http').Server).closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });

  it(`${path}: Response assembly failure closes upstream without a second terminal owner`, async () => {
    const NativeResponse = globalThis.Response;
    let failedBody!: ReadableStream;
    vi.stubGlobal('Response', class extends NativeResponse {
      constructor(value?: ConstructorParameters<typeof NativeResponse>[0], init?: ResponseInit) {
        if (value instanceof ReadableStream) { failedBody = value; throw new Error('CANARY'); }
        super(value, init);
      }
    });
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const backend = { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false as const, value: { type: 'upstream_ready' as const } }), return: close }) }) } as unknown as ChatGptBackendClient;
    const f = fixture(createRoute, backend);
    const response = await post(f.app, path, body);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('CANARY');
    await failedBody.cancel();
    expect(close).toHaveBeenCalledTimes(1);
    assertTerminal(f, 'failure', 500);
  });

  it.each([400, 401, 429, 500, 503])(`${path}: HTTP %s remains safe JSON with no prelude`, async status => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://test', fetch: async () => new Response('CANARY', { status }) });
    const f = fixture(createRoute, backend);
    const response = await post(f.app, path, body);
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.text()).not.toMatch(/CANARY|message_start|response.created|data:/);
    assertTerminal(f, 'failure', status);
  });
  it.each(['', 'data: [DONE]\n\n', 'data: {CANARY\n\n', frame({ type: 'response.created', response: 42 })])(`${path}: invalid bootstrap %# returns JSON 502`, async wire => {
    const f = fixture(createRoute, new SessionChatGptBackend({ baseUrl: 'https://test', fetch: async () => new Response(wire) }));
    const response = await post(f.app, path, body);
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.text()).not.toMatch(/CANARY|message_start|response.created|data:/);
    assertTerminal(f, 'failure', 502);
  });
  it(`${path}: actual OAuth refresh failure is safe JSON before any SSE prelude`, async () => {
    let wrapped!: RefreshAwareChatGptBackend;
    const f = fixture(createRoute, { stream: (...args) => wrapped.stream(...args) } as ChatGptBackendClient);
    f.pool.update('session', { secret: { type: 'chatgpt-session', accessToken: 'CANARY', refreshToken: 'CANARY', expiresAt: '2000-01-01T00:00:00Z' } });
    const fetch = vi.fn(async () => new Response('CANARY', { status: 401 }));
    const transport = { stream: vi.fn() } as unknown as ChatGptBackendClient;
    wrapped = new RefreshAwareChatGptBackend(transport, new SessionCredentialManager({ accountPool: f.pool, oauthClient: new CodexOAuthClient({ fetch }) }));
    const response = await post(f.app, path, body);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.text()).not.toMatch(/CANARY|data:|event:/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(transport.stream).not.toHaveBeenCalled();
    assertTerminal(f, 'failure', 401);
  });
  it(`${path}: done-first tool is delivered once through the gate`, async () => {
    const tool = { type: 'function_call', id: 'fc', call_id: 'call_once', name: 'lookup_once', arguments: '{}' };
    const f = fixture(createRoute, new SessionChatGptBackend({ baseUrl: 'https://test', fetch: async () => new Response(frame({ type: 'response.completed', response: { status: 'completed', output: [tool] } })) }));
    const response = await post(f.app, path, body);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('lookup_once');
    if (path !== '/v1/responses') expect(text.match(/lookup_once/g)).toHaveLength(1);
    else expect(text.match(/event: response.output_item.done/g)).toHaveLength(1);
    expect(text).not.toContain('upstream_ready');
    assertTerminal(f, 'success', 200);
  });
  it(`${path}: failure after explicit ready keeps HTTP 200 and SSE terminal`, async () => {
    const f = fixture(createRoute, new SessionChatGptBackend({ baseUrl: 'https://test', fetch: async () => new Response(created + frame({ type: 'response.failed', error: { message: 'CANARY' } })) }));
    const response = await post(f.app, path, body);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Upstream request failed.');
    assertTerminal(f, 'failure', 200);
  });
  it(`${path}: abort during prepare releases even if custom next/return never settle`, async () => {
    const caller = new AbortController();
    let started!: () => void;
    const gate = new Promise<void>(r => { started = r; });
    const close = vi.fn(() => new Promise<IteratorResult<never>>(() => {}));
    const backend = { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => { started(); return new Promise(() => {}); }, return: close }) }) } as unknown as ChatGptBackendClient;
    const f = fixture(createRoute, backend);
    const pending = post(f.app, path, body, caller.signal);
    await gate;
    caller.abort('CANARY');
    const response = await pending;
    expect(response.status).toBe(499);
    assertTerminal(f, 'cancelled', 499);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it(`${path}: cancel immediately after prepare closes upstream and releases once`, async () => {
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const backend = { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false as const, value: { type: 'upstream_ready' as const } }), return: close }) }) } as unknown as ChatGptBackendClient;
    const f = fixture(createRoute, backend);
    const response = await post(f.app, path, body);
    await response.body!.cancel();
    expect(close).toHaveBeenCalledTimes(1);
    assertTerminal(f, 'cancelled', 200);
  });
  it.each(['cancel', 'error', 'timeout'] as const)(`${path}: %s racing with later cancellation has one terminal`, async winner => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(encode(created)); } });
    const f = fixture(createRoute, new SessionChatGptBackend({ baseUrl: 'https://test', streamIdleTimeoutMs: 20, streamBootstrapTimeoutMs: 10, fetch: async () => new Response(upstream) }));
    const response = await post(f.app, path, body, caller.signal);
    const consuming = response.text().catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    if (winner === 'cancel') caller.abort('CANARY');
    else if (winner === 'error') controller.error(new Error('CANARY'));
    else await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(250);
    await consuming;
    caller.abort('CANARY');
    await vi.advanceTimersByTimeAsync(250);
    assertTerminal(f, winner === 'cancel' ? 'cancelled' : 'failure', 200);
    expect(upstream.locked).toBe(false);
    if (winner === 'timeout') expect(f.log.access).toHaveBeenCalledWith(expect.objectContaining({ timeoutKind: 'stream_idle' }), 'text');
  });
  it.each(['response_headers', 'stream_bootstrap'] as const)(`${path}: %s timeout returns JSON 504`, async kind => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://test', responseHeaderTimeoutMs: 20, streamBootstrapTimeoutMs: 20,
      fetch: () => kind === 'response_headers' ? new Promise(() => {}) : Promise.resolve(new Response(new ReadableStream())) });
    const f = fixture(createRoute, backend);
    const response = await post(f.app, path, body);
    expect(response.status).toBe(504);
    expect(response.headers.get('content-type')).toContain('application/json');
    assertTerminal(f, 'failure', 504);
    expect(f.log.access).toHaveBeenCalledWith(expect.objectContaining({ timeoutKind: kind }), 'text');
  });
}
