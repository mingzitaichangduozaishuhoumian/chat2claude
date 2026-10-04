import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { createAdminRoute } from './routes/admin.js';
import { createModelsRoute } from './routes/models.js';
import { availableImageModels } from './routes/image-models.js';
import { AccountPool } from './services/account-pool.js';
import { ModelRegistry } from './services/model-registry.js';
import { RuntimeApiKeys } from './services/runtime-api-keys.js';

const descriptor = { id: 'gpt-image-2', type: 'model', display_name: 'GPT Image 2', source: 'image_endpoint', endpoint: '/v1/images/generations', capabilities: { image_generation: true }, availability: 'backend_dependent' };
const descriptors = [
  { ...descriptor, id: 'gpt-image-1.5', display_name: 'GPT Image 1.5' }, descriptor,
  { ...descriptor, id: 'gpt-image-2.5-flare', display_name: 'GPT Image 2.5 Flare' },
  { ...descriptor, id: 'gpt-image-2.5-sunburst', display_name: 'GPT Image 2.5 Sunburst' },
  { ...descriptor, id: 'gpt-image-2.5', display_name: 'GPT Image 2.5' },
];
const catalog = Array.from({ length: 10 }, (_, index) => ({ id: `upstream-${index}` }));

function fixture(backendProvider: 'session' | 'mock' = 'session') {
  let now = new Date('2026-10-04T00:00:00.000Z');
  const accountPool = new AccountPool({ seedMockAccount: false, now: () => now });
  const account = accountPool.add({ id: 'a', provider: backendProvider === 'session' ? 'chatgpt-session' : 'mock', maxConcurrency: 1,
    ...(backendProvider === 'session' ? { secret: { type: 'chatgpt-session' as const, accessToken: 'PRIVATE_IMAGE_ACCESS_TOKEN', cookie: 'PRIVATE_IMAGE_COOKIE', deviceId: 'PRIVATE_IMAGE_DEVICE' } } : {}) });
  const modelRegistry = new ModelRegistry({ defaults: { aliases: [] } });
  modelRegistry.replaceAccountModels({ accountId: account.id, createdAt: account.createdAt }, catalog);
  const generateImages = vi.fn(async () => ({ created: 1, data: [{ b64_json: 'aW1hZ2U=' }] }));
  const backend: ChatGptBackendClient = { generateImages, listModels: vi.fn(async () => catalog), discoverModels: vi.fn(async () => ({ status: 'success' as const, models: catalog })), complete: async () => ({ text: '', finishReason: 'stop' }), async *stream() {} };
  const options = { backend, accountPool, modelRegistry, backendProvider, runtimeApiKeys: new RuntimeApiKeys(), envApiKeys: [], defaultReasoningEffort: 'medium', defaultResponseSpeed: 'auto' };
  const app = new Hono();
  app.route('/', createAdminRoute(options));
  app.route('/', createModelsRoute(options));
  return { app, options, accountPool, modelRegistry, backend, generateImages,
    now: (value: string) => { now = new Date(value); },
    get: async (path: string) => (await app.request(path)).json() as Promise<any>,
    mutate: async (path: string, method: string, body?: unknown) => {
      const response = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(response.status).toBeLessThan(400);
      return response.json() as Promise<any>;
    },
  };
}

