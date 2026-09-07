import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import {
  mapChatGptResponseToClaude, mapChatGptResponseToOpenAiChat, mapChatGptResponseToOpenAiResponses,
  mapChatGptStreamToClaudeSse, mapChatGptStreamToOpenAiChatSse, mapChatGptStreamToOpenAiResponsesSse,
} from './index.js';

const canary = 'OPAQUE_CLIENT_ISOLATION_CANARY';
const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: canary };
const call = { type: 'function_call', id: 'fc_provider', call_id: 'call_1', name: 'lookup', arguments: '{}' };
const request = { model: 'test', messages: [{ role: 'user' as const, content: 'hello' }], input: 'hello', max_tokens: 64 };
const backendRequest = { model: 'test', messages: request.messages, maxTokens: 64 };
const context = { account: { id: 'test', provider: 'chatgpt-session' as const, secret: { type: 'chatgpt-session' as const, accessToken: 'test' } } };
function client(replay: boolean) {
  return new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response([
    { type: 'response.output_text.delta', delta: 'answer' },
    { type: 'response.completed', response: { status: 'completed', output: [...(replay ? [reasoning] : []), call], usage: { input_tokens: 10, output_tokens: 20 } } },
  ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')) });
}
async function collect(iterable: AsyncIterable<string>) {
  let text = '';
  for await (const chunk of iterable) text += chunk;
  return text;
}
afterEach(() => vi.restoreAllMocks());

describe('backend replay stays internal to client protocol mappings', () => {
  it.each([
    ['Claude', mapChatGptResponseToClaude],
    ['OpenAI Chat', mapChatGptResponseToOpenAiChat],
    ['OpenAI Responses', mapChatGptResponseToOpenAiResponses],
  ] as const)('%s non-stream response never serializes the opaque carrier', async (_protocol, map) => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const completion = await client(true).complete(backendRequest, context);
    expect(completion.replayItems).toEqual([reasoning, call]);
    const response = map(request, completion);
    const baseline = map(request, await client(false).complete(backendRequest, context));
    if (_protocol === 'OpenAI Responses') {
      expect((response as ReturnType<typeof mapChatGptResponseToOpenAiResponses>).output).toContainEqual({ type: 'reasoning', id: 'rs_1', summary: [] });
      expect(JSON.stringify(response)).not.toMatch(/OPAQUE_CLIENT_ISOLATION_CANARY|encrypted_content|replayItems/);
    } else {
      expect({ ...response, id: '' }).toEqual({ ...baseline, id: '' });
      expect(JSON.stringify(response)).not.toMatch(/OPAQUE_CLIENT_ISOLATION_CANARY|encrypted_content|replayItems|fc_provider/);
    }
  });

  it.each([
    ['Claude', mapChatGptStreamToClaudeSse],
    ['OpenAI Chat', mapChatGptStreamToOpenAiChatSse],
    ['OpenAI Responses', mapChatGptStreamToOpenAiResponsesSse],
  ] as const)('%s stream never serializes the opaque carrier', async (_protocol, map) => {
    const response = await collect(map(request, client(true).stream(backendRequest, context)));
    expect(response).toContain('answer');
    expect(response).toContain('call_1');
    expect(response).not.toMatch(/OPAQUE_CLIENT_ISOLATION_CANARY|encrypted_content|replayItems/);
    if (_protocol !== 'OpenAI Responses') expect(response).not.toContain('fc_provider');
  });
});
