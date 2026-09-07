import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { accessLog } from '../middleware/access-log.js';
import { SessionChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import type { ChatGptBackendClient, ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptDiscoveredModel } from '@chatgpt-to-claude/chatgpt-backend';
import { createMessagesRoute } from './messages.js';
import { createOpenAiChatRoute } from './openai-chat.js';
import { createOpenAiResponsesRoute } from './openai-responses.js';
import { AccountPool } from '../services/account-pool.js';
import { AdminOperationalState } from '../services/admin-operational-state.js';
import { ModelRegistry } from '../services/model-registry.js';
import { RequestLog } from '../services/request-log.js';

const models: ChatGptDiscoveredModel[] = [{ id: 'model-1' }];

describe('request-statistics protocol attribution', () => {
  it.each([
    ['Claude Messages', createMessagesRoute, '/v1/messages', { model: 'sonnet', max_tokens: 16, messages: [{ role: 'user', content: 'secret prompt' }] }],
    ['OpenAI Chat Completions', createOpenAiChatRoute, '/v1/chat/completions', { model: 'sonnet', messages: [{ role: 'user', content: 'secret prompt' }] }],
    ['OpenAI Responses', createOpenAiResponsesRoute, '/v1/responses', { model: 'sonnet', input: 'secret prompt' }],
  ] as const)('attributes a non-streaming success for %s', async (_protocol, createRoute, path, body) => {
    const state = new AdminOperationalState({ path: 'unused.json', debounceMs: 60_000 });
    const app = createRoute({ backend: new UsageBackend(), requestLog: new RequestLog(), modelRegistry: registry(), accountPool: new AccountPool(), operationalState: state });

    expect((await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(200);
    expect(state.snapshot().accounts[0]?.requestStats).toMatchObject({
      totalRequests: 1, successfulRequests: 1, failedRequests: 0, cancelledRequests: 0, inputTokens: 7, outputTokens: 4, inFlight: 0,
    });
    expect(JSON.stringify(state.snapshot())).not.toContain('secret prompt');
  });

  it.each([
    ['Claude Messages', createMessagesRoute, '/v1/messages', { model: 'sonnet', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }],
    ['OpenAI Chat Completions', createOpenAiChatRoute, '/v1/chat/completions', { model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] }],
    ['OpenAI Responses', createOpenAiResponsesRoute, '/v1/responses', { model: 'sonnet', input: 'hello' }],
  ] as const)('attributes a non-streaming failure for %s', async (_protocol, createRoute, path, body) => {
    const state = new AdminOperationalState({ path: 'unused.json', debounceMs: 60_000 });
    const app = createRoute({ backend: new FailingBackend(), requestLog: new RequestLog(), modelRegistry: registry(), accountPool: new AccountPool(), operationalState: state });

    const response = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('backend failed');
    expect(state.snapshot().accounts[0]?.requestStats).toMatchObject({
      totalRequests: 1, successfulRequests: 0, failedRequests: 1, cancelledRequests: 0, inFlight: 0,
    });
  });

  it.each([
    [createMessagesRoute, '/v1/messages', { model: 'sonnet', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }],
    [createOpenAiChatRoute, '/v1/chat/completions', { model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] }],
    [createOpenAiResponsesRoute, '/v1/responses', { model: 'sonnet', input: 'hello' }],
  ] as const)('safely maps session SSE failures and releases accounts (case %#)', async (createRoute, path, body) => {
    for (const stream of [false, true]) for (const partial of [false, true]) {
      const state = new AdminOperationalState({ path: 'unused.json', debounceMs: 60_000 });
      const pool = new AccountPool();
      pool.add({ id: 'session-canary', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'token' } });
      const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000,
        fetch: async () => new Response((partial ? 'data: {"delta":"safe partial"}\n\n' : '')
          + 'data: {"type":"response.error","message":{"content":"SSE_SECRET_CANARY"},"detail":"SSE_SECRET_CANARY"}\n\n'
          + 'data: {"type":"response.completed"}\n\n'),
      });
      const modelRegistry = registry();
      modelRegistry.replaceAccountModels({ accountId: 'session-canary', createdAt: pool.get('session-canary')!.createdAt }, models);
      const app = createRoute({ backend, requestLog: new RequestLog(), modelRegistry, accountPool: pool, operationalState: state, backendProvider: 'session' });
      const response = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, stream }) });
      const text = await response.text();
      expect(response.status).toBe(stream ? 200 : 502);
      expect(text).toContain('Upstream request failed.');
      expect(text).not.toMatch(/SSE_SECRET_CANARY|response\.completed|message_stop|"finish_reason":"stop"/);
      expect(state.snapshot().accounts[0]?.requestStats).toMatchObject({ totalRequests: 1, successfulRequests: 0, failedRequests: 1, cancelledRequests: 0, inFlight: 0 });
      expect(pool.get('session-canary')).toMatchObject({ currentConcurrency: 0, status: 'available', cooldownUntil: null, lastErrorCode: 'upstream_error' });
      expect(JSON.stringify(state.snapshot()) + JSON.stringify(pool.get('session-canary'))).not.toContain('SSE_SECRET_CANARY');
    }
  });

  it.each([
    [createMessagesRoute, '/v1/messages', { model: 'sonnet', max_tokens: 16, messages: [{ role: 'user', content: 'USER_CANARY' }] }],
    [createOpenAiChatRoute, '/v1/chat/completions', { model: 'sonnet', messages: [{ role: 'user', content: 'USER_CANARY' }] }],
    [createOpenAiResponsesRoute, '/v1/responses', { model: 'sonnet', input: 'USER_CANARY' }],
  ] as const)('logs exactly one safe non-streaming cancellation for %s', async (createRoute, path, body) => {
    for (const aborted of [true, false]) {
      const state = new AdminOperationalState({ path: 'unused.json', debounceMs: 60_000 });
      const pool = new AccountPool();
      const release = vi.spyOn(pool, 'release');
      const controller = new AbortController();
      const backend = new UsageBackend();
      vi.spyOn(backend, 'complete').mockImplementation(async () => {
        if (aborted) controller.abort();
        throw new DOMException('PROVIDER_TOKEN_COOKIE_CANARY', 'AbortError');
      });
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), access: vi.fn() };
      const app = new Hono();
      app.use('*', accessLog(logger));
      app.route('/', createRoute({ backend, requestLog: new RequestLog(), modelRegistry: registry(), accountPool: pool, operationalState: state, logger }));
      const response = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      expect(response.status).toBe(aborted ? 499 : 500);
      expect(logger.access).toHaveBeenCalledWith(expect.objectContaining({ status: aborted ? 499 : 500 }), 'text');
      expect(await response.text()).not.toContain('CANARY');
      expect(state.snapshot().accounts[0]?.requestStats).toMatchObject({ totalRequests: 1, successfulRequests: 0, failedRequests: aborted ? 0 : 1, cancelledRequests: aborted ? 1 : 0, inFlight: 0 });
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String), incarnation: expect.any(Number) }), undefined);
      const lease = release.mock.calls[0][0];
      expect(pool.get(typeof lease === 'string' ? lease : lease.id)).toMatchObject({ currentConcurrency: 0, status: 'available', cooldownUntil: null });
      expect(logger.info.mock.calls.length + logger.error.mock.calls.length).toBe(0);
      expect(logger.access).toHaveBeenCalledTimes(1);
      expect(logger.access).toHaveBeenCalledWith(expect.objectContaining({ path, outcome: aborted ? 'cancelled' : 'failure' }), 'text');
      expect(JSON.stringify([logger.access.mock.calls, logger.info.mock.calls, logger.error.mock.calls, state.snapshot()])).not.toContain('CANARY');
    }
  });

  it('does not create statistics for a pre-acquisition validation failure', async () => {
    const state = new AdminOperationalState({ path: 'unused.json', debounceMs: 60_000 });
    const app = createOpenAiChatRoute({ backend: new UsageBackend(), requestLog: new RequestLog(), modelRegistry: registry(), accountPool: new AccountPool(), operationalState: state });

    expect((await app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', messages: 'invalid' }) })).status).toBe(400);
    expect(state.snapshot().accounts).toEqual([]);
  });
});

function registry(): ModelRegistry {
  const result = new ModelRegistry({ discoveredModels: models });
  result.update('sonnet', { backendModel: 'model-1' });
  return result;
}

class FailingBackend implements ChatGptBackendClient {
  async listModels(): Promise<ChatGptDiscoveredModel[]> { return models; }
  async healthCheck() { return { ok: true }; }
  async complete(): Promise<ChatGptCompletionResponse> { throw new Error('backend failed'); }
  async *stream() { yield { type: 'done' as const }; }
}

class UsageBackend implements ChatGptBackendClient {
  async listModels(): Promise<ChatGptDiscoveredModel[]> { return models; }
  async healthCheck() { return { ok: true }; }
  async complete(_request: ChatGptCompletionRequest): Promise<ChatGptCompletionResponse> {
    return { text: 'ok', finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 4, raw: { prompt: 'must-not-persist' } } };
  }
  async *stream() { yield { type: 'done' as const }; }
}
