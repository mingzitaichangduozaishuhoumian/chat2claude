import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SessionChatGptBackend, type ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { createOpenAiResponsesRoute } from './routes/openai-responses.js';
import { createOpenAiChatRoute } from './routes/openai-chat.js';
import { createMessagesRoute } from './routes/messages.js';
import { AccountPool } from './services/account-pool.js';
import { ModelRegistry } from './services/model-registry.js';
import { RequestLog } from './services/request-log.js';
import { ResponsesStore } from './services/responses-store.js';
import { RuntimeApiKeys } from './services/runtime-api-keys.js';
import { apiKeyAuth } from './middleware/auth.js';

const image = (id = 'img', result = 'YWJj') => ({ type: 'image_generation_call', id, status: 'completed', result, output_format: 'png', background: 'opaque', quality: 'high', size: '1024x1024', action: 'generate' });
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const preview = { type: 'response.image_generation_call.partial_image', item_id: 'img', output_index: 0, partial_image_index: 0, partial_image_b64: 'YWJj', output_format: 'png' };
function fixture(route: typeof createOpenAiResponsesRoute | typeof createOpenAiChatRoute | typeof createMessagesRoute, upstream: () => Response, backendOverride?: ChatGptBackendClient, responsesStore = new ResponsesStore()) {
  const backend = backendOverride ?? new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 3000, fetch: async () => upstream() });
  const accountPool = new AccountPool({ seedMockAccount: false });
  const account = accountPool.add({ id: 'image-synthetic', provider: 'chatgpt-session', capabilities: ['chatgpt-session', 'messages'], secret: { type: 'chatgpt-session', accessToken: 'synthetic-token' } });
  const modelRegistry = new ModelRegistry({ defaults: [] });
  modelRegistry.replaceAccountModels({ accountId: account.id, createdAt: account.createdAt }, [{ id: 'image-test', controls: {
    reasoning: { metadataKnown: true, supported: [{ effort: 'medium' }], defaultEffort: 'medium' },
    serviceTier: { metadataKnown: false, supported: [], fastMode: false },
  } }]);
  const app = new Hono();
  app.use('*', apiKeyAuth(['synthetic-image-key'], new RuntimeApiKeys()));
  app.route('/', route({ backend, accountPool, modelRegistry, responsesStore, requestLog: new RequestLog(), backendProvider: 'session' }));
  return {
    send: (path: string, body: Record<string, unknown>) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'synthetic-image-key' }, body: JSON.stringify({ model: 'image-test', ...body }) }),
    released: () => accountPool.get(account.id)?.currentConcurrency === 0,
    account: () => accountPool.get(account.id),
    accountPool, responsesStore,
  };
}

