import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, formatLocalAccessTime, type HttpAccessLogEntry } from './logger.js';

afterEach(() => vi.restoreAllMocks());
const entry: HttpAccessLogEntry = {
  requestId: 'ed73cd3b-0081-44af-aef4-83a14b30cde2', method: 'POST', path: '/v1/messages',
  query: { beta: true }, status: 200, durationMs: 29, durationKind: 'response_ready',
  peerIp: '127.0.0.1', model: 'opus', stream: true,
};

describe('dedicated access logger', () => {
  it.each([
    [new Date(2026, 0, 1, 0, 0, 0, 0), '00:00:00.000'],
    [new Date(2026, 6, 1, 1, 2, 3, 4), '01:02:03.004'],
    [new Date(2026, 11, 31, 23, 59, 59, 999), '23:59:59.999'],
  ] as const)('formats local date fields without locale conversion', (date, expected) => {
    expect(formatLocalAccessTime(date)).toBe(expected);
  });

  it('defaults to concise text but retains JSON for ordinary application logs', () => {
    vi.useFakeTimers();
    const localDate = new Date(2026, 8, 3, 17, 37, 48, 754);
    vi.setSystemTime(localDate);
    try {
      const sink = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const logger = createLogger();
      logger.access!(entry);
      expect(sink).toHaveBeenNthCalledWith(1, '[opus] 17:37:48.754 --> POST /v1/messages 200 29ms');
      logger.info('ordinary', { ok: true });
      expect(JSON.parse(sink.mock.calls[1][0])).toMatchObject({ level: 'info', message: 'ordinary', meta: { ok: true }, time: localDate.toISOString() });
      logger.access!(entry, 'json');
      expect(JSON.parse(sink.mock.calls[2][0]).time).toBe(localDate.toISOString());
    } finally { vi.useRealTimers(); }
  });

  it.each([['text'], ['json']] as const)('selects severity and applies LOG_LEVEL in %s format', (format) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = createLogger('warn');
    for (const status of [200, 302, 404, 503]) logger.access!({ ...entry, status }, format);
    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    if (format === 'text') {
      expect(warn.mock.calls[0][0]).toContain('--> POST /v1/messages 404');
      expect(error.mock.calls[0][0]).toContain('--> POST /v1/messages 503');
    } else {
      expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({ level: 'error', message: 'HTTP access', meta: { status: 503, requestId: entry.requestId } });
    }
  });

  it('omits empty optional fields and false stream, and adds safe reason', () => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createLogger().access!({ ...entry, status: 503, query: {}, model: undefined, stream: false, reason: 'account_busy_timeout' });
    expect(sink.mock.calls[0][0]).toMatch(/^\[\?\] \d{2}:\d{2}:\d{2}\.\d{3} --> POST \/v1\/messages 503 29ms$/);
    expect(sink.mock.calls[0][0]).not.toMatch(/stream|model=|durationKind|reason=/);
  });

  it('renders Copilot-style arrow phases and detailed stream summaries without request content', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 3, 17, 37, 48, 754));
    const sink = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const logger = createLogger();
      logger.access!({ ...entry, phase: 'request_started', model: undefined });
      logger.access!({ ...entry, phase: 'response_ready', model: 'opus' });
      logger.access!({ ...entry, phase: 'stream_terminal', outcome: 'success', downstreamEventCount: 2, downstreamBodyBytes: Buffer.byteLength('中文😀'), stream: true }, 'detailed');
      expect(sink.mock.calls.map(([line]) => line)).toEqual([
        '[?] 17:37:48.754 <-- POST /v1/messages?beta',
        '[opus] 17:37:48.754 --> POST /v1/messages 200 29ms',
        '[opus] 17:37:48.754 --> STREAM success 29ms stream downstreamEvents=2 downstreamBytes=10 req=ed73cd3b',
      ]);
    } finally { vi.useRealTimers(); }
  });

  it('renders every sanitized request metric in detailed output', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 3, 17, 37, 48, 754));
    const sink = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      createLogger().access!({
        ...entry, phase: 'response_ready', sourceMessageCount: 2, sourceContentBlockCount: 3,
        toolCount: 4, toolSchemaBytes: 5, upstreamInputItemCount: 6, replayItemCount: 7,
        replayApplied: true, upstreamBodyBytes: 8, downstreamEventCount: 9, downstreamBodyBytes: 10,
      } as HttpAccessLogEntry, 'detailed');
      expect(sink.mock.calls[0][0]).toContain('messages=2 content=3 tools=4 schemaBytes=5 inputItems=6 replayItems=7 replayApplied=true upstreamBytes=8 downstreamEvents=9 downstreamBytes=10');
    } finally { vi.useRealTimers(); }
  });
});
