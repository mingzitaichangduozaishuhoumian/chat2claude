import type { ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptMessage, ChatGptStreamEvent, ChatGptTool, ChatGptToolChoice, ChatGptUsage } from '@chatgpt-to-claude/chatgpt-backend';
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
  reasoning?: { effort?: string };
  reasoning_effort?: string;
  speed?: string;
  response_speed?: string;
  tools?: OpenAiResponsesTool[];
  tool_choice?: OpenAiResponsesToolChoice;
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
  return {
    messages: mapResponsesInput(request.input, request.instructions),
    maxTokens: request.max_output_tokens ?? request.max_tokens ?? 1024,
    model: options.backendModel ?? request.model,
    reasoningEffort: normalizeReasoningEffort(request.reasoning?.effort ?? request.reasoning_effort ?? modelDefaults?.reasoningEffort ?? defaults.globalReasoningEffort),
    speedPreference: normalizeSpeedPreference(request.speed ?? request.response_speed ?? modelDefaults?.speedPreference ?? defaults.globalSpeedPreference),
    tools: mapResponsesTools(request.tools),
    toolChoice: mapResponsesToolChoice(request.tool_choice),
    backendOptions: options.backendOptions,
  };
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

export async function* mapChatGptStreamToOpenAiResponsesSse(request: OpenAiResponsesRequest, events: AsyncIterable<ChatGptStreamEvent>): AsyncIterable<string> {
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
  yield responsesSse('response.completed', { ...base, type: 'response.completed', response: createMinimalResponse(id, createdAt, request.model, output, outputText, usage) });
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

function stringifyResponsesContentPart(part: unknown): string {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return stringifyUnknown(part);
  const raw = part as Record<string, unknown>;
  if (typeof raw.text === 'string') return raw.text;
  if (raw.type === 'input_text' || raw.type === 'output_text' || raw.type === 'text') return String(raw.text ?? '');
  if (raw.type === 'input_image' || raw.type === 'image' || raw.type === 'image_url' || raw.type === 'url') return `[unsupported:${String(raw.type)}] ${stringifyUnknown(raw)}`;
  return `[unsupported:${String(raw.type ?? 'content_part')}] ${stringifyUnknown(raw)}`;
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
