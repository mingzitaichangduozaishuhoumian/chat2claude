import { describe, expect, it, vi } from 'vitest';
import { CODEX_IMAGE_BASE_MODEL_IDS, CODEX_IMAGE_RESOLUTION_ALIASES, SessionChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { createOpenAiImagesRoute } from './routes/openai-images.js';
import { AccountPool } from './services/account-pool.js';
import { RequestLog } from './services/request-log.js';

const extendedModels = ['gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-sunburst-2026-09-08'];
const aliases = Object.entries(CODEX_IMAGE_RESOLUTION_ALIASES).map(([id, config]) => ({ id, ...config }));
// A real, CRC-valid one-pixel RGBA PNG with half-transparent red; no live images.
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg==';
const widePng = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DQwPCf4T8ADn0Dfur2k8AAAAAASUVORK5CYII=';
function fixture(images = [tinyPng]) {
  const accountPool = new AccountPool({ seedMockAccount: false });
  accountPool.add({ id: 'synthetic', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'synthetic-token' } });
  const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const body = JSON.parse(init!.body as string);
    captured.push({ url: String(url), body });
    return Response.json({ created: 123, data: images.map((b64_json) => ({ b64_json })), output_format: 'png', quality: body.quality });
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
  it.each(CODEX_IMAGE_BASE_MODEL_IDS.flatMap((model) => [false, true].map((stream) => ({ model, stream }))))('keeps base model $model unchanged for stream=$stream', async ({ model, stream }) => {
    const f = fixture();
    const response = await f.send({ model, prompt: 'synthetic-image', quality: 'high', stream });
    expect(response.status).toBe(200);
    expect(await responseBody(response, stream)).toMatchObject({ quality: 'high', output_format: 'png' });
    expect(f.captured).toEqual([{ url: 'https://synthetic.invalid/backend-api/codex/images/generations', body: { prompt: 'synthetic-image', model, quality: 'high' } }]);
    expect(f.accountPool.get('synthetic')?.currentConcurrency).toBe(0);
  });

  it.each(aliases.flatMap((alias) => [false, true].map((stream) => ({ ...alias, stream }))))('normalizes $id on the Session wire and returns final PNG dimensions for stream=$stream', async ({ id, model, stream }) => {
    const f = fixture();
    const response = await f.send({ model: id, prompt: 'synthetic-image', size: '16x16', quality: 'high', stream });
    expect(response.status).toBe(200);
    const output = await responseBody(response, stream);
    const png = Buffer.from(stream ? output.b64_json : output.data[0].b64_json, 'base64');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([16, 16]);
    expect(output).toMatchObject({ quality: 'high', output_format: 'png', size: '16x16' });
    expect(f.captured).toEqual([{ url: 'https://synthetic.invalid/backend-api/codex/images/generations', body: { prompt: 'synthetic-image', model, size: '16x16', quality: 'high' } }]);
    expect(f.accountPool.get('synthetic')?.currentConcurrency).toBe(0);
  });

  it.each([
    { model: 'gpt-image-2.5-flare-2k', size: '2048x2048', width: 2048, height: 2048 },
    { model: 'gpt-image-2.5-sunburst-4k', size: '3840x2160', width: 3840, height: 2160 },
  ])('applies the advertised default size of $model to a real PNG', async ({ model, size, width, height }) => {
    const f = fixture();
    const response = await f.send({ model, prompt: 'synthetic-image' });
    expect(response.status).toBe(200);
    const output = await responseBody(response, false);
    const png = Buffer.from(output.data[0].b64_json, 'base64');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, height]);
    expect(output.size).toBe(size);
    expect(f.captured[0].body).toMatchObject({ size });
    expect(f.captured[0].body.model).not.toMatch(/-[24]k$/);
  });

  it('keeps explicit auto and reports actual source dimensions for a size alias', async () => {
    const f = fixture();
    const response = await f.send({ model: 'gpt-image-2.5-flare-4k', prompt: 'synthetic-image', size: 'auto' });
    expect(response.status).toBe(200);
    const output = await responseBody(response, false);
    expect(output.size).toBe('1x1');
    expect(output.data[0].b64_json).toBe(tinyPng);
    expect(f.captured[0].body).toMatchObject({ model: 'gpt-image-2.5-flare', size: 'auto' });
  });

  it.each(aliases)('omits shared size for mixed dimensions in an auto batch using $id', async ({ id, model }) => {
    const f = fixture([tinyPng, widePng]);
    const response = await f.send({ model: id, prompt: 'synthetic-image', size: 'auto', n: 2 });
    expect(response.status).toBe(200);
    const output = await responseBody(response, false);
    expect(output).not.toHaveProperty('size');
    expect(output.data).toEqual([{ b64_json: tinyPng }, { b64_json: widePng }]);
    expect(output.data.map((item: { b64_json: string }) => {
      const png = Buffer.from(item.b64_json, 'base64');
      return [png.readUInt32BE(16), png.readUInt32BE(20)];
    })).toEqual([[1, 1], [2, 1]]);
    expect(f.captured[0].body).toEqual({ model, prompt: 'synthetic-image', size: 'auto', n: 2 });
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

  it.each(aliases.flatMap((alias) => ['xhigh', 'max'].map((quality) => ({ ...alias, quality }))))('retains extended quality $quality while resolving $id', async ({ id, model, quality }) => {
    const f = fixture();
    const response = await f.send({ model: id, prompt: 'synthetic-image', size: '16x16', quality });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ quality, size: '16x16' });
    expect(f.captured[0].body).toEqual({ model, prompt: 'synthetic-image', size: '16x16', quality });
  });

  it.each(['3841x16', '3840x2161', '4096x4096', '99999x99999', '0x16', 'NaNx16', 16, null])('rejects unsafe alias size %j before account acquisition or fetch', async (size) => {
    const f = fixture();
    const acquire = vi.spyOn(f.accountPool, 'acquireAsync');
    const response = await f.send({ model: 'gpt-image-2.5-flare-4k', prompt: 'synthetic-image', size });
    expect(response.status).toBe(400);
    expect(acquire).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
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
