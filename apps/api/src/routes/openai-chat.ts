import { boundedClose, prepareStream, type PreparedStream } from './prepare-stream.js';
import { Hono } from 'hono';
import type { Logger } from '@chatgpt-to-claude/shared';
import { logHttpRequestFailure, releaseAccountWhenDone } from './stream-lifecycle.js';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptResponseToOpenAiChat, mapChatGptStreamToOpenAiChatSse, mapOpenAiChatRequestToChatGpt, readableStreamFromAsyncIterable, type OpenAiChatCompletionRequest, type ReasoningSpeedDefaults } from '@chatgpt-to-claude/protocol-mapper';
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

export interface OpenAiChatRouteDeps { backend: ChatGptBackendClient; requestLog: RequestLog; modelRegistry: ModelRegistry; accountPool: AccountPool; operationalState?: AdminOperationalState; backendProvider?: 'mock' | 'session'; defaults?: ReasoningSpeedDefaults; ready?: Promise<unknown>; accountAcquireTimeoutMs?: number; logger?: Logger; reasoningReplayStore?: ReasoningReplayStore; }

export function createOpenAiChatRoute(deps: OpenAiChatRouteDeps): Hono {
  const app = new Hono();
  app.post('/v1/chat/completions', async (c) => {
    try {
      if (deps.ready) await deps.ready;
      const request = parseOpenAiChatCompletionRequest(await parseRequestJson(() => c.req.json()));
      setAccessLogMetadata(c, { model: request.model, stream: Boolean(request.stream) });
      const explicitControls = {
        reasoningEffort: request.reasoning_effort,
        serviceTier: request.service_tier ?? request.speed ?? request.response_speed,
      };
      const accountProvider = accountProviderForBackend(deps.backendProvider);
      if (deps.backendProvider === 'session') checkSessionAccountAvailability(c, deps.accountPool);
      const globalResolution = deps.modelRegistry.resolve(request.model);
      const accountControls = deps.modelRegistry.accountControlRequirements(globalResolution, explicitControls);
      const visibleRequest = mapOpenAiChatRequestToChatGpt(request, {}, { backendModel: globalResolution.backendModel, resolvedControls: {} });
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
      const backendContext = { account, signal: AbortSignal.any([c.req.raw.signal, streamCancellation.signal]) };
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
        const backendRequest = mapOpenAiChatRequestToChatGpt(request, {}, {
          backendModel: resolution.backendModel,
          resolvedControls: controls,
        });
        replay.apply(backendRequest, account, deps.accountPool);
        deps.requestLog.record({ route: '/v1/chat/completions', stream: Boolean(request.stream), model: request.model });

        if (request.stream) {
          prepared = await prepareStream(deps.backend.stream(backendRequest, backendContext), { signal: backendContext.signal, abort: () => streamCancellation.abort() });
          const events = streamOwner = releaseAccountWhenDone(deps.accountPool, account, mapChatGptStreamToOpenAiChatSse(request, trackStreamStatistics(replay.stream(prepared.events, account, backendRequest.model, deps.accountPool, backendContext.signal), tracker, backendContext.signal, true)), openAiChatStreamError, tracker, backendContext.signal, { route: '/v1/chat/completions', requestId: getAccessLogRequestId(c), logger: deps.logger, terminal: getAccessLogTerminal(c) }, prepared.close);
          const stream = responseBody = readableStreamFromAsyncIterable(events, {
            signal: c.req.raw.signal,
            onCancel: () => { streamCancellation.abort(); return events.cancel(); },
          });
          const response = new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' } });
          releaseDeferredToStream = true;
          return response;
        }

        const backendResponse = await deps.backend.complete(backendRequest, backendContext);
        replay.complete(backendResponse, account, backendRequest.model, deps.accountPool, backendContext.signal);
        const response = mapChatGptResponseToOpenAiChat(request, backendResponse);
        tracker.finish('success', usageFromBackend(backendResponse.usage));
        return c.json(response);
      } catch (error) {
        streamOwner?.abandon();
        releaseError = error;
        tracker.finish(requestErrorOutcome(error, backendContext.signal));
        if (responseBody) await boundedClose(() => responseBody!.cancel());
        throw error;
      } finally {
        if (!releaseDeferredToStream) {
          await prepared?.close();
          deps.accountPool.release(account, accountReleaseError(releaseError));
        }
      }
    } catch (error) {
      logHttpRequestFailure(error, { route: '/v1/chat/completions', requestId: getAccessLogRequestId(c), logger: deps.logger, terminal: getAccessLogTerminal(c) }, c.req.raw.signal);
      const apiError = mapRequestCancellation(error, c.req.raw.signal) ?? (error instanceof ClaudeApiError ? error : mapChatGptBackendError(error) ?? (error instanceof ModelRegistryError ? new ClaudeApiError(error.message, error.status, error.status === 404 ? 'not_found_error' : 'invalid_request_error') : unexpectedApiError()));
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
  if (body.service_tier !== undefined && typeof body.service_tier !== 'string') throw new ClaudeApiError('service_tier must be a string');
  if (body.speed !== undefined && typeof body.speed !== 'string') throw new ClaudeApiError('speed must be a string');
  if (body.response_speed !== undefined && typeof body.response_speed !== 'string') throw new ClaudeApiError('response_speed must be a string');
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new ClaudeApiError('tools must be an array');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') throw new ClaudeApiError('parallel_tool_calls must be a boolean');
  validateTools(body.tools);
  validateToolChoice(body.tool_choice, body.tools);
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

function validateTools(tools: unknown): void {
  if (tools === undefined) return;
  if (!Array.isArray(tools)) throw new ClaudeApiError('tools must be an array');
  for (const tool of tools) {
    if (!isObject(tool)) throw new ClaudeApiError('tools items must be objects');
    if (tool.type !== 'function') throw new ClaudeApiError(`Unsupported tool type: ${String(tool.type)}`);
    if (!isObject(tool.function)) throw new ClaudeApiError('function tool must include a function object');
    if (typeof tool.function.name !== 'string' || !tool.function.name.trim()) throw new ClaudeApiError('function tool name is required');
    if (tool.function.parameters !== undefined && !isObject(tool.function.parameters)) throw new ClaudeApiError('function tool parameters must be an object');
  }
}

function validateToolChoice(toolChoice: unknown, tools: unknown): void {
  if (toolChoice === undefined) return;
  if (typeof toolChoice === 'string') {
    if (toolChoice !== 'auto' && toolChoice !== 'none' && toolChoice !== 'required') throw new ClaudeApiError(`Unsupported tool_choice: ${toolChoice}`);
    return;
  }
  if (!isObject(toolChoice)) throw new ClaudeApiError('tool_choice must be a string or object');
  if (toolChoice.type !== 'function') throw new ClaudeApiError(`Unsupported tool_choice type: ${String(toolChoice.type)}`);
  const fn = toolChoice.function;
  const name = typeof toolChoice.name === 'string' ? toolChoice.name : isObject(fn) && typeof fn.name === 'string' ? fn.name : undefined;
  if (!name?.trim()) throw new ClaudeApiError('tool_choice function name is required');
  if (!Array.isArray(tools) || !chatToolNames(tools).has(name)) throw new ClaudeApiError(`tool_choice function name is not in tools: ${name}`);
}

function chatToolNames(tools: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (isObject(tool) && isObject(tool.function) && typeof tool.function.name === 'string' && tool.function.name.trim()) names.add(tool.function.name);
  }
  return names;
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

async function* openAiChatStreamError(error: unknown): AsyncIterable<string> {
  const payload = mapErrorPayload(error);
  yield `data: ${JSON.stringify({ error: { message: payload.message, type: payload.type, code: null } })}\n\n`;
  yield 'data: [DONE]\n\n';
}
