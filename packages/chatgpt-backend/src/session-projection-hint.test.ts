import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend, type ChatGptStreamEvent } from './index.js';

const request = { model: 'synthetic-model', maxTokens: 16, messages: [] };
const context = { account: { id: 'synthetic-account', provider: 'chatgpt-session' as const, secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic-token' } } };
const reasoning = { type: 'reasoning', id: 'reasoning-1', summary: [], encrypted_content: 'synthetic-encrypted-content' };
const encode = (frame: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`);

describe('session early projection index hints', () => {
  it.each(['output_text', 'refusal'] as const)('provides a %s hint after completed encrypted reasoning before the terminal frame arrives', async (kind) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const responseBody = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(responseBody) });
    controller.enqueue(encode({ type: 'response.output_item.done', output_index: 0, item: reasoning }));
    controller.enqueue(encode({ type: `response.${kind}.delta`, item_id: 'message-1', output_index: 1, content_index: 0, delta: 'visible' }));
    const iterator = backend.stream(request, context)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'upstream_ready' });
    expect((await iterator.next()).value).toEqual({
      type: kind === 'refusal' ? 'refusal_delta' : 'text_delta', text: 'visible',
      itemId: 'message-1', outputIndex: 1, contentIndex: 0, projectedOutputIndex: 1,
      projectedOutputPrefix: [reasoning],
    });
    await iterator.return?.();
  });

  it.each([
    { event: 'response.output_item.added', item: reasoning },
    { event: 'response.output_item.done', item: { type: 'reasoning', id: 'reasoning-1', summary: [] } },
    { event: 'response.output_item.done', item: { type: 'web_search_call', id: 'search-1', status: 'completed' } },
    { event: 'response.output_item.done', item: { type: 'image_generation_call', id: 'image-1', status: 'failed' } },
  ])('omits a hint when preceding $item.type projection is not proven', async ({ event, item }) => {
    const frames = [
      { type: event, output_index: 0, item },
      { type: 'response.output_text.delta', item_id: 'message-1', output_index: 1, content_index: 0, delta: 'visible' },
      { type: 'response.completed', response: { status: 'completed' } },
    ];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(frames.map((frame) => new TextDecoder().decode(encode(frame))).join('')) });
    const events: ChatGptStreamEvent[] = [];
    for await (const value of backend.stream(request, context)) events.push(value);
    expect(events.find((value) => value.type === 'text_delta')).not.toHaveProperty('projectedOutputIndex');
    expect(events.find((value) => value.type === 'text_delta')).not.toHaveProperty('projectedOutputPrefix');
  });

  it('detaches each complete reasoning prefix from downstream consumers', async () => {
    const frames = [
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.output_text.delta', item_id: 'message-1', output_index: 1, content_index: 0, delta: 'first' },
      { type: 'response.output_text.delta', item_id: 'message-1', output_index: 1, content_index: 0, delta: 'second' },
      { type: 'response.completed', response: { status: 'completed' } },
    ];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(frames.map((frame) => new TextDecoder().decode(encode(frame))).join('')) });
    let deltas = 0;
    for await (const event of backend.stream(request, context)) {
      if (event.type !== 'text_delta') continue;
      expect(event.projectedOutputPrefix).toEqual([reasoning]);
      const prefixItem = event.projectedOutputPrefix?.[0];
      if (prefixItem?.type === 'reasoning') prefixItem.encrypted_content = 'consumer mutation';
      deltas++;
    }
    expect(deltas).toBe(2);
  });

  it('does not infer a prefix across a missing provider output index', async () => {
    const frames = [
      { type: 'response.output_item.done', output_index: 1, item: reasoning },
      { type: 'response.output_text.delta', item_id: 'message-2', output_index: 2, content_index: 0, delta: 'visible' },
      { type: 'response.completed', response: { status: 'completed' } },
    ];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(frames.map((frame) => new TextDecoder().decode(encode(frame))).join('')) });
    const events: ChatGptStreamEvent[] = [];
    for await (const value of backend.stream(request, context)) events.push(value);
    expect(events.find((value) => value.type === 'text_delta')).not.toHaveProperty('projectedOutputPrefix');
  });
});
