import type { ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptFinishReason, ChatGptImageDetail, ChatGptInputContentPart, ChatGptInputItem, ChatGptMessage, ChatGptStreamEvent, ChatGptTool, ChatGptToolChoice, ChatGptUsage } from '@chatgpt-to-claude/chatgpt-backend';
import { createMessageId } from '@chatgpt-to-claude/shared';
import { estimateTokens } from './response.js';
import { normalizeReasoningEffort, normalizeSpeedPreference, type ReasoningSpeedDefaults } from './reasoning.js';

export type OpenAiChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface OpenAiChatCompletionRequest {
  model: string;
  messages: OpenAiChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  reasoning_effort?: string;
  speed?: string;
  response_speed?: string;
  tools?: OpenAiChatTool[];
  tool_choice?: OpenAiChatToolChoice;
  stream_options?: { include_usage?: boolean };
}

export interface OpenAiChatMessage {
  role: OpenAiChatRole;
  content?: string | OpenAiChatContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: OpenAiChatToolCall[];
}

export interface OpenAiChatContentPart { type?: string; text?: string; [key: string]: unknown; }
export interface OpenAiChatTool { type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean }; }
export type OpenAiChatToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
export interface OpenAiChatToolCall { id?: string; type?: 'function'; function?: { name?: string; arguments?: string }; }

export interface OpenAiChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: number; message: OpenAiChatResponseMessage; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAiChatResponseMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: OpenAiChatResponseToolCall[];
}

export interface OpenAiChatResponseToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; }

export interface OpenAiBackendRequestOptions { backendModel?: string; backendOptions?: Record<string, unknown>; }

export function mapOpenAiChatRequestToChatGpt(request: OpenAiChatCompletionRequest, defaults: ReasoningSpeedDefaults = {}, options: OpenAiBackendRequestOptions = {}): ChatGptCompletionRequest {
  const messages: ChatGptMessage[] = request.messages.map((message) => ({
    role: message.role === 'tool' ? 'user' : message.role,
    content: stringifyOpenAiMessage(message),
  }));
  const modelDefaults = defaults.modelDefaults?.[request.model];
  const stopSequences = normalizeOpenAiStop(request.stop);
  return {
    messages,
    inputItems: mapOpenAiChatInputItems(request.messages),
    maxTokens: request.max_completion_tokens ?? request.max_tokens ?? 1024,
    model: options.backendModel ?? request.model,
    reasoningEffort: normalizeReasoningEffort(request.reasoning_effort ?? modelDefaults?.reasoningEffort ?? defaults.globalReasoningEffort),
    speedPreference: normalizeSpeedPreference(request.speed ?? request.response_speed ?? modelDefaults?.speedPreference ?? defaults.globalSpeedPreference),
    temperature: typeof request.temperature === 'number' ? request.temperature : undefined,
    topP: typeof request.top_p === 'number' ? request.top_p : undefined,
    stopSequences,
    tools: mapOpenAiTools(request.tools),
    toolChoice: mapOpenAiToolChoice(request.tool_choice),
    backendOptions: options.backendOptions,
  };
}

export function mapOpenAiTools(tools: OpenAiChatTool[] | undefined): ChatGptTool[] | undefined {
  return tools?.filter((tool) => tool.type === 'function').map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    inputSchema: tool.function.parameters ?? {},
    strict: tool.function.strict,
    raw: tool,
  }));
}

export function mapOpenAiToolChoice(toolChoice: OpenAiChatToolChoice | undefined): ChatGptToolChoice | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice.type === 'function') return { type: 'tool', name: toolChoice.function.name };
  return undefined;
}

export function mapChatGptResponseToOpenAiChat(request: OpenAiChatCompletionRequest, response: ChatGptCompletionResponse): OpenAiChatCompletionResponse {
  const toolCalls = mapToolCalls(response.toolCalls);
  const completionText = response.text ?? '';
  const promptTokens = response.usage?.inputTokens ?? estimateTokens(JSON.stringify(request.messages));
  const completionTokens = response.usage?.outputTokens ?? estimateTokens(completionText + JSON.stringify(toolCalls ?? []));
  const totalTokens = response.usage?.totalTokens ?? promptTokens + completionTokens;
  return {
    id: createOpenAiId(),
    object: 'chat.completion',
    created: currentUnixSeconds(),
    model: request.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: toolCalls?.length ? (completionText || null) : completionText, ...(toolCalls?.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls?.length ? 'tool_calls' : mapOpenAiFinishReason(response.finishReason),
    }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
  };
}

export async function* mapChatGptStreamToOpenAiChatSse(request: OpenAiChatCompletionRequest, events: AsyncIterable<ChatGptStreamEvent>): AsyncIterable<string> {
  const id = createOpenAiId();
  const created = currentUnixSeconds();
  let finishReason: string | undefined;
  let sawToolCall = false;
  let usage: ChatGptUsage | undefined;
  yield openAiSse({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  for await (const event of events) {
    if (event.type === 'text_delta') {
      yield openAiSse({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }] });
    } else if (event.type === 'tool_call') {
      sawToolCall = true;
      yield openAiSse({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta: { tool_calls: [mapToolCallDelta(event.toolCall, 0)] }, finish_reason: null }] });
      finishReason = 'tool_calls';
    } else if (event.type === 'done') {
      finishReason = sawToolCall ? 'tool_calls' : mapOpenAiFinishReason(event.finishReason);
      usage = event.usage ?? usage;
    }
  }
  yield openAiSse({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? 'stop' }] });
  if (request.stream_options?.include_usage === true && usage) {
    yield openAiSse({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [], usage: mapOpenAiChatUsage(usage) });
  }
  yield 'data: [DONE]\n\n';
}

