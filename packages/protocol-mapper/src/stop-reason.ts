import type { ClaudeStopReason } from '@chatgpt-to-claude/claude-protocol';
import type { ChatGptCompletionResponse } from '@chatgpt-to-claude/chatgpt-backend';
export function mapStopReason(reason: ChatGptCompletionResponse['finishReason']): ClaudeStopReason {
  switch (reason) {
    case 'length': return 'max_tokens';
    case 'stop': default: return 'end_turn';
  }
}
