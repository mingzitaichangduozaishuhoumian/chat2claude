import { Hono } from 'hono';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError, parseClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptResponseToClaude, mapChatGptStreamToClaudeSse, mapClaudeRequestToChatGpt, readableStreamFromAsyncIterable, type ReasoningSpeedDefaults } from '@chatgpt-to-claude/protocol-mapper';
import type { RequestLog } from '../services/request-log.js';
import type { ModelRegistry } from '../services/model-registry.js';
import type { AccountPool } from '../services/account-pool.js';
export interface MessagesRouteDeps { backend: ChatGptBackendClient; requestLog: RequestLog; modelRegistry: ModelRegistry; accountPool: AccountPool; defaults?: ReasoningSpeedDefaults; }
export function createMessagesRoute(deps: MessagesRouteDeps): Hono {
  const app = new Hono();
  app.post('/v1/messages', async (c) => {
    try {
      const request = parseClaudeMessagesRequest(await c.req.json());
      const model = deps.modelRegistry.get(request.model);
      if (!model) throw new ClaudeApiError(`Unknown model: ${request.model}`, 404, 'not_found_error');
      if (!model.enabled) throw new ClaudeApiError(`Model is disabled: ${request.model}`, 400, 'invalid_request_error');
      const backendRequest = mapClaudeRequestToChatGpt(request, {
        ...deps.defaults,
        modelDefaults: { ...deps.defaults?.modelDefaults, [request.model]: { reasoningEffort: model.defaults.reasoning_effort, speedPreference: model.defaults.speed } },
      }, { backendModel: model.backendModel });
      deps.requestLog.record({ route: '/v1/messages', stream: Boolean(request.stream), model: request.model });
      const account = deps.accountPool.acquire();
      if (!account) throw new ClaudeApiError('No ChatGPT account available', 503, 'overloaded_error');
      if (request.stream) {
        const events = releaseAccountWhenDone(deps.accountPool, account.id, mapChatGptStreamToClaudeSse(request, deps.backend.stream(backendRequest)));
        const stream = readableStreamFromAsyncIterable(events);
        return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' } });
      }
      let releaseError: unknown;
      try {
        const backendResponse = await deps.backend.complete(backendRequest);
        return c.json(mapChatGptResponseToClaude(request, backendResponse));
      } catch (error) {
        releaseError = error;
        throw error;
      } finally {
        deps.accountPool.release(account.id, releaseError);
      }
    } catch (error) {
      const apiError = error instanceof ClaudeApiError ? error : new ClaudeApiError(error instanceof Error ? error.message : 'Invalid request');
      return c.json(apiError.toResponseBody(), apiError.status as 400);
    }
  });
  return app;
}

async function* releaseAccountWhenDone(accountPool: AccountPool, accountId: string, events: AsyncIterable<string>): AsyncIterable<string> {
  let releaseError: unknown;
  try {
    yield* events;
  } catch (error) {
    releaseError = error;
    throw error;
  } finally {
    accountPool.release(accountId, releaseError);
  }
}
