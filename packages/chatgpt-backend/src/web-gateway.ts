import { isDeepStrictEqual, TextDecoder } from 'node:util';
import type {
  ChatGptBackendClient, ChatGptBackendHealthCheckResult, ChatGptBackendRequestContext,
  ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptDiscoveredModel,
  ChatGptFinishReason, ChatGptInputContentPart, ChatGptToolCall, ChatGptUsage,
} from './client.js';
import type { ChatGptStreamEvent } from './events.js';
import { ChatGptBackendError, type ChatGptBackendErrorCode } from './errors.js';
import { canonicalToolArguments } from './json-arguments.js';
import { checkWebGatewayConnection } from './web-gateway-health.js';

export interface WebGatewayConfiguration {
  baseUrl: string;
  apiKey?: string;
  /** Exact IDs accepted by the separately operated gateway. */
  models: string[];
  supportsTools?: boolean;
  /** Explicit false excludes tools requiring strict JSON Schema enforcement. */
  supportsStrictTools?: boolean;
  /** Opt in only when every configured gateway model accepts user image input. */
  supportsImages?: boolean;
}

export interface WebGatewayChatGptBackendOptions {
  getConfiguration: () => WebGatewayConfiguration | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type JsonObject = Record<string, unknown>;
type WireContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };
type WireMessage = { role: string; content: string | WireContentPart[] | null; tool_call_id?: string; tool_calls?: JsonObject[] };
type Lifetime = ReturnType<typeof requestLifetime>;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_TOOLS = 128;
const MAX_IMAGE_URL_CHARS = 8192;
const FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'refusal']);
const webGatewayBackendErrors = new WeakSet<Error>();

/** Runtime-only provenance; no extra fields enter serialized client errors. */
export function isWebGatewayBackendError(value: unknown): boolean {
  return value instanceof ChatGptBackendError && webGatewayBackendErrors.has(value);
}

export function configuredWebGatewayModels(configuration: WebGatewayConfiguration | undefined): ChatGptDiscoveredModel[] {
  return (configuration?.models ?? []).map((id) => ({
    id,
    capabilities: { tools: configuration?.supportsTools === true, vision: configuration?.supportsImages === true,
      input_image: configuration?.supportsImages === true, input_modalities: configuration?.supportsImages === true ? ['text', 'image'] : ['text'] },
    controls: {
      reasoning: { metadataKnown: true, supported: [] },
      serviceTier: { metadataKnown: true, supported: [], fastMode: false },
    },
  }));
}

/** Uses the same validation as generation, without contacting the gateway. */
export function supportsWebGatewayRequest(request: ChatGptCompletionRequest, configuration: WebGatewayConfiguration | undefined): boolean {
  if (!configuration) return false;
  try { endpoint(configuration, '/chat/completions'); requestBody(request, configuration, false); return true; }
  catch { return false; }
}

