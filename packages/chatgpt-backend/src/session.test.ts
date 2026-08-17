import { describe, expect, it } from 'vitest';
import { ChatGptBackendError, SessionChatGptBackend, type ChatGptCompletionRequest } from './index.js';

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
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: 'gpt-test', stream: true, store: false, instructions: '', max_output_tokens: 128 });
  });

  it('aggregates done usage for complete responses', async () => {
    const usage = { input_tokens: 9, output_tokens: 4, total_tokens: 13 };
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse([
      { type: 'response.output_text.delta', output_text_delta: 'ok' },
      { type: 'response.completed', body: { usage } },
    ]) });

    const response = await backend.complete(request, context);
    expect(response).toEqual({ text: 'ok', finishReason: 'stop', usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13, raw: usage } });
  });

  it('keeps raw usage scoped to the usage object', async () => {
    const usage = { input_tokens: 9, output_tokens: 4, total_tokens: 13 };
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse([
      { type: 'response.completed', secret: 'nope', response: { usage, secret: 'nope' } },
    ]) });

    const response = await backend.complete(request, context);
    expect(response.usage?.raw).toEqual(usage);
    expect(response.usage?.raw).not.toHaveProperty('secret');
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
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('merges usage fields from separate stream events into done usage', async () => {
    const earlyUsage = { input_tokens: 11 };
    const completedUsage = { output_tokens: 7, total_tokens: 18 };
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse([
      { type: 'response.output_text.delta', delta: 'hello', token_usage: earlyUsage },
      { type: 'response.completed', response: { usage: completedUsage }, finish_reason: 'stop' },
    ]) });

    const events = [];
    for await (const event of backend.stream(request, context)) events.push(event);
    expect(events).toEqual([
      { type: 'text_delta', text: 'hello' },
      { type: 'done', finishReason: 'stop', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, raw: completedUsage } },
    ]);
  });

  it('passes generation controls to the Codex responses body', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await backend.complete({ ...request, temperature: 0.25, topP: 0.75, stopSequences: ['END'] }, context);
    expect(calls[0].body).toMatchObject({ temperature: 0.25, top_p: 0.75, stop: 'END' });
  });

  it('omits generation controls from the Codex responses body when unset', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await backend.complete(request, context);
    expect(calls[0].body).not.toHaveProperty('temperature');
    expect(calls[0].body).not.toHaveProperty('top_p');
    expect(calls[0].body).not.toHaveProperty('stop');
  });

  it('allowlists backend responsesBody fields and keeps store false even when requested true', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await backend.complete({
      ...request,
      backendOptions: {
        responsesBody: {
          previous_response_id: 'resp_prev',
          store: true,
          metadata: { trace: 'abc' },
          parallel_tool_calls: false,
          truncation: 'auto',
          text: { format: { type: 'json_object' } },
          extra: 'drop me',
        },
      },
    }, context);

    expect(calls[0].body).toMatchObject({
      previous_response_id: 'resp_prev',
      store: false,
      metadata: { trace: 'abc' },
      parallel_tool_calls: false,
      truncation: 'auto',
      text: { format: { type: 'json_object' } },
    });
    expect(calls[0].body).not.toHaveProperty('extra');
  });

  it('passes multiple stop sequences as an array to the Codex responses body', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await backend.complete({ ...request, stopSequences: ['END', 'STOP'] }, context);
    expect(calls[0].body.stop).toEqual(['END', 'STOP']);
  });

  it('prefers structured inputItems when building the Codex responses body', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await backend.complete({
      ...request,
      messages: [{ role: 'user', content: 'fallback only' }],
      inputItems: [
        { type: 'message', role: 'assistant', content: 'checking' },
        { type: 'function_call', callId: 'call_1', name: 'lookup', arguments: { q: 'x' } },
        { type: 'function_call', callId: 'call_2', name: 'lookup', arguments: '{"q":"x"}' },
        { type: 'function_call_output', callId: 'call_1', output: 'done', isError: true },
      ],
    }, context);

    expect(calls[0].body.input).toEqual([
      { type: 'message', role: 'assistant', content: 'checking' },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'done' },
    ]);
  });

  it('maps structured message content parts to Responses input content parts', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await backend.complete({
      ...request,
      inputItems: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'look ' }, { type: 'image', imageUrl: 'data:image/png;base64,aaa', detail: 'high' }] }],
    }, context);

    expect(calls[0].body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look ' }, { type: 'input_image', image_url: 'data:image/png;base64,aaa', detail: 'high' }] },
    ]);
  });

  it('maps internal any toolChoice to the Codex required tool_choice dialect', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await backend.complete({ ...request, toolChoice: { type: 'any' } }, context);
    expect(calls[0].body.tool_choice).toBe('required');
  });

  it('merges backend responsesBody hosted tools with mapped function tools', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await backend.complete({
      ...request,
      tools: [{ name: 'get_weather', description: 'weather', inputSchema: { type: 'object' }, strict: true }],
      backendOptions: { responsesBody: { tools: [{ type: 'web_search_preview', search_context_size: 'low' }] } },
    }, context);

    expect(calls[0].body.tools).toEqual([
      { type: 'function', name: 'get_weather', description: 'weather', parameters: { type: 'object' }, strict: true },
      { type: 'web_search_preview', search_context_size: 'low' },
    ]);
  });

  it('applies raw hosted tool_choice only when internal toolChoice is absent', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await backend.complete({ ...request, backendOptions: { responsesBody: { tool_choice: { type: 'web_search_preview' } } } }, context);
    await backend.complete({ ...request, toolChoice: { type: 'any' }, backendOptions: { responsesBody: { tool_choice: { type: 'web_search_preview' } } } }, context);
    await backend.complete({ ...request, toolChoice: { type: 'tool', name: 'get_weather' }, backendOptions: { responsesBody: { tool_choice: { type: 'web_search_preview' } } } }, context);

    expect(calls[0].body.tool_choice).toEqual({ type: 'web_search_preview' });
    expect(calls[1].body.tool_choice).toBe('required');
    expect(calls[2].body.tool_choice).toEqual({ type: 'function', name: 'get_weather' });
  });

  it('passes tools/tool_choice to the Codex responses body and parses tool calls', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([
        { tool_call: { id: 'call_1', name: 'get_weather', input: { city: 'Paris' } } },
        { type: 'response.completed', finish_reason: 'tool_calls' },
      ]);
    } });

    const toolRequest: ChatGptCompletionRequest = {
      ...request,
      tools: [{ name: 'get_weather', description: 'weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, strict: true }],
      toolChoice: { type: 'tool', name: 'get_weather' },
    };
    const response = await backend.complete(toolRequest, context);
    expect(calls[0].body).toMatchObject({
      tools: [{ type: 'function', name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } }, strict: true }],
      tool_choice: { type: 'function', name: 'get_weather' },
    });
    expect(response).toEqual({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }] });
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

  it('classifies model discovery 401 responses as unauthorized backend errors', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response('expired', { status: 401 }) });

    await expect(backend.listModels(context)).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    await expect(backend.listModels(context)).rejects.toBeInstanceOf(ChatGptBackendError);
  });

  it('classifies responses 429 responses as rate limited backend errors', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response('too many', { status: 429 }) });

    await expect(backend.complete(request, context)).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    await expect(backend.complete(request, context)).rejects.toBeInstanceOf(ChatGptBackendError);
  });
});

function sseResponse(items: Array<Record<string, unknown> | string>): Response {
  const body = items.map((item) => `data: ${typeof item === 'string' ? item : JSON.stringify(item)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
