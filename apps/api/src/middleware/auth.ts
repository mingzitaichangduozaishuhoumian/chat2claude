import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { RuntimeApiKeys } from '../services/runtime-api-keys.js';
import { isTrustedLocalHost, isTrustedLocalRequestHost, type LocalAdminSession } from '../services/local-admin-session.js';

declare module 'hono' {
  interface ContextVariableMap {
    /** Present only after successful API-key authentication. */
    reasoningReplayOwner: string | undefined;
    /** Present after admin middleware identifies the accepted credential family. */
    adminAuthKind: 'env_key' | 'runtime_key' | 'local_session' | undefined;
  }
}

const PUBLIC_ADMIN_API_PATHS = new Set(['/admin/api/setup/status', '/admin/api/auth/status']);
const BOOTSTRAP_ADMIN_API_PATTERNS = [
  /^\/admin\/api\/api-keys\/dev-enable$/,
  /^\/admin\/api\/auth\/chatgpt\/start$/,
  /^\/admin\/api\/auth\/chatgpt\/callback$/,
  /^\/admin\/api\/auth\/chatgpt\/complete$/,
  /^\/admin\/api\/auth\/chatgpt\/[^/]+$/,
  /^\/admin\/api\/auth\/chatgpt\/[^/]+\/cancel$/,
];

export function apiKeyAuth(apiKeys: string[], runtimeApiKeys: RuntimeApiKeys): MiddlewareHandler {
  const envKeys = new Set(apiKeys);
  return async (c, next) => {
    const apiKey = extractApiKey(c.req.header('x-api-key'), c.req.header('authorization'));
    if (envKeys.size === 0 && runtimeApiKeys.size === 0) {
      return c.json({ type: 'error', error: { type: 'authentication_error', message: 'API key required. Open /admin to initialize development access.' } }, 401);
    }
    const ownerId = ownerIdForApiKey(apiKey, envKeys, runtimeApiKeys);
    if (!ownerId) {
      return c.json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid or missing API key' } }, 401);
    }
    c.set('ownerId', ownerId);
    // Only authenticated middleware supplies this partition for both native and
    // implicit replay. Keep the existing ownerId contract for other consumers.
    const runtimeIdentity = runtimeApiKeys.identityForKey(apiKey!);
    c.set('reasoningReplayOwner', envKeys.has(apiKey!)
      ? `env:${createHash('sha256').update(apiKey!).digest('hex')}`
      : runtimeIdentity ? `runtime:${runtimeIdentity}` : undefined);
    return next();
  };
}

export function adminApiAuth(apiKeys: string[], runtimeApiKeys: RuntimeApiKeys, options: { allowAnonymousBootstrap: boolean; localAdminSession?: LocalAdminSession }): MiddlewareHandler {
  const envKeys = new Set(apiKeys);
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (PUBLIC_ADMIN_API_PATHS.has(path)) return next();

    const requestHost = c.req.header('host') ?? new URL(c.req.url).host;
    const hasAnyKey = envKeys.size > 0 || runtimeApiKeys.hasAny();
    if (!hasAnyKey && options.allowAnonymousBootstrap && isTrustedLocalRequestHost(requestHost, c.req.url) && isBootstrapAdminApiPath(path)) return next();

    const apiKey = extractApiKey(c.req.header('x-api-key'), c.req.header('authorization'));
    if (apiKey && runtimeApiKeys.has(apiKey)) {
      c.header('cache-control', 'no-store');
      return c.json({ type: 'error', error: { type: 'permission_error', message: 'Runtime API keys cannot access Admin API routes.' } }, 403);
    }
    if (apiKey && envKeys.has(apiKey)) {
      c.set('ownerId', ownerIdFromKey(apiKey));
      c.set('adminAuthKind', 'env_key');
      return next();
    }

    if (options.localAdminSession?.matches(c.req.header('cookie'), requestHost, c.req.url)) {
      if (isUnsafeMethod(c.req.method) && !hasSameOrigin(c.req.url, requestHost, c.req.header('origin'))) {
        return c.json({ type: 'error', error: { type: 'permission_error', message: 'Admin browser session mutations require a same-origin Origin header' } }, 403);
      }
      c.set('ownerId', 'local_admin_session');
      c.set('adminAuthKind', 'local_session');
      return next();
    }

    return c.json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid or missing admin API key' } }, 401);
  };
}

function ownerIdForApiKey(apiKey: string | undefined, envKeys: Set<string>, runtimeApiKeys: RuntimeApiKeys): string | undefined {
  if (!apiKey) return undefined;
  if (envKeys.has(apiKey) || runtimeApiKeys.has(apiKey)) return ownerIdFromKey(apiKey);
  return undefined;
}

export function ownerIdFromKey(apiKey: string): string {
  return `key_${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
}

function isBootstrapAdminApiPath(path: string): boolean {
  return BOOTSTRAP_ADMIN_API_PATTERNS.some((pattern) => pattern.test(path));
}

function isUnsafeMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function hasSameOrigin(requestUrl: string, requestHost: string | undefined, origin: string | undefined): boolean {
  if (!origin || !isTrustedLocalRequestHost(requestHost, requestUrl)) return false;
  try {
    const request = new URL(requestUrl);
    const originUrl = new URL(origin);
    return ['http:', 'https:'].includes(originUrl.protocol)
      && isTrustedLocalHost(originUrl.host)
      && originUrl.origin === request.origin;
  } catch {
    return false;
  }
}

function extractApiKey(xApiKey: string | undefined, authorization: string | undefined): string | undefined {
  return xApiKey ?? bearerToken(authorization);
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}