/** OpenAI Chat Completions transport for a separately authenticated web gateway. */
export class WebGatewayChatGptBackend implements ChatGptBackendClient {
  private readonly getConfiguration: WebGatewayChatGptBackendOptions['getConfiguration'];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: WebGatewayChatGptBackendOptions) {
    this.getConfiguration = options.getConfiguration;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw invalidRequest('Invalid web gateway timeout.');
  }

  async listModels(_context?: ChatGptBackendRequestContext): Promise<ChatGptDiscoveredModel[]> {
    return configuredWebGatewayModels(this.configuration());
  }

  async healthCheck(context?: ChatGptBackendRequestContext): Promise<ChatGptBackendHealthCheckResult> {
    try {
      const connection = await checkWebGatewayConnection({
        configuration: this.getConfiguration(), fetch: this.fetchImpl, timeoutMs: this.timeoutMs, signal: context?.signal,
      });
      return connection.state === 'reachable' ? { ok: true } : { ok: false, message: 'Web gateway connection could not be confirmed.' };
    } catch {
      if (context?.signal?.aborted) throw abortError();
      return { ok: false, message: 'Web gateway connection could not be confirmed.' };
    }
  }

  async complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse> {
    let text = '';
    let refusal = '';
    const toolCalls: ChatGptToolCall[] = [];
    let terminal: Extract<ChatGptStreamEvent, { type: 'done' }> | undefined;
    for await (const event of this.execute(request, false, context)) {
      if (event.type === 'text_delta') text += event.text;
      else if (event.type === 'refusal_delta') refusal += event.text;
      else if (event.type === 'tool_call') toolCalls.push(event.toolCall);
      else if (event.type === 'done') terminal = event;
    }
    if (!terminal) throw invalidResponse();
    return {
      text, finishReason: terminal.finishReason ?? 'stop', terminalSuccessful: true,
      ...(refusal ? { refusal } : {}), ...(toolCalls.length ? { toolCalls } : {}),
      ...(terminal.usage ? { usage: terminal.usage } : {}),
    };
  }

  stream(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): AsyncIterable<ChatGptStreamEvent> {
    return this.execute(request, true, context);
  }

  private configuration(): WebGatewayConfiguration {
    const value = this.getConfiguration();
    if (!value || !Array.isArray(value.models) || !value.models.length || value.models.length > 256
      || value.models.some((id) => typeof id !== 'string' || !id || id.length > 256 || id.trim() !== id)
      || new Set(value.models).size !== value.models.length
      || value.apiKey !== undefined && (typeof value.apiKey !== 'string' || /[\r\n]/.test(value.apiKey))
      || value.supportsTools !== undefined && typeof value.supportsTools !== 'boolean'
      || value.supportsStrictTools !== undefined && typeof value.supportsStrictTools !== 'boolean'
      || value.supportsImages !== undefined && typeof value.supportsImages !== 'boolean') {
      throw invalidRequest('Web gateway is not configured correctly.');
    }
    // Validate before any request. URL credentials and query parameters never reach fetch.
    endpoint(value, '/models');
    return { baseUrl: value.baseUrl, apiKey: value.apiKey, models: [...value.models], supportsTools: value.supportsTools, supportsStrictTools: value.supportsStrictTools, supportsImages: value.supportsImages };
  }

  private async fetchResponse(url: string, init: RequestInit, lifetime: Lifetime): Promise<Response> {
    return lifetime.run(() => this.fetchImpl(url, { ...init, redirect: 'error', credentials: 'omit', signal: lifetime.signal }).then((response) => {
      if (lifetime.signal.aborted) cancelBody(response);
      return response;
    }));
  }

  private async *execute(request: ChatGptCompletionRequest, stream: boolean, context?: ChatGptBackendRequestContext): AsyncIterable<ChatGptStreamEvent> {
    let lifetime: Lifetime | undefined;
    let response: Response | undefined;
    try {
      const configuration = this.configuration();
      const body = requestBody(request, configuration, stream);
      lifetime = requestLifetime(this.timeoutMs, context?.signal);
      response = await this.fetchResponse(endpoint(configuration, '/chat/completions'), {
        method: 'POST', headers: gatewayHeaders(configuration, true), body,
      }, lifetime);
      if (!response.ok) throw httpError(response.status);
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (contentType === 'text/event-stream') {
        yield* decodeStream(response, lifetime, configuration.supportsTools === true);
      } else if (contentType === 'application/json' || contentType?.endsWith('+json')) {
        const result = parseCompletion(parseJson(await readBody(response, lifetime)), configuration.supportsTools === true);
        lifetime.check();
        yield { type: 'upstream_ready' };
        lifetime.check();
        if (result.text) yield { type: 'text_delta', text: result.text };
        lifetime.check();
        if (result.refusal) yield { type: 'refusal_delta', text: result.refusal };
        for (const toolCall of result.toolCalls ?? []) { lifetime.check(); yield { type: 'tool_call', toolCall }; }
        lifetime.check();
        yield { type: 'done', terminalSuccessful: true, finishReason: result.finishReason, ...(result.usage ? { usage: result.usage } : {}) };
      } else throw invalidResponse();
    } catch (error) {
      throw safeError(error, lifetime, context?.signal);
    } finally {
      cancelBody(response);
      lifetime?.dispose();
    }
  }
}

