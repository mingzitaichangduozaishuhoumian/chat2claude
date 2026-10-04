import { describe, expect, it, vi } from 'vitest';
import { CODEX_IMAGE_MODEL_IDS, SessionChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { createOpenAiImagesRoute } from './routes/openai-images.js';
import { AccountPool } from './services/account-pool.js';
import { RequestLog } from './services/request-log.js';

const extendedModels = ['gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-sunburst-2026-09-08'];
function fixture() {
  const accountPool = new AccountPool({ seedMockAccount: false });
  accountPool.add({ id: 'synthetic', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'synthetic-token' } });
  const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const body = JSON.parse(init!.body as string);
    captured.push({ url: String(url), body });
    return Response.json({ created: 123, data: [{ b64_json: 'aW1hZ2U=' }], output_format: 'png', quality: body.quality });
  });
  const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', fetch });
  const app = createOpenAiImagesRoute({ backend, accountPool, requestLog: new RequestLog(), backendProvider: 'session', accountAcquireTimeoutMs: 0 });
  return { backend, accountPool, captured, fetch, send: (body: unknown) => app.request('/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) };
}

async function responseBody(response: Response, stream: boolean) {
  const text = await response.text();
  if (!stream) return JSON.parse(text);
  expect(text.match(/event: image_generation.completed/g)).toHaveLength(1);
  expect(text).not.toContain('partial_image');
  return JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
}

describe('registered image models through API and real Session wire construction', () => {
  it.each(CODEX_IMAGE_MODEL_IDS.flatMap((model) => [false, true].map((stream) => ({ model, stream }))))('keeps $model unchanged for stream=$stream', async ({ model, stream }) => {
    const f = fixture();
    const response = await f.send({ model, prompt: 'synthetic-image', quality: 'high', stream });
    expect(response.status).toBe(200);
    expect(await responseBody(response, stream)).toMatchObject({ quality: 'high', output_format: 'png' });
    expect(f.captured).toEqual([{ url: 'https://synthetic.invalid/backend-api/codex/images/generations', body: { prompt: 'synthetic-image', model, quality: 'high' } }]);
    expect(f.accountPool.get('synthetic')?.currentConcurrency).toBe(0);
  });

  it.each(extendedModels.flatMap((model) => ['xhigh', 'max'].flatMap((quality) => [false, true].map((stream) => ({ model, quality, stream })))))('preserves $quality request and response metadata for $model stream=$stream', async ({ model, quality, stream }) => {
    const f = fixture();
    const response = await f.send({ model, prompt: 'synthetic-image', quality, stream });
    expect(response.status).toBe(200);
    const output = await responseBody(response, stream);
    expect(output.quality).toBe(quality);
    expect(f.captured[0].body).toEqual({ model, prompt: 'synthetic-image', quality });
    expect(f.accountPool.get('synthetic')?.currentConcurrency).toBe(0);
  });

  it.each([undefined, 'gpt-image-2', 'gpt-image-1.5', 'image-future', 'gpt-image-2.5-unverified'].flatMap((model) => ['xhigh', 'max'].map((quality) => ({ model, quality }))))('rejects unsupported extended quality $quality for $model before acquisition or fetch', async ({ model, quality }) => {
    const f = fixture();
    const acquire = vi.spyOn(f.accountPool, 'acquireAsync');
    const response = await f.send({ ...(model === undefined ? {} : { model }), prompt: 'synthetic-image', quality });
    expect(response.status).toBe(400);
    expect(acquire).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    // Direct adapter users retain the same guard when no API route is involved.
    await expect(f.backend.generateImages({ ...(model === undefined ? {} : { model }), prompt: 'synthetic-image', quality: quality as 'xhigh' | 'max' }, { account: f.accountPool.get('synthetic')! }))
      .rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('keeps the default gpt-image-2 and permits explicit future IDs with standard quality', async () => {
    const f = fixture();
    expect((await f.send({ prompt: 'synthetic-image', quality: 'auto' })).status).toBe(200);
    expect(f.captured[0].body.model).toBe('gpt-image-2');
    expect((await f.send({ model: 'image-future', prompt: 'synthetic-image', quality: 'high' })).status).toBe(200);
    expect(f.captured[1].body.model).toBe('image-future');
  });
});