describe('Responses image stream HTTP lifecycle', () => {
  it.each([false, true])('returns generated images but never stores an unusable previous_response_id (stream=%s)', async (stream) => {
    const upstream = vi.fn(() => new Response(frame({ type: 'response.completed', response: { status: 'completed', output: [image()] } })));
    const store = new ResponsesStore();
    const put = vi.spyOn(store, 'put');
    const f = fixture(createOpenAiResponsesRoute, upstream, undefined, store);
    const first = await f.send('/v1/responses', { input: 'draw', tools: [{ type: 'image_generation' }], stream });
    expect(first.status).toBe(200);
    const wire = await first.text();
    const completed = stream ? wire.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6))).find((event) => event.type === 'response.completed').response : JSON.parse(wire);
    expect(completed.output).toEqual([image()]);
    expect(completed.id).toMatch(/^resp_/);
    expect(store.count()).toBe(0);
    expect(put).not.toHaveBeenCalled();
    const acquire = vi.spyOn(f.accountPool, 'acquireAsync');
    const second = await f.send('/v1/responses', { input: 'Describe the previous image', previous_response_id: completed.id });
    expect(second.status).toBe(404);
    expect(await second.json()).toMatchObject({ error: { type: 'not_found_error', message: 'Previous response not found.' } });
    expect(upstream).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(f.released()).toBe(true);
  });

  it.each([false, true])('rejects copied image output items before account acquisition (stream=%s)', async (stream) => {
    const upstream = vi.fn(() => { throw new Error('Must not dispatch copied image output'); });
    const f = fixture(createOpenAiResponsesRoute, upstream);
    const acquire = vi.spyOn(f.accountPool, 'acquireAsync');
    const response = await f.send('/v1/responses', { input: [image()], stream });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error', message: 'Generated image outputs cannot be replayed directly. Send the image as an input_image content part.' } });
    expect(acquire).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    expect(f.released()).toBe(true);
  });

  it('continues forwarding explicitly supplied input_image vision content', async () => {
    let captured: Record<string, unknown> | undefined;
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.test', fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response(frame({ type: 'response.completed', response: { status: 'completed', output: [] } }));
    } });
    const f = fixture(createOpenAiResponsesRoute, () => { throw new Error('Overridden backend'); }, backend);
    const content = [{ type: 'input_image', image_url: 'data:image/png;base64,YWJj', detail: 'auto' }];
    const response = await f.send('/v1/responses', { input: [{ type: 'message', role: 'user', content }], store: false });
    expect(response.status).toBe(200);
    expect(captured).toMatchObject({ input: [{ role: 'user', content }] });
    expect(f.released()).toBe(true);
  });

  it('delivers the preview before completion and releases the session when the caller cancels', async () => {
    let upstreamCancelled = false;
    const f = fixture(createOpenAiResponsesRoute, () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(frame(preview))); },
      cancel() { upstreamCancelled = true; },
    })));
    const response = await f.send('/v1/responses', { input: 'draw', tools: [{ type: 'image_generation', partial_images: 1 }], stream: true, store: false });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let received = '';
    while (!received.includes('partial_image_b64')) { const next = await reader.read(); if (next.done) throw new Error('Missing image preview'); received += new TextDecoder().decode(next.value); }
    expect(received.indexOf('response.output_item.added')).toBeLessThan(received.indexOf('response.image_generation_call.partial_image'));
    expect(received).not.toContain('response.completed');
    await reader.cancel();
    await vi.waitFor(() => { expect(upstreamCancelled).toBe(true); expect(f.released()).toBe(true); });
  });

  it.each([false, true])('accepts larger multi-image authoritative output through the actual route (stream=%s)', async (stream) => {
    const images = [image('first', 'A'.repeat(600 * 1024)), image('second', 'A'.repeat(600 * 1024))];
    const f = fixture(createOpenAiResponsesRoute, () => new Response(frame({ type: 'response.completed', response: { status: 'completed', output: images } })));
    const response = await f.send('/v1/responses', { input: 'draw', tools: [{ type: 'image_generation' }], stream, store: false });
    expect(response.status).toBe(200);
    const wire = await response.text();
    const completed = stream ? wire.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6))).find((event) => event.type === 'response.completed').response : JSON.parse(wire);
    expect(completed.output).toEqual(images);
    expect(completed.output_text).toBe('');
    expect(f.released()).toBe(true);
  });

  it('returns a stream error when previews have no authoritative final image', async () => {
    const f = fixture(createOpenAiResponsesRoute, () => new Response(frame(preview) + frame({ type: 'response.completed', response: { status: 'completed', output: [] } })));
    const response = await f.send('/v1/responses', { input: 'draw', tools: [{ type: 'image_generation' }], stream: true, store: false });
    const wire = await response.text();
    expect(response.status).toBe(200);
    expect(wire).toContain('response.image_generation_call.partial_image');
    expect(wire).toContain('event: response.failed');
    expect(wire).not.toContain('event: response.completed');
    expect(wire).toContain('"status":"failed"');
    expect(f.released()).toBe(true);
  });
});

describe.each([
  { name: 'Chat', route: createOpenAiChatRoute, path: '/v1/chat/completions', body: { messages: [{ role: 'user', content: 'draw' }] } },
  { name: 'Claude', route: createMessagesRoute, path: '/v1/messages', body: { max_tokens: 64, messages: [{ role: 'user', content: 'draw' }] } },
])('$name unsupported image output', ({ route, path, body }) => {
  it('rejects images carried only in a custom backend done event without exposing private output', async () => {
    const backend: ChatGptBackendClient = {
      listModels: async () => [], complete: async () => ({ text: '', finishReason: 'stop' }),
      async *stream() {
        yield { type: 'done', finishReason: 'stop', outputItems: [
          { type: 'reasoning', id: 'reasoning', summary: [], encrypted_content: 'PRIVATE_CIPHERTEXT' },
          { type: 'image_generation_call', id: 'image', status: 'completed', result: 'YWJj' },
        ] };
      },
    };
    const f = fixture(route, () => { throw new Error('Custom backend must not fetch'); }, backend);
    const response = await f.send(path, { ...body, stream: true });
    const wire = await response.text();
    expect(response.status).toBe(200);
    expect(wire).toContain('Generated image output is not supported');
    expect(wire).toContain('/v1/images/generations');
    expect(wire).toContain('api_error');
    expect(wire).not.toContain('YWJj');
    expect(wire).not.toContain('PRIVATE_CIPHERTEXT');
    expect(wire).not.toContain('"finish_reason":"stop"');
    expect(wire).not.toContain('message_stop');
    expect(f.released()).toBe(true);
    expect(f.account()?.status).toBe('available');
  });

  it.each([false, true])('uses the error envelope, never a blank success (stream=%s)', async (stream) => {
    const f = fixture(route, () => new Response(frame({ type: 'response.completed', response: { status: 'completed', output: [image()] } })));
    const response = await f.send(path, { ...body, stream });
    const wire = await response.text();
    expect(response.status).toBe(stream ? 200 : 501);
    expect(wire).toContain('/v1/images/generations');
    expect(wire).toContain('api_error');
    expect(wire).not.toContain('YWJj');
    expect(wire).not.toContain('"finish_reason":"stop"');
    expect(wire).not.toContain('message_stop');
    expect(f.released()).toBe(true);
    expect(f.account()?.status).toBe('available');
  });
});
