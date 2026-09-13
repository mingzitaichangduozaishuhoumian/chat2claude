import { describe, expect, it, vi } from 'vitest';
import { parseClaudeMessagesRequest, type ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { SessionChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { mapClaudeRequestToChatGpt } from './request.js';
import { estimateClaudeInputTokens, mapChatGptResponseToClaude } from './response.js';
import { mapChatGptStreamToOpenAiChatSse } from './openai-chat.js';
import { mapChatGptStreamToOpenAiResponsesSse } from './openai-responses.js';
import { mapChatGptStreamToClaudeSse, readableStreamFromAsyncIterable } from './streaming.js';

const request: ClaudeMessagesRequest = { model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] };

describe('mapChatGptStreamToClaudeSse', () => {
  it('uses the shared Claude input estimate in message_start usage', async () => {
    const countedRequest = { ...request, system: 'Answer precisely.', tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { key: { type: 'string' } } } }] };
    const events = parseClaudeData(await collect(mapChatGptStreamToClaudeSse(countedRequest, async function* () {
      yield { type: 'done' as const, finishReason: 'stop' };
    }())));
    expect(events[0]).toMatchObject({ type: 'message_start', message: { usage: { input_tokens: estimateClaudeInputTokens(countedRequest), output_tokens: 0 } } });
  });

  it('round trips standard session SSE to unique Claude tool_result call IDs on the next upstream request', async () => {
    const items = ['a', 'b'].map((key) => ({ type: 'function_call', id: `fc_${key}`, call_id: `call_${key}`, name: 'lookup', arguments: JSON.stringify({ key }) }));
    const frames = [
      ...items.map((item, output_index) => ({ type: 'response.output_item.added', output_index, item: { ...item, arguments: '' } })),
      ...[1, 0].flatMap((i) => [
        { type: 'response.function_call_arguments.delta', item_id: items[i].id, output_index: i, delta: items[i].arguments },
        { type: 'response.function_call_arguments.done', item_id: items[i].id, output_index: i, arguments: items[i].arguments },
        { type: 'response.output_item.done', output_index: i, item: items[i] },
      ]),
      { type: 'response.completed', response: { output: items } },
    ];
    const bodies: Array<{ input: Array<{ type: string; call_id: string }> }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
    } });
    const context = { account: { id: 'session-1', provider: 'chatgpt-session' as const, secret: { type: 'chatgpt-session' as const, accessToken: 'token' } } };
    const text = await collect(mapChatGptStreamToClaudeSse(request, backend.stream(mapClaudeRequestToChatGpt(request), context)));
    const starts = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
      .filter((event) => event.type === 'content_block_start' && event.content_block.type === 'tool_use');
    expect(starts.map((event) => event.content_block.id)).toEqual(['call_b', 'call_a']);
    expect(text).not.toContain('fc_');
    expect(text).not.toContain('"type":"text_delta"');
    const next = parseClaudeMessagesRequest({ ...request, messages: [
      ...request.messages,
      { role: 'assistant', content: starts.map((event) => ({ ...event.content_block, input: { key: event.content_block.id.slice(-1) } })) },
      { role: 'user', content: starts.map((event) => ({ type: 'tool_result', tool_use_id: event.content_block.id, content: 'ok' })) },
    ] });
    await backend.complete(mapClaudeRequestToChatGpt(next), context);
    expect(bodies[1].input.filter((item) => item.type === 'function_call').map((item) => item.call_id)).toEqual(['call_b', 'call_a']);
    expect(bodies[1].input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id)).toEqual(['call_b', 'call_a']);
  });

  it.each([undefined, null, '', 'stop', 'length'] as const)('maps session tool completion to Claude stop reason with finish_reason=%s', async (finish_reason) => {
    const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' };
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response([
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { finish_reason } },
    ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')) });
    const context = { account: { id: 'session-1', provider: 'chatgpt-session' as const, secret: { type: 'chatgpt-session' as const, accessToken: 'token' } } };
    const backendRequest = mapClaudeRequestToChatGpt(request);
    const expected = finish_reason === 'length' ? 'max_tokens' : finish_reason === 'stop' ? 'end_turn' : 'tool_use';
    const completion = mapChatGptResponseToClaude(request, await backend.complete(backendRequest, context));
    expect(completion.stop_reason).toBe(expected);
    expect(completion.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'lookup', input: {} }]);
    const text = await collect(mapChatGptStreamToClaudeSse(request, backend.stream(backendRequest, context)));
    expect(text).toContain(`"stop_reason":"${expected}"`);
    expect(text.match(/event: message_delta\n/g)).toHaveLength(1);
  });

  it('streams tool calls as Claude tool_use blocks with input_json_delta', async () => {
    const text = await collect(mapChatGptStreamToClaudeSse(request, async function* () {
      yield { type: 'tool_call' as const, toolCall: { id: 'call_1', name: 'get_weather', input: { city: 'Paris' } } };
      yield { type: 'done' as const, finishReason: 'tool_calls' };
    }()));
    expect(text).toContain('"content_block":{"type":"tool_use","id":"call_1","name":"get_weather","input":{}}');
    expect(text).toContain('"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Paris\\"}"}');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it('streams reasoning_delta as a Claude thinking block and closes it before text', async () => {
    const text = await collect(mapChatGptStreamToClaudeSse(request, async function* () {
      yield { type: 'reasoning_delta' as const, text: 'thinking out loud' };
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const, finishReason: 'stop' };
    }()));
    const events = parseClaudeData(text);
    expect(events.filter((event) => event.type === 'content_block_start')).toEqual([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    ]);
    expect(events).toContainEqual({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking out loud' } });
    expect(events).toContainEqual({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello' } });
    expect(events.findIndex((event) => event.type === 'content_block_stop' && event.index === 0))
      .toBeLessThan(events.findIndex((event) => event.type === 'content_block_start' && event.index === 1));
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
  });

  it('opens an empty thinking block for status and closes it before text', async () => {
    const status = 'web search searching';
    const events = parseClaudeData(await collect(mapChatGptStreamToClaudeSse(request, async function* () {
      yield { type: 'status_delta' as const, status };
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const, finishReason: 'stop' };
    }())));
    expect(events.filter((event) => event.type === 'content_block_start')).toEqual([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    ]);
    expect(events.some((event) => (event.delta as { type?: string } | undefined)?.type === 'thinking_delta')).toBe(false);
    expect(JSON.stringify(events)).not.toContain(status);
    expect(events.findIndex((event) => event.type === 'content_block_stop' && event.index === 0))
      .toBeLessThan(events.findIndex((event) => event.type === 'content_block_start' && event.index === 1));
  });

  it('emits only real reasoning after status opens a thinking block', async () => {
    const status = 'web search searching';
    const events = parseClaudeData(await collect(mapChatGptStreamToClaudeSse(request, async function* () {
      yield { type: 'status_delta' as const, status };
      yield { type: 'reasoning_delta' as const, text: 'thinking out loud' };
      yield { type: 'done' as const, finishReason: 'stop' };
    }())));
    expect(events.filter((event) => event.type === 'content_block_start')).toEqual([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    ]);
    const thinkingDeltas = events.filter((event) => (event.delta as { type?: string } | undefined)?.type === 'thinking_delta');
    expect(thinkingDeltas).toEqual([
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking out loud' } },
    ]);
    expect(JSON.stringify(thinkingDeltas)).not.toContain(status);
  });

  it('does not open thinking for whitespace-only reasoning or emit whitespace after status', async () => {
    const whitespaceOnly = parseClaudeData(await collect(mapChatGptStreamToClaudeSse(request, async function* () {
      yield { type: 'reasoning_delta' as const, text: '  \n ' };
      yield { type: 'tool_call' as const, toolCall: { id: 'call_1', name: 'lookup', input: {} } };
      yield { type: 'done' as const, finishReason: 'tool_calls' };
    }())));
    expect(whitespaceOnly.filter((event) => event.type === 'content_block_start')).toEqual([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} } },
    ]);
    expect(whitespaceOnly.some((event) => (event.delta as { type?: string } | undefined)?.type === 'thinking_delta')).toBe(false);

    const statusOnly = parseClaudeData(await collect(mapChatGptStreamToClaudeSse(request, async function* () {
      yield { type: 'status_delta' as const, status: 'web search searching' };
      yield { type: 'done' as const, finishReason: 'stop' };
    }())));
    expect(statusOnly.filter((event) => (event.delta as { type?: string } | undefined)?.type === 'thinking_delta')).toEqual([]);
    expect(statusOnly.findIndex((event) => event.type === 'content_block_stop' && event.index === 0))
      .toBeLessThan(statusOnly.findIndex((event) => event.type === 'message_delta'));

    const afterStatus = parseClaudeData(await collect(mapChatGptStreamToClaudeSse(request, async function* () {
      yield { type: 'status_delta' as const, status: 'web search searching' };
      yield { type: 'reasoning_delta' as const, text: '  \n ' };
      yield { type: 'done' as const, finishReason: 'stop' };
    }())));
    expect(afterStatus.filter((event) => (event.delta as { type?: string } | undefined)?.type === 'thinking_delta')).toEqual([]);
  });

  it('closes real reasoning before starting tool_use', async () => {
    const events = parseClaudeData(await collect(mapChatGptStreamToClaudeSse(request, async function* () {
      yield { type: 'reasoning_delta' as const, text: 'considering options' };
      yield { type: 'tool_call' as const, toolCall: { id: 'call_1', name: 'lookup', input: {} } };
      yield { type: 'done' as const, finishReason: 'tool_calls' };
    }())));
    expect(events.findIndex((event) => event.type === 'content_block_stop' && event.index === 0))
      .toBeLessThan(events.findIndex((event) => event.type === 'content_block_start' && event.index === 1));
  });

  it('does not emit a thinking delta for status after real reasoning', async () => {
    const events = parseClaudeData(await collect(mapChatGptStreamToClaudeSse(request, async function* () {
      yield { type: 'reasoning_delta' as const, text: 'considering options' };
      yield { type: 'status_delta' as const, status: 'web search searching' };
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const, finishReason: 'stop' };
    }())));
    expect(events.filter((event) => (event.delta as { type?: string } | undefined)?.type === 'thinking_delta')).toEqual([
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'considering options' } },
    ]);
    expect(events.findIndex((event) => event.type === 'content_block_stop' && event.index === 0))
      .toBeLessThan(events.findIndex((event) => event.type === 'content_block_start' && event.index === 1));
  });

  it('uses done finishReason for text streams', async () => {
    const text = await collect(mapChatGptStreamToClaudeSse(request, async function* () {
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const, finishReason: 'length' };
    }()));
    expect(text).toContain('"stop_reason":"max_tokens"');
  });

  it('uses done usage for Claude message_delta usage', async () => {
    const text = await collect(mapChatGptStreamToClaudeSse(request, async function* () {
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const, finishReason: 'stop', usage: { outputTokens: 42 } };
    }()));
    expect(text).toContain('"usage":{"output_tokens":42}');
  });

  it('uses done usage for OpenAI responses completed usage', async () => {
    const text = await collect(mapChatGptStreamToOpenAiResponsesSse({ model: 'gpt-test', input: 'hello' }, async function* () {
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    }()));
    expect(text).toContain('"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}');
  });

  it('calls OpenAI responses onCompleted with the completed response before DONE', async () => {
    const completed: Array<{ id: string; output_text: string }> = [];
    const text = await collect(mapChatGptStreamToOpenAiResponsesSse({ model: 'gpt-test', input: 'hello' }, async function* () {
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const };
    }(), { onCompleted: async (response) => { completed.push({ id: response.id, output_text: response.output_text }); } }));
    expect(completed).toHaveLength(1);
    expect(completed[0].output_text).toBe('hello');
    expect(text).toContain(`"id":"${completed[0].id}"`);
    expect(text).toContain('data: [DONE]');
  });

  it('does not emit an OpenAI chat usage chunk by default', async () => {
    const chunks = parseOpenAiData(await collect(mapChatGptStreamToOpenAiChatSse({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] }, async function* () {
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    }())));
    expect(chunks.some((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0 && chunk.usage)).toBe(false);
  });

  it('emits an OpenAI chat usage chunk when include_usage is true', async () => {
    const chunks = parseOpenAiData(await collect(mapChatGptStreamToOpenAiChatSse({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }], stream_options: { include_usage: true } }, async function* () {
      yield { type: 'text_delta' as const, text: 'hello' };
      yield { type: 'done' as const, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    }())));
    const usageChunk = chunks.find((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0);
    expect(usageChunk).toMatchObject({ object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  });
});

