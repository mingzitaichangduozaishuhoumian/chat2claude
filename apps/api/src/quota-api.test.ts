import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatGptBackendError, type ChatGptAccountQuota, type ChatGptBackendClient, type ChatGptBackendRequestContext } from '@chatgpt-to-claude/chatgpt-backend';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { AccountPool } from './services/account-pool.js';
import { DurableRuntimeState } from './services/durable-runtime-state.js';
import { ModelRegistry } from './services/model-registry.js';
import { RuntimeApiKeys } from './services/runtime-api-keys.js';
import { RuntimeStateStore } from './services/runtime-state-store.js';

const directories: string[] = [];
const quota: ChatGptAccountQuota = { allowed: true, limitReached: false, windows: [{ position: 'primary', descriptor: 'five-hour', durationSeconds: 18_000, usedPercent: 20 }], additionalLimits: [] };

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Admin quota APIs', () => {
  it('keeps GET cache-only, requires auth, and allows API-key or local-session explicit refresh', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir, CHATGPT_BACKEND: 'session', API_KEYS: 'admin-key' });
    persistAccounts(env.runtimeStatePath, ['session']);
    let calls = 0;
    const app = createApp(env, { backend: backend(async () => { calls += 1; return quota; }) });
    await app.request('/admin/api/models', { headers: { 'x-api-key': 'admin-key' } });

    expect((await app.request('/admin/api/quotas')).status).toBe(401);
    const cached = await app.request('/admin/api/quotas', { headers: { 'x-api-key': 'admin-key' } });
    expect(cached.status).toBe(200);
    expect(await cached.json()).toMatchObject({ quotas: [expect.objectContaining({ accountId: 'session', status: 'unknown' })] });
    expect(calls).toBe(0);

    const refreshed = await app.request('/admin/api/quotas/session/refresh', { method: 'POST', headers: { 'x-api-key': 'admin-key' } });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ quota: expect.objectContaining({ accountId: 'session', status: 'fresh', quota }) });
    expect(calls).toBe(1);

    const cookie = (await app.request('/admin')).headers.get('set-cookie')!;
    const cookieRefresh = await app.request('http://localhost/admin/api/quotas/session/refresh', { method: 'POST', headers: { cookie, origin: 'http://localhost' } });
    expect(cookieRefresh.status).toBe(200);
    expect(calls).toBe(2);
    const crossOrigin = await app.request('http://localhost/admin/api/quotas/session/refresh', { method: 'POST', headers: { cookie, origin: 'https://attacker.test' } });
    expect(crossOrigin.status).toBe(403);
    await app.dispose();
  });

  it('refreshes all with partial success, reports unsupported accounts, and returns 404 for unknown account', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir, CHATGPT_BACKEND: 'session', API_KEYS: 'admin-key' });
    persistAccounts(env.runtimeStatePath, ['ok', 'fail']);
    const app = createApp(env, { backend: backend(async (context) => {
      if (context?.account?.id === 'fail') throw new ChatGptBackendError('provider secret', 'rate_limited', { status: 429 });
      return quota;
    }) });
    await app.request('/admin/api/models', { headers: { 'x-api-key': 'admin-key' } });
    await app.request('/admin/api/accounts', {
      method: 'POST',
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'mock', label: 'Unsupported mock' }),
    });

    const response = await app.request('/admin/api/quotas/refresh', { method: 'POST', headers: { 'x-api-key': 'admin-key' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ quotas: expect.arrayContaining([
      expect.objectContaining({ accountId: 'ok', status: 'fresh' }),
      expect.objectContaining({ accountId: 'fail', status: 'error', error: { code: 'rate_limited', status: 429, category: 'rate_limit', message: 'Quota provider rate limited the request.' } }),
      expect.objectContaining({ accountId: 'mock', status: 'unknown', supported: false, error: expect.objectContaining({ code: 'unsupported' }) }),
    ]), summary: { total: 3, fresh: 1, stale: 0, error: 1, unknown: 1 } });
    expect(JSON.stringify(await (await app.request('/admin/api/quotas', { headers: { 'x-api-key': 'admin-key' } })).json())).not.toContain('provider secret');
    expect((await app.request('/admin/api/quotas/missing/refresh', { method: 'POST', headers: { 'x-api-key': 'admin-key' } })).status).toBe(404);
    await app.dispose();
  });

  it('shares one upstream operation across concurrent same-account refresh requests and restores cache after restart', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir, CHATGPT_BACKEND: 'session', API_KEYS: 'admin-key' });
    persistAccounts(env.runtimeStatePath, ['session']);
    const pending = deferred<ChatGptAccountQuota>();
    let calls = 0;
    const first = createApp(env, { backend: backend(async () => { calls += 1; return pending.promise; }) });
    await first.request('/admin/api/models', { headers: { 'x-api-key': 'admin-key' } });
    const requestOne = first.request('/admin/api/quotas/session/refresh', { method: 'POST', headers: { 'x-api-key': 'admin-key' } });
    const requestTwo = first.request('/admin/api/quotas/session/refresh', { method: 'POST', headers: { 'x-api-key': 'admin-key' } });
    await Promise.resolve();
    expect(calls).toBe(1);
    pending.resolve(quota);
    expect((await requestOne).status).toBe(200);
    expect((await requestTwo).status).toBe(200);
    await first.dispose();

    const restarted = createApp(env, { backend: backend(async () => { throw new Error('must not fetch on GET'); }) });
    const cached = await restarted.request('/admin/api/quotas', { headers: { 'x-api-key': 'admin-key' } });
    const cachedBody = await cached.json();
    expect(cachedBody).toMatchObject({ quotas: [expect.objectContaining({ accountId: 'session', status: 'fresh', quota })] });
    const serialized = JSON.stringify(cachedBody);
    for (const forbidden of ['access-1', 'refresh-1', 'upstream-1', 'request_id', 'prompt', 'response', 'stack', 'raw']) expect(serialized).not.toContain(forbidden);
    await restarted.dispose();
  });
});

function backend(getAccountQuota: NonNullable<ChatGptBackendClient['getAccountQuota']>): ChatGptBackendClient {
  return {
    async listModels() { return []; },
    async complete() { return { text: '', finishReason: 'stop' }; },
    async *stream() { yield { type: 'done' as const }; },
    getAccountQuota,
  };
}

function persistAccounts(path: string, ids: string[], includeMock = false): void {
  const accounts = new AccountPool({ seedMockAccount: includeMock });
  for (const id of ids) accounts.add({ id, provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: `${id}-access-1`, refreshToken: `${id}-refresh-1`, accountId: `${id}-upstream-1` } });
  new DurableRuntimeState({ accountPool: accounts, runtimeApiKeys: new RuntimeApiKeys(), modelRegistry: new ModelRegistry(), store: new RuntimeStateStore({ path }) }).persist();
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'chat2claude-quota-api-'));
  directories.push(directory);
  return directory;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
