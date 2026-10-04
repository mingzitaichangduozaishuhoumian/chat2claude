import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ChatGptBackendError, type ChatGptBackendClient, type ChatGptImageGenerationResponse } from '@chatgpt-to-claude/chatgpt-backend';
import { createOpenAiImagesRoute } from './routes/openai-images.js';
import { AccountPool } from './services/account-pool.js';
import { RequestLog } from './services/request-log.js';
import type { AdminOperationalState } from './services/admin-operational-state.js';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { accessLog } from './middleware/access-log.js';

const image: ChatGptImageGenerationResponse = { created: 123, data: [{ b64_json: 'aW1hZ2U=' }] };
const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const accountPool = new AccountPool({ seedMockAccount: false });
  accountPool.add({ id: 'image-account', provider: 'chatgpt-session', capabilities: ['messages'], maxConcurrency: 1,
    secret: { type: 'chatgpt-session', accessToken: 'SYNTHETIC_ONLY' } });
  const generateImages = vi.fn<NonNullable<ChatGptBackendClient['generateImages']>>(async () => image);
  const backend: ChatGptBackendClient = { generateImages, listModels: vi.fn(async () => []), complete: vi.fn(async () => ({ text: '', finishReason: 'stop' })), async *stream() {} };
  const state = { recordRequestStarted: vi.fn(), recordRequestFinished: vi.fn() };
  const requestLog = new RequestLog();
  const log = logger();
  const app = new Hono();
  app.use('*', accessLog(log));
  app.route('/', createOpenAiImagesRoute({ backend, accountPool, requestLog, logger: log, operationalState: state as unknown as AdminOperationalState, backendProvider: 'session', accountAcquireTimeoutMs: 0 }));
  const request = (body: unknown = { prompt: 'Draw a small tree' }, signal?: AbortSignal) => app.request('/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  return { app, request, backend, generateImages, accountPool, state, requestLog, log };
}

