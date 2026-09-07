import { mkdtempSync, rmSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountPool } from './account-pool.js';
import { CodexOAuthClient } from './codex-oauth-client.js';
import { RuntimeApiKeys } from './runtime-api-keys.js';
import { SessionCredentialManager } from './session-credential-manager.js';
import { DurableRuntimeState } from './durable-runtime-state.js';
import { RuntimeStateStore, type RuntimeStateFileSystem } from './runtime-state-store.js';

function addSession(pool: AccountPool, id: string, expiresAt = '2026-08-22T02:00:00.000Z') {
  pool.add({ id, provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accountId: `${id}-upstream`, accessToken: `${id}-access-1`, refreshToken: `${id}-refresh-1`, expiresAt, email: `${id}@example.test`, cookie: `${id}=cookie` } });
  return pool.get(id)!;
}

describe('AccountPool credential CAS', () => {
  it('updates only the currently expected token version', () => {
    const pool = new AccountPool();
    addSession(pool, 'session');
    expect(pool.compareAndSwapSessionSecret('session', { accessToken: 'wrong', refreshToken: 'session-refresh-1' }, { type: 'chatgpt-session', accessToken: 'stale' })).toBeUndefined();
    expect(pool.compareAndSwapSessionSecret('session', { accessToken: 'session-access-1', refreshToken: 'session-refresh-1' }, { type: 'chatgpt-session', accessToken: 'session-access-2', refreshToken: 'session-refresh-2' })?.secret?.accessToken).toBe('session-access-2');
    expect(pool.compareAndSwapSessionSecret('session', { accessToken: 'session-access-1', refreshToken: 'session-refresh-1' }, { type: 'chatgpt-session', accessToken: 'stale' })).toBeUndefined();
  });

  it('rejects an obsolete configuration revision even when tokens are unchanged', () => {
    const pool = new AccountPool();
    const original = addSession(pool, 'session');
    pool.update('session', { secret: { ...original.secret!, cookie: 'new=cookie' } });

    expect(pool.compareAndSwapSessionSecret(
      'session',
      { accessToken: 'session-access-1', refreshToken: 'session-refresh-1' },
      { type: 'chatgpt-session', accessToken: 'stale' },
      original.incarnation,
      undefined,
      undefined,
      original.configurationRevision,
    )).toBeUndefined();
    expect(pool.get('session')?.secret?.cookie).toBe('new=cookie');
  });

  it('does not write durable state for a credential version or configuration mismatch', () => {
    const pool = new AccountPool();
    const original = addSession(pool, 'session');
    const store = new RuntimeStateStore({ path: 'unused-runtime-state.json' });
    let writes = 0;
    store.save = () => { writes += 1; };
    const durableState = new DurableRuntimeState({ accountPool: pool, runtimeApiKeys: new RuntimeApiKeys(), store });
    expect(durableState.compareAndSwapSessionSecret('session', { accessToken: 'wrong', refreshToken: 'session-refresh-1' }, { type: 'chatgpt-session', accessToken: 'stale' })).toBeUndefined();
    pool.update('session', { secret: { ...original.secret!, cookie: 'new=cookie' } });
    expect(durableState.compareAndSwapSessionSecret(
      'session',
      { accessToken: 'session-access-1', refreshToken: 'session-refresh-1' },
      { type: 'chatgpt-session', accessToken: 'stale' },
      original.incarnation,
      undefined,
      undefined,
      original.configurationRevision,
    )).toBeUndefined();
    expect(writes).toBe(0);
  });
});

describe('RuntimeApiKeys', () => {
  it('returns one stable key for a named setup target', () => {
    const keys = new RuntimeApiKeys();
    expect(keys.getOrCreate('chatgpt-primary')).toBe(keys.getOrCreate('chatgpt-primary'));
    expect(keys.size).toBe(1);
  });
});

