import type { ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptImageDetail, ChatGptInputContentPart, ChatGptInputItem, ChatGptMessage, ChatGptStreamEvent, ChatGptTool, ChatGptToolChoice, ChatGptUsage } from '@chatgpt-to-claude/chatgpt-backend';
import { ChatGptBackendError, parseResponsesReplayItem, ResponsesReplayBudget } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import { createMessageId } from '@chatgpt-to-claude/shared';
import { estimateTokens } from './response.js';
import { normalizeReasoningEffort, normalizeSpeedPreference, type ReasoningSpeedDefaults } from './reasoning.js';

export interface OpenAiResponsesRequest {
  model: string;
  input: string | OpenAiResponsesInputItem[];
  instructions?: string;
  include?: Array<'reasoning.encrypted_content'>;
  stream?: boolean;
  max_output_tokens?: number;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[] | null;
  reasoning?: { effort?: string };
  reasoning_effort?: string;
  service_tier?: string;
  speed?: string;
  response_speed?: string;
  tools?: OpenAiResponsesTool[];
  tool_choice?: OpenAiResponsesToolChoice;
  previous_response_id?: string | null;
  store?: boolean | null;
  metadata?: Record<string, unknown> | null;
  parallel_tool_calls?: boolean;
  truncation?: string;
  text?: Record<string, unknown>;
  response_format?: Record<string, unknown>;
}

export type OpenAiResponsesInputItem = Record<string, unknown>;
export type OpenAiResponsesTool = Record<string, unknown>;
export type OpenAiResponsesToolChoice = 'auto' | 'none' | 'required' | { type?: string; name?: string; function?: { name?: string } };

export interface OpenAiResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  status: 'completed';
  output: Array<Record<string, unknown>>;
  output_text: string;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

export interface OpenAiResponsesBackendRequestOptions {
  backendModel?: string;
  backendOptions?: Record<string, unknown>;
  resolvedControls?: { reasoningEffort?: string; serviceTier?: string };
}

export function mapOpenAiResponsesRequestToChatGpt(request: OpenAiResponsesRequest, defaults: ReasoningSpeedDefaults = {}, options: OpenAiResponsesBackendRequestOptions = {}): ChatGptCompletionRequest {
  const modelDefaults = defaults.modelDefaults?.[request.model];
  const stopSequences = normalizeResponsesStop(request.stop);
  const backendOptions = mapResponsesBackendOptions(request, options.backendOptions);
  return {
    messages: mapResponsesInput(request.input, request.instructions),
    inputItems: mapResponsesInputItems(request.input, request.instructions),
    maxTokens: request.max_output_tokens ?? request.max_tokens ?? 1024,
    model: options.backendModel ?? request.model,
    ...(options.resolvedControls
      ? {
          ...(options.resolvedControls.reasoningEffort === undefined ? {} : { reasoningEffort: options.resolvedControls.reasoningEffort }),
          ...(options.resolvedControls.serviceTier === undefined ? {} : { serviceTier: options.resolvedControls.serviceTier }),
        }
      : {
          reasoningEffort: normalizeReasoningEffort(request.reasoning?.effort ?? request.reasoning_effort ?? modelDefaults?.reasoningEffort ?? defaults.globalReasoningEffort),
          speedPreference: normalizeSpeedPreference(request.service_tier ?? request.speed ?? request.response_speed ?? modelDefaults?.speedPreference ?? defaults.globalSpeedPreference),
        }),
    temperature: typeof request.temperature === 'number' ? request.temperature : undefined,
    topP: typeof request.top_p === 'number' ? request.top_p : undefined,
    stopSequences,
    tools: mapResponsesTools(request.tools),
    toolChoice: mapResponsesToolChoice(request.tool_choice),
    backendOptions,
  };
}

