import type { ClaudeStopReason } from '@chatgpt-to-claude/claude-protocol';
export type BackendFinishReason = string | null | undefined;
export function mapStopReason(reason: BackendFinishReason): ClaudeStopReason {
  switch (reason) {
    case 'length':
    case 'max_tokens':
    case 'context_length':
    case 'model_context_window_exceeded':
      return reason === 'model_context_window_exceeded' ? 'model_context_window_exceeded' : 'max_tokens';
    case 'tool_use':
    case 'tool_calls':
      return 'tool_use';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'pause':
    case 'pause_turn':
      return 'pause_turn';
    case 'refusal':
      return 'refusal';
    case 'content_filter':
      return 'refusal';
    case 'interrupted':
    case 'error':
    case 'stop':
    case 'end_turn':
    case undefined:
    case null:
    default:
      return 'end_turn';
  }
}
