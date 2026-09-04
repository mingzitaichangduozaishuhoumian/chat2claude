import packageJson from '../package.json' with { type: 'json' };
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
      accountId: 'acct-1',
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
    expect(headers.get('chatgpt-account-id')).toBe('acct-1');
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

  it('forwards canonical reasoning effort and service tier to the Codex responses body', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await backend.complete({ ...request, reasoningEffort: 'xhigh', serviceTier: 'priority' }, context);
    await backend.complete({ ...request, reasoningEffort: 'max', serviceTier: 'priority' }, context);
    expect(calls[0].body).toMatchObject({ reasoning: { effort: 'xhigh' }, service_tier: 'priority' });
    expect(calls[1].body).toMatchObject({ reasoning: { effort: 'max' }, service_tier: 'priority' });
  });

  it('rejects local-only ultra before performing a fetch', async () => {
    let fetchCalls = 0;
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => {
      fetchCalls += 1;
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await expect(backend.complete({ ...request, reasoningEffort: 'ultra' }, context)).rejects.toMatchObject({
      name: 'ChatGptBackendError',
      code: 'invalid_request',
      status: 400,
    });
    expect(fetchCalls).toBe(0);
  });

  it('forwards explicit neutral reasoning and service-tier sentinels', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await backend.complete({ ...request, reasoningEffort: 'none', serviceTier: 'default' }, context);
    expect(calls[0].body).toMatchObject({ reasoning: { effort: 'none' }, service_tier: 'default' });
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
    expect(calls[0].url).toBe(`https://chatgpt.test/backend-api/codex/models?client_version=${packageJson.version}`);
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Headers).get('authorization')).toBe('Bearer token-1');
    expect((calls[0].init.headers as Headers).get('chatgpt-account-id')).toBe('acct-1');
  });

  it('normalizes ordered Codex catalog controls while retaining raw metadata', async () => {
    const rawModel = {
      id: 'gpt-codex',
      display_name: 'Codex',
      default_reasoning_level: 'future-deep',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast' },
        { effort: 'future-deep', description: 'Future' },
        { effort: 'ultra', description: 'Client compatibility mode' },
      ],
      service_tiers: [{ id: 'economy', name: 'Economy', description: 'Queued' }],
      additional_speed_tiers: [{ id: 'priority', name: 'Priority' }],
      default_service_tier: 'economy',
      features: { fast_mode: true },
      multi_agent_reasoning: { effort: 'max' },
      future_catalog_field: { retained: true },
    };
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => Response.json({ models: [rawModel] }) });

    const models = await backend.listModels(context);

    expect(models[0].controls).toEqual({
      reasoning: {
        metadataKnown: true,
        supported: [
          { effort: 'low', description: 'Fast' },
          { effort: 'future-deep', description: 'Future' },
          { effort: 'ultra', description: 'Client compatibility mode' },
        ],
        defaultEffort: 'future-deep',
        multiAgent: { effort: 'max' },
      },
      serviceTier: {
        metadataKnown: true,
        supported: [
          { id: 'economy', name: 'Economy', description: 'Queued' },
          { id: 'priority', name: 'Priority' },
        ],
        defaultTier: 'economy',
        fastMode: true,
      },
    });
    expect(models[0].raw).toEqual(rawModel);
  });

  it('marks absent model-control metadata unknown instead of fabricating support', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => Response.json({ models: [{ id: 'plain-model' }] }) });
    const models = await backend.listModels(context);
    expect(models[0].controls).toEqual({
      reasoning: { metadataKnown: false, supported: [], defaultEffort: undefined },
      serviceTier: { metadataKnown: false, supported: [], defaultTier: undefined, fastMode: false },
    });
  });

  it('allows the Codex model client version to be configured', async () => {
    const calls: string[] = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, clientVersion: '1.2.3', fetch: async (url) => {
      calls.push(String(url));
      return Response.json({ models: [] });
    } });

    await backend.listModels(context);

    expect(calls).toEqual(['https://chatgpt.test/backend-api/codex/models?client_version=1.2.3']);
  });

  it('sends the configured originator on model and response requests', async () => {
    const calls: Array<{ url: string; originator: string | null }> = [];
    const backend = new SessionChatGptBackend({
      baseUrl: 'https://chatgpt.test',
      timeoutMs: 1000,
      originator: 'chat2claude',
      fetch: async (url, init) => {
        calls.push({ url: String(url), originator: new Headers(init?.headers).get('originator') });
        return String(url).includes('/models') ? Response.json({ models: [] }) : sseResponse([{ type: 'response.completed' }]);
      },
    });

    await backend.listModels(context);
    await backend.complete(request, context);

    expect(calls).toEqual([
      { url: `https://chatgpt.test/backend-api/codex/models?client_version=${packageJson.version}`, originator: 'chat2claude' },
      { url: 'https://chatgpt.test/backend-api/codex/responses', originator: 'chat2claude' },
    ]);
  });

  it('propagates caller cancellation to the active models fetch without reporting a timeout', async () => {
    const fetchStarted = deferred<void>();
    let transportAborted = false;
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 60_000, fetch: async (_url, init) => {
      fetchStarted.resolve();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error('missing transport signal'));
        const abort = () => {
          transportAborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    } });
    const controller = new AbortController();
    const pending = backend.listModels({ ...context, signal: controller.signal });
    await fetchStarted.promise;

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportAborted).toBe(true);
  });

  it('retains timeout classification when no caller cancellation occurs', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 5, fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true });
    }) });

    await expect(backend.listModels(context)).rejects.toMatchObject({ code: 'timeout', status: 504 });
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

  it('fetches authoritative account quota from /wham/usage with selected account headers', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test/backend-api', timeoutMs: 1000, clientVersion: '9.8.7', originator: 'chat2claude', fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return Response.json({
        account_id: 'provider-account', user_id: 'provider-user', plan_type: 'plus',
        rate_limit_reached_type: { type: 'primary_window' },
        rate_limit: {
          allowed: true, limit_reached: false, rate_limit_reached_type: 'must-not-use-nested-value',
          primary_window: { used_percent: 25.5, limit_window_seconds: 18_000, reset_after_seconds: 900, reset_at: 1_800_000_000 },
          secondary_window: { used_percent: 70, limit_window_seconds: 604_800, reset_after_seconds: 86_400, reset_at: 1_800_604_800 },
        },
        additional_rate_limits: [{
          metered_feature: 'codex_other', limit_name: 'Other meter',
          rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 3600 } },
        }],
        rate_limit_reset_credits: { available_count: 3 },
        spend_control: { hard_limit_usd: '12.34' },
        future_top_level: { secret: 'drop' },
      });
    } });

    await expect(backend.getAccountQuota!(context)).resolves.toEqual({
      providerAccountId: 'provider-account', providerUserId: 'provider-user', planType: 'plus',
      allowed: true, limitReached: false, rateLimitReachedType: 'primary_window',
      windows: [
        { position: 'primary', descriptor: 'five-hour', usedPercent: 25.5, durationSeconds: 18_000, resetAfterSeconds: 900, resetAt: '2027-01-15T08:00:00.000Z' },
        { position: 'secondary', descriptor: 'weekly', usedPercent: 70, durationSeconds: 604_800, resetAfterSeconds: 86_400, resetAt: '2027-01-22T08:00:00.000Z' },
      ],
      additionalLimits: [{
        meteredFeature: 'codex_other', limitName: 'Other meter', allowed: false, limitReached: true,
        windows: [{ position: 'primary', descriptor: 'primary-3600-seconds', usedPercent: 100, durationSeconds: 3600 }],
      }],
      resetCredits: { availableCount: 3 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://chatgpt.test/backend-api/wham/usage');
    expect(calls[0].headers.get('authorization')).toBe('Bearer token-1');
    expect(calls[0].headers.get('chatgpt-account-id')).toBe('acct-1');
    expect(calls[0].headers.get('originator')).toBe('chat2claude');
    expect(calls[0].headers.get('accept')).toBe('application/json');
  });

  it('preserves a single positional window and keeps absent windows unavailable', async () => {
    const payloads = [
      { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } } },
      { rate_limit: {} },
    ];
    const backend = new SessionChatGptBackend({
      baseUrl: 'https://chatgpt.test/backend-api',
      timeoutMs: 1000,
      fetch: async () => Response.json(payloads.shift()),
    });

    await expect(backend.getAccountQuota!(context)).resolves.toEqual({
      windows: [{ position: 'primary', descriptor: 'five-hour', usedPercent: 10, durationSeconds: 18_000 }],
    });
    await expect(backend.getAccountQuota!(context)).resolves.toEqual({ windows: [] });
  });

  it('keeps missing quota values unavailable and drops malformed provider numbers and nullable allowance', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test/backend-api', timeoutMs: 1000, fetch: async () => Response.json({
      rate_limit: {
        allowed: null,
        limit_reached: true,
        primary_window: { used_percent: -1, limit_window_seconds: 0, reset_after_seconds: Number.NaN, reset_at: -4 },
        secondary_window: { used_percent: 101, limit_window_seconds: 7200, reset_after_seconds: 0, reset_at: 0 },
        unknown: 'drop',
      },
      additional_rate_limits: [
        { metered_feature: 'one', rate_limit: { allowed: true } },
        { limit_name: 'two', rate_limit: { primary_window: { used_percent: 50 } } },
        null,
      ],
      rate_limit_reset_credits: { available_count: -1 },
    }) });

    await expect(backend.getAccountQuota!(context)).resolves.toEqual({
      limitReached: true,
      windows: [
        { position: 'primary', descriptor: 'primary' },
        { position: 'secondary', descriptor: 'secondary-7200-seconds', durationSeconds: 7200, resetAfterSeconds: 0, resetAt: '1970-01-01T00:00:00.000Z' },
      ],
      additionalLimits: [
        { meteredFeature: 'one', allowed: true, windows: [] },
        { limitName: 'two', windows: [{ position: 'primary', descriptor: 'primary', usedPercent: 50 }] },
      ],
    });
  });

  it.each([
    [401, 'unauthorized'], [403, 'unauthorized'], [429, 'rate_limited'], [500, 'upstream_error'],
  ] as const)('classifies quota HTTP %s as %s', async (status, code) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test/backend-api', timeoutMs: 1000, fetch: async () => new Response('provider detail must not escape', { status }) });
    await expect(backend.getAccountQuota!(context)).rejects.toMatchObject({ code, status });
  });

  it('keeps timeout active through quota response body parsing and allows the next refresh', async () => {
    let calls = 0;
    const backend = new SessionChatGptBackend({
      baseUrl: 'https://chatgpt.test/backend-api',
      timeoutMs: 10,
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Response(new ReadableStream({ start() {} }), { status: 200 });
        return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
      },
    });

    await expect(backend.getAccountQuota!(context)).rejects.toMatchObject({ code: 'timeout', status: 504 });
    await expect(backend.getAccountQuota!(context)).resolves.toEqual({
      windows: [{ position: 'primary', descriptor: 'primary', usedPercent: 10 }],
    });
    expect(calls).toBe(2);
  }, 500);

  it('applies caller cancellation while reading the quota response body', async () => {
    const backend = new SessionChatGptBackend({
      baseUrl: 'https://chatgpt.test/backend-api',
      timeoutMs: 60_000,
      fetch: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
    });
    const controller = new AbortController();
    const pending = backend.getAccountQuota!({ ...context, signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  }, 500);

  it('applies timeout and caller cancellation to quota fetches', async () => {
    const hangingFetch: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const timeoutBackend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test/backend-api', timeoutMs: 5, fetch: hangingFetch });
    await expect(timeoutBackend.getAccountQuota!(context)).rejects.toMatchObject({ code: 'timeout', status: 504 });

    const controller = new AbortController();
    const cancelBackend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test/backend-api', timeoutMs: 60_000, fetch: hangingFetch });
    const pending = cancelBackend.getAccountQuota!({ ...context, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

function sseResponse(items: Array<Record<string, unknown> | string>): Response {
  const body = items.map((item) => `data: ${typeof item === 'string' ? item : JSON.stringify(item)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
