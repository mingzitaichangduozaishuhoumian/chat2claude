import { setImmediate, clearImmediate } from 'node:timers';
import { ChatGptBackendError, sanitizeBackendDiagnostic, sanitizeReplayDebugDiagnostic } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import { createLogger, type Logger } from '@chatgpt-to-claude/shared';
import type { Account, AccountPool } from '../services/account-pool.js';
import { requestErrorOutcome, type AccountRequestTracker } from '../services/request-statistics.js';
import { accountReleaseError } from './account-release-error.js';
import { boundedClose } from './prepare-stream.js';

export interface RequestSizeMetrics {
  upstreamBodyBytes?: number;
  downstreamEventCount?: number;
  downstreamBodyBytes?: number;
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
  for (const key of ['upstreamBodyBytes', 'downstreamEventCount', 'downstreamBodyBytes', 'sourceMessageCount', 'sourceContentBlockCount', 'toolCount', 'toolSchemaBytes', 'upstreamInputItemCount', 'replayItemCount']) {
    if (typeof raw[key] === 'number' && Number.isSafeInteger(raw[key]) && raw[key] >= 0) safe[key] = raw[key];
  }
  if (typeof raw.replayApplied === 'boolean') safe.replayApplied = raw.replayApplied;
  return safe;
}

interface StreamLogContext {
  metrics?: RequestSizeMetrics;
  terminal?: (fields: Record<string, unknown>) => void;
  lifecycle?: (fields: Record<string, unknown> & { lifecycle: 'start' | 'active' }) => void;
  route: '/v1/messages' | '/v1/chat/completions' | '/v1/responses';
  requestId?: string;
  logger?: Logger;
}

const BACKEND_ERROR_CODES = new Set(['unauthorized', 'rate_limited', 'network_error', 'timeout', 'upstream_error', 'invalid_response', 'invalid_request']);
const ACTIVE_LIFECYCLE_INTERVAL_MS = 5_000;

function logReplaySnapshotDebug(error: unknown, logger: Logger, metadata: Record<string, unknown>): void {
  if (!(error instanceof ChatGptBackendError)) return;
  const replay = sanitizeReplayDebugDiagnostic(error.replayDebugDiagnostic);
  if (!replay) return;
  try { logger.debug('ChatGPT replay snapshot validation failed', { ...metadata, replay }); }
  catch { /* Debug logging must not replace the upstream failure. */ }
}

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
  if (outcome === 'failure') logReplaySnapshotDebug(error, logger, metadata);
  try {
    if (context.terminal) {
      context.terminal({ ...sanitizeRequestMetrics(context.metrics), outcome, ...(outcome === 'failure' ? safeErrorFields(error) : {}) });
    } else if (outcome === 'cancelled') {
      logger.info('HTTP request terminated', { ...metadata, ...sanitizeRequestMetrics(context.metrics), outcome });
    } else {
      logger.error('HTTP request terminated', { ...metadata, ...sanitizeRequestMetrics(context.metrics), outcome, ...safeErrorFields(error) });
    }
  } catch { /* Logging must never replace the original HTTP failure. */ }
}

