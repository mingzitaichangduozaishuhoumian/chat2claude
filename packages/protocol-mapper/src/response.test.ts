import { describe, expect, it } from 'vitest';
import type { ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptResponseToOpenAiChat } from './openai-chat.js';
import { mapChatGptResponseToOpenAiResponses } from './openai-responses.js';
import { estimateClaudeInputTokens, estimateTokens, mapChatGptResponseToClaude } from './response.js';

const request: ClaudeMessagesRequest = { model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] };

describe('token estimates', () => {
  it('counts CJK text more conservatively than the old character average', () => {
    const text = '你好世界你好世界';
    expect(estimateTokens(text)).toBeGreaterThan(Math.ceil(text.length / 4));
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(8);
  });

  it('includes Claude request-level fields in input estimates', () => {
    const withTools = estimateClaudeInputTokens({
      ...request,
      tools: [{ name: 'lookup_weather', description: 'Look up weather by city and unit.', input_schema: { type: 'object', properties: { city: { type: 'string' }, unit: { enum: ['c', 'f'] } }, required: ['city'] } }],
      tool_choice: { type: 'tool', name: 'lookup_weather' },
    });
    expect(withTools).toBeGreaterThan(estimateClaudeInputTokens(request));
  });
});

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

  it('falls back to prompt plus completion tokens for partial OpenAI chat usage', () => {
    const response = mapChatGptResponseToOpenAiChat({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] }, { text: 'hello', finishReason: 'stop', usage: { inputTokens: 101, outputTokens: 202 } });
    expect(response.usage).toEqual({ prompt_tokens: 101, completion_tokens: 202, total_tokens: 303 });
  });

  it('falls back to input plus output tokens for partial OpenAI responses usage', () => {
    const response = mapChatGptResponseToOpenAiResponses({ model: 'gpt-test', input: 'hello' }, { text: 'hello', finishReason: 'stop', usage: { inputTokens: 101, outputTokens: 202 } });
    expect(response.usage).toEqual({ input_tokens: 101, output_tokens: 202, total_tokens: 303 });
  });
});
