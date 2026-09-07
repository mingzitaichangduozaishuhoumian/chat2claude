import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ChatGptBackendError, SessionChatGptBackend, type ChatGptBackendClient, type ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
import { createMessagesRoute } from './routes/messages.js';
import { createOpenAiChatRoute } from './routes/openai-chat.js';
import { createOpenAiResponsesRoute } from './routes/openai-responses.js';
import { AccountPool } from './services/account-pool.js';
import { AdminOperationalState } from './services/admin-operational-state.js';
import { ModelRegistry } from './services/model-registry.js';
import { RequestLog } from './services/request-log.js';
import { accessLog, type HttpAccessLog } from './middleware/access-log.js';

const protocols = [
  { path: '/v1/messages', route: createMessagesRoute, body: { max_tokens: 8, messages: [{ role: 'user', content: 'hello' }] } },
  { path: '/v1/chat/completions', route: createOpenAiChatRoute, body: { messages: [{ role: 'user', content: 'hello' }] } },
  { path: '/v1/responses', route: createOpenAiResponsesRoute, body: { input: 'hello' } },
];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

for (const protocol of protocols) describe(protocol.path, () => {
  function fixture(timeoutMs?: number, backendOverride?: ChatGptBackendClient) {
    const pool = new AccountPool({ seedMockAccount: false });
    const account = pool.add({ id: 'session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'canary-secret' } });
    const models = new ModelRegistry({ defaults: { aliases: [] } });
    models.replaceAccountModels({ accountId: account.id, createdAt: account.createdAt }, [{ id: 'test-model' }]);
    let end!: () => void;
    const gate = new Promise<void>((resolve) => { end = resolve; });
    let fail = false;
    const backend: ChatGptBackendClient = backendOverride ?? {
      listModels: vi.fn(async () => [{ id: 'test-model' }]),
      complete: vi.fn(async () => ({ text: 'ok', finishReason: 'stop' as const })),
      stream: vi.fn(async function* (): AsyncIterable<ChatGptStreamEvent> {
        await gate;
        if (fail) throw new Error('private stream failure');
        yield { type: 'text_delta', text: 'hello' };
        yield { type: 'done', finishReason: 'stop' };
      }),
    };
    const streamLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logs: HttpAccessLog[] = [];
    const capture = (_message: string, meta?: unknown) => { logs.push(meta as HttpAccessLog); };
    const app = new Hono();
    app.use('*', accessLog({ debug: capture, info: capture, warn: capture, error: capture }));
    // Keep persistence outside even the 95-second virtual streaming test.
    const operationalState = new AdminOperationalState({ path: 'unused.json', debounceMs: 120_000 });
    app.route('/', protocol.route({ logger: streamLogger, backend, accountPool: pool, modelRegistry: models, requestLog: new RequestLog(), operationalState, backendProvider: 'session', accountAcquireTimeoutMs: timeoutMs }));
    const request = (stream = false, signal?: AbortSignal) => app.request(protocol.path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ ...protocol.body, model: 'test-model', stream }),
    });
    return { pool, models, backend, request, logs, streamLogger, operationalState, end: (error = false) => { fail = error; end(); } };
  }

  it('streams for 95 seconds with no premature access line or duplicated chunks', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const backend = new SessionChatGptBackend({ baseUrl: 'https://test', requestTimeoutMs: 50_000, responseHeaderTimeoutMs: 50_000, streamIdleTimeoutMs: 15_000, streamTotalTimeoutMs: 0, fetch: async () => new Response(body) });
    const { request, logs, pool } = fixture(undefined, backend);
    const response = await request(true);
    const pending = response.text();
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"UNIQUE_CHUNK"}\n\n'));
      expect(logs).toHaveLength(0);
    }
    await vi.advanceTimersByTimeAsync(5000);
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'));
    const text = await pending;
    if (protocol.path === '/v1/responses') expect(text).toContain('UNIQUE_CHUNK'.repeat(9));
    else expect((text.match(/"(?:content|text)":"UNIQUE_CHUNK"/g) ?? []).length).toBe(9);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 200, outcome: 'success', durationKind: 'stream_terminal', durationMs: 95_000 });
    expect(pool.get('session')?.currentConcurrency).toBe(0);
    expect(body.locked).toBe(false);
  });

  it('records non-streaming serialization failure rather than an early success', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const backend: ChatGptBackendClient = {
      listModels: async () => [], stream: async function* () {},
      complete: async () => ({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call', name: 'tool', input: circular }] }),
    };
    const { request, logs, pool } = fixture(undefined, backend);
    expect((await request()).status).toBe(500);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 500, outcome: 'failure' });
    expect(pool.get('session')?.currentConcurrency).toBe(0);
  });

  it.each([false, true])('releases accounts on mapper errors even when the logging sink throws=%s', async brokenLogger => {
    const circular: Record<string, unknown> = { secret: 'MAPPER_CANARY' };
    circular.self = circular;
    const backend: ChatGptBackendClient = {
      listModels: async () => [], complete: async () => ({ text: '', finishReason: 'stop' }),
      stream: async function* () { yield { type: 'tool_call', toolCall: { id: 'call', name: 'tool', input: circular } }; },
    };
    const { request, logs, pool } = fixture(undefined, backend);
    if (brokenLogger) vi.spyOn(logs, 'push').mockImplementation(() => { throw new Error('LOGGER_CANARY'); });
    const response = await request(true);
    await response.text();
    expect(pool.get('session')?.currentConcurrency).toBe(0);
    if (!brokenLogger) {
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ status: 200, outcome: 'failure', exceptionFamily: 'TypeError' });
      expect(JSON.stringify(logs)).not.toContain('MAPPER_CANARY');
    }
  });

  it.each(['upstream_error', 'internal_error', 'untrusted_code'] as const)('logs safe %s after HTTP 200 without exposing provider details', async (code) => {
    const canary = 'provider-token-cookie-message-cause-canary';
    const error = code === 'internal_error' ? new Error(canary, { cause: canary })
      : new ChatGptBackendError(canary, 'upstream_error', { cause: new Error(canary) });
    if (code === 'untrusted_code') Object.defineProperty(error, 'code', { value: canary });
    const backend: ChatGptBackendClient = {
      listModels: async () => [],
      complete: async () => ({ text: 'ok', finishReason: 'stop' }),
      stream: async function* () { yield { type: 'text_delta', text: canary }; throw error; },
    };
    const { request, logs, streamLogger, pool } = fixture(undefined, backend);
    const response = await request(true);
    expect(response.status).toBe(200);
    await response.text();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 200, durationKind: 'stream_terminal',
      path: protocol.path, outcome: 'failure', code: code === 'upstream_error' ? code : 'internal_error',
      exceptionFamily: code === 'internal_error' ? 'Error' : 'ChatGptBackendError',
    });
    expect(streamLogger.error).not.toHaveBeenCalled();
    expect(streamLogger.info).not.toHaveBeenCalled();
    expect(JSON.stringify([logs, streamLogger.error.mock.calls, pool.exportState()])).not.toContain(canary);
    expect(pool.acquire()).toBeDefined();
  });

  it.each(['error', 'response.failed', 'response.incomplete', 'body-read', 'http-error'] as const)('logs safe %s diagnostics and counts one failure in both response modes', async (type) => {
    const canary = 'SESSION_ROUTE_PRIVATE_CANARY';
    for (const stream of [false, true]) {
      const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => {
        if (type === 'body-read') return new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError(canary)); } }));
        if (type === 'http-error') return new Response(canary, { status: 503 });
        return new Response(`data: ${JSON.stringify({ type, message: canary, param: canary, details: canary, response: { status: type === 'response.incomplete' ? 'incomplete' : 'failed', error: { code: canary, message: canary, param: canary, detail: canary, details: canary }, incomplete_details: { reason: 'max_output_tokens', explanation: canary } } })}\n\n`);
      } });
      const { request, logs, streamLogger, operationalState, pool } = fixture(undefined, backend);
      const response = await request(stream);
      const text = await response.text();
      expect(response.status).toBe(stream ? 200 : 502);
      const fields = {
        path: protocol.path, requestId: logs[0].requestId, outcome: 'failure', exceptionFamily: 'ChatGptBackendError',
        code: type === 'body-read' ? 'network_error' : type === 'response.incomplete' ? 'invalid_response' : 'upstream_error',
        httpStatus: type === 'http-error' ? 503 : 200,
        failurePhase: type === 'http-error' ? 'response_headers' : type === 'body-read' ? 'response_body_read' : type === 'response.incomplete' ? 'response_incomplete' : 'response_event',
        ...(type === 'body-read' || type === 'http-error' ? {} : { eventType: type, responseStatus: type === 'response.incomplete' ? 'incomplete' : 'failed', responseErrorCode: 'unknown' }),
        ...(type === 'response.incomplete' ? { incompleteReason: 'max_output_tokens' } : {}),
      };
      expect(streamLogger.error).not.toHaveBeenCalled();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject(fields);
      expect(text + JSON.stringify([logs, streamLogger.error.mock.calls, operationalState.snapshot(), pool.exportState()])).not.toContain(canary);
      expect(operationalState.snapshot().accounts[0]?.requestStats).toMatchObject({ totalRequests: 1, failedRequests: 1, successfulRequests: 0, cancelledRequests: 0, inFlight: 0 });
      expect(pool.get('session')?.currentConcurrency).toBe(0);
    }
  });

  it.each(['reader-cancel', 'request-abort'] as const)('interrupts already-blocked upstream I/O on %s and releases for the queued request', async (outcome) => {
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    let finishCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => { finishCancel = resolve; });
    const bodyCancel = vi.fn(() => cancelGate);
    const upstreamBody = new ReadableStream<Uint8Array>({
      pull() { entered(); return new Promise<void>(() => {}); },
      cancel: bodyCancel,
    }, { highWaterMark: 0 });
    const signals: AbortSignal[] = [];
    let calls = 0;
    const backend = new SessionChatGptBackend({
      baseUrl: 'https://chatgpt.test', timeoutMs: 60_000,
      fetch: async (_url, init) => {
        signals.push(init!.signal!);
        return ++calls === 1 ? new Response(upstreamBody) : new Response('data: {"type":"response.completed"}\n\n');
      },
    });
    const { pool, request, operationalState } = fixture(undefined, backend);
    const release = vi.spyOn(pool, 'release');
    const requestAbort = new AbortController();
    const first = await request(true, requestAbort.signal);
    const reader = first.body!.getReader();
    const consuming = (async () => { while (!(await reader.read()).done) { /* Drain protocol prelude into the blocking backend read. */ } })();
    const consumed = consuming.catch((error: unknown) => error);
    await reading;
    expect(pool.get('session')?.currentConcurrency).toBe(1);
    expect(signals[0].aborted).toBe(false);
    let queued!: () => void;
    const waiting = new Promise<void>((resolve) => { queued = resolve; });
    const acquire = pool.acquireAsync.bind(pool);
    vi.spyOn(pool, 'acquireAsync').mockImplementation((...args) => {
      const pending = acquire(...args);
      queued();
      return pending;
    });
    let secondFinished = false;
    const second = Promise.resolve(request()).then((response) => { secondFinished = true; return response; });
    await waiting;
    expect(pool.pendingAcquisitions).toBe(1);
    expect(calls).toBe(1);
    let teardownFinished = false;
    const cancellation = outcome === 'reader-cancel' ? reader.cancel().then(() => { teardownFinished = true; }) : undefined;
    if (outcome === 'request-abort') requestAbort.abort('private cancellation detail');
    await vi.waitFor(() => expect(bodyCancel).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      expect(teardownFinished).toBe(false);
      expect(secondFinished).toBe(false);
      expect(release).not.toHaveBeenCalled();
      expect(upstreamBody.locked).toBe(true);
      expect(pool.get('session')?.currentConcurrency).toBe(1);
      expect(pool.pendingAcquisitions).toBe(1);
      expect(calls).toBe(1);
      expect(operationalState.snapshot().accounts[0]?.requestStats).toMatchObject({
        totalRequests: 0, cancelledRequests: 0, failedRequests: 0, inFlight: 1,
      });
    } finally {
      finishCancel();
    }
    await cancellation;
    await consumed;
    expect((await second).status).toBe(200);
    expect(bodyCancel).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(true);
    expect(upstreamBody.locked).toBe(false);
    expect(pool.get('session')).toMatchObject({ currentConcurrency: 0, status: 'available' });
    expect(pool.pendingAcquisitions).toBe(0);
    expect(calls).toBe(2);
    expect(operationalState.snapshot().accounts[0]?.requestStats).toMatchObject({
      totalRequests: 2, successfulRequests: 1, cancelledRequests: 1, failedRequests: 0, inFlight: 0,
    });
  });

  it.each(['complete', 'cancel', 'error'])('holds the SSE slot until %s, then wakes the next request', async (outcome) => {
    const { pool, backend, request, end, operationalState, streamLogger, logs } = fixture();
    const first = await request(true);
    expect(first.status).toBe(200);
    expect(pool.get('session')?.currentConcurrency).toBe(1);
    const second = request();
    await vi.waitFor(() => expect(pool.pendingAcquisitions).toBe(1));
    expect(backend.complete).not.toHaveBeenCalled();
    expect(operationalState.snapshot().accounts[0]?.requestStats).toMatchObject({ totalRequests: 0, inFlight: 1 });
    if (outcome === 'cancel') await first.body!.cancel();
    else {
      end(outcome === 'error');
      const text = await first.text();
      if (outcome === 'error') expect(text).toMatch(/error|response.failed/);
    }
    expect((await second).status).toBe(200);
    expect(backend.complete).toHaveBeenCalledTimes(1);
    expect(streamLogger.error).not.toHaveBeenCalled();
    expect(streamLogger.info).not.toHaveBeenCalled();
    expect(logs.filter(entry => entry.durationKind === 'stream_terminal')).toEqual([expect.objectContaining({
      path: protocol.path, status: 200,
      outcome: outcome === 'complete' ? 'success' : outcome === 'cancel' ? 'cancelled' : 'failure',
      ...(outcome === 'error' ? { code: 'internal_error', exceptionFamily: 'Error' } : {}),
    })]);
    expect(operationalState.snapshot().accounts[0]?.requestStats).toMatchObject({
      totalRequests: 2, successfulRequests: outcome === 'complete' ? 2 : 1,
      cancelledRequests: outcome === 'cancel' ? 1 : 0, failedRequests: outcome === 'error' ? 1 : 0, inFlight: 0,
    });
    expect(pool.get('session')).toMatchObject({ currentConcurrency: 0, status: 'available' });
    expect(pool.pendingAcquisitions).toBe(0);
  });

  it.each([0, 20])('preserves 503 envelopes and logs safe reason for timeout %i', async (timeout) => {
    const { pool, backend, request, logs } = fixture(timeout);
    pool.acquire({ provider: 'chatgpt-session' });
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { type: 'overloaded_error' } });
    expect(logs[0]).toMatchObject({ model: 'test-model', reason: timeout === 0 ? 'account_busy' : 'account_busy_timeout' });
    expect(JSON.stringify(logs)).not.toContain('canary-secret');
    expect(backend.complete).not.toHaveBeenCalled();
    expect(pool.pendingAcquisitions).toBe(0);
    expect(pool.get('session')).toMatchObject({ currentConcurrency: 1, status: 'available' });
  });

  it('aborts a pending request and cleans the waiter without modifying account health', async () => {
    const { pool, request, logs, backend } = fixture();
    pool.acquire();
    const controller = new AbortController();
    const pending = request(false, controller.signal);
    await vi.waitFor(() => expect(pool.pendingAcquisitions).toBe(1));
    controller.abort('private abort reason');
    expect((await pending).status).toBe(503);
    expect(logs[0]).toMatchObject({ reason: 'request_aborted' });
    expect(pool.pendingAcquisitions).toBe(0);
    expect(backend.complete).not.toHaveBeenCalled();
    expect(pool.get('session')).toMatchObject({ currentConcurrency: 1, status: 'available' });
  });

  it.each(['no_account', 'capability_unavailable', 'model_or_controls_unsupported'] as const)('does not wait for %s', async (reason) => {
    const { pool, models, backend, request, logs } = fixture();
    if (reason === 'no_account') pool.remove('session');
    if (reason === 'capability_unavailable') pool.update('session', { capabilities: ['other'] });
    if (reason === 'model_or_controls_unsupported') {
      // Keep the model globally visible, but absent from this account's catalog.
      models.replaceDiscoveredModels([{ id: 'test-model' }]);
      const account = pool.get('session')!;
      models.replaceAccountModels({ accountId: account.id, createdAt: account.createdAt }, []);
    }
    expect((await request()).status).toBe(503);
    expect(logs[0]).toMatchObject({ reason });
    expect(pool.pendingAcquisitions).toBe(0);
    expect(backend.complete).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled', 'account_disabled'], ['unhealthy', 'account_unhealthy'], ['error', 'account_error'], ['cooldown', 'account_cooldown'],
  ] as const)('does not wait for %s', async (status, reason) => {
    const { pool, request, logs } = fixture();
    pool.update('session', { status });
    expect((await request()).status).toBe(503);
    expect(logs[0]).toMatchObject({ reason });
    expect(pool.pendingAcquisitions).toBe(0);
  });
});