function endpoint(configuration: WebGatewayConfiguration, suffix: string): string {
  let url: URL;
  try { url = new URL(configuration.baseUrl); } catch { throw invalidRequest('Invalid web gateway address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalidRequest('Invalid web gateway address.');
  const base = url.href.replace(/\/+$/, '');
  return `${base.endsWith('/v1') ? base : `${base}/v1`}${suffix}`;
}

function gatewayHeaders(configuration: WebGatewayConfiguration, json: boolean): Headers {
  const headers = new Headers({ accept: json ? 'application/json, text/event-stream' : 'application/json' });
  if (json) headers.set('content-type', 'application/json');
  if (configuration.apiKey) headers.set('authorization', `Bearer ${configuration.apiKey}`);
  return headers;
}

function requestBody(request: ChatGptCompletionRequest, configuration: WebGatewayConfiguration, stream: boolean): string {
  if (!configuration.models.includes(request.model)) throw invalidRequest('Model is not configured for the web gateway.');
  if (request.reasoningExecution || request.reasoningEffort !== undefined && !['none', 'default', 'auto'].includes(request.reasoningEffort)
    || [request.serviceTier, request.speedPreference].some((value) => value !== undefined && !['default', 'standard', 'auto'].includes(value))) {
    throw invalidRequest('Web gateway does not support reasoning or service tier controls.');
  }
  const forwarded = gatewayRequestOptions(request);
  if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0) throw invalidRequest('Invalid web gateway token limit.');
  const usesTools = !!request.tools?.length || !!request.toolChoice && request.toolChoice.type !== 'none'
    || forwarded.parallelToolCalls === true || request.inputItems?.some((item) => item.type === 'function_call' || item.type === 'function_call_output'
      || item.type === 'replay' && item.item.type === 'function_call');
  if (usesTools && !configuration.supportsTools) throw invalidRequest('Web gateway tool support is disabled.');
  if (configuration.supportsStrictTools === false && request.tools?.some(tool => tool.strict === true)) {
    throw invalidRequest('Web gateway does not support strict tool schemas.');
  }
  if ((request.tools?.length ?? 0) > MAX_TOOLS) throw invalidRequest('Too many web gateway tools.');
  const messages: WireMessage[] = [];
  if (request.inputItems !== undefined) {
    for (const item of request.inputItems) {
      if (item.type === 'replay') {
        // Responses represents even ordinary, visible function-call history as a
        // replay item. Project only that public tool contract; reasoning ciphertext
        // and provider-specific execution semantics must never leave for a gateway.
        const call = item.item;
        if (call.type !== 'function_call' || call.status !== undefined && call.status !== 'completed'
          || call.async === true || call.namespace !== undefined || call.caller !== undefined && call.caller !== null && call.caller.type !== 'direct') {
          throw invalidRequest('Web gateway does not support native replay.');
        }
        appendToolCall(messages, call.call_id, call.name, call.arguments);
      } else if (item.type === 'message') messages.push({ role: item.role, content: gatewayContent(item.content, item.role, configuration) });
      else if (item.type === 'function_call') {
        appendToolCall(messages, item.callId, item.name, item.arguments);
      } else if (item.type === 'function_call_output') {
        if (!validIdentifier(item.callId)) throw invalidRequest('Invalid web gateway tool result.');
        messages.push({ role: 'tool', tool_call_id: item.callId, content: gatewayContent(item.output, 'tool', configuration) });
      } else throw invalidRequest('Unsupported web gateway input.');
    }
  } else {
    for (const message of request.messages) messages.push({ role: message.role, content: gatewayContent(message.content, message.role, configuration) });
  }
  if (!messages.length) throw invalidRequest('Web gateway requires a message.');
  const body: JsonObject = { model: request.model, messages, max_tokens: request.maxTokens, stream };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.stopSequences !== undefined) body.stop = request.stopSequences;
  if (forwarded.metadata !== undefined) body.metadata = forwarded.metadata;
  if (forwarded.parallelToolCalls !== undefined) body.parallel_tool_calls = forwarded.parallelToolCalls;
  if (configuration.supportsTools) {
    if (request.tools?.length) body.tools = request.tools.map((tool) => {
      if (!validIdentifier(tool.name) || !isObject(tool.inputSchema)) throw invalidRequest('Invalid web gateway tool definition.');
      return { type: 'function', function: { name: tool.name, parameters: tool.inputSchema, ...(tool.description === undefined ? {} : { description: tool.description }), ...(tool.strict === undefined ? {} : { strict: tool.strict }) } };
    });
    if (request.toolChoice) body.tool_choice = request.toolChoice.type === 'tool'
      ? { type: 'function', function: { name: request.toolChoice.name } }
      : request.toolChoice.type === 'any' ? 'required' : request.toolChoice.type;
  }
  let serialized: string;
  try { serialized = JSON.stringify(body); } catch { throw invalidRequest('Invalid web gateway request.'); }
  if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) throw invalidRequest('Web gateway request is too large.');
  return serialized;
}

