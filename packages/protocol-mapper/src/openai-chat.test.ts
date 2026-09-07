import { describe, expect, it } from 'vitest';
import { mapChatGptStreamToOpenAiChatSse } from './openai-chat.js';

describe('OpenAI Chat streaming tools', () => {
  it('assigns stable independent tool indices within choice zero', async () => {
    const chunks = [];
    for await (const chunk of mapChatGptStreamToOpenAiChatSse({ model: 'test', messages: [] }, (async function* () {
      yield { type: 'tool_call' as const, toolCall: { id: 'call_b', name: 'lookup', input: { key: 'b' } } };
      yield { type: 'text_delta' as const, text: 'checking' };
      yield { type: 'tool_call' as const, toolCall: { id: 'call_a', name: 'lookup', input: { key: 'a' } } };
      yield { type: 'done' as const };
    })())) {
      if (chunk !== 'data: [DONE]\n\n') chunks.push(JSON.parse(chunk.slice(6)));
    }
    const choices = chunks.flatMap((chunk) => chunk.choices);
    expect(choices.every((choice) => choice.index === 0)).toBe(true);
    expect(choices.flatMap((choice) => choice.delta.tool_calls ?? [])).toEqual([
      { index: 0, id: 'call_b', type: 'function', function: { name: 'lookup', arguments: '{"key":"b"}' } },
      { index: 1, id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"key":"a"}' } },
    ]);
    expect(choices.at(-1).finish_reason).toBe('tool_calls');
  });
});
