import type { ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptImageDetail, ChatGptInputContentPart, ChatGptInputItem, ChatGptMessage, ChatGptStreamEvent, ChatGptTool, ChatGptToolChoice, ChatGptUsage } from '@chatgpt-to-claude/chatgpt-backend';
import { createMessageId } from '@chatgpt-to-claude/shared';
import { estimateTokens } from './response.js';
import { normalizeReasoningEffort, normalizeSpeedPreference, type ReasoningSpeedDefaults } from './reasoning.js';

export interface OpenAiResponsesRequest {
  model: string;
  input: string | OpenAiResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  max_output_tokens?: number;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[] | null;
  reasoning?: { effort?: string };
  reasoning_effort?: string;
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

export interface OpenAiResponsesBackendRequestOptions { backendModel?: string; backendOptions?: Record<string, unknown>; }

export function mapOpenAiResponsesRequestToChatGpt(request: OpenAiResponsesRequest, defaults: ReasoningSpeedDefaults = {}, options: OpenAiResponsesBackendRequestOptions = {}): ChatGptCompletionRequest {
  const modelDefaults = defaults.modelDefaults?.[request.model];
  const stopSequences = normalizeResponsesStop(request.stop);
  const backendOptions = mapResponsesBackendOptions(request, options.backendOptions);
  return {
    messages: mapResponsesInput(request.input, request.instructions),
    inputItems: mapResponsesInputItems(request.input, request.instructions),
    maxTokens: request.max_output_tokens ?? request.max_tokens ?? 1024,
    model: options.backendModel ?? request.model,
    reasoningEffort: normalizeReasoningEffort(request.reasoning?.effort ?? request.reasoning_effort ?? modelDefaults?.reasoningEffort ?? defaults.globalReasoningEffort),
    speedPreference: normalizeSpeedPreference(request.speed ?? request.response_speed ?? modelDefaults?.speedPreference ?? defaults.globalSpeedPreference),
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
  for (const key of ['previous_response_id', 'store', 'metadata', 'parallel_tool_calls', 'truncation'] as const) {
    if (request[key] !== undefined) responsesBody[key] = request[key];
  }
  if (request.text !== undefined) responsesBody.text = request.text;
  else if (request.response_format !== undefined) {
    const text = isPlainObject(responsesBody.text) ? { ...(responsesBody.text as Record<string, unknown>) } : {};
    if (text.format === undefined) responsesBody.text = { ...text, format: normalizeOpenAiResponseFormat(request.response_format) };
  }
  if (!Object.keys(responsesBody).length) return backendOptions;
  return { ...backendOptions, responsesBody };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOpenAiResponseFormat(responseFormat: Record<string, unknown>): Record<string, unknown> {
  if (responseFormat.type !== 'json_schema') return responseFormat;
  const jsonSchema = responseFormat.json_schema;
  if (!isPlainObject(jsonSchema)) return responseFormat;
  return { type: 'json_schema', ...jsonSchema };
}

export function mapChatGptResponseToOpenAiResponses(request: OpenAiResponsesRequest, response: ChatGptCompletionResponse): OpenAiResponsesResponse {
  const outputText = response.text ?? '';
  const output: Array<Record<string, unknown>> = [];
  if (outputText || !response.toolCalls?.length) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: outputText }] });
  for (const toolCall of response.toolCalls ?? []) output.push({ type: 'function_call', call_id: toolCall.id, name: toolCall.name, arguments: JSON.stringify(toolCall.input ?? {}) });
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

export interface OpenAiResponsesStreamOptions { onCompleted?: (response: OpenAiResponsesResponse) => void | Promise<void>; }

export async function* mapChatGptStreamToOpenAiResponsesSse(request: OpenAiResponsesRequest, events: AsyncIterable<ChatGptStreamEvent>, options: OpenAiResponsesStreamOptions = {}): AsyncIterable<string> {
  const id = createResponsesId();
  const createdAt = currentUnixSeconds();
  const base = { response_id: id, created_at: createdAt, model: request.model };
  const output: Array<Record<string, unknown>> = [];
  let outputText = '';
  let usage: ChatGptUsage | undefined;
  yield responsesSse('response.created', { ...base, type: 'response.created', response: createMinimalResponse(id, createdAt, request.model, [], '') });
  for await (const event of events) {
    if (event.type === 'text_delta') {
      outputText += event.text;
      yield responsesSse('response.output_text.delta', { ...base, type: 'response.output_text.delta', delta: event.text });
    } else if (event.type === 'tool_call') {
      const item = { type: 'function_call', call_id: event.toolCall.id, name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.input ?? {}) };
      output.push(item);
      yield responsesSse('response.output_item.added', { ...base, type: 'response.output_item.added', item: { ...item, arguments: '' } });
      yield responsesSse('response.function_call_arguments.delta', { ...base, type: 'response.function_call_arguments.delta', call_id: event.toolCall.id, delta: item.arguments });
    } else if (event.type === 'done') {
      usage = event.usage ?? usage;
    }
  }
  if (outputText || !output.length) output.unshift({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: outputText }] });
  const response = createMinimalResponse(id, createdAt, request.model, output, outputText, usage);
  await options.onCompleted?.(response);
  yield responsesSse('response.completed', { ...base, type: 'response.completed', response });
  yield 'data: [DONE]\n\n';
}

function mapResponsesInput(input: OpenAiResponsesRequest['input'], instructions?: string): ChatGptMessage[] {
  const messages = typeof input === 'string'
    ? [{ role: 'user' as const, content: input }]
    : input.map((item) => {
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
  for (const item of input) {
    if (item.type === 'function_call') {
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
  return value === 'assistant' || value === 'system' ? value : 'user';
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
