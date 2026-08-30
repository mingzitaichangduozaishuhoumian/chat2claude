import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createAdminRoute } from './routes/admin.js';
import { AccountPool } from './services/account-pool.js';
import { DurableRuntimeState } from './services/durable-runtime-state.js';
import { ModelRegistry } from './services/model-registry.js';
import { RuntimeApiKeys } from './services/runtime-api-keys.js';
import { RuntimeStateStore } from './services/runtime-state-store.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('durable administration', () => {
  it('lists only redacted runtime key metadata, revokes immediately, and restores anonymous bootstrap after final revoke', async () => {
    const dataDir = temporaryDirectory();
    const app = createApp(loadEnv({ DATA_DIR: dataDir, NODE_ENV: 'test' }));
    const createResponse = await app.request('/admin/api/api-keys/dev-enable', { method: 'POST' });
    const created = await createResponse.json() as { key: string };
    const listResponse = await app.request('/admin/api/api-keys', { headers: { 'x-api-key': created.key } });
    const listed = await listResponse.json() as { apiKeys: Array<{ id: string; prefix: string; key?: string }> };
    expect(listResponse.status).toBe(200);
    expect(listed.apiKeys).toHaveLength(1);
    expect(listed.apiKeys[0]).not.toHaveProperty('key');
    expect(listed.apiKeys[0].prefix).toBe(created.key.slice(0, 12));

    const revokeResponse = await app.request(`/admin/api/api-keys/${listed.apiKeys[0].id}`, { method: 'DELETE', headers: { 'x-api-key': created.key } });
    expect(revokeResponse.status).toBe(200);
    const apiResponse = await app.request('/v1/models', { headers: { 'x-api-key': created.key } });
    expect(apiResponse.status).toBe(401);
    expect((await app.request('/admin/api/api-keys/dev-enable', { method: 'POST' })).status).toBe(200);
    await app.dispose();
  });

  it('hydrates legacy runtime-key metadata with an unprefixed SHA-256 ID and replaces a revoked named key', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'runtime-state.json');
    writeFileSync(path, JSON.stringify({ version: 1, accounts: [], runtimeApiKeys: { keys: ['legacy-key'], namedKeys: { primary: 'legacy-key' } } }));
    const keys = new RuntimeApiKeys();
    const accounts = new AccountPool();
    new DurableRuntimeState({ accountPool: accounts, runtimeApiKeys: keys, store: new RuntimeStateStore({ path }) }).hydrate();
    const [legacy] = keys.listSafe();
    expect(legacy).toMatchObject({
      id: createHash('sha256').update('legacy-key').digest('hex'),
      name: 'primary',
      prefix: 'legacy-key',
    });
    expect(legacy).not.toHaveProperty('key');
    expect(legacy.id).not.toContain('legacy-');
    expect(keys.revoke(legacy.id)).toMatchObject({ id: legacy.id });
    const replacement = keys.getOrCreate('primary');
    expect(replacement).not.toBe('legacy-key');
    expect(keys.listSafe()).toHaveLength(1);
    expect(keys.listSafe()[0].name).toBe('primary');
  });

  it('hydrates distinct legacy keys that share their first 36 bytes', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'runtime-state.json');
    const sharedStart = 'x'.repeat(36);
    const firstKey = `${sharedStart}first`;
    const secondKey = `${sharedStart}second`;
    writeFileSync(path, JSON.stringify({
      version: 1,
      accounts: [],
      runtimeApiKeys: { keys: [firstKey, secondKey], namedKeys: { first: firstKey, second: secondKey } },
    }));

    const keys = new RuntimeApiKeys();
    const accounts = new AccountPool();
    expect(new DurableRuntimeState({ accountPool: accounts, runtimeApiKeys: keys, store: new RuntimeStateStore({ path }) }).hydrate()).toBe(true);

    expect(keys.listSafe()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: createHash('sha256').update(firstKey).digest('hex'), name: 'first' }),
      expect.objectContaining({ id: createHash('sha256').update(secondKey).digest('hex'), name: 'second' }),
    ]));
    expect(keys.listSafe()).toHaveLength(2);
  });

  it('returns 409 for an active account, 404 after deletion, and persists the deletion', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'runtime-state.json');
    const accountPool = new AccountPool();
    const runtimeApiKeys = new RuntimeApiKeys();
    const durableState = new DurableRuntimeState({ accountPool, runtimeApiKeys, store: new RuntimeStateStore({ path }) });
    durableState.persist();
    const app = new Hono();
    app.route('/', createAdminRoute({ accountPool, modelRegistry: new ModelRegistry(), backend: {} as ChatGptBackendClient, runtimeApiKeys, durableState, envApiKeys: [], defaultReasoningEffort: 'medium', defaultResponseSpeed: 'balanced', backendProvider: 'mock' }));

    expect(accountPool.acquire({ provider: 'mock' })).toBeTruthy();
    expect((await app.request('/admin/api/accounts/mock-account', { method: 'DELETE' })).status).toBe(409);
    accountPool.release('mock-account');
    expect((await app.request('/admin/api/accounts/mock-account', { method: 'DELETE' })).status).toBe(200);
    expect((await app.request('/admin/api/accounts/mock-account', { method: 'DELETE' })).status).toBe(404);

    const restoredAccounts = new AccountPool();
    const restoredKeys = new RuntimeApiKeys();
    new DurableRuntimeState({ accountPool: restoredAccounts, runtimeApiKeys: restoredKeys, store: new RuntimeStateStore({ path }) }).hydrate();
    expect(restoredAccounts.get('mock-account')).toBeUndefined();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'chat2claude-admin-persistence-'));
  directories.push(directory);
  return directory;
}
