import type { Context } from 'hono';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import type { AccountAcquireOptions, AccountPool, AccountUnavailableReason } from '../services/account-pool.js';
import { setAccessLogMetadata } from '../middleware/access-log.js';

function unavailable(c: Context, reason: AccountUnavailableReason, message = 'No available account supports the requested model and controls.'): never {
  setAccessLogMetadata(c, { reason });
  // Keep protocol error types/statuses stable, including in-process aborted requests.
  throw new ClaudeApiError(message, 503, 'overloaded_error');
}

/** Preserve session bootstrap's 503 before model resolution, but never reject a busy pool here. */
export function checkSessionAccountAvailability(c: Context, pool: AccountPool): void {
  const reason = pool.unavailableReason({ provider: 'chatgpt-session', capability: 'messages' });
  if (reason && reason !== 'account_busy') unavailable(c, reason, 'No available chatgpt-session account.');
}

export async function acquireRequestAccount(c: Context, pool: AccountPool, options: AccountAcquireOptions, timeoutMs?: number) {
  const result = await pool.acquireAsync(options, { timeoutMs, signal: c.req.raw.signal });
  if (!result.account) unavailable(c, result.reason);
  // Cancellation may win after synchronous acquisition but before this continuation.
  if (c.req.raw.signal.aborted) {
    pool.release(result.account);
    unavailable(c, 'request_aborted');
  }
  return result.account;
}
