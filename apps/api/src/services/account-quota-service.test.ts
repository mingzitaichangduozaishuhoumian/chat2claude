import { describe, expect, it } from 'vitest';
import { ChatGptBackendError, SessionChatGptBackend, type ChatGptAccountQuota, type ChatGptBackendClient, type ChatGptBackendRequestContext } from '@chatgpt-to-claude/chatgpt-backend';
import { AccountPool } from './account-pool.js';
import { AdminOperationalState, type OperationalStateFileSystem } from './admin-operational-state.js';
import { AccountQuotaService } from './account-quota-service.js';
import { RefreshAwareChatGptBackend } from './refresh-aware-backend.js';
import { SessionCredentialManager } from './session-credential-manager.js';
import { CodexOAuthClient } from './codex-oauth-client.js';

const quota: ChatGptAccountQuota = {
  planType: 'plus', allowed: true, limitReached: false,
  windows: [{ position: 'primary', descriptor: 'five-hour', durationSeconds: 18_000, usedPercent: 25 }],
  additionalLimits: [], resetCredits: { availableCount: 2 },
};

function sessionPool() {
  const pool = new AccountPool({ seedMockAccount: false, now: () => new Date('2026-09-04T00:00:00.000Z') });
  pool.add({ id: 'session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: '2026-09-04T02:00:00.000Z', accountId: 'upstream-1' } });
  return pool;
}

function quotaBackend(handler: (context?: ChatGptBackendRequestContext) => Promise<ChatGptAccountQuota>): ChatGptBackendClient {
  return {
    async listModels() { return []; },
    async complete() { return { text: '', finishReason: 'stop' }; },
    async *stream() { yield { type: 'done' as const }; },
    getAccountQuota: handler,
  };
}

describe('AccountQuotaService', () => {
  it('returns unknown cache without fetching, then stores fresh explicit refresh success', async () => {
    const pool = sessionPool();
    let calls = 0;
    const service = new AccountQuotaService({ accountPool: pool, backend: quotaBackend(async () => { calls += 1; return quota; }), now: () => new Date('2026-09-04T00:00:00.000Z'), ttlMs: 300_000 });

    expect(service.getAll()).toEqual([expect.objectContaining({ accountId: 'session', supported: true, status: 'unknown' })]);
    expect(service.getAll()[0]).not.toHaveProperty('quota');
    expect(calls).toBe(0);
    await expect(service.refreshAccount('session')).resolves.toMatchObject({ status: 'fresh', quota, fetchedAt: '2026-09-04T00:00:00.000Z', expiresAt: '2026-09-04T00:05:00.000Z' });
    expect(calls).toBe(1);
    expect(service.getAll()[0]).toMatchObject({ status: 'fresh', quota });
  });

  it('preserves the previous snapshot as stale on refresh failure and reports first failure without zeros', async () => {
    const pool = sessionPool();
    let fail = false;
    const service = new AccountQuotaService({ accountPool: pool, backend: quotaBackend(async () => {
      if (fail) throw new ChatGptBackendError('raw provider detail', 'rate_limited', { status: 429 });
      return quota;
    }), now: () => new Date('2026-09-04T00:00:00.000Z') });
    await service.refreshAccount('session');
    fail = true;
    await expect(service.refreshAccount('session')).resolves.toMatchObject({
      status: 'stale', quota,
      error: { code: 'rate_limited', status: 429, category: 'rate_limit', message: 'Quota provider rate limited the request.' },
    });

    const firstFailure = new AccountQuotaService({ accountPool: sessionPool(), backend: quotaBackend(async () => { throw new Error('secret stack and payload'); }) });
    const result = await firstFailure.refreshAccount('session');
    expect(result).toMatchObject({ status: 'error', error: { code: 'unknown', category: 'unknown', message: 'Quota refresh failed.' } });
    expect(result).not.toHaveProperty('quota');
    expect(JSON.stringify(result)).not.toMatch(/secret stack|payload|remaining|usedPercent/);
  });

  it('preserves a fresh cache across same-identity OAuth token rotation', async () => {
    const pool = sessionPool();
    const service = new AccountQuotaService({ accountPool: pool, backend: quotaBackend(async () => quota) });
    await service.refreshAccount('session');
    const before = pool.get('session')!;

    expect(pool.compareAndSwapSessionSecret(
      before.id,
      { accessToken: before.secret?.accessToken, refreshToken: before.secret?.refreshToken },
      { ...before.secret!, accessToken: 'rotated-access', refreshToken: 'rotated-refresh' },
      before.incarnation,
      undefined,
      undefined,
      before.configurationRevision,
    )).toBeDefined();
    expect(service.getAll()[0]).toMatchObject({ status: 'fresh', quota });
  });

  it('deduplicates concurrent explicit refreshes for the same account credential lifecycle', async () => {
    const pool = sessionPool();
    const pending = deferred<ChatGptAccountQuota>();
    let calls = 0;
    const service = new AccountQuotaService({ accountPool: pool, backend: quotaBackend(async () => { calls += 1; return pending.promise; }) });
    const first = service.refreshAccount('session');
    const second = service.refreshAccount('session');
    await Promise.resolve();
    expect(calls).toBe(1);
    pending.resolve(quota);
    await expect(Promise.all([first, second])).resolves.toEqual([expect.objectContaining({ status: 'fresh' }), expect.objectContaining({ status: 'fresh' })]);
  });

  it('clears single-flight state after a quota body timeout so an explicit retry can proceed', async () => {
    const pool = sessionPool();
    let calls = 0;
    const backend = new SessionChatGptBackend({
      baseUrl: 'https://chatgpt.test/backend-api',
      timeoutMs: 10,
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Response(new ReadableStream({ start() {} }), { status: 200 });
        return Response.json({ rate_limit: { primary_window: { used_percent: 15 } } });
      },
    });
    const service = new AccountQuotaService({ accountPool: pool, backend });

    await expect(service.refreshAccount('session')).resolves.toMatchObject({
      status: 'error',
      error: { code: 'timeout', category: 'timeout' },
    });
    await expect(service.refreshAccount('session')).resolves.toMatchObject({
      status: 'fresh',
      quota: { windows: [{ position: 'primary', descriptor: 'primary', usedPercent: 15 }] },
    });
    expect(calls).toBe(2);
  });

  it('refresh-all returns partial success and leaves unsupported accounts explicit', async () => {
    const pool = sessionPool();
    pool.add({ id: 'session-fail', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'bad' } });
    pool.add({ id: 'mock', provider: 'mock' });
    const service = new AccountQuotaService({ accountPool: pool, backend: quotaBackend(async (context) => {
      if (context?.account?.id === 'session-fail') throw new ChatGptBackendError('no', 'unauthorized', { status: 401 });
      return quota;
    }) });

    const results = await service.refreshAll();
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'session', status: 'fresh' }),
      expect.objectContaining({ accountId: 'session-fail', status: 'error', error: expect.objectContaining({ code: 'unauthorized' }) }),
      expect.objectContaining({ accountId: 'mock', status: 'unknown', supported: false, error: expect.objectContaining({ code: 'unsupported' }) }),
    ]));
  });

  it('keeps refresh results and partial success available when operational persistence is poisoned', async () => {
    const pool = sessionPool();
    pool.add({ id: 'session-2', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'access-2' } });
    const operationalState = new AdminOperationalState({ path: 'unused-operational-state.json', debounceMs: 1, fs: failingRenameFs() });
    operationalState.setDiscoveredModelIds({ accountId: 'seed', createdAt: '2026-09-04T00:00:00.000Z' }, ['model']);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const diagnostics: unknown[] = [];
    const service = new AccountQuotaService({
      accountPool: pool,
      backend: quotaBackend(async () => quota),
      operationalState,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await expect(service.refreshAccount('session')).resolves.toMatchObject({ status: 'fresh', quota });
    await expect(service.refreshAll()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'session', status: 'fresh', quota }),
      expect.objectContaining({ accountId: 'session-2', status: 'fresh', quota }),
    ]));
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operational_persistence_unavailable', accountId: 'session' }),
      expect.objectContaining({ code: 'operational_persistence_unavailable', accountId: 'session-2' }),
    ]));
    expect(JSON.stringify(diagnostics)).not.toMatch(/access-1|access-2|stack/);
  });

  it('never mutates account scheduling health for quota 429', async () => {
    const pool = sessionPool();
    const before = pool.get('session')!;
    const service = new AccountQuotaService({ accountPool: pool, backend: quotaBackend(async () => { throw new ChatGptBackendError('limited', 'rate_limited', { status: 429 }); }) });
    await service.refreshAccount('session');
    expect(pool.get('session')).toMatchObject({ status: before.status, cooldownUntil: before.cooldownUntil, lastError: before.lastError, healthRevision: before.healthRevision });
  });

  it('rejects stale results after delete/recreate, reauthorization, or settings changes', async () => {
    for (const mutate of [
      (pool: AccountPool) => { pool.remove('session'); pool.add({ id: 'session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'access-1' } }); },
      (pool: AccountPool) => { pool.compareAndSwapSessionSecret('session', { accessToken: 'access-1', refreshToken: 'refresh-1' }, { type: 'chatgpt-session', accessToken: 'reauthorized', refreshToken: 'new' }); },
      (pool: AccountPool) => { pool.update('session', { maxConcurrency: 2 }); },
    ]) {
      const pool = sessionPool();
      const pending = deferred<ChatGptAccountQuota>();
      const service = new AccountQuotaService({ accountPool: pool, backend: quotaBackend(async () => pending.promise) });
      const refresh = service.refreshAccount('session');
      await Promise.resolve();
      mutate(pool);
      pending.resolve(quota);
      await expect(refresh).resolves.toMatchObject({ status: 'unknown', error: expect.objectContaining({ code: 'account_changed' }) });
      expect(service.getAll()[0]).not.toHaveProperty('quota');
    }
  });

  it('accepts OAuth rotation owned by the active quota operation and keeps quota generation independent from discovery', async () => {
    const pool = sessionPool();
    pool.update('session', { secret: { ...pool.get('session')!.secret, expiresAt: '2026-09-04T00:00:10.000Z' } });
    const discovery = pool.beginDiscovery(pool.get('session')!)!;
    const transport = quotaBackend(async () => quota);
    const backend = new RefreshAwareChatGptBackend(transport, new SessionCredentialManager({
      accountPool: pool,
      now: () => new Date('2026-09-04T00:00:00.000Z'),
      oauthClient: new CodexOAuthClient({ fetch: async () => Response.json({ access_token: 'rotated', refresh_token: 'rotated-refresh', expires_in: 3600 }) }),
    }));
    const service = new AccountQuotaService({ accountPool: pool, backend, now: () => new Date('2026-09-04T00:00:00.000Z') });

    await expect(service.refreshAccount('session')).resolves.toMatchObject({ status: 'fresh', quota });
    expect(pool.get('session')?.secret?.accessToken).toBe('rotated');
    expect(pool.isCurrentDiscovery(discovery)).toBe(false);
  });
});

function failingRenameFs(): OperationalStateFileSystem {
  return {
    readFileSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    mkdirSync() {},
    chmodSync() {},
    openSync() { return 1; },
    writeSync(_fd, _buffer, _offset, length) { return length; },
    fsyncSync() {},
    closeSync() {},
    renameSync() { throw Object.assign(new Error('injected persistence failure'), { code: 'EIO' }); },
    unlinkSync() {},
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
