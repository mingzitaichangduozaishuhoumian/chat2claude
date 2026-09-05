import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGptBackendError, type ChatGptBackendClient, type ChatGptModelDiscoveryDiagnostic, type ChatGptModelDiscoveryResult } from '@chatgpt-to-claude/chatgpt-backend';
import { AdminOperationalState } from './services/admin-operational-state.js';
import { AccountPool } from './services/account-pool.js';
import { ModelRegistry } from './services/model-registry.js';
import { RuntimeApiKeys } from './services/runtime-api-keys.js';
import { createAdminRoute } from './routes/admin.js';
import { refreshAccountModels } from './services/account-model-discovery.js';
import { SetupProvisioner } from './services/setup-provisioner.js';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';

const dirs: string[] = [];
const states: AdminOperationalState[] = [];
afterEach(async () => { for (const state of states.splice(0)) await state.dispose(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), 'discovery-lifecycle-')); dirs.push(dir); return dir; }
const diagnostic: ChatGptModelDiscoveryDiagnostic = { clientVersion: '1.2.3-rc.1+build.7', httpStatus: 200, contentType: 'json', envelope: 'models', candidateCount: 2, acceptedCount: 1, rejectedCount: 1, duplicateCount: 0, reasons: ['invalid_model_id'] };
function fixture() {
  const path = join(directory(), 'operations.json');
  const operationalState = new AdminOperationalState({ path }); states.push(operationalState);
  const accountPool = new AccountPool({ seedMockAccount: false });
  const account = accountPool.add({ id: 'synthetic-account', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'credential-do-not-disclose', accountId: 'synthetic-upstream', planType: 'pro' } });
  const identity = { accountId: account.id, createdAt: account.createdAt };
  const modelRegistry = new ModelRegistry();
  const backend: ChatGptBackendClient = { complete: async () => ({ text: '', finishReason: 'stop' }), async *stream() {}, listModels: vi.fn(async () => { throw new Error('legacy method must not run'); }), discoverModels: vi.fn(async () => ({ status: 'success' as const, models: [{ id: 'synthetic-alpha' }] })), getAccountQuota: async () => ({ planType: 'prolite', windows: [] }) };
  const runtimeApiKeys = new RuntimeApiKeys();
  const options = { accountPool, modelRegistry, backend, operationalState, runtimeApiKeys };
  const route = createAdminRoute({ ...options, envApiKeys: [], defaultReasoningEffort: 'medium', defaultResponseSpeed: 'auto', backendProvider: 'session' });
  return { ...options, account, identity, route, path };
}

