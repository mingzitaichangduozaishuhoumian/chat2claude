import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { isIP } from 'node:net';
import { accessLogLevel, type AccessLogFormat, type HttpAccessLogEntry, type Logger } from '@chatgpt-to-claude/shared';
import { ACCOUNT_UNAVAILABLE_REASONS, type AccountUnavailableReason } from '../services/account-pool.js';

const ACCESS_LOG_METADATA = 'accessLogMetadata';
const PUBLIC_QUERY_PARAMETERS = new Set(['beta']);
const INVALID_MODEL_ID = '<invalid-model-id>';
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

export interface AccessLogMetadata {
  model?: string;
  stream?: boolean;
  reason?: AccountUnavailableReason;
}

export interface HttpAccessLog extends HttpAccessLogEntry {
  reason?: AccountUnavailableReason;
}

/**
 * Records request completion without observing request or response bodies.
 * For streaming responses, duration measures when the response is ready, not
 * when its body finishes sending.
 */
export function accessLog(logger: Logger, format: AccessLogFormat = 'text'): MiddlewareHandler {
  return async (c, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const url = new URL(c.req.url);

    try {
      await next();
    } finally {
      const metadata = c.get(ACCESS_LOG_METADATA) as AccessLogMetadata | undefined;
      const entry: HttpAccessLog = {
        requestId,
        method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'].includes(c.req.method) ? c.req.method : 'OTHER',
        path: normalizeAccessPath(url.pathname),
        query: summarizeQuery(url.searchParams),
        status: c.res.status,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        durationKind: 'response_ready',
        peerIp: peerIp(c),
        ...(metadata?.model === undefined ? {} : { model: safeModelId(metadata.model) }),
        ...(metadata?.stream === undefined ? {} : { stream: metadata.stream }),
        ...(metadata?.reason && ACCOUNT_UNAVAILABLE_REASONS.includes(metadata.reason) ? { reason: metadata.reason } : {}),
      };
      if (logger.access) logger.access(entry, format);
      else logger[accessLogLevel(entry.status)]('HTTP access', entry);
    }
  };
}

/** Attach only protocol fields which have passed the route's request validation. */
export function setAccessLogMetadata(c: Context, metadata: AccessLogMetadata): void {
  c.set(ACCESS_LOG_METADATA, { ...c.get(ACCESS_LOG_METADATA), ...metadata });
}

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

export function summarizeQuery(searchParams: URLSearchParams): Record<string, true> {
  const summary: Record<string, true> = {};
  for (const name of searchParams.keys()) summary[PUBLIC_QUERY_PARAMETERS.has(name) ? name : 'other'] = true;
  return summary;
}

function safeModelId(model: string): string {
  return MODEL_ID_PATTERN.test(model) ? model : INVALID_MODEL_ID;
}

function peerIp(c: Context): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: unknown } } } | undefined)?.incoming;
  const address = incoming?.socket?.remoteAddress;
  return typeof address === 'string' && isIP(address) ? address : 'unknown';
}
