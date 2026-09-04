import { describe, expect, it } from 'vitest';
import type { ChatGptBackendClient, ChatGptBackendRequestContext, ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptDiscoveredModel } from '@chatgpt-to-claude/chatgpt-backend';
import { AccountPool } from './services/account-pool.js';
import { ModelRegistry } from './services/model-registry.js';
import { RequestLog } from './services/request-log.js';
import { createMessagesRoute } from './routes/messages.js';

function model(id: string, effort: string): ChatGptDiscoveredModel {
  return {
    id,
    controls: {
      reasoning: { metadataKnown: true, supported: [{ effort }], defaultEffort: effort },
      serviceTier: { metadataKnown: true, supported: [], fastMode: false },
    },
  };
}

function registry(): ModelRegistry {
  return new ModelRegistry({
    defaults: {
      aliases: [{
        id: 'sonnet', type: 'model', display_name: 'Sonnet', backendModel: 'model-a', enabled: true,
        capabilities: {}, defaults: { reasoning_effort: 'none', speed: 'auto' },
      }],
    },
  });
}

class RoutingBackend implements ChatGptBackendClient {
  readonly completions: Array<{ accountId: string | undefined; model: string; reasoningEffort: string | undefined; serviceTier: string | undefined }> = [];
  listModelsCalls = 0;

  async listModels(): Promise<ChatGptDiscoveredModel[]> {
    this.listModelsCalls += 1;
    throw new Error('request routing must not perform discovery');
  }

  async complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse> {
    this.completions.push({ accountId: context?.account?.id, model: request.model, reasoningEffort: request.reasoningEffort, serviceTier: request.serviceTier });
    return { text: 'ok', finishReason: 'stop' };
  }

  async *stream(): AsyncIterable<never> { return; }
}

describe('heterogeneous account model routing', () => {
  it('never routes a model or requested control through an ineligible account', async () => {
    const accountPool = new AccountPool({ seedMockAccount: false });
    const accountA = accountPool.add({ id: 'account-a', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'token-a' }, maxConcurrency: 2 });
    const accountB = accountPool.add({ id: 'account-b', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'token-b' }, maxConcurrency: 2 });
    const models = registry();
    models.replaceAccountModels({ accountId: accountA.id, createdAt: accountA.createdAt }, [model('model-a', 'high')]);
    models.replaceAccountModels({ accountId: accountB.id, createdAt: accountB.createdAt }, [model('model-b', 'low')]);
    const backend = new RoutingBackend();
    const app = createMessagesRoute({ backend, requestLog: new RequestLog(), modelRegistry: models, accountPool, backendProvider: 'session' });

    const aliasResponse = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonnet', max_tokens: 8, reasoning_effort: 'high', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(aliasResponse.status).toBe(200);
    expect(backend.completions[0]).toEqual({ accountId: 'account-a', model: 'model-a', reasoningEffort: 'high', serviceTier: undefined });

    const directResponse = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'model-b', max_tokens: 8, reasoning_effort: 'low', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(directResponse.status).toBe(200);
    expect(backend.completions[1]).toEqual({ accountId: 'account-b', model: 'model-b', reasoningEffort: 'low', serviceTier: undefined });
    expect(backend.listModelsCalls).toBe(0);
  });

  it('treats valid implicit alias effort and tier defaults as account eligibility requirements', async () => {
    const accountPool = new AccountPool({ seedMockAccount: false });
    const accountA = accountPool.add({ id: 'account-a', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'token-a' } });
    const accountB = accountPool.add({ id: 'account-b', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'token-b' } });
    const models = new ModelRegistry({
      defaults: { aliases: [{
        id: 'sonnet', type: 'model', display_name: 'Sonnet', backendModel: 'shared-model', enabled: true,
        capabilities: {}, defaults: { reasoning_effort: 'high', speed: 'priority' },
      }] },
    });
    models.replaceAccountModels({ accountId: accountA.id, createdAt: accountA.createdAt }, [{
      id: 'shared-model',
      controls: {
        reasoning: { metadataKnown: true, supported: [{ effort: 'low' }], defaultEffort: 'low' },
        serviceTier: { metadataKnown: true, supported: [], defaultTier: 'standard', fastMode: false },
      },
    }]);
    models.replaceAccountModels({ accountId: accountB.id, createdAt: accountB.createdAt }, [{
      id: 'shared-model',
      controls: {
        reasoning: { metadataKnown: true, supported: [{ effort: 'high' }], defaultEffort: 'high' },
        serviceTier: { metadataKnown: true, supported: [{ id: 'priority' }], defaultTier: 'priority', fastMode: true },
      },
    }]);
    const backend = new RoutingBackend();
    const app = createMessagesRoute({ backend, requestLog: new RequestLog(), modelRegistry: models, accountPool, backendProvider: 'session' });

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonnet', max_tokens: 8, messages: [{ role: 'user', content: 'implicit defaults' }] }),
    });

    expect(response.status).toBe(200);
    expect(backend.completions).toEqual([{
      accountId: 'account-b', model: 'shared-model', reasoningEffort: 'high', serviceTier: 'priority',
    }]);
  });

  it('keeps existing homogeneous scheduling behavior', async () => {
    const accountPool = new AccountPool({ seedMockAccount: false });
    const first = accountPool.add({ id: 'first', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'one' }, maxConcurrency: 1 });
    const second = accountPool.add({ id: 'second', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'two' }, maxConcurrency: 1 });
    const models = registry();
    models.replaceAccountModels({ accountId: first.id, createdAt: first.createdAt }, [model('model-a', 'high')]);
    models.replaceAccountModels({ accountId: second.id, createdAt: second.createdAt }, [model('model-a', 'high')]);

    const acquiredFirst = accountPool.acquire({
      provider: 'chatgpt-session', capability: 'messages',
      eligible: (account) => models.supportsAccountRequest('sonnet', { accountId: account.id, createdAt: account.createdAt }, { reasoningEffort: 'high', serviceTier: undefined }),
    });
    const acquiredSecond = accountPool.acquire({
      provider: 'chatgpt-session', capability: 'messages',
      eligible: (account) => models.supportsAccountRequest('sonnet', { accountId: account.id, createdAt: account.createdAt }, { reasoningEffort: 'high', serviceTier: undefined }),
    });

    expect(acquiredFirst?.id).toBe('first');
    expect(acquiredSecond?.id).toBe('second');
  });
});