function mapResponsesBackendOptions(request: OpenAiResponsesRequest, backendOptions: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const responsesBody: Record<string, unknown> = isPlainObject(backendOptions?.responsesBody) ? { ...(backendOptions.responsesBody as Record<string, unknown>) } : {};
  for (const key of ['previous_response_id', 'metadata', 'parallel_tool_calls', 'truncation'] as const) {
    if (request[key] !== undefined) responsesBody[key] = request[key];
  }
  if (request.text !== undefined) responsesBody.text = request.text;
  else if (request.response_format !== undefined) {
    const text = isPlainObject(responsesBody.text) ? { ...(responsesBody.text as Record<string, unknown>) } : {};
    if (text.format === undefined) responsesBody.text = { ...text, format: normalizeOpenAiResponseFormat(request.response_format) };
  }
  const rawTools = mapResponsesRawHostedTools(request.tools);
  if (rawTools?.length) responsesBody.tools = Array.isArray(responsesBody.tools) ? [...responsesBody.tools, ...rawTools] : rawTools;
  const rawToolChoice = mapResponsesRawHostedToolChoice(request.tool_choice);
  if (rawToolChoice) responsesBody.tool_choice = rawToolChoice;
  if (!Object.keys(responsesBody).length) return backendOptions;
  return { ...backendOptions, responsesBody };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mapResponsesRawHostedTools(tools: OpenAiResponsesTool[] | undefined): OpenAiResponsesTool[] | undefined {
  if (!tools) return undefined;
  const rawTools = tools.filter((tool) => tool.type !== undefined && tool.type !== 'function').map((tool) => ({ ...tool }));
  return rawTools.length ? rawTools : undefined;
}

function mapResponsesRawHostedToolChoice(toolChoice: OpenAiResponsesToolChoice | undefined): Record<string, unknown> | undefined {
  if (!toolChoice || typeof toolChoice !== 'object' || toolChoice.type === 'function') return undefined;
  return { ...toolChoice };
}

function normalizeOpenAiResponseFormat(responseFormat: Record<string, unknown>): Record<string, unknown> {
  if (responseFormat.type !== 'json_schema') return responseFormat;
  const jsonSchema = responseFormat.json_schema;
  if (!isPlainObject(jsonSchema)) return responseFormat;
  return { type: 'json_schema', ...jsonSchema };
}

export function mapChatGptResponseToOpenAiResponses(request: OpenAiResponsesRequest, response: ChatGptCompletionResponse): OpenAiResponsesResponse {
  if (response.terminalSuccessful === false) throw invalidNativeOutput();
  const outputText = response.outputItems ? response.outputItems.filter((item) => item.type === 'message').flatMap((item) => item.content.map((part) => part.text)).join('') : response.text ?? '';
  const output: Array<Record<string, unknown>> = [];
  const replay = response.replayItems ?? [];
  if (outputText || !response.toolCalls?.length && !replay.length) output.push({ id: `msg_${createMessageId()}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: outputText, annotations: [] }] });
  for (const raw of replay) {
    const item = parseResponsesReplayItem(raw);
    if (!item) throw invalidNativeOutput();
    const visible: Record<string, unknown> = { ...item };
    if (!request.include?.includes('reasoning.encrypted_content')) delete visible.encrypted_content;
    if (!visible.id) visible.id = `fc_${createMessageId()}`;
    output.push(visible);
  }
  const replayCalls = new Set(replay.filter((item) => item.type === 'function_call').map((item) => item.call_id));
  for (const toolCall of response.toolCalls ?? []) if (!replayCalls.has(toolCall.id)) output.push({ id: `fc_${createMessageId()}`, type: 'function_call', status: 'completed', call_id: toolCall.id, name: toolCall.name, arguments: JSON.stringify(toolCall.input ?? {}) });
  if (response.outputItems) {
    output.splice(0, output.length, ...response.outputItems.map((item): Record<string, unknown> => {
      const visible: Record<string, unknown> = { ...structuredClone(item) };
      if (!request.include?.includes('reasoning.encrypted_content')) delete visible.encrypted_content;
      visible.id ??= `${item.type === 'message' ? 'msg' : 'fc'}_${createMessageId()}`;
      return visible;
    }));
  }
  const inputTokens = response.usage?.inputTokens ?? estimateTokens(JSON.stringify(request.input));
  const outputTokens = response.usage?.outputTokens ?? estimateTokens(outputText + JSON.stringify(response.toolCalls ?? []));
  const totalTokens = response.usage?.totalTokens ?? inputTokens + outputTokens;
  return {
    id: createResponsesId(),
    object: 'response',
    created_at: currentUnixSeconds(),
    model: request.model,
    status: 'completed',
    output,
    output_text: outputText,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens },
  };
}

export interface OpenAiResponsesStreamOptions {
  signal?: AbortSignal;
  onCompleted?: (response: OpenAiResponsesResponse, completion: ChatGptCompletionResponse) => void | Promise<void>;
}

export const NATIVE_RESPONSES_OUTPUT_BYTES = 4 * 1024 * 1024;
function invalidNativeOutput(): ChatGptBackendError {
  return new ChatGptBackendError('Invalid Responses backend output.', 'invalid_response', { status: 502 });
}

/** Buffer until the successful terminal and iterator disposal. No tentative tool
 * events can escape before the authoritative reasoning/tool ordering is known. */
export async function* mapChatGptStreamToOpenAiResponsesSse(request: OpenAiResponsesRequest, events: AsyncIterable<ChatGptStreamEvent>, options: OpenAiResponsesStreamOptions = {}): AsyncIterable<string> {
  const id = createResponsesId();
  const createdAt = currentUnixSeconds();
  let sequence = 0;
  const emit = (type: string, fields: Record<string, unknown>) => responsesSse(type, { type, sequence_number: sequence++, ...fields });
  yield emit('response.created', { response: { ...createMinimalResponse(id, createdAt, request.model, [], ''), status: 'in_progress' } });
  let terminal: Extract<ChatGptStreamEvent, { type: 'done' }> | undefined;
  let text = '';
  let bytes = 256; // Fixed counters/array state, independent of discarded envelopes.
  let lastTextCodeUnit = 0;
  const toolCalls: NonNullable<ChatGptCompletionResponse['toolCalls']> = [];
  for await (const event of events) {
    if (terminal) throw invalidNativeOutput();
    if (event.type === 'text_delta') {
      bytes += Buffer.byteLength(event.text, 'utf8');
      // A surrogate pair can straddle chunks: two isolated replacements cost six
      // UTF-8 bytes, whereas the concatenated code point costs four.
      const first = event.text.charCodeAt(0);
      if (lastTextCodeUnit >= 0xd800 && lastTextCodeUnit <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) bytes -= 2;
      if (event.text.length) lastTextCodeUnit = event.text.charCodeAt(event.text.length - 1);
      text += event.text;
    } else if (event.type === 'tool_call') {
      bytes += Buffer.byteLength(JSON.stringify(event.toolCall), 'utf8') + 1;
      toolCalls.push(event.toolCall);
    } else if (event.type === 'done') {
      bytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
      terminal = event;
    }
    if (bytes > NATIVE_RESPONSES_OUTPUT_BYTES) throw invalidNativeOutput();
  }
  if (!terminal) throw invalidNativeOutput();
  options.signal?.throwIfAborted();
  const completion: ChatGptCompletionResponse = { text, toolCalls, ...terminal, finishReason: terminal.finishReason ?? 'stop' };
  const response = { ...mapChatGptResponseToOpenAiResponses(request, completion), id, created_at: createdAt };
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > NATIVE_RESPONSES_OUTPUT_BYTES) throw invalidNativeOutput();
  for (const [output_index, item] of response.output.entries()) {
    options.signal?.throwIfAborted();
    const initial: Record<string, unknown> = { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : item.type === 'message' ? { content: [] } : {}) };
    delete initial.encrypted_content;
    yield emit('response.output_item.added', { output_index, item: initial });
    const fields = { item_id: item.id, output_index };
    if (item.type === 'function_call') {
      yield emit('response.function_call_arguments.delta', { ...fields, delta: item.arguments });
      yield emit('response.function_call_arguments.done', { ...fields, arguments: item.arguments });
    } else if (item.type === 'message') {
      const content = item.content as Array<Record<string, unknown>>;
      for (const [content_index, part] of content.entries()) {
        yield emit('response.content_part.added', { ...fields, content_index, part: { ...part, text: '' } });
        yield emit('response.output_text.delta', { ...fields, content_index, delta: part.text });
        yield emit('response.output_text.done', { ...fields, content_index, text: part.text });
        yield emit('response.content_part.done', { ...fields, content_index, part });
      }
    }
    yield emit('response.output_item.done', { output_index, item });
  }
  options.signal?.throwIfAborted();
  await options.onCompleted?.(response, completion);
  yield emit('response.completed', { response });
  yield 'data: [DONE]\n\n';
}

function mapResponsesInput(input: OpenAiResponsesRequest['input'], instructions?: string): ChatGptMessage[] {
  const messages = typeof input === 'string'
    ? [{ role: 'user' as const, content: input }]
    : input.filter((item) => item.type !== 'reasoning').map((item) => {
      const role = normalizeRole(item.role);
      return { role, content: stringifyResponsesInputItem(item) };
    });
  return typeof instructions === 'string' && instructions ? [{ role: 'system', content: instructions }, ...messages] : messages;
}

function stringifyResponsesInputItem(item: OpenAiResponsesInputItem): string {
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) return item.content.map(stringifyResponsesContentPart).join('');
  if (item.type === 'function_call') return `[function_call:${String(item.call_id ?? 'unknown')}:${String(item.name ?? 'unknown')}] ${stringifyUnknown(item.arguments)}`;
  if (item.type === 'function_call_output') return `[function_call_output:${String(item.call_id ?? 'unknown')}] ${stringifyUnknown(item.output)}`;
  if (typeof item.output === 'string') return `[output] ${item.output}`;
  return `[unsupported:${String(item.type ?? 'input_item')}] ${stringifyUnknown(item)}`;
}

function mapResponsesInputItems(input: OpenAiResponsesRequest['input'], instructions?: string): ChatGptInputItem[] {
  const inputItems: ChatGptInputItem[] = [];
  if (typeof instructions === 'string' && instructions) inputItems.push({ type: 'message', role: 'system', content: instructions });
  if (typeof input === 'string') {
    inputItems.push({ type: 'message', role: 'user', content: input });
    return inputItems;
  }
  const budget = new ResponsesReplayBudget();
  for (const item of input) {
    if (item.type === 'reasoning' || item.type === 'function_call' && typeof item.arguments === 'string') {
      try {
        const replay = parseResponsesReplayItem(item);
        if (!replay) throw new Error();
        budget.add(replay);
        inputItems.push({ type: 'replay', item: replay });
      } catch { throw new ClaudeApiError('Invalid reasoning input.', 400, 'invalid_request_error'); }
    } else if (item.type === 'function_call') {
      inputItems.push({ type: 'function_call', callId: String(item.call_id ?? 'unknown'), name: String(item.name ?? 'unknown'), arguments: item.arguments ?? {} });
    } else if (item.type === 'function_call_output') {
      inputItems.push({ type: 'function_call_output', callId: String(item.call_id ?? 'unknown'), output: stringifyUnknown(item.output) });
    } else {
      const content = mapResponsesMessageContent(item);
      if (content !== undefined) inputItems.push({ type: 'message', role: normalizeRole(item.role), content });
    }
  }
  return inputItems;
}

function stringifyResponsesContentPart(part: unknown): string {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return stringifyUnknown(part);
  const raw = part as Record<string, unknown>;
  if (typeof raw.text === 'string') return raw.text;
  if (raw.type === 'input_text' || raw.type === 'output_text' || raw.type === 'text') return String(raw.text ?? '');
  if (raw.type === 'input_image' || raw.type === 'image' || raw.type === 'image_url' || raw.type === 'url') return `[unsupported:${String(raw.type)}]`;
  return `[unsupported:${String(raw.type ?? 'content_part')}] ${stringifyUnknown(raw)}`;
}

function mapResponsesMessageContent(item: OpenAiResponsesInputItem): string | ChatGptInputContentPart[] | undefined {
  if (typeof item.content === 'string') return item.content || undefined;
  if (!Array.isArray(item.content)) return stringifyResponsesInputItem(item);
  const parts: ChatGptInputContentPart[] = [];
  let hasImage = false;
  for (const part of item.content) {
    const image = responsesImagePart(part);
    if (image) {
      parts.push(image);
      hasImage = true;
      continue;
    }
    appendInputText(parts, stringifyResponsesContentPart(part));
  }
  if (!parts.length) return undefined;
  return hasImage ? parts : parts.map((part) => part.type === 'text' ? part.text : '').join('');
}

function responsesImagePart(part: unknown): ChatGptInputContentPart | undefined {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined;
  const raw = part as Record<string, unknown>;
  if (raw.type !== 'input_image' && raw.type !== 'image_url') return undefined;
  const imageUrl = typeof raw.image_url === 'string'
    ? raw.image_url
    : raw.image_url && typeof raw.image_url === 'object' && !Array.isArray(raw.image_url) && typeof (raw.image_url as Record<string, unknown>).url === 'string'
      ? String((raw.image_url as Record<string, unknown>).url)
      : undefined;
  if (!imageUrl) return undefined;
  const detail = normalizeImageDetail(raw.detail);
  return { type: 'image', imageUrl, ...(detail ? { detail } : {}) };
}

function appendInputText(parts: ChatGptInputContentPart[], text: string): void {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last?.type === 'text') last.text += text;
  else parts.push({ type: 'text', text });
}

function normalizeImageDetail(value: unknown): ChatGptImageDetail | undefined {
  return value === 'auto' || value === 'low' || value === 'high' ? value : undefined;
}

function mapResponsesTools(tools: OpenAiResponsesTool[] | undefined): ChatGptTool[] | undefined {
  if (!tools) return undefined;
  const mapped: ChatGptTool[] = [];
  for (const tool of tools) {
    if (tool.type !== undefined && tool.type !== 'function') continue;
    const fn = tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function) ? tool.function as Record<string, unknown> : tool;
    const name = typeof fn.name === 'string' ? fn.name : undefined;
    if (!name) continue;
    mapped.push({
      name,
      description: typeof fn.description === 'string' ? fn.description : undefined,
      inputSchema: fn.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters) ? fn.parameters as Record<string, unknown> : {},
      strict: typeof fn.strict === 'boolean' ? fn.strict : undefined,
      raw: tool,
    });
  }
  return mapped;
}

function mapResponsesToolChoice(toolChoice: OpenAiResponsesToolChoice | undefined): ChatGptToolChoice | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice.type === 'function') {
    const name = toolChoice.function?.name ?? toolChoice.name;
    return name ? { type: 'tool', name } : undefined;
  }
  return undefined;
}

function normalizeRole(value: unknown): ChatGptMessage['role'] {
  return value === 'developer' ? 'system' : value === 'assistant' || value === 'system' ? value : 'user';
}

function normalizeResponsesStop(stop: OpenAiResponsesRequest['stop']): string[] | undefined {
  if (typeof stop === 'string') return stop ? [stop] : undefined;
  if (!Array.isArray(stop)) return undefined;
  const values = stop.filter((item) => typeof item === 'string');
  return values.length ? values : undefined;
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function createMinimalResponse(id: string, createdAt: number, model: string, output: Array<Record<string, unknown>>, outputText: string, usage?: ChatGptUsage): OpenAiResponsesResponse {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return { id, object: 'response', created_at: createdAt, model, status: 'completed', output, output_text: outputText, usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: usage?.totalTokens ?? inputTokens + outputTokens } };
}

function responsesSse(event: string, data: unknown): string { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
function currentUnixSeconds(): number { return Math.floor(Date.now() / 1000); }
function createResponsesId(): string { return `resp_${createMessageId()}`; }
