import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend, type ChatGptCompletionRequest, type ChatGptStreamEvent } from './index.js';

const request: ChatGptCompletionRequest = { model: 'synthetic-model', maxTokens: 32, messages: [] };
const context = { account: { id: 'synthetic-account', provider: 'chatgpt-session' as const, secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic-token' } } };
function backend(frames: unknown[]) {
  return new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')) });
}
const message = (type: 'output_text' | 'refusal', text: unknown) => ({
  type: 'message', id: 'msg_synthetic', role: 'assistant', status: 'completed',
  content: [type === 'refusal' ? { type, refusal: text } : { type, text, annotations: [] }],
});

describe('session visible text and refusal output', () => {
  it('preserves refusal deltas independently of ordinary text', async () => {
    const response = await backend([
      { type: 'response.refusal.delta', delta: 'I cannot ' },
      { type: 'response.refusal.delta', delta: 'help with that.' },
      { type: 'response.completed', response: { status: 'completed' } },
    ]).complete(request, context);
    expect(response).toEqual({ text: '', refusal: 'I cannot help with that.', finishReason: 'refusal' });
  });

  it.each(['output_text', 'refusal'] as const)('emits final-only %s content before terminal completion', async (type) => {
    const item = message(type, 'Completed content');
    const frames = [{ type: 'response.completed', response: { status: 'completed', output: [item] } }];
    const events: ChatGptStreamEvent[] = [];
    for await (const event of backend(frames).stream(request, context)) events.push(event);
    expect(events).toEqual([
      { type: 'upstream_ready' },
      { type: type === 'refusal' ? 'refusal_delta' : 'text_delta', text: 'Completed content', itemId: 'msg_synthetic', outputIndex: 0, contentIndex: 0, finalSnapshot: true },
      { type: 'done', finishReason: type === 'refusal' ? 'refusal' : 'stop', outputItems: [item] },
    ]);
    expect(await backend(frames).complete(request, context)).toMatchObject(type === 'refusal'
      ? { text: '', refusal: 'Completed content', finishReason: 'refusal', outputItems: [item] }
      : { text: 'Completed content', finishReason: 'stop', outputItems: [item] });
  });

  it.each(['output_text', 'refusal'] as const)('appends only the missing %s suffix from a completed snapshot', async (type) => {
    const events: ChatGptStreamEvent[] = [];
    for await (const event of backend([
      { type: `response.${type}.delta`, delta: 'Completed ' },
      { type: 'response.completed', response: { status: 'completed', output: [message(type, 'Completed content')] } },
    ]).stream(request, context)) events.push(event);
    expect(events.filter((event) => event.type === (type === 'refusal' ? 'refusal_delta' : 'text_delta'))).toEqual([
      { type: type === 'refusal' ? 'refusal_delta' : 'text_delta', text: 'Completed ' },
      { type: type === 'refusal' ? 'refusal_delta' : 'text_delta', text: 'content', itemId: 'msg_synthetic', outputIndex: 0, contentIndex: 0, finalSnapshot: true },
    ]);
  });

  it.each(['output_text', 'refusal'] as const)('does not repeat fully streamed %s content at completion', async (type) => {
    const response = await backend([
      { type: `response.${type}.delta`, delta: 'Completed content' },
      { type: `response.${type}.done`, ...(type === 'refusal' ? { refusal: 'Completed content' } : { text: 'Completed content' }) },
      { type: 'response.completed', response: { status: 'completed', output: [message(type, 'Completed content')] } },
    ]).complete(request, context);
    expect(type === 'refusal' ? response.refusal : response.text).toBe('Completed content');
  });

  it.each(['output_text', 'refusal'] as const)('retains validated %s delta identities for multiple messages and parts', async (type) => {
    const events: ChatGptStreamEvent[] = [];
    const frames = [
      { type: `response.${type}.delta`, item_id: 'msg_first', output_index: 1, content_index: 0, delta: 'first' },
      { type: `response.${type}.delta`, item_id: 'msg_second', output_index: 3, content_index: 1, delta: 'second' },
      { type: `response.${type}.delta`, delta: 'legacy' },
      { type: 'response.completed', response: { status: 'completed' } },
    ];
    for await (const event of backend(frames).stream(request, context)) events.push(event);
    expect(events.filter((event) => event.type === (type === 'refusal' ? 'refusal_delta' : 'text_delta'))).toEqual([
      { type: type === 'refusal' ? 'refusal_delta' : 'text_delta', itemId: 'msg_first', outputIndex: 1, contentIndex: 0, text: 'first' },
      { type: type === 'refusal' ? 'refusal_delta' : 'text_delta', itemId: 'msg_second', outputIndex: 3, contentIndex: 1, text: 'second' },
      { type: type === 'refusal' ? 'refusal_delta' : 'text_delta', text: 'legacy' },
    ]);
  });

  it.each(['output_text', 'refusal'] as const)('retains a final-only leading %s message alongside a streamed later message', async (type) => {
    const first = { ...message(type, 'first'), id: 'msg_first' };
    const second = { ...message(type, 'second'), id: 'msg_second' };
    const frames = [
      { type: `response.${type}.delta`, item_id: 'msg_second', output_index: 1, content_index: 0, delta: 'second' },
      { type: 'response.completed', response: { status: 'completed', output: [first, second] } },
    ];
    const events: ChatGptStreamEvent[] = [];
    for await (const event of backend(frames).stream(request, context)) events.push(event);
    const kind = type === 'refusal' ? 'refusal_delta' : 'text_delta';
    expect(events.filter((event) => event.type === kind)).toEqual([
      { type: kind, text: 'second', itemId: 'msg_second', outputIndex: 1, contentIndex: 0 },
      { type: kind, text: 'first', itemId: 'msg_first', outputIndex: 0, contentIndex: 0, finalSnapshot: true },
    ]);
    const response = await backend(frames).complete(request, context);
    expect(type === 'refusal' ? response.refusal : response.text).toBe('firstsecond');
  });

  it('reconciles separate content parts and retains provider indices after ignored output items', async () => {
    const item = { ...message('output_text', 'first'), content: [
      { type: 'output_text', text: 'first', annotations: [] },
      { type: 'output_text', text: 'second', annotations: [] },
    ] };
    const frames = [
      { type: 'response.output_text.delta', item_id: 'msg_synthetic', output_index: 2, content_index: 1, delta: 'sec' },
      { type: 'response.completed', response: { status: 'completed', output: [
        { type: 'reasoning', id: 'reasoning_without_ciphertext', summary: [] },
        { type: 'web_search_call', id: 'search_call', status: 'completed' },
        item,
      ] } },
    ];
    const events: ChatGptStreamEvent[] = [];
    for await (const event of backend(frames).stream(request, context)) events.push(event);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'sec', itemId: 'msg_synthetic', outputIndex: 2, contentIndex: 1 },
      { type: 'text_delta', text: 'first', itemId: 'msg_synthetic', outputIndex: 2, contentIndex: 0, finalSnapshot: true },
      { type: 'text_delta', text: 'ond', itemId: 'msg_synthetic', outputIndex: 2, contentIndex: 1, finalSnapshot: true },
    ]);
    expect((await backend(frames).complete(request, context)).text).toBe('firstsecond');
  });

  it('matches output-index-only live deltas to the authoritative message identity', async () => {
    const frames = [
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'first' },
      { type: 'response.completed', response: { status: 'completed', output: [
        { type: 'reasoning', id: 'no_ciphertext', summary: [] }, message('output_text', 'firstsecond'),
      ] } },
    ];
    const events: ChatGptStreamEvent[] = [];
    for await (const event of backend(frames).stream(request, context)) events.push(event);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'first', outputIndex: 1, contentIndex: 0 },
      { type: 'text_delta', text: 'second', itemId: 'msg_synthetic', outputIndex: 1, contentIndex: 0, finalSnapshot: true },
    ]);
  });

  it.each([
    { item_id: '' }, { output_index: -1 }, { content_index: 1.5 },
  ])('rejects malformed delta identities before exposing them: %j', async (identity) => {
    const events: ChatGptStreamEvent[] = [];
    const operation = async () => { for await (const event of backend([{ type: 'response.output_text.delta', delta: 'private', ...identity }]).stream(request, context)) events.push(event); };
    await expect(operation()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(events).toEqual([]);
  });

  it('rejects a malformed refusal before publishing readiness or provider content', async () => {
    const events: ChatGptStreamEvent[] = [];
    const operation = async () => {
      for await (const event of backend([{ type: 'response.completed', response: { status: 'completed', output: [message('refusal', { secret: 'REFUSAL_SECRET_CANARY' })] } }]).stream(request, context)) events.push(event);
    };
    const error = await operation().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'invalid_response', status: 502 });
    expect(events).toEqual([]);
    expect(JSON.stringify(error)).not.toContain('REFUSAL_SECRET_CANARY');
  });

  it.each(['queued', 'in_progress', 'unknown'])('rejects a completed event carrying nonterminal response status %s', async (status) => {
    await expect(backend([{ type: 'response.completed', response: { status, output: [] } }]).complete(request, context)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