describe('discovery lifecycle stages 3–5', () => {
  it('retains catalog and quota after parser failure, accepts partial and explicit empty, and isolates routing', async () => {
    const f = fixture();
    await f.route.request('/admin/api/quotas/synthetic-account/refresh', { method: 'POST' });
    const quota = f.operationalState.snapshot().accounts[0].quotaCache;
    await f.route.request('/admin/api/models/refresh', { method: 'POST' });
    await f.route.request('/admin/api/accounts/synthetic-account/health-check', { method: 'POST' });
    expect(f.operationalState.snapshot().accounts[0].quotaCache).toEqual(quota);
    expect(f.modelRegistry.supportsAccountRequest('synthetic-alpha', f.identity)).toBe(true);
    expect(f.modelRegistry.supportsAccountRequest('synthetic-alpha', { accountId: 'other-account', createdAt: f.account.createdAt })).toBe(false);
    const successAt = f.operationalState.snapshot().accounts[0].discovery.succeededAt;
    f.backend.discoverModels = async () => { throw new ChatGptBackendError('provider body secret-do-not-disclose', 'invalid_response', { discoveryDiagnostic: { ...diagnostic, envelope: 'unknown', secret: 'secret-do-not-disclose' } as ChatGptModelDiscoveryDiagnostic }); };
    const failure = await f.route.request('/admin/api/accounts/synthetic-account/health-check', { method: 'POST' });
    expect(failure.status).toBe(502);
    const body = await failure.json();
    expect(body).toMatchObject({ ok: false, modelCount: 1, discovery: { status: 'error', stale: true, succeededAt: successAt, error: 'invalid_response' }, account: { status: 'available' } });
    expect(JSON.stringify(body)).not.toContain('do-not-disclose');
    expect(f.operationalState.snapshot().accounts[0].quotaCache).toEqual(quota);
    expect(f.modelRegistry.supportsAccountRequest('synthetic-alpha', f.identity)).toBe(true);
    f.backend.discoverModels = async () => ({ status: 'partial', models: [{ id: 'synthetic-beta', raw: { token: 'do-not-disclose' } }], diagnostic });
    const partial = await (await f.route.request('/admin/api/models/refresh', { method: 'POST' })).json();
    expect(JSON.stringify(partial)).not.toContain('do-not-disclose');
    expect(partial).toMatchObject({ refreshedAccounts: [{ ok: true, modelCount: 1, discovery: { status: 'partial', diagnostic } }] });
    expect(f.modelRegistry.supportsAccountRequest('synthetic-alpha', f.identity)).toBe(false);
    expect(f.modelRegistry.supportsAccountRequest('synthetic-beta', f.identity)).toBe(true);
    f.backend.discoverModels = async () => ({ status: 'empty', models: [] });
    await f.route.request('/admin/api/models/refresh', { method: 'POST' });
    expect(f.operationalState.snapshot().accounts[0]).toMatchObject({ discovery: { status: 'empty', stale: false }, discoveredModels: [], quotaCache: quota });
    expect(f.modelRegistry.supportsAccountRequest('synthetic-beta', f.identity)).toBe(false);
    await f.operationalState.flush();
    expect(readFileSync(f.path, 'utf8')).not.toContain('do-not-disclose');
  });

  it('reports failure without a verified catalog and hydrates old empty catalogs as unknown', async () => {
    const f = fixture();
    f.backend.discoverModels = async () => { throw new Error('secret-do-not-disclose'); };
    const result = await refreshAccountModels(f, f.accountPool.get(f.account.id)!);
    expect(result).toMatchObject({ ok: false, modelCount: 0, discovery: { status: 'error', stale: false, succeededAt: null } });
    expect(result.message).toContain('尚无已验证目录');
    f.operationalState.flushSync();
    const old = JSON.parse(readFileSync(f.path, 'utf8'));
    delete old.accounts[0].discovery;
    writeFileSync(f.path, JSON.stringify(old));
    const restored = new AdminOperationalState({ path: f.path }); states.push(restored); restored.hydrate();
    expect(restored.snapshot().accounts[0].discovery).toEqual({ status: 'unknown', stale: false, attemptedAt: null, succeededAt: null });
    restored.recordDiscovery(f.identity, { status: 'partial', models: [{ id: 'synthetic-safe' }], diagnostic });
    restored.recordDiscoveryFailure(f.identity, new ChatGptBackendError('secret', 'invalid_response', { discoveryDiagnostic: diagnostic }));
    restored.flushSync();
    const roundtrip = new AdminOperationalState({ path: f.path }); states.push(roundtrip); roundtrip.hydrate();
    expect(roundtrip.snapshot().accounts[0]).toMatchObject({ discoveredModelIds: ['synthetic-safe'], discovery: { status: 'error', stale: true, diagnostic } });
    const invalid = JSON.parse(readFileSync(f.path, 'utf8')); invalid.accounts[0].discovery.diagnostic.headers = { authorization: 'secret' }; writeFileSync(f.path, JSON.stringify(invalid));
    expect(() => new AdminOperationalState({ path: f.path }).hydrate()).toThrow('unknown fields');
  });

  it('ignores late failures and legacy empty lists rather than erasing a newer catalog', async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.backend.discoverModels = () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
    const older = refreshAccountModels(f, f.accountPool.get(f.account.id)!);
    f.backend.discoverModels = async () => ({ status: 'success', models: [{ id: 'synthetic-newer' }] });
    await refreshAccountModels(f, f.accountPool.get(f.account.id)!);
    reject(new Error('late failure')); expect(await older).toMatchObject({ applied: false });
    delete f.backend.discoverModels; f.backend.listModels = async () => [];
    expect(await refreshAccountModels(f, f.accountPool.get(f.account.id)!)).toMatchObject({ discovery: { status: 'unknown' }, modelCount: 1 });
    expect(f.modelRegistry.supportsAccountRequest('synthetic-newer', f.identity)).toBe(true);
  });

  it('provisions typed partial discovery and only credential replacement invalidates quota', async () => {
    const f = fixture();
    await f.route.request('/admin/api/quotas/synthetic-account/refresh', { method: 'POST' });
    f.backend.discoverModels = async () => ({ status: 'partial', models: [{ id: 'synthetic-provisioned' }], diagnostic });
    const provisioner = new SetupProvisioner(f);
    await provisioner.provisionTarget({ mode: 'reauthorize', accountId: f.account.id }, { type: 'chatgpt-session', accessToken: 'replacement', accountId: 'synthetic-upstream' });
    expect(f.operationalState.snapshot().accounts[0]).toMatchObject({ discovery: { status: 'partial', diagnostic }, quotaCache: { status: 'unknown' } });
    expect(f.backend.listModels).not.toHaveBeenCalled();
  });

  it('presents usage plan priority in Admin DTO and preserves cached catalog/quota across startup failure', async () => {
    const dir = directory();
    const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir, CHATGPT_BACKEND: 'session', API_KEYS: 'test-admin-key' });
    let result: ChatGptModelDiscoveryResult = { status: 'success', models: [{ id: 'synthetic-startup' }] };
    let fail = false;
    const backend: ChatGptBackendClient = { complete: async () => ({ text: '', finishReason: 'stop' }), async *stream() {}, listModels: async () => { throw new Error('legacy'); }, discoverModels: async () => { if (fail) throw new ChatGptBackendError('secret body', 'invalid_response'); return result; }, getAccountQuota: async () => ({ planType: 'prolite', windows: [] }) };
    const headers = { 'x-api-key': 'test-admin-key', 'content-type': 'application/json' };
    const app = createApp(env, { backend });
    const provisioned = await app.request('/admin/api/auth/chatgpt/complete', { method: 'POST', headers, body: JSON.stringify({ accessToken: 'secret-access', accountId: 'synthetic-upstream', planType: 'pro' }) });
    expect(provisioned.status).toBe(200);
    await app.request('/admin/api/quotas/chatgpt-primary/refresh', { method: 'POST', headers });
    expect(await (await app.request('/admin/api/accounts', { headers })).json()).toMatchObject({ accounts: [{ plan: { label: 'ChatGPT Pro 5x', upstreamId: 'prolite', source: 'usage', stale: false } }] });
    await app.dispose(); fail = true;
    const restarted = createApp(env, { backend });
    await restarted.request('/admin/api/models', { headers });
    expect(await (await restarted.request('/admin/api/accounts', { headers })).json()).toMatchObject({ accounts: [{ modelCount: 1, discovery: { status: 'error', stale: true }, plan: { label: 'ChatGPT Pro 5x' } }] });
    expect(await (await restarted.request('/admin/api/quotas', { headers })).json()).toMatchObject({ quotas: [{ status: 'fresh', quota: { planType: 'prolite' } }] });
    fail = false; result = { status: 'empty', models: [] };
    await restarted.request('/admin/api/models/refresh', { method: 'POST', headers });
    await restarted.dispose();
  });
});