describe('Independent OpenAI Images API', () => {
  it('uses the independent default image model without text discovery or invented usage', async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...image, output_format: 'png' });
    expect(f.generateImages).toHaveBeenCalledWith({ model: 'gpt-image-2', prompt: 'Draw a small tree' }, expect.objectContaining({ account: expect.objectContaining({ id: 'image-account' }), signal: expect.any(AbortSignal) }));
    expect(f.backend.listModels).not.toHaveBeenCalled();
    expect(f.backend.complete).not.toHaveBeenCalled();
    expect(f.accountPool.get('image-account')?.currentConcurrency).toBe(0);
    expect(f.state.recordRequestStarted).toHaveBeenCalledOnce();
    expect(f.state.recordRequestFinished).toHaveBeenCalledWith(expect.anything(), { outcome: 'success' });
    expect(f.requestLog.list()).toEqual([expect.objectContaining({ route: '/v1/images/generations', model: 'gpt-image-2', stream: false })]);
  });

  it('forwards only supported provider fields and preserves known metadata and usage', async () => {
    const f = fixture();
    f.generateImages.mockResolvedValueOnce({ ...image, quality: 'high', size: '1536x1024', usage: { inputTokens: 7, totalTokens: 10, raw: { secret: 'USAGE_CANARY' } } });
    const response = await f.request({ model: 'image-native-future', prompt: ' exact prompt ', background: 'transparent', quality: 'auto', size: 'auto', n: 1, response_format: 'b64_json', output_format: 'png', stream: false, partial_images: 0 });
    expect(await response.json()).toEqual({ ...image, output_format: 'png', background: 'transparent', quality: 'high', size: '1536x1024', usage: { input_tokens: 7, total_tokens: 10 } });
    expect(f.generateImages.mock.calls[0][0]).toEqual({ model: 'image-native-future', prompt: ' exact prompt ', background: 'transparent', quality: 'auto', size: 'auto', n: 1 });
    expect(f.state.recordRequestFinished).toHaveBeenCalledWith(expect.anything(), { outcome: 'success', inputTokens: 7 });
  });

  it('supports n>1 for JSON responses', async () => {
    const f = fixture();
    f.generateImages.mockResolvedValueOnce({ ...image, data: [image.data[0], { b64_json: 'b3RoZXI=' }] });
    const response = await f.request({ prompt: 'Two images', n: 2 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [{ b64_json: 'aW1hZ2U=' }, { b64_json: 'b3RoZXI=' }] });
  });

  it.each([
    null, [], {}, { prompt: '' }, { prompt: ' ' }, { prompt: 'x'.repeat(32_001) },
    ...[0, 11, 1.5, '1', null].map((n) => ({ prompt: 'x', n })),
    { prompt: 'x', response_format: 'url' }, { prompt: 'x', output_format: 'jpeg' },
    { prompt: 'x', output_compression: 80 }, { prompt: 'x', moderation: 'low' },
    { prompt: 'x', user: 'unverified-forwarding' }, { prompt: 'x', partial_images: 1 }, { prompt: 'x', partial_images: '0' },
    { prompt: 'x', stream: true, n: 2 }, { prompt: 'x', stream: 'true' },
    { prompt: 'x', background: 'bad' }, { prompt: 'x', quality: 1 }, { prompt: 'x', size: 'invalid' },
    { prompt: 'x', model: '' }, { prompt: 'x', model: '../bad' },
  ])('rejects unsupported or malformed settings before acquiring an account (%#)', async (body) => {
    const f = fixture();
    const response = await f.request(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error' } });
    expect(f.generateImages).not.toHaveBeenCalled();
    expect(f.state.recordRequestStarted).not.toHaveBeenCalled();
    expect(f.accountPool.get('image-account')?.currentConcurrency).toBe(0);
  });

  it('bounds the request body and does not echo malformed JSON', async () => {
    const f = fixture();
    const response = await f.app.request('/v1/images/generations', { method: 'POST', body: 'PRIVATE_JSON_CANARY' });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('PRIVATE_JSON_CANARY');
    expect((await f.request({ prompt: 'x'.repeat(128 * 1024) })).status).toBe(413);
    expect(f.generateImages).not.toHaveBeenCalled();
  });

  it('streams exactly one final event without partial previews, fake metadata or zero usage', async () => {
    const f = fixture();
    const response = await f.request({ prompt: 'x', stream: true });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toBe('event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"aW1hZ2U=","created_at":123,"output_format":"png"}\n\n');
    expect(f.state.recordRequestFinished).toHaveBeenCalledExactlyOnceWith(expect.anything(), { outcome: 'success' });
    expect(f.accountPool.get('image-account')?.currentConcurrency).toBe(0);
  });

  it('logs the recognized image route and stream outcome without prompt or image contents', async () => {
    const f = fixture();
    const response = await f.request({ prompt: 'PROMPT_CANARY', stream: true });
    await response.text();
    expect(f.log.info).toHaveBeenCalledWith('HTTP access', expect.objectContaining({ path: '/v1/images/generations', model: 'gpt-image-2', outcome: 'success', durationKind: 'stream_terminal' }));
    const logs = JSON.stringify([...f.log.info.mock.calls, ...f.log.error.mock.calls]);
    expect(logs).not.toContain('PROMPT_CANARY');
    expect(logs).not.toContain(image.data[0].b64_json);
  });

  it('retains the HTTP upstream error status before final-only streaming begins', async () => {
    const f = fixture();
    f.generateImages.mockRejectedValueOnce(new ChatGptBackendError('UPSTREAM_CANARY', 'timeout', { status: 504 }));
    const response = await f.request({ prompt: 'x', stream: true });
    expect(response.status).toBe(504);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.text()).not.toContain('UPSTREAM_CANARY');
  });

  it('streams only known usage and uses explicit request settings when upstream metadata is absent', async () => {
    const f = fixture();
    f.generateImages.mockResolvedValueOnce({ ...image, usage: { outputTokens: 8 } });
    const response = await f.request({ prompt: 'x', stream: true, quality: 'auto', size: 'auto', background: 'auto', partial_images: 0 });
    const text = await response.text();
    const data = JSON.parse(text.split('data: ')[1]);
    expect(data).toMatchObject({ quality: 'auto', size: 'auto', background: 'auto', usage: { output_tokens: 8 } });
    expect(data.usage).not.toHaveProperty('input_tokens');
    expect(data.usage).not.toHaveProperty('total_tokens');
  });

  it('does not silently discard multiple results in final-only streaming', async () => {
    const f = fixture();
    f.generateImages.mockResolvedValueOnce({ ...image, data: [image.data[0], image.data[0]] });
    const response = await f.request({ prompt: 'x', stream: true });
    expect(response.status).toBe(502);
    expect(f.state.recordRequestFinished).toHaveBeenCalledExactlyOnceWith(expect.anything(), { outcome: 'failure' });
    expect(f.accountPool.get('image-account')?.currentConcurrency).toBe(0);
  });

  it.each([
    { error: new ChatGptBackendError('PRIVATE', 'upstream_error', { status: 403 }), status: 403, accountStatus: 'available' },
    { error: new ChatGptBackendError('PRIVATE', 'rate_limited', { status: 429, safeDiagnostic: { rateLimitScope: 'image_gen' } }), status: 429, accountStatus: 'available' },
    { error: new ChatGptBackendError('PRIVATE', 'rate_limited', { status: 429 }), status: 429, accountStatus: 'cooldown' },
    { error: new ChatGptBackendError('PRIVATE', 'invalid_request', { status: 400 }), status: 400, accountStatus: 'available' },
    { error: new ChatGptBackendError('PRIVATE', 'unauthorized', { status: 401 }), status: 401, accountStatus: 'unhealthy' },
  ])('isolates image-specific failures from text account availability ($status/$accountStatus)', async ({ error, status, accountStatus }) => {
    const f = fixture();
    f.generateImages.mockRejectedValueOnce(error);
    const response = await f.request();
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain('PRIVATE');
    expect(f.accountPool.get('image-account')).toMatchObject({ currentConcurrency: 0, status: accountStatus });
    expect(f.state.recordRequestFinished).toHaveBeenCalledExactlyOnceWith(expect.anything(), { outcome: 'failure' });
    if (accountStatus === 'available') {
      const textLease = f.accountPool.acquire({ provider: 'chatgpt-session', capability: 'messages' });
      expect(textLease?.id).toBe('image-account');
      if (textLease) f.accountPool.release(textLease);
    }
  });

  it('cancels an in-flight image request promptly even if a custom backend ignores its signal', async () => {
    const f = fixture();
    f.generateImages.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = f.request(undefined, controller.signal);
    await vi.waitFor(() => expect(f.generateImages).toHaveBeenCalledOnce());
    controller.abort('PRIVATE_REASON');
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.text()).not.toContain('PRIVATE_REASON');
    expect(f.generateImages.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(f.accountPool.get('image-account')).toMatchObject({ currentConcurrency: 0, status: 'available' });
    expect(f.state.recordRequestFinished).toHaveBeenCalledExactlyOnceWith(expect.anything(), { outcome: 'cancelled' });
  });

  it('releases a completed image stream cancelled before delivery exactly once', async () => {
    const f = fixture();
    const response = await f.request({ prompt: 'x', stream: true });
    await response.body!.cancel();
    expect(f.accountPool.get('image-account')?.currentConcurrency).toBe(0);
    expect(f.state.recordRequestFinished).toHaveBeenCalledExactlyOnceWith(expect.anything(), { outcome: 'cancelled' });
  });

  it('does not publish success when cancellation races a completed backend result', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.generateImages.mockImplementationOnce(async () => { controller.abort(); return image; });
    expect((await f.request(undefined, controller.signal)).status).toBe(499);
    expect(f.state.recordRequestFinished).toHaveBeenCalledExactlyOnceWith(expect.anything(), { outcome: 'cancelled' });
    expect(f.accountPool.get('image-account')?.currentConcurrency).toBe(0);
  });

  it('respects account concurrency and reports an unsupported backend explicitly', async () => {
    const f = fixture();
    const lease = f.accountPool.acquire({ provider: 'chatgpt-session' })!;
    expect((await f.request()).status).toBe(503);
    expect(f.generateImages).not.toHaveBeenCalled();
    f.accountPool.release(lease);
    delete f.backend.generateImages;
    expect((await f.request()).status).toBe(501);
    expect(f.state.recordRequestStarted).not.toHaveBeenCalled();
  });

  it('is protected by the application API-key middleware', async () => {
    const f = fixture();
    const app = createApp(loadEnv({ NODE_ENV: 'test', API_KEYS: 'synthetic-key' }), { backend: f.backend, runtimeStateStore: null, operationalState: null });
    try {
      expect((await app.request('/v1/images/generations', { method: 'POST', body: JSON.stringify({ prompt: 'x' }) })).status).toBe(401);
      expect(f.generateImages).not.toHaveBeenCalled();
      expect((await app.request('/v1/images/generations', { method: 'POST', headers: { authorization: 'Bearer synthetic-key', 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) })).status).toBe(200);
    } finally { await app.dispose(); }
  });
});
