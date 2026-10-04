import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend, parseImageGenerationCallOutputItem, parseResponsesReplayItem, ResponsesImageBudget, ResponsesImagePartials, RESPONSES_IMAGE_LIMITS, RESPONSES_REPLAY_LIMITS, type ChatGptStreamEvent } from './index.js';

const context = { account: { id: 'synthetic', secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic' } } };
const request = { model: 'synthetic', maxTokens: 16, messages: [], backendOptions: { responsesBody: { tools: [{ type: 'image_generation', partial_images: 2 }] } } };
const image = (result = 'ZmluYWw=') => ({ type: 'image_generation_call' as const, id: 'img_synthetic', status: 'completed' as const, result });
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const terminal = (output: unknown[]) => ({ type: 'response.completed', response: { status: 'completed', output } });
const preview = (patch: Record<string, unknown> = {}) => ({ type: 'response.image_generation_call.partial_image', item_id: 'img_synthetic', output_index: 0, partial_image_index: 0, partial_image_b64: 'cHJldmlldw==', ...patch });
const backend = (frames: unknown[]) => new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', fetch: async () => new Response(frames.map(frame).join('')) });

describe('independent generated-image output budgets', () => {
  it('accepts standard image metadata and normalizes nullable optional fields', () => {
    const metadata = { action: 'generate', background: 'opaque', output_format: 'png', quality: 'max', size: '1536x864', revised_prompt: null };
    expect(parseImageGenerationCallOutputItem({ ...image(), ...metadata })).toEqual({ ...image(), action: 'generate', background: 'opaque', output_format: 'png', quality: 'max', size: '1536x864' });
    expect(parseImageGenerationCallOutputItem({ ...image(), action: null, background: null, output_format: null, quality: null, size: null, revised_prompt: null })).toEqual(image());
  });

  it('accepts a 200KiB source image and a multi-image bundle above the old 1MiB limit', async () => {
    const output = [image(Buffer.alloc(200 * 1024).toString('base64')), ...Array.from({ length: 5 }, (_,index) => ({ ...image(Buffer.alloc(150 * 1024).toString('base64')), id: `img_${index}` }))];
    const result = await backend([terminal(output)]).complete(request, context);
    expect(result.outputItems?.length).toBe(6);
    expect(result).not.toHaveProperty('replayItems');
  });

  it.each([false, true])('accepts an image above 8MiB with created=%s without spending the text or bootstrap budget', async (created) => {
    const result = await backend([...(created ? [{ type: 'response.created', response: { id: 'synthetic', status: 'in_progress' } }] : []), terminal([image('A'.repeat(9 * 1024 * 1024))])]).complete(request, context);
    expect(result.outputItems?.[0].type).toBe('image_generation_call');
  });

  it('enforces exact 16MiB item bytes without widening the hidden replay item limit', () => {
    const base = image('');
    const length = RESPONSES_IMAGE_LIMITS.itemBytes - Buffer.byteLength(JSON.stringify(base));
    expect(parseImageGenerationCallOutputItem(image('A'.repeat(length)))?.result.length).toBe(length);
    expect(() => parseImageGenerationCallOutputItem(image('A'.repeat(length + 1)))).toThrow(expect.objectContaining({ code: 'invalid_response' }));
    expect(RESPONSES_REPLAY_LIMITS).toEqual({ itemBytes: 256 * 1024, bundleBytes: 1024 * 1024, items: 128 });
    expect(() => parseResponsesReplayItem({ type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'A'.repeat(300 * 1024) })).toThrow();
  });

  it('enforces the 64MiB image bundle and ten-item limits independently', () => {
    const large = image('A'.repeat(RESPONSES_IMAGE_LIMITS.itemBytes - Buffer.byteLength(JSON.stringify(image(''))) - 2));
    const bytes = new ResponsesImageBudget();
    for (let index = 0; index < 4; index++) bytes.add(large);
    expect(() => bytes.add(image())).toThrow(expect.objectContaining({ code: 'invalid_response' }));
    const count = new ResponsesImageBudget();
    for (let index = 0; index < 10; index++) count.add(image());
    expect(() => count.add(image())).toThrow();
  });

  it('still rejects more than 4MiB of ordinary text alongside a valid image', async () => {
    await expect(backend([terminal([image(), { type: 'message', id: 'msg', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(4 * 1024 * 1024), annotations: [] }] }])]).complete(request, context))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('ephemeral Responses image previews', () => {
  it('emits a validated preview before the terminal image and never inserts preview pixels into replay', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const session = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', fetch: async () => new Response(body) });
    const reasoning = { type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'synthetic-ciphertext' };
    const enqueue = (value: unknown) => controller.enqueue(new TextEncoder().encode(frame(value)));
    enqueue({ type: 'response.output_item.done', output_index: 0, item: reasoning });
    enqueue(preview({ output_index: 1, output_format: 'png', size: '1024x1024', private: 'PRIVATE_PREVIEW_CANARY' }));
    const iterator = session.stream(request, context)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'upstream_ready' });
    expect((await iterator.next()).value).toEqual({ type: 'image_partial', itemId: 'img_synthetic', outputIndex: 1, partialImageIndex: 0, partialImageB64: 'cHJldmlldw==', metadata: { output_format: 'png', size: '1024x1024' }, projectedOutputIndex: 1, projectedOutputPrefix: [reasoning] });
    enqueue(terminal([reasoning, image()]));
    expect((await iterator.next()).value).toEqual({ type: 'image_output', item: image() });
    const done = (await iterator.next()).value;
    expect(done).toMatchObject({ type: 'done', replayItems: [reasoning], outputItems: [reasoning, image()] });
    expect(JSON.stringify(done)).not.toContain('cHJldmlldw==');
    expect(JSON.stringify(done)).not.toContain('PRIVATE_PREVIEW_CANARY');
    await iterator.return?.();
  });

  it.each([
    { item_id: '' }, { output_index: -1 }, { output_index: 0.5 }, { partial_image_index: -1 }, { partial_image_index: 3 },
    { partial_image_index: 0.5 }, { partial_image_b64: 'invalid_base64' }, { quality: 'invalid' }, { size: 'invalid' },
  ])('rejects invalid preview fields without exposing content: %j', async (patch) => {
    const events: ChatGptStreamEvent[] = [];
    const operation = async () => { for await (const event of backend([preview(patch), terminal([image()])]).stream(request, context)) events.push(event); };
    await expect(operation()).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
    expect(events).toEqual([]);
  });

  it.each([{ output: [] }, { output: [{ ...image(), id: 'other' }] }, { output: [{ ...image(), status: 'failed' }] }])('rejects a terminal output that does not corroborate the preview image', async ({ output }) => {
    await expect(backend([preview(), terminal(output)]).complete(request, context)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects duplicate preview indices and conflicting image identities', () => {
    const partials = new ResponsesImagePartials();
    partials.accept(preview());
    partials.accept(preview({ partial_image_index: 1 }));
    partials.accept(preview({ partial_image_index: 2 }));
    expect(() => partials.accept(preview({ partial_image_index: 2 }))).toThrow();
    expect(() => partials.accept(preview({ item_id: 'other' }))).toThrow();
  });

  it('bounds cumulative preview bytes and per-item preview bytes', () => {
    const partials = new ResponsesImagePartials();
    const pixels = 'A'.repeat(15 * 1024 * 1024);
    for (let index = 0; index < 4; index++) partials.accept(preview({ item_id: `img_${index}`, output_index: index, partial_image_b64: pixels }));
    expect(() => partials.accept(preview({ item_id: 'img_4', output_index: 4, partial_image_b64: pixels }))).toThrow();
    expect(() => new ResponsesImagePartials().accept(preview({ partial_image_b64: 'A'.repeat(RESPONSES_IMAGE_LIMITS.itemBytes) }))).toThrow();
  });
});
