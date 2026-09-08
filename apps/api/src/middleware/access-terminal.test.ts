import { afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { accessLog, getAccessLogTerminal } from './access-log.js';
import { createLogger } from '@chatgpt-to-claude/shared';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('emits response readiness before a later SSE terminal failure, once per phase', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout'] });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = new Hono();
  let terminal!: ReturnType<typeof getAccessLogTerminal>;
  app.use('*', accessLog(logger, 'detailed'));
  app.get('/v1/messages', c => { terminal = getAccessLogTerminal(c); return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }); });
  await app.request('/v1/messages');
  expect(logger.info).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(12);
  terminal!({ outcome: 'failure', code: 'timeout', upstreamBodyBytes: 12, body: 'CANARY' });
  terminal!({ outcome: 'success' });
  expect(logger.error).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith('HTTP access', expect.objectContaining({ phase: 'stream_terminal', outcome: 'failure', code: 'timeout', upstreamBodyBytes: 12 }));
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('CANARY');
});

it('keeps text success and cancellation terminal-silent but reports a safe failure', async () => {
  const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = new Hono();
  let terminal!: ReturnType<typeof getAccessLogTerminal>;
  app.use('*', accessLog(logger));
  app.get('/v1/messages', c => { terminal = getAccessLogTerminal(c); return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }); });
  await app.request('/v1/messages');
  terminal!({ outcome: 'success' });
  terminal!({ outcome: 'cancelled' });
  expect(logger.info).toHaveBeenCalledTimes(1);
  expect(logger.warn).not.toHaveBeenCalled();
  terminal!({ outcome: 'failure', code: 'timeout', message: 'CANARY' });
  expect(logger.error).toHaveBeenCalledTimes(0); // terminal ownership is idempotent
  const direct = (await import('@chatgpt-to-claude/shared')).createLogger();
  direct.access!({ requestId: '12345678', method: 'POST', path: '/v1/messages', query: {}, status: 200, durationMs: 32, durationKind: 'stream_terminal', phase: 'stream_terminal', peerIp: 'unknown', outcome: 'failure', code: 'timeout' });
  expect(sink).toHaveBeenCalledWith(expect.stringContaining('--> STREAM FAILED | 0.032s | timeout'));
});

it.each([
  ['/v1/messages', 400], ['/v1/messages', 404], ['/v1/messages', 500],
  ['/v1/chat/completions', 400], ['/v1/chat/completions', 404], ['/v1/chat/completions', 500],
  ['/v1/responses', 400], ['/v1/responses', 404], ['/v1/responses', 500],
] as const)('merges a non-stream terminal into one response-ready access record for %s (%i)', async (path, status) => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), access: vi.fn() };
  const app = new Hono();
  app.use('*', accessLog(logger, 'detailed'));
  app.get(path, c => {
    getAccessLogTerminal(c)!({ outcome: 'failure', code: 'internal_error', sourceMessageCount: 1 });
    return c.json({ error: 'safe' }, status);
  });

  expect((await app.request(path)).status).toBe(status);
  expect(logger.access.mock.calls.map(([entry]) => (entry as { phase: string }).phase)).toEqual(['request_started', 'response_ready']);
  expect(logger.access.mock.calls[1][0]).toMatchObject({ phase: 'response_ready', status, outcome: 'failure', code: 'internal_error', sourceMessageCount: 1 });
});

it.each(['success', 'failure', 'cancelled'] as const)('merges non-stream %s terminal state into response readiness', async outcome => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), access: vi.fn() };
  const app = new Hono();
  app.use('*', accessLog(logger, 'detailed'));
  app.get('/v1/messages', c => {
    getAccessLogTerminal(c)!({ outcome, ...(outcome === 'failure' ? { code: 'timeout' } : {}) });
    return c.json({ ok: true });
  });

  await app.request('/v1/messages');
  expect(logger.access.mock.calls.map(([entry]) => (entry as { phase: string }).phase)).toEqual(['request_started', 'response_ready']);
  expect(logger.access.mock.calls[1][0]).toMatchObject({ phase: 'response_ready', outcome });
});

