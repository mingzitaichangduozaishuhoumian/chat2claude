import { afterEach, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import { AccountPool } from './account-pool.js';
import { createChatGptBackend } from './backend-factory.js';
import { candidateSessionContext } from './refresh-aware-backend.js';

afterEach(() => vi.useRealTimers());
it('API factory uses phased generation defaults while retaining short discovery limits and metric callbacks', async () => {
  vi.useFakeTimers();
  const env = loadEnv({ CHATGPT_BACKEND: 'session', CHATGPT_REQUEST_TIMEOUT_MS: '50' });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const backend = createChatGptBackend(env, new AccountPool(), undefined, async url => String(url).includes('/responses') ? new Response(body) : new Promise(() => {}));
  const context = { ...candidateSessionContext({ id: 'test', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'CANARY' } }), onWireMetrics: vi.fn() };
  const result = backend.complete({ model: 'test', maxTokens: 1, messages: [{ role: 'user', content: 'CANARY' }] }, context).catch(error => error);
  for (let i = 0; i < 12; i++) { await vi.advanceTimersByTimeAsync(10); controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')); }
  controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'));
  expect(await result).toMatchObject({ text: '' });
  expect(context.onWireMetrics).toHaveBeenCalledWith(expect.objectContaining({ upstreamBodyBytes: expect.any(Number) }));
  const discovery = backend.listModels(context).catch(error => error);
  await vi.advanceTimersByTimeAsync(50);
  expect(await discovery).toMatchObject({ code: 'timeout', status: 504 });
  expect(vi.getTimerCount()).toBe(0);
});
