import type { AccountAcquireOptions } from '../services/account-pool.js';

/** Match Session's bearer-token requirement; cookies alone cannot generate images. */
export function imageAccountAcquireOptions(backendProvider: 'mock' | 'session' | undefined): AccountAcquireOptions {
  if (backendProvider !== 'session') return { provider: 'mock' };
  return {
    provider: 'chatgpt-session',
    eligible: (account) => account.secret?.type === 'chatgpt-session'
      && typeof account.secret.accessToken === 'string' && account.secret.accessToken.trim().length > 0,
  };
}
