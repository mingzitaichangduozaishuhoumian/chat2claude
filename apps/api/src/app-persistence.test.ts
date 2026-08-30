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

  it('reconstructs the sonnet binding after provision and restart', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({
      DATA_DIR: dataDir,
      CHATGPT_BACKEND: 'mock',
      MOCK_BACKEND_MODELS_JSON: JSON.stringify([{ id: 'backend-test-model', displayName: 'Backend Test Model' }]),
    });
    const initialApp = createApp(env);
    const provisionResponse = await initialApp.request('/admin/api/auth/chatgpt/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: 'persisted-access' }),
    });
    expect(provisionResponse.status).toBe(200);
    const provisioned = await provisionResponse.json() as { apiKey: string };
    await initialApp.dispose();

    const restartedApp = createApp(env);
    const response = await restartedApp.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': provisioned.apiKey },
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
