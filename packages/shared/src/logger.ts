export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type AccessLogFormat = 'text' | 'json';
const weights: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Only sanitized, allowlisted metadata belongs in an access entry. Never pass raw requests/errors. */
export interface HttpAccessLogEntry {
  requestId: string;
  method: string;
  path: string;
  query: Record<string, true>;
  status: number;
  durationMs: number;
  durationKind: 'response_ready';
  peerIp: string;
  model?: string;
  stream?: boolean;
  reason?: string;
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  /** Optional for compatibility with injected structured loggers. */
  access?(entry: HttpAccessLogEntry, format?: AccessLogFormat): void;
}

export function accessLogLevel(status: number): LogLevel {
  return status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
}

/** Fixed-width host-local time, independent of locale and UTC offset. */
export function formatLocalAccessTime(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const emit = (entryLevel: LogLevel, line: string) => {
    const sink = entryLevel === 'error' ? console.error : entryLevel === 'warn' ? console.warn : console.log;
    sink(line);
  };
  const write = (entryLevel: LogLevel, message: string, meta?: unknown) => {
    if (weights[entryLevel] < weights[level]) return;
    emit(entryLevel, JSON.stringify({ level: entryLevel, message, meta, time: new Date().toISOString() }));
  };
  return {
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
    access: (entry, format = 'text') => {
      const entryLevel = accessLogLevel(entry.status);
      if (weights[entryLevel] < weights[level]) return;
      if (format === 'json') return write(entryLevel, 'HTTP access', entry);
      const query = Object.keys(entry.query).sort().join('&');
      const fields = [
        formatLocalAccessTime(new Date()), entryLevel.toUpperCase().padEnd(5),
        entry.status, `${entry.durationMs}ms`, entry.peerIp, entry.method,
        `${entry.path}${query ? `?${query}` : ''}`,
        ...(entry.model ? [`model=${entry.model}`] : []),
        ...(entry.stream ? ['stream'] : []),
        ...(entry.reason ? [`reason=${entry.reason}`] : []),
        `req=${entry.requestId.slice(0, 8)}`,
      ];
      // Defense in depth against line/terminal injection; validation is owned by middleware.
      emit(entryLevel, fields.join(' ').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?'));
    },
  };
}
