import { Hono } from 'hono';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptResponseToOpenAiResponses, mapChatGptStreamToOpenAiResponsesSse, mapOpenAiResponsesRequestToChatGpt, readableStreamFromAsyncIterable, type OpenAiResponsesInputItem, type OpenAiResponsesRequest, type ReasoningSpeedDefaults } from '@chatgpt-to-claude/protocol-mapper';
import type { RequestLog } from '../services/request-log.js';
import { ResponsesStore } from '../services/responses-store.js';
import { ModelRegistryError, type ModelRegistry } from '../services/model-registry.js';
import type { AccountPool, AccountProvider } from '../services/account-pool.js';
import { accountReleaseError } from './account-release-error.js';
import { mapChatGptBackendError, mapErrorPayload } from './backend-errors.js';

export interface OpenAiResponsesRouteDeps { backend: ChatGptBackendClient; requestLog: RequestLog; modelRegistry: ModelRegistry; accountPool: AccountPool; responsesStore?: ResponsesStore; backendProvider?: 'mock' | 'session'; defaults?: ReasoningSpeedDefaults; ready?: Promise<unknown>; }

export function createOpenAiResponsesRoute(deps: OpenAiResponsesRouteDeps): Hono {
  const app = new Hono();
  const responsesStore = deps.responsesStore ?? new ResponsesStore();
  app.post('/v1/responses', async (c) => {
    try {
      if (deps.ready) await deps.ready;
      const request = parseOpenAiResponsesRequest(await c.req.json());
      const ownerId = String((c as { get: (key: string) => unknown }).get('ownerId') ?? 'anonymous');
      const downstreamRequest = withPreviousResponseContext(ownerId, request, responsesStore);
      const accountProvider = accountProviderForBackend(deps.backendProvider);
      const account = deps.accountPool.acquire({ provider: accountProvider, capability: 'messages' });
      if (!account) throw new ClaudeApiError(`No available ${accountProvider} account. Import and health-check a ChatGPT session account before calling /v1/responses.`, 503, 'overloaded_error');

      const backendContext = { account };
      let releaseError: unknown;
      let releaseDeferredToStream = false;
      try {
        if (deps.backendProvider === 'session') await deps.modelRegistry.refreshFromBackend(deps.backend, backendContext);
        const resolution = deps.modelRegistry.resolve(request.model);
        const backendRequest = mapOpenAiResponsesRequestToChatGpt(downstreamRequest, {
          ...deps.defaults,
          modelDefaults: { ...deps.defaults?.modelDefaults, [request.model]: { reasoningEffort: resolution.model.defaults.reasoning_effort, speedPreference: resolution.model.defaults.speed } },
        }, { backendModel: resolution.backendModel });
        deps.requestLog.record({ route: '/v1/responses', stream: Boolean(request.stream), model: request.model });

        if (request.stream) {
          const events = releaseAccountWhenDone(deps.accountPool, account.id, mapChatGptStreamToOpenAiResponsesSse(downstreamRequest, deps.backend.stream(backendRequest, backendContext), { onCompleted: (response) => { if (request.store === true) responsesStore.put(ownerId, request, response); } }), (error) => openAiResponsesStreamError(error, request.model));
          const stream = readableStreamFromAsyncIterable(events);
          releaseDeferredToStream = true;
          return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' } });
        }

        const backendResponse = await deps.backend.complete(backendRequest, backendContext);
        const response = mapChatGptResponseToOpenAiResponses(downstreamRequest, backendResponse);
        if (request.store === true) responsesStore.put(ownerId, request, response);
        return c.json(response);
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

function withPreviousResponseContext(ownerId: string, request: OpenAiResponsesRequest, responsesStore: ResponsesStore): OpenAiResponsesRequest {
  const previousResponseId = typeof request.previous_response_id === 'string' ? request.previous_response_id : '';
  if (!previousResponseId) return request;
  const previous = responsesStore.get(ownerId, previousResponseId);
  if (!previous) throw new ClaudeApiError(`Previous response not found: ${previousResponseId}`, 404, 'not_found_error');
  const replayItems = replayablePreviousOutputItems(previous.response.output);
  const outputText = previous.response.output_text;
  const input = replayItems.length
    ? prependInputItems(request.input, replayItems)
    : outputText ? prependInputItems(request.input, [{ type: 'message', role: 'assistant', content: outputText }]) : request.input;
  return { ...request, input, previous_response_id: undefined };
}

function replayablePreviousOutputItems(output: Array<Record<string, unknown>>): OpenAiResponsesInputItem[] {
  const items: OpenAiResponsesInputItem[] = [];
  for (const item of output) {
    if (item.type === 'function_call') {
      const callId = typeof item.call_id === 'string' ? item.call_id : undefined;
      const name = typeof item.name === 'string' ? item.name : undefined;
      if (callId && name) items.push({ type: 'function_call', call_id: callId, name, arguments: item.arguments ?? '' });
      continue;
    }
    if (item.type === 'message') {
      const content = replayableAssistantMessageContent(item.content);
      if (content !== undefined) items.push({ type: 'message', role: 'assistant', content });
    }
  }
  return items;
}

function replayableAssistantMessageContent(content: unknown): string | unknown[] | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter((part) => typeof part === 'string' || isObject(part));
  return parts.length ? parts : undefined;
}

function prependInputItems(input: OpenAiResponsesRequest['input'], items: OpenAiResponsesInputItem[]): OpenAiResponsesInputItem[] {
  return typeof input === 'string'
    ? [...items, { type: 'message', role: 'user', content: input }]
    : [...items, ...input];
}

function parseOpenAiResponsesRequest(value: unknown): OpenAiResponsesRequest {
  if (!isObject(value)) throw new ClaudeApiError('Request body must be a JSON object');
  const body = value;
  if (typeof body.model !== 'string' || !body.model) throw new ClaudeApiError('model is required');
  if (typeof body.input !== 'string' && !Array.isArray(body.input)) throw new ClaudeApiError('input must be a string or array');
  validateResponsesInput(body.input);
  const maxTokens = body.max_output_tokens ?? body.max_tokens;
  if (maxTokens !== undefined && (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1)) throw new ClaudeApiError('max_output_tokens/max_tokens must be a positive integer');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new ClaudeApiError('stream must be a boolean');
  if (body.temperature !== undefined && typeof body.temperature !== 'number') throw new ClaudeApiError('temperature must be a number');
  if (body.top_p !== undefined && typeof body.top_p !== 'number') throw new ClaudeApiError('top_p must be a number');
  validateStop(body.stop);
  if (body.reasoning !== undefined) {
    if (!isObject(body.reasoning)) throw new ClaudeApiError('reasoning must be an object');
    if (body.reasoning.effort !== undefined && typeof body.reasoning.effort !== 'string') throw new ClaudeApiError('reasoning.effort must be a string');
  }
  if (body.reasoning_effort !== undefined && typeof body.reasoning_effort !== 'string') throw new ClaudeApiError('reasoning_effort must be a string');
  if (body.speed !== undefined && typeof body.speed !== 'string') throw new ClaudeApiError('speed must be a string');
  if (body.response_speed !== undefined && typeof body.response_speed !== 'string') throw new ClaudeApiError('response_speed must be a string');
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new ClaudeApiError('tools must be an array');
  validateTools(body.tools);
  validateToolChoice(body.tool_choice, body.tools);
  if (body.previous_response_id !== undefined && body.previous_response_id !== null && typeof body.previous_response_id !== 'string') throw new ClaudeApiError('previous_response_id must be a string or null');
  if (body.store !== undefined && body.store !== null && typeof body.store !== 'boolean') throw new ClaudeApiError('store must be a boolean or null');
  if (body.metadata !== undefined && body.metadata !== null && !isObject(body.metadata)) throw new ClaudeApiError('metadata must be an object or null');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') throw new ClaudeApiError('parallel_tool_calls must be a boolean');
  if (body.truncation !== undefined && typeof body.truncation !== 'string') throw new ClaudeApiError('truncation must be a string');
  if (body.text !== undefined && !isObject(body.text)) throw new ClaudeApiError('text must be an object');
  if (body.response_format !== undefined && !isObject(body.response_format)) throw new ClaudeApiError('response_format must be an object');
  return body as unknown as OpenAiResponsesRequest;
}

function validateStop(stop: unknown): void {
  if (stop === undefined || stop === null || typeof stop === 'string') return;
  if (!Array.isArray(stop) || stop.some((item) => typeof item !== 'string')) throw new ClaudeApiError('stop must be a string, string array, or null');
}

function validateResponsesInput(input: unknown): void {
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (!isObject(item)) throw new ClaudeApiError('input items must be objects');
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== 'string' && !isObject(part)) throw new ClaudeApiError('input content parts must be strings or objects');
    }
  }
}

function validateTools(tools: unknown): void {
  if (tools === undefined) return;
  if (!Array.isArray(tools)) throw new ClaudeApiError('tools must be an array');
  for (const tool of tools) {
    if (!isObject(tool)) throw new ClaudeApiError('tools items must be objects');
    if (typeof tool.type !== 'string' || !tool.type.trim()) throw new ClaudeApiError('tool type is required');
    if (tool.type !== 'function') continue;
    const fn = isObject(tool.function) ? tool.function : tool;
    const name = typeof fn.name === 'string' ? fn.name : undefined;
    if (!name?.trim()) throw new ClaudeApiError('function tool name is required');
    if (tool.parameters !== undefined && !isObject(tool.parameters)) throw new ClaudeApiError('function tool parameters must be an object');
    if (isObject(tool.function) && tool.function.parameters !== undefined && !isObject(tool.function.parameters)) throw new ClaudeApiError('function tool parameters must be an object');
  }
}

function validateToolChoice(toolChoice: unknown, tools: unknown): void {
  if (toolChoice === undefined) return;
  if (typeof toolChoice === 'string') {
    if (toolChoice !== 'auto' && toolChoice !== 'none' && toolChoice !== 'required') throw new ClaudeApiError(`Unsupported tool_choice: ${toolChoice}`);
    return;
  }
  if (!isObject(toolChoice)) throw new ClaudeApiError('tool_choice must be a string or object');
  if (typeof toolChoice.type !== 'string' || !toolChoice.type.trim()) throw new ClaudeApiError('tool_choice type is required');
  if (toolChoice.type !== 'function') return;
  const fn = toolChoice.function;
  const name = typeof toolChoice.name === 'string' ? toolChoice.name : isObject(fn) && typeof fn.name === 'string' ? fn.name : undefined;
  if (!name?.trim()) throw new ClaudeApiError('tool_choice function name is required');
  if (!Array.isArray(tools) || !responsesFunctionToolNames(tools).has(name)) throw new ClaudeApiError(`tool_choice function name is not in tools: ${name}`);
}

function responsesFunctionToolNames(tools: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (!isObject(tool) || tool.type !== 'function') continue;
    const fn = isObject(tool.function) ? tool.function : tool;
    if (typeof fn.name === 'string' && fn.name.trim()) names.add(fn.name);
  }
  return names;
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

async function* openAiResponsesStreamError(error: unknown, model: string): AsyncIterable<string> {
  const payload = mapErrorPayload(error);
  const openAiError = { message: payload.message, type: payload.type, code: null };
  yield `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { id: 'resp_failed', object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'failed', error: openAiError }, error: openAiError })}\n\n`;
  yield 'data: [DONE]\n\n';
}
