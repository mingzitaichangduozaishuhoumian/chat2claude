import type { ChatGptCompletionRequest, ChatGptMessage } from '@chatgpt-to-claude/chatgpt-backend';
import type { ClaudeContentBlock, ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { resolveReasoningSpeed, type ReasoningSpeedDefaults } from './reasoning.js';
export function mapClaudeRequestToChatGpt(request: ClaudeMessagesRequest, defaults: ReasoningSpeedDefaults = {}): ChatGptCompletionRequest {
  const messages: ChatGptMessage[] = [];
  const system = stringifySystem(request.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const message of request.messages) messages.push({ role: message.role, content: stringifyContent(message.content) });
  const resolved = resolveReasoningSpeed(request, defaults);
  return { messages, maxTokens: request.max_tokens, model: request.model, reasoningEffort: resolved.reasoningEffort, speedPreference: resolved.speedPreference };
}
export function stringifyContent(content: string | ClaudeContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}
function stringifySystem(system: ClaudeMessagesRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((block) => block.text).join('');
}
