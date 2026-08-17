import { describe, expect, it } from 'vitest';
import type { ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
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
});

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const chunk of iterable) text += chunk;
  return text;
}