/** Ordinary Chat fields may arrive through different protocol projections.
 * Equal repeated values are accepted; conflicting sources are rejected rather
 * than choosing a protocol-specific precedence. Native options remain closed.
 */
function gatewayRequestOptions(request: ChatGptCompletionRequest): { metadata?: Record<string, string> | null; parallelToolCalls?: boolean } {
  const options = optionObject(request.backendOptions, ['mappingDiagnostics', 'claudeRequest', 'responsesBody']);
  const claude = optionObject(options.claudeRequest, ['metadata', 'service_tier']);
  const responses = optionObject(options.responsesBody, ['metadata', 'parallel_tool_calls', 'previous_response_id']);
  if (responses.previous_response_id !== undefined && responses.previous_response_id !== null) throw invalidRequest('Web gateway previous response history must be expanded locally.');

  let metadata: Record<string, string> | null | undefined;
  for (const value of [claude.metadata, responses.metadata]) {
    if (value === undefined) continue;
    if (value !== null && (!isObject(value) || Object.values(value).some((entry) => typeof entry !== 'string'))) throw invalidRequest('Web gateway metadata must be an object of strings or null.');
    if (metadata !== undefined && !isDeepStrictEqual(metadata, value)) throw invalidRequest('Conflicting web gateway metadata.');
    metadata = value as Record<string, string> | null;
  }

  let parallelToolCalls: boolean | undefined;
  for (const value of [request.parallelToolCalls, responses.parallel_tool_calls]) {
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw invalidRequest('Web gateway parallel_tool_calls must be a boolean.');
    if (parallelToolCalls !== undefined && parallelToolCalls !== value) throw invalidRequest('Conflicting web gateway parallel_tool_calls.');
    parallelToolCalls = value;
  }

  let serviceTier: string | undefined;
  for (const value of [request.serviceTier, request.speedPreference, claude.service_tier]) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !['auto', 'default', 'standard'].includes(value)) throw invalidRequest('Web gateway does not support service tier controls.');
    const normalized = value === 'standard' ? 'default' : value;
    if (serviceTier !== undefined && serviceTier !== normalized) throw invalidRequest('Conflicting web gateway service tier controls.');
    serviceTier = normalized;
  }
  return { ...(metadata === undefined ? {} : { metadata }), ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }) };
}

function optionObject(value: unknown, allowed: string[]): JsonObject {
  if (value === undefined) return {};
  if (!isObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw invalidRequest('Web gateway does not support native backend options.');
  return value;
}

function appendToolCall(messages: WireMessage[], callId: string, name: string, args: unknown): void {
  if (!validIdentifier(callId) || !validIdentifier(name)) throw invalidRequest('Invalid web gateway tool call.');
  const call = { id: callId, type: 'function', function: { name, arguments: argumentsString(args, false) } };
  const previous = messages.at(-1);
  if (previous?.role === 'assistant') (previous.tool_calls ??= []).push(call);
  else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
}

function gatewayContent(content: string | ChatGptInputContentPart[], role: string, configuration: WebGatewayConfiguration): string | WireContentPart[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw invalidRequest('Invalid web gateway message content.');
  let hasImages = false;
  const parts: WireContentPart[] = content.map((part) => {
    if (!isObject(part)) throw invalidRequest('Invalid web gateway message content.');
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part.type !== 'image') throw invalidRequest('Unsupported web gateway message content.');
    if (configuration.supportsImages !== true) throw invalidRequest('Web gateway image input support is disabled.');
    // Chat Completions only permits image_url parts on user messages. Tool
    // outputs must not silently discard images or move them into another role.
    if (role !== 'user') throw invalidRequest('Web gateway images are only supported in user messages.');
    const url = imageUrl(part.imageUrl);
    if (part.detail !== undefined && !['auto', 'low', 'high'].includes(part.detail as string)) throw invalidRequest('Invalid web gateway image detail.');
    hasImages = true;
    return { type: 'image_url', image_url: { url, ...(part.detail === undefined ? {} : { detail: part.detail as 'auto' | 'low' | 'high' }) } };
  });
  return hasImages ? parts : parts.map((part) => part.type === 'text' ? part.text : '').join('');
}

