import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createAdminRoute } from './routes/admin.js';
import { AccountPool } from './services/account-pool.js';
import { DurableRuntimeState } from './services/durable-runtime-state.js';
import { ModelRegistry } from './services/model-registry.js';
import { RuntimeApiKeys } from './services/runtime-api-keys.js';
import { RuntimeStateStore, type RuntimeStateFileSystem } from './services/runtime-state-store.js';
import { ChatGptAuthFlowService } from './services/chatgpt-auth-flow.js';
import { AdminOperationalState } from './services/admin-operational-state.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function localAdminHeaders(app: { request: Hono['request'] }, contentType = false): Promise<Record<string, string>> {
  const response = await app.request('http://127.0.0.1:3000/admin', { headers: { host: '127.0.0.1:3000' } });
  const cookie = response.headers.get('set-cookie') ?? '';
  return {
    ...(contentType ? { 'content-type': 'application/json' } : {}),
    host: '127.0.0.1:3000',
    cookie,
    origin: 'http://127.0.0.1:3000',
  };
}

describe('durable administration', () => {
  it('renders simple/professional mode controls and custom alias management controls', async () => {
    const app = createApp(loadEnv({ DATA_DIR: temporaryDirectory(), NODE_ENV: 'test' }));
    const response = await app.request('/admin');
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('id="mode-simple"');
    expect(html).toContain('id="mode-professional"');
    expect(html).toContain('id="create-model-form"');
    expect(html).toContain('id="oauth-callback-url" aria-label="OAuth callback URL（请粘贴完整 callback URL）"');
    expect(html).toContain('id="result" role="status" aria-live="polite"');
    expect(html).toContain('data-delete-model=');
    await app.dispose();
  });

  it('discloses and accepts a development key when persistence commits but confirmation fails', async () => {
    const dataDir = temporaryDirectory();
    const path = join(dataDir, 'runtime-state.json');
    const env = loadEnv({ DATA_DIR: dataDir, NODE_ENV: 'test' });
    const app = createApp(env, {
      runtimeStateStore: new RuntimeStateStore({ path, fs: committedUnconfirmedFs() }),
    });

    const response = await app.request('/admin/api/api-keys/dev-enable', { method: 'POST' });
    const body = await response.json() as { ok: boolean; key: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, key: expect.any(String) });
    expect((await app.request('/v1/models', { headers: { 'x-api-key': body.key } })).status).toBe(200);
    await app.dispose();

    const restarted = createApp(env, {
      runtimeStateStore: new RuntimeStateStore({ path }),
    });
    expect((await restarted.request('/v1/models', { headers: { 'x-api-key': body.key } })).status).toBe(200);
    await restarted.dispose();
  });

  it('creates a distinct durable Runtime API Key without revoking existing keys', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir, NODE_ENV: 'test' });
    const first = createApp(env);
    const bootstrap = await first.request('/admin/api/api-keys/dev-enable', { method: 'POST' });
    const { key: existingKey } = await bootstrap.json() as { key: string };
    const adminHeaders = await localAdminHeaders(first);

    const createdResponse = await first.request('http://127.0.0.1:3000/admin/api/api-keys', {
      method: 'POST',
      headers: adminHeaders,
    });
    const created = await createdResponse.json() as { ok: boolean; apiKey: string };

    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get('cache-control')).toBe('no-store');
    expect(created).toMatchObject({ ok: true, apiKey: expect.any(String) });
    expect(created.apiKey).not.toBe(existingKey);
    expect((await first.request('/v1/models', { headers: { 'x-api-key': existingKey } })).status).toBe(200);
    expect((await first.request('/v1/models', { headers: { 'x-api-key': created.apiKey } })).status).toBe(200);
    expect(await (await first.request('http://127.0.0.1:3000/admin/api/api-keys', { headers: adminHeaders })).json()).toEqual({
      apiKeys: expect.arrayContaining([
        expect.objectContaining({ prefix: existingKey.slice(0, 12) }),
        expect.objectContaining({ prefix: created.apiKey.slice(0, 12) }),
      ]),
    });
    await first.dispose();

    const restarted = createApp(env);
    expect((await restarted.request('/v1/models', { headers: { 'x-api-key': existingKey } })).status).toBe(200);
    expect((await restarted.request('/v1/models', { headers: { 'x-api-key': created.apiKey } })).status).toBe(200);
    await restarted.dispose();
  });

  it('creates named Runtime API Keys, trims names, and rejects invalid or duplicate names', async () => {
    const dataDir = temporaryDirectory();
    const app = createApp(loadEnv({ DATA_DIR: dataDir, NODE_ENV: 'test' }));
    await app.request('/admin/api/api-keys/dev-enable', { method: 'POST' });
    const adminHeaders = await localAdminHeaders(app, true);

    const unnamedResponse = await app.request('http://127.0.0.1:3000/admin/api/api-keys', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: '   ' }) });
    const namedResponse = await app.request('http://127.0.0.1:3000/admin/api/api-keys', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: '  laptop  ' }) });
    const named = await namedResponse.json() as { apiKey: string };

    expect(unnamedResponse.status).toBe(201);
    expect(namedResponse.status).toBe(201);
    expect((await (await app.request('http://127.0.0.1:3000/admin/api/api-keys', { headers: adminHeaders })).json()) as { apiKeys: Array<{ name?: string; prefix: string }> }).toMatchObject({
      apiKeys: expect.arrayContaining([
        expect.objectContaining({ name: 'laptop', prefix: named.apiKey.slice(0, 12) }),
      ]),
    });

    const duplicateResponse = await app.request('http://127.0.0.1:3000/admin/api/api-keys', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'laptop' }) });
    const controlResponse = await app.request('http://127.0.0.1:3000/admin/api/api-keys', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'badname' }) });
    const longResponse = await app.request('http://127.0.0.1:3000/admin/api/api-keys', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'x'.repeat(65) }) });
    const typeResponse = await app.request('http://127.0.0.1:3000/admin/api/api-keys', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 42 }) });

    expect(duplicateResponse.status).toBe(400);
    expect(await duplicateResponse.json()).toEqual({ error: 'Runtime API key name already exists.' });
    expect(controlResponse.status).toBe(400);
    expect(await controlResponse.json()).toEqual({ error: 'Runtime API key name must not contain control characters.' });
    expect(longResponse.status).toBe(400);
    expect(await longResponse.json()).toEqual({ error: 'Runtime API key name must be 1-64 characters after trimming.' });
    expect(typeResponse.status).toBe(400);
    expect(await typeResponse.json()).toEqual({ error: 'Runtime API key name must be a string.' });
    await app.dispose();
  });

  it('returns an internal server error when durable Runtime API Key persistence fails after name validation', async () => {
    const dataDir = temporaryDirectory();
    const app = createApp(loadEnv({ DATA_DIR: dataDir, NODE_ENV: 'test' }), {
      runtimeStateStore: new RuntimeStateStore({ path: join(dataDir, 'runtime-state.json'), fs: failingWriteFs() }),
    });
    const adminHeaders = await localAdminHeaders(app, true);

    const response = await app.request('http://127.0.0.1:3000/admin/api/api-keys', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'server-failure' }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ type: 'error', error: { type: 'internal_server_error', message: 'Internal server error' } });
    await app.dispose();
  });

  it('reports a model mutation as successful when persistence commits but confirmation fails', async () => {
    const path = join(temporaryDirectory(), 'runtime-state.json');
    const app = createApp(loadEnv({ DATA_DIR: temporaryDirectory(), NODE_ENV: 'test' }), {
      runtimeStateStore: new RuntimeStateStore({ path, fs: committedUnconfirmedFs() }),
    });
    await app.request('/admin/api/api-keys/dev-enable', { method: 'POST' });
    const adminHeaders = await localAdminHeaders(app, true);

    const response = await app.request('http://127.0.0.1:3000/admin/api/models', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ id: 'durable-warning', backendModel: 'provider-model' }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      model: { id: 'durable-warning', backendModel: 'provider-model' },
    });
    await app.dispose();
  });

  it('lists only redacted runtime key metadata, revokes immediately, and restores anonymous bootstrap after final revoke', async () => {
    const dataDir = temporaryDirectory();
    const app = createApp(loadEnv({ DATA_DIR: dataDir, NODE_ENV: 'test' }));
    const createResponse = await app.request('/admin/api/api-keys/dev-enable', { method: 'POST' });
    const created = await createResponse.json() as { key: string };
    const adminHeaders = await localAdminHeaders(app);
    const listResponse = await app.request('http://127.0.0.1:3000/admin/api/api-keys', { headers: adminHeaders });
    const listed = await listResponse.json() as { apiKeys: Array<{ id: string; prefix: string; key?: string }> };
    expect(listResponse.status).toBe(200);
    expect(listed.apiKeys).toHaveLength(1);
    expect(listed.apiKeys[0]).not.toHaveProperty('key');
    expect(listed.apiKeys[0].prefix).toBe(created.key.slice(0, 12));

    const revokeResponse = await app.request(`http://127.0.0.1:3000/admin/api/api-keys/${listed.apiKeys[0].id}`, { method: 'DELETE', headers: adminHeaders });
    expect(revokeResponse.status).toBe(200);
    const apiResponse = await app.request('/v1/models', { headers: { 'x-api-key': created.key } });
    expect(apiResponse.status).toBe(401);
    expect((await app.request('/admin/api/api-keys/dev-enable', { method: 'POST' })).status).toBe(200);
    await app.dispose();
  });

  it('preserves ChatGPT account authorization when revoking the final durable Runtime API Key', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir, NODE_ENV: 'test', CHATGPT_BACKEND: 'session' });
    const accountPool = new AccountPool({ seedMockAccount: false });
    accountPool.add({
      id: 'session-account',
      provider: 'chatgpt-session',
      secret: { type: 'chatgpt-session', accessToken: 'persisted-access-token', accountId: 'upstream-account' },
    });
    const runtimeApiKeys = new RuntimeApiKeys();
    const apiKey = runtimeApiKeys.create('sk-runtime-', 'only-client');
    new DurableRuntimeState({ accountPool, runtimeApiKeys, modelRegistry: new ModelRegistry(), store: new RuntimeStateStore({ path: env.runtimeStatePath }) }).persist();

    const app = createApp(env, {
      backend: { listModels: vi.fn(async () => [{ id: 'provider-sonnet' }]) } as unknown as ChatGptBackendClient,
    });
    const adminHeaders = await localAdminHeaders(app);
    expect((await app.request('/v1/models', { headers: { 'x-api-key': apiKey } })).status).toBe(200);

    const beforeAuthStatus = await (await app.request('/admin/api/auth/status')).json() as { accountReady: boolean; apiKeysConfigured: boolean; ready: boolean };
    expect(beforeAuthStatus).toMatchObject({ accountReady: true, apiKeysConfigured: true });

    const [listedKey] = (await (await app.request('http://127.0.0.1:3000/admin/api/api-keys', { headers: adminHeaders })).json() as { apiKeys: Array<{ id: string; name?: string }> }).apiKeys;
    expect(listedKey).toMatchObject({ name: 'only-client' });
    expect((await app.request(`http://127.0.0.1:3000/admin/api/api-keys/${listedKey.id}`, { method: 'DELETE', headers: adminHeaders })).status).toBe(200);
    expect((await app.request('/v1/models', { headers: { 'x-api-key': apiKey } })).status).toBe(401);

    const afterAuthStatus = await (await app.request('/admin/api/auth/status')).json() as { accountReady: boolean; apiKeysConfigured: boolean; ready: boolean };
    expect(afterAuthStatus).toMatchObject({ accountReady: true, apiKeysConfigured: false, ready: false });
    const afterRevokeAccounts = new AccountPool({ seedMockAccount: false });
    const afterRevokeKeys = new RuntimeApiKeys();
    expect(new DurableRuntimeState({ accountPool: afterRevokeAccounts, runtimeApiKeys: afterRevokeKeys, store: new RuntimeStateStore({ path: env.runtimeStatePath }) }).hydrate()).toBe(true);
    expect(afterRevokeAccounts.list()).toEqual([expect.objectContaining({ id: 'session-account', provider: 'chatgpt-session', hasSecret: true })]);
    expect(afterRevokeKeys.listSafe()).toEqual([]);
    await app.dispose();

    const restarted = createApp(env, {
      backend: { listModels: vi.fn(async () => [{ id: 'provider-sonnet' }]) } as unknown as ChatGptBackendClient,
    });
    const restartedAuthStatus = await (await restarted.request('/admin/api/auth/status')).json() as { accountReady: boolean; apiKeysConfigured: boolean; ready: boolean };
    expect(restartedAuthStatus).toMatchObject({ accountReady: true, apiKeysConfigured: false, ready: false });
    expect((await restarted.request('/v1/models', { headers: { 'x-api-key': apiKey } })).status).toBe(401);
    await restarted.dispose();
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

  it('creates, persists, and deletes custom aliases while protecting built-ins', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir, NODE_ENV: 'test' });
    const first = createApp(env);
    const key = (await (await first.request('/admin/api/api-keys/dev-enable', { method: 'POST' })).json() as { key: string }).key;
    const headers = await localAdminHeaders(first, true);

    const create = await first.request('http://127.0.0.1:3000/admin/api/models', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'research', display_name: 'Research alias', backendModel: 'backend-discovered-later', enabled: false, defaults: { reasoning_effort: 'max', speed: 'quality' } }),
    });
    expect(create.status).toBe(201);
    expect(await create.json()).toMatchObject({ model: { id: 'research', builtIn: false, backendModel: 'backend-discovered-later', enabled: false, defaults: { reasoning_effort: 'max', speed: 'standard' } } });
    const duplicate = await first.request('http://127.0.0.1:3000/admin/api/models', { method: 'POST', headers, body: JSON.stringify({ id: 'research' }) });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ error: expect.stringMatching(/already exists/) });
    expect((await first.request('http://127.0.0.1:3000/admin/api/models/fable', { method: 'DELETE', headers })).status).toBe(400);
    await first.dispose();

    const restarted = createApp(env);
    const restartedHeaders = await localAdminHeaders(restarted);
    const list = await restarted.request('http://127.0.0.1:3000/admin/api/models', { headers: restartedHeaders });
    expect(await list.json()).toMatchObject({ aliases: expect.arrayContaining([
      expect.objectContaining({ id: 'fable', builtIn: true }),
      expect.objectContaining({ id: 'research', builtIn: false, backendModel: 'backend-discovered-later', enabled: false }),
    ]) });
    expect((await restarted.request('http://127.0.0.1:3000/admin/api/models/research', { method: 'DELETE', headers: restartedHeaders })).status).toBe(200);
    await restarted.dispose();

    const afterDelete = createApp(env);
    const afterDeleteHeaders = await localAdminHeaders(afterDelete);
    const afterDeleteList = await afterDelete.request('http://127.0.0.1:3000/admin/api/models', { headers: afterDeleteHeaders });
    expect((await afterDeleteList.json() as { aliases: Array<{ id: string }> }).aliases.some((model) => model.id === 'research')).toBe(false);
    await afterDelete.dispose();
  });

  it('validates the OAuth return origin against the actual request Host and Origin', async () => {
    const authFlow = new ChatGptAuthFlowService({ enableCallbackListener: false });
    const app = new Hono();
    app.route('/', createAdminRoute({ accountPool: new AccountPool(), modelRegistry: new ModelRegistry(), backend: {} as ChatGptBackendClient, runtimeApiKeys: new RuntimeApiKeys(), envApiKeys: [], defaultReasoningEffort: 'medium', defaultResponseSpeed: 'balanced', backendProvider: 'mock', authFlow }));
    const start = await app.request('http://localhost:3100/admin/api/auth/chatgpt/start', {
      method: 'POST', headers: { origin: 'http://localhost:3100', 'content-type': 'application/json' }, body: JSON.stringify({ adminOrigin: 'http://localhost:3100' }),
    });
    expect(start.status).toBe(201);
    const flow = await start.json() as { authorizeUrl: string };
    const state = new URL(flow.authorizeUrl).searchParams.get('state')!;
    const accepted = await authFlow.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=code&state=${state}` });
    expect(accepted).not.toHaveProperty('returnOrigin');

    for (const adminOrigin of ['https://localhost:3100', 'http://localhost:3100/admin', 'http://localhost:3100?next=x', 'http://user@localhost:3100', 'http://attacker.test']) {
      const response = await app.request('http://localhost:3100/admin/api/auth/chatgpt/start', {
        method: 'POST', headers: { origin: 'http://localhost:3100', 'content-type': 'application/json' }, body: JSON.stringify({ adminOrigin }),
      });
      expect(response.status).toBe(400);
    }
    await authFlow.close();
  });

  it('validates OAuth add and reauthorize targets before creating flows', async () => {
    const accountPool = new AccountPool({ seedMockAccount: false });
    accountPool.add({ id: 'session-existing', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'old', accountId: 'upstream' } });
    accountPool.add({ id: 'mock-existing', provider: 'mock' });
    const authFlow = new ChatGptAuthFlowService({ enableCallbackListener: false });
    const app = new Hono();
    app.route('/', createAdminRoute({ accountPool, modelRegistry: new ModelRegistry(), backend: {} as ChatGptBackendClient, runtimeApiKeys: new RuntimeApiKeys(), envApiKeys: [], defaultReasoningEffort: 'medium', defaultResponseSpeed: 'balanced', backendProvider: 'mock', authFlow }));

    const add = await app.request('http://localhost/admin/api/auth/chatgpt/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'add' }) });
    expect(add.status).toBe(201);
    expect(await add.json()).toMatchObject({ mode: 'add' });
    expect((await app.request('/admin/api/auth/chatgpt/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'add', accountId: 'session-existing' }) })).status).toBe(400);
    expect((await app.request('/admin/api/auth/chatgpt/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'reauthorize' }) })).status).toBe(400);
    expect((await app.request('/admin/api/auth/chatgpt/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'reauthorize', accountId: 'missing' }) })).status).toBe(404);
    expect((await app.request('/admin/api/auth/chatgpt/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'reauthorize', accountId: 'mock-existing' }) })).status).toBe(409);
    const reauthorize = await app.request('/admin/api/auth/chatgpt/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'reauthorize', accountId: 'session-existing' }) });
    expect(reauthorize.status).toBe(201);
    expect(await reauthorize.json()).toMatchObject({ mode: 'reauthorize', accountId: 'session-existing' });
    await authFlow.close();
  });

  it('contains popup-first OAuth UX, cross-tab recovery, wrapping, and explicit failure paths', async () => {
    const app = createApp(loadEnv({ DATA_DIR: temporaryDirectory(), NODE_ENV: 'test' }));
    const html = await (await app.request('/admin')).text();
    const popupIndex = html.indexOf("const popup = window.open('about:blank', '_blank');");
    const startAwaitIndex = html.indexOf("await postJson('/admin/api/auth/chatgpt/start'", popupIndex);
    expect(popupIndex).toBeGreaterThan(-1);
    expect(startAwaitIndex).toBeGreaterThan(popupIndex);
    expect(html).toContain("startOAuthFlow('add')");
    expect(html).toContain("mode: mode, accountId: accountId");
    expect(html).toContain('data-reauthorize-account=');
    expect(html).toContain('重新授权');
    expect(html).toContain('popup.location.href = body.authorizeUrl;');
    expect(html).toContain('popup.focus();');
    expect(html).toContain('if (popup) popup.close();');
    expect(html).toContain('浏览器拦截了授权窗口');
    expect(html).toContain('id="auth-link" class="pill" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("link.textContent = '打开 Codex OAuth 授权页';");
    expect(html).not.toContain('link.textContent = authorizeUrl;');
    expect(html).toContain('id="auth-url-display"');
    expect(html).toContain('overflow-wrap:anywhere');
    expect(html).toContain('word-break:break-word');
    expect(html).toContain('min-width:0;max-width:100%');
    expect(html).toContain('id="auth-message" class="muted" role="status" aria-live="polite"');
    expect(html).toContain('复制失败，请手动选中下方完整授权 URL 复制。');
    expect(html).toContain("sessionStorage.setItem(oauthFlowStorageKey, JSON.stringify({ flowId, origin: window.location.origin }))");
    expect(html).toContain("url.searchParams.get('oauth_flow')");
    expect(html).toContain("/^[A-Za-z0-9_-]{32}$/.test(flowId)");
    expect(html).toContain("history.replaceState(history.state, '', url.pathname + url.search + url.hash)");
    expect(html).toContain('saved.origin !== window.location.origin');
    expect(html).toContain('服务重启或流程过期，请重新授权。');
    expect(html).toContain('clearOAuthFlow();');
    expect(html).toContain('未认证/数据未加载');
    expect(html).toContain('账号数据加载失败，未加载。');
    expect(html).toContain('运行时 API Key 加载失败，未加载。');
    expect(html).toContain('模型数据加载失败，未加载。');
    await app.dispose();
  });

  it('projects only allowlisted ChatGPT account identity fields and redacts all credentials', async () => {
    const accountPool = new AccountPool({ seedMockAccount: false });
    accountPool.add({
      id: 'session-account',
      provider: 'chatgpt-session',
      secret: {
        type: 'chatgpt-session',
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        idToken: 'id-secret',
        cookie: 'cookie-secret',
        deviceId: 'device-secret',
        userAgent: 'agent-secret',
        email: 'owner@example.com',
        accountId: 'upstream-account',
        planType: 'plus',
        expiresAt: '2026-09-04T12:00:00.000Z',
      },
    });
    const account = accountPool.get('session-account')!;
    const operationalState = new AdminOperationalState({ path: join(temporaryDirectory(), 'operational.json'), debounceMs: 60_000 });
    operationalState.recordProvisioningSuccess(
      { accountId: account.id, createdAt: account.createdAt },
      [{ id: 'dynamic-model-from-safe-catalog', displayName: 'Dynamic model' }],
      { checkedAt: '2026-09-04T00:00:00.000Z', result: 'healthy', message: null },
    );
    const app = new Hono();
    app.route('/', createAdminRoute({ accountPool, modelRegistry: new ModelRegistry(), backend: {} as ChatGptBackendClient, runtimeApiKeys: new RuntimeApiKeys(), operationalState, envApiKeys: [], defaultReasoningEffort: 'medium', defaultResponseSpeed: 'balanced', backendProvider: 'mock' }));

    const body = await (await app.request('/admin/api/accounts')).json() as { accounts: Array<Record<string, unknown>> };
    expect(body.accounts[0]).toMatchObject({
      id: 'session-account',
      hasSecret: true,
      email: 'owner@example.com',
      upstreamAccountId: 'upstream-account',
      planType: 'plus',
      credentialExpiresAt: '2026-09-04T12:00:00.000Z',
      modelCount: 1,
      discoveredModels: [{ id: 'dynamic-model-from-safe-catalog', displayName: 'Dynamic model' }],
    });
    expect(JSON.stringify(body)).not.toMatch(/access-secret|refresh-secret|id-secret|cookie-secret|device-secret|agent-secret/);
    for (const field of ['secret', 'accessToken', 'refreshToken', 'idToken', 'cookie', 'deviceId', 'userAgent']) {
      expect(body.accounts[0]).not.toHaveProperty(field);
    }
  });

  it('restricts generic account creation to mock accounts without session secrets', async () => {
    const accountPool = new AccountPool({ seedMockAccount: false });
    const app = new Hono();
    app.route('/', createAdminRoute({ accountPool, modelRegistry: new ModelRegistry(), backend: {} as ChatGptBackendClient, runtimeApiKeys: new RuntimeApiKeys(), envApiKeys: [], defaultReasoningEffort: 'medium', defaultResponseSpeed: 'balanced', backendProvider: 'mock' }));

    const sessionResponse = await app.request('/admin/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'caller-session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'injected', accountId: 'upstream-injected' } }),
    });
    expect(sessionResponse.status).toBe(400);
    expect(await sessionResponse.json()).toEqual({ error: 'Session accounts must be added through ChatGPT authorization or manual provisioning.' });

    const disguisedSecretResponse = await app.request('/admin/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'caller-mock', provider: 'mock', secret: { type: 'chatgpt-session', accessToken: 'injected' } }),
    });
    expect(disguisedSecretResponse.status).toBe(400);
    expect(accountPool.list()).toHaveLength(0);

    const mockResponse = await app.request('/admin/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'allowed-mock', provider: 'mock', label: 'Allowed mock' }),
    });
    expect(mockResponse.status).toBe(201);
    expect(await mockResponse.json()).toMatchObject({ account: { id: 'allowed-mock', provider: 'mock', hasSecret: false } });
  });

  it('rejects repeated access-token-only manual additions without committing accounts', async () => {
    const accountPool = new AccountPool({ seedMockAccount: false });
    const app = new Hono();
    app.route('/', createAdminRoute({
      accountPool,
      modelRegistry: new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] }),
      backend: {
        async listModels() { return [{ id: 'catalog-a' }]; },
      } as ChatGptBackendClient,
      runtimeApiKeys: new RuntimeApiKeys(),
      envApiKeys: [],
      defaultReasoningEffort: 'medium',
      defaultResponseSpeed: 'balanced',
      backendProvider: 'mock',
    }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.request('/admin/api/auth/chatgpt/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'add', accessToken: 'same-access-token' }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'ChatGPT account identity metadata is required before adding this session.',
      });
    }

    expect(accountPool.list()).toEqual([]);
  });

  it('allows only label, enabled, and maxConcurrency through the account PATCH route', async () => {
    const accountPool = new AccountPool();
    const app = new Hono();
    app.route('/', createAdminRoute({ accountPool, modelRegistry: new ModelRegistry(), backend: {} as ChatGptBackendClient, runtimeApiKeys: new RuntimeApiKeys(), envApiKeys: [], defaultReasoningEffort: 'medium', defaultResponseSpeed: 'balanced', backendProvider: 'mock' }));

    const allowed = await app.request('/admin/api/accounts/mock-account', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Renamed', enabled: false, maxConcurrency: 3 }),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ account: { label: 'Renamed', enabled: false, maxConcurrency: 3, status: 'disabled' } });

    const before = accountPool.get('mock-account');
    for (const forbidden of [
      { status: 'available' },
      { currentConcurrency: 9 },
      { lastError: 'injected' },
      { secret: { type: 'chatgpt-session', accessToken: 'injected' } },
      { capabilities: ['admin'] },
      { provider: 'chatgpt-session' },
    ]) {
      const response = await app.request('/admin/api/accounts/mock-account', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'must-not-apply', ...forbidden }),
      });
      expect(response.status).toBe(400);
    }
    expect(accountPool.get('mock-account')).toEqual(before);
  });

  it('returns 409 for an active account, 404 after deletion, and persists the deletion', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'runtime-state.json');
    const accountPool = new AccountPool();
    const runtimeApiKeys = new RuntimeApiKeys();
    const durableState = new DurableRuntimeState({ accountPool, runtimeApiKeys, store: new RuntimeStateStore({ path }) });
    durableState.persist();
    const operationalState = new AdminOperationalState({ path: join(directory, 'operational.json'), debounceMs: 0 });
    const identity = { accountId: 'mock-account', createdAt: accountPool.get('mock-account')!.createdAt };
    operationalState.setDiscoveredModelIds(identity, ['model-a']);
    const app = new Hono();
    app.route('/', createAdminRoute({ accountPool, modelRegistry: new ModelRegistry(), backend: {} as ChatGptBackendClient, runtimeApiKeys, durableState, operationalState, envApiKeys: [], defaultReasoningEffort: 'medium', defaultResponseSpeed: 'balanced', backendProvider: 'mock' }));

    expect(accountPool.acquire({ provider: 'mock' })).toBeTruthy();
    expect((await app.request('/admin/api/accounts/mock-account', { method: 'DELETE' })).status).toBe(409);
    accountPool.release('mock-account');
    expect((await app.request('/admin/api/accounts/mock-account', { method: 'DELETE' })).status).toBe(200);
    expect(operationalState.snapshot().accounts).toHaveLength(0);
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

function failingWriteFs(): RuntimeStateFileSystem {
  return {
    readFileSync: nodeFs.readFileSync,
    mkdirSync: nodeFs.mkdirSync,
    chmodSync: nodeFs.chmodSync,
    openSync: nodeFs.openSync,
    writeSync() {
      const error = new Error('injected pre-commit persistence failure') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    },
    fsyncSync: nodeFs.fsyncSync,
    closeSync: nodeFs.closeSync,
    renameSync: nodeFs.renameSync,
    unlinkSync: nodeFs.unlinkSync,
  };
}

function committedUnconfirmedFs(): RuntimeStateFileSystem {
  let renamed = false;
  return {
    readFileSync: nodeFs.readFileSync,
    mkdirSync: nodeFs.mkdirSync,
    chmodSync: nodeFs.chmodSync,
    openSync: nodeFs.openSync,
    writeSync: nodeFs.writeSync,
    fsyncSync(fd) {
      if (renamed) {
        renamed = false;
        const error = new Error('injected post-rename confirmation failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      nodeFs.fsyncSync(fd);
    },
    closeSync: nodeFs.closeSync,
    renameSync(oldPath, newPath) {
      nodeFs.renameSync(oldPath, newPath);
      renamed = true;
    },
    unlinkSync: nodeFs.unlinkSync,
  };
}