it('records cancellation-first terminal ownership independently from duplicate terminal calls', async () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), access: vi.fn() };
  const app = new Hono();
  app.use('*', accessLog(logger, 'detailed'));
  app.get('/v1/messages', c => {
    const terminal = getAccessLogTerminal(c)!;
    terminal({ outcome: 'cancelled' });
    terminal({ outcome: 'failure', code: 'timeout' });
    return c.json({ ok: true });
  });

  await app.request('/v1/messages');
  expect(logger.access.mock.calls.map(([entry]) => (entry as { phase: string }).phase)).toEqual(['request_started', 'response_ready']);
  expect(logger.access.mock.calls[1][0]).toMatchObject({ outcome: 'cancelled' });
  expect(logger.access.mock.calls[1][0]).not.toHaveProperty('code');
});

it.each([
  ['/v1/messages', 400], ['/v1/messages', 404], ['/v1/messages', 500],
  ['/v1/chat/completions', 400], ['/v1/chat/completions', 404], ['/v1/chat/completions', 500],
  ['/v1/responses', 400], ['/v1/responses', 404], ['/v1/responses', 500],
] as const)('keeps one non-stream terminal outgoing log for %s (%i) in text, JSON, and injected modes', async (path, status) => {
  for (const mode of ['text', 'json', 'injected'] as const) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const injected = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logger = mode === 'injected' ? injected : createLogger();
    const app = new Hono();
    app.use('*', accessLog(logger, mode === 'json' ? 'json' : 'text'));
    app.get(path, c => {
      getAccessLogTerminal(c)!({ outcome: 'failure', code: 'internal_error' });
      return c.json({ error: 'safe' }, status);
    });

    expect((await app.request(path)).status).toBe(status);
    const expectedLevel = status >= 500 ? 'error' : 'warn';
    if (mode === 'injected') {
      expect(injected.warn.mock.calls.length + injected.error.mock.calls.length).toBe(1);
      expect(injected[expectedLevel]).toHaveBeenCalledWith('HTTP access', expect.objectContaining({ phase: 'response_ready', status, outcome: 'failure' }));
    } else {
      expect(warn.mock.calls.length + error.mock.calls.length).toBe(1);
      const line = (status >= 500 ? error : warn).mock.calls[0][0];
      if (mode === 'json') expect(JSON.parse(line)).toMatchObject({ level: expectedLevel, message: 'HTTP access', meta: { phase: 'response_ready', status, outcome: 'failure' } });
      else expect(line).toContain(`--> ${status} |`);
      expect(line).not.toContain('STREAM');
    }
    warn.mockRestore();
    error.mockRestore();
  }
});

it.each(['detailed', 'json'] as const)('allowlists protocol diagnostics at the access boundary in %s', async format => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const app = new Hono();
  app.use('*', accessLog(createLogger(), format));
  let terminal!: ReturnType<typeof getAccessLogTerminal>;
  app.get('/v1/messages', c => {
    terminal = getAccessLogTerminal(c);
    return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
  });
  await app.request('/v1/messages?beta=CANARY&token=CANARY');
  terminal!({ outcome: 'failure', code: 'invalid_response', protocolStage: 'sse_decode', protocolReason: 'malformed_sse_json', message: 'CANARY', detail: 'CANARY', param: 'CANARY', raw: 'CANARY', args: 'CANARY' });
  terminal!({ outcome: 'failure', protocolReason: 'CANARY' });
  expect(error).toHaveBeenCalledTimes(1);
  const line = String(error.mock.calls[0][0]);
  if (format === 'json') expect(JSON.parse(line).meta).toMatchObject({ protocolStage: 'sse_decode', protocolReason: 'malformed_sse_json' });
  else expect(line).toContain('protocolStage=sse_decode protocolReason=malformed_sse_json');
  expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain('CANARY');
});

it('swallows an access sink failure without changing the response', async () => {
  const app = new Hono();
  app.use('*', accessLog({ debug: vi.fn(), info: vi.fn(() => { throw new Error('CANARY'); }), warn: vi.fn(), error: vi.fn() }));
  app.get('/v1/messages', c => c.json({ ok: true }));
  expect((await app.request('/v1/messages')).status).toBe(200);
});
