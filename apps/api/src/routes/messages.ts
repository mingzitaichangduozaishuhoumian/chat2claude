import { Hono } from 'hono';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError, parseClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptResponseToClaude, mapChatGptStreamToClaudeSse, mapClaudeRequestToChatGpt, readableStreamFromAsyncIterable, type ReasoningSpeedDefaults } from '@chatgpt-to-claude/protocol-mapper';
import type { RequestLog } from '../services/request-log.js';
import { ModelRegistryError, type ModelRegistry } from '../services/model-registry.js';
import type { AccountPool, AccountProvider } from '../services/account-pool.js';
import { accountReleaseError } from './account-release-error.js';
import { mapChatGptBackendError, mapErrorPayload } from './backend-errors.js';
import { createAccountRequestTracker, trackStreamStatistics, usageFromBackend } from '../services/request-statistics.js';
import type { AdminOperationalState } from '../services/admin-operational-state.js';
import { setAccessLogMetadata } from '../middleware/access-log.js';

export interface MessagesRouteDeps { backend: ChatGptBackendClient; requestLog: RequestLog; modelRegistry: ModelRegistry; accountPool: AccountPool; operationalState?: AdminOperationalState; backendProvider?: 'mock' | 'session'; defaults?: ReasoningSpeedDefaults; ready?: Promise<unknown>; }

export function createMessagesRoute(deps: MessagesRouteDeps): Hono {
  const app = new Hono();
  app.post('/v1/messages', async (c) => {
    try {
      if (deps.ready) await deps.ready;
      const request = parseClaudeMessagesRequest(await c.req.json());
      setAccessLogMetadata(c, { model: request.model, stream: Boolean(request.stream) });
      const explicitControls = {
        reasoningEffort: request.output_config?.effort ?? request.reasoning_effort,
        serviceTier: request.service_tier ?? request.speed ?? request.response_speed,
      };
      const accountProvider = accountProviderForBackend(deps.backendProvider);
      if (deps.backendProvider === 'session' && !deps.accountPool.firstAvailable({ provider: accountProvider, capability: 'messages' })) {
        throw new ClaudeApiError(`No available ${accountProvider} account.`, 503, 'overloaded_error');
      }
      const globalResolution = deps.modelRegistry.resolve(request.model);
      const accountControls = deps.modelRegistry.accountControlRequirements(globalResolution, explicitControls);
      const account = deps.accountPool.acquire({
        provider: accountProvider,
        capability: 'messages',
        ...(deps.backendProvider === 'session' ? {
          eligible: (candidate) => deps.modelRegistry.supportsAccountRequest(
            request.model,
            { accountId: candidate.id, createdAt: candidate.createdAt },
            accountControls,
          ),
        } : {}),
      });
      if (!account) throw new ClaudeApiError(`No available ${accountProvider} account supports model ${globalResolution.backendModel} with the requested controls.`, 503, 'overloaded_error');

      const tracker = createAccountRequestTracker(deps.operationalState, account);
      const backendContext = { account };
      let releaseError: unknown;
      let releaseDeferredToStream = false;
      try {
        const resolution = deps.backendProvider === 'session'
          ? deps.modelRegistry.resolveForAccount(request.model, { accountId: account.id, createdAt: account.createdAt })
          : globalResolution;
        const controls = deps.modelRegistry.resolveControls(resolution, accountControls);
        const backendRequest = mapClaudeRequestToChatGpt(request, {}, {
          backendModel: resolution.backendModel,
          resolvedControls: controls,
        });
        deps.requestLog.record({ route: '/v1/messages', stream: Boolean(request.stream), model: request.model });

        if (request.stream) {
          const events = releaseAccountWhenDone(deps.accountPool, account.id, mapChatGptStreamToClaudeSse(request, trackStreamStatistics(deps.backend.stream(backendRequest, backendContext), tracker)), claudeStreamError);
          const stream = readableStreamFromAsyncIterable(events);
          releaseDeferredToStream = true;
          return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' } });
        }

        const backendResponse = await deps.backend.complete(backendRequest, backendContext);
        const response = mapChatGptResponseToClaude(request, backendResponse);
        tracker.finish('success', usageFromBackend(backendResponse.usage));
        return c.json(response);
      } catch (error) {
        releaseError = error;
        tracker.finish('failure');
        throw error;
      } finally {
        if (!releaseDeferredToStream) deps.accountPool.release(account.id, accountReleaseError(releaseError));
      }
    } catch (error) {
      const apiError = error instanceof ClaudeApiError ? error : mapChatGptBackendError(error) ?? (error instanceof ModelRegistryError ? new ClaudeApiError(error.message, error.status, error.status === 404 ? 'not_found_error' : 'invalid_request_error') : new ClaudeApiError(error instanceof Error ? error.message : 'Invalid request'));
      return c.json(apiError.toResponseBody(), apiError.status as 400);
    }
  });
  return app;
}

function accountProviderForBackend(backendProvider: MessagesRouteDeps['backendProvider']): AccountProvider {
  return backendProvider === 'session' ? 'chatgpt-session' : 'mock';
}

async function* releaseAccountWhenDone(accountPool: AccountPool, accountId: string, events: AsyncIterable<string>, onError: (error: unknown) => AsyncIterable<string>): AsyncIterable<string> {
  let releaseError: unknown;
  try {
    yield* events;
  } catch (error) {
    releaseError = error;
    yield* onError(error);
  } finally {
    accountPool.release(accountId, accountReleaseError(releaseError));
  }
}

async function* claudeStreamError(error: unknown): AsyncIterable<string> {
  yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: mapErrorPayload(error) })}\n\n`;
}
