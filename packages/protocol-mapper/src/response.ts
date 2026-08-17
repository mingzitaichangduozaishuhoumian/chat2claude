import type { ChatGptCompletionResponse } from '@chatgpt-to-claude/chatgpt-backend';
import type { ClaudeContentBlock, ClaudeMessageResponse, ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { createMessageId } from '@chatgpt-to-claude/shared';
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
    usage: { input_tokens: estimateTokens(JSON.stringify(request.messages)), output_tokens: estimateTokens(response.text) },
  };
}
export function mapResponseContent(response: ChatGptCompletionResponse): ClaudeContentBlock[] {
  const content: ClaudeContentBlock[] = [];
  if (response.text) content.push({ type: 'text', text: response.text });
  for (const toolCall of response.toolCalls ?? []) content.push({ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.input });
  if (!content.length) content.push({ type: 'text', text: '' });
  return content;
}
export function estimateTokens(text: string): number { return Math.max(1, Math.ceil(text.length / 4)); }
