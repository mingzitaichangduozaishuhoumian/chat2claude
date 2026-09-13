export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type AccessLogFormat = 'text' | 'detailed' | 'json';
const weights: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Only sanitized, allowlisted metadata belongs in an access entry. Never pass raw requests/errors. */
export interface HttpAccessLogEntry {
  requestId: string; method: string; path: string; query: Record<string, true>; status: number; durationMs: number;
  durationKind: 'response_ready' | 'stream_terminal' | 'stream_lifecycle';
  /** The log event phase; omitted entries remain compatible as response-ready. */
  phase?: 'request_started' | 'response_ready' | 'stream_terminal' | 'stream_lifecycle';
  lifecycle?: 'start' | 'active';
  outcome?: 'success' | 'failure' | 'cancelled'; code?: string; timeoutKind?: string; upstreamBodyBytes?: number;
  protocolStage?: string; protocolReason?: string;
  eventType?: string; responseStatus?: string; responseErrorCode?: string; incompleteReason?: string; failurePhase?: string; httpStatus?: number; exceptionFamily?: string;
  downstreamEventCount?: number; downstreamBodyBytes?: number;
  sourceMessageCount?: number; sourceContentBlockCount?: number; toolCount?: number; toolSchemaBytes?: number;
  upstreamInputItemCount?: number; replayItemCount?: number; replayApplied?: boolean;
  peerIp: string; model?: string; backendModel?: string; stream?: boolean; reason?: string;
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
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export function formatAccessDuration(ms: number): string {
  return `${(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000).toFixed(3)}s`;
}

/** Defense in depth before padding and emission; never allow terminal/bidi controls. */
function safeAccessText(value: string): string {
  return Array.from(value, char => {
    const code = char.codePointAt(0)!;
    return code <= 31 || (code >= 127 && code <= 159) || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ? '?' : char;
  }).join('');
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
      const phase = entry.phase ?? 'response_ready';
      const column = (value: string, width: number) => safeAccessText(value).slice(0, width).padEnd(width);
      const centerColumn = (value: string, width: number) => {
        const safe = safeAccessText(value).slice(0, width);
        const total = Math.max(0, width - safe.length);
        const left = total === 1 ? 1 : Math.floor(total / 2);
        return `${' '.repeat(left)}${safe}${' '.repeat(total - left)}`;
      };
      const pathCategory = entry.path.startsWith('/v1/') ? 'api' : entry.path.startsWith('/admin/') ? 'admin' : 'system';
      const hasModelMapping = Boolean(entry.model && entry.backendModel && entry.model !== entry.backendModel);
      const model = hasModelMapping ? `${entry.model}→${entry.backendModel}` : entry.model ?? entry.backendModel ?? pathCategory;
      const compactModel = hasModelMapping && model.length > 15 ? `${model.slice(0, 14)}…` : model;
      const prefix = `[${time}] [${column(entry.requestId, 8)}] [${entryLevel.toUpperCase().padEnd(5)}] [${centerColumn(compactModel, hasModelMapping ? 15 : 7)}]`;
      const target = `${entry.method} ${entry.path}${query ? `?${query}` : ''}`;
      const terminalStatus = entry.outcome === 'success' ? 'DONE' : entry.outcome === 'cancelled' ? 'CANCELLED' : entry.outcome === 'failure' ? 'FAILED' : 'UNKNOWN';
      const streamMetrics = `events=${entry.downstreamEventCount ?? 0} bytes=${entry.downstreamBodyBytes ?? 0}`;
      const fields = phase === 'request_started'
        ? [prefix, '<--', target]
        : phase === 'stream_terminal'
          ? [prefix, '-->', `STREAM ${terminalStatus} | total=${formatAccessDuration(entry.durationMs)} | ${streamMetrics}`]
          : phase === 'stream_lifecycle'
            ? entry.lifecycle === 'start'
              ? [prefix, '-->', `STREAM OPEN | ${entry.status} | ttfb=${formatAccessDuration(entry.durationMs)} | ${target}`]
              : [prefix, '-->', `STREAM ${(entry.lifecycle ?? 'active').toUpperCase()} | ${formatAccessDuration(entry.durationMs)} | ${streamMetrics}`]
            : [prefix, '-->', `${entry.status}${entry.stream ? ' STREAMING' : ''} | ${formatAccessDuration(entry.durationMs)} | ${target}`];
      if (format === 'detailed' && phase === 'response_ready') fields.push(
        ...(entry.stream ? ['stream'] : []), ...(entry.reason ? [`reason=${entry.reason}`] : []), ...(entry.outcome ? [`outcome=${entry.outcome}`] : []),
        ...(entry.code ? [`code=${entry.code}`] : []), ...(entry.timeoutKind ? [`timeoutKind=${entry.timeoutKind}`] : []),
        ...(['protocolStage', 'protocolReason', 'failurePhase', 'eventType', 'responseStatus', 'responseErrorCode', 'incompleteReason', 'httpStatus', 'exceptionFamily'] as const).flatMap(key => entry[key] === undefined ? [] : [`${key}=${entry[key]}`]),
        ...(entry.sourceMessageCount === undefined ? [] : [`messages=${entry.sourceMessageCount}`]),
        ...(entry.sourceContentBlockCount === undefined ? [] : [`content=${entry.sourceContentBlockCount}`]),
        ...(entry.toolCount === undefined ? [] : [`tools=${entry.toolCount}`]),
        ...(entry.toolSchemaBytes === undefined ? [] : [`schemaBytes=${entry.toolSchemaBytes}`]),
        ...(entry.upstreamInputItemCount === undefined ? [] : [`inputItems=${entry.upstreamInputItemCount}`]),
        ...(entry.replayItemCount === undefined ? [] : [`replayItems=${entry.replayItemCount}`]),
        ...(entry.replayApplied === undefined ? [] : [`replayApplied=${entry.replayApplied}`]),
        ...(entry.upstreamBodyBytes === undefined ? [] : [`upstreamBytes=${entry.upstreamBodyBytes}`]),
        ...(entry.downstreamEventCount === undefined ? [] : [`downstreamEvents=${entry.downstreamEventCount}`]),
        ...(entry.downstreamBodyBytes === undefined ? [] : [`downstreamBytes=${entry.downstreamBodyBytes}`]),
      );
      else if (phase === 'stream_terminal' && entry.outcome === 'failure') fields.push(...(entry.code ? [`| ${entry.code}`] : []),
        ...((format === 'detailed'
          ? ['protocolStage', 'protocolReason', 'failurePhase', 'eventType', 'responseStatus', 'responseErrorCode', 'incompleteReason', 'httpStatus', 'exceptionFamily', 'timeoutKind']
          : ['protocolReason', 'timeoutKind', 'incompleteReason']) as readonly (keyof HttpAccessLogEntry)[]).flatMap(key => entry[key] === undefined ? [] : [`${key}=${entry[key]}`]));
      emit(entryLevel, safeAccessText(fields.join(' ')));
    },
  };
}
