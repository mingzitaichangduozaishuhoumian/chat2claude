export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type AccessLogFormat = 'text' | 'detailed' | 'json';
const weights: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Only sanitized, allowlisted metadata belongs in an access entry. Never pass raw requests/errors. */
export interface HttpAccessLogEntry {
  requestId: string; method: string; path: string; query: Record<string, true>; status: number; durationMs: number;
  durationKind: 'response_ready' | 'stream_terminal';
  /** The log event phase; omitted entries remain compatible as response-ready. */
  phase?: 'request_started' | 'response_ready' | 'stream_terminal';
  outcome?: 'success' | 'failure' | 'cancelled'; code?: string; timeoutKind?: string; upstreamBodyBytes?: number;
  downstreamEventCount?: number; downstreamBodyBytes?: number;
  sourceMessageCount?: number; sourceContentBlockCount?: number; toolCount?: number; toolSchemaBytes?: number;
  upstreamInputItemCount?: number; replayItemCount?: number; replayApplied?: boolean;
  peerIp: string; model?: string; stream?: boolean; reason?: string;
}

export interface Logger {
  debug(message: string, meta?: unknown): void; info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void; error(message: string, meta?: unknown): void;
  /** Optional for compatibility with injected structured loggers. */
  access?(entry: HttpAccessLogEntry, format?: AccessLogFormat): void;
}

export function accessLogLevel(status: number, outcome?: HttpAccessLogEntry['outcome'], durationKind?: HttpAccessLogEntry['durationKind']): LogLevel {
  if (durationKind === 'stream_terminal' && status === 200 && outcome === 'failure') return 'error';
  if (outcome === 'cancelled') return 'warn';
  return status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
}

/** Fixed-width host-local time, independent of locale and UTC offset. */
export function formatLocalAccessTime(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
export function formatAccessDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(3))}s`;
  return `${Math.floor(ms / 60_000)}m${Number(((ms % 60_000) / 1000).toFixed(3))}s`;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const emit = (entryLevel: LogLevel, line: string) => { const sink = entryLevel === 'error' ? console.error : entryLevel === 'warn' ? console.warn : console.log; sink(line); };
  const write = (entryLevel: LogLevel, message: string, meta?: unknown) => { if (weights[entryLevel] >= weights[level]) emit(entryLevel, JSON.stringify({ level: entryLevel, message, meta, time: new Date().toISOString() })); };
  return {
    debug: (m, meta) => write('debug', m, meta), info: (m, meta) => write('info', m, meta), warn: (m, meta) => write('warn', m, meta), error: (m, meta) => write('error', m, meta),
    access: (entry, format = 'text') => {
      const entryLevel = accessLogLevel(entry.status, entry.outcome, entry.durationKind);
      if (weights[entryLevel] < weights[level]) return;
      if (format === 'json') return write(entryLevel, 'HTTP access', entry);
      const query = Object.keys(entry.query).sort().join('&');
      const time = formatLocalAccessTime(new Date());
      const model = entry.model ?? '?';
      const phase = entry.phase ?? 'response_ready';
      const fields = phase === 'request_started'
        ? [`[${model}]`, time, '<--', entry.method, `${entry.path}${query ? `?${query}` : ''}`]
        : phase === 'stream_terminal'
          ? [`[${model}]`, time, '-->', 'STREAM', entry.outcome ?? 'unknown', formatAccessDuration(entry.durationMs)]
          : [`[${model}]`, time, '-->', entry.method, entry.path, entry.status, formatAccessDuration(entry.durationMs)];
      if (format === 'detailed' && phase !== 'request_started') fields.push(
        ...(entry.stream ? ['stream'] : []), ...(entry.reason ? [`reason=${entry.reason}`] : []), ...(entry.outcome && phase !== 'stream_terminal' ? [`outcome=${entry.outcome}`] : []),
        ...(entry.code ? [`code=${entry.code}`] : []), ...(entry.timeoutKind ? [`timeoutKind=${entry.timeoutKind}`] : []),
        ...(entry.sourceMessageCount === undefined ? [] : [`messages=${entry.sourceMessageCount}`]),
        ...(entry.sourceContentBlockCount === undefined ? [] : [`content=${entry.sourceContentBlockCount}`]),
        ...(entry.toolCount === undefined ? [] : [`tools=${entry.toolCount}`]),
        ...(entry.toolSchemaBytes === undefined ? [] : [`schemaBytes=${entry.toolSchemaBytes}`]),
        ...(entry.upstreamInputItemCount === undefined ? [] : [`inputItems=${entry.upstreamInputItemCount}`]),
        ...(entry.replayItemCount === undefined ? [] : [`replayItems=${entry.replayItemCount}`]),
        ...(entry.replayApplied === undefined ? [] : [`replayApplied=${entry.replayApplied}`]),
        ...(entry.upstreamBodyBytes === undefined ? [] : [`upstreamBytes=${entry.upstreamBodyBytes}`]),
        ...(entry.downstreamEventCount === undefined ? [] : [`downstreamEvents=${entry.downstreamEventCount}`]),
        ...(entry.downstreamBodyBytes === undefined ? [] : [`downstreamBytes=${entry.downstreamBodyBytes}`]), `req=${entry.requestId.slice(0, 8)}`,
      );
      else if (phase === 'stream_terminal' && entry.outcome === 'failure') fields.push(...(entry.code ? [`code=${entry.code}`] : []), ...(entry.timeoutKind ? [`timeoutKind=${entry.timeoutKind}`] : []));
      // Defense in depth against line/terminal injection; validation is owned by middleware.
      const line = Array.from(fields.join(' '), char => { const code = char.codePointAt(0)!; return code <= 31 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? '?' : char; }).join('');
      emit(entryLevel, line);
    },
  };
}
