import { describe, expect, it, vi } from 'vitest';
import { ChatGptBackendError, MockChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { createAdminRoute } from './routes/admin.js';
import { AccountPool } from './services/account-pool.js';
import { BackendRouting } from './services/backend-routing.js';
import { ModelRegistry } from './services/model-registry.js';
import { RuntimeApiKeys } from './services/runtime-api-keys.js';
import { WebGatewayConnection } from './services/web-gateway-connection.js';
import { WEB_GATEWAY_ACCOUNT_ID } from './services/web-gateway-account.js';

const gateway = { baseUrl: 'https://gateway.invalid', apiKey: 'PRIVATE_KEY', models: ['auto'], supportsTools: false };
function fixture(fetchImpl: typeof fetch = vi.fn(async () => Response.json({ data: [] }))) {
  const backendRouting = new BackendRouting({ mode: 'codex', gateway });
  const accountPool = new AccountPool({ seedMockAccount: false });
  const modelRegistry = new ModelRegistry();
  const app = createAdminRoute({ backend: new MockChatGptBackend(), backendRouting, accountPool, modelRegistry,
    runtimeApiKeys: new RuntimeApiKeys(), envApiKeys: [], defaultReasoningEffort: 'medium', defaultResponseSpeed: 'auto', backendProvider: 'mock', gatewayFetch: fetchImpl });
  const get = async () => (await app.request('/admin/api/backend-routing')).json() as Promise<any>;
  const check = (body: unknown = {}) => app.request('/admin/api/backend-routing/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, backendRouting, accountPool, modelRegistry, get, check, fetchImpl };
}

describe('Admin non-generating gateway connection checks', () => {
  it('does not contact or enable a configured gateway when settings are read', async () => {
    const f = fixture();
    expect(await f.get()).toMatchObject({ webEnabled: false, mode: 'codex', autoPreference: 'codex', connection: { state: 'unchecked' } });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('checks saved credentials and caches the safe result without changing settings, accounts or models', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer PRIVATE_KEY');
      return Response.json({ data: [], private: 'PRIVATE_PROVIDER_CANARY' });
    });
    const f = fixture(fetchImpl);
    const before = f.backendRouting.snapshot();
    const models = f.modelRegistry.snapshot();
    const response = await f.check();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connection: { state: 'reachable', method: 'models', httpStatus: 200 } });
    expect(await f.get()).toMatchObject({ webEnabled: false, connection: { state: 'reachable' } });
    expect(f.backendRouting.snapshot()).toEqual(before);
    expect(f.accountPool.list()).toEqual([]);
    expect(f.modelRegistry.snapshot()).toEqual(models);
    expect(JSON.stringify(await f.get())).not.toMatch(/PRIVATE_KEY|PRIVATE_PROVIDER_CANARY/);
  });

  it('checks an unsaved gateway clone without saving it or confusing its result with the saved gateway', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://draft.invalid/v1/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer DRAFT_PRIVATE_KEY');
      return Response.json({ data: [] });
    });
    const f = fixture(fetchImpl);
    const before = f.backendRouting.snapshot();
    const response = await f.check({ webEnabled: true, mode: 'web', gateway: { baseUrl: 'https://draft.invalid', apiKey: 'DRAFT_PRIVATE_KEY' } });
    expect(await response.json()).toMatchObject({ connection: { state: 'reachable' } });
    expect(f.backendRouting.snapshot()).toEqual(before);
    expect(await f.get()).toMatchObject({ webEnabled: false, connection: { state: 'unchecked' }, gateway: { baseUrl: gateway.baseUrl } });
  });

  it('reports authentication failure as a safe category without enabling Web or revealing the response', async () => {
    const f = fixture(vi.fn(async () => Response.json({ message: 'PRIVATE_KEY PRIVATE_PROVIDER_CANARY' }, { status: 401 })));
    const response = await f.check();
    const body = await response.json();
    expect(body).toMatchObject({ connection: { state: 'auth_failed', httpStatus: 401 } });
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE/);
    expect(f.backendRouting.isWebEnabled()).toBe(false);
  });

  it.each(['http://localhost', 'http://127.0.0.1', 'http://[::1]'])('rejects this API as its own gateway (%s)', async (baseUrl) => {
    const f = fixture();
    const response = await f.check({ gateway: { baseUrl } });
    expect(response.status).toBe(400);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('invalidates saved checks when the credentials change', async () => {
    const f = fixture();
    await f.check();
    expect(await f.get()).toMatchObject({ connection: { state: 'reachable' } });
    f.backendRouting.update({ gateway: { apiKey: 'REPLACED_PRIVATE_KEY' } });
    expect(await f.get()).toMatchObject({ connection: { state: 'unchecked' } });
  });

  it('shows recent request failures independently of a successful HTTP connection check', async () => {
    const f = fixture();
    f.accountPool.add({ id: WEB_GATEWAY_ACCOUNT_ID, provider: 'chatgpt-web' });
    const account = f.accountPool.acquire({ provider: 'chatgpt-web' })!;
    f.accountPool.release(account, new ChatGptBackendError('PRIVATE_PROVIDER_CANARY', 'network_error'));
    await f.check();
    const view = await f.get();
    expect(view).toMatchObject({ connection: { state: 'reachable' }, lastRequestFailure: { state: 'unreachable' } });
    expect(JSON.stringify(view)).not.toContain('PRIVATE_PROVIDER_CANARY');
  });

  it('expires operational connection results rather than claiming an old check is current', async () => {
    let now = 0;
    const service = new WebGatewayConnection({ now: () => now, fetch: vi.fn(async () => Response.json({ data: [] })) });
    await service.check(gateway);
    expect(service.view(gateway).state).toBe('reachable');
    now = 60_000;
    expect(service.view(gateway).state).toBe('unchecked');
    expect(service.view(undefined).state).toBe('unconfigured');
  });
});
