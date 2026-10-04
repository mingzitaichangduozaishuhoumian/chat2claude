import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionChatGptBackend, RESPONSES_IMAGE_LIMITS, type ChatGptImageGenerationRequest } from './index.js';

const context = { account: { id: 'synthetic', secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic-token', accountId: 'synthetic-upstream', cookie: 'synthetic-cookie' } } };
const response = { created: 123, data: [{ b64_json: 'aW1hZ2U=', generation_id: 'synthetic-generation' }] };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Codex Images JSON endpoint', () => {
  it('uses the standalone endpoint, a UUID turn header, account auth and only the official body fields', async () => {
    const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid/backend-api/', fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(init!.body as string) });
      return Response.json({ ...response, output_format: 'png', background: 'opaque', quality: 'medium', size: '1024x1024',
        private: 'PRIVATE_IMAGE_CANARY', usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, private: 'PRIVATE_IMAGE_CANARY' } });
    } });
    const result = await backend.generateImages({ prompt: 'draw a test', n: 1, background: 'opaque', quality: 'medium', size: '1024x1024', stream: true, output_format: 'jpeg', store: true } as ChatGptImageGenerationRequest, context);
    expect(calls[0].url).toBe('https://synthetic.invalid/backend-api/codex/images/generations');
    expect(calls[0].body).toEqual({ prompt: 'draw a test', model: 'gpt-image-2', n: 1, background: 'opaque', quality: 'medium', size: '1024x1024' });
    expect(calls[0].headers.get('x-codex-image-turn-id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(calls[0].headers.get('authorization')).toBe('Bearer synthetic-token');
    expect(calls[0].headers.get('chatgpt-account-id')).toBe('synthetic-upstream');
    expect(calls[0].headers.get('accept')).toBe('application/json');
    expect(result).toEqual({ ...response, output_format: 'png', background: 'opaque', quality: 'medium', size: '1024x1024', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_IMAGE_CANARY');
    await backend.generateImages({ prompt: 'another', model: 'gpt-image-1.5' }, context);
    expect(calls[1].body).toEqual({ prompt: 'another', model: 'gpt-image-1.5' });
    expect(calls[1].headers.get('x-codex-image-turn-id')).not.toBe(calls[0].headers.get('x-codex-image-turn-id'));
  });

  it('accepts actual base64 larger than the old replay budget', async () => {
    const image = Buffer.alloc(300 * 1024).toString('base64');
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', fetch: async () => Response.json({ created: 0, data: [{ b64_json: image }] }) });
    const result = await backend.generateImages({ prompt: 'test' }, context);
    expect(result.data[0].b64_json.length).toBe(image.length);
  });

  it.each([[400, 'invalid_request'], [401, 'unauthorized'], [403, 'upstream_error'], [429, 'rate_limited'], [500, 'upstream_error']] as const)('classifies HTTP %s without leaking provider data', async (status, code) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', fetch: async () => Response.json({ error: { code: 'rate_limit_exceeded', message: 'PRIVATE_IMAGE_CANARY' } }, {
      status, headers: { 'x-codex-active-limit': 'image_gen', 'x-codex-imagegen-request-id': 'PRIVATE_IMAGE_CANARY' },
    }) });
    const error = await backend.generateImages({ prompt: 'test' }, context).catch((error: unknown) => error);
    expect(error).toMatchObject({ code, status });
    if (status === 429) expect(error).toMatchObject({ safeDiagnostic: { rateLimitScope: 'image_gen' } });
    expect(String(error) + JSON.stringify(error)).not.toContain('PRIVATE_IMAGE_CANARY');
  });

  it('does not expose or infer an unknown quota header value', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', fetch: async () => new Response('', { status: 429, headers: { 'x-codex-active-limit': 'PRIVATE_IMAGE_CANARY' } }) });
    await expect(backend.generateImages({ prompt: 'test' }, context)).rejects.toMatchObject({ code: 'rate_limited', safeDiagnostic: { rateLimitScope: 'unknown' } });
  });

  it.each([{ prompt: '' }, { prompt: 'test', n: 11 }, { prompt: 'test', n: 0 }, { prompt: 'test', quality: 'xhigh' }, { prompt: 'test', background: 'invalid' }, { prompt: 'test', size: 'bad-size' }])('rejects unsupported request values before fetch: %j', async (request) => {
    const fetch = vi.fn();
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', fetch });
    await expect(backend.generateImages(request as ChatGptImageGenerationRequest, context)).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{ created: 1 }, { ...response, created: -1 }, { created: 1, data: [] }, { created: 1, data: [{ b64_json: 'not_base64' }] }, { created: 1, data: Array(11).fill({ b64_json: 'AA==' }) }])('rejects malformed successful JSON responses: %j', async (payload) => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', fetch: async () => Response.json(payload) });
    await expect(backend.generateImages({ prompt: 'test' }, context)).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
  });

  it('keeps its default 300 second timeout independent of the short-operation timeout', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', timeoutMs: 10, fetch: async () => new Response(new ReadableStream({ cancel })) });
    let outcome: unknown = 'pending';
    const pending = backend.generateImages({ prompt: 'test' }, context).catch((error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(outcome).toMatchObject({ code: 'timeout', status: 504 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an active JSON read and bounds stalled reader cleanup', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', fetch: async () => new Response(body) });
    const result = backend.generateImages({ prompt: 'test' }, { ...context, signal: caller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    caller.abort('PRIVATE_IMAGE_CANARY');
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces the JSON byte limit while reading and cancels before exhausting an endless body', async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(8 * 1024 * 1024).fill(32);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(chunk); }, cancel });
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', fetch: async () => new Response(body) });
    await expect(backend.generateImages({ prompt: 'test' }, context)).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
    expect(pulls).toBeLessThanOrEqual(RESPONSES_IMAGE_LIMITS.bundleBytes / chunk.byteLength + 2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('preserves HTTP classification after bounded stalled error-body cleanup', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', fetch: async () => new Response(new ReadableStream({ cancel }), { status: 403 }) });
    const pending = backend.generateImages({ prompt: 'test' }, context).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toMatchObject({ code: 'upstream_error', status: 403 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
