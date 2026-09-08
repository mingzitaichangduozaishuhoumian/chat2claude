import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { isIP } from 'node:net';
import { accessLogLevel, type AccessLogFormat, type HttpAccessLogEntry, type Logger } from '@chatgpt-to-claude/shared';
import { sanitizeBackendDiagnostic } from '@chatgpt-to-claude/chatgpt-backend';
import { sanitizeRequestMetrics } from '../routes/stream-lifecycle.js';
import { ACCOUNT_UNAVAILABLE_REASONS, type AccountUnavailableReason } from '../services/account-pool.js';

const ACCESS_LOG_METADATA = 'accessLogMetadata';
const PUBLIC_QUERY_PARAMETERS = new Set(['beta']);
const INVALID_MODEL_ID = '<invalid-model-id>';
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

export interface AccessLogMetadata { model?: string; stream?: boolean; reason?: AccountUnavailableReason; }
export interface HttpAccessLog extends HttpAccessLogEntry { reason?: AccountUnavailableReason; }
export type AccessLogTerminal = (fields: Record<string, unknown>) => void;

/** Request-scoped internal callback; never sourced from headers or JSON. */
export function getAccessLogTerminal(c: Context): AccessLogTerminal | undefined { return c.get('accessLogTerminal') as AccessLogTerminal | undefined; }

/** Logs request start and response readiness without consuming or cloning an SSE body. */
export function accessLog(logger: Logger, format: AccessLogFormat = 'text'): MiddlewareHandler {
  return async (c, next) => {
    const requestId = randomUUID();
    c.set('accessLogRequestId', requestId);
    const startedAt = performance.now();
    const url = new URL(c.req.url);
    const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'].includes(c.req.method) ? c.req.method : 'OTHER';
    const base = () => ({ requestId, method, path: normalizeAccessPath(url.pathname), query: summarizeQuery(url.searchParams), status: c.res.status, durationMs: Math.max(0, Math.round(performance.now() - startedAt)), peerIp: peerIp(c) });
    let ready = false;
    let responseEmitted = false;
    let terminalEmitted = false;
    let terminal: Record<string, unknown> | undefined;
    const emit = (entry: HttpAccessLog) => {
      // Legacy injected structured loggers cannot render arrow phases. Preserve their
      // terminal-only stream contract while the application logger emits both arrows.
      if (!logger.access && entry.phase === 'request_started') return;
      try {
        if (logger.access) logger.access(entry, format);
        else logger[accessLogLevel(entry.status, entry.outcome, entry.durationKind)]('HTTP access', entry);
      } catch { /* Logging is observational and cannot change request teardown. */ }
    };
    const metadata = () => {
      const value = c.get(ACCESS_LOG_METADATA) as AccessLogMetadata | undefined;
      return {
        ...(value?.model === undefined ? {} : { model: safeModelId(value.model) }),
        ...(value?.stream === undefined ? {} : { stream: value.stream }),
        ...(value?.reason && ACCOUNT_UNAVAILABLE_REASONS.includes(value.reason) ? { reason: value.reason } : {}),
      };
    };
    // Response behavior, rather than request intent, determines whether a terminal
    // needs its own STREAM event. A rejected stream request may return JSON.
    const isStreaming = () => c.res.headers.get('content-type')?.includes('text/event-stream') ?? false;
    const emitResponseReady = () => {
      if (!ready || responseEmitted) return;
      responseEmitted = true;
      if (!logger.access && isStreaming()) return;
      // A non-stream route finalizes before its response is ready: retain its safe
      // terminal state on this sole response-ready record rather than logging STREAM.
      const fields = !isStreaming() && terminal ? sanitizeAccessTerminal(terminal) : {};
      emit({ ...base(), ...metadata(), ...fields, durationKind: 'response_ready', phase: 'response_ready' });
    };
    const emitTerminal = () => {
      if (!ready || !terminal || terminalEmitted || !isStreaming()) return;
      terminalEmitted = true;
      const fields = sanitizeAccessTerminal(terminal);
      // Text deliberately stays concise: successes/cancellations already have their ready line.
      if (format === 'text' && fields.outcome !== 'failure' && logger.access) return;
      emit({ ...base(), ...metadata(), ...fields, durationKind: 'stream_terminal', phase: 'stream_terminal' });
    };
    c.set('accessLogTerminal', (fields: Record<string, unknown>) => { terminal ??= fields; emitTerminal(); });
    emit({ ...base(), durationKind: 'response_ready', phase: 'request_started' });
    try { await next(); }
    finally { ready = true; emitResponseReady(); emitTerminal(); }
  };
}

