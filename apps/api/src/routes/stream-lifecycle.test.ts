import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { releaseAccountWhenDone } from './stream-lifecycle.js';
import { ChatGptBackendError } from '@chatgpt-to-claude/chatgpt-backend';
import { accessLog, getAccessLogTerminal } from '../middleware/access-log.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
for (const route of ['/v1/messages', '/v1/chat/completions', '/v1/responses'] as const) {
  it.each(['complete', 'return', 'cancel', 'logger-throws'] as const)(`${route} logs only after slow error-envelope cleanup: %s`, async mode => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const order: string[] = [];
    const release = vi.fn(() => { order.push('release'); });
    const finish = vi.fn(() => { order.push('tracker'); });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(() => {
      order.push('log');
      expect(release).toHaveBeenCalledTimes(1);
      if (mode === 'logger-throws') throw new Error('LOGGER_CANARY');
    }) };
    const caller = new AbortController();
    const app = new Hono();
    let iterator!: AsyncIterator<string>;
    app.use('*', accessLog(logger));
    app.get(route, c => {
      const events = (async function* () { throw new ChatGptBackendError('CANARY', 'timeout', { status: 504, safeDiagnostic: { timeoutKind: 'stream_idle' } }); })();
      iterator = releaseAccountWhenDone({ release } as never, {} as never, events, async function* () {
        try { yield 'error envelope'; } finally { order.push('envelope-cleanup'); }
      }, { finish } as never, caller.signal, { route, terminal: getAccessLogTerminal(c) })[Symbol.asyncIterator]();
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    });
    await app.request(route);
    await vi.advanceTimersByTimeAsync(1);
    expect((await iterator.next()).value).toBe('error envelope');
    expect(logger.error).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1200);
    if (mode === 'cancel') caller.abort();
    if (mode === 'complete') expect((await iterator.next()).done).toBe(true);
    else await iterator.return!();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('HTTP access', expect.objectContaining({ status: 200, durationMs: 1201, durationKind: 'stream_terminal', outcome: 'failure', code: 'timeout', timeoutKind: 'stream_idle' }));
    expect(order).toEqual(['envelope-cleanup', 'tracker', 'release', 'log']);
    await iterator.return!();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('CANARY');
  });
}

it('writes structural replay diagnostics only through the debug logger path', async () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const error = new ChatGptBackendError('CANARY_MESSAGE', 'invalid_response', {
    status: 502,
    safeDiagnostic: { protocolStage: 'replay_snapshot', protocolReason: 'replay_snapshot' },
    replayDebugDiagnostic: {
      eventType: 'response.output_item.done', topLevelFields: ['type', 'item', 'output_index'],
      itemType: 'function_call', itemStatus: 'completed', callerFields: ['type', 'caller_id'], callerType: 'program',
      outputIndex: 'valid', mismatchReason: 'output_snapshot_conflict',
    },
  });
  const owner = releaseAccountWhenDone(
    { release: vi.fn() } as never, {} as never, (async function* () { throw error; })(), async function* () {}, { finish: vi.fn() } as never,
    new AbortController().signal, { route: '/v1/messages', logger },
  );

  for await (const _ of owner) { /* drain */ }

  expect(logger.debug).toHaveBeenCalledWith('ChatGPT replay snapshot validation failed', expect.objectContaining({
    route: '/v1/messages', replay: expect.objectContaining({
      eventType: 'response.output_item.done', topLevelFields: ['item', 'output_index', 'type'], itemType: 'function_call',
      callerFields: ['caller_id', 'type'], callerType: 'program', outputIndex: 'valid', mismatchReason: 'output_snapshot_conflict',
    }),
  }));
  expect(JSON.stringify([logger.debug.mock.calls, logger.error.mock.calls])).not.toContain('CANARY_MESSAGE');
});

it('releases once and emits terminal even when tracker.finish throws', async () => {
  const release = vi.fn();
  const finish = vi.fn(() => { throw new Error('TRACKER_CANARY'); });
  const terminal = vi.fn();
  const owner = releaseAccountWhenDone({ release } as never, {} as never,
    (async function* () { yield 'data: ok\n\n'; })(), async function* () {}, { finish },
    new AbortController().signal, { route: '/v1/messages', terminal });
  const consume = async () => { for await (const _ of owner) { /* drain */ } };
  await expect(consume()).resolves.toBeUndefined();
  await owner.cancel();
  expect(finish).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  expect(terminal).toHaveBeenCalledTimes(1);
  expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
});

