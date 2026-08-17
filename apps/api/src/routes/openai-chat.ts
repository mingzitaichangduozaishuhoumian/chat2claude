import { Hono } from 'hono';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptResponseToOpenAiChat, mapChatGptStreamToOpenAiChatSse, mapOpenAiChatRequestToChatGpt, readableStreamFromAsyncIterable, type OpenAiChatCompletionRequest, type ReasoningSpeedDefaults } from '@chatgpt-to-claude/protocol-mapper';
import type { RequestLog } from '../services/request-log.js';
import { ModelRegistryError, type ModelRegistry } from '../services/model-registry.js';
import type { AccountPool, AccountProvider } from '../services/account-pool.js';
import { mapChatGptBackendError, mapErrorPayload } from './backend-errors.js';

export interface OpenAiChatRouteDeps { backend: ChatGptBackendClient; requestLog: RequestLog; modelRegistry: ModelRegistry; accountPool: AccountPool; backendProvider?: 'mock' | 'session'; defaults?: ReasoningSpeedDefaults; ready?: Promise<unknown>; }

export function createOpenAiChatRoute(deps: OpenAiChatRouteDeps): Hono {
  const app = new Hono();
  app.post('/v1/chat/completions', async (c) => {
    try {
      if (deps.ready) await deps.ready;
      const request = parseOpenAiChatCompletionRequest(await c.req.json());
      const accountProvider = accountProviderForBackend(deps.backendProvider);
      const account = deps.accountPool.acquire({ provider: accountProvider, capability: 'messages' });
      if (!account) throw new ClaudeApiError(`No available ${accountProvider} account. Import and health-check a ChatGPT session account before calling /v1/chat/completions.`, 503, 'overloaded_error');

      const backendContext = { account };
      let releaseError: unknown;
      let releaseDeferredToStream = false;
      try {
        if (deps.backendProvider === 'session') await deps.modelRegistry.refreshFromBackend(deps.backend, backendContext);
        const resolution = deps.modelRegistry.resolve(request.model);
        const backendRequest = mapOpenAiChatRequestToChatGpt(request, {
          ...deps.defaults,
          modelDefaults: { ...deps.defaults?.modelDefaults, [request.model]: { reasoningEffort: resolution.model.defaults.reasoning_effort, speedPreference: resolution.model.defaults.speed } },
        }, { backendModel: resolution.backendModel });
        deps.requestLog.record({ route: '/v1/chat/completions', stream: Boolean(request.stream), model: request.model });

        if (request.stream) {
          const events = releaseAccountWhenDone(deps.accountPool, account.id, mapChatGptStreamToOpenAiChatSse(request, deps.backend.stream(backendRequest, backendContext)), openAiChatStreamError);
          const stream = readableStreamFromAsyncIterable(events);
          releaseDeferredToStream = true;
          return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' } });
        }

        const backendResponse = await deps.backend.complete(backendRequest, backendContext);
        return c.json(mapChatGptResponseToOpenAiChat(request, backendResponse));
      } catch (error) {
        releaseError = error;
        throw error;
      } finally {
        if (!releaseDeferredToStream) deps.accountPool.release(account.id, releaseError);
      }
    } catch (error) {
      const apiError = error instanceof ClaudeApiError ? error : mapChatGptBackendError(error) ?? (error instanceof ModelRegistryError ? new ClaudeApiError(error.message, error.status, error.status === 404 ? 'not_found_error' : 'invalid_request_error') : new ClaudeApiError(error instanceof Error ? error.message : 'Invalid request'));
      return c.json(toOpenAiError(apiError), apiError.status as 400);
    }
  });
  return app;
}

function parseOpenAiChatCompletionRequest(value: unknown): OpenAiChatCompletionRequest {
  if (!value || typeof value !== 'object') throw new ClaudeApiError('Request body must be a JSON object');
  const body = value as Partial<OpenAiChatCompletionRequest>;
  if (typeof body.model !== 'string' || !body.model) throw new ClaudeApiError('model is required');
  if (!Array.isArray(body.messages)) throw new ClaudeApiError('messages must be an array');
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1)) throw new ClaudeApiError('max_tokens/max_completion_tokens must be a positive integer');
  if (body.response_format !== undefined && (!body.response_format || typeof body.response_format !== 'object' || Array.isArray(body.response_format))) throw new ClaudeApiError('response_format must be an object');
  return body as OpenAiChatCompletionRequest;
}

function toOpenAiError(error: ClaudeApiError) {
  return { error: { message: error.message, type: error.type, code: null } };
}

function accountProviderForBackend(backendProvider: OpenAiChatRouteDeps['backendProvider']): AccountProvider {
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

async function* openAiChatStreamError(error: unknown): AsyncIterable<string> {
  const payload = mapErrorPayload(error);
  yield `data: ${JSON.stringify({ error: { message: payload.message, type: payload.type, code: null } })}\n\n`;
  yield 'data: [DONE]\n\n';
}
