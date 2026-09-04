import packageJson from '../package.json' with { type: 'json' };
import type { ChatGptAccountQuota, ChatGptAdditionalQuotaLimit, ChatGptBackendClient, ChatGptBackendHealthCheckResult, ChatGptBackendRequestContext, ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptDiscoveredModel, ChatGptFinishReason, ChatGptInputContentPart, ChatGptInputItem, ChatGptModelControlCapabilities, ChatGptQuotaWindow, ChatGptReasoningLevelOption, ChatGptServiceTierOption, ChatGptSessionSecret, ChatGptToolCall, ChatGptUsage } from './client.js';
import type { ChatGptStreamEvent } from './events.js';
import { ChatGptBackendError, type ChatGptBackendErrorCode } from './errors.js';

export interface SessionChatGptBackendOptions {
  baseUrl: string;
  timeoutMs: number;
  clientVersion?: string;
  originator?: string;
  fetch?: typeof fetch;
}

const DEFAULT_CODEX_CLIENT_VERSION = packageJson.version;

type JsonObject = Record<string, unknown>;

export class SessionChatGptBackend implements ChatGptBackendClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly clientVersion: string;
  private readonly originator: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SessionChatGptBackendOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.clientVersion = options.clientVersion?.trim() || DEFAULT_CODEX_CLIENT_VERSION;
    this.originator = options.originator?.trim() || undefined;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listModels(context?: ChatGptBackendRequestContext): Promise<ChatGptDiscoveredModel[]> {
    if (!context?.account) return [];
    const secret = requireSessionSecret(context);
    const { response, payload } = await this.fetchJsonWithTimeout(
      this.backendApiEndpoint('/codex/models', { client_version: this.clientVersion }),
      { method: 'GET', headers: this.headers(secret, false) },
      context.signal,
      'ChatGPT models response was not valid JSON.',
    );
    if (!response.ok) throw httpBackendError('ChatGPT models discovery failed', response.status);
    return parseDiscoveredModels(payload);
  }

  async healthCheck(context?: ChatGptBackendRequestContext): Promise<ChatGptBackendHealthCheckResult> {
    try {
      await this.listModels(context);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async getAccountQuota(context?: ChatGptBackendRequestContext): Promise<ChatGptAccountQuota> {
    const secret = requireSessionSecret(context);
    const { response, payload } = await this.fetchJsonWithTimeout(
      this.backendApiEndpoint('/wham/usage'),
      { method: 'GET', headers: this.headers(secret, false, 'application/json') },
      context?.signal,
      'ChatGPT quota response was not valid JSON.',
    );
    if (!response.ok) throw httpBackendError('ChatGPT quota request failed', response.status);
    return normalizeAccountQuota(payload);
  }

  async complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse> {
    let text = '';
    let finishReason: ChatGptFinishReason = 'stop';
    let usage: ChatGptUsage | undefined;
    const toolCalls: ChatGptToolCall[] = [];
    for await (const event of this.stream(request, context)) {
      if (event.type === 'text_delta') text += event.text;
      if (event.type === 'tool_call') toolCalls.push(event.toolCall);
      if (event.type === 'done') {
        if (event.finishReason) finishReason = event.finishReason;
        if (event.usage) usage = event.usage;
      }
    }
    return { text, finishReason, ...(toolCalls.length ? { toolCalls } : {}), ...(usage ? { usage } : {}) };
  }

  async *stream(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): AsyncIterable<ChatGptStreamEvent> {
    validateSessionRequest(request);
    const secret = requireSessionSecret(context);
    const response = await this.fetchWithTimeout(this.backendApiEndpoint('/codex/responses'), {
      method: 'POST',
      headers: this.headers(secret, true),
      body: JSON.stringify(buildResponsesBody(request)),
    }, context?.signal);
    if (!response.ok) throw httpBackendError('ChatGPT responses request failed', response.status);

    let latestUsage: ChatGptUsage | undefined;
    for await (const data of iterateSseData(response)) {
      if (data === '[DONE]') break;
      const parsed = parseJson(data);
      if (!parsed) continue;
      latestUsage = mergeUsage(latestUsage, extractUsage(parsed));
      const delta = extractTextDelta(parsed);
      if (delta) yield { type: 'text_delta', text: delta };
      const toolCall = extractToolCall(parsed);
      if (toolCall) yield { type: 'tool_call', toolCall };
      if (isDoneEvent(parsed)) {
        yield { type: 'done', finishReason: extractFinishReason(parsed), ...(latestUsage ? { usage: latestUsage } : {}) };
        return;
      }
    }
    yield { type: 'done', finishReason: 'stop', ...(latestUsage ? { usage: latestUsage } : {}) };
  }

  private headers(secret: ChatGptSessionSecret, includeContentType: boolean, accept = 'text/event-stream'): Headers {
    const headers = new Headers();
    headers.set('authorization', `Bearer ${secret.accessToken}`);
    headers.set('accept', accept);
    if (includeContentType) headers.set('content-type', 'application/json');
    if (secret.cookie) headers.set('cookie', secret.cookie);
    if (secret.userAgent) headers.set('user-agent', secret.userAgent);
    if (secret.deviceId) headers.set('oai-device-id', secret.deviceId);
    if (secret.accountId) headers.set('chatgpt-account-id', secret.accountId);
    if (this.originator) headers.set('originator', this.originator);
    return headers;
  }

  private backendApiEndpoint(path: string, query?: Record<string, string>): string {
    const backendApiBase = this.baseUrl.endsWith('/backend-api') ? this.baseUrl : `${this.baseUrl}/backend-api`;
    const url = new URL(`${backendApiBase}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    return url.toString();
  }

  private fetchWithTimeout(url: string, init: RequestInit, callerSignal?: AbortSignal): Promise<Response> {
    return this.runWithTimeout((signal) => this.fetchResponse(url, init, signal), callerSignal);
  }

  private runWithTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
    if (callerSignal?.aborted) return Promise.reject(abortError());
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const cancel = () => controller.abort();
    callerSignal?.addEventListener('abort', cancel, { once: true });
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(callerSignal?.aborted
          ? abortError()
          : new ChatGptBackendError('ChatGPT session backend request timed out.', 'timeout', { status: 504 }));
      }, { once: true });
    });
    return Promise.race([operation(controller.signal), aborted]).catch((error) => {
      if (callerSignal?.aborted) throw abortError();
      if (timedOut) throw new ChatGptBackendError('ChatGPT session backend request timed out.', 'timeout', { status: 504, cause: error });
      throw error;
    }).finally(() => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', cancel);
    });
  }

  private async fetchResponse(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ChatGptBackendError('ChatGPT session backend network request failed.', 'network_error', { cause: error });
    }
  }

  private fetchJsonWithTimeout(url: string, init: RequestInit, callerSignal: AbortSignal | undefined, invalidResponseMessage: string): Promise<{ response: Response; payload?: unknown }> {
    return this.runWithTimeout(async (signal) => {
      const response = await this.fetchResponse(url, init, signal);
      if (!response.ok) return { response };
      try {
        return { response, payload: await response.json() };
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ChatGptBackendError(invalidResponseMessage, 'invalid_response', { status: 502, cause: error });
      }
    }, callerSignal);
  }
}

function normalizeAccountQuota(value: unknown): ChatGptAccountQuota {
  const raw = isPlainObject(value) ? value : {};
  const rateLimit = isPlainObject(raw.rate_limit) ? raw.rate_limit : {};
  const quota: ChatGptAccountQuota = {
    ...optionalString('providerAccountId', raw.account_id),
    ...optionalString('providerUserId', raw.user_id),
    ...optionalString('planType', raw.plan_type),
    ...optionalBoolean('allowed', rateLimit.allowed),
    ...optionalBoolean('limitReached', rateLimit.limit_reached),
    ...optionalString('rateLimitReachedType', rateLimitReachedType(raw.rate_limit_reached_type)),
    windows: normalizeQuotaWindows(rateLimit),
  };

  const additionalLimits = normalizeAdditionalQuotaLimits(raw.additional_rate_limits);
  if (additionalLimits.length) quota.additionalLimits = additionalLimits;
  const availableCount = nonNegativeNumber(isPlainObject(raw.rate_limit_reset_credits)
    ? raw.rate_limit_reset_credits.available_count
    : undefined);
  if (availableCount !== undefined) quota.resetCredits = { availableCount };
  return quota;
}

function normalizeAdditionalQuotaLimits(value: unknown): ChatGptAdditionalQuotaLimit[] {
  if (!Array.isArray(value)) return [];
  const limits: ChatGptAdditionalQuotaLimit[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const rateLimit = isPlainObject(item.rate_limit) ? item.rate_limit : {};
    limits.push({
      ...optionalString('meteredFeature', item.metered_feature),
      ...optionalString('limitName', item.limit_name),
      ...optionalBoolean('allowed', rateLimit.allowed),
      ...optionalBoolean('limitReached', rateLimit.limit_reached),
      ...optionalString('rateLimitReachedType', rateLimitReachedType(item.rate_limit_reached_type)),
      windows: normalizeQuotaWindows(rateLimit),
    });
  }
  return limits;
}

function normalizeQuotaWindows(rateLimit: JsonObject): ChatGptQuotaWindow[] {
  const windows: ChatGptQuotaWindow[] = [];
  for (const [position, value] of [
    ['primary', rateLimit.primary_window],
    ['secondary', rateLimit.secondary_window],
  ] as const) {
    if (!isPlainObject(value)) continue;
    const durationSeconds = positiveNumber(value.limit_window_seconds);
    const window: ChatGptQuotaWindow = {
      position,
      descriptor: quotaWindowDescriptor(position, durationSeconds),
      ...optionalNumber('usedPercent', percentage(value.used_percent)),
      ...optionalNumber('durationSeconds', durationSeconds),
      ...optionalNumber('resetAfterSeconds', nonNegativeNumber(value.reset_after_seconds)),
    };
    const resetAt = unixSecondsToIso(value.reset_at);
    if (resetAt !== undefined) window.resetAt = resetAt;
    windows.push(window);
  }
  return windows;
}

function quotaWindowDescriptor(position: ChatGptQuotaWindow['position'], durationSeconds: number | undefined): string {
  if (durationSeconds === 18_000) return 'five-hour';
  if (durationSeconds === 604_800) return 'weekly';
  return durationSeconds === undefined ? position : `${position}-${durationSeconds}-seconds`;
}

function rateLimitReachedType(value: unknown): unknown {
  return isPlainObject(value) ? value.type : undefined;
}

function optionalString<Key extends string>(key: Key, value: unknown): Partial<Record<Key, string>> {
  return typeof value === 'string' && value.length > 0 ? { [key]: value } as Record<Key, string> : {};
}

function optionalBoolean<Key extends string>(key: Key, value: unknown): Partial<Record<Key, boolean>> {
  return typeof value === 'boolean' ? { [key]: value } as Record<Key, boolean> : {};
}

function optionalNumber<Key extends string>(key: Key, value: number | undefined): Partial<Record<Key, number>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, number>;
}

function percentage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function unixSecondsToIso(value: unknown): string | undefined {
  const seconds = nonNegativeNumber(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function validateSessionRequest(request: ChatGptCompletionRequest): void {
  if (request.reasoningEffort?.trim().toLowerCase() === 'ultra') {
    throw new ChatGptBackendError(
      'The local-only reasoning effort "ultra" must be resolved to a target-supported upstream effort before calling the ChatGPT session backend.',
      'invalid_request',
      { status: 400 },
    );
  }
}

function httpBackendError(prefix: string, status: number): ChatGptBackendError {
  return new ChatGptBackendError(`${prefix}: HTTP ${status}`, backendErrorCodeForStatus(status), { status });
}

function backendErrorCodeForStatus(status: number): ChatGptBackendErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  return 'upstream_error';
}

function abortError(): Error {
  const error = new Error('ChatGPT session backend request was cancelled.');
  error.name = 'AbortError';
  return error;
}

function buildResponsesBody(request: ChatGptCompletionRequest): JsonObject {
  const body: JsonObject = {
    model: request.model,
    input: request.inputItems?.length ? request.inputItems.map(toResponsesInputItem) : request.messages.map((message) => ({ type: 'message', role: message.role, content: message.content })),
    stream: true,
    store: false,
    instructions: '',
    max_output_tokens: request.maxTokens,
  };
  applyResponsesBodyOptions(body, request.backendOptions?.responsesBody);
  if (request.reasoningEffort) body.reasoning = { effort: request.reasoningEffort };
  if (request.serviceTier) body.service_tier = request.serviceTier;
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (typeof request.topP === 'number') body.top_p = request.topP;
  if (request.stopSequences?.length) body.stop = request.stopSequences.length === 1 ? request.stopSequences[0] : request.stopSequences;
  const mappedTools = request.tools?.length ? request.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: tool.strict })) : [];
  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  if (mappedTools.length || rawTools.length) body.tools = [...mappedTools, ...rawTools];
  if (request.toolChoice) body.tool_choice = request.toolChoice.type === 'tool' ? { type: 'function', name: request.toolChoice.name } : request.toolChoice.type === 'any' ? 'required' : request.toolChoice.type;
  return body;
}

function applyResponsesBodyOptions(body: JsonObject, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as JsonObject;
  if (typeof raw.previous_response_id === 'string' || raw.previous_response_id === null) body.previous_response_id = raw.previous_response_id;
  if (raw.metadata === null || raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)) body.metadata = raw.metadata;
  if (typeof raw.parallel_tool_calls === 'boolean') body.parallel_tool_calls = raw.parallel_tool_calls;
  if (typeof raw.truncation === 'string') body.truncation = raw.truncation;
  if (raw.text && typeof raw.text === 'object' && !Array.isArray(raw.text)) body.text = raw.text;
  if (Array.isArray(raw.tools)) body.tools = raw.tools.map((tool) => isPlainObject(tool) ? { ...tool } : tool);
  if (body.tool_choice === undefined && isPlainObject(raw.tool_choice)) body.tool_choice = { ...raw.tool_choice };
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toResponsesInputItem(item: ChatGptInputItem): JsonObject {
  if (item.type === 'message') return { type: 'message', role: item.role, content: toResponsesContent(item.content) };
  if (item.type === 'function_call') return { type: 'function_call', call_id: item.callId, name: item.name, arguments: stringifyArguments(item.arguments) };
  return { type: 'function_call_output', call_id: item.callId, output: item.output };
}

function toResponsesContent(content: string | ChatGptInputContentPart[]): string | JsonObject[] {
  if (typeof content === 'string') return content;
  return content.map((part) => part.type === 'text'
    ? { type: 'input_text', text: part.text }
    : { type: 'input_image', image_url: part.imageUrl, ...(part.detail ? { detail: part.detail } : {}) });
}

function stringifyArguments(value: unknown): string {
  if (typeof value === 'string') return value || '{}';
  try { return JSON.stringify(value ?? {}); } catch { return String(value); }
}

function parseDiscoveredModels(value: unknown): ChatGptDiscoveredModel[] {
  const rawModels = readModelArray(value);
  if (!rawModels) return [];
  const ids = new Set<string>();
  const models: ChatGptDiscoveredModel[] = [];
  for (const item of rawModels) {
    const model = normalizeDiscoveredModel(item);
    if (!model || ids.has(model.id)) continue;
    ids.add(model.id);
    models.push(model);
  }
  return models;
}

function readModelArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as JsonObject;
  const candidates = [raw.models, raw.data, readPath(raw, ['body', 'models'])];
  return candidates.find((candidate): candidate is unknown[] => Array.isArray(candidate));
}

function normalizeDiscoveredModel(value: unknown): ChatGptDiscoveredModel | undefined {
  if (typeof value === 'string' && value.trim()) return { id: value.trim() };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as JsonObject;
  const id = readNonEmptyString(raw.id) ?? readNonEmptyString(raw.slug) ?? readNonEmptyString(raw.name) ?? readNonEmptyString(raw.model);
  if (!id) return undefined;
  const displayName = readNonEmptyString(raw.display_name) ?? readNonEmptyString(raw.displayName) ?? readNonEmptyString(raw.title) ?? readNonEmptyString(raw.name);
  const capabilities = isPlainObject(raw.capabilities) ? { ...raw.capabilities } : undefined;
  return {
    id,
    displayName,
    capabilities,
    controls: normalizeModelControls(raw, capabilities),
    raw,
  };
}

function normalizeModelControls(raw: JsonObject, capabilities: JsonObject | undefined): ChatGptModelControlCapabilities {
  const sources = [raw, capabilities].filter((source): source is JsonObject => Boolean(source));
  const supportedReasoningValue = firstDefined(sources, ['supported_reasoning_levels', 'supportedReasoningLevels']);
  const defaultReasoningValue = firstDefined(sources, ['default_reasoning_level', 'defaultReasoningLevel']);
  const supportedReasoning = normalizeReasoningOptions(supportedReasoningValue);
  const defaultEffort = readNonEmptyString(defaultReasoningValue);
  const multiAgent = firstDefined(sources, ['multi_agent_reasoning', 'multiAgentReasoning', 'multi_agent', 'multiAgent']);

  const serviceTiersValue = firstDefined(sources, ['service_tiers', 'serviceTiers']);
  const additionalSpeedTiersValue = firstDefined(sources, ['additional_speed_tiers', 'additionalSpeedTiers']);
  const serviceTiers = normalizeServiceTierOptions(serviceTiersValue, additionalSpeedTiersValue);
  const defaultTier = readNonEmptyString(firstDefined(sources, ['default_service_tier', 'defaultServiceTier']));
  const features = firstDefined(sources, ['features']);
  const fastMode = isPlainObject(features) && (features.fast_mode === true || features.fastMode === true);

  return {
    reasoning: {
      metadataKnown: Array.isArray(supportedReasoningValue) || defaultEffort !== undefined || multiAgent !== undefined,
      supported: supportedReasoning,
      defaultEffort,
      ...(multiAgent === undefined ? {} : { multiAgent }),
    },
    serviceTier: {
      metadataKnown: Array.isArray(serviceTiersValue) || Array.isArray(additionalSpeedTiersValue) || defaultTier !== undefined || fastMode,
      supported: serviceTiers,
      defaultTier,
      fastMode,
    },
  };
}

function firstDefined(sources: JsonObject[], keys: string[]): unknown {
  for (const source of sources) {
    for (const key of keys) {
      if (source[key] !== undefined) return source[key];
    }
  }
  return undefined;
}

function normalizeReasoningOptions(value: unknown): ChatGptReasoningLevelOption[] {
  if (!Array.isArray(value)) return [];
  const result: ChatGptReasoningLevelOption[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const raw = typeof item === 'string' ? { effort: item } : isPlainObject(item) ? item : undefined;
    const effort = readNonEmptyString(raw?.effort);
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    const description = readNonEmptyString(raw?.description);
    result.push({ effort, ...(description ? { description } : {}) });
  }
  return result;
}

function normalizeServiceTierOptions(serviceTiersValue: unknown, additionalSpeedTiersValue: unknown): ChatGptServiceTierOption[] {
  const result: ChatGptServiceTierOption[] = [];
  const seen = new Set<string>();
  const append = (item: unknown) => {
    const raw = typeof item === 'string' ? { id: item } : isPlainObject(item) ? item : undefined;
    const id = readNonEmptyString(raw?.id) ?? readNonEmptyString(raw?.tier);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const name = readNonEmptyString(raw?.name);
    const description = readNonEmptyString(raw?.description);
    result.push({ id, ...(name ? { name } : {}), ...(description ? { description } : {}) });
  };
  if (Array.isArray(serviceTiersValue)) serviceTiersValue.forEach(append);
  if (Array.isArray(additionalSpeedTiersValue)) additionalSpeedTiersValue.forEach(append);
  return result;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireSessionSecret(context?: ChatGptBackendRequestContext): ChatGptSessionSecret {
  const account = context?.account;
  if (!account) throw new Error('ChatGPT session backend requires an account context.');
  if (account.provider && account.provider !== 'chatgpt-session') throw new Error(`ChatGPT session backend requires a chatgpt-session account, got ${account.provider}.`);
  const secret = account.secret;
  if (!secret || secret.type !== 'chatgpt-session') throw new Error(`ChatGPT session account ${account.id} is missing a chatgpt-session secret.`);
  if (!secret.accessToken?.trim()) throw new Error(`ChatGPT session account ${account.id} is missing secret.accessToken.`);
  return secret;
}

async function* iterateSseData(response: Response): AsyncIterable<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drainSseBuffer(buffer, (next) => { buffer = next; });
    }
  } finally {
    reader.releaseLock();
  }
  buffer += decoder.decode();
  yield* drainSseBuffer(`${buffer}\n\n`, (next) => { buffer = next; });
}

function* drainSseBuffer(buffer: string, setBuffer: (value: string) => void): Iterable<string> {
  let boundary = findSseFrameBoundary(buffer);
  while (boundary) {
    const frame = buffer.slice(0, boundary.index);
    buffer = buffer.slice(boundary.index + boundary.length);
    const data = frame.split(/\r?\n/)
      .map((line) => line.startsWith('data:') ? line.slice(5).trimStart() : undefined)
      .filter((line): line is string => line !== undefined)
      .join('\n')
      .trim();
    if (data) yield data;
    boundary = findSseFrameBoundary(buffer);
  }
  setBuffer(buffer);
}

function findSseFrameBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseJson(data: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : undefined;
  } catch {
    return undefined;
  }
}

function extractTextDelta(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const object = value as JsonObject;
  const candidates = [
    object.output_text_delta,
    object.delta,
    object.text,
    object.content,
    readPath(object, ['message', 'delta', 'content']),
    readPath(object, ['message', 'content']),
    readPath(object, ['response', 'output_text_delta']),
    readPath(object, ['item', 'content']),
    readPath(object, ['data', 'output_text_delta']),
  ];
  for (const candidate of candidates) {
    const text = normalizeTextCandidate(candidate);
    if (text) return text;
  }
  return undefined;
}

function normalizeTextCandidate(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(normalizeTextCandidate).filter((item): item is string => Boolean(item)).join('') || undefined;
  if (value && typeof value === 'object') {
    const raw = value as JsonObject;
    return normalizeTextCandidate(raw.text ?? raw.content ?? raw.value);
  }
  return undefined;
}

function extractToolCall(value: unknown): ChatGptToolCall | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as JsonObject;
  const candidates = [object.tool_call, object.toolCall, object.function_call, readPath(object, ['delta', 'tool_calls', '0']), readPath(object, ['message', 'tool_calls', '0']), readPath(object, ['item'])];
  for (const candidate of candidates) {
    const toolCall = normalizeToolCall(candidate);
    if (toolCall) return toolCall;
  }
  return undefined;
}

function normalizeToolCall(value: unknown): ChatGptToolCall | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as JsonObject;
  const functionObject = raw.function && typeof raw.function === 'object' && !Array.isArray(raw.function) ? raw.function as JsonObject : undefined;
  const id = readNonEmptyString(raw.id) ?? readNonEmptyString(raw.call_id) ?? readNonEmptyString(raw.tool_call_id);
  const name = readNonEmptyString(raw.name) ?? readNonEmptyString(functionObject?.name);
  if (!name) return undefined;
  const rawInput = raw.input ?? raw.arguments ?? functionObject?.arguments ?? {};
  return { id: id ?? `call_${name}`, name, input: parseToolInput(rawInput) };
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function extractFinishReason(value: JsonObject): ChatGptFinishReason | undefined {
  return readNonEmptyString(value.finish_reason) ?? readNonEmptyString(value.finishReason) ?? readNonEmptyString(readPath(value, ['response', 'finish_reason'])) ?? (isDoneEvent(value) ? 'stop' : undefined);
}

function extractUsage(value: JsonObject): ChatGptUsage | undefined {
  const candidates = [value.usage, readPath(value, ['response', 'usage']), readPath(value, ['body', 'usage']), value.token_usage, value.tokenUsage];
  for (const candidate of candidates) {
    const usage = normalizeUsage(candidate);
    if (usage) return usage;
  }
  return undefined;
}

function normalizeUsage(value: unknown): ChatGptUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as JsonObject;
  const usage: ChatGptUsage = {
    inputTokens: readTokenCount(raw.input_tokens) ?? readTokenCount(raw.prompt_tokens),
    outputTokens: readTokenCount(raw.output_tokens) ?? readTokenCount(raw.completion_tokens),
    totalTokens: readTokenCount(raw.total_tokens),
    raw,
  };
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.totalTokens !== undefined ? usage : undefined;
}

function mergeUsage(current: ChatGptUsage | undefined, next: ChatGptUsage | undefined): ChatGptUsage | undefined {
  if (!next) return current;
  if (!current) return next;
  return {
    inputTokens: next.inputTokens ?? current.inputTokens,
    outputTokens: next.outputTokens ?? current.outputTokens,
    totalTokens: next.totalTokens ?? current.totalTokens,
    raw: next.raw ?? current.raw,
  };
}

function readTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readPath(value: JsonObject, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as JsonObject)[segment];
  }
  return current;
}

function isDoneEvent(value: JsonObject): boolean {
  const type = value.type;
  return type === 'done' || type === 'response.completed' || type === 'message_stop' || value.done === true;
}