describe('Admin image endpoint descriptors', () => {
  it('shows five separate image models while retaining the ten actually discovered models', async () => {
    const f = fixture();
    const account = (await f.get('/admin/api/accounts')).accounts[0];
    const models = await f.get('/admin/api/models');
    const publicModels = await f.get('/v1/models');
    expect(account.modelCount).toBe(10);
    expect(account.discoveredModels.map((model: { id: string }) => model.id)).toEqual(catalog.map((model) => model.id));
    expect(account.imageModels).toEqual(descriptors);
    expect(models.imageModels).toEqual(descriptors);
    expect(models.discovered).toHaveLength(10);
    expect(models.combined).toHaveLength(10);
    expect(models.aliases).toEqual([]);
    expect(publicModels.data.find((model: { id: string }) => model.id === descriptor.id)).toEqual(descriptor);
    expect(f.modelRegistry.snapshot().accountCatalogs[0].models).toEqual(catalog);
    expect(JSON.stringify({ account, models, publicModels })).not.toMatch(/PRIVATE_IMAGE_(ACCESS_TOKEN|COOKIE|DEVICE)/);
    expect(f.generateImages).not.toHaveBeenCalled();
  });

  it.each(['no-secret', 'empty-secret', 'cookie-only', 'whitespace-token', 'disabled', 'unhealthy', 'error', 'cooldown', 'wrong-provider', 'backend-unsupported'] as const)('returns an explicit empty image list for %s', async (condition) => {
    const f = fixture();
    if (condition === 'backend-unsupported') delete f.backend.generateImages;
    else if (condition === 'disabled') f.accountPool.update('a', { enabled: false });
    else if (condition === 'unhealthy' || condition === 'error' || condition === 'cooldown') f.accountPool.update('a', { status: condition, ...(condition === 'cooldown' ? { cooldownUntil: '2026-10-04T00:05:00.000Z' } : {}) });
    else {
      f.accountPool.remove('a');
      f.accountPool.add({ id: 'a', provider: condition === 'wrong-provider' ? 'mock' : 'chatgpt-session',
        ...(condition === 'empty-secret' ? { secret: { type: 'chatgpt-session' as const } } : {}),
        ...(condition === 'cookie-only' ? { secret: { type: 'chatgpt-session' as const, cookie: 'PRIVATE_IMAGE_COOKIE' } } : {}),
        ...(condition === 'whitespace-token' ? { secret: { type: 'chatgpt-session' as const, accessToken: '   ' } } : {}),
      });
    }
    expect((await f.get('/admin/api/accounts')).accounts[0].imageModels).toEqual([]);
    expect((await f.get('/admin/api/models')).imageModels).toEqual([]);
    expect((await f.get('/v1/models')).data.some((model: { source: string }) => model.source === 'image_endpoint')).toBe(false);
    expect(f.generateImages).not.toHaveBeenCalled();
  });

  it('does not lend another account entitlement to missing credentials, disabled or other-provider accounts', async () => {
    const f = fixture();
    f.accountPool.add({ id: 'missing', provider: 'chatgpt-session' });
    f.accountPool.add({ id: 'disabled', provider: 'chatgpt-session', enabled: false, secret: { type: 'chatgpt-session', accessToken: 'synthetic' } });
    f.accountPool.add({ id: 'mock', provider: 'mock' });
    const accounts = (await f.get('/admin/api/accounts')).accounts;
    expect(accounts.map((account: { id: string; imageModels: unknown[] }) => ({ id: account.id, imageModels: account.imageModels }))).toEqual([
      { id: 'a', imageModels: descriptors }, { id: 'missing', imageModels: [] }, { id: 'disabled', imageModels: [] }, { id: 'mock', imageModels: [] },
    ]);
    expect((await f.get('/admin/api/models')).imageModels).toEqual(descriptors);
  });

  it('keeps a busy account visible and restores visibility when its cooldown expires', async () => {
    const f = fixture();
    const lease = f.accountPool.acquire({ provider: 'chatgpt-session' })!;
    expect((await f.get('/admin/api/accounts')).accounts[0].imageModels).toEqual(descriptors);
    expect((await f.get('/admin/api/models')).imageModels).toEqual(descriptors);
    expect(f.accountPool.get('a')?.currentConcurrency).toBe(1);
    f.accountPool.release(lease);
    f.accountPool.update('a', { status: 'cooldown', cooldownUntil: '2026-10-04T00:01:00.000Z' });
    expect((await f.get('/admin/api/models')).imageModels).toEqual([]);
    f.now('2026-10-04T00:01:01.000Z');
    expect((await f.get('/admin/api/accounts')).accounts[0].imageModels).toEqual(descriptors);
    expect((await f.get('/admin/api/models')).imageModels).toEqual(descriptors);
  });

  it.each(['session', 'mock'] as const)('retains imageModels across every %s model view mutation and refresh', async (provider) => {
    const f = fixture(provider);
    const created = await f.mutate('/admin/api/models', 'POST', { id: 'alias', backendModel: catalog[0].id });
    expect(created.view.imageModels).toEqual(descriptors);
    expect((await f.mutate('/admin/api/models/alias', 'PATCH', { enabled: false })).view.imageModels).toEqual(descriptors);
    expect((await f.mutate('/admin/api/models/alias', 'DELETE')).view.imageModels).toEqual(descriptors);
    expect((await f.mutate('/admin/api/models/reset', 'POST')).view.imageModels).toEqual(descriptors);
    const refreshed = await f.mutate('/admin/api/models/refresh', 'POST');
    expect(refreshed.imageModels).toEqual(descriptors);
    expect(refreshed.discovered).toHaveLength(10);
    if (provider === 'session') expect((await f.mutate('/admin/api/accounts/a/health-check', 'POST')).view.imageModels).toEqual(descriptors);
    expect(f.generateImages).not.toHaveBeenCalled();
  });

  it('requires matching mock accounts for a mock backend and returns detached descriptors', async () => {
    const f = fixture('mock');
    f.accountPool.add({ id: 'session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'synthetic' } });
    const accounts = (await f.get('/admin/api/accounts')).accounts;
    expect(accounts.map((account: { imageModels: unknown[] }) => account.imageModels)).toEqual([descriptors, []]);
    const first = availableImageModels(f.options);
    first[0].display_name = 'modified';
    Object.assign(first[0].capabilities, { private: 'PRIVATE_IMAGE_CANARY' });
    expect(availableImageModels(f.options)).toEqual(descriptors);
    expect(availableImageModels(f.options, 'unknown')).toEqual([]);
  });
});
