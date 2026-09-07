import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionChatGptBackend, type ChatGptCompletionRequest, type ChatGptReplayItem, type ChatGptStreamEvent } from './index.js';
import { parseResponsesReplayItem, RESPONSES_REPLAY_LIMITS } from './responses-replay.js';

const request: ChatGptCompletionRequest = { model: 'gpt-test', maxTokens: 128, messages: [] };
const context = { account: { id: 'test', provider: 'chatgpt-session' as const, secret: { type: 'chatgpt-session' as const, accessToken: 'test' } } };
const canary = 'REPLAY_SECRET_CANARY';
const reasoning = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'summary' }], content: [{ type: 'reasoning_text', text: 'reasoning' }], status: 'completed', encrypted_content: ` \t${canary}\r\n+/= 雪 ` } satisfies ChatGptReplayItem;
const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: ' { "q": "x" } ', status: 'completed', async: false, caller: { type: 'direct' }, namespace: 'tools' } satisfies ChatGptReplayItem;
const completed = (output: unknown) => ({ type: 'response.completed', response: { status: 'completed', output } });
const done = (item: unknown, output_index: number) => ({ type: 'response.output_item.done', output_index, item });
function backend(frames: unknown[], fetchSpy?: (body: unknown) => void) {
  return new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
    fetchSpy?.(JSON.parse(String(init?.body)));
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
  } });
}
async function events(frames: unknown[]) {
  const result: ChatGptStreamEvent[] = [];
  for await (const event of backend(frames).stream(request, context)) result.push(event);
  return result;
}
afterEach(() => vi.restoreAllMocks());