describe('releaseAccountWhenDone downstream metrics', () => {
  it('delivers and releases without waiting for queued lifecycle observation', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setImmediate', 'clearImmediate'] });
    const order: string[] = [];
    const lifecycle = vi.fn(() => { order.push('lifecycle'); throw new Error('LOGGER-CANARY'); });
    const release = vi.fn(() => { order.push('release'); });
    const finish = vi.fn(() => { order.push('finish'); });
    const owner = releaseAccountWhenDone(
      { release } as never, {} as never, (async function* () { yield 'data: CANARY-PAYLOAD\n\n'; })(), async function* () {}, { finish } as never,
      new AbortController().signal, { route: '/v1/messages', lifecycle },
    );
    const iterator = owner[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: 'data: CANARY-PAYLOAD\n\n' });
    expect(lifecycle).not.toHaveBeenCalled();
    expect(order).toEqual([]);

    await expect(iterator.return!()).resolves.toMatchObject({ done: true });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['finish', 'release']);
    await vi.runAllTimersAsync();
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it('emits only the queued stream start lifecycle before terminal statistics', async () => {
    vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
    const lifecycle = vi.fn();
    const terminal = vi.fn();
    const owner = releaseAccountWhenDone(
      { release: vi.fn() } as never, {} as never, (async function* () { yield 'data: one\n\n'; yield 'data: two\n\n'; })(), async function* () {}, { finish: vi.fn() } as never,
      new AbortController().signal, { route: '/v1/messages', lifecycle, terminal },
    );
    const iterator = owner[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: 'data: one\n\n' });
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: 'data: two\n\n' });
    expect(lifecycle).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(lifecycle).toHaveBeenCalledTimes(1);
    expect(lifecycle.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ lifecycle: 'start', downstreamEventCount: 1, downstreamBodyBytes: Buffer.byteLength('data: one\n\n') }));
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', downstreamEventCount: 2, downstreamBodyBytes: Buffer.byteLength('data: one\n\ndata: two\n\n') }));
    expect(JSON.stringify([lifecycle.mock.calls, terminal.mock.calls])).not.toContain('one');
    expect(JSON.stringify([lifecycle.mock.calls, terminal.mock.calls])).not.toContain('two');
  });

  it('clears queued start work on terminal cancellation before lifecycle flush', async () => {
    vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
    const lifecycle = vi.fn();
    const release = vi.fn();
    const finish = vi.fn();
    const owner = releaseAccountWhenDone(
      { release } as never, {} as never, (async function* () { yield 'data: one\n\n'; yield 'data: two\n\n'; })(), async function* () {}, { finish } as never,
      new AbortController().signal, { route: '/v1/messages', lifecycle },
    );
    const iterator = owner[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: 'data: one\n\n' });
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: 'data: two\n\n' });
    await expect(iterator.return!()).resolves.toMatchObject({ done: true });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it('keeps lifecycle logs quiet while terminal reports real downstream event progress', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setImmediate', 'clearImmediate'] });
    const lifecycle = vi.fn();
    const terminal = vi.fn();
    const events = (async function* () {
      yield 'data: CANARY-SECRET-1\n\n';
      await new Promise(resolve => setTimeout(resolve, 4_999));
      yield 'data: CANARY-SECRET-2\n\n';
      await new Promise(resolve => setTimeout(resolve, 1));
      yield 'data: CANARY-SECRET-3\n\n';
      await new Promise(resolve => setTimeout(resolve, 5_000));
      yield 'data: CANARY-SECRET-4\n\n';
    })();
    const owner = releaseAccountWhenDone(
      { release: vi.fn() } as never, {} as never, events, async function* () {}, { finish: vi.fn() } as never,
      new AbortController().signal, { route: '/v1/messages', lifecycle, terminal },
    );
    const iterator = owner[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toBe('data: CANARY-SECRET-1\n\n');
    expect(lifecycle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle).toHaveBeenCalledTimes(1);
    expect(lifecycle).toHaveBeenLastCalledWith(expect.objectContaining({ lifecycle: 'start', downstreamEventCount: 1, downstreamBodyBytes: Buffer.byteLength('data: CANARY-SECRET-1\n\n') }));

    const second = iterator.next();
    await vi.advanceTimersByTimeAsync(4_999);
    expect((await second).value).toBe('data: CANARY-SECRET-2\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle).toHaveBeenCalledTimes(1);

    const third = iterator.next();
    await vi.advanceTimersByTimeAsync(1);
    expect((await third).value).toBe('data: CANARY-SECRET-3\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle).toHaveBeenCalledTimes(1);

    const fourth = iterator.next();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await fourth).value).toBe('data: CANARY-SECRET-4\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle).toHaveBeenCalledTimes(1);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await vi.runAllTimersAsync();
    expect(lifecycle).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success', downstreamEventCount: 4,
      downstreamBodyBytes: Buffer.byteLength('data: CANARY-SECRET-1\n\ndata: CANARY-SECRET-2\n\ndata: CANARY-SECRET-3\n\ndata: CANARY-SECRET-4\n\n'),
    }));
    expect(JSON.stringify([lifecycle.mock.calls, terminal.mock.calls])).not.toContain('CANARY-SECRET');
  });

  it('counts yielded SSE events and UTF-8 bytes without inspecting content', async () => {
    const terminal = vi.fn();
    const events = (async function* () { yield 'data: 中文\n\n'; yield 'data: 😀\n\n'; })();
    const owner = releaseAccountWhenDone(
      { release: vi.fn() } as never, {} as never, events, async function* () {}, { finish: vi.fn() } as never,
      new AbortController().signal, { route: '/v1/messages', terminal },
    );
    const output: string[] = [];
    for await (const event of owner) output.push(event);
    expect(output).toEqual(['data: 中文\n\n', 'data: 😀\n\n']);
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success', downstreamEventCount: 2,
      downstreamBodyBytes: Buffer.byteLength('data: 中文\n\ndata: 😀\n\n'),
    }));
  });

  it('counts error SSE payloads through the same UTF-8 downstream accounting path', async () => {
    const terminal = vi.fn();
    const events = (async function* () { yield 'data: normal 中文\n\n'; throw new Error('boom'); })();
    const owner = releaseAccountWhenDone(
      { release: vi.fn() } as never, {} as never, events, async function* () { yield 'data: error 😀\n\n'; }, { finish: vi.fn() } as never,
      new AbortController().signal, { route: '/v1/messages', terminal },
    );
    const output: string[] = [];
    for await (const event of owner) output.push(event);
    expect(output).toEqual(['data: normal 中文\n\n', 'data: error 😀\n\n']);
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure', downstreamEventCount: 2,
      downstreamBodyBytes: Buffer.byteLength(output.join(''), 'utf8'),
    }));
  });
});