describe('readableStreamFromAsyncIterable lifecycle', () => {
  it('emits configured SSE keepalives only while upstream is silent', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const upstream = new Promise<IteratorResult<string>>(resolve => { release = () => resolve({ done: false, value: 'data: real\n\n' }); });
    let nextCalls = 0;
    const stream = readableStreamFromAsyncIterable({ [Symbol.asyncIterator]: () => ({ next: () => ++nextCalls === 1 ? upstream : Promise.resolve({ done: true as const, value: undefined }) }) }, { sseKeepaliveIntervalMs: 25 });
    const reader = stream.getReader();
    const first = reader.read();
    await vi.advanceTimersByTimeAsync(24);
    await expect(Promise.race([first.then(() => 'settled'), Promise.resolve('pending')])).resolves.toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(new TextDecoder().decode((await first).value)).toBe(': keepalive\n\n');
    expect(nextCalls).toBe(1);
    const second = reader.read();
    release();
    expect(new TextDecoder().decode((await second).value)).toBe('data: real\n\n');
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it.each(['upstream-win', 'completion', 'cancel', 'upstream-rejection', 'signal-abort'] as const)('clears keepalive timers after %s', async outcome => {
    vi.useFakeTimers();
    let release!: (value: IteratorResult<string>) => void;
    let reject!: (reason?: unknown) => void;
    const pending = new Promise<IteratorResult<string>>((resolve, fail) => { release = resolve; reject = fail; });
    let nextCalls = 0;
    const controller = new AbortController();
    const stream = readableStreamFromAsyncIterable({ [Symbol.asyncIterator]: () => ({
      next: () => {
        nextCalls += 1;
        if (outcome === 'completion') return Promise.resolve({ done: true as const, value: undefined });
        if (outcome === 'upstream-rejection') return Promise.reject(new Error('upstream failed'));
        return nextCalls === 1 ? pending : Promise.resolve({ done: true as const, value: undefined });
      },
    }) }, { signal: controller.signal, sseKeepaliveIntervalMs: 100 });
    const reader = stream.getReader();
    const first = reader.read();
    if (outcome === 'upstream-win') {
      release({ done: false, value: 'data: real\n\n' });
      expect(new TextDecoder().decode((await first).value)).toBe('data: real\n\n');
      expect(vi.getTimerCount()).toBe(0);
      expect(await reader.read()).toEqual({ done: true, value: undefined });
    } else if (outcome === 'completion') {
      expect(await first).toEqual({ done: true, value: undefined });
    } else if (outcome === 'upstream-rejection') {
      await expect(first).rejects.toThrow('upstream failed');
    } else if (outcome === 'signal-abort') {
      controller.abort('client gone');
      reject(new Error('late upstream failure'));
      await first.catch(() => undefined);
    } else {
      const cancelled = reader.cancel('client gone');
      release({ done: false, value: 'data: late\n\n' });
      await cancelled;
      await first.catch(() => undefined);
    }
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('gracefulAbort=%s changes only downstream abort delivery', async gracefulAbort => {
    const caller = new AbortController();
    const onCancel = vi.fn();
    const stream = readableStreamFromAsyncIterable((async function* () { yield 'hello'; })(), { signal: caller.signal, gracefulAbort, onCancel });
    caller.abort();
    if (gracefulAbort) await expect(new Response(stream).text()).resolves.toBe('');
    else await expect(new Response(stream).text()).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    const failed = readableStreamFromAsyncIterable((async function* () { throw new DOMException('upstream failed', 'AbortError'); })(), { signal: new AbortController().signal, gracefulAbort });
    await expect(new Response(failed).text()).rejects.toMatchObject({ name: 'AbortError', message: 'upstream failed' });
  });
  it.each(['cancel', 'abort'] as const)('interrupts pending next before awaiting return on %s', async (outcome) => {
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    let interrupt!: () => void;
    const blocked = new Promise<void>((resolve) => { interrupt = resolve; });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const finalized = vi.fn(finish);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const stream = readableStreamFromAsyncIterable((async function* () {
      try { entered(); await blocked; yield 'late chunk'; }
      finally { finalized(); }
    })(), { signal: controller.signal, onCancel: interrupt });
    const reader = stream.getReader();
    const pending = reader.read().catch((error: unknown) => error);
    await reading;
    if (outcome === 'cancel') await reader.cancel();
    else controller.abort();
    await pending;
    // Cancellation may enqueue generator return behind the pending next.
    await finished;
    expect(finalized).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it.each(['complete', 'error', 'pre-abort'] as const)('cleans listeners and finalizes on %s', async (outcome) => {
    const controller = new AbortController();
    if (outcome === 'pre-abort') controller.abort();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const stream = readableStreamFromAsyncIterable((async function* () {
      try {
        if (outcome === 'error') throw new Error('broken');
        yield 'hello';
      } finally { finish(); }
    })(), { signal: controller.signal });
    const result = new Response(stream).text();
    if (outcome === 'complete') expect(await result).toBe('hello');
    else await expect(result).rejects.toThrow();
    await finished;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const chunk of iterable) text += chunk;
  return text;
}

function parseClaudeData(text: string): Array<Record<string, unknown>> {
  return text.split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
}

function parseOpenAiData(text: string): Array<Record<string, unknown>> {
  return text.split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
}