function sanitizeAccessTerminal(value: Record<string, unknown>) {
  const outcome: HttpAccessLogEntry['outcome'] = value.outcome === 'success' || value.outcome === 'failure' || value.outcome === 'cancelled' ? value.outcome : undefined;
  const codes = ['unauthorized', 'rate_limited', 'network_error', 'timeout', 'upstream_error', 'invalid_response', 'invalid_request', 'internal_error'];
  const families = ['ChatGptBackendError', 'ClaudeApiError', 'SyntaxError', 'TypeError', 'Error', 'unknown'];
  return {
    ...sanitizeRequestMetrics(value), ...sanitizeBackendDiagnostic(value),
    ...(outcome ? { outcome } : {}),
    ...(typeof value.code === 'string' && codes.includes(value.code) ? { code: value.code } : {}),
    ...(typeof value.exceptionFamily === 'string' && families.includes(value.exceptionFamily) ? { exceptionFamily: value.exceptionFamily } : {}),
  };
}

/** Server-generated only; never use a client request-ID header in diagnostics. */
export function getAccessLogRequestId(c: Context): string | undefined {
  const value: unknown = c.get('accessLogRequestId');
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : undefined;
}

/** Attach only protocol fields which have passed the route's request validation. */
export function setAccessLogMetadata(c: Context, metadata: AccessLogMetadata): void { c.set(ACCESS_LOG_METADATA, { ...c.get(ACCESS_LOG_METADATA), ...metadata }); }

export function normalizeAccessPath(pathname: string): string {
  if (pathname === '/v1/models' || pathname === '/v1/messages' || pathname === '/v1/messages/count_tokens' || pathname === '/v1/chat/completions' || pathname === '/v1/responses') return pathname;
  if (pathname.startsWith('/v1/')) return '/v1/:unknown';
  if (pathname === '/admin/api/setup/status' || pathname === '/admin/api/auth/status' || pathname === '/admin/api/api-keys/dev-enable' || pathname === '/admin/api/auth/chatgpt/start' || pathname === '/admin/api/auth/chatgpt/callback' || pathname === '/admin/api/auth/chatgpt/complete' || pathname === '/admin/api/quotas' || pathname === '/admin/api/quotas/refresh' || pathname === '/admin/api/accounts' || pathname === '/admin/api/api-keys' || pathname === '/admin/api/models' || pathname === '/admin/api/models/reset' || pathname === '/admin/api/models/refresh') return pathname;
  if (/^\/admin\/api\/auth\/chatgpt\/[^/]+$/.test(pathname)) return '/admin/api/auth/chatgpt/:flowId';
  if (/^\/admin\/api\/auth\/chatgpt\/[^/]+\/cancel$/.test(pathname)) return '/admin/api/auth/chatgpt/:flowId/cancel';
  if (/^\/admin\/api\/quotas\/[^/]+\/refresh$/.test(pathname)) return '/admin/api/quotas/:accountId/refresh';
  if (/^\/admin\/api\/quotas\/[^/]+\/active-reset$/.test(pathname)) return '/admin/api/quotas/:accountId/active-reset';
  if (/^\/admin\/api\/accounts\/[^/]+$/.test(pathname)) return '/admin/api/accounts/:accountId';
  if (/^\/admin\/api\/accounts\/[^/]+\/health-check$/.test(pathname)) return '/admin/api/accounts/:accountId/health-check';
  if (/^\/admin\/api\/api-keys\/[^/]+$/.test(pathname)) return '/admin/api/api-keys/:keyId';
  if (/^\/admin\/api\/models\/[^/]+$/.test(pathname)) return '/admin/api/models/:modelId';
  if (pathname.startsWith('/admin/api/')) return '/admin/api/:unknown';
  return ':unknown';
}
export function summarizeQuery(searchParams: URLSearchParams): Record<string, true> { const summary: Record<string, true> = {}; for (const name of searchParams.keys()) summary[PUBLIC_QUERY_PARAMETERS.has(name) ? name : 'other'] = true; return summary; }
function safeModelId(model: string): string { return MODEL_ID_PATTERN.test(model) ? model : INVALID_MODEL_ID; }
function peerIp(c: Context): string { const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: unknown } } } | undefined)?.incoming; const address = incoming?.socket?.remoteAddress; return typeof address === 'string' && isIP(address) ? address : 'unknown'; }
