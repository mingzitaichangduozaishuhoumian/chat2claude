import { boundedClose, prepareStream, type PreparedStream } from './prepare-stream.js';
import { Hono } from 'hono';
import type { Logger } from '@chatgpt-to-claude/shared';
import { logHttpRequestFailure, releaseAccountWhenDone } from './stream-lifecycle.js';
import { parseResponsesReplayItem, ResponsesReplayBudget, type ChatGptCompletionResponse, type ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptResponseToOpenAiResponses, mapChatGptStreamToOpenAiResponsesSse, mapOpenAiResponsesRequestToChatGpt, readableStreamFromAsyncIterable, type OpenAiResponsesResponse, type OpenAiResponsesRequest, type ReasoningSpeedDefaults } from '@chatgpt-to-claude/protocol-mapper';
import type { RequestLog } from '../services/request-log.js';
import { previousResponseNotFound, ResponsesStore } from '../services/responses-store.js';
import { bindRequestHistory } from '../services/request-history-binding.js';
import { ModelRegistryError, type ModelRegistry } from '../services/model-registry.js';
import type { AccountPool, AccountProvider } from '../services/account-pool.js';
import { accountReleaseError } from './account-release-error.js';
import { mapRequestCancellation, mapChatGptBackendError, mapErrorPayload, parseRequestJson, unexpectedApiError } from './backend-errors.js';
import { createAccountRequestTracker, requestErrorOutcome, trackStreamStatistics, usageFromBackend } from '../services/request-statistics.js';
import type { AdminOperationalState } from '../services/admin-operational-state.js';
import { getAccessLogRequestId, getAccessLogTerminal, setAccessLogMetadata } from '../middleware/access-log.js';
import { acquireRequestAccount, checkSessionAccountAvailability } from './account-acquisition.js';

export interface OpenAiResponsesRouteDeps { backend: ChatGptBackendClient; requestLog: RequestLog; modelRegistry: ModelRegistry; accountPool: AccountPool; responsesStore?: ResponsesStore; operationalState?: AdminOperationalState; backendProvider?: 'mock' | 'session'; defaults?: ReasoningSpeedDefaults; ready?: Promise<unknown>; accountAcquireTimeoutMs?: number; logger?: Logger; }

