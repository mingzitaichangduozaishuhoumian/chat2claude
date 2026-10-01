import { describe, expect, it } from 'vitest';
import { RESPONSES_INPUT_REPLAY_LIMITS } from '@chatgpt-to-claude/chatgpt-backend';
import { mapOpenAiResponsesRequestToChatGpt } from './openai-responses.js';
import { mapOpenAiChatRequestToChatGpt } from './openai-chat.js';
import { mapClaudeRequestToChatGpt } from './request.js';

const call = (index: number, argumentsText = '{}') => ({ type: 'function_call', call_id: `call_${index}`, name: 'Read', arguments: argumentsText });

describe('large request input preservation', () => {
  it('accepts a Responses history exceeding the 128-item output replay limit', () => {
    const input = Array.from({ length: 129 }, (_, index) => [
      call(index), { type: 'function_call_output', call_id: `call_${index}`, output: `result_${index}` },
    ]).flat();
    const request = mapOpenAiResponsesRequestToChatGpt({ model: 'model', input });
    expect(request.inputItems).toHaveLength(258);
    expect(request.inputItems?.at(-2)).toEqual({ type: 'replay', item: call(128) });
    expect(request.inputItems?.at(-1)).toEqual({ type: 'function_call_output', callId: 'call_128', output: 'result_128' });
  });

  it('keeps large historical tool arguments intact instead of applying the output item limit', () => {
    const argumentsText = JSON.stringify({ document: 'x'.repeat(300 * 1024) });
    const request = mapOpenAiResponsesRequestToChatGpt({ model: 'model', input: [call(0, argumentsText)] });
    expect(request.inputItems).toEqual([{ type: 'replay', item: call(0, argumentsText) }]);
  });

  it.each(['Claude', 'Chat', 'Responses'] as const)('preserves a 4 MiB plain text payload in %s', (protocol) => {
    const text = 'x'.repeat(4 * 1024 * 1024) + 'END_OF_CONTEXT';
    const messages = [{ role: 'user' as const, content: text }];
    const request = protocol === 'Claude' ? mapClaudeRequestToChatGpt({ model: 'model', max_tokens: 32, messages })
      : protocol === 'Chat' ? mapOpenAiChatRequestToChatGpt({ model: 'model', messages })
        : mapOpenAiResponsesRequestToChatGpt({ model: 'model', input: text });
    expect(request.inputItems).toEqual([{ type: 'message', role: 'user', content: text }]);
  });

  it('continues to reject history exceeding the separate input replay limit', () => {
    const input = Array.from({ length: RESPONSES_INPUT_REPLAY_LIMITS.items + 1 }, (_, index) => call(index));
    expect(() => mapOpenAiResponsesRequestToChatGpt({ model: 'model', input })).toThrow('Invalid reasoning input.');
  });
});
