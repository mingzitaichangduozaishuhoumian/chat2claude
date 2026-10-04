import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend, type ChatGptImageGenerationCallOutputItem, type ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
import { mapChatGptResponseToOpenAiResponses, mapChatGptStreamToOpenAiResponsesSse } from './openai-responses.js';
import { mapChatGptResponseToOpenAiChat, mapChatGptStreamToOpenAiChatSse } from './openai-chat.js';
import { mapChatGptResponseToClaude } from './response.js';
import { mapChatGptStreamToClaudeSse } from './streaming.js';

const request = { model: 'model', input: 'draw', tools: [{ type: 'image_generation' }] };
const context = { account: { id: 'synthetic', provider: 'chatgpt-session' as const, secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic' } } };
const backendRequest = { model: 'model', messages: [], maxTokens: 64, backendOptions: { responsesBody: { tools: [{ type: 'image_generation' }] } } };
const finalImage = (id = 'img', result = 'YWJj'): ChatGptImageGenerationCallOutputItem => ({ type: 'image_generation_call', id, status: 'completed', result, output_format: 'png', background: 'opaque', quality: 'high', size: '1024x1024', action: 'generate' });
const partial = (itemId = 'img', outputIndex = 0, partialImageIndex = 0): Extract<ChatGptStreamEvent, { type: 'image_partial' }> => ({ type: 'image_partial', itemId, outputIndex, partialImageIndex, partialImageB64: 'YWJj', metadata: { output_format: 'png' } });
async function* source(events: ChatGptStreamEvent[]) { yield* events; }
function data(chunk: string) { return chunk.startsWith('event:') ? JSON.parse(chunk.split('\ndata: ')[1]) : undefined; }
async function collect(events: ChatGptStreamEvent[]) {
  const result: Array<Record<string, any>> = [];
  for await (const chunk of mapChatGptStreamToOpenAiResponsesSse(request, source(events))) { const event = data(chunk); if (event) result.push(event); }
  assertAppend(result);
  return result;
}
function assertAppend(events: Array<Record<string, any>>) {
  const output: any[] = [];
  for (const event of events) {
    if (event.type === 'response.output_item.added') { expect(event.output_index).toBe(output.length); output.push(event.item); }
    if (event.type === 'response.image_generation_call.partial_image') expect(output[event.output_index]).toMatchObject({ id: event.item_id, type: 'image_generation_call', result: null });
    if (event.type === 'response.output_item.done') { expect(output[event.output_index]?.id).toBe(event.item.id); output[event.output_index] = event.item; }
    if (event.type === 'response.completed') expect(output).toEqual(event.response.output);
  }
}

describe('native Responses image streaming', () => {
  it('publishes a real Session preview before terminal, after the complete reasoning prefix', async () => {
    const reasoning = { type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'PRIVATE_CIPHERTEXT' };
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encode = (frame: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`);
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 4000, fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(value) {
      controller = value;
      value.enqueue(encode({ type: 'response.output_item.done', output_index: 0, item: reasoning }));
      value.enqueue(encode({ type: 'response.image_generation_call.partial_image', item_id: 'img', output_index: 1, partial_image_index: 0, partial_image_b64: 'YWJj', output_format: 'png', private_field: 'PRIVATE_METADATA' }));
    } })) });
    const iterator = mapChatGptStreamToOpenAiResponsesSse(request, backend.stream(backendRequest, context))[Symbol.asyncIterator]();
    const events: any[] = [];
    let released = false;
    const finish = () => { if (released) return; released = true; controller.enqueue(encode({ type: 'response.completed', response: { status: 'completed', output: [reasoning, finalImage()] } })); controller.close(); };
    const early = (async () => { while (true) { const next = await iterator.next(); if (next.done) throw new Error('Missing preview'); const event = data(next.value); if (event) events.push(event); if (event?.type === 'response.image_generation_call.partial_image') return event; } })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const preview = await Promise.race([early, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Preview waited for terminal')), 1500); })]);
      expect(preview).toMatchObject({ output_index: 1, item_id: 'img', partial_image_index: 0, partial_image_b64: 'YWJj', output_format: 'png' });
      expect(events.filter((event) => event.type === 'response.output_item.added').map((event) => event.item.id)).toEqual(['rs', 'img']);
      expect(events.some((event) => event.type === 'response.completed')).toBe(false);
      finish();
      while (true) { const next = await iterator.next(); if (next.done) break; const event = data(next.value); if (event) events.push(event); }
      assertAppend(events);
      expect(events.filter((event) => event.type === 'response.output_item.done' && event.item.id === 'img')).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('PRIVATE_');
    } finally { clearTimeout(timer); finish(); await early.catch(() => {}); await iterator.return?.(); }
  });

  it('buffers uncertain raw indices and replays previews at the safe projected index', async () => {
    const events = await collect([partial('img', 2), { type: 'done', outputItems: [finalImage()] }]);
    expect(events.find((event) => event.type.endsWith('.partial_image'))).toMatchObject({ output_index: 0 });
  });

  it('preserves independent multi-image lifecycles and larger image output budgets', async () => {
    const images = [finalImage('a', 'A'.repeat(3 * 1024 * 1024)), finalImage('b', 'A'.repeat(3 * 1024 * 1024))];
    const events = await collect([partial('a', 0), partial('b', 1), { type: 'done', outputItems: images }]);
    expect(events.at(-1)?.response.output).toEqual(images);
    expect(mapChatGptResponseToOpenAiResponses(request, { text: '', finishReason: 'stop', outputItems: images }).output).toEqual(images);
    expect(events.filter((event) => event.type === 'response.output_item.added').map((event) => event.item.result)).toEqual([null, null]);
  });

  it.each(([[], [{ type: 'done', outputItems: [] }], [{ type: 'done', outputItems: [finalImage('other')] }], [{ type: 'done', terminalSuccessful: false, outputItems: [finalImage()] }]] as ChatGptStreamEvent[][]).map((ending) => ({ ending })))('never turns previews into final success without matching authoritative output (%#)', async ({ ending }) => {
    let committed = false;
    await expect((async () => { for await (const _chunk of mapChatGptStreamToOpenAiResponsesSse(request, source([partial(), ...ending]), { onCompleted: () => { committed = true; } })) {} })()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(committed).toBe(false);
  });

  it.each(([
    [partial(), partial()],
    [partial(), partial('img', 1, 1)],
    [{ ...partial(), partialImageB64: 'https://example.test/image' }],
    [{ ...partial(), partialImageIndex: 3 }],
  ] as ChatGptStreamEvent[][]).map((events) => ({ events })))('rejects invalid preview identity/index/payload (%#)', async ({ events }) => {
    await expect(collect([...events, { type: 'done', outputItems: [finalImage()] }])).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('strips unknown preview metadata before serializing the public event', async () => {
    const event = { ...partial(), metadata: { output_format: 'png', secret: 'PRIVATE_CANARY' } } as ChatGptStreamEvent;
    const events = await collect([event, { type: 'done', outputItems: [finalImage()] }]);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_CANARY');
  });

  it('closes the source and does not commit after cancellation following a preview', async () => {
    const controller = new AbortController();
    let closed = false;
    let committed = false;
    const events = (async function* () { try { yield partial(); yield { type: 'done' as const, outputItems: [finalImage()] }; } finally { closed = true; } })();
    const iterator = mapChatGptStreamToOpenAiResponsesSse(request, events, { signal: controller.signal, onCompleted: () => { committed = true; } })[Symbol.asyncIterator]();
    while (true) { const next = await iterator.next(); if (data(next.value)?.type.endsWith('.partial_image')) break; }
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(closed).toBe(true); expect(committed).toBe(false);
  });

  it('retains image count and individual item guards independently of text', async () => {
    expect(() => mapChatGptResponseToOpenAiResponses(request, { text: '', finishReason: 'stop', outputItems: [finalImage('large', 'A'.repeat(16 * 1024 * 1024))] })).toThrow();
    expect(() => mapChatGptResponseToOpenAiResponses(request, { text: '', finishReason: 'stop', outputItems: Array.from({ length: 11 }, (_, index) => finalImage(String(index))) })).toThrow();
    expect(() => mapChatGptResponseToOpenAiResponses(request, { text: '', finishReason: 'stop', outputItems: [finalImage(), finalImage()] })).toThrow();
  });
});

describe.each(['Chat', 'Claude'])('%s image output compatibility', (protocol) => {
  it('rejects image completions with an actionable error instead of empty success', () => {
    const completion = { text: '', finishReason: 'stop', outputItems: [finalImage()] };
    expect(() => protocol === 'Chat' ? mapChatGptResponseToOpenAiChat({ model: 'model', messages: [] }, completion) : mapChatGptResponseToClaude({ model: 'model', messages: [], max_tokens: 32 }, completion)).toThrow('/v1/images/generations');
  });
  it.each([partial(), { type: 'done', outputItems: [finalImage()] }] as ChatGptStreamEvent[])('rejects $type without a success terminal', async (event) => {
    let result = '';
    const stream = protocol === 'Chat' ? mapChatGptStreamToOpenAiChatSse({ model: 'model', messages: [] }, source([event])) : mapChatGptStreamToClaudeSse({ model: 'model', max_tokens: 32, messages: [] }, source([event]));
    await expect((async () => { for await (const chunk of stream) result += chunk; })()).rejects.toMatchObject({ status: 501, type: 'api_error' });
    expect(result).not.toContain('[DONE]'); expect(result).not.toContain('message_stop');
  });
});
