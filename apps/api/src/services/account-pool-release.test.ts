import { describe, expect, it } from 'vitest';
import { ChatGptBackendError } from '@chatgpt-to-claude/chatgpt-backend';
import { AccountPool, markAccountCredentialError } from './account-pool.js';

const canary = 'provider-message-token-cookie-cause-canary';

describe('AccountPool release health classification', () => {
  it.each(['network_error', 'timeout', 'upstream_error', 'invalid_response', 'invalid_request'] as const)('allows immediate retry after %s without retaining provider details', (code) => {
    const pool = new AccountPool();
    const account = pool.acquire()!;
    pool.release(account.id, new ChatGptBackendError(canary, code, { cause: new Error(canary) }));
    expect(pool.get(account.id)).toMatchObject({ status: 'available', currentConcurrency: 0, cooldownUntil: null,
      lastErrorCode: code === 'invalid_request' ? null : code, lastError: code === 'invalid_request' ? null : 'Account request failed.' });
    expect(JSON.stringify(pool.exportState())).not.toContain(canary);
    expect(pool.acquire()?.id).toBe(account.id);
  });

  it('clears prior transient diagnostics on invalid_request', () => {
    const pool = new AccountPool();
    pool.release('mock-account', new ChatGptBackendError(canary, 'timeout'));
    pool.release('mock-account', new ChatGptBackendError(canary, 'invalid_request'));
    expect(pool.get('mock-account')).toMatchObject({ status: 'available', lastError: null, lastErrorCode: null });
  });

  it('blocks unauthorized until health recovery', () => {
    const pool = new AccountPool();
    pool.release(pool.acquire()!.id, new ChatGptBackendError(canary, 'unauthorized'));
    expect(pool.unavailableReason()).toBe('account_unhealthy');
    expect(pool.acquire()).toBeUndefined();
    expect(JSON.stringify(pool.exportState())).not.toContain(canary);
    pool.markHealthy('mock-account');
    expect(pool.acquire()).toBeDefined();
  });

  it('retains cooldown and retries at expiry', () => {
    let now = 0;
    const pool = new AccountPool({ now: () => new Date(now), rateLimitCooldownMs: 100 });
    pool.release(pool.acquire()!.id, new ChatGptBackendError(canary, 'rate_limited'));
    expect(pool.unavailableReason()).toBe('account_cooldown');
    expect(pool.acquire()).toBeUndefined();
    now = 100;
    expect(pool.acquire()).toBeDefined();
  });

  for (const blockingCode of ['unauthorized', 'rate_limited'] as const) {
    it.each([undefined, 'invalid_request', 'timeout', 'network_error', 'upstream_error', 'invalid_response'] as const)(`does not overwrite concurrent ${blockingCode} on %s release`, (code) => {
      const pool = new AccountPool();
      pool.update('mock-account', { maxConcurrency: 2 });
      pool.acquire();
      pool.acquire();
      pool.release('mock-account', new ChatGptBackendError(canary, blockingCode));
      pool.release('mock-account', code ? new ChatGptBackendError(canary, code) : undefined);
      expect(pool.get('mock-account')).toMatchObject({ currentConcurrency: 0, status: blockingCode === 'unauthorized' ? 'unhealthy' : 'cooldown', lastErrorCode: blockingCode });
      expect(pool.acquire()).toBeUndefined();
    });
  }

  it('keeps explicit health-check error distinct and safe', () => {
    const pool = new AccountPool();
    pool.markError('mock-account', new ChatGptBackendError(canary, 'upstream_error'));
    expect(pool.unavailableReason()).toBe('account_error');
    expect(pool.get('mock-account')).toMatchObject({ status: 'error', lastError: 'Health check request failed.' });
    expect(JSON.stringify(pool.exportState())).not.toContain(canary);
  });

  it('ignores only stale owned unauthorized errors, not errors for current credentials', () => {
    const pool = new AccountPool({ seedMockAccount: false });
    pool.add({ id: 'session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'old' } });
    const old = pool.acquire()!;
    const stale = markAccountCredentialError(new ChatGptBackendError(canary, 'unauthorized'), old);
    pool.compareAndSwapSessionSecret(old.id, { accessToken: 'old' }, { type: 'chatgpt-session', accessToken: 'new' });
    pool.release(old.id, stale);
    const current = pool.acquire()!;
    expect(current).toBeDefined();
    pool.release(current.id, markAccountCredentialError(new ChatGptBackendError(canary, 'unauthorized'), current));
    expect(pool.acquire()).toBeUndefined();
    expect(pool.get(current.id)?.status).toBe('unhealthy');
  });
});
