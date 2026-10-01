import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend, type ChatGptCompletionRequest } from './index.js';

const context = { account: { id: 'synthetic-account', provider: 'chatgpt-session' as const, secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic-token' } } };

describe('session multimodal tool outputs', () => {
  it.each(['complete', 'stream'] as const)('encodes structured text and image results on %s', async (method) => {
    let wireBody: Record<string, unknown> | undefined;
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      wireBody = JSON.parse(String(init?.body));
      return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    } });
    const request: ChatGptCompletionRequest = {
      model: 'synthetic-model', maxTokens: 16, messages: [],
      inputItems: [
        { type: 'function_call_output', callId: 'screenshot', output: [
          { type: 'text', text: 'Screenshot result' },
          { type: 'image', imageUrl: 'data:image/png;base64,aGVsbG8=', detail: 'high' },
          { type: 'image', imageUrl: 'https://images.test/screenshot.png' },
        ] },
        { type: 'function_call_output', callId: 'legacy', output: '{"status":"ok"}' },
        { type: 'function_call_output', callId: 'empty', output: [] },
      ],
    };
    const original = structuredClone(request);
    if (method === 'complete') await backend.complete(request, context);
    else for await (const _event of backend.stream(request, context)) { /* drain lazy fetch */ }

    expect(wireBody?.input).toEqual([
      { type: 'function_call_output', call_id: 'screenshot', output: [
        { type: 'input_text', text: 'Screenshot result' },
        { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=', detail: 'high' },
        { type: 'input_image', image_url: 'https://images.test/screenshot.png' },
      ] },
      { type: 'function_call_output', call_id: 'legacy', output: '{"status":"ok"}' },
      { type: 'function_call_output', call_id: 'empty', output: [] },
    ]);
    expect(request).toEqual(original);
  });
});
