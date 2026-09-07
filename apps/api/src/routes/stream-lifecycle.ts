import { ChatGptBackendError, sanitizeBackendDiagnostic } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import { createLogger, type Logger } from '@chatgpt-to-claude/shared';
import type { Account, AccountPool } from '../services/account-pool.js';
import { requestErrorOutcome, type AccountRequestTracker } from '../services/request-statistics.js';
import { accountReleaseError } from './account-release-error.js';
import { boundedClose } from './prepare-stream.js';

export interface RequestSizeMetrics {
  upstreamBodyBytes?: number;
  sourceMessageCount?: number;
  sourceContentBlockCount?: number;
  toolCount?: number;
  toolSchemaBytes?: number;
  upstreamInputItemCount?: number;
  replayItemCount?: number;
  replayApplied?: boolean;
}

export function sanitizeRequestMetrics(value: unknown): RequestSizeMetrics {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const safe: Record<string, number | boolean> = {};
  for (const key of ['upstreamBodyBytes', 'sourceMessageCount', 'sourceContentBlockCount', 'toolCount', 'toolSchemaBytes', 'upstreamInputItemCount', 'replayItemCount']) {
    if (typeof raw[key] === 'number' && Number.isSafeInteger(raw[key]) && raw[key] >= 0) safe[key] = raw[key];
  }
  if (typeof raw.replayApplied === 'boolean') safe.replayApplied = raw.replayApplied;
  return safe;
}

interface StreamLogContext {
  metrics?: RequestSizeMetrics;
  terminal?: (fields: Record<string, unknown>) => void;
  route: '/v1/messages' | '/v1/chat/completions' | '/v1/responses';
  requestId?: string;
  logger?: Logger;
}

const BACKEND_ERROR_CODES = new Set(['unauthorized', 'rate_limited', 'network_error', 'timeout', 'upstream_error', 'invalid_response', 'invalid_request']);

function safeErrorFields(error: unknown) {
  const code = error instanceof ChatGptBackendError && BACKEND_ERROR_CODES.has(error.code) ? error.code : 'internal_error';
  const exceptionFamily = error instanceof ChatGptBackendError ? 'ChatGptBackendError'
    : error instanceof ClaudeApiError ? 'ClaudeApiError'
    : error instanceof SyntaxError ? 'SyntaxError'
    : error instanceof TypeError ? 'TypeError'
    : error instanceof Error ? 'Error' : 'unknown';
  return { code, exceptionFamily, ...(error instanceof ChatGptBackendError ? sanitizeBackendDiagnostic(error.safeDiagnostic) : {}) };
}

export function logHttpRequestFailure(error: unknown, context: StreamLogContext, signal?: AbortSignal): void {
  const logger = context.logger ?? createLogger();
  const metadata = { route: context.route, ...(context.requestId ? { requestId: context.requestId } : {}) };
  const outcome = requestErrorOutcome(error, signal);
  if (context.terminal) {
    context.terminal({ ...sanitizeRequestMetrics(context.metrics), outcome, ...(outcome === 'failure' ? safeErrorFields(error) : {}) });
    return;
  }
  if (outcome === 'cancelled') {
    logger.info('HTTP request terminated', { ...metadata, ...sanitizeRequestMetrics(context.metrics), outcome });
  } else {
    logger.error('HTTP request terminated', { ...metadata, ...sanitizeRequestMetrics(context.metrics), outcome, ...safeErrorFields(error) });
  }
}

/** One eager owner also covers cancellation before the first body pull. */
export function releaseAccountWhenDone(accountPool: AccountPool, lease: Account, events: AsyncIterable<string>, onError: (error: unknown) => AsyncIterable<string>, tracker: AccountRequestTracker, signal: AbortSignal, context: StreamLogContext, closeUpstream?: () => Promise<void>): AsyncIterable<string> & { cancel(): Promise<void>; abandon(): void } {
  let releaseError: unknown;
  let failureFields: ReturnType<typeof safeErrorFields> | undefined;
  let outcome: 'success' | 'failure' | 'cancelled' = 'cancelled';
  let finished = false;
  let cancelling: Promise<void> | undefined;
  const logger = context.logger ?? createLogger();
  const metadata = { route: context.route, ...(context.requestId ? { requestId: context.requestId } : {}) };
  const finish = () => {
    if (finished) return;
    finished = true;
    tracker.finish(outcome);
    accountPool.release(lease, accountReleaseError(releaseError));
    const fields = { ...sanitizeRequestMetrics(context.metrics), outcome, ...failureFields };
    try {
      if (context.terminal) context.terminal(fields);
      else logger[outcome === 'failure' ? 'error' : 'info']('HTTP stream terminated', { ...metadata, ...fields });
    } catch { /* observational only; the lease is already released */ }
  };
  const iterator = (async function* () {
    try {
      yield* events;
      if (!finished) outcome = signal.aborted ? 'cancelled' : 'success';
    } catch (error) {
      if (!finished) {
        releaseError = error;
        outcome = requestErrorOutcome(error, signal);
        if (outcome === 'failure') failureFields = safeErrorFields(error);
      }
      await closeUpstream?.();
      if (!finished) yield* onError(error);
    } finally {
      await closeUpstream?.();
      finish();
    }
  })();
  return {
    [Symbol.asyncIterator]: () => iterator,
    // Response assembly failed: the HTTP catch/finally retains terminal ownership.
    abandon() { finished = true; },
    cancel() {
      return cancelling ??= (async () => {
        // Abort active I/O before requesting return; neither custom next nor
        // return is trusted to settle. Both teardown paths share the finalizer.
        await Promise.all([closeUpstream?.(), boundedClose(() => iterator.return())]);
        finish();
      })();
    },
  };
}
