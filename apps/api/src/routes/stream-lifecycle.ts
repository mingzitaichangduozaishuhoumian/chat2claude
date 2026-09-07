import { ChatGptBackendError } from '@chatgpt-to-claude/chatgpt-backend';
import { createLogger, type Logger } from '@chatgpt-to-claude/shared';
import type { AccountPool } from '../services/account-pool.js';
import { requestErrorOutcome, type AccountRequestTracker } from '../services/request-statistics.js';
import { accountReleaseError } from './account-release-error.js';

interface StreamLogContext {
  route: '/v1/messages' | '/v1/chat/completions' | '/v1/responses';
  requestId?: string;
  logger?: Logger;
}

const BACKEND_ERROR_CODES = new Set(['unauthorized', 'rate_limited', 'network_error', 'timeout', 'upstream_error', 'invalid_response', 'invalid_request']);

/** Observes the existing iterator only; never pulls or clones a response body for logging. */
export async function* releaseAccountWhenDone(accountPool: AccountPool, accountId: string, events: AsyncIterable<string>, onError: (error: unknown) => AsyncIterable<string>, tracker: AccountRequestTracker, signal: AbortSignal, context: StreamLogContext): AsyncIterable<string> {
  let releaseError: unknown;
  let outcome: 'success' | 'failure' | 'cancelled' = 'cancelled';
  const logger = context.logger ?? createLogger();
  const metadata = { route: context.route, ...(context.requestId ? { requestId: context.requestId } : {}) };
  try {
    yield* events;
    outcome = signal.aborted ? 'cancelled' : 'success';
  } catch (error) {
    releaseError = error;
    outcome = signal.aborted ? 'cancelled' : 'failure';
    tracker.finish(requestErrorOutcome(error, signal));
    // Log before yielding the error envelope: the client may stop reading it.
    if (outcome === 'failure') {
      const code = error instanceof ChatGptBackendError && BACKEND_ERROR_CODES.has(error.code) ? error.code : 'internal_error';
      logger.error('HTTP stream terminated', { ...metadata, outcome, code });
    }
    yield* onError(error);
  } finally {
    // The protocol prelude may be cancelled before the backend tracker starts.
    tracker.finish('cancelled');
    accountPool.release(accountId, accountReleaseError(releaseError));
    if (outcome !== 'failure') logger.info('HTTP stream terminated', { ...metadata, outcome });
  }
}
