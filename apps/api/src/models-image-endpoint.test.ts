import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { createModelsRoute } from './routes/models.js';
import { createOpenAiImagesRoute } from './routes/openai-images.js';
import { createOpenAiChatRoute } from './routes/openai-chat.js';
import { createOpenAiResponsesRoute } from './routes/openai-responses.js';
import { createMessagesRoute } from './routes/messages.js';
import { AccountPool } from './services/account-pool.js';
import { ModelRegistry } from './services/model-registry.js';
import { RequestLog } from './services/request-log.js';
import { createChatGptBackend } from './services/backend-factory.js';
import { loadEnv } from './config/env.js';

function fixture() {
  let now = new Date('2026-10-04T00:00:00Z');
  const accountPool = new AccountPool({ seedMockAccount: false, now: () => now });
  accountPool.add({ id: 'session', provider: 'chatgpt-session', capabilities: ['messages'], maxConcurrency: 1, secret: { type: 'chatgpt-session', accessToken: 'SYNTHETIC_ONLY' } });
  const modelRegistry = new ModelRegistry({ defaults: { aliases: [] } });
  const backend: ChatGptBackendClient = {
    generateImages: vi.fn(async () => ({ created: 1, data: [{ b64_json: 'aW1hZ2U=' }] })),
    listModels: vi.fn(async () => []), complete: vi.fn(async () => ({ text: '', finishReason: 'stop' })), stream: vi.fn(async function* () {}),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = { backend, accountPool, modelRegistry, requestLog: new RequestLog(), backendProvider: 'session' as const, logger };
  const app = new Hono();
  app.route('/', createModelsRoute(deps));
  app.route('/', createOpenAiImagesRoute(deps));
  app.route('/', createOpenAiChatRoute(deps));
  app.route('/', createOpenAiResponsesRoute(deps));
  app.route('/', createMessagesRoute(deps));
  return { app, backend, accountPool, modelRegistry, setNow: (value: Date) => { now = value; },
    models: async () => (await (await app.request('/v1/models')).json() as { data: Array<Record<string, unknown>> }).data,
  };
}

describe('Independent image model descriptor', () => {
  it('advertises only the verified default endpoint model without modifying text catalogs', async () => {
    const f = fixture();
    expect(await f.models()).toEqual([{ id: 'gpt-image-2', type: 'model', display_name: 'GPT Image 2', source: 'image_endpoint', endpoint: '/v1/images/generations', capabilities: { image_generation: true }, availability: 'backend_dependent' }]);
    expect(f.modelRegistry.list()).toEqual([]);
    expect(f.modelRegistry.adminView().discovered).toEqual([]);
    expect(() => f.modelRegistry.resolve('gpt-image-2')).toThrow();
    expect(f.backend.listModels).not.toHaveBeenCalled();
    expect(f.backend.generateImages).not.toHaveBeenCalled();
  });

  it('routes the advertised model only through Images and rejects it in every text API', async () => {
    const f = fixture();
    for (const [path, body] of [
      ['/v1/messages', { max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }],
      ['/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }],
      ['/v1/responses', { input: 'x' }],
    ] as const) {
      const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-image-2', ...body }) });
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error', message: 'This model uses the Images API. Use /v1/images/generations.' } });
    }
    expect(f.backend.complete).not.toHaveBeenCalled();
    expect(f.backend.generateImages).not.toHaveBeenCalled();
    expect((await f.app.request('/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-image-2', prompt: 'A tree' }) })).status).toBe(200);
    expect(f.backend.generateImages).toHaveBeenCalledOnce();
  });

  it.each(['native', 'stale-alias', 'bound-alias', 'same-name-alias'])('rejects %s image models before text account acquisition or backend dispatch', async (kind) => {
    const f = fixture();
    const acquire = vi.spyOn(f.accountPool, 'acquireAsync');
    let model = 'gpt-image-2';
    if (kind === 'stale-alias' || kind === 'bound-alias') {
      model = 'image-alias';
      f.modelRegistry.create({ id: model, backendModel: 'gpt-image-2' });
      if (kind === 'bound-alias') f.modelRegistry.replaceDiscoveredModels([{ id: 'gpt-image-2' }]);
    } else if (kind === 'same-name-alias') {
      f.modelRegistry.create({ id: model, backendModel: 'text-model' });
      f.modelRegistry.replaceDiscoveredModels([{ id: 'text-model' }]);
    }
    for (const stream of [false, true]) {
      for (const [path, body] of [
        ['/v1/messages', { max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }],
        ['/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }],
        ['/v1/responses', { input: 'x' }],
      ] as const) {
        const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, model, stream }) });
        expect(response.status, `${kind} ${path} stream=${stream}`).toBe(400);
        expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error', message: 'This model uses the Images API. Use /v1/images/generations.' } });
      }
    }
    expect(acquire).not.toHaveBeenCalled();
    expect(f.backend.complete).not.toHaveBeenCalled();
    expect(f.backend.stream).not.toHaveBeenCalled();
    expect(f.backend.generateImages).not.toHaveBeenCalled();
    expect(f.accountPool.get('session')?.currentConcurrency).toBe(0);
  });

  it.each(['disabled', 'unhealthy', 'error', 'cooldown', 'deleted', 'credentials-missing', 'wrong-provider', 'backend-unsupported'])('hides the descriptor when %s makes the image endpoint unavailable', async (condition) => {
    const f = fixture();
    if (condition === 'deleted') f.accountPool.remove('session');
    else if (condition === 'backend-unsupported') delete f.backend.generateImages;
    else if (condition === 'credentials-missing') {
      f.accountPool.remove('session');
      f.accountPool.add({ id: 'session', provider: 'chatgpt-session' });
    } else if (condition === 'wrong-provider') {
      f.accountPool.remove('session');
      f.accountPool.add({ id: 'mock', provider: 'mock' });
    } else if (condition === 'disabled') f.accountPool.update('session', { enabled: false });
    else f.accountPool.update('session', { status: condition, ...(condition === 'cooldown' ? { cooldownUntil: '2026-10-04T00:01:00Z' } : {}) });
    expect(await f.models()).toEqual([]);
  });

  it('retains a busy available model and restores it after account re-enable or cooldown expiry', async () => {
    const f = fixture();
    const lease = f.accountPool.acquire({ provider: 'chatgpt-session' })!;
    expect(await f.models()).toHaveLength(1);
    f.accountPool.release(lease);
    f.accountPool.update('session', { enabled: false });
    expect(await f.models()).toEqual([]);
    f.accountPool.update('session', { enabled: true });
    expect(await f.models()).toHaveLength(1);
    f.accountPool.update('session', { status: 'cooldown', cooldownUntil: '2026-10-04T00:01:00Z' });
    expect(await f.models()).toEqual([]);
    f.setNow(new Date('2026-10-04T00:01:01Z'));
    expect(await f.models()).toHaveLength(1);
  });

  it.each([
    undefined,
    {},
    { type: 'chatgpt-session', accessToken: '' },
    { type: 'chatgpt-session', accessToken: '   ' },
    { type: 'chatgpt-session', cookie: 'synthetic-cookie-only' },
    { type: 'chatgpt-session', refreshToken: 'synthetic-refresh-only' },
  ])('hides and rejects images without usable bearer credentials (%#)', async (secret) => {
    const f = fixture();
    f.accountPool.remove('session');
    f.accountPool.add({ id: 'session', provider: 'chatgpt-session', secret });
    expect(await f.models()).toEqual([]);
    const response = await f.app.request('/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'A tree' }) });
    expect(response.status).toBe(503);
    expect(f.backend.generateImages).not.toHaveBeenCalled();
    expect(f.accountPool.get('session')).toMatchObject({ status: 'available', currentConcurrency: 0 });
  });

  it('skips an unconfigured first account and dispatches to the next eligible account', async () => {
    const f = fixture();
    f.accountPool.remove('session');
    f.accountPool.add({ id: 'unconfigured', provider: 'chatgpt-session' });
    f.accountPool.add({ id: 'configured', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'synthetic-configured-token', expiresAt: '2000-01-01T00:00:00Z' } });
    expect(await f.models()).toHaveLength(1);
    const response = await f.app.request('/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'A tree' }) });
    expect(response.status).toBe(200);
    expect(f.backend.generateImages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ account: expect.objectContaining({ id: 'configured' }) }));
    expect(f.accountPool.get('unconfigured')).toMatchObject({ status: 'available', currentConcurrency: 0 });
    expect(f.accountPool.get('configured')).toMatchObject({ status: 'available', currentConcurrency: 0 });
  });

  it('selects the configured account through real Session and credential-refresh adapters', async () => {
    const f = fixture();
    f.accountPool.remove('session');
    f.accountPool.add({ id: 'unconfigured', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', cookie: 'synthetic-cookie-only' } });
    f.accountPool.add({ id: 'configured', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'synthetic-configured-token' } });
    const upstream = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toContain('/backend-api/codex/images/generations');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-configured-token');
      return Response.json({ created: 1, data: [{ b64_json: 'aW1hZ2U=' }] });
    });
    f.backend.generateImages = createChatGptBackend(loadEnv({ CHATGPT_BACKEND: 'session' }), f.accountPool, undefined, upstream).generateImages;
    expect(await f.models()).toHaveLength(1);
    expect((await f.app.request('/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'A tree' }) })).status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect(f.accountPool.get('unconfigured')).toMatchObject({ status: 'available', currentConcurrency: 0 });
    expect(f.accountPool.get('configured')).toMatchObject({ status: 'available', currentConcurrency: 0 });
  });

  it('prefers explicit image routing for a duplicate public ID without changing the catalog', async () => {
    const f = fixture();
    f.modelRegistry.replaceDiscoveredModels([{ id: 'gpt-image-2' }]);
    const models = await f.models();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ source: 'image_endpoint', endpoint: '/v1/images/generations' });
    expect(models[0]).not.toHaveProperty('discovered');
    expect(f.modelRegistry.resolve('gpt-image-2').model.source).toBe('discovered');
    expect(f.modelRegistry.adminView().discovered[0].source).toBe('discovered');
  });
});
