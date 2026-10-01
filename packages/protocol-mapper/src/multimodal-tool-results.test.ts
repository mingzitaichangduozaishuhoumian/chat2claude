import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend, type ChatGptCompletionRequest } from '@chatgpt-to-claude/chatgpt-backend';
import { parseClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { mapClaudeRequestToChatGpt } from './request.js';
import { mapOpenAiResponsesRequestToChatGpt } from './openai-responses.js';

const context = { account: { id: 'synthetic-account', provider: 'chatgpt-session' as const, secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic-token' } } };
const imageUrl = 'data:image/png;base64,c2NyZWVuc2hvdA==';
const result = [
  { type: 'input_text', text: 'Before screenshot' },
  { type: 'input_image', image_url: imageUrl },
  { type: 'input_text', text: 'After screenshot' },
  { type: 'input_image', image_url: 'https://images.test/second.png', detail: 'high' },
];

async function sessionInput(request: ChatGptCompletionRequest): Promise<unknown> {
  let input: unknown;
  const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
    input = JSON.parse(String(init?.body)).input;
    return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
  } });
  await backend.complete(request, context);
  return input;
}

describe('multimodal tool results', () => {
  it('keeps Claude screenshot results attached to their tool call on the session wire', async () => {
    const request = parseClaudeMessagesRequest({ model: 'model', max_tokens: 32, messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read_image', name: 'Read', input: { path: 'screenshot.png' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read_image', content: [
        { type: 'text', text: 'Before screenshot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'c2NyZWVuc2hvdA==' } },
        { type: 'text', text: 'After screenshot' },
        { type: 'image', source: { type: 'url', url: 'https://images.test/second.png', detail: 'high' } },
      ] }] },
    ] });
    const original = structuredClone(request);
    expect(await sessionInput(mapClaudeRequestToChatGpt(request))).toEqual([
      { type: 'function_call', call_id: 'read_image', name: 'Read', arguments: '{"path":"screenshot.png"}' },
      { type: 'function_call_output', call_id: 'read_image', output: result },
    ]);
    expect(request).toEqual(original);
  });

  it('preserves Responses structured tool output arrays instead of serializing them as text', async () => {
    const input = [
      { type: 'function_call', call_id: 'read_image', name: 'Read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'read_image', output: result },
    ];
    expect(await sessionInput(mapOpenAiResponsesRequestToChatGpt({ model: 'model', input }))).toEqual(input);
  });

  it('keeps text-only Claude tool results as strings and omits private thinking', () => {
    const request = parseClaudeMessagesRequest({ model: 'model', max_tokens: 32, messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: 'Visible' }, { type: 'thinking', thinking: 'PRIVATE_THINKING' }] }] },
    ] });
    expect(mapClaudeRequestToChatGpt(request).inputItems?.at(-1)).toEqual({ type: 'function_call_output', callId: 'call', output: 'Visible' });
  });
});
