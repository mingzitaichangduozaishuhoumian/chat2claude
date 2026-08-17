import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { RuntimeApiKeys } from '../services/runtime-api-keys.js';

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
    return next();
  };
}

export function adminApiAuth(apiKeys: string[], runtimeApiKeys: RuntimeApiKeys): MiddlewareHandler {
  const envKeys = new Set(apiKeys);
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (PUBLIC_ADMIN_API_PATHS.has(path)) return next();

    const hasAnyKey = envKeys.size > 0 || runtimeApiKeys.hasAny();
    if (!hasAnyKey && isBootstrapAdminApiPath(path)) return next();

    const apiKey = extractApiKey(c.req.header('x-api-key'), c.req.header('authorization'));
    const ownerId = ownerIdForApiKey(apiKey, envKeys, runtimeApiKeys);
    if (!ownerId) {
      return c.json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid or missing admin API key' } }, 401);
    }
    c.set('ownerId', ownerId);
    return next();
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

function extractApiKey(xApiKey: string | undefined, authorization: string | undefined): string | undefined {
  return xApiKey ?? bearerToken(authorization);
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}
