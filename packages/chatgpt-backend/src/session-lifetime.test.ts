import { afterEach, expect, it, vi } from 'vitest';
import { SessionChatGptBackend } from './session.js';
import { sanitizeBackendDiagnostic } from './errors.js';
import type { ChatGptCompletionRequest } from './client.js';

const context = { account: { id: 'test', secret: { type: 'chatgpt-session' as const, accessToken: 'CANARY' } } };
const request: ChatGptCompletionRequest = { model: 'test', maxTokens: 1, messages: [{ role: 'user', content: '中文CANARY' }] };
const encode = (text: string) => new TextEncoder().encode(text);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture(total = 0, stalledCancel = false) {
  const cancel = vi.fn(() => stalledCancel ? new Promise<void>(() => {}) : Promise.resolve());
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel });
  let signal!: AbortSignal;
  const backend = new SessionChatGptBackend({ baseUrl: 'https://test', timeoutMs: 50, requestTimeoutMs: 50, responseHeaderTimeoutMs: 50, streamIdleTimeoutMs: 50, streamTotalTimeoutMs: total,
    fetch: async (_url, init) => { signal = init!.signal!; return new Response(body); } });
  return { backend, controller, cancel, body, signal: () => signal };
}

it.each(['comment', 'reasoning', 'tool', 'split'] as const)('keeps an active raw %s stream alive beyond the old absolute limit', async (kind) => {
  vi.useFakeTimers();
  const f = fixture();
  const result = f.backend.complete(request, context).catch(e => e);
  for (let i = 0; i < 12; i++) {
    await vi.advanceTimersByTimeAsync(10);
    f.controller.enqueue(encode(kind === 'comment' ? ': heartbeat\n\n' : kind === 'reasoning' ? 'data: {"type":"response.reasoning_summary_text.delta","delta":"CANARY"}\n\n' : kind === 'tool' ? 'data: {"type":"response.web_search_call.in_progress","item_id":"ws"}\n\n' : ':'));
  }
  f.controller.enqueue(encode('\n\ndata: {"type":"response.completed"}\n\n'));
  expect(await result).toMatchObject({ text: '', finishReason: 'stop' });
  expect(vi.getTimerCount()).toBe(0);
  expect(f.body.locked).toBe(false);
});

it.each(['first', 'later', 'empty', 'stalled-cancel'] as const)('times out idle %s body and bounds reader cleanup', async mode => {
  vi.useFakeTimers();
  const f = fixture(0, mode === 'stalled-cancel');
  const result = f.backend.complete(request, context).catch(e => e);
  await vi.advanceTimersByTimeAsync(20);
  if (mode === 'later') f.controller.enqueue(encode(': activity\n\n'));
  if (mode === 'empty') f.controller.enqueue(new Uint8Array());
  await vi.advanceTimersByTimeAsync(30);
  if (mode === 'later') expect(f.signal().aborted).toBe(false);
  else expect(f.signal().aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(300);
  expect(await result).toMatchObject({ code: 'timeout', status: 504, safeDiagnostic: { timeoutKind: 'stream_idle' } });
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(f.body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('times out headers even when fetch ignores abort', async () => {
  vi.useFakeTimers();
  const backend = new SessionChatGptBackend({ baseUrl: 'https://test', responseHeaderTimeoutMs: 50, fetch: () => new Promise(() => {}) });
  const result = backend.complete(request, context).catch(e => e);
  await vi.advanceTimersByTimeAsync(50);
  expect(await result).toMatchObject({ code: 'timeout', status: 504, safeDiagnostic: { timeoutKind: 'response_headers' } });
  expect(vi.getTimerCount()).toBe(0);
});

it('optional total timeout terminates an active stream', async () => {
  vi.useFakeTimers();
  const f = fixture(100);
  const result = f.backend.complete(request, context).catch(e => e);
  for (let i = 0; i < 9; i++) { await vi.advanceTimersByTimeAsync(10); f.controller.enqueue(encode(': alive\n\n')); }
  await vi.advanceTimersByTimeAsync(10);
  expect(await result).toMatchObject({ code: 'timeout', status: 504, safeDiagnostic: { timeoutKind: 'stream_total' } });
  expect(vi.getTimerCount()).toBe(0);
});

it('caller cancellation wins during timeout cleanup', async () => {
  vi.useFakeTimers();
  const f = fixture(0, true);
  const caller = new AbortController();
  const result = f.backend.complete(request, { ...context, signal: caller.signal }).catch(e => e);
  await vi.advanceTimersByTimeAsync(50);
  caller.abort('CANARY');
  await vi.advanceTimersByTimeAsync(250);
  expect(await result).toMatchObject({ name: 'AbortError' });
  expect(vi.getTimerCount()).toBe(0);
});

it('iterator.return disposes all timers and the caller listener', async () => {
  vi.useFakeTimers();
  const f = fixture(500);
  const caller = new AbortController();
  const remove = vi.spyOn(caller.signal, 'removeEventListener');
  const iterator = f.backend.stream(request, { ...context, signal: caller.signal })[Symbol.asyncIterator]();
  f.controller.enqueue(encode('data: {"type":"response.output_text.delta","delta":"ok"}\n\n'));
  await iterator.next();
  await iterator.return!();
  expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(f.cancel).toHaveBeenCalledTimes(1);
});

it('publishes exact serialized UTF8 wire metrics before a failing fetch', async () => {
  let wire = '';
  const metrics = vi.fn();
  const schema = { type: 'object', description: '中文CANARY' };
  const backend = new SessionChatGptBackend({ baseUrl: 'https://test', fetch: async (_url, init) => { wire = init!.body as string; expect(metrics).toHaveBeenCalledTimes(1); throw new Error('CANARY'); } });
  await backend.complete({ ...request, tools: [{ name: 'tool', inputSchema: schema }], inputItems: [
    { type: 'message', role: 'system', content: '系统CANARY' },
    { type: 'message', role: 'user', content: [{ type: 'text', text: 'CANARY' }, { type: 'image', imageUrl: 'https://CANARY' }] },
    { type: 'function_call', callId: 'call', name: 'tool', arguments: { secret: 'CANARY' } },
    { type: 'function_call_output', callId: 'call', output: 'CANARY' },
    { type: 'replay', item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'CANARY' } },
  ] }, { ...context, onWireMetrics: metrics }).catch(() => {});
  expect(metrics).toHaveBeenCalledWith({ upstreamBodyBytes: Buffer.byteLength(wire, 'utf8'), upstreamInputItemCount: 5, replayItemCount: 1, replayApplied: true, toolCount: 1, toolSchemaBytes: Buffer.byteLength(JSON.stringify(schema), 'utf8') });
  expect(Buffer.byteLength(wire)).toBeGreaterThan(wire.length);
  expect(JSON.stringify(metrics.mock.calls)).not.toContain('CANARY');
});

it('only permits fixed timeout kinds in diagnostics', () => {
  expect(sanitizeBackendDiagnostic({ timeoutKind: 'stream_idle', body: 'CANARY', cause: 'CANARY' })).toEqual({ timeoutKind: 'stream_idle' });
  expect(sanitizeBackendDiagnostic({ timeoutKind: 'CANARY' })).toEqual({});
});
