import type { ChatGptCompletionResponse } from '@chatgpt-to-claude/chatgpt-backend';
import type { ClaudeContentBlock, ClaudeMessageResponse, ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { createMessageId } from '@chatgpt-to-claude/shared';
import { normalizeClaudeMessagesToCanonical } from './canonical.js';
import { mapCanonicalInputItems, mapClaudeToolChoice, mapClaudeTools } from './request.js';
import { mapStopReason } from './stop-reason.js';
export function mapChatGptResponseToClaude(request: ClaudeMessagesRequest, response: ChatGptCompletionResponse): ClaudeMessageResponse {
  return {
    id: createMessageId(),
    type: 'message',
    role: 'assistant',
    model: request.model,
    content: mapResponseContent(response),
    stop_reason: mapStopReason(response.finishReason),
    stop_sequence: null,
    usage: { input_tokens: response.usage?.inputTokens ?? estimateClaudeInputTokens(request), output_tokens: response.usage?.outputTokens ?? estimateTokens(response.text) },
  };
}
export function mapResponseContent(response: ChatGptCompletionResponse): ClaudeContentBlock[] {
  const content: ClaudeContentBlock[] = [];
  if (response.text) content.push({ type: 'text', text: response.text });
  for (const toolCall of response.toolCalls ?? []) content.push({ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.input });
  if (!content.length) content.push({ type: 'text', text: '' });
  return content;
}
export function estimateClaudeInputTokens(request: Pick<ClaudeMessagesRequest, 'model' | 'messages'> & Partial<ClaudeMessagesRequest>): number {
  const canonical = normalizeClaudeMessagesToCanonical({ ...request, max_tokens: request.max_tokens ?? 1 } as ClaudeMessagesRequest);
  const countable = compactObject({
    model: request.model,
    input: mapCanonicalInputItems(canonical.messages, canonical.diagnostics),
    tools: mapClaudeTools(request.tools),
    tool_choice: mapClaudeToolChoice(request.tool_choice),
    thinking: request.thinking,
    output_config: request.output_config,
    reasoning_effort: request.reasoning_effort,
    speed: request.speed,
    response_speed: request.response_speed,
    stop_sequences: request.stop_sequences,
    temperature: request.temperature,
    top_p: request.top_p,
    metadata: request.metadata,
    service_tier: request.service_tier,
    container: request.container,
    context_management: request.context_management,
    mcp_servers: request.mcp_servers,
  });
  return estimateTokens(JSON.stringify(countable));
}

export function estimateTokens(text: string): number {
  let asciiRun = 0;
  let cjk = 0;
  let symbols = 0;
  let whitespace = 0;
  const flushAscii = () => {
    const tokens = Math.ceil(asciiRun / 4);
    asciiRun = 0;
    return tokens;
  };
  let tokens = 0;
  for (const char of text) {
    if (/\s/u.test(char)) {
      tokens += flushAscii();
      whitespace += 1;
    } else if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) {
      tokens += flushAscii();
      cjk += 1;
    } else if (/[A-Za-z0-9_]/u.test(char)) {
      asciiRun += 1;
    } else {
      tokens += flushAscii();
      symbols += 1;
    }
  }
  tokens += flushAscii();
  tokens += cjk;
  tokens += Math.ceil(symbols / 2);
  tokens += Math.ceil(whitespace / 8);
  return Math.max(1, tokens);
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;
}
