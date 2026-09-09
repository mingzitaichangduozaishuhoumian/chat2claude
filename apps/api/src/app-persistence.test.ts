import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatGptBackendClient, ChatGptBackendRequestContext, ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptDiscoveredModel } from '@chatgpt-to-claude/chatgpt-backend';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { AccountPool } from './services/account-pool.js';
import { DurableRuntimeState } from './services/durable-runtime-state.js';
import { RuntimeApiKeys } from './services/runtime-api-keys.js';
import { RuntimeStateStore } from './services/runtime-state-store.js';
import { AdminOperationalState } from './services/admin-operational-state.js';
import { ModelRegistry } from './services/model-registry.js';
import { RefreshAwareChatGptBackend } from './services/refresh-aware-backend.js';
import { SessionCredentialManager } from './services/session-credential-manager.js';
import { CodexOAuthClient } from './services/codex-oauth-client.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function localAdminHeaders(app: { request: (input: string, requestInit?: RequestInit) => Response | Promise<Response> }, contentType = false): Promise<Record<string, string>> {
  const response = await app.request('http://127.0.0.1:3000/admin', { headers: { host: '127.0.0.1:3000' } });
  const cookie = response.headers.get('set-cookie') ?? '';
  return {
    ...(contentType ? { 'content-type': 'application/json' } : {}),
    host: '127.0.0.1:3000',
    cookie,
    origin: 'http://127.0.0.1:3000',
  };
}

