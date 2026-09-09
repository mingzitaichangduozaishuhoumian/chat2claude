import { afterEach, expect, it, vi } from 'vitest';
import { SessionChatGptBackend, type SessionChatGptBackendOptions } from './session.js';

const context = { account: { id: 'test', secret: { type: 'chatgpt-session' as const, accessToken: 'CANARY' } } };
const request = { model: 'test', maxTokens: 1, messages: [] };
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const created = { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } };
const completed = { type: 'response.completed', response: { status: 'completed', output: [] } };
function backend(body: string | ReadableStream<Uint8Array>, options: Partial<SessionChatGptBackendOptions> = {}) {
  return new SessionChatGptBackend({ baseUrl: 'https://test', fetch: async () => new Response(body), ...options });
}
afterEach(() => vi.useRealTimers());

it.each([
  [{ type: 'response.created', response: 'CANARY' }, 'frame_validation', 'invalid_lifecycle'],
  [{ type: 'response.output_text.delta', delta: { secret: 'CANARY' } }, 'frame_validation', 'invalid_text'],
  [{ type: 'response.content_part.done', part: { type: 'output_text', text: 42 } }, 'frame_validation', 'invalid_part'],
  [{ type: 'response.output_item.added', item: null }, 'frame_validation', 'invalid_output_item'],
  [{ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc', call_id: 'call', name: 'f', arguments: 'CANARY' } }, 'tool_finalization', 'tool_finalization'],
  [{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', id: 'rs', summary: [], encrypted_content: 42 }] } }, 'replay_snapshot', 'replay_snapshot'],
] as const)('classifies late invalid frame without retaining content: %s', async (value, protocolStage, protocolReason) => {
  const iterator = backend(frame(created) + frame(value)).stream(request, context)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({ type: 'upstream_ready' });
  const error = await iterator.next().catch(error => error);
  expect(error).toMatchObject({ code: 'invalid_response', safeDiagnostic: { protocolStage, protocolReason } });
  expect(JSON.stringify(error) + String(error)).not.toContain('CANARY');
  expect(error.cause).toBeUndefined();
});

it.each([
  created,
  { type: 'response.in_progress', response: { id: 'resp_1', status: 'in_progress' } },
  { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
  { type: 'response.web_search_call.in_progress', item_id: 'ws_1' },
  { type: 'response.output_text.delta', delta: 'hello' },
  { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc', call_id: 'call', name: 'f', arguments: '{}' } },
  completed,
])('emits ready once before business events for $type', async first => {
  const events = [];
  const terminal = first.type === 'response.output_item.done' && 'item' in first ? { type: 'response.completed', response: { status: 'completed', output: [first.item] } } : completed;
  for await (const event of backend(frame(first) + (first === completed ? '' : frame(terminal))).stream(request, context)) events.push(event);
  expect(events[0]).toEqual({ type: 'upstream_ready' });
  expect(events.filter(e => (e.type as string) === 'upstream_ready')).toHaveLength(1);
  if (first.type === 'response.output_text.delta') expect(events.filter(e => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'hello' }]);
  if (first.type === 'response.output_item.done') expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1);
});

it.each([
  ['response.reasoning_text.delta', 'visible reasoning'],
  ['response.reasoning_summary_text.delta', 'visible summary'],
] as const)('emits readable %s as reasoning_delta after upstream_ready', async (type, delta) => {
  const events = [];
  for await (const event of backend(frame({ type, delta }) + frame(completed)).stream(request, context)) events.push(event);
  expect(events).toEqual([
    { type: 'upstream_ready' },
    { type: 'reasoning_delta', text: delta },
    { type: 'done', finishReason: 'stop' },
  ]);
});

it.each([
  ['response.web_search_call.searching', 'web search searching'],
  ['response.code_interpreter_call.interpreting', 'code interpreter interpreting'],
] as const)('emits safe %s as status_delta after upstream_ready without leaking item_id', async (type, status) => {
  const events = [];
  for await (const event of backend(frame({ type, item_id: 'item_secret_123' }) + frame(completed)).stream(request, context)) events.push(event);
  expect(events).toEqual([
    { type: 'upstream_ready' },
    { type: 'status_delta', status },
    { type: 'done', finishReason: 'stop' },
  ]);
  expect(JSON.stringify(events)).not.toContain('item_secret_123');
});

it.each([
  '', frame(created).slice(0, -2), 'data: [DONE]\n\n', 'data: {CANARY\n\n', frame({ type: 'response.created', response: 'CANARY' }),
  frame({ type: 'response.output_text.delta', delta: 5 }), frame({ type: 'response.output_item.added', item: null }),
  frame({ type: 'response.completed', response: { output: 'CANARY' } }),
  frame({ type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'call', name: 'f', arguments: '{}' }, { type: 'function_call', call_id: 'bad', name: 'f', arguments: 'CANARY' }] } }),
  frame({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs', summary: [], encrypted_content: 42 } }),
  frame({ type: 'extension', text: 'CANARY' }),
])('rejects invalid bootstrap atomically without ready: %s', async body => {
  const iterator = backend(body).stream(request, context)[Symbol.asyncIterator]();
  const error = await iterator.next().catch(e => e);
  expect(error).toMatchObject({ code: 'invalid_response', status: 502 });
  expect(JSON.stringify(error)).not.toContain('CANARY');
});

it.each(['response.failed', 'error', 'response.incomplete', 'response.cancelled'])('rejects first %s without ready', async type => {
  await expect(backend(frame({ type })).stream(request, context)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ status: 502 });
});

it('ignores comments, heartbeat, unknown extensions and partial frames until a valid complete frame', async () => {
  let c!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { c = value; } });
  const iterator = backend(body).stream(request, context)[Symbol.asyncIterator]();
  const ready = vi.fn();
  const pending = iterator.next().then(ready);
  for (const chunk of [': hello\n\n', 'event: ping\n\n', frame({ type: 'extension', delta: 'CANARY' }), frame(created).slice(0, -2)]) {
    c.enqueue(new TextEncoder().encode(chunk));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(ready).not.toHaveBeenCalled();
  }
  c.enqueue(new TextEncoder().encode('\n\n'));
  await pending;
  expect(ready).toHaveBeenCalledWith({ done: false, value: { type: 'upstream_ready' } });
  await iterator.return!();
});

