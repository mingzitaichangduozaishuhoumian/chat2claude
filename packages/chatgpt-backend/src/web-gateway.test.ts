import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configuredWebGatewayModels, supportsWebGatewayRequest, WebGatewayChatGptBackend,
  type ChatGptBackendRequestContext, type ChatGptCompletionRequest, type ChatGptStreamEvent, type WebGatewayConfiguration,
} from './index.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const configuration: WebGatewayConfiguration = { baseUrl: 'http://127.0.0.1:3000', apiKey: 'gateway-only', models: ['web-auto'] };
const request: ChatGptCompletionRequest = { model: 'web-auto', maxTokens: 128, messages: [{ role: 'user', content: 'Hello' }] };
const context: ChatGptBackendRequestContext = { account: { id: 'session-account', provider: 'chatgpt-session', secret: {
  type: 'chatgpt-session', accessToken: 'SESSION_TOKEN_CANARY', cookie: 'SESSION_COOKIE_CANARY', accountId: 'SESSION_ACCOUNT_CANARY',
  deviceId: 'SESSION_DEVICE_CANARY', userAgent: 'SESSION_AGENT_CANARY', refreshToken: 'SESSION_REFRESH_CANARY',
} } };

function jsonCompletion(message: Record<string, unknown> = { role: 'assistant', content: 'Hello back' }, finishReason = 'stop'): Response {
  return Response.json({ choices: [{ index: 0, message, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
}

function makeBackend(response: Response | (() => Promise<Response>), config: WebGatewayConfiguration = configuration, timeoutMs = 1_000) {
  const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => typeof response === 'function' ? response() : response);
  const backend = new WebGatewayChatGptBackend({ getConfiguration: () => config, fetch: fetchMock, timeoutMs });
  return { backend, fetchMock };
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function sse(source: string): Response { return new Response(source, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }); }
async function collect(iterable: AsyncIterable<ChatGptStreamEvent>): Promise<ChatGptStreamEvent[]> {
  const events: ChatGptStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('WebGatewayChatGptBackend', () => {
  it('excludes explicitly unsupported strict tool schemas before dispatch while preserving non-strict tools', async () => {
    const toolRequest = { ...request, tools: [{ name: 'lookup', inputSchema: { type: 'object' }, strict: true }] };
    const config = { ...configuration, supportsTools: true, supportsStrictTools: false };
    expect(supportsWebGatewayRequest(toolRequest, config)).toBe(false);
    const { backend, fetchMock } = makeBackend(jsonCompletion(), config);
    await expect(backend.complete(toolRequest)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(supportsWebGatewayRequest({ ...toolRequest, tools: [{ ...toolRequest.tools[0], strict: false }] }, config)).toBe(true);
    expect(supportsWebGatewayRequest(toolRequest, { ...config, supportsStrictTools: true })).toBe(true);
    expect(supportsWebGatewayRequest(toolRequest, { ...configuration, supportsTools: true })).toBe(true);
  });
  it('uses exact configured model IDs and independent fresh capability metadata', async () => {
    const fetchMock = vi.fn();
    let config: WebGatewayConfiguration | undefined = { ...configuration, models: ['chatgpt-auto', 'exact-provider-id'] };
    const backend = new WebGatewayChatGptBackend({ getConfiguration: () => config, fetch: fetchMock });
    const models = await backend.listModels(context);
    expect(models.map((model) => model.id)).toEqual(config.models);
    expect(models[0]).toMatchObject({ capabilities: { tools: false, vision: false, input_image: false, input_modalities: ['text'] }, controls: {
      reasoning: { metadataKnown: true, supported: [] }, serviceTier: { metadataKnown: true, supported: [], fastMode: false },
    } });
    models[0].controls!.reasoning.supported.push({ effort: 'high' });
    expect((await backend.listModels())[0].controls!.reasoning.supported).toEqual([]);
    config = { ...config, supportsTools: true, models: ['replacement'] };
    expect(await backend.listModels()).toMatchObject([{ id: 'replacement', capabilities: { tools: true } }]);
    expect(configuredWebGatewayModels(undefined)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('publishes image input capability only after explicit opt-in and keeps catalog arrays independent', async () => {
    const config = { ...configuration, supportsImages: true };
    const { backend, fetchMock } = makeBackend(jsonCompletion(), config);
    const models = await backend.listModels();
    expect(models[0].capabilities).toMatchObject({ tools: false, vision: true, input_image: true, input_modalities: ['text', 'image'] });
    (models[0].capabilities!.input_modalities as string[]).push('video');
    expect((await backend.listModels())[0].capabilities!.input_modalities).toEqual(['text', 'image']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves user text/image order, details, signed URLs and data images across conversation turns', async () => {
    const config = { ...configuration, supportsImages: true };
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const url = 'https://images.test/photo.png?signature=a%2Fb&expires=123';
    const mapped: ChatGptCompletionRequest = { ...request, inputItems: [
      { type: 'message', role: 'system', content: [{ type: 'text', text: 'Read images.' }] },
      { type: 'message', role: 'user', content: [
        { type: 'text', text: 'Compare ' }, { type: 'image', imageUrl: url, detail: 'high' },
        { type: 'text', text: ' with ' }, { type: 'image', imageUrl: image }, { type: 'text', text: '.' },
      ] },
      { type: 'message', role: 'assistant', content: 'The first image differs.' },
      { type: 'message', role: 'user', content: [{ type: 'image', imageUrl: image, detail: 'low' }, { type: 'text', text: 'Look again.' }] },
    ] };
    expect(supportsWebGatewayRequest(mapped, config)).toBe(true);
    expect(supportsWebGatewayRequest({ ...mapped, model: 'WEB-AUTO' }, config)).toBe(false);
    const { backend, fetchMock } = makeBackend(jsonCompletion(), config);
    await backend.complete(mapped);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).messages).toEqual([
      { role: 'system', content: 'Read images.' },
      { role: 'user', content: [
        { type: 'text', text: 'Compare ' }, { type: 'image_url', image_url: { url, detail: 'high' } },
        { type: 'text', text: ' with ' }, { type: 'image_url', image_url: { url: image } }, { type: 'text', text: '.' },
      ] },
      { role: 'assistant', content: 'The first image differs.' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: image, detail: 'low' } }, { type: 'text', text: 'Look again.' }] },
    ]);
  });

  it.each(['png', 'jpeg', 'webp', 'gif'])('accepts canonical base64 %s data URLs without fetching images', async (mime) => {
    const imageUrl = `data:image/${mime};base64,AA==`;
    const mapped: ChatGptCompletionRequest = { ...request, inputItems: [{ type: 'message', role: 'user', content: [{ type: 'image', imageUrl, detail: 'auto' }] }] };
    const config = { ...configuration, supportsImages: true };
    expect(supportsWebGatewayRequest(mapped, config)).toBe(true);
    const { backend, fetchMock } = makeBackend(jsonCompletion(), config);
    await backend.complete(mapped);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3000/v1/chat/completions');
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).messages[0].content).toEqual([{ type: 'image_url', image_url: { url: imageUrl, detail: 'auto' } }]);
  });

  it('keeps tool and image opt-in independent and forwards both when enabled', async () => {
    const mapped: ChatGptCompletionRequest = { ...request, inputItems: [{ type: 'message', role: 'user', content: [{ type: 'image', imageUrl: 'https://images.test/picture.png' }] }] };
    for (const config of [configuration, { ...configuration, supportsTools: true }, { ...configuration, supportsImages: false }]) {
      expect(supportsWebGatewayRequest(mapped, config)).toBe(false);
      const { backend, fetchMock } = makeBackend(jsonCompletion(), config);
      await expect(backend.complete(mapped)).rejects.toMatchObject({ code: 'invalid_request', message: 'Web gateway image input support is disabled.' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
    const imageOnly = { ...configuration, supportsImages: true };
    expect(supportsWebGatewayRequest(mapped, imageOnly)).toBe(true);
    const withTools = { ...mapped, tools: [{ name: 'inspect', inputSchema: {} }] };
    expect(supportsWebGatewayRequest(withTools, imageOnly)).toBe(false);
    const both = { ...imageOnly, supportsTools: true };
    expect(supportsWebGatewayRequest(withTools, both)).toBe(true);
    const { backend, fetchMock } = makeBackend(jsonCompletion(), both);
    await backend.complete(withTools);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({ tools: [{ function: { name: 'inspect' } }], messages: [{ content: [{ type: 'image_url' }] }] });
  });

  it('does not advertise or enable image generation when image input is enabled', async () => {
    const config = { ...configuration, supportsImages: true, supportsTools: true };
    const { backend, fetchMock } = makeBackend(jsonCompletion(), config);
    expect((await backend.listModels())[0].capabilities!.image_generation).toBeUndefined();
    const mapped = { ...request, backendOptions: { responsesBody: { tools: [{ type: 'image_generation' }] } } };
    expect(supportsWebGatewayRequest(mapped, config)).toBe(false);
    await expect(backend.complete(mapped)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects images on system, assistant and tool messages rather than losing image content', async () => {
    const image = [{ type: 'image' as const, imageUrl: 'https://images.test/result.png' }];
    const config = { ...configuration, supportsTools: true, supportsImages: true };
    const inputs: NonNullable<ChatGptCompletionRequest['inputItems']>[] = [
      [{ type: 'message', role: 'system', content: image }],
      [{ type: 'message', role: 'assistant', content: image }],
      [{ type: 'function_call', callId: 'call_1', name: 'inspect', arguments: {} }, { type: 'function_call_output', callId: 'call_1', output: [{ type: 'text', text: 'Image result' }, ...image] }],
    ];
    for (const inputItems of inputs) {
      const mapped = { ...request, inputItems };
      expect(supportsWebGatewayRequest(mapped, config)).toBe(false);
      const { backend, fetchMock } = makeBackend(jsonCompletion(), config);
      await expect(backend.complete(mapped)).rejects.toMatchObject({ code: 'invalid_request', message: 'Web gateway images are only supported in user messages.' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it.each([
    'file:///tmp/image.png', 'javascript:alert(1)', 'http://images.test/image.png', 'https://user:password@images.test/image.png',
    'https://images.test/image.png#fragment', 'https://images.test/white space.png', 'https://images.test/' + 'x'.repeat(8192),
    'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpg;base64,AA==', 'data:image/png,raw', 'data:image/png;base64,',
    'data:image/png;base64,AA', 'data:image/png;base64,AB==', 'data:image/png;base64,AA===', 'data:image/png;base64,A!==',
    'data:image/png;base64,AA==\n', 'data:image/png;base64,AA-_',
  ])('rejects invalid image URL without contacting the gateway: %s', async (imageUrl) => {
    const config = { ...configuration, supportsImages: true };
    const mapped: ChatGptCompletionRequest = { ...request, inputItems: [{ type: 'message', role: 'user', content: [{ type: 'image', imageUrl }] }] };
    expect(supportsWebGatewayRequest(mapped, config)).toBe(false);
    const { backend, fetchMock } = makeBackend(jsonCompletion(), config);
    await expect(backend.complete(mapped)).rejects.toMatchObject({ code: 'invalid_request', message: 'Invalid web gateway image URL.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies the 16 MiB request limit to individual and combined inline images', async () => {
    const config = { ...configuration, supportsImages: true };
    const images = [
      ['data:image/png;base64,' + 'A'.repeat(16 * 1024 * 1024)],
      Array.from({ length: 2 }, () => 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024)),
    ];
    for (const urls of images) {
      const mapped: ChatGptCompletionRequest = { ...request, inputItems: [{ type: 'message', role: 'user', content: urls.map((imageUrl) => ({ type: 'image', imageUrl })) }] };
      expect(supportsWebGatewayRequest(mapped, config)).toBe(false);
      const { backend, fetchMock } = makeBackend(jsonCompletion(), config);
      await expect(backend.complete(mapped)).rejects.toMatchObject({ code: 'invalid_request' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid image detail without exposing inline image data in errors', async () => {
    const base64 = Buffer.from('IMAGE_BASE64_CANARY').toString('base64');
    const imageUrl = `data:image/png;base64,${base64}`;
    const config = { ...configuration, supportsImages: true };
    const mapped = { ...request, inputItems: [{ type: 'message', role: 'user', content: [{ type: 'image', imageUrl, detail: 'unknown' }] }] } as unknown as ChatGptCompletionRequest;
    expect(supportsWebGatewayRequest(mapped, config)).toBe(false);
    const { backend, fetchMock } = makeBackend(jsonCompletion(), config);
    const error = await backend.complete(mapped).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'invalid_request', message: 'Invalid web gateway image detail.' });
    expect(String(error) + JSON.stringify(error)).not.toContain(base64);
    expect(String(error) + JSON.stringify(error)).not.toContain(imageUrl);
    expect((error as Error).cause).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a complete multi-turn tool conversation and isolates session credentials', async () => {
    const { backend, fetchMock } = makeBackend(jsonCompletion(), { ...configuration, baseUrl: 'https://gateway.test/api/v1/', supportsTools: true });
    await backend.complete({ ...request, messages: [{ role: 'user', content: 'FALLBACK_MUST_NOT_BE_SENT' }], inputItems: [
      { type: 'message', role: 'system', content: 'Be concise' },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'Find ' }, { type: 'text', text: 'weather' }] },
      { type: 'message', role: 'assistant', content: 'Checking' },
      { type: 'function_call', callId: 'call_1', name: 'weather', arguments: '{"city":"Paris","large":9007199254740993}' },
      { type: 'function_call', callId: 'call_2', name: 'clock', arguments: { zone: 'UTC' } },
      { type: 'function_call_output', callId: 'call_1', output: [{ type: 'text', text: 'Sunny' }], isError: false },
      { type: 'function_call_output', callId: 'call_2', output: 'Noon' },
      { type: 'message', role: 'user', content: 'Summarize' },
    ], tools: [{ name: 'weather', description: 'Weather', inputSchema: { type: 'object' }, strict: true }],
    toolChoice: { type: 'tool', name: 'weather' }, parallelToolCalls: false, temperature: 0.4, topP: 0.9, stopSequences: ['END'],
    reasoningEffort: 'none', serviceTier: 'default' }, context);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.test/api/v1/chat/completions');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    const headers = new Headers(init!.headers);
    expect([...headers]).toEqual([['accept', 'application/json, text/event-stream'], ['authorization', 'Bearer gateway-only'], ['content-type', 'application/json']]);
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({
      model: 'web-auto', max_tokens: 128, stream: false,
      messages: [
        { role: 'system', content: 'Be concise' }, { role: 'user', content: 'Find weather' },
        { role: 'assistant', content: 'Checking', tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris","large":9007199254740993}' } },
          { id: 'call_2', type: 'function', function: { name: 'clock', arguments: '{"zone":"UTC"}' } },
        ] },
        { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' }, { role: 'tool', tool_call_id: 'call_2', content: 'Noon' },
        { role: 'user', content: 'Summarize' },
      ],
      tools: [{ type: 'function', function: { name: 'weather', description: 'Weather', parameters: { type: 'object' }, strict: true } }],
      tool_choice: { type: 'function', function: { name: 'weather' } }, parallel_tool_calls: false, temperature: 0.4, top_p: 0.9, stop: ['END'],
    });
    expect(JSON.stringify([url, init!.body, [...headers]])).not.toContain('SESSION_');
  });

  it('maps required/none tool choices and tool-only assistant turns', async () => {
    for (const choice of ['any', 'none'] as const) {
      const { backend, fetchMock } = makeBackend(jsonCompletion(), { ...configuration, supportsTools: true });
      await backend.complete({ ...request, inputItems: [
        { type: 'function_call', callId: 'one', name: 'first', arguments: {} },
        { type: 'function_call_output', callId: 'one', output: 'ok' },
      ], toolChoice: { type: choice } });
      const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
      expect(body.tool_choice).toBe(choice === 'any' ? 'required' : 'none');
      expect(body.messages[0]).toMatchObject({ role: 'assistant', content: null, tool_calls: [{ id: 'one' }] });
    }
  });

  it('never falls back to account credentials when the gateway has no API key', async () => {
    const { backend, fetchMock } = makeBackend(jsonCompletion(), { baseUrl: configuration.baseUrl, models: ['web-auto'] });
    await backend.complete(request, context);
    const headers = new Headers(fetchMock.mock.calls[0][1]!.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(JSON.stringify([...headers])).not.toContain('SESSION_');
  });

  it('shares capability validation with routing and ignores internal mapper diagnostics', async () => {
    const mapped = { ...request, backendOptions: { mappingDiagnostics: [{ code: 'internal' }] } };
    expect(supportsWebGatewayRequest(mapped, configuration)).toBe(true);
    expect(supportsWebGatewayRequest({ ...mapped, reasoningEffort: 'high' }, configuration)).toBe(false);
    expect(supportsWebGatewayRequest(mapped, undefined)).toBe(false);
    const { backend, fetchMock } = makeBackend(jsonCompletion());
    await backend.complete(mapped);
    expect(fetchMock.mock.calls[0][1]!.body).not.toContain('mappingDiagnostics');
  });

  it('forwards ordinary Claude Code and Responses metadata without forwarding protocol wrappers', async () => {
    for (const backendOptions of [
      { mappingDiagnostics: [], claudeRequest: { metadata: { user_id: 'claude-code-user' }, service_tier: 'standard' } },
      { responsesBody: { metadata: { user_id: 'claude-code-user' }, parallel_tool_calls: false, previous_response_id: null } },
      { claudeRequest: { metadata: { user_id: 'claude-code-user' } }, responsesBody: { metadata: { user_id: 'claude-code-user' } } },
    ]) {
      const mapped = { ...request, serviceTier: 'default', speedPreference: 'standard', backendOptions };
      expect(supportsWebGatewayRequest(mapped, configuration)).toBe(true);
      const { backend, fetchMock } = makeBackend(jsonCompletion());
      await backend.complete(mapped);
      const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
      expect(body.metadata).toEqual({ user_id: 'claude-code-user' });
      if ('responsesBody' in backendOptions && backendOptions.responsesBody?.parallel_tool_calls === false) expect(body.parallel_tool_calls).toBe(false);
      expect(body).not.toHaveProperty('claudeRequest');
      expect(body).not.toHaveProperty('responsesBody');
      expect(body).not.toHaveProperty('previous_response_id');
      expect(body).not.toHaveProperty('service_tier');
    }
    const config = { ...configuration, supportsTools: true };
    const mapped = { ...request, tools: [{ name: 'lookup', inputSchema: {} }], backendOptions: { responsesBody: { metadata: null, parallel_tool_calls: true } } };
    const { backend, fetchMock } = makeBackend(jsonCompletion(), config);
    await backend.complete(mapped);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({ metadata: null, parallel_tool_calls: true });
  });

  it('rejects conflicting projected fields instead of overriding another request source', async () => {
    const cases: Array<{ override: Partial<ChatGptCompletionRequest>; message: string }> = [
      { override: { backendOptions: { claudeRequest: { metadata: { user_id: 'one' } }, responsesBody: { metadata: { user_id: 'two' } } } }, message: 'Conflicting web gateway metadata.' },
      { override: { parallelToolCalls: false, backendOptions: { responsesBody: { parallel_tool_calls: true } } }, message: 'Conflicting web gateway parallel_tool_calls.' },
      { override: { serviceTier: 'default', speedPreference: 'standard', backendOptions: { claudeRequest: { service_tier: 'auto' } } }, message: 'Conflicting web gateway service tier controls.' },
      { override: { serviceTier: 'default', speedPreference: 'auto', backendOptions: { claudeRequest: { service_tier: 'standard' } } }, message: 'Conflicting web gateway service tier controls.' },
    ];
    for (const { override, message } of cases) {
      const mapped = { ...request, ...override };
      expect(supportsWebGatewayRequest(mapped, { ...configuration, supportsTools: true })).toBe(false);
      const { backend, fetchMock } = makeBackend(jsonCompletion(), { ...configuration, supportsTools: true });
      await expect(backend.complete(mapped)).rejects.toMatchObject({ code: 'invalid_request', message });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('does not let metadata bypass unsupported native capabilities or field validation', async () => {
    const options: Array<Record<string, unknown>> = [
      { claudeRequest: { metadata: { user_id: 'user' }, container: {} } },
      { claudeRequest: { metadata: { user_id: 'user' }, context_management: {} } },
      { claudeRequest: { metadata: { user_id: 'user' }, mcp_servers: [] } },
      { claudeRequest: { metadata: { user_id: 'user' }, service_tier: 'priority' } },
      { claudeRequest: { metadata: { user_id: 123 } } },
      { responsesBody: { metadata: {}, text: { format: { type: 'json_object' } } } },
      { responsesBody: { metadata: {}, tools: [{ type: 'web_search' }] } },
      { responsesBody: { metadata: {}, truncation: 'auto' } },
      { responsesBody: { metadata: {}, previous_response_id: 'upstream-history' } },
      { responsesBody: { metadata: [], parallel_tool_calls: false } },
      { responsesBody: { metadata: {}, parallel_tool_calls: 'false' } },
      { responsesBody: { metadata: {}, parallel_tool_calls: true } },
    ];
    for (const backendOptions of options) {
      const mapped = { ...request, backendOptions };
      expect(supportsWebGatewayRequest(mapped, configuration)).toBe(false);
      const { backend, fetchMock } = makeBackend(jsonCompletion());
      await expect(backend.complete(mapped)).rejects.toMatchObject({ code: 'invalid_request' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('projects visible Responses function-call replay and its output into ordinary tool history', async () => {
    const config = { ...configuration, supportsTools: true };
    const rawArguments = '{ "value": 9007199254740993 }';
    const continuation: ChatGptCompletionRequest = { ...request, inputItems: [
      { type: 'message', role: 'user', content: 'Look up this value' },
      { type: 'replay', item: { type: 'function_call', id: 'fc_response', call_id: 'call_response', name: 'lookup', arguments: rawArguments, status: 'completed' } },
      { type: 'function_call_output', callId: 'call_response', output: 'Found it' },
    ] };
    expect(supportsWebGatewayRequest(continuation, config)).toBe(true);
    expect(supportsWebGatewayRequest(continuation, configuration)).toBe(false);
    const { backend, fetchMock } = makeBackend(jsonCompletion(), config);
    await backend.complete(continuation);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).messages).toEqual([
      { role: 'user', content: 'Look up this value' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_response', type: 'function', function: { name: 'lookup', arguments: rawArguments } }] },
      { role: 'tool', tool_call_id: 'call_response', content: 'Found it' },
    ]);
    expect(fetchMock.mock.calls[0][1]!.body).not.toContain('fc_response');
  });

  it('rejects encrypted reasoning replay even with gateway tool support enabled', async () => {
    const config = { ...configuration, supportsTools: true };
    const continuation: ChatGptCompletionRequest = { ...request, inputItems: [
      { type: 'replay', item: { type: 'reasoning', id: 'reasoning', summary: [], encrypted_content: 'ENCRYPTED_REPLAY_CANARY' } },
      { type: 'replay', item: { type: 'function_call', call_id: 'call_response', name: 'lookup', arguments: '{}' } },
      { type: 'function_call_output', callId: 'call_response', output: 'Found it' },
    ] };
    expect(supportsWebGatewayRequest(continuation, config)).toBe(false);
    const { backend, fetchMock } = makeBackend(jsonCompletion(), config);
    const error = await backend.complete(continuation).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'invalid_request' });
    expect(String(error) + JSON.stringify(error)).not.toContain('ENCRYPTED_REPLAY_CANARY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([{ status: 'in_progress' }, { async: true }, { namespace: 'provider' }, { caller: { type: 'program', caller_id: 'program' } }])(
    'rejects provider-specific tool replay execution semantics: %j', async (fields) => {
      const { backend, fetchMock } = makeBackend(jsonCompletion(), { ...configuration, supportsTools: true });
      const continuation = { ...request, inputItems: [{ type: 'replay', item: { type: 'function_call', call_id: 'call', name: 'lookup', arguments: '{}', ...fields } }] } as ChatGptCompletionRequest;
      await expect(backend.complete(continuation)).rejects.toMatchObject({ code: 'invalid_request' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('accepts complete JSON text, refusal, usage and exact raw tool arguments', async () => {
    const { backend } = makeBackend(jsonCompletion());
    expect(await backend.complete(request)).toEqual({ text: 'Hello back', finishReason: 'stop', terminalSuccessful: true, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } });
    const refusal = makeBackend(jsonCompletion({ role: 'assistant', content: null, refusal: 'Cannot help' }, 'content_filter')).backend;
    expect(await refusal.complete(request)).toMatchObject({ text: '', refusal: 'Cannot help', finishReason: 'content_filter' });
    const rawArguments = '{"value":9007199254740993}';
    const tools = makeBackend(jsonCompletion({ role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'exact', arguments: rawArguments } },
    ] }, 'tool_calls'), { ...configuration, supportsTools: true }).backend;
    expect((await tools.complete(request)).toolCalls).toEqual([{ id: 'call_1', name: 'exact', input: JSON.parse(rawArguments), rawArguments }]);
  });

  it('emits a readiness barrier and requires both SSE finish reason and DONE', async () => {
    const source = ': heartbeat\n\n' + chunk({ role: 'assistant' }) + chunk({ content: 'Hi ' }) + chunk({ content: 'there' }) + chunk({}, 'stop')
      + 'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n' + 'data: [DONE]\n\n';
    const { backend, fetchMock } = makeBackend(sse(source));
    expect(await collect(backend.stream(request))).toEqual([
      { type: 'upstream_ready' }, { type: 'text_delta', text: 'Hi ' }, { type: 'text_delta', text: 'there' },
      { type: 'done', terminalSuccessful: true, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).stream).toBe(true);
  });

  it('assembles interleaved streamed tool calls before publishing them', async () => {
    const source = chunk({ tool_calls: [
      { index: 1, id: 'call_b', type: 'function', function: { name: 'clock', arguments: '{"z' } },
      { index: 0, id: 'call_a', type: 'function', function: { name: 'wea', arguments: '{"city":' } },
    ] }) + chunk({ tool_calls: [
      { index: 0, function: { name: 'ther', arguments: '"Paris"}' } },
      { index: 1, function: { arguments: 'one":"UTC"}' } },
    ] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
    const { backend } = makeBackend(sse(source), { ...configuration, supportsTools: true });
    expect(await collect(backend.stream(request))).toEqual([
      { type: 'upstream_ready' },
      { type: 'tool_call', toolCall: { id: 'call_a', name: 'weather', input: { city: 'Paris' }, rawArguments: '{"city":"Paris"}' } },
      { type: 'tool_call', toolCall: { id: 'call_b', name: 'clock', input: { zone: 'UTC' }, rawArguments: '{"zone":"UTC"}' } },
      { type: 'done', terminalSuccessful: true, finishReason: 'tool_calls' },
    ]);
  });

  it('does not publish incomplete streamed tool arguments or unsolicited tools', async () => {
    const source = chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'tool', arguments: '{"incomplete":' } }] })
      + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
    const { backend } = makeBackend(sse(source), { ...configuration, supportsTools: true });
    const events: ChatGptStreamEvent[] = [];
    await expect((async () => { for await (const event of backend.stream(request)) events.push(event); })()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(events).toEqual([{ type: 'upstream_ready' }]);
    const unsolicited = makeBackend(jsonCompletion({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'tool', arguments: '{}' } }] }, 'tool_calls')).backend;
    await expect(unsolicited.complete(request)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('handles UTF-8 and CRLF split across arbitrary transport chunks', async () => {
    const bytes = new TextEncoder().encode((chunk({ content: '你好🌍' }) + chunk({}, 'stop') + 'data: [DONE]\n\n').replace(/\n/g, '\r\n'));
    let index = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { if (index === bytes.length) controller.close(); else controller.enqueue(bytes.slice(index, ++index)); } });
    const { backend } = makeBackend(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    expect(await backend.complete(request)).toMatchObject({ text: '你好🌍', terminalSuccessful: true });
  });

  it('accepts standalone CR line endings and rejects malformed UTF-8', async () => {
    const source = (chunk({ content: 'CR' }) + chunk({}, 'stop') + 'data: [DONE]\n\n').replace(/\n/g, '\r');
    expect(await makeBackend(sse(source)).backend.complete(request)).toMatchObject({ text: 'CR' });
    const invalid = new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } });
    await expect(makeBackend(invalid).backend.complete(request)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('accepts a complete JSON response to a streaming request', async () => {
    const { backend } = makeBackend(jsonCompletion());
    expect(await collect(backend.stream(request))).toEqual([
      { type: 'upstream_ready' }, { type: 'text_delta', text: 'Hello back' },
      { type: 'done', terminalSuccessful: true, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } },
    ]);
  });

  it.each([
    chunk({ content: 'partial' }),
    chunk({ content: 'partial' }) + chunk({}, 'stop'),
    chunk({ content: 'partial' }) + 'data: [DONE]\n\n',
    chunk({}, 'stop') + 'data: [DONE]',
    'data: {broken}\n\n',
    'data: {"error":{"message":"BODY_CANARY"}}\n\n',
    'data: {"choices":[{"index":1,"delta":{"content":"wrong choice"},"finish_reason":null}]}\n\n',
    chunk({}, 'stop') + chunk({ content: 'after finish' }) + 'data: [DONE]\n\n',
    'data: ' + 'x'.repeat(1024 * 1024 + 1) + '\n\n',
  ])('rejects malformed, oversized or truncated SSE without reporting success', async (source) => {
    const { backend } = makeBackend(sse(source));
    const seen: ChatGptStreamEvent[] = [];
    const result = (async () => { for await (const event of backend.stream(request)) seen.push(event); })();
    await expect(result).rejects.toMatchObject({ code: 'invalid_response' });
    expect(seen.some((event) => event.type === 'done')).toBe(false);
  });

  it.each([
    { choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: null }] },
    { choices: [{ index: 0, message: { role: 'assistant', content: 'bad' }, finish_reason: 'error' }] },
    { error: { message: 'BODY_CANARY' }, choices: [] },
    { choices: [{ index: 0, message: { role: 'assistant', content: 12 }, finish_reason: 'stop' }] },
  ])('rejects incomplete or invalid JSON completions', async (payload) => {
    const { backend } = makeBackend(Response.json(payload));
    await expect(backend.complete(request)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    { reasoningEffort: 'high' }, { reasoningExecution: { effort: 'max', delegation: 'proactive' } }, { serviceTier: 'priority' },
    { inputItems: [{ type: 'replay', item: { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'secret' } }] },
    { inputItems: [{ type: 'message', role: 'user', content: [{ type: 'image', imageUrl: 'data:image/png;base64,AA==' }] }] },
    { tools: [{ name: 'tool', inputSchema: {} }] }, { toolChoice: { type: 'any' } },
    { inputItems: [{ type: 'function_call', callId: 'one', name: 'tool', arguments: {} }] },
    { backendOptions: { responsesBody: { tools: [{ type: 'web_search' }] } } },
    { model: 'unconfigured' },
  ])('rejects unsupported capability requests before contacting the gateway', async (override) => {
    const { backend, fetchMock } = makeBackend(jsonCompletion());
    await expect(backend.complete({ ...request, ...override } as ChatGptCompletionRequest)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([[401, 'unauthorized'], [403, 'unauthorized'], [429, 'rate_limited'], [400, 'invalid_request'], [422, 'invalid_request'], [500, 'upstream_error']] as const)(
    'classifies HTTP %s without exposing error bodies, headers, addresses or credentials', async (status, code) => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ pull() { throw new Error('BODY_CANARY'); }, cancel }, { highWaterMark: 0 });
      const { backend } = makeBackend(new Response(body, { status, headers: { 'x-error': 'HEADER_CANARY' } }), { ...configuration, baseUrl: 'https://URL_CANARY.test', apiKey: 'TOKEN_CANARY' });
      const error = await backend.complete(request, context).catch((value: unknown) => value);
      expect(error).toMatchObject({ code, status });
      expect(String(error) + JSON.stringify(error)).not.toMatch(/CANARY|SESSION_/);
      expect((error as Error).cause).toBeUndefined();
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it('sanitizes fetch failures and rejects URL credentials before fetch', async () => {
    const { backend } = makeBackend(async () => { throw new Error('https://URL_CANARY.test/?token=TOKEN_CANARY'); });
    const error = await backend.complete(request).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'network_error', cause: undefined });
    expect(String(error) + JSON.stringify(error)).not.toContain('CANARY');
    const invalid = makeBackend(jsonCompletion(), { ...configuration, baseUrl: 'http://user:password@127.0.0.1:3000' });
    await expect(invalid.backend.complete(request)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(invalid.fetchMock).not.toHaveBeenCalled();
  });

  it('probes models for health but retains the configured model directory', async () => {
    const { backend, fetchMock } = makeBackend(Response.json({ data: [] }));
    expect(await backend.healthCheck(context)).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3000/v1/models');
    expect(new Headers(fetchMock.mock.calls[0][1]!.headers).get('authorization')).toBe('Bearer gateway-only');
    expect((await backend.listModels()).map((model) => model.id)).toEqual(['web-auto']);
    const failed = makeBackend(new Response('BODY_CANARY', { status: 401 })).backend;
    expect(await failed.healthCheck()).toEqual({ ok: false, message: 'Web gateway request failed: HTTP 401.' });
  });

  it('honors an already cancelled signal without invoking fetch or exposing its reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error('ABORT_CANARY'));
    const { backend, fetchMock } = makeBackend(jsonCompletion());
    await expect(backend.complete(request, { ...context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', message: 'Web gateway request was cancelled.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels an active response reader and releases it on external abort', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) { if (!sent) { sent = true; stream.enqueue(new TextEncoder().encode(chunk({ content: 'prefix' }))); } }, cancel,
    }, { highWaterMark: 0 });
    const { backend } = makeBackend(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const iterator = backend.stream(request, { signal: controller.signal })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'upstream_ready' });
    expect((await iterator.next()).value).toEqual({ type: 'text_delta', text: 'prefix' });
    const pending = iterator.next();
    controller.abort('ABORT_CANARY');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it.each(['json', 'sse'] as const)('does not publish content after cancellation at readiness: %s', async (format) => {
    const controller = new AbortController();
    const response = format === 'json' ? jsonCompletion() : sse(chunk({ content: 'must not publish' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    const { backend } = makeBackend(response);
    const iterator = backend.stream(request, { signal: controller.signal })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'upstream_ready' });
    controller.abort('ABORT_CANARY');
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('bounds a stalled fetch by the timeout and cancels a late response', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let resolve!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((done) => { resolve = done; });
    const { backend, fetchMock } = makeBackend(() => pendingResponse, configuration, 30);
    const result = backend.complete(request).catch((value: unknown) => value);
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toMatchObject({ code: 'timeout', status: 504 });
    expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);
    resolve(new Response(new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels stalled reads on timeout without waiting for stalled cleanup', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); }, cancel }, { highWaterMark: 0 });
    const { backend } = makeBackend(new Response(body, { headers: { 'content-type': 'application/json' } }), configuration, 30);
    const result = backend.complete(request).catch((value: unknown) => value);
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toMatchObject({ code: 'timeout' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the upstream stream when the consumer returns early', async () => {
    const cancel = vi.fn();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({ pull(stream) { if (!sent) { sent = true; stream.enqueue(new TextEncoder().encode(chunk({ role: 'assistant' }))); } }, cancel }, { highWaterMark: 0 });
    const { backend } = makeBackend(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const iterator = backend.stream(request)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
});
