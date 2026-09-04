import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { AccountPool } from './services/account-pool.js';
import { DurableRuntimeState } from './services/durable-runtime-state.js';
import { RuntimeApiKeys } from './services/runtime-api-keys.js';
import { RuntimeStateStore } from './services/runtime-state-store.js';
import { AdminOperationalState } from './services/admin-operational-state.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('createApp runtime state hydration', () => {
  it('hydrates accounts and runtime keys before backend and auth construction', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir });
    const accountPool = new AccountPool();
    accountPool.add({ id: 'persisted-session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'persisted-access' } });
    const runtimeApiKeys = new RuntimeApiKeys();
    const apiKey = runtimeApiKeys.getOrCreate('primary');
    new DurableRuntimeState({ accountPool, runtimeApiKeys, store: new RuntimeStateStore({ path: env.runtimeStatePath }) }).persist();

    const app = createApp(env);
    const response = await app.request('/admin/api/accounts', { headers: { 'x-api-key': apiKey } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accounts: expect.arrayContaining([expect.objectContaining({ id: 'persisted-session', hasSecret: true })]) });
    await app.dispose();
  });

  it('keeps a valid persisted empty account pool empty on restart', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir });
    new RuntimeStateStore({ path: env.runtimeStatePath }).save({ version: 1, accounts: [], runtimeApiKeys: { keys: ['runtime-key'], namedKeys: {} } });
    const app = createApp(env);
    const response = await app.request('/admin/api/accounts', { headers: { 'x-api-key': 'runtime-key' } });
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
    const response = await app.request('/admin/api/accounts', { headers: { 'x-api-key': apiKey } });
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
    const headers = { 'content-type': 'application/json', 'x-api-key': provisioned.apiKey };
    const customMapping = await initialApp.request('/admin/api/models/sonnet', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ backendModel: 'custom-second-model' }),
    });
    expect(customMapping.status).toBe(200);
    await initialApp.dispose();

    const restartedApp = createApp(env);
    const models = await restartedApp.request('/admin/api/models', { headers: { 'x-api-key': provisioned.apiKey } });
    expect(await models.json()).toMatchObject({ aliases: expect.arrayContaining([
      expect.objectContaining({ id: 'sonnet', backendModel: 'custom-second-model', status: 'bound' }),
    ]) });
    const response = await restartedApp.request('/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'after restart' }] }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { model: string }).model).toBe('sonnet');
    await restartedApp.dispose();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'chat2claude-app-state-'));
  directories.push(directory);
  return directory;
}