it('uses a non-sliding bootstrap deadline despite permanent heartbeats', async () => {
  vi.useFakeTimers();
  let c!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { c = value; } });
  const result = backend(body, { streamBootstrapTimeoutMs: 50, streamIdleTimeoutMs: 100 }).stream(request, context)[Symbol.asyncIterator]().next().catch(e => e);
  for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(9); c.enqueue(new TextEncoder().encode(': heartbeat\n\n')); }
  await vi.advanceTimersByTimeAsync(5);
  expect(await result).toMatchObject({ code: 'timeout', status: 504, safeDiagnostic: { timeoutKind: 'stream_bootstrap' } });
  expect(vi.getTimerCount()).toBe(0);
});

it('clears bootstrap after ready and explicit bootstrap opts out of legacy total timeout', async () => {
  vi.useFakeTimers();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(new TextEncoder().encode(frame(created))); } });
  const iterator = backend(body, { timeoutMs: 10, streamBootstrapTimeoutMs: 20 }).stream(request, context)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({ type: 'upstream_ready' });
  const pending = iterator.next().catch(error => error);
  await vi.advanceTimersByTimeAsync(30);
  controller.enqueue(new TextEncoder().encode(frame(completed)));
  expect((await pending).value).toMatchObject({ type: 'done' });
  await iterator.return!();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['bytes', 'frames'])('bounds bootstrap %s without retaining payload', async kind => {
  const body = kind === 'bytes' ? ': CANARY' + 'x'.repeat(8 * 1024 * 1024 + 1) : frame({ type: 'extension', value: 'CANARY' }).repeat(257);
  await expect(backend(body).stream(request, context)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
});

it.each([
  { frames: [frame({ type: 'response.content_part.added', part: { type: 'refusal', refusal: 'declined' } })] },
  { frames: [frame(created), frame({ type: 'response.content_part.done', part: { type: 'refusal', refusal: 'declined' } })] },
])('accepts refusal content parts before and after readiness', async ({ frames }) => {
  const events = [];
  for await (const event of backend([...frames, frame(completed)].join('')).stream(request, context)) events.push(event);
  expect(events).toEqual([
    { type: 'upstream_ready' },
    { type: 'done', finishReason: 'stop' },
  ]);
});

it.each([
  { frames: [frame({ type: 'response.content_part.added', part: { type: 'reasoning_text', text: 'thinking' } })] },
  { frames: [frame(created), frame({ type: 'response.content_part.done', part: { type: 'reasoning_text', text: 'thinking' } })] },
])('accepts reasoning text content parts before and after readiness', async ({ frames }) => {
  const events = [];
  for await (const event of backend([...frames, frame(completed)].join('')).stream(request, context)) events.push(event);
  expect(events).toEqual([
    { type: 'upstream_ready' },
    { type: 'done', finishReason: 'stop' },
  ]);
});

it('rejects unknown content-part types without publishing readiness', async () => {
  const error = await backend(frame({ type: 'response.content_part.added', part: { type: 'future_part', text: 'CANARY' } })).stream(request, context)[Symbol.asyncIterator]().next().catch(error => error);
  expect(error).toMatchObject({ code: 'invalid_response', status: 502, safeDiagnostic: { failurePhase: 'response_protocol' } });
  expect(String(error) + JSON.stringify(error)).not.toContain('CANARY');
});

it('does not let an unknown output item cancel the bootstrap deadline', async () => {
  vi.useFakeTimers();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const result = backend(body, { streamBootstrapTimeoutMs: 50, streamIdleTimeoutMs: 100 })
    .stream(request, context)[Symbol.asyncIterator]().next().catch(error => error);
  controller.enqueue(new TextEncoder().encode(frame({ type: 'response.output_item.added', item: { type: 'future_item', secret: 'CANARY' } })));
  await vi.advanceTimersByTimeAsync(50);
  const error = await result;
  expect(error).toMatchObject({ code: 'timeout', status: 504, safeDiagnostic: { timeoutKind: 'stream_bootstrap' } });
  expect(String(error) + JSON.stringify(error)).not.toContain('CANARY');
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { type: 'response.created', response: {} },
  { type: 'response.in_progress', response: { id: 'resp_1' } },
  { type: 'response.completed', response: {} },
])('does not publish readiness for a lifecycle event missing its minimum structure: $type', async frameValue => {
  const iterator = backend(frame(frameValue)).stream(request, context)[Symbol.asyncIterator]();
  const error = await iterator.next().catch(error => error);
  expect(error).toMatchObject({ code: 'invalid_response', status: 502, safeDiagnostic: { failurePhase: 'response_protocol' } });
  expect(String(error) + JSON.stringify(error)).not.toContain('CANARY');
});

it('accepts an otherwise-empty completed envelope only after a validated event opened readiness', async () => {
  const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' };
  const events = [];
  for await (const event of backend(frame({ type: 'response.output_item.done', item }) + frame({ type: 'response.completed', response: {} })).stream(request, context)) events.push(event);
  expect(events).toEqual([
    { type: 'upstream_ready' },
    { type: 'tool_call', toolCall: { id: 'call_1', name: 'lookup', input: {} } },
    { type: 'done', finishReason: 'tool_calls' },
  ]);
});
