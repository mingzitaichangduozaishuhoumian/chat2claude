import { describe, expect, it } from 'vitest';
import { ChatGptBackendError } from '@chatgpt-to-claude/chatgpt-backend';
import { AccountPool } from './account-pool.js';

function fixture() {
  const pool = new AccountPool({ seedMockAccount: false, now: () => new Date(0) });
  pool.add({ id: 'session', provider: 'chatgpt-session', secret: { accessToken: 'old' } });
  return pool;
}

describe('account lease identity isolation', () => {
  for (const mode of ['commit', 'patch', 'cas'] as const) {
    it.each(['unauthorized', 'rate_limited', undefined] as const)(`releases inherited slot without applying stale %s after ${mode}`, async (code) => {
      const pool = fixture();
      const old = pool.acquire()!;
      if (mode === 'commit') pool.commitProvisionedSession({ id: old.id, secret: { accessToken: 'new', accountId: 'new-user' } }, new Date(1));
      if (mode === 'patch') pool.update(old.id, { secret: { accessToken: 'new', accountId: 'new-user' } });
      if (mode === 'cas') pool.compareAndSwapSessionSecret(old.id, { accessToken: 'old' }, { type: 'chatgpt-session', accessToken: 'new', accountId: 'new-user' });
      const before = pool.get(old.id)!;
      expect(before.incarnation).not.toBe(old.incarnation);
      expect(before.currentConcurrency).toBe(1);
      const waiter = pool.acquireAsync({}, { timeoutMs: 100 });
      pool.release(old, code ? new ChatGptBackendError('PRIVATE_CANARY', code) : undefined);
      // The only permitted state change is returning the inherited slot.
      expect(pool.get(old.id)).toMatchObject({ status: 'available', healthRevision: before.healthRevision, lastError: null, cooldownUntil: null });
      const { account: next } = await waiter;
      expect(next).toBeDefined();
      expect(pool.get(old.id)?.currentConcurrency).toBe(1);
      pool.release(old, new ChatGptBackendError('duplicate', 'unauthorized'));
      expect(pool.get(old.id)?.currentConcurrency).toBe(1);
      pool.release(next!);
      expect(pool.get(old.id)?.currentConcurrency).toBe(0);
      pool.release(next!);
      expect(pool.get(old.id)?.currentConcurrency).toBe(0);
    });
  }

  it('does not decrement a recreated account slot, even with identical timestamps', () => {
    const pool = fixture();
    const old = pool.acquire()!;
    pool.remove(old.id);
    pool.add({ id: old.id, provider: 'chatgpt-session', secret: { accessToken: 'new' } });
    const next = pool.acquire()!;
    pool.release(old, new ChatGptBackendError('old error', 'unauthorized'));
    expect(pool.get(old.id)).toMatchObject({ status: 'available', currentConcurrency: 1 });
    pool.release(next);
    expect(pool.get(old.id)?.currentConcurrency).toBe(0);
  });

  it('preserves current-incarnation authentication and cooldown classification', () => {
    const pool = fixture();
    const current = pool.acquire()!;
    pool.release(current, new ChatGptBackendError('bad credentials', 'unauthorized'));
    expect(pool.get(current.id)).toMatchObject({ status: 'unhealthy', currentConcurrency: 0 });
    pool.markHealthy(current.id);
    const next = pool.acquire()!;
    pool.release(next, new ChatGptBackendError('limited', 'rate_limited'));
    expect(pool.get(next.id)).toMatchObject({ status: 'cooldown', currentConcurrency: 0 });
  });

  it('keeps outstanding lease ownership through a transaction rollback snapshot', () => {
    const pool = fixture();
    const old = pool.acquire()!;
    const snapshot = pool.snapshot();
    pool.remove(old.id);
    pool.restore(snapshot);
    pool.release(old);
    expect(pool.get(old.id)?.currentConcurrency).toBe(0);
  });
});
