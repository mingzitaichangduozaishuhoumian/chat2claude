import { describe, expect, it } from 'vitest';
import type { ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptResponseToClaude } from './response.js';

const request: ClaudeMessagesRequest = { model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] };

describe('mapChatGptResponseToClaude tool calls', () => {
  it('maps backend tool calls to Claude tool_use content blocks', () => {
    const response = mapChatGptResponseToClaude(request, { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }] });
    expect(response.stop_reason).toBe('tool_use');
    expect(response.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }]);
  });

  it('keeps text response behavior unchanged', () => {
    const response = mapChatGptResponseToClaude(request, { text: 'hello', finishReason: 'stop' });
    expect(response.stop_reason).toBe('end_turn');
    expect(response.content).toEqual([{ type: 'text', text: 'hello' }]);
  });
});
