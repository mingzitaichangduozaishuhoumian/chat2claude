import { Hono } from 'hono';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptResponseToOpenAiChat, mapChatGptStreamToOpenAiChatSse, mapOpenAiChatRequestToChatGpt, readableStreamFromAsyncIterable, type OpenAiChatCompletionRequest, type ReasoningSpeedDefaults } from '@chatgpt-to-claude/protocol-mapper';
import type { RequestLog } from '../services/request-log.js';
import { ModelRegistryError, type ModelRegistry } from '../services/model-registry.js';
import type { AccountPool, AccountProvider } from '../services/account-pool.js';
import { accountReleaseError } from './account-release-error.js';
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
        if (!releaseDeferredToStream) deps.accountPool.release(account.id, accountReleaseError(releaseError));
      }
    } catch (error) {
      const apiError = error instanceof ClaudeApiError ? error : mapChatGptBackendError(error) ?? (error instanceof ModelRegistryError ? new ClaudeApiError(error.message, error.status, error.status === 404 ? 'not_found_error' : 'invalid_request_error') : new ClaudeApiError(error instanceof Error ? error.message : 'Invalid request'));
      return c.json(toOpenAiError(apiError), apiError.status as 400);
    }
  });
  return app;
}

function parseOpenAiChatCompletionRequest(value: unknown): OpenAiChatCompletionRequest {
  if (!isObject(value)) throw new ClaudeApiError('Request body must be a JSON object');
  const body = value;
  if (typeof body.model !== 'string' || !body.model) throw new ClaudeApiError('model is required');
  if (!Array.isArray(body.messages)) throw new ClaudeApiError('messages must be an array');
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens !== undefined && (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1)) throw new ClaudeApiError('max_tokens/max_completion_tokens must be a positive integer');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new ClaudeApiError('stream must be a boolean');
  if (body.temperature !== undefined && typeof body.temperature !== 'number') throw new ClaudeApiError('temperature must be a number');
  if (body.top_p !== undefined && typeof body.top_p !== 'number') throw new ClaudeApiError('top_p must be a number');
  validateStop(body.stop);
  if (body.reasoning_effort !== undefined && typeof body.reasoning_effort !== 'string') throw new ClaudeApiError('reasoning_effort must be a string');
  if (body.speed !== undefined && typeof body.speed !== 'string') throw new ClaudeApiError('speed must be a string');
  if (body.response_speed !== undefined && typeof body.response_speed !== 'string') throw new ClaudeApiError('response_speed must be a string');
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new ClaudeApiError('tools must be an array');
  validateToolChoice(body.tool_choice);
  if (body.stream_options !== undefined) {
    if (!isObject(body.stream_options)) throw new ClaudeApiError('stream_options must be an object');
    if (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean') throw new ClaudeApiError('stream_options.include_usage must be a boolean');
  }
  if (body.response_format !== undefined && !isObject(body.response_format)) throw new ClaudeApiError('response_format must be an object');
  for (const message of body.messages) validateOpenAiChatMessage(message);
  return body as unknown as OpenAiChatCompletionRequest;
}

function validateStop(stop: unknown): void {
  if (stop === undefined || stop === null || typeof stop === 'string') return;
  if (!Array.isArray(stop) || stop.some((item) => typeof item !== 'string')) throw new ClaudeApiError('stop must be a string, string array, or null');
}

function validateOpenAiChatMessage(message: unknown): void {
  if (!isObject(message)) throw new ClaudeApiError('message must be an object');
  if (message.role !== 'system' && message.role !== 'developer' && message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') throw new ClaudeApiError('message.role must be system, developer, user, assistant, or tool');
  if (message.content !== undefined && message.content !== null && typeof message.content !== 'string' && !Array.isArray(message.content)) throw new ClaudeApiError('message.content must be a string, null, or array');
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isObject(part)) throw new ClaudeApiError('message.content parts must be objects');
    }
  }
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new ClaudeApiError('message.tool_calls must be an array');
  if (message.role === 'tool' && message.tool_call_id !== undefined && typeof message.tool_call_id !== 'string') throw new ClaudeApiError('message.tool_call_id must be a string');
}

function validateToolChoice(toolChoice: unknown): void {
  if (toolChoice === undefined || typeof toolChoice === 'string') return;
  if (!isObject(toolChoice)) throw new ClaudeApiError('tool_choice must be a string or object');
  if (toolChoice.type !== 'function') return;
  const fn = toolChoice.function;
  const name = typeof toolChoice.name === 'string' ? toolChoice.name : isObject(fn) && typeof fn.name === 'string' ? fn.name : undefined;
  if (!name) throw new ClaudeApiError('tool_choice function name is required');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
    accountPool.release(accountId, accountReleaseError(releaseError));
  }
}

async function* openAiChatStreamError(error: unknown): AsyncIterable<string> {
  const payload = mapErrorPayload(error);
  yield `data: ${JSON.stringify({ error: { message: payload.message, type: payload.type, code: null } })}\n\n`;
  yield 'data: [DONE]\n\n';
}
