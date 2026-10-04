import { afterEach, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import { AccountPool } from './account-pool.js';
import { createChatGptBackend } from './backend-factory.js';
import { candidateSessionContext } from './refresh-aware-backend.js';

afterEach(() => vi.useRealTimers());
it('keeps image generation on its configured independent timeout', async () => {
  vi.useFakeTimers();
  const env = loadEnv({ CHATGPT_BACKEND: 'session', CHATGPT_REQUEST_TIMEOUT_MS: '5', CHATGPT_IMAGE_REQUEST_TIMEOUT_MS: '90' });
  const backend = createChatGptBackend(env, new AccountPool(), undefined, async () => new Promise(() => {}));
  const context = candidateSessionContext({ id: 'test', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'SYNTHETIC_ONLY' } });
  const result = backend.generateImages!({ prompt: 'A tree' }, context).catch((error) => error);
  let settled = false;
  void result.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(6);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(84);
  expect(await result).toMatchObject({ code: 'timeout', status: 504 });
  expect(vi.getTimerCount()).toBe(0);
});

it('API factory uses phased generation defaults while retaining short discovery limits and metric callbacks', async () => {
  vi.useFakeTimers();
  const env = loadEnv({ CHATGPT_BACKEND: 'session', CHATGPT_REQUEST_TIMEOUT_MS: '50' });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const backend = createChatGptBackend(env, new AccountPool(), undefined, async url => String(url).includes('/responses') ? new Response(body) : new Promise(() => {}));
  const context = { ...candidateSessionContext({ id: 'test', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'CANARY' } }), onWireMetrics: vi.fn() };
  const result = backend.complete({ model: 'test', maxTokens: 1, messages: [{ role: 'user', content: 'CANARY' }] }, context).catch(error => error);
  for (let i = 0; i < 12; i++) { await vi.advanceTimersByTimeAsync(10); controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')); }
  controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'));
  expect(await result).toMatchObject({ text: '' });
  expect(context.onWireMetrics).toHaveBeenCalledWith(expect.objectContaining({ upstreamBodyBytes: expect.any(Number) }));
  const discovery = backend.listModels(context).catch(error => error);
  await vi.advanceTimersByTimeAsync(50);
  expect(await discovery).toMatchObject({ code: 'timeout', status: 504 });
  expect(vi.getTimerCount()).toBe(0);
});