/** One eager owner also covers cancellation before the first body pull. */
export function releaseAccountWhenDone(accountPool: AccountPool, lease: Account, events: AsyncIterable<string>, onError: (error: unknown) => AsyncIterable<string>, tracker: AccountRequestTracker, signal: AbortSignal, context: StreamLogContext, closeUpstream?: () => Promise<void>): AsyncIterable<string> & { cancel(): Promise<void>; abandon(): void } {
  let releaseError: unknown;
  let failureFields: ReturnType<typeof safeErrorFields> | undefined;
  let outcome: 'success' | 'failure' | 'cancelled' = 'cancelled';
  let finished = false;
  let downstreamEventCount = 0;
  let downstreamBodyBytes = 0;
  let lifecycleStarted = false;
  let lastActiveLifecycleAt = 0;
  let lifecycleClosed = false;
  let lifecycleHandle: ReturnType<typeof setImmediate> | undefined;
  let pendingStartLifecycle: (Record<string, unknown> & { lifecycle: 'start' }) | undefined;
  let pendingActiveLifecycle: (Record<string, unknown> & { lifecycle: 'active' }) | undefined;
  const emitPendingLifecycle = () => {
    if (lifecycleHandle) clearImmediate(lifecycleHandle);
    lifecycleHandle = undefined;
    const startFields = pendingStartLifecycle;
    const activeFields = pendingActiveLifecycle;
    pendingStartLifecycle = undefined;
    pendingActiveLifecycle = undefined;
    if (lifecycleClosed) return;
    if (startFields) {
      try { context.lifecycle?.(startFields); }
      catch { /* Logging must never affect stream delivery, backpressure, or release. */ }
    }
    if (activeFields && !lifecycleClosed) {
      try { context.lifecycle?.(activeFields); }
      catch { /* Logging must never affect stream delivery, backpressure, or release. */ }
    }
  };
  const clearLifecycle = () => {
    lifecycleClosed = true;
    pendingStartLifecycle = undefined;
    pendingActiveLifecycle = undefined;
    if (lifecycleHandle) clearImmediate(lifecycleHandle);
    lifecycleHandle = undefined;
  };
  const scheduleLifecycle = (lifecycle: 'start' | 'active') => {
    if (!context.lifecycle || lifecycleClosed) return;
    const fields = { ...sanitizeRequestMetrics(context.metrics), lifecycle, downstreamEventCount, downstreamBodyBytes };
    if (lifecycle === 'start') pendingStartLifecycle ??= fields as Record<string, unknown> & { lifecycle: 'start' };
    else pendingActiveLifecycle = fields as Record<string, unknown> & { lifecycle: 'active' };
    if (lifecycleHandle) return;
    lifecycleHandle = setImmediate(emitPendingLifecycle);
  };
  const countDownstreamEvent = (event: string) => {
    downstreamEventCount += 1;
    downstreamBodyBytes += Buffer.byteLength(event, 'utf8');
    if (!lifecycleStarted) {
      lifecycleStarted = true;
      lastActiveLifecycleAt = performance.now();
      scheduleLifecycle('start');
      return;
    }
    // Progress is accounted on every downstream event, but ACTIVE lifecycle
    // diagnostics are only a low-frequency heartbeat. This keeps detailed
    // access logs useful without producing one line per SSE event.
    const now = performance.now();
    if (now - lastActiveLifecycleAt >= ACTIVE_LIFECYCLE_INTERVAL_MS) {
      lastActiveLifecycleAt = now;
      scheduleLifecycle('active');
    }
  };
  let cancelling: Promise<void> | undefined;
  // Body cancellation is distinct from prepared.close()'s internal I/O abort.
  const bodyCancellation = new AbortController();
  const callerSignal = AbortSignal.any([signal, bodyCancellation.signal]);
  const logger = context.logger ?? createLogger();
  const metadata = { route: context.route, ...(context.requestId ? { requestId: context.requestId } : {}) };
  const finish = () => {
    if (finished) return;
    finished = true;
    // A naturally drained stream may complete before setImmediate runs. Preserve
    // the first-event observation before the terminal entry without waiting while
    // events are still being delivered; cancellation intentionally clears it.
    if (outcome !== 'cancelled') emitPendingLifecycle();
    clearLifecycle();
    try { tracker.finish(outcome); } catch { /* Statistics are observational too. */ }
    finally { accountPool.release(lease, accountReleaseError(releaseError)); }
    const fields = { ...sanitizeRequestMetrics(context.metrics), downstreamEventCount, downstreamBodyBytes, outcome, ...failureFields };
    try {
      if (context.terminal) context.terminal(fields);
      else logger[outcome === 'failure' ? 'error' : 'info']('HTTP stream terminated', { ...metadata, ...fields });
    } catch { /* observational only; the lease is already released */ }
  };
  const iterator = (async function* () {
    try {
      for await (const event of events) {
        // Count the already mapped downstream payload only; do not parse, clone, or buffer it.
        countDownstreamEvent(event);
        yield event;
      }
      if (!finished) outcome = callerSignal.aborted ? 'cancelled' : 'success';
    } catch (error) {
      if (!finished) {
        releaseError = error;
        outcome = requestErrorOutcome(error, callerSignal);
        if (outcome === 'failure') {
          failureFields = safeErrorFields(error);
          logReplaySnapshotDebug(error, logger, metadata);
        }
      }
      await closeUpstream?.();
      if (!finished) {
        for await (const event of onError(error)) {
          // Error envelopes are mapped downstream payloads too; count them exactly once.
          countDownstreamEvent(event);
          yield event;
        }
      }
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
      bodyCancellation.abort();
      return cancelling ??= (async () => {
        // Abort active I/O before requesting return; neither custom next nor
        // return is trusted to settle. Both teardown paths share the finalizer.
        await Promise.all([closeUpstream?.(), boundedClose(() => iterator.return())]);
        finish();
      })();
    },
  };
}
