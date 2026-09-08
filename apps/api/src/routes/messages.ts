import { boundedClose, prepareStream, type PreparedStream } from './prepare-stream.js';
import { Hono } from 'hono';
import type { Logger } from '@chatgpt-to-claude/shared';
import { logHttpRequestFailure, releaseAccountWhenDone, sanitizeRequestMetrics, type RequestSizeMetrics } from './stream-lifecycle.js';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError, parseClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptResponseToClaude, mapChatGptStreamToClaudeSse, mapClaudeRequestToChatGpt, readableStreamFromAsyncIterable, type ReasoningSpeedDefaults } from '@chatgpt-to-claude/protocol-mapper';
import type { RequestLog } from '../services/request-log.js';
import { ModelRegistryError, type ModelRegistry } from '../services/model-registry.js';
import type { AccountPool, AccountProvider } from '../services/account-pool.js';
import { accountReleaseError } from './account-release-error.js';
import { mapRequestCancellation, mapChatGptBackendError, mapErrorPayload, parseRequestJson, unexpectedApiError } from './backend-errors.js';
import { createAccountRequestTracker, requestErrorOutcome, trackStreamStatistics, usageFromBackend } from '../services/request-statistics.js';
import type { AdminOperationalState } from '../services/admin-operational-state.js';
import { getAccessLogRequestId, getAccessLogTerminal, setAccessLogMetadata } from '../middleware/access-log.js';
import { acquireRequestAccount, checkSessionAccountAvailability } from './account-acquisition.js';
import type { ReasoningReplayStore } from '../services/reasoning-replay-store.js';
import { RequestReasoningReplay } from '../services/request-reasoning-replay.js';

export interface MessagesRouteDeps { backend: ChatGptBackendClient; requestLog: RequestLog; modelRegistry: ModelRegistry; accountPool: AccountPool; operationalState?: AdminOperationalState; backendProvider?: 'mock' | 'session'; defaults?: ReasoningSpeedDefaults; ready?: Promise<unknown>; accountAcquireTimeoutMs?: number; sseKeepaliveIntervalMs?: number; logger?: Logger; reasoningReplayStore?: ReasoningReplayStore; }