function imageUrl(value: unknown): string {
  const fail = () => invalidRequest('Invalid web gateway image URL.');
  if (typeof value !== 'string' || !value || value.length > MAX_BODY_BYTES || /[\u0000-\u0020\u007f]/.test(value)) throw fail();
  if (value.startsWith('data:')) {
    const prefix = /^data:image\/(?:png|jpeg|webp|gif);base64,/.exec(value)?.[0];
    if (!prefix) throw fail();
    const encoded = value.slice(prefix.length);
    // Buffer's base64 decoder accepts malformed input, so validate both grammar
    // and canonical encoding. The final serialized body shares the 16 MiB cap.
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
      || Buffer.from(encoded, 'base64').toString('base64') !== encoded) throw fail();
    return value;
  }
  if (value.length > MAX_IMAGE_URL_CHARS || value.trim() !== value) throw fail();
  let url: URL;
  try { url = new URL(value); } catch { throw fail(); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) throw fail();
  // Forward the original signed URL without downloading or resolving its host.
  return value;
}

function parseCompletion(payload: unknown, supportsTools: boolean): ChatGptCompletionResponse {
  if (!isObject(payload) || payload.error !== undefined || !Array.isArray(payload.choices) || payload.choices.length !== 1) throw invalidResponse();
  const choice = payload.choices[0];
  if (!isObject(choice) || choice.index !== undefined && choice.index !== 0 || !isObject(choice.message)) throw invalidResponse();
  const message = choice.message;
  if (message.role !== 'assistant' || message.content !== undefined && message.content !== null && typeof message.content !== 'string'
    || message.refusal !== undefined && message.refusal !== null && typeof message.refusal !== 'string') throw invalidResponse();
  const toolCalls = parseToolCalls(message.tool_calls, supportsTools);
  const finishReason = finishReasonValue(choice.finish_reason, toolCalls.length);
  if (message.content === undefined && message.refusal === undefined && !toolCalls.length) throw invalidResponse();
  return { text: typeof message.content === 'string' ? message.content : '', finishReason, terminalSuccessful: true,
    ...(typeof message.refusal === 'string' && message.refusal ? { refusal: message.refusal } : {}),
    ...(toolCalls.length ? { toolCalls } : {}), ...(payload.usage === undefined || payload.usage === null ? {} : { usage: parseUsage(payload.usage) }) };
}

function parseToolCalls(value: unknown, supportsTools: boolean): ChatGptToolCall[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TOOLS || value.length && !supportsTools) throw invalidResponse();
  const ids = new Set<string>();
  return value.map((raw) => {
    if (!isObject(raw) || raw.type !== 'function' || !validIdentifier(raw.id) || ids.has(raw.id) || !isObject(raw.function)
      || !validIdentifier(raw.function.name) || typeof raw.function.arguments !== 'string') throw invalidResponse();
    ids.add(raw.id);
    const rawArguments = argumentsString(raw.function.arguments, true);
    return { id: raw.id, name: raw.function.name, input: JSON.parse(rawArguments) as unknown, rawArguments };
  });
}

function argumentsString(value: unknown, response: boolean): string {
  try {
    const source = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_FRAME_BYTES) throw new Error();
    canonicalToolArguments(source);
    return source;
  } catch { throw response ? invalidResponse() : invalidRequest('Invalid web gateway tool arguments.'); }
}

function finishReasonValue(value: unknown, toolCount: number): ChatGptFinishReason {
  if (typeof value !== 'string' || !FINISH_REASONS.has(value) || (value === 'tool_calls') !== (toolCount > 0)) throw invalidResponse();
  return value;
}