describe('session ordered opaque replay', () => {
  it.each([
    [[reasoning, call], true],
    [[call], true],
    [[reasoning], false],
    [[reasoning, { type: 'message', content: [] }, call], false],
    [[{ type: 'reasoning', id: 'rs_missing', summary: [] }, call], false],
    [[reasoning, reasoning, call], false],
  ] as const)('marks implicit replay eligibility only for an entire tool/reasoning output %#', async (output, replayEligible) => {
    await expect(backend([completed(output)]).complete(request, context)).resolves.toMatchObject({ replayEligible });
    expect((await events([completed(output)])).at(-1)).toMatchObject({ type: 'done', replayEligible });
  });
  it('commits completed output order, full wire fields and exact ciphertext only on done', async () => {
    const output = [reasoning, { type: 'message', content: [] }, call, { ...reasoning, id: 'rs_2' }];
    const frames = [done(call, 2), done(reasoning, 0), done(reasoning, 0), completed(output)];
    const stream = await events(frames);
    const outputItems = [reasoning, { type: 'message', role: 'assistant', status: 'completed', content: [] }, call, output[3]];
    expect(stream).toEqual([
      { type: 'upstream_ready' },
      { type: 'tool_call', toolCall: { id: 'call_1', name: 'lookup', input: { q: 'x' } } },
      { type: 'done', finishReason: 'tool_calls', replayItems: [reasoning, call, output[3]], replayEligible: false, outputItems },
    ]);
    expect(JSON.stringify(stream.filter((event) => event.type !== 'done'))).not.toContain(canary);
    await expect(backend(frames).complete(request, context)).resolves.toEqual({
      text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'lookup', input: { q: 'x' } }], replayItems: [reasoning, call, output[3]], replayEligible: false, outputItems,
    });
  });

  it('compares wire objects independently of property order and deduplicates identical output identities', async () => {
    const reordered = Object.fromEntries(Object.entries(reasoning).reverse());
    await expect(backend([done(reordered, 0), completed([reasoning, reasoning])]).complete(request, context))
      .resolves.toMatchObject({ replayItems: [reasoning] });
  });

  it.each([
    [done(reasoning, 0), completed([{ ...reasoning, encrypted_content: 'changed' }])],
    [done(reasoning, 0), done({ ...reasoning, summary: [] }, 0), completed([reasoning])],
    [done(reasoning, 0), completed([call, reasoning])],
    [done(reasoning, 0), completed([])],
    [completed([reasoning, { ...reasoning, encrypted_content: 'changed' }])],
    [completed([call, { ...call, id: 'fc_other' }])],
    [done(reasoning, -1), completed([reasoning])],
    [done(reasoning, 1.5), completed([reasoning])],
    [done(call, 0), completed([{ ...call, arguments: '{"q":"x"}' }])],
  ])('rejects conflicting identities, indices or exact wire snapshots %#', async (...frames) => {
    await expect(backend(frames).complete(request, context)).rejects.toMatchObject({ code: 'invalid_response', status: 502, safeDiagnostic: { failurePhase: 'response_protocol' } });
  });

  it.each([undefined, null])('does not replay reasoning without ciphertext (%s)', async (encrypted_content) => {
    await expect(backend([completed([{ ...reasoning, encrypted_content }])]).complete(request, context)).resolves.toEqual({ text: '', finishReason: 'stop' });
  });

  it.each([
    { ...reasoning, encrypted_content: 42 },
    { ...reasoning, encrypted_content: '' },
    { ...reasoning, id: 42 },
    { ...reasoning, summary: [{ type: 'summary_text', text: 42 }] },
    { ...reasoning, content: [{ type: 'output_text', text: canary }] },
    { ...reasoning, status: canary },
    { ...reasoning, unexpected: canary },
    { ...call, arguments: {} },
    { ...call, caller: { type: 'program', caller_id: 42 } },
  ])('rejects malformed full wire items with payload-free diagnostics %#', async (item) => {
    const logs = ['log', 'warn', 'error', 'debug', 'info'].map((method) => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
    const error = await backend([completed([item])]).complete(request, context).catch((error: unknown) => error);
    expect(error).toMatchObject({ name: 'ChatGptBackendError', code: 'invalid_response', status: 502, cause: undefined, safeDiagnostic: { httpStatus: 200, failurePhase: 'response_protocol' } });
    expect(inspect(error, { depth: null }) + JSON.stringify(error)).not.toContain(canary);
    expect(logs.flatMap((log) => log.mock.calls)).toEqual([]);
  });

  it.each(['item', 'bundle', 'count', 'done-bundle', 'done-count'] as const)('bounds replay %s', async (mode) => {
    const output = mode === 'item' ? [{ ...reasoning, encrypted_content: '雪'.repeat(90_000) }]
      : Array.from({ length: mode.includes('count') ? 129 : 6 }, (_, i) => ({ ...reasoning, id: `rs_${i}`, encrypted_content: mode.includes('count') ? 'x' : 'x'.repeat(200_000) }));
    const frames = mode.startsWith('done-') ? [...output.map(done), completed(output)] : [completed(output)];
    await expect(backend(frames).complete(request, context)).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
  });

  it.each(['response.failed', 'response.incomplete', 'response.error', 'error', 'cancelled', 'in_progress', 'missing-terminal', 'legacy-done', 'missing-output'] as const)('never commits unsuccessful or incomplete provenance: %s', async (mode) => {
    const terminal = mode === 'missing-terminal' ? [] : mode === 'legacy-done' ? [{ type: 'done' }]
      : mode === 'missing-output' ? [{ type: 'response.completed' }]
      : mode === 'cancelled' || mode === 'in_progress' ? [{ type: 'response.completed', response: { status: mode, output: [reasoning] } }]
      : [{ type: mode, response: { output: [reasoning], error: { message: canary } } }];
    const stream: ChatGptStreamEvent[] = [];
    try { for await (const event of backend([done(reasoning, 0), ...terminal]).stream(request, context)) stream.push(event); }
    catch (error) { expect(inspect(error, { depth: null })).not.toContain(canary); }
    expect(JSON.stringify(stream)).not.toContain(canary);
    expect(stream.every((event) => !('replayItems' in event))).toBe(true);
  });

  it.each([
    { type: 'response.cancelled' },
    { type: 'response.created', response: { status: 'cancelled' } },
    { type: 'response.completed', status: 'cancelled' },
  ])('rejects an upstream cancellation terminal even if success follows %#', async (terminal) => {
    const stream: ChatGptStreamEvent[] = [];
    const collect = async () => {
      for await (const event of backend([done(reasoning, 0), terminal, completed([reasoning])]).stream(request, context)) stream.push(event);
    };
    await expect(collect()).rejects.toMatchObject({ code: 'upstream_error', status: 502, cause: undefined });
    expect(stream.every((event) => !('replayItems' in event))).toBe(true);
  });

  it('does not commit when caller aborts while a completed tool event is yielded', async () => {
    const controller = new AbortController();
    const iterator = backend([completed([reasoning, call])]).stream(request, { ...context, signal: controller.signal })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'upstream_ready' });
    expect((await iterator.next()).value).toMatchObject({ type: 'tool_call' });
    controller.abort(new Error(canary));
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not commit on caller cancellation after a done snapshot', async () => {
    const controller = new AbortController();
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({ pull(stream) {
      if (reads++ === 0) stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(done(reasoning, 0))}\n\n`));
      else controller.abort(new Error(canary));
    } }, { highWaterMark: 0 });
    const client = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(body) });
    const error = await client.complete(request, { ...context, signal: controller.signal }).catch((error: unknown) => error);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(inspect(error, { depth: null })).not.toContain(canary);
  });

  it.each([null, [], 'reasoning', 42, new (class { type = 'reasoning'; encrypted_content = canary; })(), Object.create(reasoning)])('rejects non-plain replay candidates %#', (item) => {
    expect(() => parseResponsesReplayItem(item)).toThrowError(expect.objectContaining({ code: 'invalid_response', status: 502, cause: undefined }));
  });

  it('returns a detached wire snapshot without mutating allowed fields', () => {
    const item = { ...reasoning, summary: [{ type: 'summary_text', text: 'original' }] };
    const replay = parseResponsesReplayItem(item);
    expect(replay).toEqual(item);
    item.summary[0].text = 'modified';
    expect(replay).toMatchObject({ summary: [{ type: 'summary_text', text: 'original' }] });
  });

  it.each([null, { type: 'program', caller_id: 'caller_1' }])('preserves optional caller wire shapes %#', async (caller) => {
    const item = { ...call, caller };
    await expect(backend([completed([item])]).complete(request, context)).resolves.toMatchObject({ replayItems: [item] });
  });

  it('ignores added reasoning snapshots and accepts event-name-only completed output', async () => {
    const frames = [
      { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, encrypted_content: 'partial' } },
      completed([reasoning]),
    ];
    const client = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () =>
      new Response(frames.map(({ type, ...data }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join('')) });
    await expect(client.complete(request, context)).resolves.toMatchObject({ replayItems: [reasoning] });
  });

  it.each([null, {}, [null], [[]], [canary]])('rejects malformed completed output envelopes %#', async (output) => {
    await expect(backend([completed(output)]).complete(request, context)).rejects.toMatchObject({ code: 'invalid_response', status: 502, cause: undefined });
  });

  it('accepts exact item and bundle byte boundaries and rejects one byte over', async () => {
    const sized = (bytes: number, id: string) => {
      const item = { ...reasoning, id, encrypted_content: '' };
      return { ...item, encrypted_content: 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(item))) };
    };
    const exactItem = sized(RESPONSES_REPLAY_LIMITS.itemBytes, 'rs_item');
    await expect(backend([completed([exactItem])]).complete(request, context)).resolves.toHaveProperty('replayItems');
    const items = Array.from({ length: 4 }, (_, i) => sized(RESPONSES_REPLAY_LIMITS.itemBytes - (i === 3 ? 5 : 0), `rs_${i}`));
    expect(Buffer.byteLength(JSON.stringify(items))).toBe(RESPONSES_REPLAY_LIMITS.bundleBytes);
    await expect(backend([completed(items)]).complete(request, context)).resolves.toHaveProperty('replayItems');
    items[3].encrypted_content += 'x';
    await expect(backend([completed(items)]).complete(request, context)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(backend([completed([{ ...exactItem, encrypted_content: `${exactItem.encrypted_content}x` }])]).complete(request, context)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('accepts exactly 128 items, including corroborating done snapshots', async () => {
    const items = Array.from({ length: 128 }, (_, i) => ({ ...reasoning, id: `rs_${i}` }));
    await expect(backend([...items.map(done), completed(items)]).complete(request, context)).resolves.toMatchObject({ replayItems: items });
  });

  it.each(['item', 'bundle', 'count'] as const)('bounds replay input %s before sending a request', async (mode) => {
    const capture = vi.fn();
    const items = Array.from({ length: mode === 'item' ? 1 : mode === 'count' ? 129 : 6 }, (_, i) => ({
      type: 'replay' as const, item: { ...reasoning, id: `rs_${i}`, encrypted_content: 'x'.repeat(mode === 'item' ? 300_000 : mode === 'bundle' ? 200_000 : 1) },
    }));
    await expect(backend([completed([])], capture).complete({ ...request, inputItems: items }, context)).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
    expect(capture).not.toHaveBeenCalled();
  });

  it('serializes replay input as structured full wire objects amidst ordinary history', async () => {
    const capture = vi.fn();
    const inputItems: NonNullable<ChatGptCompletionRequest['inputItems']> = [
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'replay', item: reasoning },
      { type: 'replay', item: call },
      { type: 'function_call_output', callId: 'call_1', output: 'result' },
    ];
    await backend([completed([])], capture).complete({ ...request, inputItems }, context);
    expect(capture.mock.calls[0][0]).toEqual({ model: 'gpt-test', input: [
      { type: 'message', role: 'user', content: 'hi' }, reasoning, call,
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
    ], stream: true, store: false, include: ['reasoning.encrypted_content'], instructions: '' });
  });
});
