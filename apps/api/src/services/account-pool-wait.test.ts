import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountPool } from './account-pool.js';
import { ChatGptBackendError } from '@chatgpt-to-claude/chatgpt-backend';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('AccountPool notification acquisition', () => {
  it('does not let same-turn newcomers steal a released slot', async () => {
    vi.useFakeTimers();
    const pool = new AccountPool();
    pool.acquire();
    const oldest = pool.acquireAsync();
    pool.release('mock-account');
    expect(pool.acquire()).toBeUndefined();
    const newcomer = pool.acquireAsync();
    expect(await oldest).toHaveProperty('account');
    expect(pool.pendingAcquisitions).toBe(1);
    pool.release('mock-account');
    expect(await newcomer).toHaveProperty('account');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips an incompatible head waiter but honors the earliest compatible waiter', async () => {
    vi.useFakeTimers();
    const pool = new AccountPool();
    pool.add({ id: 'other' });
    pool.acquire({ eligible: (a) => a.id === 'mock-account' });
    pool.acquire({ eligible: (a) => a.id === 'other' });
    const head = pool.acquireAsync({ eligible: (a) => a.id === 'mock-account' });
    const compatible = pool.acquireAsync({ eligible: (a) => a.id === 'other' });
    pool.release('other');
    expect(pool.acquire({ eligible: (a) => a.id === 'other' })).toBeUndefined();
    expect(await compatible).toMatchObject({ account: { id: 'other' } });
    pool.release('other');
    expect(pool.acquire({ eligible: (a) => a.id === 'other' })?.id).toBe('other');
    pool.release('mock-account');
    expect(await head).toHaveProperty('account');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an expired waiter before release microtasks even if its timer has not run', async () => {
    vi.useFakeTimers();
    let monotonic = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const pool = new AccountPool();
    pool.acquire();
    const pending = pool.acquireAsync({}, { timeoutMs: 10 });
    // Simulate a blocked event loop: time advances, timer callbacks do not.
    monotonic = 11;
    pool.release('mock-account');
    await Promise.resolve();
    expect(await pending).toEqual({ reason: 'account_busy_timeout' });
    expect(pool.get('mock-account')?.currentConcurrency).toBe(0);
    expect(pool.pendingAcquisitions).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('atomically reacquires released slots without exceeding concurrency', async () => {
    vi.useFakeTimers();
    const pool = new AccountPool();
    pool.acquire();
    const first = pool.acquireAsync();
    const second = pool.acquireAsync();
    expect(pool.pendingAcquisitions).toBe(2);
    pool.release('mock-account');
    expect(await first).toMatchObject({ account: { currentConcurrency: 1 } });
    expect(pool.pendingAcquisitions).toBe(1);
    expect(pool.get('mock-account')?.currentConcurrency).toBe(1);
    pool.release('mock-account');
    expect(await second).toHaveProperty('account');
    expect(pool.pendingAcquisitions).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one fixed default 30 second deadline, not a reset on notification', async () => {
    vi.useFakeTimers();
    const pool = new AccountPool();
    pool.acquire();
    const pending = pool.acquireAsync();
    await vi.advanceTimersByTimeAsync(29_000);
    pool.update('mock-account', { label: 'updated' });
    await vi.advanceTimersByTimeAsync(999);
    expect(pool.pendingAcquisitions).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ reason: 'account_busy_timeout' });
    expect(pool.pendingAcquisitions).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(pool.get('mock-account')).toMatchObject({ status: 'available', currentConcurrency: 1 });
  });

  it('supports zero timeout, custom timeout and abort without leaking listeners or timers', async () => {
    vi.useFakeTimers();
    const pool = new AccountPool();
    pool.acquire();
    expect(await pool.acquireAsync({}, { timeoutMs: 0 })).toEqual({ reason: 'account_busy' });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = pool.acquireAsync({}, { signal: controller.signal, timeoutMs: 10 });
    controller.abort('secret cancellation text');
    expect(await pending).toEqual({ reason: 'request_aborted' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(await pool.acquireAsync({}, { signal: controller.signal })).toEqual({ reason: 'request_aborted' });
    const timeout = pool.acquireAsync({}, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await timeout).toEqual({ reason: 'account_busy_timeout' });
    expect(pool.pendingAcquisitions).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['disabled', 'account_disabled'], ['unhealthy', 'account_unhealthy'],
    ['error', 'account_error'], ['cooldown', 'account_cooldown'],
  ] as const)('fails immediately for %s, including saturated accounts', async (status, reason) => {
    vi.useFakeTimers();
    const pool = new AccountPool();
    pool.update('mock-account', { status, currentConcurrency: 1 });
    expect(await pool.acquireAsync()).toEqual({ reason });
    expect(pool.pendingAcquisitions).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('classifies provider, capability and model/control mismatches without waiting', async () => {
    const pool = new AccountPool();
    pool.acquire();
    expect(await pool.acquireAsync({ provider: 'chatgpt-session' })).toEqual({ reason: 'no_account' });
    expect(await pool.acquireAsync({ capability: 'missing' })).toEqual({ reason: 'capability_unavailable' });
    expect(await pool.acquireAsync({ eligible: () => false })).toEqual({ reason: 'model_or_controls_unsupported' });
    pool.remove('mock-account');
    expect(await pool.acquireAsync()).toEqual({ reason: 'no_account' });
  });

  it('ignores spare incompatible accounts while waiting for an eligible busy account', async () => {
    const pool = new AccountPool();
    pool.acquire();
    pool.add({ id: 'other' });
    const pending = pool.acquireAsync({ eligible: (account) => account.id === 'mock-account' });
    expect(pool.pendingAcquisitions).toBe(1);
    pool.release('mock-account');
    expect(await pending).toMatchObject({ account: { id: 'mock-account' } });
  });

  it('wakes on configuration changes and stops waiting when availability becomes permanent', async () => {
    const pool = new AccountPool();
    pool.acquire();
    const enabled = pool.acquireAsync();
    pool.update('mock-account', { maxConcurrency: 2 });
    expect(await enabled).toHaveProperty('account');
    const disabled = pool.acquireAsync();
    pool.update('mock-account', { enabled: false });
    expect(await disabled).toEqual({ reason: 'account_disabled' });
    expect(pool.pendingAcquisitions).toBe(0);
  });

  it('cleans up when a dynamic eligibility predicate throws on notification', async () => {
    vi.useFakeTimers();
    const pool = new AccountPool();
    pool.acquire();
    let fail = false;
    const pending = pool.acquireAsync({ eligible: () => {
      if (fail) throw new Error('catalog changed');
      return true;
    } });
    const rejected = expect(pending).rejects.toThrow('catalog changed');
    fail = true;
    pool.release('mock-account');
    await rejected;
    expect(pool.pendingAcquisitions).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(pool.get('mock-account')?.currentConcurrency).toBe(0);
  });

  it('cleans repeated cancellations and never acquires for an aborted waiter', async () => {
    vi.useFakeTimers();
    const pool = new AccountPool();
    pool.acquire();
    for (let index = 0; index < 100; index += 1) {
      const controller = new AbortController();
      const pending = pool.acquireAsync({}, { signal: controller.signal });
      controller.abort();
      expect(await pending).toEqual({ reason: 'request_aborted' });
    }
    pool.release('mock-account');
    expect(pool.pendingAcquisitions).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(pool.get('mock-account')?.currentConcurrency).toBe(0);
  });

  it.each(['add', 'health', 'enable', 'restore', 'import', 'remove'] as const)('notifies existing waiters on %s', async (mutation) => {
    vi.useFakeTimers();
    const pool = new AccountPool();
    pool.acquire();
    if (mutation === 'health') {
      pool.add({ id: 'recovering' });
      pool.markError('recovering', new Error('unhealthy'));
    }
    if (mutation === 'enable') pool.add({ id: 'recovering', enabled: false });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = pool.acquireAsync({}, { signal: controller.signal });
    if (mutation === 'add') pool.add({ id: 'new' });
    if (mutation === 'health') pool.markHealthy('recovering');
    if (mutation === 'enable') pool.update('recovering', { enabled: true });
    if (mutation === 'restore') {
      const snapshot = pool.snapshot();
      snapshot.accounts[0].currentConcurrency = 0;
      pool.restore(snapshot);
    }
    if (mutation === 'import') pool.importState(pool.exportState());
    if (mutation === 'remove') pool.remove('mock-account');
    const result = await pending;
    if (mutation === 'remove') expect(result).toEqual({ reason: 'no_account' });
    else expect(result).toHaveProperty('account');
    expect(pool.pendingAcquisitions).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('wakes at the nearest compatible cooldown without any other pool operation', async () => {
    vi.useFakeTimers();
    const pool = new AccountPool();
    pool.acquire();
    pool.add({ id: 'cooling' });
    pool.update('cooling', { status: 'cooldown', cooldownUntil: new Date(Date.now() + 50).toISOString() });
    let result: Awaited<ReturnType<AccountPool['acquireAsync']>> | undefined;
    const pending = pool.acquireAsync().then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(50);
    expect(pool.pendingAcquisitions).toBe(0);
    expect(result).toMatchObject({ account: { id: 'cooling' } });
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('notifies pending acquisition when release reports cooldown rather than hanging', async () => {
    const pool = new AccountPool();
    pool.acquire();
    const pending = pool.acquireAsync();
    pool.release('mock-account', new ChatGptBackendError('private upstream detail', 'rate_limited'));
    expect(await pending).toEqual({ reason: 'account_cooldown' });
    expect(pool.pendingAcquisitions).toBe(0);
  });
});
