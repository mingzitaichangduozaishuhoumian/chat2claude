import { CODEX_ORIGINATOR, DEFAULT_CODEX_CLIENT_VERSION, codexUserAgent } from './codex-protocol.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
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
  it.each(['known', 'unknown', 'invalid-json', 'oversized', 'read-error', 'cancel-error', 'abort'] as const)('reads bounded HTTP diagnostics safely: %s', async (mode) => {
    const controller = new AbortController();
    const cancel = vi.fn(() => { if (mode === 'cancel-error') throw new Error('HTTP_CANARY'); });
    const known = { error: { code: 'unsupported_parameter', type: 'invalid_request_error', param: 'max_output_tokens', message: 'HTTP_CANARY', detail: 'HTTP_CANARY' }, prompt: 'HTTP_CANARY' };
    const text = mode === 'invalid-json' ? 'HTTP_CANARY' : mode === 'oversized' ? JSON.stringify({ ...known, padding: 'x'.repeat(70_000) })
      : JSON.stringify(mode === 'unknown' ? { error: { code: 'HTTP_CANARY', type: 'HTTP_CANARY', param: 'tools.HTTP_CANARY', message: 'HTTP_CANARY' } } : known);
    let sent = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(stream) {
        if (mode === 'read-error') { stream.error(new Error('HTTP_CANARY')); return; }
        if (mode === 'abort') { controller.abort(); return; }
        if (!sent) { sent = true; stream.enqueue(new TextEncoder().encode(text)); }
        else stream.close();
      }, cancel,
    }, { highWaterMark: 0 }), { status: 400 });
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => response });
    const error = await backend.complete(request, { ...context, signal: controller.signal }).catch((error: unknown) => error) as ChatGptBackendError;
    if (mode === 'abort') expect(error).toMatchObject({ name: 'AbortError' });
    else {
      expect(error).toMatchObject({ status: 400, code: 'upstream_error', safeDiagnostic: { httpStatus: 400, failurePhase: 'response_headers' } });
      if (mode === 'known' || mode === 'cancel-error') expect(error.safeDiagnostic).toMatchObject({ responseErrorCode: 'unsupported_parameter', responseErrorType: 'invalid_request_error', responseErrorParam: 'max_output_tokens' });
      else if (mode === 'unknown') expect(error.safeDiagnostic).toMatchObject({ responseErrorCode: 'unknown', responseErrorType: 'unknown', responseErrorParam: 'unknown' });
      else expect(error.safeDiagnostic).toEqual({ httpStatus: 400, failurePhase: 'response_headers' });
      expect(Object.isFrozen(error.safeDiagnostic)).toBe(true);
    }
    expect(error.cause).toBeUndefined();
    expect(String(error) + JSON.stringify(error)).not.toContain('HTTP_CANARY');
    if (mode === 'oversized') expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(['stalled-read', 'stalled-cleanup'] as const)('bounds diagnostic %s without losing HTTP status', async (mode) => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => mode === 'stalled-cleanup' ? new Promise<void>(() => {}) : undefined);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (mode === 'stalled-cleanup') controller.enqueue(new Uint8Array(65 * 1024));
        else return new Promise<void>(() => {});
      }, cancel,
    }, { highWaterMark: 0 });
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 60_000, fetch: async () => new Response(body, { status: 400 }) });
    const result = backend.complete(request, context).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ status: 400, safeDiagnostic: { httpStatus: 400, failurePhase: 'response_headers' } });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one 250ms deadline between a permanently stalled diagnostic read and cleanup', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}); },
      cancel,
    }, { highWaterMark: 0 });
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 60_000, fetch: async () => new Response(body, { status: 429 }) });
    const startedAt = performance.now();
    const error = await backend.complete(request, context).catch((cause: unknown) => cause);
    const elapsedMs = performance.now() - startedAt;

    expect(error).toMatchObject({ status: 429, code: 'rate_limited', safeDiagnostic: { httpStatus: 429, failurePhase: 'response_headers' } });
    expect(elapsedMs).toBeLessThanOrEqual(350);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('normalizes fallback system history and structured text roles without tools', async () => {
    const bodies: Record<string, unknown>[] = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponse([{ type: 'response.completed' }]);
    } });
    await backend.complete({ ...request, messages: [{ role: 'system', content: 'rules' }], backendOptions: { responsesBody: { parallel_tool_calls: true } } }, context);
    expect(bodies[0].input).toEqual([{ type: 'message', role: 'developer', content: 'rules' }]);
    expect(bodies[0]).not.toHaveProperty('parallel_tool_calls');
    await backend.complete({ ...request, inputItems: [
      { type: 'message', role: 'system', content: [{ type: 'text', text: 'rules' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ] }, context);
    expect(bodies[1].input).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ]);
  });

  it.each(['added-only', 'delta', 'done', 'delta-and-done'] as const)('preserves nonempty added arguments with %s finalization', async (mode) => {
    const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' };
    const frames = [
      { type: 'response.output_item.added', output_index: 0, item },
      ...(mode.includes('delta') ? [
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"q":' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"x"}' },
      ] : []),
      ...(mode.includes('done') ? [
        { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{ "q": "x" }' },
        { type: 'response.output_item.done', output_index: 0, item },
      ] : []),
      { type: 'response.completed' },
    ];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse(frames) });
    await expect(backend.complete(request, context)).resolves.toEqual({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'lookup', input: { q: 'x' } }] });
  });

  it('does not treat empty added arguments as a complete empty object', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '' } },
      { type: 'response.completed' },
    ]) });
    await expect(backend.complete(request, context)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each(['standalone', 'event-only', 'after-delta'] as const)('aggregates a simplified done without item.type: %s', async (mode) => {
    const item = { id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' };
    const frames = [
      ...(mode === 'after-delta' ? [
        { type: 'response.output_item.added', output_index: 0, item: { ...item, type: 'function_call', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: item.arguments },
      ] : []),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', finish_reason: 'stop' },
    ];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => mode === 'event-only'
      ? new Response(frames.map(({ type, ...frame }) => `event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))
      : sseResponse(frames) });
    const events = [];
    for await (const event of backend.stream(request, context)) events.push(event);
    expect(events).toEqual([
      { type: 'tool_call', toolCall: { id: 'call_1', name: 'lookup', input: { q: 'x' } } },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it.each([
    { type: 'message', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' },
    { id: 'fc_1', name: 'lookup', arguments: '{}' },
    { id: 'fc_1', call_id: 'call_1', arguments: '{}' },
    { id: 'fc_1', call_id: 'call_1', name: 'lookup' },
  ])('does not infer a function call from an unrelated or incomplete done item %#', async (item) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse([
      { type: 'response.output_item.done', item }, { type: 'response.completed' },
    ]) });
    await expect(backend.complete(request, context)).resolves.toEqual({ text: '', finishReason: 'stop' });
  });

  it('independently emits mixed compatibility text and tools, but never standard argument deltas', async () => {
    const tool_call = { id: 'fc_compat', call_id: 'call_compat', name: 'lookup', input: { q: 'x' } };
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse([
      { delta: 'before ', tool_call },
      { delta: 'after', tool_call },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"q":"x"}' },
      { type: 'response.completed' },
    ]) });
    await expect(backend.complete(request, context)).resolves.toEqual({ text: 'before after', finishReason: 'tool_calls', toolCalls: [
      { id: 'call_compat', name: 'lookup', input: { q: 'x' } },
      { id: 'call_1', name: 'lookup', input: { q: 'x' } },
    ] });
  });

  it.each(['added-delta', 'added-done', 'added-duplicate', 'simplified-delta', 'simplified-duplicate', 'simplified-association'] as const)('rejects %s conflicts without retaining arguments or provider text', async (mode) => {
    const item = { id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"secret":"REGRESSION_CANARY"}' };
    const added = mode.startsWith('added');
    const frames = [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, type: 'function_call', arguments: added ? item.arguments : '' } },
      ...(mode.endsWith('delta') ? [{ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{}' }] : []),
      ...(mode === 'added-done' ? [{ type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{}' }] : []),
      ...(mode === 'added-duplicate' ? [{ type: 'response.output_item.added', item: { ...item, type: 'function_call', arguments: '{}' } }] : []),
      ...(!added ? [{ type: 'response.output_item.done', output_index: 0, item: { ...item, ...(mode === 'simplified-association' ? { call_id: 'call_other' } : {}) } }] : []),
      ...(mode === 'simplified-duplicate' ? [{ type: 'response.output_item.done', item: { ...item, arguments: '{}' } }] : []),
      { type: 'response.completed' },
    ];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse(frames.map((frame) => ({ ...frame, message: 'REGRESSION_CANARY', details: 'REGRESSION_CANARY' }))) });
    // Capture only the error: failed assertions must not print the successful tool payload.
    const error = await backend.complete(request, context).then(() => undefined, (error: unknown) => error);
    expect(error).toMatchObject({ code: 'invalid_response', safeDiagnostic: { failurePhase: 'response_protocol' } });
    expect(String(error) + JSON.stringify(error)).not.toContain('REGRESSION_CANARY');
    expect((error as Error).cause).toBeUndefined();
  });

  it('assembles interleaved official function calls once using call_id, never argument text', async () => {
    const items = [
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'first', arguments: '' },
      { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'second', arguments: '' },
    ];
    const frames = [
      ...items.map((item, output_index) => ({ type: 'response.output_item.added', output_index, item })),
      { type: 'response.function_call_arguments.delta', item_id: 'fc_a', output_index: 0, delta: '{"a":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_b', output_index: 1, delta: '{"b":2}' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_a', output_index: 0, delta: '1}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_b', output_index: 1, arguments: '{"b":2}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_a', output_index: 0, arguments: '{"a":1}' },
      ...items.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item: { ...item, arguments: output_index ? '{"b":2}' : '{"a":1}' } })),
      { type: 'response.completed', response: { output: items.map((item, i) => ({ ...item, arguments: i ? '{"b":2}' : '{"a":1}' })) } },
    ];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse(frames) });
    const result = await backend.complete(request, context);
    expect(result.text).toBe('');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls).toEqual(expect.arrayContaining([
      { id: 'call_a', name: 'first', input: { a: 1 } }, { id: 'call_b', name: 'second', input: { b: 2 } },
    ]));
  });

  it.each(['full', 'delta', 'completed', 'event-only'] as const)('supports %s argument finalization and deduplicates compatibility echoes', async (mode) => {
    const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' };
    const frames = mode === 'completed' ? [{ type: 'response.completed', response: { output: [item] } }] : [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
      ...(mode === 'delta' ? [{ type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }] : []),
      { type: 'response.output_item.done', item: { ...item, ...(mode === 'delta' ? { arguments: undefined } : {}) } },
      { tool_call: { id: 'different_item_id', call_id: 'call_1', name: 'lookup', input: { q: 'x' } } },
      { tool_call: { id: 'call_1', name: 'lookup', input: { q: 'x' } } },
      { type: 'response.completed', response: { output: [item] } },
    ];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => mode === 'event-only'
      ? new Response(frames.map(({ type, ...frame }) => `${type ? `event: ${type}\n` : ''}data: ${JSON.stringify(frame)}\n\n`).join(''))
      : sseResponse(frames) });
    await expect(backend.complete(request, context)).resolves.toMatchObject({ text: '', toolCalls: [{ id: 'call_1', name: 'lookup', input: { q: 'x' } }] });
  });

  it.each(['arguments', 'association', 'missing-call-id', 'duplicate-call-id'] as const)('rejects %s protocol conflicts without retaining payloads', async (conflict) => {
    const item = { type: 'function_call', id: 'fc_1', call_id: conflict === 'missing-call-id' ? undefined : 'call_1', name: 'lookup', arguments: '' };
    const frames = [
      { type: 'response.output_item.added', output_index: 0, item },
      ...(conflict === 'association' || conflict === 'duplicate-call-id' ? [{ type: 'response.output_item.added', output_index: 1, item: { ...item, id: 'fc_2', call_id: conflict === 'duplicate-call-id' ? 'call_1' : 'call_2' } }] : []),
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: conflict === 'association' ? 1 : 0, delta: '{"secret":"TOOL_CANARY"}' },
      { type: 'response.output_item.done', output_index: 0, item: { ...item, arguments: conflict === 'arguments' ? '{}' : '{"secret":"TOOL_CANARY"}' } },
      { type: 'response.completed' },
    ];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse(frames) });
    try { await backend.complete(request, context); expect.fail('Expected protocol conflict'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'invalid_response', safeDiagnostic: { failurePhase: 'response_protocol' } });
      expect(String(error) + JSON.stringify(error)).not.toContain('TOOL_CANARY');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it.each(['error', 'response.failed', 'response.incomplete'])('keeps only allowlisted diagnostics for %s', async (type) => {
    const secret = 'PROVIDER_DIAGNOSTIC_CANARY';
    const payload = { type, code: secret, message: secret, param: secret, details: secret,
      response: { status: type === 'response.incomplete' ? 'incomplete' : 'failed', error: { code: 'misalignment_policy_violation', message: secret, param: secret, details: secret }, incomplete_details: { reason: secret, explanation: secret } } };
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse([payload]) });
    const events = [];
    try {
      for await (const event of backend.stream(request, context)) events.push(event);
      expect.fail('Expected terminal error');
    } catch (error) {
      expect(error).toMatchObject({ code: type === 'response.incomplete' ? 'invalid_response' : 'upstream_error', safeDiagnostic: {
        eventType: type, responseStatus: payload.response.status, httpStatus: 200,
        failurePhase: type === 'response.incomplete' ? 'response_incomplete' : 'response_event',
        ...(type === 'response.failed' ? { responseErrorCode: 'misalignment_policy_violation' } : {}),
        ...(type === 'response.incomplete' ? { incompleteReason: 'unknown' } : {}),
      } });
      expect(String(error) + JSON.stringify(error)).not.toContain(secret);
      expect((error as Error).cause).toBeUndefined();
    }
    expect(events).toEqual([]);
  });

  it.each(['rate_limit_exceeded', 'ERROR_CODE_CANARY'])('sanitizes top-level standard error code %s', async (code) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse([
      { type: 'error', code, message: 'ERROR_MESSAGE_CANARY', param: 'ERROR_PARAM_CANARY', raw: 'ERROR_RAW_CANARY' },
    ]) });
    const error = await backend.complete(request, context).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'upstream_error', status: 502, safeDiagnostic: {
      eventType: 'error', responseErrorCode: code === 'rate_limit_exceeded' ? code : 'unknown', httpStatus: 200, failurePhase: 'response_event',
    } });
    expect(String(error) + JSON.stringify(error)).not.toContain('CANARY');
    expect((error as Error).cause).toBeUndefined();
  });

  it.each([
    { frame: { type: 'error', error: { code: 'rate_limit_exceeded', message: 'NESTED_MESSAGE_CANARY', detail: 'NESTED_DETAIL_CANARY', param: 'NESTED_PARAM_CANARY', raw: 'NESTED_RAW_CANARY' } }, code: 'rate_limit_exceeded' },
    { frame: { type: 'error', error: { code: 'NESTED_CODE_CANARY', message: 'NESTED_MESSAGE_CANARY', detail: 'NESTED_DETAIL_CANARY', param: 'NESTED_PARAM_CANARY', raw: 'NESTED_RAW_CANARY' } }, code: 'unknown' },
    { frame: { error: { code: 'rate_limit_exceeded', message: 'NESTED_MESSAGE_CANARY', detail: 'NESTED_DETAIL_CANARY', param: 'NESTED_PARAM_CANARY', raw: 'NESTED_RAW_CANARY' } }, code: 'rate_limit_exceeded' },
    { frame: { error: { code: 'NESTED_CODE_CANARY', message: 'NESTED_MESSAGE_CANARY', detail: 'NESTED_DETAIL_CANARY', param: 'NESTED_PARAM_CANARY', raw: 'NESTED_RAW_CANARY' } }, code: 'unknown' },
  ])('sanitizes nested response error codes for $frame.type frames', async ({ frame, code }) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => sseResponse([frame]) });
    const error = await backend.complete(request, context).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'upstream_error', status: 502, safeDiagnostic: {
      ...(frame.type ? { eventType: frame.type } : {}), responseErrorCode: code, httpStatus: 200, failurePhase: 'response_event',
    } });
    expect(String(error) + JSON.stringify(error)).not.toContain('NESTED_');
    expect((error as Error).cause).toBeUndefined();
  });

  it.each(['eof', 'done-marker'] as const)('defaults emitted tools to tool_calls at %s', async (terminal) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup","arguments":"{}"}}\n\n'
      + (terminal === 'done-marker' ? 'data: [DONE]\n\n' : ''),
    ) });
    await expect(backend.complete(request, context)).resolves.toMatchObject({ finishReason: 'tool_calls' });
  });

  it('continues skipping malformed JSON frames without exposing their raw contents', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response('data: {MALFORMED_FRAME_CANARY\n\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed"}\n\n') });
    await expect(backend.complete(request, context)).resolves.toMatchObject({ text: 'ok', finishReason: 'stop' });
  });

  it('preserves an upstream reader AbortError without classifying it as a network failure', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(new ReadableStream({
      pull(controller) { controller.error(new DOMException('ABORT_CANARY', 'AbortError')); },
    })) });
    try { await backend.complete(request, context); expect.fail('Expected abort'); }
    catch (error) {
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(error).not.toBeInstanceOf(ChatGptBackendError);
      expect(String(error) + JSON.stringify(error)).not.toContain('ABORT_CANARY');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('classifies missing HTTP 2xx response bodies as invalid responses', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(null) });
    await expect(backend.complete(request, context)).rejects.toMatchObject({ code: 'invalid_response', safeDiagnostic: { httpStatus: 200, failurePhase: 'response_body_read' } });
  });

  it.each([TypeError, SyntaxError])('classifies a body read %s safely after HTTP 2xx', async (ErrorClass) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(new ReadableStream({
      pull(controller) { controller.error(new ErrorClass('BODY_READ_CANARY')); },
    })) });
    try {
      await backend.complete(request, context);
      expect.fail('Expected body read failure');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorClass === SyntaxError ? 'invalid_response' : 'network_error', safeDiagnostic: { httpStatus: 200, failurePhase: 'response_body_read' } });
      expect(String(error) + JSON.stringify(error)).not.toContain('BODY_READ_CANARY');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it.each([
    'data: {"type":"error","message":"SSE_SECRET_CANARY"}',
    'data: {"type":"response.error","message":{"content":"SSE_SECRET_CANARY"}}',
    'data: {"type":"response.failed","response":{"error":{"detail":"SSE_SECRET_CANARY"}}}',
    'data: {"type":"response.completed","response":{"status":"failed","error":{"message":"SSE_SECRET_CANARY"}}}',
    'data: {"error":{"message":"SSE_SECRET_CANARY"}}',
    'data: {"response":{"error":{"detail":"SSE_SECRET_CANARY"}}}',
    'event: response.failed\ndata: {"detail":"SSE_SECRET_CANARY"}',
    'event: error\ndata: SSE_SECRET_CANARY',
  ])('rejects an in-band failure without leaking or emitting done: %s', async (frame) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000,
      fetch: async () => new Response(`${frame}\n\ndata: {"type":"response.completed"}\n\n`),
    });
    const events = [];
    try {
      for await (const event of backend.stream(request, context)) events.push(event);
      expect.fail('Expected backend failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatGptBackendError);
      expect(error).toMatchObject({ code: 'upstream_error', status: 502, message: 'ChatGPT session backend response failed.' });
      expect(String(error) + JSON.stringify(error)).not.toContain('SSE_SECRET_CANARY');
      expect((error as Error).cause).toBeUndefined();
    }
    expect(events).toEqual([]);
    await expect(backend.complete(request, context)).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it.each(['abort', 'timeout', 'return', 'done', 'http-error'] as const)('handles gated async cancel on %s without masking the primary outcome', async (outcome) => {
    vi.useFakeTimers();
    let finishCancel!: () => void;
    const gate = new Promise<void>((resolve) => { finishCancel = resolve; });
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    let cancelling!: () => void;
    const cancelled = new Promise<void>((resolve) => { cancelling = resolve; });
    const cancel = vi.fn(async () => { cancelling(); await gate; throw new Error('cleanup failure'); });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (outcome === 'return') controller.enqueue(new TextEncoder().encode('data: {"delta":"hello"}\n\n'));
        if (outcome === 'done') controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'));
      },
      pull() { entered(); return new Promise<void>(() => {}); },
      cancel,
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 50,
      fetch: async () => new Response(body, { status: outcome === 'http-error' ? 401 : 200 }),
    });
    const iterator = backend.stream(request, { ...context, signal: controller.signal })[Symbol.asyncIterator]();
    let operation = iterator.next();
    if (outcome === 'return' || outcome === 'done') {
      await operation;
      operation = outcome === 'return' ? iterator.return!() : iterator.next();
    }
    let settled = false;
    const result = operation.then((value) => { settled = true; return value; }, (error: unknown) => { settled = true; return error; });
    if (outcome === 'abort' || outcome === 'timeout' || outcome === 'http-error') {
      await reading;
      if (outcome === 'abort') controller.abort();
      else await vi.advanceTimersByTimeAsync(50);
    }
    await cancelled;
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(settled).toBe(outcome === 'http-error');
      if (outcome !== 'http-error') expect(body.locked).toBe(true);
    } finally { finishCancel(); }
    const value = await result;
    if (outcome === 'abort') expect(value).toMatchObject({ name: 'AbortError' });
    else if (outcome === 'timeout') expect(value).toMatchObject({ code: 'timeout' });
    else if (outcome === 'http-error') expect(value).toMatchObject({ code: 'unauthorized', status: 401 });
    else expect(value).toMatchObject({ done: true });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['abort', 'timeout'] as const)('keeps %s active after headers and interrupts an already-pending body read', async (outcome) => {
    vi.useFakeTimers();
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull() { entered(); return new Promise<void>(() => {}); }, cancel,
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let fetchSignal!: AbortSignal;
    let calls = 0;
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 50,
      fetch: async (_url, init) => {
        fetchSignal = init!.signal!;
        return ++calls === 1 ? new Response(body) : sseResponse(['{"type":"response.completed"}']);
      },
    });
    const iterator = backend.stream(request, { ...context, signal: controller.signal })[Symbol.asyncIterator]();
    const next = iterator.next();
    const rejected = expect(next).rejects.toMatchObject(outcome === 'abort' ? { name: 'AbortError' } : { code: 'timeout', status: 504 });
    await reading;
    expect(fetchSignal.aborted).toBe(false);
    // Legacy absolute limit plus the new body-idle watchdog.
    expect(vi.getTimerCount()).toBe(2);
    if (outcome === 'abort') controller.abort('private reason');
    else await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(fetchSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    await expect(backend.complete(request, context)).resolves.toMatchObject({ finishReason: 'stop' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels unread upstream body and clears lifetime resources on iterator return', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"delta":"hello"}\n\n')); },
      cancel,
    });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 50, fetch: async () => new Response(body) });
    const iterator = backend.stream(request, { ...context, signal: controller.signal })[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: { type: 'text_delta' } });
    await iterator.return!();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deduplicates tier IDs case-insensitively without merging the Fast family or replacing first metadata', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => Response.json({ models: [{
      id: 'tier-model',
      service_tiers: [{ id: 'FaSt', name: 'First Fast', description: 'First metadata' }, 'economy', 'fast', 'FASTEST'],
      additional_speed_tiers: [{ id: 'FAST', name: 'Duplicate' }, 'ECONOMY', 'priority', 'fastest', 'flex'],
    }] }) });
    const models = await backend.listModels(context);
    expect(models[0].controls?.serviceTier.supported).toEqual([
      { id: 'FaSt', name: 'First Fast', description: 'First metadata' }, { id: 'economy' },
      { id: 'FASTEST' }, { id: 'priority' }, { id: 'flex' },
    ]);
  });

  it.each(['FaSt', 'FASTEST', 'Priority'])('omits noncanonical provider tier %s in the private wire body', async (serviceTier) => {
    const bodies: unknown[] = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponse([{ type: 'response.completed' }]);
    } });
    await backend.complete({ ...request, serviceTier }, context);
    expect(bodies[0]).not.toHaveProperty('service_tier');
  });
  it('uses JSON discovery and SSE Responses with a versioned official default User-Agent', async () => {
    const calls: Headers[] = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, clientVersion: '2.3.4', fetch: async (url, init) => {
      calls.push(new Headers(init?.headers));
      return String(url).includes('/models') ? Response.json({ models: [] }) : sseResponse(['[DONE]']);
    } });
    const noAgent = { account: { ...context.account, secret: { ...context.account.secret, userAgent: undefined } } };
    await backend.listModels(noAgent);
    await backend.complete(request, noAgent);
    expect(calls.map((headers) => headers.get('accept'))).toEqual(['application/json', 'text/event-stream']);
    for (const headers of calls) {
      expect(headers.get('originator')).toBe('codex_cli_rs');
      expect(headers.get('user-agent')).toBe(codexUserAgent('2.3.4'));
      expect(headers.get('authorization')).toBe('Bearer token-1');
      expect(headers.get('cookie')).toBe('cookie-1');
      expect(headers.get('oai-device-id')).toBe('device-1');
      expect(headers.get('chatgpt-account-id')).toBe('acct-1');
    }
  });

  it('prefers official models and slug over compatibility envelopes and IDs', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => Response.json({
      models: [{ slug: 'synthetic-route', id: 'synthetic-other', name: 'Synthetic Display' }],
      data: ['synthetic-ignore'], body: { models: ['synthetic-also-ignore'] },
    }) });
    const result = await backend.discoverModels(context);
    expect(result.status).toBe('success');
    expect(result.models.map((model) => model.id)).toEqual(['synthetic-route']);
    expect(result.diagnostic).toEqual({ clientVersion: DEFAULT_CODEX_CLIENT_VERSION, httpStatus: 200, contentType: 'json', envelope: 'models', candidateCount: 1, acceptedCount: 1, rejectedCount: 0, duplicateCount: 0, reasons: [] });
  });

  it.each([
    { payload: ['synthetic-a'], envelope: 'array' },
    { payload: { data: [{ id: 'synthetic-a' }] }, envelope: 'data' },
    { payload: { body: { models: [{ model: 'synthetic-a' }] } }, envelope: 'body_models' },
    { payload: { models: [{ name: 'synthetic-a' }] }, envelope: 'models' },
  ])('retains the explicit $envelope compatibility envelope', async ({ payload, envelope }) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => Response.json(payload) });
    const result = await backend.discoverModels(context);
    expect(result.models.map((model) => model.id)).toEqual(['synthetic-a']);
    expect(result.diagnostic?.envelope).toBe(envelope);
  });

  it.each([[], { models: [], data: ['synthetic-ignore'] }, { data: [] }, { body: { models: [] } }].map((payload) => ({ payload })))('reports an explicit empty catalog (%j)', async ({ payload }) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => Response.json(payload) });
    await expect(backend.discoverModels(context)).resolves.toMatchObject({ models: [], status: 'empty', diagnostic: { candidateCount: 0, acceptedCount: 0 } });
    await expect(backend.listModels(context)).resolves.toEqual([]);
  });

  it.each([
    null, {}, { unknown: ['synthetic-a'] }, { data: { models: ['synthetic-a'] } },
    { models: null, data: ['synthetic-must-not-fallback'] }, { models: {} }, { models: 'synthetic-a' },
    { models: [null, {}, false, 4, [], '', ' ', { slug: 42 }, { display_name: 'Display only' }, { id: 'not a routable id' }] },
  ])('rejects unknown, malformed and entirely unusable catalogs (%j)', async (payload) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => Response.json(payload) });
    await expect(backend.listModels(context)).rejects.toMatchObject({ name: 'ChatGptBackendError', code: 'invalid_response', status: 502, cause: undefined });
    await expect(backend.healthCheck(context)).resolves.toMatchObject({ ok: false });
  });

  it('reports counts and reason enums for mixed invalid and duplicate entries without raw metadata', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => Response.json({ models: [
      { slug: 'synthetic-a', arbitrary: 'sensitive-body' }, null, { slug: 'synthetic-a' },
      { id: 'synthetic-b' }, { display_name: 'sensitive-body' },
    ] }, { headers: { 'content-type': 'application/json; private=sensitive-header' } }) });
    const result = await backend.discoverModels(context);
    expect(result.status).toBe('partial');
    expect(result.models.map((model) => model.id)).toEqual(['synthetic-a', 'synthetic-b']);
    expect(result.diagnostic).toEqual({ clientVersion: DEFAULT_CODEX_CLIENT_VERSION, httpStatus: 200, contentType: 'json', envelope: 'models', candidateCount: 5, acceptedCount: 2, rejectedCount: 2, duplicateCount: 1, reasons: ['invalid_model_id', 'duplicate_model_id'] });
    expect(JSON.stringify(result.diagnostic)).not.toMatch(/sensitive|synthetic|token|cookie/);
    await expect(backend.listModels(context)).resolves.toHaveLength(2);
  });

  it.each([
    { contentType: 'text/html; private=secret-body', category: 'html' },
    { contentType: 'text/event-stream', category: 'event_stream' },
    { contentType: 'application/problem+json', category: 'json' },
    { contentType: 'application/secret-body', category: 'other' },
  ])('safely classifies malformed JSON with $category content type', async ({ contentType, category }) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response('secret-body', { headers: { 'content-type': contentType } }) });
    const error = await backend.listModels(context).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'invalid_response', cause: undefined, discoveryDiagnostic: { httpStatus: 200, contentType: category, envelope: 'unknown', reasons: ['invalid_json'] } });
    expect(JSON.stringify(error)).not.toContain('secret-body');
    expect(String(error)).not.toContain('secret-body');
  });

  it('does not retain raw network error causes or HTTP response bodies', async () => {
    for (const fetchImpl of [async () => { throw new Error('sensitive-network-error'); }, async () => new Response('sensitive-body', { status: 403 })]) {
      const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: fetchImpl });
      const error = await backend.listModels(context).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ChatGptBackendError);
      expect(error).toHaveProperty('cause', undefined);
      expect(JSON.stringify(error)).not.toContain('sensitive');
      expect(String(error)).not.toContain('sensitive');
    }
  });

  it('keeps missing-account calls compatible without declaring verified emptiness', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => { throw new Error('must not fetch'); } });
    await expect(backend.listModels()).resolves.toEqual([]);
    await expect(backend.discoverModels()).resolves.toEqual({ models: [], status: 'unknown' });
  });

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
    expect(response).toEqual({ text: 'hello world', finishReason: 'stop', terminalSuccessful: false });
    expect(calls[0].url).toBe('https://chatgpt.test/backend-api/codex/responses');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer token-1');
    expect(headers.get('cookie')).toBe('cookie-1');
    expect(headers.get('oai-device-id')).toBe('device-1');
    expect(headers.get('user-agent')).toBe('ua-1');
    expect(headers.get('chatgpt-account-id')).toBe('acct-1');
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: 'gpt-test', stream: true, store: false, instructions: '', include: ['reasoning.encrypted_content'] });
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

  it('filters unsupported generation controls from the Codex responses body', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await backend.complete({ ...request, temperature: 0.25, topP: 0.75, stopSequences: ['END'] }, context);
    for (const field of ['temperature', 'top_p', 'stop', 'max_output_tokens']) expect(calls[0].body).not.toHaveProperty(field);
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

  it('forwards neutral reasoning but omits the default service tier', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await backend.complete({ ...request, reasoningEffort: 'none', serviceTier: 'default' }, context);
    expect(calls[0].body).toMatchObject({ reasoning: { effort: 'none' } });
    expect(calls[0].body).not.toHaveProperty('service_tier');
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
      text: { format: { type: 'json_object' } },
    });
    for (const field of ['extra', 'parallel_tool_calls', 'truncation']) expect(calls[0].body).not.toHaveProperty(field);
  });

  it('omits multiple stop sequences from the Codex responses body', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return sseResponse([{ type: 'response.completed' }]);
    } });

    await backend.complete({ ...request, stopSequences: ['END', 'STOP'] }, context);
    expect(calls[0].body).not.toHaveProperty('stop');
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
    expect(calls[0].url).toBe(`https://chatgpt.test/backend-api/codex/models?client_version=${DEFAULT_CODEX_CLIENT_VERSION}`);
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

  it('uses the official originator even when legacy options specify another identity', async () => {
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
      { url: `https://chatgpt.test/backend-api/codex/models?client_version=${DEFAULT_CODEX_CLIENT_VERSION}`, originator: CODEX_ORIGINATOR },
      { url: 'https://chatgpt.test/backend-api/codex/responses', originator: CODEX_ORIGINATOR },
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

  it('keeps discovery timeout active through JSON body parsing and permits a later request', async () => {
    let calls = 0;
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 10, fetch: async () => {
      calls += 1;
      return calls === 1 ? new Response(new ReadableStream({ start() {} })) : Response.json({ models: [{ slug: 'synthetic-later' }] });
    } });
    await expect(backend.discoverModels(context)).rejects.toMatchObject({ code: 'timeout', status: 504, cause: undefined });
    await expect(backend.discoverModels(context)).resolves.toMatchObject({ status: 'success', models: [{ id: 'synthetic-later' }] });
  });

  it('cancels discovery during body parsing and refuses pre-cancelled requests', async () => {
    let calls = 0;
    const started = deferred<void>();
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 60_000, fetch: async () => {
      calls += 1;
      started.resolve();
      return new Response(new ReadableStream({ start() {} }));
    } });
    const controller = new AbortController();
    const pending = backend.discoverModels({ ...context, signal: controller.signal });
    await started.promise;
    await Promise.resolve();
    controller.abort('sensitive-cancellation-reason');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'ChatGPT session backend request was cancelled.' });
    await expect(backend.discoverModels({ ...context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
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

  it.each(['snake', 'camel'])('normalizes dedicated reset credits (%s), retaining adapter IDs and excluding unsupported credits', async (shape) => {
    const credit = shape === 'snake'
      ? { reset_type: 'codex_rate_limits', expires_at: '2026-10-01T00:00:00Z', granted_at: '2026-09-01T00:00:00Z' }
      : { resetType: 'codex_rate_limits', expiresAt: '2026-10-01T00:00:00Z', grantedAt: '2026-09-01T00:00:00Z' };
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (url) => Response.json(String(url).endsWith('/usage')
      ? { rate_limit: {}, rate_limit_reset_credits: { available_count: 99 } }
      : { [shape === 'snake' ? 'available_count' : 'availableCount']: '2', credits: [
        { ...credit, id: 'unsafe-provider-id', status: 'available', secret: 'drop' },
        { ...credit, status: 'consumed' }, { ...credit, status: 'available', reset_type: 'other' },
      ] }) });
    expect((await backend.getAccountQuota(context)).resetCredits).toEqual({ availableCount: 2, credits: [
      { id: 'unsafe-provider-id', status: 'available', expiresAt: '2026-10-01T00:00:00.000Z', grantedAt: '2026-09-01T00:00:00.000Z' },
    ] });
  });

  it.each([null, -1, 1.5, 'invalid', ''])('does not turn invalid credit count %s into zero', async (available_count) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (url) => Response.json(String(url).endsWith('/usage') ? { rate_limit: {} } : { available_count }) });
    expect((await backend.getAccountQuota(context)).resetCredits).toEqual({ error: 'invalid_response' });
  });

  it.each([null, [], {}, { rate_limit: null }])('rejects malformed usage as non-authoritative (%s)', async (payload) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => Response.json(payload) });
    await expect(backend.getAccountQuota(context)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('keeps a safe reset-credit fetch failure while retaining successful usage', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (url) => String(url).endsWith('/usage')
      ? Response.json({ rate_limit: { allowed: true } }) : new Response('provider-secret', { status: 401 }) });
    expect(await backend.getAccountQuota(context)).toEqual({ allowed: true, windows: [], resetCredits: { error: 'fetch_failed' } });
  });

  it('consumes with a JSON redemption ID and never returns provider success/error bodies', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let status = 200;
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (url, init) => {
      calls.push({ url: String(url), init }); return new Response('provider-secret ' + id, { status });
    } });
    await expect(backend.consumeAccountResetCredit(id, context)).resolves.toBeUndefined();
    expect(calls[0].url).toBe('https://chatgpt.test/backend-api/wham/rate-limit-reset-credits/consume');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ redeem_request_id: id });
    expect(new Headers(calls[0].init?.headers).get('content-type')).toBe('application/json');
    status = 429;
    await expect(backend.consumeAccountResetCredit(id, context)).rejects.toMatchObject({ code: 'rate_limited', message: 'Reset credit request failed: HTTP 429' });
  });

  it('fetches authoritative account quota from /wham/usage with selected account headers', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test/backend-api', timeoutMs: 1000, clientVersion: '9.8.7', originator: 'chat2claude', fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      if (String(url).endsWith('/rate-limit-reset-credits')) return Response.json({ available_count: 3 });
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
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://chatgpt.test/backend-api/wham/rate-limit-reset-credits');
    expect(calls[1].headers.get('OpenAI-Beta')).toBe('codex-1');
    expect(calls[0].url).toBe('https://chatgpt.test/backend-api/wham/usage');
    expect(calls[0].headers.get('authorization')).toBe('Bearer token-1');
    expect(calls[0].headers.get('chatgpt-account-id')).toBe('acct-1');
    expect(calls[0].headers.get('originator')).toBe(CODEX_ORIGINATOR);
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
      fetch: async (url) => Response.json(String(url).endsWith('/usage') ? payloads.shift() : {}),
    });

    await expect(backend.getAccountQuota!(context)).resolves.toEqual({
      windows: [{ position: 'primary', descriptor: 'five-hour', usedPercent: 10, durationSeconds: 18_000 }],
      resetCredits: { error: 'invalid_response' },
    });
    await expect(backend.getAccountQuota!(context)).resolves.toEqual({ windows: [], resetCredits: { error: 'invalid_response' } });
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
      resetCredits: { error: 'invalid_response' },
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
      resetCredits: { error: 'invalid_response' },
    });
    expect(calls).toBe(3);
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
