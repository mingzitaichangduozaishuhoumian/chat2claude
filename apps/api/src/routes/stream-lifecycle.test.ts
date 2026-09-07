import { afterEach, expect, it, vi } from 'vitest';
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
