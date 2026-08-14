import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend, type ChatGptCompletionRequest } from './index.js';

const request: ChatGptCompletionRequest = {
  model: 'gpt-test',
  maxTokens: 128,
  messages: [{ role: 'user', content: 'hello' }],
};

const context = {
  account: {
    id: 'session-1',
    provider: 'chatgpt-session' as const,
    secret: {
      type: 'chatgpt-session' as const,
      accessToken: 'token-1',
      cookie: 'cookie-1',
      deviceId: 'device-1',
      userAgent: 'ua-1',
    },
  },
};

describe('SessionChatGptBackend', () => {
  it('aggregates SSE text deltas for complete', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test/', timeoutMs: 1000, fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return sseResponse([
        { type: 'response.output_text.delta', output_text_delta: 'hello ' },
        { type: 'response.output_text.delta', delta: 'world' },
        '[DONE]',
      ]);
    } });

    const response = await backend.complete(request, context);
    expect(response).toEqual({ text: 'hello world', finishReason: 'stop' });
    expect(calls[0].url).toBe('https://chatgpt.test/backend-api/codex/responses');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer token-1');
    expect(headers.get('cookie')).toBe('cookie-1');
    expect(headers.get('oai-device-id')).toBe('device-1');
    expect(headers.get('user-agent')).toBe('ua-1');
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: 'gpt-test', stream: true, store: false, instructions: '' });
  });

  it('streams compatible text delta shapes', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse([
      { delta: { content: 'a' } },
      { message: { delta: { content: 'b' } } },
      { content: [{ text: 'c' }] },
      { type: 'response.completed' },
    ]) });

    const events = [];
    for await (const event of backend.stream(request, context)) events.push(event);
    expect(events).toEqual([
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
      { type: 'text_delta', text: 'c' },
      { type: 'done' },
    ]);
  });

  it('throws a clear error when the session secret is missing', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse([]) });
    await expect(backend.complete(request, { account: { id: 'session-1', provider: 'chatgpt-session' } })).rejects.toThrow('missing a chatgpt-session secret');
    await expect(backend.complete(request, { account: { id: 'session-2', provider: 'chatgpt-session', secret: { type: 'chatgpt-session' } } })).rejects.toThrow('missing secret.accessToken');
  });

  it('healthCheck calls models endpoint with session headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    } });

    await expect(backend.healthCheck(context)).resolves.toEqual({ ok: true });
    expect(calls[0].url).toBe('https://chatgpt.test/backend-api/codex/models');
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Headers).get('authorization')).toBe('Bearer token-1');
  });
});

function sseResponse(items: Array<Record<string, unknown> | string>): Response {
  const body = items.map((item) => `data: ${typeof item === 'string' ? item : JSON.stringify(item)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