describe('SessionCredentialManager', () => {
  it('does not refresh a token outside the proactive skew', async () => {
    const pool = new AccountPool();
    const account = addSession(pool, 'session');
    let refreshes = 0;
    const manager = new SessionCredentialManager({ accountPool: pool, now: () => new Date('2026-08-22T00:00:00.000Z'), oauthClient: new CodexOAuthClient({ fetch: async () => { refreshes += 1; return Response.json({ access_token: 'new' }); } }) });
    expect((await manager.getFreshAccount(account)).secret?.accessToken).toBe('session-access-1');
    expect(refreshes).toBe(0);
  });

  it('proactively refreshes near expiry and writes rotated tokens to the pool', async () => {
    const pool = new AccountPool();
    const account = addSession(pool, 'session', '2026-08-22T00:00:30.000Z');
    const manager = new SessionCredentialManager({ accountPool: pool, now: () => new Date('2026-08-22T00:00:00.000Z'), oauthClient: new CodexOAuthClient({ now: () => new Date('2026-08-22T00:00:00.000Z'), fetch: async () => Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }) }) });
    const fresh = await manager.getFreshAccount(account);
    expect(fresh.secret).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', email: 'session@example.test', cookie: 'session=cookie' });
    expect(pool.get('session')?.secret?.accessToken).toBe('access-2');
  });

  it('persists rotated credentials before returning a successful refresh', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat2claude-refresh-'));
    try {
      const path = join(directory, 'runtime-state.json');
      const pool = new AccountPool();
      const account = addSession(pool, 'session', '2026-08-22T00:00:00.000Z');
      const keys = new RuntimeApiKeys();
      const store = new RuntimeStateStore({ path });
      const durableState = new DurableRuntimeState({ accountPool: pool, runtimeApiKeys: keys, store });
      durableState.persist();
      const manager = new SessionCredentialManager({
        accountPool: pool,
        durableState,
        now: () => new Date('2026-08-22T00:00:00.000Z'),
        oauthClient: new CodexOAuthClient({ fetch: async () => Response.json({ access_token: 'access-2', refresh_token: 'refresh-2' }) }),
      });

      await manager.getFreshAccount(account);
      const restoredPool = new AccountPool();
      new DurableRuntimeState({ accountPool: restoredPool, runtimeApiKeys: new RuntimeApiKeys(), store }).hydrate();
      expect(restoredPool.get('session')?.secret).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects refresh and rolls memory back when rotated credentials cannot persist', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat2claude-refresh-fail-'));
    try {
      const pool = new AccountPool();
      const account = addSession(pool, 'session', '2026-08-22T00:00:00.000Z');
      const store = new RuntimeStateStore({ path: join(directory, 'runtime-state.json') });
      const durableState = new DurableRuntimeState({ accountPool: pool, runtimeApiKeys: new RuntimeApiKeys(), store });
      durableState.persist();
      pool.acquire({ provider: 'chatgpt-session' });
      store.save = () => { throw new Error('injected disk failure'); };
      const manager = new SessionCredentialManager({
        accountPool: pool,
        durableState,
        now: () => new Date('2026-08-22T00:00:00.000Z'),
        oauthClient: new CodexOAuthClient({ fetch: async () => Response.json({ access_token: 'access-2', refresh_token: 'refresh-2' }) }),
      });

      await expect(manager.getFreshAccount(account)).rejects.toThrow('injected disk failure');
      expect(pool.get('session')).toMatchObject({ currentConcurrency: 1, secret: { accessToken: 'session-access-1', refreshToken: 'session-refresh-1' } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['chmod', 'directory fsync'] as const)('returns rotated credentials after a post-rename %s failure without exposing token data', async (failurePoint) => {
    const directory = mkdtempSync(join(tmpdir(), 'chat2claude-refresh-committed-'));
    try {
      const path = join(directory, 'runtime-state.json');
      const pool = new AccountPool();
      const account = addSession(pool, 'session', '2026-08-22T00:00:00.000Z');
      const durableState = new DurableRuntimeState({ accountPool: pool, runtimeApiKeys: new RuntimeApiKeys(), store: new RuntimeStateStore({ path }) });
      durableState.persist();
      const diagnostics: unknown[] = [];
      const manager = new SessionCredentialManager({
        accountPool: pool,
        durableState: new DurableRuntimeState({ accountPool: pool, runtimeApiKeys: new RuntimeApiKeys(), store: new RuntimeStateStore({ path, fs: postRenameFailureFs(failurePoint) }) }),
        now: () => new Date('2026-08-22T00:00:00.000Z'),
        oauthClient: new CodexOAuthClient({ fetch: async () => Response.json({ access_token: 'access-2', refresh_token: 'refresh-2' }) }),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      await expect(manager.getFreshAccount(account)).resolves.toMatchObject({ secret: { accessToken: 'access-2', refreshToken: 'refresh-2' } });
      expect(pool.get('session')?.secret).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
      expect(diagnostics).toEqual([{
        severity: 'warning',
        code: 'durability_confirmation_failed',
        message: 'ChatGPT credential rotation was committed, but filesystem durability confirmation failed.',
      }]);
      expect(JSON.stringify(diagnostics)).not.toContain('access-2');
      expect(JSON.stringify(diagnostics)).not.toContain('refresh-2');

      const restored = new AccountPool();
      new DurableRuntimeState({ accountPool: restored, runtimeApiKeys: new RuntimeApiKeys(), store: new RuntimeStateStore({ path }) }).hydrate();
      expect(restored.get('session')?.secret).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('single-flights refresh per account while allowing different accounts independently', async () => {
    const pool = new AccountPool();
    const first = addSession(pool, 'first', '2026-08-22T00:00:00.000Z');
    const second = addSession(pool, 'second', '2026-08-22T00:00:00.000Z');
    const refreshes: string[] = [];
    const client = new CodexOAuthClient({ fetch: async (_url, init) => {
      const token = (init?.body as URLSearchParams).get('refresh_token')!;
      refreshes.push(token);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ access_token: `${token}-new` });
    } });
    const manager = new SessionCredentialManager({ accountPool: pool, now: () => new Date('2026-08-22T00:00:00.000Z'), oauthClient: client });
    await Promise.all([manager.getFreshAccount(first), manager.getFreshAccount(first), manager.getFreshAccount(second)]);
    expect(refreshes.sort()).toEqual(['first-refresh-1', 'second-refresh-1']);
  });

  it('keys refresh single-flight by credential version rather than account id', async () => {
    const pool = new AccountPool();
    const first = addSession(pool, 'session', '2026-08-22T00:00:00.000Z');
    const oldRefresh = deferred<Response>();
    const newRefresh = deferred<Response>();
    const requested: string[] = [];
    const manager = new SessionCredentialManager({ accountPool: pool, now: () => new Date('2026-08-22T00:00:00.000Z'), oauthClient: new CodexOAuthClient({ fetch: async (_url, init) => {
      const token = (init?.body as URLSearchParams).get('refresh_token')!;
      requested.push(token);
      return token === 'session-refresh-1' ? oldRefresh.promise : newRefresh.promise;
    } }) });
    const firstPending = manager.getFreshAccount(first);
    await Promise.resolve();
    pool.compareAndSwapSessionSecret('session', { accessToken: 'session-access-1', refreshToken: 'session-refresh-1' }, { type: 'chatgpt-session', accountId: 'session-upstream', accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: '2026-08-22T00:00:00.000Z' });
    const secondPending = manager.getFreshAccount(pool.get('session')!);
    await Promise.resolve();
    expect(requested).toEqual(['session-refresh-1', 'refresh-2']);
    newRefresh.resolve(Response.json({ access_token: 'access-3', refresh_token: 'refresh-3' }));
    await expect(secondPending).resolves.toMatchObject({ secret: { accessToken: 'access-3' } });
    oldRefresh.resolve(Response.json({ access_token: 'stale-access' }));
    await expect(firstPending).resolves.toMatchObject({ secret: { accessToken: 'access-3' } });
  });

  it('does not overwrite newer same-token credential metadata with an in-flight refresh result', async () => {
    const pool = new AccountPool();
    const stale = addSession(pool, 'session', '2026-08-22T00:00:00.000Z');
    const refresh = deferred<Response>();
    const manager = new SessionCredentialManager({
      accountPool: pool,
      now: () => new Date('2026-08-22T00:00:00.000Z'),
      oauthClient: new CodexOAuthClient({ fetch: async () => refresh.promise }),
    });

    const pending = manager.getFreshAccount(stale);
    await Promise.resolve();
    pool.update('session', { secret: {
      type: 'chatgpt-session',
      accessToken: 'session-access-1',
      refreshToken: 'session-refresh-1',
      expiresAt: '2026-08-22T03:00:00.000Z',
      email: 'new@example.test',
      accountId: 'new-upstream-account',
      planType: 'team',
      cookie: 'new=cookie',
      deviceId: 'new-device',
      userAgent: 'new-agent',
    } });
    refresh.resolve(Response.json({ access_token: 'stale-access', refresh_token: 'stale-refresh', expires_in: 3600 }));

    // The metadata now identifies a different upstream user; do not return it to
    // the old in-flight request, even though its token strings were unchanged.
    await expect(pending).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(pool.get('session')).toMatchObject({ secret: {
      accessToken: 'session-access-1',
      refreshToken: 'session-refresh-1',
      expiresAt: '2026-08-22T03:00:00.000Z',
      email: 'new@example.test',
      accountId: 'new-upstream-account',
      planType: 'team',
      cookie: 'new=cookie',
      deviceId: 'new-device',
      userAgent: 'new-agent',
    } });
    expect(pool.get('session')?.secret).toMatchObject({ accessToken: 'session-access-1', cookie: 'new=cookie', deviceId: 'new-device' });
  });

  it('does not write a stale refresh result after delete/recreate with identical credentials', async () => {
    const pool = new AccountPool();
    const stale = addSession(pool, 'session', '2026-08-22T00:00:00.000Z');
    const refresh = deferred<Response>();
    const manager = new SessionCredentialManager({ accountPool: pool, now: () => new Date('2026-08-22T00:00:00.000Z'), oauthClient: new CodexOAuthClient({ fetch: async () => refresh.promise }) });
    const pending = manager.getFreshAccount(stale);
    await Promise.resolve();
    expect(pool.remove('session')).toBeDefined();
    const replacement = addSession(pool, 'session', '2026-08-22T00:00:00.000Z');
    expect(replacement.secret).toMatchObject({ accessToken: 'session-access-1', refreshToken: 'session-refresh-1' });
    refresh.resolve(Response.json({ access_token: 'stale-access', refresh_token: 'stale-refresh' }));

    await expect(pending).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(pool.get('session')).toMatchObject({ secret: { accessToken: 'session-access-1', refreshToken: 'session-refresh-1' } });
  });

  it('suppresses a stale refresh failure after reauthorization replaces canonical credentials', async () => {
    const pool = new AccountPool();
    const stale = addSession(pool, 'session', '2026-08-22T00:00:00.000Z');
    const refresh = deferred<Response>();
    const manager = new SessionCredentialManager({ accountPool: pool, now: () => new Date('2026-08-22T00:00:00.000Z'), oauthClient: new CodexOAuthClient({ fetch: async () => refresh.promise }) });
    const pending = manager.getFreshAccount(stale);
    await Promise.resolve();
    pool.compareAndSwapSessionSecret('session', { accessToken: 'session-access-1', refreshToken: 'session-refresh-1' }, { type: 'chatgpt-session', accountId: 'session-upstream', accessToken: 'reauthorized-access', refreshToken: 'reauthorized-refresh', expiresAt: '2026-08-22T02:00:00.000Z' });
    refresh.reject(new Error('stale refresh failed'));
    await expect(pending).resolves.toMatchObject({ secret: { accessToken: 'reauthorized-access' } });
  });

  it('uses a newer canonical token instead of refreshing again after a stale 401', async () => {
    const pool = new AccountPool();
    const stale = addSession(pool, 'session');
    pool.compareAndSwapSessionSecret('session', { accessToken: 'session-access-1', refreshToken: 'session-refresh-1' }, { type: 'chatgpt-session', accountId: 'session-upstream', accessToken: 'access-2', refreshToken: 'refresh-2' });
    let refreshes = 0;
    const manager = new SessionCredentialManager({ accountPool: pool, oauthClient: new CodexOAuthClient({ fetch: async () => { refreshes += 1; return Response.json({ access_token: 'access-3' }); } }) });
    const fresh = await manager.getFreshAccount(stale, 'session-access-1');
    expect(fresh.secret?.accessToken).toBe('access-2');
    expect(refreshes).toBe(0);
  });

  it('times out a never-resolving refresh, clears single-flight state, and permits a retry', async () => {
    const pool = new AccountPool();
    const account = addSession(pool, 'session', '2026-08-22T00:00:00.000Z');
    let requests = 0;
    const client = new CodexOAuthClient({ timeoutMs: 10, fetch: async () => {
      requests += 1;
      if (requests === 1) return new Promise<Response>(() => undefined);
      return Response.json({ access_token: 'access-2', refresh_token: 'refresh-2' });
    } });
    const manager = new SessionCredentialManager({ accountPool: pool, now: () => new Date('2026-08-22T00:00:00.000Z'), oauthClient: client });

    const first = await settleWithin(manager.getFreshAccount(account), 100);
    expect(first).toMatchObject({ status: 'rejected', reason: { code: 'timeout' } });
    const retried = await manager.getFreshAccount(account);
    expect(retried.secret).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    expect(requests).toBe(2);
  });

  it('preserves account cooldown and fallback selection for OAuth refresh HTTP 429', async () => {
    const pool = new AccountPool();
    const first = addSession(pool, 'first', '2026-08-22T00:00:00.000Z');
    addSession(pool, 'second', '2026-08-22T00:00:00.000Z');
    const manager = new SessionCredentialManager({
      accountPool: pool,
      now: () => new Date('2026-08-22T00:00:00.000Z'),
      oauthClient: new CodexOAuthClient({ fetch: async () => Response.json({ error: 'rate_limit_exceeded' }, { status: 429 }) }),
    });

    const error = await manager.getFreshAccount(first).then(() => undefined, (reason: unknown) => reason);
    pool.release(first.id, error);
    expect(pool.get(first.id)).toMatchObject({ status: 'cooldown', lastErrorCode: 'rate_limited' });
    expect(pool.firstAvailable({ provider: 'chatgpt-session' })?.id).toBe('second');
  });
});

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<PromiseSettledResult<T> | { status: 'timed_out' }> {
  return Promise.race([
    promise.then(
      (value): PromiseFulfilledResult<T> => ({ status: 'fulfilled', value }),
      (reason: unknown): PromiseRejectedResult => ({ status: 'rejected', reason }),
    ),
    new Promise<{ status: 'timed_out' }>((resolve) => setTimeout(() => resolve({ status: 'timed_out' }), timeoutMs)),
  ]);
}

function postRenameFailureFs(failurePoint: 'chmod' | 'directory fsync'): RuntimeStateFileSystem {
  let renamed = false;
  return {
    readFileSync: nodeFs.readFileSync,
    mkdirSync: nodeFs.mkdirSync,
    chmodSync(path, mode) {
      if (renamed && failurePoint === 'chmod') throw ioError();
      nodeFs.chmodSync(path, mode);
    },
    openSync: nodeFs.openSync,
    writeSync: nodeFs.writeSync,
    fsyncSync(fd) {
      if (renamed && failurePoint === 'directory fsync') throw ioError();
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

function ioError(): NodeJS.ErrnoException {
  const error = new Error('injected post-rename failure') as NodeJS.ErrnoException;
  error.code = 'EIO';
  return error;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