export function createMessagesRoute(deps: MessagesRouteDeps): Hono {
  const app = new Hono();
  app.post('/v1/messages', async (c) => {
    const metrics: RequestSizeMetrics = {};
    try {
      if (deps.ready) await deps.ready;
      const request = parseClaudeMessagesRequest(await parseRequestJson(() => c.req.json()));
      metrics.sourceMessageCount = request.messages.length;
      metrics.sourceContentBlockCount = request.messages.reduce((sum, message) => sum + (typeof message.content === 'string' ? 1 : message.content.length), 0);
      setAccessLogMetadata(c, { model: request.model, stream: Boolean(request.stream) });
      const explicitControls = {
        reasoningEffort: request.output_config?.effort ?? request.reasoning_effort,
        serviceTier: request.service_tier ?? request.speed ?? request.response_speed,
      };
      const accountProvider = accountProviderForBackend(deps.backendProvider);
      if (deps.backendProvider === 'session') checkSessionAccountAvailability(c, deps.accountPool);
      const globalResolution = deps.modelRegistry.resolve(request.model);
      const accountControls = deps.modelRegistry.accountControlRequirements(globalResolution, explicitControls);
      const visibleRequest = mapClaudeRequestToChatGpt(request, {}, { backendModel: globalResolution.backendModel, resolvedControls: {} });
      const owner = c.get('reasoningReplayOwner');
      const replay = new RequestReasoningReplay(deps.reasoningReplayStore, {
        owner: typeof owner === 'string' ? owner : undefined, provider: accountProvider, model: globalResolution.backendModel,
      }, visibleRequest.inputItems);
      const account = await acquireRequestAccount(c, deps.accountPool, {
        provider: accountProvider,
        capability: 'messages',
        eligible: (candidate) => replay.eligible(candidate, globalResolution.backendModel)
          && (deps.backendProvider !== 'session' || deps.modelRegistry.supportsAccountRequest(
            request.model,
            { accountId: candidate.id, createdAt: candidate.createdAt },
            accountControls,
          )),
      }, deps.accountAcquireTimeoutMs);

      const tracker = createAccountRequestTracker(deps.operationalState, account);
      const streamCancellation = new AbortController();
      const backendContext = { account, signal: AbortSignal.any([c.req.raw.signal, streamCancellation.signal]), onWireMetrics: (wire: unknown) => { Object.assign(metrics, sanitizeRequestMetrics(wire)); } };
      let releaseError: unknown;
      let releaseDeferredToStream = false;
      let prepared: PreparedStream | undefined;
      let streamOwner: ReturnType<typeof releaseAccountWhenDone> | undefined;
      let responseBody: ReadableStream<Uint8Array> | undefined;
      try {
        const resolution = deps.backendProvider === 'session'
          ? deps.modelRegistry.resolveForAccount(request.model, { accountId: account.id, createdAt: account.createdAt })
          : globalResolution;
        const controls = deps.modelRegistry.resolveControls(resolution, accountControls);
        const backendRequest = mapClaudeRequestToChatGpt(request, {}, {
          backendModel: resolution.backendModel,
          resolvedControls: controls,
        });
        replay.apply(backendRequest, account, deps.accountPool);
        deps.requestLog.record({ route: '/v1/messages', stream: Boolean(request.stream), model: request.model });

        if (request.stream) {
          prepared = await prepareStream(deps.backend.stream(backendRequest, backendContext), { signal: backendContext.signal, abort: () => streamCancellation.abort() });
          const events = streamOwner = releaseAccountWhenDone(deps.accountPool, account, mapChatGptStreamToClaudeSse(request, trackStreamStatistics(replay.stream(prepared.events, account, backendRequest.model, deps.accountPool, backendContext.signal), tracker, c.req.raw.signal, true)), claudeStreamError, tracker, c.req.raw.signal, { route: '/v1/messages', requestId: getAccessLogRequestId(c), logger: deps.logger, metrics, terminal: getAccessLogTerminal(c) }, prepared.close);
          const stream = responseBody = readableStreamFromAsyncIterable(events, {
            signal: c.req.raw.signal,
            gracefulAbort: true,
            sseKeepaliveIntervalMs: deps.sseKeepaliveIntervalMs,
            onCancel: () => events.cancel(),
          });
          const response = new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' } });
          releaseDeferredToStream = true;
          return response;
        }

        const backendResponse = await deps.backend.complete(backendRequest, backendContext);
        replay.complete(backendResponse, account, backendRequest.model, deps.accountPool, backendContext.signal);
        const response = c.json(mapChatGptResponseToClaude(request, backendResponse));
        tracker.finish('success', usageFromBackend(backendResponse.usage));
        const terminal = getAccessLogTerminal(c);
        if (terminal) terminal({ ...sanitizeRequestMetrics(metrics), outcome: 'success' });
        else { try { deps.logger?.info('HTTP request statistics', sanitizeRequestMetrics(metrics)); } catch { /* observational only */ } }
        return response;
      } catch (error) {
        streamOwner?.abandon();
        releaseError = error;
        tracker.finish(requestErrorOutcome(error, c.req.raw.signal));
        if (responseBody) await boundedClose(() => responseBody!.cancel());
        throw error;
      } finally {
        if (!releaseDeferredToStream) {
          await prepared?.close();
          deps.accountPool.release(account, accountReleaseError(releaseError));
        }
      }
    } catch (error) {
      logHttpRequestFailure(error, { route: '/v1/messages', requestId: getAccessLogRequestId(c), logger: deps.logger, metrics, terminal: getAccessLogTerminal(c) }, c.req.raw.signal);
      const apiError = mapRequestCancellation(error, c.req.raw.signal) ?? (error instanceof ClaudeApiError ? error : mapChatGptBackendError(error) ?? (error instanceof ModelRegistryError ? new ClaudeApiError(error.message, error.status, error.status === 404 ? 'not_found_error' : 'invalid_request_error') : unexpectedApiError()));
      return c.json(apiError.toResponseBody(), apiError.status as 400);
    }
  });
  return app;
}

function accountProviderForBackend(backendProvider: MessagesRouteDeps['backendProvider']): AccountProvider {
  return backendProvider === 'session' ? 'chatgpt-session' : 'mock';
}

async function* claudeStreamError(error: unknown): AsyncIterable<string> {
  yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: mapErrorPayload(error) })}\n\n`;
}
