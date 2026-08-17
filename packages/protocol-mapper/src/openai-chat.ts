import type { ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptFinishReason, ChatGptMessage, ChatGptStreamEvent, ChatGptTool, ChatGptToolChoice } from '@chatgpt-to-claude/chatgpt-backend';
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
  reasoning_effort?: string;
  speed?: string;
  response_speed?: string;
  tools?: OpenAiChatTool[];
  tool_choice?: OpenAiChatToolChoice;
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
  return {
    messages,
    maxTokens: request.max_completion_tokens ?? request.max_tokens ?? 1024,
    model: options.backendModel ?? request.model,
    reasoningEffort: normalizeReasoningEffort(request.reasoning_effort ?? modelDefaults?.reasoningEffort ?? defaults.globalReasoningEffort),
    speedPreference: normalizeSpeedPreference(request.speed ?? request.response_speed ?? modelDefaults?.speedPreference ?? defaults.globalSpeedPreference),
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
  const promptTokens = estimateTokens(JSON.stringify(request.messages));
  const completionTokens = estimateTokens(completionText + JSON.stringify(toolCalls ?? []));
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
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

export async function* mapChatGptStreamToOpenAiChatSse(request: OpenAiChatCompletionRequest, events: AsyncIterable<ChatGptStreamEvent>): AsyncIterable<string> {
  const id = createOpenAiId();
  const created = currentUnixSeconds();
  let finishReason: string | undefined;
  let sawToolCall = false;
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
    }
  }
  yield openAiSse({ id, object: 'chat.completion.chunk', created, model: request.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? 'stop' }] });
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

function mapToolCalls(toolCalls: ChatGptCompletionResponse['toolCalls']): OpenAiChatResponseToolCall[] | undefined {
  return toolCalls?.map((toolCall) => ({ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input ?? {}) } }));
}

function mapToolCallDelta(toolCall: NonNullable<ChatGptCompletionResponse['toolCalls']>[number], index: number) {
  return { index, id: toolCall.id, type: 'function' as const, function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input ?? {}) } };
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

function openAiSse(data: unknown): string { return `data: ${JSON.stringify(data)}\n\n`; }
function currentUnixSeconds(): number { return Math.floor(Date.now() / 1000); }
function createOpenAiId(): string { return `chatcmpl_${createMessageId()}`; }
