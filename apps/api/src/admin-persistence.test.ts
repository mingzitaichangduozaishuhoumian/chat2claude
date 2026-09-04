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
import { ChatGptAuthFlowService } from './services/chatgpt-auth-flow.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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

  it('creates, persists, and deletes custom aliases while protecting built-ins', async () => {
    const dataDir = temporaryDirectory();
    const env = loadEnv({ DATA_DIR: dataDir, NODE_ENV: 'test' });
    const first = createApp(env);
    const key = (await (await first.request('/admin/api/api-keys/dev-enable', { method: 'POST' })).json() as { key: string }).key;
    const headers = { 'content-type': 'application/json', 'x-api-key': key };

    const create = await first.request('/admin/api/models', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'research', display_name: 'Research alias', backendModel: 'backend-discovered-later', enabled: false, defaults: { reasoning_effort: 'max', speed: 'quality' } }),
    });
    expect(create.status).toBe(201);
    expect(await create.json()).toMatchObject({ model: { id: 'research', builtIn: false, backendModel: 'backend-discovered-later', enabled: false, defaults: { reasoning_effort: 'max', speed: 'quality' } } });
    const duplicate = await first.request('/admin/api/models', { method: 'POST', headers, body: JSON.stringify({ id: 'research' }) });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ error: expect.stringMatching(/already exists/) });
    expect((await first.request('/admin/api/models/fable', { method: 'DELETE', headers: { 'x-api-key': key } })).status).toBe(400);
    await first.dispose();

    const restarted = createApp(env);
    const list = await restarted.request('/admin/api/models', { headers: { 'x-api-key': key } });
    expect(await list.json()).toMatchObject({ aliases: expect.arrayContaining([
      expect.objectContaining({ id: 'fable', builtIn: true }),
      expect.objectContaining({ id: 'research', builtIn: false, backendModel: 'backend-discovered-later', enabled: false }),
    ]) });
    expect((await restarted.request('/admin/api/models/research', { method: 'DELETE', headers: { 'x-api-key': key } })).status).toBe(200);
    await restarted.dispose();

    const afterDelete = createApp(env);
    const afterDeleteList = await afterDelete.request('/admin/api/models', { headers: { 'x-api-key': key } });
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

  it('contains popup-first OAuth UX, cross-tab recovery, wrapping, and explicit failure paths', async () => {
    const app = createApp(loadEnv({ DATA_DIR: temporaryDirectory(), NODE_ENV: 'test' }));
    const html = await (await app.request('/admin')).text();
    const popupIndex = html.indexOf("const popup = window.open('about:blank', '_blank');");
    const startAwaitIndex = html.indexOf("await postJson('/admin/api/auth/chatgpt/start'", popupIndex);
    expect(popupIndex).toBeGreaterThan(-1);
    expect(startAwaitIndex).toBeGreaterThan(popupIndex);
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
    const app = new Hono();
    app.route('/', createAdminRoute({ accountPool, modelRegistry: new ModelRegistry(), backend: {} as ChatGptBackendClient, runtimeApiKeys: new RuntimeApiKeys(), envApiKeys: [], defaultReasoningEffort: 'medium', defaultResponseSpeed: 'balanced', backendProvider: 'mock' }));

    const body = await (await app.request('/admin/api/accounts')).json() as { accounts: Array<Record<string, unknown>> };
    expect(body.accounts[0]).toMatchObject({
      id: 'session-account',
      hasSecret: true,
      email: 'owner@example.com',
      upstreamAccountId: 'upstream-account',
      planType: 'plus',
      credentialExpiresAt: '2026-09-04T12:00:00.000Z',
    });
    expect(JSON.stringify(body)).not.toMatch(/access-secret|refresh-secret|id-secret|cookie-secret|device-secret|agent-secret/);
    for (const field of ['secret', 'accessToken', 'refreshToken', 'idToken', 'cookie', 'deviceId', 'userAgent']) {
      expect(body.accounts[0]).not.toHaveProperty(field);
    }
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