export function stringifyOpenAiMessage(message: OpenAiChatMessage): string {
  const parts: string[] = [];
  const content = stringifyOpenAiContent(message.content);
  if (message.role === 'tool' && message.tool_call_id) parts.push(`[tool_result:${message.tool_call_id}] ${content}`);
  else if (content) parts.push(content);
  for (const toolCall of message.tool_calls ?? []) {
    const name = toolCall.function?.name ?? 'unknown';
    const id = toolCall.id ?? 'unknown';
    const args = toolCall.function?.arguments ?? '';
    parts.push(`[tool_call:${id}:${name}] ${args}`);
  }
  return parts.join('\n');
}

export function stringifyOpenAiContent(content: OpenAiChatMessage['content']): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  return content.map((part) => part.type === 'text' ? String(part.text ?? '') : `[unsupported:${String(part.type ?? 'content_part')}]`).join('');
}

function mapOpenAiChatInputItems(messages: OpenAiChatMessage[]): ChatGptInputItem[] {
  const inputItems: ChatGptInputItem[] = [];
  for (const message of messages) {
    const content = mapOpenAiContentParts(message.content);
    if (message.role === 'tool' && message.tool_call_id) {
      inputItems.push({ type: 'function_call_output', callId: message.tool_call_id, output: stringifyOpenAiContent(message.content) });
    } else {
      if (content) inputItems.push({ type: 'message', role: message.role === 'tool' ? 'user' : message.role, content });
      for (const toolCall of message.tool_calls ?? []) {
        const name = toolCall.function?.name ?? 'unknown';
        const callId = toolCall.id ?? 'unknown';
        inputItems.push({ type: 'function_call', callId, name, arguments: parseOpenAiToolArguments(toolCall.function?.arguments ?? '') });
      }
    }
  }
  return inputItems;
}

function mapOpenAiContentParts(content: OpenAiChatMessage['content']): string | ChatGptInputContentPart[] | undefined {
  if (content === undefined || content === null) return undefined;
  if (typeof content === 'string') return content || undefined;
  const parts: ChatGptInputContentPart[] = [];
  let hasImage = false;
  for (const part of content) {
    if (part.type === 'text') appendInputText(parts, String(part.text ?? ''));
    else if (part.type === 'image_url') {
      const image = openAiImagePart(part.image_url);
      if (image) {
        parts.push(image);
        hasImage = true;
      } else appendInputText(parts, `[unsupported:${String(part.type)}]`);
    } else appendInputText(parts, `[unsupported:${String(part.type ?? 'content_part')}]`);
  }
  if (!parts.length) return undefined;
  return hasImage ? parts : parts.map((part) => part.type === 'text' ? part.text : '').join('');
}

function openAiImagePart(value: unknown): ChatGptInputContentPart | undefined {
  const raw = typeof value === 'string' ? { url: value } : value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!raw || typeof raw.url !== 'string' || !raw.url) return undefined;
  const detail = normalizeImageDetail(raw.detail);
  return { type: 'image', imageUrl: raw.url, ...(detail ? { detail } : {}) };
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

function parseOpenAiToolArguments(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function mapToolCalls(toolCalls: ChatGptCompletionResponse['toolCalls']): OpenAiChatResponseToolCall[] | undefined {
  return toolCalls?.map((toolCall) => ({ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input ?? {}) } }));
}

function mapToolCallDelta(toolCall: NonNullable<ChatGptCompletionResponse['toolCalls']>[number], index: number) {
  return { index, id: toolCall.id, type: 'function' as const, function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input ?? {}) } };
}

function normalizeOpenAiStop(stop: OpenAiChatCompletionRequest['stop']): string[] | undefined {
  if (typeof stop === 'string') return stop ? [stop] : undefined;
  if (!Array.isArray(stop)) return undefined;
  const values = stop.filter((item) => typeof item === 'string');
  return values.length ? values : undefined;
}

export function mapOpenAiFinishReason(reason: ChatGptFinishReason | null | undefined): string {
  switch (reason) {
    case 'length':
    case 'max_tokens':
    case 'context_length':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case 'refusal':
      return 'content_filter';
    case 'stop':
    case 'end_turn':
    case undefined:
    case null:
    default:
      return 'stop';
  }
}

function mapOpenAiChatUsage(usage: ChatGptUsage): OpenAiChatCompletionResponse['usage'] {
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: usage.totalTokens ?? promptTokens + completionTokens };
}

function openAiSse(data: unknown): string { return `data: ${JSON.stringify(data)}\n\n`; }
function currentUnixSeconds(): number { return Math.floor(Date.now() / 1000); }
function createOpenAiId(): string { return `chatcmpl_${createMessageId()}`; }