describe('createApp runtime state hydration', () => {
  it('rolls back a failed startup catalog commit and still discovers the next account', async () => {
    const env = loadEnv({ DATA_DIR: temporaryDirectory(), CHATGPT_BACKEND: 'session', API_KEYS: 'test-key' });
    const accountPool = new AccountPool({ seedMockAccount: false });
    const first = accountPool.add({ id: 'startup-first', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'first-secret' } });
    accountPool.add({ id: 'startup-second', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'second-secret' } });
    const store = new RuntimeStateStore({ path: env.runtimeStatePath });
    new DurableRuntimeState({ accountPool, runtimeApiKeys: new RuntimeApiKeys(), modelRegistry: new ModelRegistry(), store }).persist();
    const operational = new AdminOperationalState({ path: env.operationalStatePath });
    operational.recordDiscovery({ accountId: first.id, createdAt: first.createdAt }, { status: 'success', models: [{ id: 'synthetic-cached-first' }] });
    await operational.dispose();

    const discoveredAccounts: string[] = [];
    let failNextCommit = false;
    const save = store.save.bind(store);
    const saveSpy = vi.spyOn(store, 'save').mockImplementation((state) => {
      if (failNextCommit) { failNextCommit = false; throw new Error('injected startup commit failure'); }
      save(state);
    });
    const backend: ChatGptBackendClient = {
      complete: async () => ({ text: '', finishReason: 'stop' }), async *stream() {},
      listModels: async () => { throw new Error('typed discovery expected'); },
      discoverModels: async (context) => {
        const id = context!.account!.id;
        discoveredAccounts.push(id);
        if (id === first.id) failNextCommit = true;
        return { status: 'success', models: [{ id: id === first.id ? 'synthetic-rejected-first' : 'synthetic-accepted-second' }] };
      },
    };
    const app = createApp(env, { backend, runtimeStateStore: store });
    try {
      const headers = { 'x-api-key': 'test-key' };
      const models = await (await app.request('/admin/api/models', { headers })).json() as { discovered: Array<{ id: string }>; aliases: Array<{ id: string; backendModel?: string }> };
      expect(discoveredAccounts).toEqual(['startup-first', 'startup-second']);
      expect(models.discovered.map((model) => model.id).sort()).toEqual(['synthetic-accepted-second', 'synthetic-cached-first']);
      expect(models.aliases.find((alias) => alias.id === 'sonnet')?.backendModel).toBe('synthetic-accepted-second');
      expect(await (await app.request('/admin/api/accounts', { headers })).json()).toMatchObject({ accounts: [
        expect.objectContaining({ id: first.id, discoveredModels: [{ id: 'synthetic-cached-first' }] }),
        expect.objectContaining({ id: 'startup-second', discovery: expect.objectContaining({ status: 'success' }), discoveredModels: [{ id: 'synthetic-accepted-second' }] }),
      ] });
      expect(store.load()?.modelAliases.find((alias) => alias.id === 'sonnet')?.backendModel).toBe('synthetic-accepted-second');
      expect(saveSpy).toHaveBeenCalledTimes(2);
    } finally { await app.dispose(); saveSpy.mockRestore(); }
  });
  it('hydrates accounts and runtime keys before backend and auth construction', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir });
    const accountPool = new AccountPool();
    accountPool.add({ id: 'persisted-session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'persisted-access' } });
    const runtimeApiKeys = new RuntimeApiKeys();
    const apiKey = runtimeApiKeys.getOrCreate('primary');
    new DurableRuntimeState({ accountPool, runtimeApiKeys, store: new RuntimeStateStore({ path: env.runtimeStatePath }) }).persist();

    const app = createApp(env);
    const response = await app.request('http://127.0.0.1:3000/admin/api/accounts', { headers: await localAdminHeaders(app) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accounts: expect.arrayContaining([expect.objectContaining({ id: 'persisted-session', hasSecret: true })]) });
    await app.dispose();
  });

  it('keeps a valid persisted empty account pool empty on restart', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir });
    new RuntimeStateStore({ path: env.runtimeStatePath }).save({ version: 1, accounts: [], runtimeApiKeys: { keys: ['runtime-key'], namedKeys: {} } });
    const app = createApp(env);
    const response = await app.request('http://127.0.0.1:3000/admin/api/accounts', { headers: await localAdminHeaders(app) });
    expect(await response.json()).toEqual({ accounts: [] });
    await app.dispose();
  });

  it('starts a fresh session backend without mock accounts', async () => {
    const env = loadEnv({ DATA_DIR: temporaryDirectory(), CHATGPT_BACKEND: 'session', API_KEYS: 'test-key' });
    const app = createApp(env);
    const response = await app.request('/admin/api/accounts', { headers: { 'x-api-key': 'test-key' } });
    expect(await response.json()).toEqual({ accounts: [] });
    await app.dispose();
  });

  it('retains the mock account in mock backend mode', async () => {
    const env = loadEnv({ DATA_DIR: temporaryDirectory(), CHATGPT_BACKEND: 'mock', API_KEYS: 'test-key' });
    const app = createApp(env);
    const response = await app.request('/admin/api/accounts', { headers: { 'x-api-key': 'test-key' } });
    expect(await response.json()).toMatchObject({ accounts: [expect.objectContaining({ id: 'mock-account', provider: 'mock' })] });
    await app.dispose();
  });

  it('removes persisted mock accounts during a session-mode restart while preserving real accounts and runtime keys', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir, CHATGPT_BACKEND: 'session' });
    const accountPool = new AccountPool();
    accountPool.add({ id: 'persisted-session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'persisted-access' } });
    const runtimeApiKeys = new RuntimeApiKeys();
    const apiKey = runtimeApiKeys.getOrCreate('primary');
    const store = new RuntimeStateStore({ path: env.runtimeStatePath });
    new DurableRuntimeState({ accountPool, runtimeApiKeys, store }).persist();

    const app = createApp(env);
    const response = await app.request('http://127.0.0.1:3000/admin/api/accounts', { headers: await localAdminHeaders(app) });
    expect(await response.json()).toMatchObject({ accounts: [expect.objectContaining({ id: 'persisted-session', provider: 'chatgpt-session', hasSecret: true })] });
    expect((await store.load())?.accounts).toEqual([expect.objectContaining({ id: 'persisted-session', provider: 'chatgpt-session' })]);
    expect((await store.load())?.runtimeApiKeys).toEqual(runtimeApiKeys.exportState());
    await app.dispose();
  });

  it('hydrates operational state, cleans orphans by account identity, and flushes on dispose', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir, API_KEYS: 'test-key' });
    const accounts = new AccountPool({ seedMockAccount: false });
    accounts.add({ id: 'keep', provider: 'mock' });
    const keep = accounts.get('keep')!;
    new DurableRuntimeState({ accountPool: accounts, runtimeApiKeys: new RuntimeApiKeys(), store: new RuntimeStateStore({ path: env.runtimeStatePath }) }).persist();

    const operational = new AdminOperationalState({ path: env.operationalStatePath, debounceMs: 10 });
    operational.setDiscoveredModelIds({ accountId: keep.id, createdAt: keep.createdAt }, ['keep-model']);
    operational.setDiscoveredModelIds({ accountId: 'deleted', createdAt: '2026-09-03T00:00:00.000Z' }, ['orphan-model']);
    await operational.dispose();

    const app = createApp(env);
    await app.dispose();

    const restored = new AdminOperationalState({ path: env.operationalStatePath });
    expect(restored.hydrate()).toBe(true);
    expect(restored.snapshot().accounts).toEqual([
      expect.objectContaining({ accountId: 'keep', createdAt: keep.createdAt, discoveredModelIds: ['keep-model'], requestStats: expect.objectContaining({ inFlight: 0 }) }),
    ]);
    await restored.dispose();
  });

  it('durably flushes a provisioned account catalog before success so an immediate restart survives unavailable discovery', async () => {
    const dataDir = temporaryDirectory();
    const initialEnv = loadEnv({
      DATA_DIR: dataDir,
      CHATGPT_BACKEND: 'mock',
      MOCK_BACKEND_MODELS_JSON: JSON.stringify([{ id: 'provisioned-catalog-model', displayName: 'Provisioned Catalog Model' }]),
    });
    const initialApp = createApp(initialEnv);
    try {
      const provisionResponse = await initialApp.request('/admin/api/auth/chatgpt/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: 'provisioned-access' }),
      });
      expect(provisionResponse.status).toBe(200);
      const provisioned = await provisionResponse.json() as { apiKey: string };

      // Deliberately restart before disposing the initial process. This exercises
      // the provisioning completion boundary rather than disposal's best-effort flush.
      const restartedEnv = loadEnv({ DATA_DIR: dataDir, CHATGPT_BACKEND: 'session' });
      const restartedApp = createApp(restartedEnv, { backend: new AccountCatalogBackend({}, true) });
      try {
        const models = await restartedApp.request('http://127.0.0.1:3000/admin/api/models', { headers: await localAdminHeaders(restartedApp) });
        expect(models.status).toBe(200);
        expect(await models.json()).toMatchObject({
          discovered: expect.arrayContaining([expect.objectContaining({
            id: 'provisioned-catalog-model',
            discovered: { id: 'provisioned-catalog-model', displayName: 'Provisioned Catalog Model' },
          })]),
        });
      } finally {
        await restartedApp.dispose();
      }
    } finally {
      await initialApp.dispose();
    }
  });

  it('keeps startup discovery when that operation rotates an expired OAuth credential', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir, CHATGPT_BACKEND: 'session', API_KEYS: 'test-key' });
    const accounts = new AccountPool({ seedMockAccount: false });
    accounts.add({
      id: 'rotating-startup',
      provider: 'chatgpt-session',
      secret: {
        type: 'chatgpt-session', accountId: 'startup-upstream', accessToken: 'expired-access', refreshToken: 'startup-refresh',
        expiresAt: '2000-01-01T00:00:00.000Z',
      },
    });
    new DurableRuntimeState({
      accountPool: accounts,
      runtimeApiKeys: new RuntimeApiKeys(),
      modelRegistry: new ModelRegistry(),
      store: new RuntimeStateStore({ path: env.runtimeStatePath }),
    }).persist();
    const transport = new AccountCatalogBackend({ 'rotating-startup': [{ id: 'rotated-startup-model' }] });

    const app = createApp(env, {
      backendFactory: (accountPool, durableState) => new RefreshAwareChatGptBackend(
        transport,
        new SessionCredentialManager({
          accountPool,
          durableState,
          now: () => new Date('2026-09-04T00:00:00.000Z'),
          oauthClient: new CodexOAuthClient({ fetch: async () => Response.json({
            access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600,
          }) }),
        }),
      ),
    });

    const response = await app.request('/admin/api/models', { headers: { 'x-api-key': 'test-key' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      discovered: expect.arrayContaining([expect.objectContaining({ id: 'rotated-startup-model' })]),
    });
    expect(transport.discoveryTokens).toEqual(['rotated-access']);
    await app.dispose();
  });

  it('does not let older startup discovery overwrite a newer failed health discovery', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir, CHATGPT_BACKEND: 'session', API_KEYS: 'test-key' });
    const accounts = new AccountPool({ seedMockAccount: false });
    accounts.add({ id: 'startup-health-order', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'access' } });
    new DurableRuntimeState({
      accountPool: accounts,
      runtimeApiKeys: new RuntimeApiKeys(),
      modelRegistry: new ModelRegistry(),
      store: new RuntimeStateStore({ path: env.runtimeStatePath }),
    }).persist();
    const startupDiscovery = deferred<ChatGptDiscoveredModel[]>();
    const healthDiscovery = deferred<ChatGptDiscoveredModel[]>();
    let discoveryCall = 0;
    const backend = Object.assign(new AccountCatalogBackend({}), {
      healthCheck: async () => ({ ok: true as const }),
    });
    backend.listModels = async () => (++discoveryCall === 1 ? startupDiscovery.promise : healthDiscovery.promise);
    const app = createApp(env, { backend });

    await Promise.resolve();
    const health = app.request('/admin/api/accounts/startup-health-order/health-check', {
      method: 'POST',
      headers: { 'x-api-key': 'test-key' },
    });
    await Promise.resolve();
    healthDiscovery.reject(new Error('newer health failure'));
    await expect(health).resolves.toHaveProperty('status', 502);
    startupDiscovery.resolve([{ id: 'older-startup-model' }]);

    const models = await app.request('/admin/api/models', { headers: { 'x-api-key': 'test-key' } });
    expect(models.status).toBe(200);
    expect((await models.json() as { discovered: Array<{ id: string }> }).discovered).toEqual([]);
    const accountResponse = await app.request('/admin/api/accounts', { headers: { 'x-api-key': 'test-key' } });
    expect(await accountResponse.json()).toMatchObject({
      accounts: [expect.objectContaining({ id: 'startup-health-order', status: 'error', lastError: 'Health check request failed.', discovery: expect.objectContaining({ status: 'error', stale: false }) })],
    });
    await app.dispose();
  });

  it('rehydrates disjoint account catalogs safely when restart discovery is unavailable', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir, CHATGPT_BACKEND: 'session', API_KEYS: 'test-key' });
    const accounts = new AccountPool({ seedMockAccount: false });
    accounts.add({ id: 'account-a', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'access-a' } });
    accounts.add({ id: 'account-b', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'access-b' } });
    const models = new ModelRegistry();
    models.update('sonnet', { backendModel: 'model-a' });
    new DurableRuntimeState({
      accountPool: accounts,
      runtimeApiKeys: new RuntimeApiKeys(),
      modelRegistry: models,
      store: new RuntimeStateStore({ path: env.runtimeStatePath }),
    }).persist();

    const discoveryBackend = new AccountCatalogBackend({ 'account-a': [{ id: 'model-a' }], 'account-b': [{ id: 'model-b' }] });
    const initialApp = createApp(env, { backend: discoveryBackend });
    const initialModels = await initialApp.request('/admin/api/models', { headers: { 'x-api-key': 'test-key' } });
    expect(await initialModels.json()).toMatchObject({
      aliases: expect.arrayContaining([expect.objectContaining({ id: 'sonnet', backendModel: 'model-a', status: 'bound' })]),
      discovered: expect.arrayContaining([
        expect.objectContaining({ id: 'model-a' }),
        expect.objectContaining({ id: 'model-b' }),
      ]),
    });
    await initialApp.dispose();

    const offlineBackend = new AccountCatalogBackend({}, true);
    const restartedApp = createApp(env, { backend: offlineBackend });
    const restartedModels = await restartedApp.request('/admin/api/models', { headers: { 'x-api-key': 'test-key' } });
    expect(await restartedModels.json()).toMatchObject({
      aliases: expect.arrayContaining([expect.objectContaining({ id: 'sonnet', backendModel: 'model-a', status: 'bound' })]),
      discovered: expect.arrayContaining([
        expect.objectContaining({ id: 'model-a' }),
        expect.objectContaining({ id: 'model-b' }),
      ]),
    });

    const headers = { 'content-type': 'application/json', 'x-api-key': 'test-key' };
    const aliasResponse = await restartedApp.request('/v1/messages', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'route a' }] }),
    });
    const directResponse = await restartedApp.request('/v1/messages', {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'model-b', max_tokens: 64, messages: [{ role: 'user', content: 'route b' }] }),
    });
    expect(aliasResponse.status).toBe(200);
    expect(directResponse.status).toBe(200);
    expect(offlineBackend.completionAccounts).toEqual(['account-a', 'account-b']);
    await restartedApp.dispose();
  });

  it('preserves a custom sonnet binding to the second discovered model across restart and remains callable', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({
      DATA_DIR: dataDir,
      CHATGPT_BACKEND: 'mock',
      MOCK_BACKEND_MODELS_JSON: JSON.stringify([
        { id: 'preferred-backend-model', displayName: 'Preferred Backend Model' },
        { id: 'custom-second-model', displayName: 'Custom Second Model' },
      ]),
    });
    const initialApp = createApp(env);
    const provisionResponse = await initialApp.request('/admin/api/auth/chatgpt/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: 'persisted-access' }),
    });
    expect(provisionResponse.status).toBe(200);
    const provisioned = await provisionResponse.json() as { apiKey: string };
    const clientHeaders = { 'content-type': 'application/json', 'x-api-key': provisioned.apiKey };
    const adminHeaders = await localAdminHeaders(initialApp, true);
    const customMapping = await initialApp.request('http://127.0.0.1:3000/admin/api/models/sonnet', {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ backendModel: 'custom-second-model' }),
    });
    expect(customMapping.status).toBe(200);
    await initialApp.dispose();

    const restartedApp = createApp(env);
    const models = await restartedApp.request('http://127.0.0.1:3000/admin/api/models', { headers: await localAdminHeaders(restartedApp) });
    expect(await models.json()).toMatchObject({ aliases: expect.arrayContaining([
      expect.objectContaining({ id: 'sonnet', backendModel: 'custom-second-model', status: 'bound' }),
    ]) });
    const response = await restartedApp.request('/v1/messages', {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'after restart' }] }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { model: string }).model).toBe('sonnet');
    await restartedApp.dispose();
  });
});

class AccountCatalogBackend implements ChatGptBackendClient {
  readonly completionAccounts: string[] = [];
  readonly discoveryTokens: string[] = [];

  constructor(
    private readonly catalogs: Record<string, ChatGptDiscoveredModel[]>,
    private readonly failDiscovery = false,
  ) {}

  async listModels(context?: ChatGptBackendRequestContext): Promise<ChatGptDiscoveredModel[]> {
    if (this.failDiscovery) throw new Error('discovery unavailable');
    this.discoveryTokens.push(context?.account?.secret?.accessToken ?? '');
    return this.catalogs[context?.account?.id ?? ''] ?? [];
  }

  async complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse> {
    this.completionAccounts.push(context?.account?.id ?? '');
    return { text: `${request.model}:${context?.account?.id ?? ''}`, finishReason: 'stop' };
  }

  async *stream(): AsyncIterable<never> {
    throw new Error('not implemented');
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'chat2claude-app-state-'));
  directories.push(directory);
  return directory;
}
