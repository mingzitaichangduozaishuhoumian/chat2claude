import { afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { accessLog, getAccessLogTerminal } from './access-log.js';
import { createLogger } from '@chatgpt-to-claude/shared';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it.each(['success', 'failure', 'cancelled'] as const)('emits exactly one terminal access line for %s, never response-ready', async outcome => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout'] });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = new Hono();
  let terminal!: ReturnType<typeof getAccessLogTerminal>;
  app.use('*', accessLog(logger));
  app.get('/v1/messages', c => { terminal = getAccessLogTerminal(c); return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }); });
  const response = await app.request('/v1/messages');
  expect(logger.info).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(95_000);
  terminal!({ outcome, ...(outcome === 'failure' ? { code: 'timeout', timeoutKind: 'stream_idle' } : {}), upstreamBodyBytes: 123 });
  terminal!({ outcome: 'success' });
  const calls = [...logger.info.mock.calls, ...logger.error.mock.calls, ...logger.warn.mock.calls];
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual(['HTTP access', expect.objectContaining({ status: 200, durationMs: 95000, durationKind: 'stream_terminal', outcome, upstreamBodyBytes: 123 })]);
  expect(response.status).toBe(200);
  if (outcome === 'failure') expect(logger.error).toHaveBeenCalledTimes(1);
});

it('allowlists terminal metadata and cannot leak injected fields', async () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = new Hono();
  app.use('*', accessLog(logger));
  app.get('/v1/messages', c => {
    getAccessLogTerminal(c)!({ outcome: 'failure', timeoutKind: 'CANARY', code: 'CANARY', body: 'CANARY', schema: 'CANARY', upstreamBodyBytes: 123, toolCount: 'CANARY', replayApplied: false });
    return c.json({ ok: false }, 500);
  });
  await app.request('/v1/messages');
  expect(logger.error).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith('HTTP access', expect.objectContaining({ upstreamBodyBytes: 123, replayApplied: false }));
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('CANARY');
});

for (const path of ['/v1/messages', '/v1/chat/completions', '/v1/responses']) {
  it.each([400, 404, 500])(`${path} uses HTTP severity for non-streaming failure %s in all logger modes`, async status => {
    for (const format of ['text', 'json', 'injected'] as const) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const injected = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const app = new Hono();
      app.use('*', accessLog(format === 'injected' ? injected : createLogger(), format === 'json' ? 'json' : 'text'));
      app.get(path, c => {
        getAccessLogTerminal(c)!({ outcome: 'failure', code: 'invalid_request' });
        return c.json({ error: 'safe' }, status as 400);
      });
      await app.request(path);
      const expected = format === 'injected' ? (status < 500 ? injected.warn : injected.error) : (status < 500 ? warn : error);
      const unexpected = format === 'injected' ? (status < 500 ? injected.error : injected.warn) : (status < 500 ? error : warn);
      expect(expected).toHaveBeenCalledTimes(1);
      expect(unexpected).not.toHaveBeenCalled();
      if (format === 'json') expect(JSON.parse(String(expected.mock.calls[0][0]))).toMatchObject({ level: status < 500 ? 'warn' : 'error', meta: { durationKind: 'response_ready', status, outcome: 'failure' } });
      warn.mockRestore(); error.mockRestore();
    }
  });
}

it.each([[32, '32ms'], [5333, '5.333s'], [95000, '1m35s']])('formats duration %s as %s and escalates stream failure despite HTTP 200', (durationMs, text) => {
  const sink = vi.spyOn(console, 'error').mockImplementation(() => {});
  createLogger().access!({ requestId: '12345678', method: 'POST', path: '/v1/messages', query: {}, status: 200, durationMs: durationMs as number, durationKind: 'stream_terminal', peerIp: 'unknown', outcome: 'failure', code: 'timeout', timeoutKind: 'stream_idle' });
  expect(sink).toHaveBeenCalledWith(expect.stringContaining(`200 ${text}`));
  expect(sink).toHaveBeenCalledWith(expect.stringContaining('outcome=failure code=timeout timeoutKind=stream_idle'));
});
