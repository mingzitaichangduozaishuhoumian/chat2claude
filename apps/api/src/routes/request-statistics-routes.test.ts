import { describe, expect, it } from 'vitest';
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

    expect((await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(400);
    expect(state.snapshot().accounts[0]?.requestStats).toMatchObject({
      totalRequests: 1, successfulRequests: 0, failedRequests: 1, cancelledRequests: 0, inFlight: 0,
    });
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
