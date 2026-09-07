import type { ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
import type { Account } from './account-pool.js';
import type { AdminOperationalState, OperationalAccountIdentity } from './admin-operational-state.js';

export type RequestOutcome = 'success' | 'failure' | 'cancelled';

export interface RequestUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
}

/**
 * Tracks one already-acquired account request. Every terminal path must call
 * finish; duplicate calls are deliberately ignored.
 */
export interface AccountRequestTracker {
  finish(outcome: RequestOutcome, usage?: RequestUsage): void;
}

export function createAccountRequestTracker(
  operationalState: AdminOperationalState | undefined,
  account: Pick<Account, 'id' | 'createdAt'> | OperationalAccountIdentity,
): AccountRequestTracker {
  const identity: OperationalAccountIdentity = 'accountId' in account
    ? account
    : { accountId: account.id, createdAt: account.createdAt };
  let finished = false;

  // Operational persistence is deliberately best effort: it must never alter
  // a provider response, health result, cooldown, or account release.
  try { operationalState?.recordRequestStarted(identity); } catch { /* isolated */ }

  return {
    finish(outcome, usage = {}) {
      if (finished) return;
      finished = true;
      const inputTokens = validTokenCount(usage.inputTokens);
      const outputTokens = validTokenCount(usage.outputTokens);
      try {
        operationalState?.recordRequestFinished(identity, {
          outcome,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        });
      } catch { /* isolated */ }
    },
  };
}

export function usageFromBackend(value: { inputTokens?: unknown; outputTokens?: unknown } | undefined): RequestUsage {
  const inputTokens = validTokenCount(value?.inputTokens);
  const outputTokens = validTokenCount(value?.outputTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

export function requestErrorOutcome(error: unknown, signal?: AbortSignal): RequestOutcome {
  // An upstream AbortError alone is not evidence of a client cancellation.
  return signal?.aborted && error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failure';
}

export async function* trackStreamStatistics(events: AsyncIterable<ChatGptStreamEvent>, tracker: AccountRequestTracker, signal?: AbortSignal): AsyncIterable<ChatGptStreamEvent> {
  let completed = false;
  let usage: RequestUsage | undefined;
  try {
    for await (const event of events) {
      if (event.type === 'done') usage = usageFromBackend(event.usage);
      yield event;
    }
    completed = true;
  } catch (error) {
    tracker.finish(requestErrorOutcome(error, signal), usage);
    throw error;
  } finally {
    if (completed) tracker.finish('success', usage);
    else tracker.finish('cancelled', usage);
  }
}

function validTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
}