export function createOpenAiResponsesRoute(deps: OpenAiResponsesRouteDeps): Hono {
  const app = new Hono();
  const responsesStore = deps.responsesStore ?? new ResponsesStore();
  app.post('/v1/responses', async (c) => {
    try {
      if (deps.ready) await deps.ready;
      const request = parseOpenAiResponsesRequest(await parseRequestJson(() => c.req.json()));
      setAccessLogMetadata(c, { model: request.model, stream: Boolean(request.stream) });
      const ownerId = c.get('reasoningReplayOwner');
      const previous = request.previous_response_id ? responsesStore.get(ownerId, request.previous_response_id) : undefined;
      if (request.previous_response_id && !previous) throw previousResponseNotFound();
      const explicitControls = {
        reasoningEffort: request.reasoning?.effort ?? request.reasoning_effort,
        serviceTier: request.service_tier ?? request.speed ?? request.response_speed,
      };
      const accountProvider = accountProviderForBackend(deps.backendProvider);
      if (deps.backendProvider === 'session') checkSessionAccountAvailability(c, deps.accountPool);
      const globalResolution = deps.modelRegistry.resolve(request.model);
      const accountControls = deps.modelRegistry.accountControlRequirements(globalResolution, explicitControls);
      const account = await acquireRequestAccount(c, deps.accountPool, {
        provider: accountProvider,
        capability: 'messages',
        eligible: (candidate) => (!previous || previous.accepts(candidate, globalResolution.backendModel)) &&
          (deps.backendProvider !== 'session' || deps.modelRegistry.supportsAccountRequest(
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
        const current = deps.accountPool.get(account.id);
        if (previous && (!current || !current.enabled || current.status !== 'available' || !previous.accepts(current, resolution.backendModel))) throw new ClaudeApiError('No available account supports the requested model and controls.', 503, 'overloaded_error');
        // Release history only after acquisition, with current affinity and expiry checks.
        const downstreamRequest = { ...request, input: previous ? previous.expand(request.input, current!, resolution.backendModel) : request.input, previous_response_id: undefined };
        const backendRequest = mapOpenAiResponsesRequestToChatGpt(downstreamRequest, {}, {
          backendModel: resolution.backendModel,
          resolvedControls: controls,
        });
        if (previous) bindRequestHistory(backendRequest, current!);
        const commit = (response: OpenAiResponsesResponse, completion: ChatGptCompletionResponse) => {
          const current = deps.accountPool.get(account.id);
          if (request.store === false || !ownerId || backendContext.signal.aborted || completion.terminalSuccessful === false
            || !current || !current.enabled || current.status !== 'available' || current.incarnation !== account.incarnation || current.provider !== account.provider) return;
          const full = mapChatGptResponseToOpenAiResponses({ ...downstreamRequest, include: ['reasoning.encrypted_content'] }, completion);
          responsesStore.put(ownerId, downstreamRequest, response, { account: { id: account.id, incarnation: account.incarnation, provider: account.provider }, model: backendRequest.model,
            output: full.output.map((item, index) => ({ ...item, id: response.output[index]?.id ?? item.id })),
          });
        };
        deps.requestLog.record({ route: '/v1/responses', stream: Boolean(request.stream), model: request.model });

        if (request.stream) {
          prepared = await prepareStream(deps.backend.stream(backendRequest, backendContext), { signal: backendContext.signal, abort: () => streamCancellation.abort() });
          const events = streamOwner = releaseAccountWhenDone(deps.accountPool, account, mapChatGptStreamToOpenAiResponsesSse(downstreamRequest, trackStreamStatistics(prepared.events, tracker, c.req.raw.signal, true), { signal: backendContext.signal, onCompleted: commit }), (error) => openAiResponsesStreamError(error, request.model), tracker, c.req.raw.signal, { route: '/v1/responses', requestId: getAccessLogRequestId(c), logger: deps.logger, terminal: getAccessLogTerminal(c) }, prepared.close);
          const stream = responseBody = readableStreamFromAsyncIterable(events, {
            signal: c.req.raw.signal,
            gracefulAbort: true,
            onCancel: () => events.cancel(),
          });
          const response = new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' } });
          releaseDeferredToStream = true;
          return response;
        }

        const backendResponse = await deps.backend.complete(backendRequest, backendContext);
        const response = mapChatGptResponseToOpenAiResponses(downstreamRequest, backendResponse);
        backendContext.signal.throwIfAborted();
        commit(response, backendResponse);
        tracker.finish('success', usageFromBackend(backendResponse.usage));
        return c.json(response);
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
      logHttpRequestFailure(error, { route: '/v1/responses', requestId: getAccessLogRequestId(c), logger: deps.logger, terminal: getAccessLogTerminal(c) }, c.req.raw.signal);
      const apiError = mapRequestCancellation(error, c.req.raw.signal) ?? (error instanceof ClaudeApiError ? error : mapChatGptBackendError(error) ?? (error instanceof ModelRegistryError ? new ClaudeApiError(error.message, error.status, error.status === 404 ? 'not_found_error' : 'invalid_request_error') : unexpectedApiError()));
      return c.json(toOpenAiError(apiError), apiError.status as 400);
    }
  });
  return app;
}

function parseOpenAiResponsesRequest(value: unknown): OpenAiResponsesRequest {
  if (!isObject(value)) throw new ClaudeApiError('Request body must be a JSON object');
  const body = value;
  if (typeof body.model !== 'string' || !body.model) throw new ClaudeApiError('model is required');
  if (typeof body.input !== 'string' && !Array.isArray(body.input)) throw new ClaudeApiError('input must be a string or array');
  validateResponsesInput(body.input);
  if (body.include !== undefined && (!Array.isArray(body.include) || body.include.length > 1 || body.include.some((value) => value !== 'reasoning.encrypted_content'))) throw new ClaudeApiError('Invalid Responses include.', 400, 'invalid_request_error');
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
  if (body.service_tier !== undefined && typeof body.service_tier !== 'string') throw new ClaudeApiError('service_tier must be a string');
  if (body.speed !== undefined && typeof body.speed !== 'string') throw new ClaudeApiError('speed must be a string');
  if (body.response_speed !== undefined && typeof body.response_speed !== 'string') throw new ClaudeApiError('response_speed must be a string');
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new ClaudeApiError('tools must be an array');
  validateTools(body.tools);
  validateToolChoice(body.tool_choice, body.tools);
  if (body.previous_response_id !== undefined && body.previous_response_id !== null && (typeof body.previous_response_id !== 'string' || !/^resp_[A-Za-z0-9_-]{1,123}$/.test(body.previous_response_id))) throw new ClaudeApiError('Invalid previous_response_id.', 400, 'invalid_request_error');
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
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 8 * 1024 * 1024) throw new ClaudeApiError('Responses input limit exceeded.');
  if (!Array.isArray(input)) return;
  if (input.length > 4096) throw new ClaudeApiError('Responses input limit exceeded.');
  const budget = new ResponsesReplayBudget();
  for (const item of input) {
    if (!isObject(item)) throw new ClaudeApiError('input items must be objects');
    if (item.type === 'reasoning' || item.type === 'function_call' && typeof item.arguments === 'string') {
      try {
        const parsed = parseResponsesReplayItem(item);
        if (!parsed) throw new Error();
        budget.add(parsed);
      } catch { throw new ClaudeApiError('Invalid reasoning input.', 400, 'invalid_request_error'); }
    }
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

async function* openAiResponsesStreamError(error: unknown, model: string): AsyncIterable<string> {
  const payload = mapErrorPayload(error);
  const openAiError = { message: payload.message, type: payload.type, code: null };
  yield `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { id: 'resp_failed', object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'failed', error: openAiError }, error: openAiError })}\n\n`;
  yield 'data: [DONE]\n\n';
}
