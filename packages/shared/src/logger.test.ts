import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, formatLocalAccessTime, type HttpAccessLogEntry } from './logger.js';

afterEach(() => vi.restoreAllMocks());
const entry: HttpAccessLogEntry = {
  requestId: 'ed73cd3b-0081-44af-aef4-83a14b30cde2', method: 'POST', path: '/v1/messages',
  query: { beta: true }, status: 200, durationMs: 29, durationKind: 'response_ready',
  peerIp: '127.0.0.1', model: 'opus', stream: true,
};

it('aligns text columns, outgoing query, and failure-only terminal', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 8, 13, 12, 21));
  try {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger();
    logger.access!({ ...entry, phase: 'request_started', model: undefined });
    logger.access!({ ...entry, durationMs: 4681 });
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[2026-09-08 13:12:21] [ed73cd3b] [INFO ] [—      ] <-- POST /v1/messages?beta',
      '[2026-09-08 13:12:21] [ed73cd3b] [INFO ] [opus   ] --> 200 | 4.681s | POST /v1/messages?beta',
    ]);
    for (const outcome of ['success', 'cancelled', 'failure'] as const) logger.access!({ ...entry, durationKind: 'stream_terminal', phase: 'stream_terminal', outcome, durationMs: 17598, code: 'invalid_response' });
    expect(log).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('[2026-09-08 13:12:21] [ed73cd3b] [ERROR] [opus   ] --> STREAM FAILED | 17.598s | invalid_response');
    logger.access!({ ...entry, model: 'long-model\n\x1b[31m', requestId: '1234567\nINJECT' });
    expect(log.mock.calls[2][0]).toContain('[1234567?] [INFO ] [long-mo]');
    expect(log.mock.calls[2][0]).not.toMatch(/[\r\n\x1b]/);
  } finally { vi.useRealTimers(); }
});

describe('dedicated access logger', () => {
  it.each([
    [new Date(2026, 0, 1, 0, 0, 0, 0), '2026-01-01 00:00:00'],
    [new Date(2026, 6, 1, 1, 2, 3, 4), '2026-07-01 01:02:03'],
    [new Date(2026, 11, 31, 23, 59, 59, 999), '2026-12-31 23:59:59'],
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
      expect(sink).toHaveBeenNthCalledWith(1, '[2026-09-03 17:37:48] [ed73cd3b] [INFO ] [opus   ] --> 200 | 0.029s | POST /v1/messages?beta');
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
      expect(warn.mock.calls[0][0]).toContain('--> 404 | 0.029s | POST /v1/messages?beta');
      expect(error.mock.calls[0][0]).toContain('--> 503 | 0.029s | POST /v1/messages?beta');
    } else {
      expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({ level: 'error', message: 'HTTP access', meta: { status: 503, requestId: entry.requestId } });
    }
  });

  it('omits empty optional fields and false stream, and adds safe reason', () => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createLogger().access!({ ...entry, status: 503, query: {}, model: undefined, stream: false, reason: 'account_busy_timeout' });
    expect(sink.mock.calls[0][0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[ed73cd3b\] \[ERROR\] \[—      \] --> 503 \| 0\.029s \| POST \/v1\/messages$/);
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
        '[2026-09-03 17:37:48] [ed73cd3b] [INFO ] [—      ] <-- POST /v1/messages?beta',
        '[2026-09-03 17:37:48] [ed73cd3b] [INFO ] [opus   ] --> 200 | 0.029s | POST /v1/messages?beta',
        '[2026-09-03 17:37:48] [ed73cd3b] [INFO ] [opus   ] --> STREAM SUCCESS | 0.029s stream downstreamEvents=2 downstreamBytes=10',
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
