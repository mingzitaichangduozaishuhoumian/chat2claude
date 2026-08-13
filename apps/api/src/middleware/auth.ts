import type { MiddlewareHandler } from 'hono';
import type { RuntimeApiKeys } from '../services/runtime-api-keys.js';

export function apiKeyAuth(apiKeys: string[], runtimeApiKeys: RuntimeApiKeys): MiddlewareHandler {
  const envKeys = new Set(apiKeys);
  return async (c, next) => {
    const apiKey = c.req.header('x-api-key') ?? bearerToken(c.req.header('authorization'));
    if (envKeys.size === 0 && runtimeApiKeys.size === 0) {
      return c.json({ type: 'error', error: { type: 'authentication_error', message: 'API key required. Open http://localhost:3000/admin to initialize development access.' } }, 401);
    }
    if (!apiKey || (!envKeys.has(apiKey) && !runtimeApiKeys.has(apiKey))) {
      return c.json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid or missing API key' } }, 401);
    }
    return next();
  };
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}
