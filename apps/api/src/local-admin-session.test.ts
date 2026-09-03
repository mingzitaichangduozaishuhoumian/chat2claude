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

describe('local admin browser session', () => {
  it('recovers persisted-key administration without a browser key while keeping direct admin API requests protected', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir });
    persistRuntimeKey(env.runtimeStatePath, 'persisted-runtime-key');
    const app = createApp(env);

    expect((await app.request('/admin/api/accounts')).status).toBe(401);
    const admin = await app.request('/admin');
    const cookie = admin.headers.get('set-cookie');
    expect(admin.status).toBe(200);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/admin');

    const authenticated = await app.request('/admin/api/accounts', { headers: { cookie: cookie! } });
    expect(authenticated.status).toBe(200);
    expect((await app.request('/admin/api/api-keys', { headers: { cookie: cookie! } })).status).toBe(200);
    expect((await app.request('/v1/models', { headers: { cookie: cookie! } })).status).toBe(401);
    await app.dispose();
  });

  it('allows same-origin cookie mutations and rejects cross-origin mutations', async () => {
    const app = createApp(loadEnv({ DATA_DIR: temporaryDirectory() }));
    const cookie = (await app.request('/admin')).headers.get('set-cookie')!;

    const sameOrigin = await app.request('/admin/api/accounts', {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'session-account', label: 'Session Account' }),
    });
    expect(sameOrigin.status).toBe(201);

    const crossOrigin = await app.request('/admin/api/accounts', {
      method: 'POST',
      headers: { cookie, origin: 'https://example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'cross-origin-account', label: 'Cross Origin Account' }),
    });
    expect(crossOrigin.status).toBe(403);
    await app.dispose();
  });

  it('invalidates the prior browser cookie after restart and reissues a new cookie', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir });
    const firstApp = createApp(env);
    const oldCookie = (await firstApp.request('/admin')).headers.get('set-cookie')!;
    await firstApp.dispose();

    const restartedApp = createApp(env);
    expect((await restartedApp.request('/admin/api/accounts', { headers: { cookie: oldCookie } })).status).toBe(401);
    const newCookie = (await restartedApp.request('/admin')).headers.get('set-cookie')!;
    expect(newCookie).not.toBe(oldCookie);
    expect((await restartedApp.request('/admin/api/accounts', { headers: { cookie: newCookie } })).status).toBe(200);
    await restartedApp.dispose();
  });

  it('does not issue or accept browser sessions outside trusted local mode', async () => {
    const app = createApp({ ...loadEnv({ API_KEYS: 'explicit-key' }), host: '0.0.0.0', allowAnonymousBootstrap: false });
    const admin = await app.request('/admin');
    expect(admin.headers.get('set-cookie')).toBeNull();
    expect((await app.request('/admin/api/accounts')).status).toBe(401);
    expect((await app.request('/admin/api/accounts', { headers: { 'x-api-key': 'explicit-key' } })).status).toBe(200);
    await app.dispose();
  });

  it('never issues or accepts a browser session for a hostile Host, even with a matching Origin', async () => {
    const app = createApp(loadEnv({ DATA_DIR: temporaryDirectory() }));
    const trustedCookie = (await app.request('http://localhost/admin')).headers.get('set-cookie')!;

    const hostileAdmin = await app.request('http://attacker.example/admin', { headers: { host: 'attacker.example' } });
    expect(hostileAdmin.headers.get('set-cookie')).toBeNull();

    const hostileRead = await app.request('http://attacker.example/admin/api/accounts', {
      headers: { host: 'attacker.example', cookie: trustedCookie },
    });
    expect(hostileRead.status).toBe(401);

    const hostileMutation = await app.request('http://attacker.example/admin/api/accounts', {
      method: 'POST',
      headers: { host: 'attacker.example', cookie: trustedCookie, origin: 'http://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'hostile-account', label: 'Hostile Account' }),
    });
    expect(hostileMutation.status).toBe(401);
    await app.dispose();
  });

  it('limits anonymous bootstrap to trusted local request hosts, including container bootstrap mode', async () => {
    const env = { HOST: '0.0.0.0', LOCAL_CONTAINER_BOOTSTRAP: 'true', DATA_DIR: temporaryDirectory() };
    const hostileApp = createApp(loadEnv(env));
    const hostileHeaders = { host: 'attacker.example', origin: 'http://attacker.example' };
    expect((await hostileApp.request('http://attacker.example/admin/api/api-keys/dev-enable', { method: 'POST', headers: hostileHeaders })).status).toBe(401);
    expect((await hostileApp.request('http://attacker.example/admin/api/auth/chatgpt/start', { method: 'POST', headers: hostileHeaders })).status).toBe(401);
    await hostileApp.dispose();

    for (const origin of ['http://localhost:3100', 'http://127.0.0.1:3100', 'http://[::1]:3100']) {
      const app = createApp(loadEnv({ ...env, DATA_DIR: temporaryDirectory() }));
      expect((await app.request(`${origin}/admin/api/auth/chatgpt/start`, { method: 'POST' })).status).toBe(201);
      expect((await app.request(`${origin}/admin/api/api-keys/dev-enable`, { method: 'POST' })).status).toBe(200);
      await app.dispose();
    }
  });

  it('preserves explicit API-key and Bearer admin automation regardless of Host', async () => {
    const app = createApp(loadEnv({ HOST: '0.0.0.0', API_KEYS: 'explicit-key', DATA_DIR: temporaryDirectory() }));
    expect((await app.request('http://attacker.example/admin/api/accounts', { headers: { host: 'attacker.example', 'x-api-key': 'explicit-key' } })).status).toBe(200);
    expect((await app.request('http://attacker.example/admin/api/accounts', { headers: { host: 'attacker.example', authorization: 'Bearer explicit-key' } })).status).toBe(200);
    await app.dispose();
  });

  it.each([
    'http://localhost:3100',
    'http://127.0.0.1:3100',
    'http://127.0.0.2:3100',
    'http://[::1]:3100',
  ])('issues and accepts browser sessions for trusted host %s', async (origin) => {
    const app = createApp(loadEnv({ DATA_DIR: temporaryDirectory() }));
    const cookie = (await app.request(`${origin}/admin`)).headers.get('set-cookie');
    expect(cookie).toContain('HttpOnly');
    expect((await app.request(`${origin}/admin/api/accounts`, { headers: { cookie: cookie! } })).status).toBe(200);
    await app.dispose();
  });

  it('renders inline admin authentication without window.prompt', async () => {
    const app = createApp(loadEnv({ DATA_DIR: temporaryDirectory() }));
    const page = await (await app.request('/admin')).text();
    expect(page).toContain('id="admin-api-key"');
    expect(page).not.toContain('window.prompt');
    await app.dispose();
  });
});

function persistRuntimeKey(path: string, key: string): void {
  const accountPool = new AccountPool();
  const runtimeApiKeys = new RuntimeApiKeys();
  runtimeApiKeys.restore({ keys: [key], namedKeys: {} });
  new DurableRuntimeState({ accountPool, runtimeApiKeys, store: new RuntimeStateStore({ path }) }).persist();
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'chat2claude-local-admin-session-'));
  directories.push(directory);
  return directory;
}
