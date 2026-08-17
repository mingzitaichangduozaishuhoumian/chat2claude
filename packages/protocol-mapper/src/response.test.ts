import { describe, expect, it } from 'vitest';
import type { ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptResponseToOpenAiChat } from './openai-chat.js';
import { mapChatGptResponseToOpenAiResponses } from './openai-responses.js';
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

  it('prefers real usage for Claude non-stream responses', () => {
    const response = mapChatGptResponseToClaude(request, { text: 'hello', finishReason: 'stop', usage: { inputTokens: 101, outputTokens: 202, totalTokens: 303 } });
    expect(response.usage).toEqual({ input_tokens: 101, output_tokens: 202 });
  });

  it('prefers real usage for OpenAI chat non-stream responses', () => {
    const response = mapChatGptResponseToOpenAiChat({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] }, { text: 'hello', finishReason: 'stop', usage: { inputTokens: 101, outputTokens: 202, totalTokens: 303 } });
    expect(response.usage).toEqual({ prompt_tokens: 101, completion_tokens: 202, total_tokens: 303 });
  });

  it('prefers real usage for OpenAI responses non-stream responses', () => {
    const response = mapChatGptResponseToOpenAiResponses({ model: 'gpt-test', input: 'hello' }, { text: 'hello', finishReason: 'stop', usage: { inputTokens: 101, outputTokens: 202, totalTokens: 303 } });
    expect(response.usage).toEqual({ input_tokens: 101, output_tokens: 202, total_tokens: 303 });
  });
});
