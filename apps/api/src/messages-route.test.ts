import { describe, expect, it } from 'vitest';
import type { ChatGptBackendClient, ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptDiscoveredModel } from '@chatgpt-to-claude/chatgpt-backend';
import { createApp } from './app.js';
import { createMessagesRoute } from './routes/messages.js';
import { AccountPool } from './services/account-pool.js';
import { ModelRegistry } from './services/model-registry.js';
import { RequestLog } from './services/request-log.js';

const discoveredModels = [{ id: 'backend-test-model', displayName: 'Backend Test Model' }];
const env = {
  port: 3000,
  host: '127.0.0.1',
  apiKeys: ['test-key'],
  logLevel: 'error' as const,
  mockResponsePrefix: 'Echo:',
  mockBackendModelsJson: JSON.stringify(discoveredModels),
  defaultReasoningEffort: 'medium' as const,
  defaultResponseSpeed: 'balanced' as const,
};
const jsonHeaders = { 'content-type': 'application/json', 'x-api-key': 'test-key' };

describe('/v1/messages', () => {
  it('uses the default mock backend model when model JSON is unset', async () => {
    const app = createApp({ ...env, mockBackendModelsJson: undefined });
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: Array<{ text: string }> };
    expect(body.content[0].text).toBe('Echo:[effort=medium,speed=balanced] hello');
  });

  it('returns a Claude-like non-stream message with resolved effort and speed', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, output_config: { effort: 'high' }, speed: 'fast', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { type: string; role: string; content: Array<{ text: string }>; stop_reason: string };
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.content[0].text).toBe('Echo:[effort=high,speed=fast] hello');
    expect(body.stop_reason).toBe('end_turn');
  });

  it('uses alias overlay defaults when request omits effort and speed', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: Array<{ text: string }> };
    expect(body.content[0].text).toBe('Echo:[effort=medium,speed=balanced] hello');
  });

  it('uses patched alias defaults in mock echo', async () => {
    const app = createApp(env);
    const patchRes = await app.request('/admin/api/models/sonnet', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaults: { reasoning_effort: 'max', speed: 'quality' } }) });
    expect(patchRes.status).toBe(200);

    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: Array<{ text: string }> };
    expect(body.content[0].text).toBe('Echo:[effort=max,speed=quality] hello');
  });

  it('returns Claude SSE stream events', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, stream: true, reasoning_effort: 'low', response_speed: 'quality', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('Echo:[effort=low');
    expect(text).toContain(',speed=quality] ');
    expect(text).toContain('hello');
    expect(text).toContain('event: message_stop');
  });

  it('returns a Claude error for an unknown model', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'unknown-model', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(404);
    const body = await res.json() as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('not_found_error');
    expect(body.error.message).toContain('Unknown model: unknown-model');
  });

  it('returns a Claude error for a disabled alias', async () => {
    const app = createApp(env);
    const patchRes = await app.request('/admin/api/models/sonnet', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    expect(patchRes.status).toBe(200);

    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('Model is disabled: sonnet');
  });

  it('returns a clear error for an unbound alias', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'opus', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('Model alias is not bound to a backend model: opus');
  });

  it('returns a clear error for a stale alias binding', async () => {
    const app = createApp(env);
    const patchRes = await app.request('/admin/api/models/sonnet', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backendModel: 'missing-backend-model' }) });
    expect(patchRes.status).toBe(200);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('Model alias sonnet is bound to missing backend model: missing-backend-model');
  });

  it('passes through a directly discovered backend model', async () => {
    const app = createApp({ ...env, mockBackendModelsJson: JSON.stringify([{ id: 'backend-test-model' }, { id: 'direct-backend-model' }]) });
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'direct-backend-model', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: Array<{ text: string }> };
    expect(body.content[0].text).toBe('Echo:[effort=medium,speed=balanced] hello');
  });

  it('passes resolved backendModel to the backend request', async () => {
    const backend = new InspectingBackend([{ id: 'backend-injected-model' }]);
    const modelRegistry = new ModelRegistry({ discoveredModels: [{ id: 'backend-injected-model' }] });
    const updated = modelRegistry.update('sonnet', { backendModel: 'backend-injected-model' });
    expect(updated?.backendModel).toBe('backend-injected-model');
    const app = createMessagesRoute({ backend, requestLog: new RequestLog(), modelRegistry, accountPool: new AccountPool() });

    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(backend.lastRequest?.model).toBe('backend-injected-model');
  });

  it('releases account concurrency after a non-streaming request', async () => {
    const accountPool = new AccountPool();
    const app = createMessagesRoute({ backend: new InspectingBackend([{ id: 'backend-test-model' }]), requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool });
    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(accountPool.list()[0].currentConcurrency).toBe(0);
    expect(accountPool.list()[0].status).toBe('available');
  });

  it('releases account concurrency after a streaming request is consumed', async () => {
    const accountPool = new AccountPool();
    const app = createMessagesRoute({ backend: new InspectingBackend([{ id: 'backend-test-model' }]), requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool });
    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(accountPool.list()[0].currentConcurrency).toBe(1);
    await res.text();
    expect(accountPool.list()[0].currentConcurrency).toBe(0);
    expect(accountPool.list()[0].status).toBe('available');
  });
});

