import { Hono } from 'hono';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptResponseToOpenAiResponses, mapChatGptStreamToOpenAiResponsesSse, mapOpenAiResponsesRequestToChatGpt, readableStreamFromAsyncIterable, type OpenAiResponsesRequest, type ReasoningSpeedDefaults } from '@chatgpt-to-claude/protocol-mapper';
import type { RequestLog } from '../services/request-log.js';
import { ModelRegistryError, type ModelRegistry } from '../services/model-registry.js';
import type { AccountPool, AccountProvider } from '../services/account-pool.js';
import { mapChatGptBackendError } from './backend-errors.js';

export interface OpenAiResponsesRouteDeps { backend: ChatGptBackendClient; requestLog: RequestLog; modelRegistry: ModelRegistry; accountPool: AccountPool; backendProvider?: 'mock' | 'session'; defaults?: ReasoningSpeedDefaults; ready?: Promise<unknown>; }

export function createOpenAiResponsesRoute(deps: OpenAiResponsesRouteDeps): Hono {
  const app = new Hono();
  app.post('/v1/responses', async (c) => {
    try {
      if (deps.ready) await deps.ready;
      const request = parseOpenAiResponsesRequest(await c.req.json());
      const accountProvider = accountProviderForBackend(deps.backendProvider);
      const account = deps.accountPool.acquire({ provider: accountProvider, capability: 'messages' });
      if (!account) throw new ClaudeApiError(`No available ${accountProvider} account. Import and health-check a ChatGPT session account before calling /v1/responses.`, 503, 'overloaded_error');

      const backendContext = { account };
      let releaseError: unknown;
      let releaseDeferredToStream = false;
      try {
        if (deps.backendProvider === 'session') await deps.modelRegistry.refreshFromBackend(deps.backend, backendContext);
        const resolution = deps.modelRegistry.resolve(request.model);
        const backendRequest = mapOpenAiResponsesRequestToChatGpt(request, {
          ...deps.defaults,
          modelDefaults: { ...deps.defaults?.modelDefaults, [request.model]: { reasoningEffort: resolution.model.defaults.reasoning_effort, speedPreference: resolution.model.defaults.speed } },
        }, { backendModel: resolution.backendModel });
        deps.requestLog.record({ route: '/v1/responses', stream: Boolean(request.stream), model: request.model });

        if (request.stream) {
          const events = releaseAccountWhenDone(deps.accountPool, account.id, mapChatGptStreamToOpenAiResponsesSse(request, deps.backend.stream(backendRequest, backendContext)));
          const stream = readableStreamFromAsyncIterable(events);
          releaseDeferredToStream = true;
          return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' } });
        }

        const backendResponse = await deps.backend.complete(backendRequest, backendContext);
        return c.json(mapChatGptResponseToOpenAiResponses(request, backendResponse));
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

function parseOpenAiResponsesRequest(value: unknown): OpenAiResponsesRequest {
  if (!value || typeof value !== 'object') throw new ClaudeApiError('Request body must be a JSON object');
  const body = value as Partial<OpenAiResponsesRequest>;
  if (typeof body.model !== 'string' || !body.model) throw new ClaudeApiError('model is required');
  if (typeof body.input !== 'string' && !Array.isArray(body.input)) throw new ClaudeApiError('input must be a string or array');
  const maxTokens = body.max_output_tokens ?? body.max_tokens;
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1)) throw new ClaudeApiError('max_output_tokens/max_tokens must be a positive integer');
  if (body.previous_response_id !== undefined && body.previous_response_id !== null && typeof body.previous_response_id !== 'string') throw new ClaudeApiError('previous_response_id must be a string or null');
  if (body.store !== undefined && body.store !== null && typeof body.store !== 'boolean') throw new ClaudeApiError('store must be a boolean or null');
  if (body.metadata !== undefined && body.metadata !== null && !isObject(body.metadata)) throw new ClaudeApiError('metadata must be an object or null');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') throw new ClaudeApiError('parallel_tool_calls must be a boolean');
  if (body.truncation !== undefined && typeof body.truncation !== 'string') throw new ClaudeApiError('truncation must be a string');
  if (body.text !== undefined && !isObject(body.text)) throw new ClaudeApiError('text must be an object');
  if (body.response_format !== undefined && !isObject(body.response_format)) throw new ClaudeApiError('response_format must be an object');
  return body as OpenAiResponsesRequest;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toOpenAiError(error: ClaudeApiError) {
  return { error: { message: error.message, type: error.type, code: null } };
}

function accountProviderForBackend(backendProvider: OpenAiResponsesRouteDeps['backendProvider']): AccountProvider {
  return backendProvider === 'session' ? 'chatgpt-session' : 'mock';
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