function parseUsage(value: unknown): ChatGptUsage {
  if (!isObject(value)) throw invalidResponse();
  const usage: ChatGptUsage = {};
  for (const [source, target] of [['prompt_tokens', 'inputTokens'], ['completion_tokens', 'outputTokens'], ['total_tokens', 'totalTokens']] as const) {
    if (value[source] === undefined) continue;
    if (typeof value[source] !== 'number' || !Number.isSafeInteger(value[source]) || value[source] < 0) throw invalidResponse();
    usage[target] = value[source];
  }
  return usage;
}

async function* decodeStream(response: Response, lifetime: Lifetime, supportsTools: boolean): AsyncIterable<ChatGptStreamEvent> {
  const tools = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason: ChatGptFinishReason | undefined;
  let usage: ChatGptUsage | undefined;
  let ready = false;
  for await (const data of sseFrames(response, lifetime)) {
    if (data === '[DONE]') {
      if (!finishReason) throw invalidResponse();
      const toolCalls = parseToolCalls([...tools].sort(([left], [right]) => left - right).map(([, tool]) => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } })), supportsTools);
      finishReasonValue(finishReason, toolCalls.length);
      for (const toolCall of toolCalls) { lifetime.check(); yield { type: 'tool_call', toolCall }; }
      lifetime.check();
      yield { type: 'done', terminalSuccessful: true, finishReason, ...(usage ? { usage } : {}) };
      return;
    }
    const payload = parseJson(data);
    if (!isObject(payload) || payload.error !== undefined || !Array.isArray(payload.choices) || payload.choices.length > 1) throw invalidResponse();
    if (payload.usage !== undefined && payload.usage !== null) usage = parseUsage(payload.usage);
    if (!payload.choices.length) {
      if (!finishReason || payload.usage === undefined) throw invalidResponse();
      continue;
    }
    const choice = payload.choices[0];
    if (!isObject(choice) || choice.index !== 0 || !isObject(choice.delta) || finishReason) throw invalidResponse();
    const delta = choice.delta;
    if (delta.role !== undefined && delta.role !== 'assistant'
      || delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string'
      || delta.refusal !== undefined && delta.refusal !== null && typeof delta.refusal !== 'string') throw invalidResponse();
    if (delta.tool_calls !== undefined) {
      if (!supportsTools || !Array.isArray(delta.tool_calls) || delta.tool_calls.length > MAX_TOOLS) throw invalidResponse();
      for (const raw of delta.tool_calls) {
        if (!isObject(raw) || !Number.isSafeInteger(raw.index) || (raw.index as number) < 0 || (raw.index as number) >= MAX_TOOLS
          || raw.type !== undefined && raw.type !== 'function' || raw.id !== undefined && !validIdentifier(raw.id)
          || raw.function !== undefined && !isObject(raw.function)) throw invalidResponse();
        const tool = tools.get(raw.index as number) ?? { id: '', name: '', arguments: '' };
        if (typeof raw.id === 'string') { if (tool.id && tool.id !== raw.id) throw invalidResponse(); tool.id = raw.id; }
        if (isObject(raw.function)) {
          if (raw.function.name !== undefined && typeof raw.function.name !== 'string' || raw.function.arguments !== undefined && typeof raw.function.arguments !== 'string') throw invalidResponse();
          tool.name += typeof raw.function.name === 'string' ? raw.function.name : '';
          tool.arguments += typeof raw.function.arguments === 'string' ? raw.function.arguments : '';
        }
        if (tool.name.length > 256 || Buffer.byteLength(tool.arguments) > MAX_FRAME_BYTES) throw invalidResponse();
        tools.set(raw.index as number, tool);
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = finishReasonValue(choice.finish_reason, tools.size);
    lifetime.check();
    if (!ready) { ready = true; yield { type: 'upstream_ready' }; }
    lifetime.check();
    if (typeof delta.content === 'string' && delta.content) yield { type: 'text_delta', text: delta.content };
    lifetime.check();
    if (typeof delta.refusal === 'string' && delta.refusal) yield { type: 'refusal_delta', text: delta.refusal };
  }
  // EOF is not an OpenAI completion marker, even after a finish_reason chunk.
  throw invalidResponse();
}