class InspectingBackend implements ChatGptBackendClient {
  lastRequest: ChatGptCompletionRequest | undefined;
  constructor(private readonly models: ChatGptDiscoveredModel[] = []) {}

  async listModels(): Promise<ChatGptDiscoveredModel[]> {
    return this.models;
  }

  async complete(request: ChatGptCompletionRequest): Promise<ChatGptCompletionResponse> {
    this.lastRequest = request;
    return { text: `backend:${request.model}`, finishReason: 'stop' };
  }

  async *stream(request: ChatGptCompletionRequest) {
    this.lastRequest = request;
    yield { type: 'text_delta' as const, text: `backend:${request.model}` };
    yield { type: 'done' as const };
  }
}

describe('API key auth', () => {
  it('rejects /v1/messages before admin initialization when no API key exists', async () => {
    const app = createApp({ ...env, apiKeys: [] });
    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('/admin');
  });

  it('accepts bearer API keys from API_KEYS', async () => {
    const app = createApp({ ...env, apiKeys: ['secret'] });
    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
  });

  it('enables a random runtime development key through admin dev-enable without restart', async () => {
    const app = createApp({ ...env, apiKeys: [] });
    const firstEnableRes = await app.request('/admin/api/api-keys/dev-enable', { method: 'POST' });
    const secondEnableRes = await app.request('/admin/api/api-keys/dev-enable', { method: 'POST' });
    expect(firstEnableRes.status).toBe(200);
    expect(secondEnableRes.status).toBe(200);
    const firstEnableBody = await firstEnableRes.json() as { key: string; status: { apiKeysConfigured: boolean; runtimeApiKeysConfigured: boolean } };
    const secondEnableBody = await secondEnableRes.json() as { key: string };
    expect(firstEnableBody.key).toMatch(/^sk-dev-[A-Za-z0-9_-]+$/);
    expect(secondEnableBody.key).toMatch(/^sk-dev-[A-Za-z0-9_-]+$/);
    expect(secondEnableBody.key).not.toBe(firstEnableBody.key);
    expect(firstEnableBody.status.apiKeysConfigured).toBe(true);
    expect(firstEnableBody.status.runtimeApiKeysConfigured).toBe(true);

    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': firstEnableBody.key }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
  });

  it('rejects admin dev-enable in production', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app = createApp({ ...env, apiKeys: [] });
      const res = await app.request('/admin/api/api-keys/dev-enable', { method: 'POST' });
      expect(res.status).toBe(403);
      const body = await res.json() as { type: string; error: { type: string; message: string } };
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('permission_error');
      expect(body.error.message).toContain('disabled in production');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
});

describe('/admin', () => {
  it('redirects the root path to the admin console', async () => {
    const app = createApp(env);
    const res = await app.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
  });

  it('returns an empty favicon response instead of a 404', async () => {
    const app = createApp(env);
    const res = await app.request('/favicon.ico');
    expect(res.status).toBe(204);
  });

  it('returns the server-rendered admin HTML page', async () => {
    const app = createApp(env);
    const res = await app.request('/admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('ChatGPT to Claude 运维控制台');
    expect(html).toContain('__ORIGIN__');
    expect(html).not.toContain('localhost:3000/v1/messages');
  });

  it('returns setup status for mock backend and defaults', async () => {
    const app = createApp({ ...env, apiKeys: [] });
    const res = await app.request('/admin/api/setup/status');
    expect(res.status).toBe(200);
    const body = await res.json() as { apiKeysConfigured: boolean; defaultReasoningEffort: string; defaultResponseSpeed: string; mockBackend: { enabled: boolean; provider: string; chatGptConnected: boolean }; nextStep: string };
    expect(body.apiKeysConfigured).toBe(false);
    expect(body.defaultReasoningEffort).toBe('medium');
    expect(body.defaultResponseSpeed).toBe('balanced');
    expect(body.mockBackend).toEqual({ enabled: true, provider: 'mock', chatGptConnected: false });
    expect(body.nextStep).toContain('/admin');
  });
});

describe('/v1/models', () => {
  it('returns enabled resolved aliases and discovered passthrough models', async () => {
    const app = createApp({ ...env, mockBackendModelsJson: JSON.stringify([{ id: 'backend-test-model' }, { id: 'direct-backend-model' }]) });
    const res = await app.request('/v1/models', { headers: { 'x-api-key': 'test-key' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ id: string; backendModel: string; enabled: boolean; source: string; status: string; capabilities: { reasoning_effort: string[]; response_speed: string[]; thinking: boolean }; defaults: { reasoning_effort: string; speed: string } }> };
    expect(body.data.map((model) => model.id)).toContain('sonnet');
    expect(body.data.map((model) => model.id)).toContain('direct-backend-model');
    expect(body.data.map((model) => model.id)).not.toContain('opus');
    const sonnet = body.data.find((model) => model.id === 'sonnet');
    expect(sonnet).toMatchObject({ backendModel: 'backend-test-model', enabled: true, source: 'alias', status: 'bound', defaults: { reasoning_effort: 'medium', speed: 'balanced' } });
    expect(sonnet?.capabilities.reasoning_effort).toContain('high');
    expect(sonnet?.capabilities.response_speed).toContain('fast');
    expect(sonnet?.capabilities.thinking).toBe(true);
  });
});

describe('/admin/api/accounts', () => {
  it('adds, lists, patches, and health-checks runtime accounts', async () => {
    const app = createApp(env);
    const addRes = await app.request('/admin/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'mock-2', label: 'Mock 2', maxConcurrency: 3, capabilities: ['mock', 'messages'] }) });
    expect(addRes.status).toBe(201);
    const addBody = await addRes.json() as { account: { id: string; label: string; maxConcurrency: number; status: string; enabled: boolean } };
    expect(addBody.account).toMatchObject({ id: 'mock-2', label: 'Mock 2', maxConcurrency: 3, status: 'available', enabled: true });

    const listRes = await app.request('/admin/api/accounts');
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { accounts: Array<{ id: string }> };
    expect(listBody.accounts.map((account) => account.id)).toContain('mock-2');

    const patchRes = await app.request('/admin/api/accounts/mock-2', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, lastError: 'manual disable' }) });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as { account: { status: string; enabled: boolean; lastError: string } };
    expect(patchBody.account).toMatchObject({ status: 'disabled', enabled: false, lastError: 'manual disable' });

    const healthRes = await app.request('/admin/api/accounts/mock-2/health-check', { method: 'POST' });
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json() as { ok: boolean; account: { status: string; lastError: string | null; lastUsedAt: string | null } };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.account.status).toBe('disabled');
    expect(healthBody.account.lastError).toBeNull();
    expect(healthBody.account.lastUsedAt).toEqual(expect.any(String));
  });
});

