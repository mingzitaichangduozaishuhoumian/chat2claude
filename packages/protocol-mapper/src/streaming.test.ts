import { describe, expect, it } from 'vitest';
import type { ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptStreamToOpenAiChatSse } from './openai-chat.js';
import { mapChatGptStreamToOpenAiResponsesSse } from './openai-responses.js';
import { mapChatGptStreamToClaudeSse } from './streaming.js';

const request: ClaudeMessagesRequest = { model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] };

describe('mapChatGptStreamToClaudeSse', () => {
  it('streams tool calls as Claude tool_use blocks with input_json_delta', async () => {
    const text = await collect(mapChatGptStreamToClaudeSse(request, async function* () {
      yield { type: 'tool_call' as const, toolCall: { id: 'call_1', name: 'get_weather', input: { city: 'Paris' } } };
      yield { type: 'done' as const, finishReason: 'tool_calls' };
    }()));
    expect(text).toContain('"content_block":{"type":"tool_use","id":"call_1","name":"get_weather","input":{}}');
    expect(text).toContain('"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Paris\\"}"}');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it('uses done finishReason for text streams', async () => {
    const text = await collect(mapChatGptStreamToClaudeSse(request, async function* () {
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const, finishReason: 'length' };
    }()));
    expect(text).toContain('"stop_reason":"max_tokens"');
  });

  it('uses done usage for Claude message_delta usage', async () => {
    const text = await collect(mapChatGptStreamToClaudeSse(request, async function* () {
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const, finishReason: 'stop', usage: { outputTokens: 42 } };
    }()));
    expect(text).toContain('"usage":{"output_tokens":42}');
  });

  it('uses done usage for OpenAI responses completed usage', async () => {
    const text = await collect(mapChatGptStreamToOpenAiResponsesSse({ model: 'gpt-test', input: 'hello' }, async function* () {
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    }()));
    expect(text).toContain('"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}');
  });

  it('does not emit an OpenAI chat usage chunk by default', async () => {
    const chunks = parseOpenAiData(await collect(mapChatGptStreamToOpenAiChatSse({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] }, async function* () {
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    }())));
    expect(chunks.some((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0 && chunk.usage)).toBe(false);
  });

  it('emits an OpenAI chat usage chunk when include_usage is true', async () => {
    const chunks = parseOpenAiData(await collect(mapChatGptStreamToOpenAiChatSse({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }], stream_options: { include_usage: true } }, async function* () {
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    }())));
    const usageChunk = chunks.find((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0);
    expect(usageChunk).toMatchObject({ object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  });
});

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const chunk of iterable) text += chunk;
  return text;
}

function parseOpenAiData(text: string): Array<Record<string, unknown>> {
  return text.split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
}