async function* sseFrames(response: Response, lifetime: Lifetime): AsyncIterable<string> {
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let total = 0;
  let first = true;
  try {
    while (true) {
      const { done, value } = await lifetime.run(() => reader.read());
      let text = decodeUtf8(decoder, done ? undefined : value, !done);
      if (first && text) { text = text.replace(/^\uFEFF/, ''); first = false; }
      if (value) total += value.byteLength;
      if (total > MAX_BODY_BYTES) throw invalidResponse();
      buffer += text;
      // Retain a trailing CR until the next read so a split CRLF stays one newline.
      buffer = buffer.replace(/\r\n/g, '\n').replace(done ? /\r/g : /\r(?!$)/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw invalidResponse();
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) yield data;
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) throw invalidResponse();
      if (done) {
        // An unterminated frame must never manufacture a successful [DONE].
        if (buffer.trim()) throw invalidResponse();
        return;
      }
    }
  } finally { cancelReader(reader); }
}

async function readBody(response: Response, lifetime: Lifetime): Promise<string> {
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const result = await lifetime.run(() => reader.read());
      if (result.done) return text + decodeUtf8(decoder);
      bytes += result.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw invalidResponse();
      text += decodeUtf8(decoder, result.value, true);
    }
  } finally { cancelReader(reader); }
}

function requestLifetime(timeoutMs: number, caller?: AbortSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(abortError());
  const timer = setTimeout(() => controller.abort(new ChatGptBackendError('Web gateway request timed out.', 'timeout', { status: 504 })), timeoutMs);
  caller?.addEventListener('abort', cancel, { once: true });
  if (caller?.aborted) cancel();
  return {
    signal: controller.signal,
    check() { if (controller.signal.aborted) throw controller.signal.reason; },
    dispose() { clearTimeout(timer); caller?.removeEventListener('abort', cancel); },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (controller.signal.aborted) throw controller.signal.reason;
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const result = await Promise.race([operation(), aborted]);
        if (controller.signal.aborted) throw controller.signal.reason;
        return result;
      } finally { controller.signal.removeEventListener('abort', onAbort); }
    },
  };
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try { void reader.cancel().catch(() => {}); } catch { /* Cleanup cannot expose a provider error. */ }
  try { reader.releaseLock(); } catch { /* Pending reads settle after cancellation. */ }
}

function cancelBody(response?: Response): void {
  try { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); } catch { /* Best effort. */ }
}

function safeError(error: unknown, lifetime?: Lifetime, caller?: AbortSignal): Error {
  if (caller?.aborted) return abortError();
  const safe = lifetime?.signal.aborted ? lifetime.signal.reason as Error
    : error instanceof ChatGptBackendError ? error : new ChatGptBackendError('Web gateway request failed.', 'network_error');
  if (safe instanceof ChatGptBackendError) webGatewayBackendErrors.add(safe);
  return safe;
}

function httpError(status: number): ChatGptBackendError {
  const code: ChatGptBackendErrorCode = status === 401 || status === 403 ? 'unauthorized' : status === 429 ? 'rate_limited'
    : status === 400 || status === 404 || status === 422 ? 'invalid_request' : 'upstream_error';
  return new ChatGptBackendError(`Web gateway request failed: HTTP ${status}.`, code, { status, safeDiagnostic: { httpStatus: status, failurePhase: 'response_headers' } });
}

function invalidRequest(message: string): ChatGptBackendError { return new ChatGptBackendError(message, 'invalid_request', { status: 400 }); }
function invalidResponse(): ChatGptBackendError { return new ChatGptBackendError('Web gateway returned an invalid or incomplete response.', 'invalid_response', { status: 502 }); }
function abortError(): Error { const error = new Error('Web gateway request was cancelled.'); error.name = 'AbortError'; return error; }
function isObject(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validIdentifier(value: unknown): value is string { return typeof value === 'string' && !!value && value.length <= 256 && !/[\u0000-\u0020]/.test(value); }
function parseJson(source: string): unknown { try { return JSON.parse(source) as unknown; } catch { throw invalidResponse(); } }
function decodeUtf8(decoder: TextDecoder, value?: Uint8Array, stream = false): string {
  try { return decoder.decode(value, { stream }); } catch { throw invalidResponse(); }
}
