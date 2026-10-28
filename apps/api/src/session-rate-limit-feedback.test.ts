import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SessionChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { createMessagesRoute } from './routes/messages.js';
import { createOpenAiChatRoute } from './routes/openai-chat.js';
import { createOpenAiResponsesRoute } from './routes/openai-responses.js';
import { AccountPool } from './services/account-pool.js';
import { ModelRegistry } from './services/model-registry.js';
import { RequestLog } from './services/request-log.js';

const routes = [
  [createMessagesRoute, '/v1/messages', { model: 'sonnet', max_tokens: 16, messages: [{ role: 'user', content: 'synthetic' }] }],
  [createOpenAiChatRoute, '/v1/chat/completions', { model: 'sonnet', messages: [{ role: 'user', content: 'synthetic' }] }],
  [createOpenAiResponsesRoute, '/v1/responses', { model: 'sonnet', input: 'synthetic' }],
] as const;
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const quotaFailure = frame({ type: 'response.failed', response: { status: 'failed', error: {
  type: 'usage_limit_reached', message: 'QUOTA_MESSAGE_CANARY', resets_in_seconds: 300,
} } });

describe('Codex session quota failure feedback', () => {
  for (const [createRoute, path, body] of routes) {
    it.each([false, true])(`${path} returns a safe 429 before output (stream=%s) and cools the account`, async stream => {
      const { app, pool, fetch, release } = fixture(createRoute, quotaFailure);
      const response = await post(app, path, { ...body, stream });
      expect(response.status).toBe(429);
      expect(response.headers.get('content-type')).toContain('application/json');
      const json = await response.json();
      expect(json).toMatchObject({ error: { type: 'rate_limit_error', message: 'Upstream rate limit exceeded.' } });
      expect(JSON.stringify(json)).not.toMatch(/CANARY|resets_in_seconds/);
      expect(fetch).toHaveBeenCalledTimes(1);
      assertReleased(pool, release);
    });

    it(`${path} keeps an already started stream single-use and emits a safe rate-limit failure`, async () => {
      const prefix = frame({ type: 'response.created', response: { id: 'resp_synthetic', status: 'in_progress', output: [] } })
        + frame({ type: 'response.output_text.delta', delta: 'partial-output' });
      const { app, pool, fetch, release } = fixture(createRoute, prefix + quotaFailure);
      const response = await post(app, path, { ...body, stream: true });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const text = await response.text();
      expect(text).toContain('partial-output');
      expect(text).toContain('rate_limit_error');
      expect(text).toContain('Upstream rate limit exceeded.');
      expect(text).not.toMatch(/CANARY|resets_in_seconds|response.completed|message_stop|"finish_reason":"stop"/);
      expect(fetch).toHaveBeenCalledTimes(1);
      assertReleased(pool, release);
    });
  }
});

function fixture(createRoute: typeof createMessagesRoute | typeof createOpenAiChatRoute | typeof createOpenAiResponsesRoute, content: string) {
  const pool = new AccountPool();
  pool.add({ id: 'synthetic-session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'SYNTHETIC_TOKEN_CANARY' } });
  const modelRegistry = new ModelRegistry({ discoveredModels: [{ id: 'model' }] });
  modelRegistry.update('sonnet', { backendModel: 'model' });
  modelRegistry.replaceAccountModels({ accountId: 'synthetic-session', createdAt: pool.get('synthetic-session')!.createdAt }, [{ id: 'model' }]);
  const fetch = vi.fn(async () => new Response(content, { headers: { 'content-type': 'text/event-stream' } }));
  const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch });
  const app = new Hono();
  app.route('/', createRoute({ backend, accountPool: pool, modelRegistry, requestLog: new RequestLog(), backendProvider: 'session' }));
  return { app, pool, fetch, release: vi.spyOn(pool, 'release') };
}

function post(app: Hono, path: string, body: unknown) {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function assertReleased(pool: AccountPool, release: ReturnType<typeof vi.spyOn>) {
  expect(release).toHaveBeenCalledTimes(1);
  expect(pool.get('synthetic-session')).toMatchObject({ currentConcurrency: 0, status: 'cooldown', lastErrorCode: 'rate_limited' });
  expect(Date.parse(pool.get('synthetic-session')!.cooldownUntil!)).toBeGreaterThan(Date.now());
}
