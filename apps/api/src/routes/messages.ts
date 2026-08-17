import { Hono } from 'hono';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError, parseClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptResponseToClaude, mapChatGptStreamToClaudeSse, mapClaudeRequestToChatGpt, readableStreamFromAsyncIterable, type ReasoningSpeedDefaults } from '@chatgpt-to-claude/protocol-mapper';
import type { RequestLog } from '../services/request-log.js';
import { ModelRegistryError, type ModelRegistry } from '../services/model-registry.js';
import type { AccountPool, AccountProvider } from '../services/account-pool.js';
import { mapChatGptBackendError, mapErrorPayload } from './backend-errors.js';

export interface MessagesRouteDeps { backend: ChatGptBackendClient; requestLog: RequestLog; modelRegistry: ModelRegistry; accountPool: AccountPool; backendProvider?: 'mock' | 'session'; defaults?: ReasoningSpeedDefaults; ready?: Promise<unknown>; }

export function createMessagesRoute(deps: MessagesRouteDeps): Hono {
  const app = new Hono();
  app.post('/v1/messages', async (c) => {
    try {
      if (deps.ready) await deps.ready;
      const request = parseClaudeMessagesRequest(await c.req.json());
      const accountProvider = accountProviderForBackend(deps.backendProvider);
      const account = deps.accountPool.acquire({ provider: accountProvider, capability: 'messages' });
      if (!account) throw new ClaudeApiError(`No available ${accountProvider} account. Import and health-check a ChatGPT session account before calling /v1/messages.`, 503, 'overloaded_error');

      const backendContext = { account };
      let releaseError: unknown;
      let releaseDeferredToStream = false;
      try {
        if (deps.backendProvider === 'session') await deps.modelRegistry.refreshFromBackend(deps.backend, backendContext);
        const resolution = deps.modelRegistry.resolve(request.model);
        const backendRequest = mapClaudeRequestToChatGpt(request, {
          ...deps.defaults,
          modelDefaults: { ...deps.defaults?.modelDefaults, [request.model]: { reasoningEffort: resolution.model.defaults.reasoning_effort, speedPreference: resolution.model.defaults.speed } },
        }, { backendModel: resolution.backendModel });
        deps.requestLog.record({ route: '/v1/messages', stream: Boolean(request.stream), model: request.model });

        if (request.stream) {
          const events = releaseAccountWhenDone(deps.accountPool, account.id, mapChatGptStreamToClaudeSse(request, deps.backend.stream(backendRequest, backendContext)), claudeStreamError);
          const stream = readableStreamFromAsyncIterable(events);
          releaseDeferredToStream = true;
          return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' } });
        }

        const backendResponse = await deps.backend.complete(backendRequest, backendContext);
        return c.json(mapChatGptResponseToClaude(request, backendResponse));
      } catch (error) {
        releaseError = error;
        throw error;
      } finally {
        if (!releaseDeferredToStream) deps.accountPool.release(account.id, releaseError);
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
    accountPool.release(accountId, releaseError);
  }
}

async function* claudeStreamError(error: unknown): AsyncIterable<string> {
  yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: mapErrorPayload(error) })}\n\n`;
}
