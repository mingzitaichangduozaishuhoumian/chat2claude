import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { mapChatGptStreamToOpenAiChatSse, mapOpenAiChatRequestToChatGpt } from './openai-chat.js';

describe('OpenAI Chat historical tool arguments', () => {
  it('preserves original numeric precision, escaping, and whitespace on the session wire', async () => {
    const argumentsText = ' { "id": 9007199254740993, "name": "\\u96ea" } ';
    let input: unknown;
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      input = JSON.parse(String(init?.body)).input;
      return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    } });
    const request = mapOpenAiChatRequestToChatGpt({ model: 'model', messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_id', type: 'function', function: { name: 'lookup', arguments: argumentsText } }] },
      { role: 'tool', tool_call_id: 'call_id', content: 'found' },
    ] });
    await backend.complete(request, { account: { id: 'synthetic', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'synthetic-token' } } });
    expect(input).toEqual([
      { type: 'function_call', call_id: 'call_id', name: 'lookup', arguments: argumentsText },
      { type: 'function_call_output', call_id: 'call_id', output: 'found' },
    ]);
  });
});

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