describe('/admin/api/models', () => {
  it('uses MODEL_REGISTRY_JSON as alias overlay source and resets back to it', () => {
    const modelRegistry = new ModelRegistry({
      env: {
        MODEL_REGISTRY_JSON: JSON.stringify({
          aliases: [{
            id: 'custom',
            display_name: 'Custom Alias',
            backendModel: 'backend-custom',
            enabled: true,
            defaults: { reasoning_effort: 'low', speed: 'fast' },
          }],
        }),
      },
      discoveredModels: [{ id: 'backend-custom' }, { id: 'changed' }],
    });

    expect(modelRegistry.adminView().aliases).toHaveLength(1);
    expect(modelRegistry.get('custom')?.backendModel).toBe('backend-custom');
    modelRegistry.update('custom', { backendModel: 'changed', defaults: { reasoning_effort: 'max', speed: 'quality' } });
    expect(modelRegistry.get('custom')?.backendModel).toBe('changed');
    const reset = modelRegistry.reset();
    expect(reset[0]).toMatchObject({ id: 'custom', backendModel: 'backend-custom', defaults: { reasoning_effort: 'low', speed: 'fast' } });
  });

  it('patches, lists, refreshes, and resets alias overlay models', async () => {
    const app = createApp(env);
    const patchRes = await app.request('/admin/api/models/haiku', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backendModel: 'backend-test-model', enabled: false, defaults: { reasoning_effort: 'minimal', speed: 'fastest' } }) });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as { model: { backendModel: string; enabled: boolean; defaults: { reasoning_effort: string; speed: string } } };
    expect(patchBody.model).toMatchObject({ backendModel: 'backend-test-model', enabled: false, defaults: { reasoning_effort: 'minimal', speed: 'fastest' } });

    const adminListRes = await app.request('/admin/api/models');
    const adminListBody = await adminListRes.json() as { aliases: Array<{ id: string; enabled: boolean }>; discovered: Array<{ id: string }>; combined: Array<{ id: string }> };
    expect(adminListBody.aliases.find((model) => model.id === 'haiku')?.enabled).toBe(false);
    expect(adminListBody.discovered.map((model) => model.id)).toContain('backend-test-model');
    expect(adminListBody.combined.map((model) => model.id)).toContain('backend-test-model');

    const publicListRes = await app.request('/v1/models', { headers: { 'x-api-key': 'test-key' } });
    const publicListBody = await publicListRes.json() as { data: Array<{ id: string }> };
    expect(publicListBody.data.map((model) => model.id)).not.toContain('haiku');

    const refreshRes = await app.request('/admin/api/models/refresh', { method: 'POST' });
    expect(refreshRes.status).toBe(200);
    const refreshBody = await refreshRes.json() as { discovered: Array<{ id: string }> };
    expect(refreshBody.discovered.map((model) => model.id)).toContain('backend-test-model');

    const resetRes = await app.request('/admin/api/models/reset', { method: 'POST' });
    expect(resetRes.status).toBe(200);
    const resetBody = await resetRes.json() as { models: Array<{ id: string; backendModel?: string; enabled: boolean; defaults: { reasoning_effort: string; speed: string } }> };
    const resetHaiku = resetBody.models.find((model) => model.id === 'haiku');
    expect(resetHaiku?.enabled).toBe(true);
    expect(resetHaiku?.backendModel).toBe('backend-test-model');
    expect(resetHaiku?.defaults).not.toEqual({ reasoning_effort: 'minimal', speed: 'fastest' });
  });
});
