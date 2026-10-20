import { afterEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { deflateSync } from 'node:zlib';
import { SessionChatGptBackend, CODEX_IMAGE_BASE_MODEL_IDS, CODEX_IMAGE_MODEL_IDS, CODEX_IMAGE_RESOLUTION_ALIASES,
  isSupportedImageQuality, isSupportedImageSize } from './index.js';
import { imageGenerationBody } from './images.js';
import { resizeAliasedImageResponse } from './image-resize.js';

const context = { account: { id: 'synthetic', secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic-token' } } };
const alias = 'gpt-image-2.5-flare-2k';
const signal = () => new AbortController().signal;
function png(width: number, height: number, pixels: number[] = [0, 0, 255, 255]): string {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index++) image.data[index] = pixels[index % pixels.length];
  return PNG.sync.write(image).toString('base64');
}
function image(b64_json = png(1, 1)) {
  return { created: 123, data: [{ b64_json, generation_id: 'synthetic-generation' }] };
}
function chunk(type: string, data: Buffer): Buffer {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); output.write(type, 4); data.copy(output, 8);
  let crc = 0xffffffff;
  for (const byte of output.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  }
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
function header(width: number, height: number, depth = 8, colorType = 6, interlace = 0): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width); data.writeUInt32BE(height, 4);
  data[8] = depth; data[9] = colorType; data[12] = interlace;
  return chunk('IHDR', data);
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const endChunk = () => chunk('IEND', Buffer.alloc(0));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('explicit local image resolution aliases', () => {
  it('adds exactly four detached resolution presets without changing the five native model IDs', () => {
    expect(CODEX_IMAGE_BASE_MODEL_IDS).toHaveLength(5);
    expect(Object.keys(CODEX_IMAGE_RESOLUTION_ALIASES)).toEqual([
      'gpt-image-2.5-flare-2k', 'gpt-image-2.5-flare-4k', 'gpt-image-2.5-sunburst-2k', 'gpt-image-2.5-sunburst-4k',
    ]);
    expect(CODEX_IMAGE_MODEL_IDS).toHaveLength(9);
    expect(new Set(CODEX_IMAGE_MODEL_IDS).size).toBe(9);
    expect(Object.isFrozen(CODEX_IMAGE_RESOLUTION_ALIASES)).toBe(true);
    expect(Object.values(CODEX_IMAGE_RESOLUTION_ALIASES).every(Object.isFrozen)).toBe(true);
  });

  it.each(Object.entries(CODEX_IMAGE_RESOLUTION_ALIASES))('maps %s only at the Images wire boundary', (model, preset) => {
    const request = { model, prompt: 'a portrait, do not rewrite these words', background: 'transparent' as const, quality: 'max' as const };
    expect(imageGenerationBody(request)).toEqual({ ...request, model: preset.model, size: preset.size });
    expect(request.model).toBe(model);
    expect(request).not.toHaveProperty('size');
    expect(isSupportedImageQuality(model, 'xhigh')).toBe(true);
    expect(isSupportedImageQuality(model, 'max')).toBe(true);
    expect(imageGenerationBody({ ...request, size: '123x321' })).toMatchObject({ model: preset.model, size: '123x321' });
    expect(imageGenerationBody({ ...request, size: 'auto' })).toMatchObject({ model: preset.model, size: 'auto' });
  });

  it.each(['gpt-image-2.5-flare-8k', 'gpt-image-2.5-flare-4K', 'gpt-image-2.5-flare-4k-snapshot', 'toString', 'constructor'])('does not infer a resolution alias for %s', (model) => {
    expect(imageGenerationBody({ model, prompt: 'test' })).toEqual({ model, prompt: 'test' });
    expect(isSupportedImageQuality(model, 'max')).toBe(false);
    expect(isSupportedImageSize(model, '99999x99999')).toBe(true);
  });

  it.each(['3841x1', '1x3841', '3840x2161', '0x100', '100x0', '2K', '2048X2048'])('rejects an unsafe or malformed alias output size %s', (size) => {
    expect(isSupportedImageSize(alias, size)).toBe(false);
    expect(() => imageGenerationBody({ model: alias, prompt: 'test', size })).toThrow();
  });
  it.each(['auto', '1x1', '2048x2048', '3840x2160', '2160x3840'])('accepts bounded alias size %s', (size) => {
    expect(isSupportedImageSize(alias, size)).toBe(true);
  });
});

describe('physical PNG resolution output', () => {
  it('fits without stretching and uses transparent centered padding', async () => {
    const result = await resizeAliasedImageResponse(image(png(2, 1)), { model: alias, prompt: 'test', size: '4x4', background: 'transparent' }, signal());
    expect(result).toMatchObject({ created: 123, size: '4x4', output_format: 'png', data: [{ generation_id: 'synthetic-generation' }] });
    const decoded = PNG.sync.read(Buffer.from(result.data[0].b64_json, 'base64'));
    expect([decoded.width, decoded.height]).toEqual([4, 4]);
    expect([...decoded.data.subarray(0, 16)]).toEqual(Array(16).fill(0));
    expect([...decoded.data.subarray(16, 32)]).toEqual(Array(4).fill([0, 0, 255, 255]).flat());
    expect([...decoded.data.subarray(48, 64)]).toEqual(Array(16).fill(0));
  });

  it('composites semi-transparent pixels and padding on white for opaque output', async () => {
    const result = await resizeAliasedImageResponse({ ...image(png(1, 2, [255, 0, 0, 128])), background: 'opaque' },
      { model: alias, prompt: 'test', size: '4x4' }, signal());
    const decoded = PNG.sync.read(Buffer.from(result.data[0].b64_json, 'base64'));
    expect([...decoded.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...decoded.data.subarray(4, 8)]).toEqual([255, 127, 127, 255]);
    expect([...decoded.data].filter((_value, index) => index % 4 === 3).every((alpha) => alpha === 255)).toBe(true);
  });

  it('interpolates premultiplied alpha without a hidden-color fringe or dark halo', async () => {
    const result = await resizeAliasedImageResponse(image(png(2, 1, [255, 0, 0, 255, 0, 0, 255, 0])),
      { model: alias, prompt: 'test', size: '8x4', background: 'transparent' }, signal());
    const decoded = PNG.sync.read(Buffer.from(result.data[0].b64_json, 'base64'));
    let partial = 0;
    for (let index = 0; index < decoded.data.length; index += 4) {
      const [red, green, blue, alpha] = decoded.data.subarray(index, index + 4);
      if (alpha > 0 && alpha < 255) { partial++; expect([red, green, blue]).toEqual([255, 0, 0]); }
    }
    expect(partial).toBeGreaterThan(0);
  });

  it('preserves an already matching validated PNG byte-for-byte and reports physical metadata', async () => {
    const source = image(png(3, 2));
    const result = await resizeAliasedImageResponse({ ...source, size: '999x999' }, { model: alias, prompt: 'test', size: '3x2' }, signal());
    expect(result.data).toEqual(source.data);
    expect(result.size).toBe('3x2');
  });

  it('keeps auto dimensions, validates the PNG, and corrects inaccurate upstream size metadata', async () => {
    const source = image(png(7, 3));
    expect(await resizeAliasedImageResponse({ ...source, size: '1024x1024' }, { model: alias, prompt: 'test', size: 'auto' }, signal()))
      .toEqual({ ...source, size: '7x3', output_format: 'png' });
  });

  it('does not invent one global auto size when a batch contains different dimensions', async () => {
    const result = await resizeAliasedImageResponse({ created: 1, size: '1024x1024', data: [{ b64_json: png(2, 1) }, { b64_json: png(1, 2) }] },
      { model: alias, prompt: 'test', size: 'auto' }, signal());
    expect(result).not.toHaveProperty('size');
  });

  it.each(['aW1hZ2U=', png(1, 1).slice(0, -4) + 'AAAA'])('fails rather than returning an invalid PNG as a successful resolution alias', async (b64_json) => {
    await expect(resizeAliasedImageResponse(image(b64_json), { model: alias, prompt: 'test', size: 'auto' }, signal()))
      .rejects.toMatchObject({ code: 'invalid_response', status: 502 });
  });

  it('rejects excessive IHDR dimensions before decoding a compressed image', async () => {
    const bytes = Buffer.from(png(1, 1), 'base64'); bytes.writeUInt32BE(100_000, 16);
    await expect(resizeAliasedImageResponse(image(bytes.toString('base64')), { model: alias, prompt: 'test', size: 'auto' }, signal()))
      .rejects.toMatchObject({ code: 'invalid_response', status: 502 });
  });

  it('rejects compressed scanline data exceeding the declared pixel budget', async () => {
    const original = Buffer.from(png(1, 1), 'base64');
    const bomb = Buffer.concat([original.subarray(0, 33), chunk('IDAT', deflateSync(Buffer.alloc(1024 * 1024))), chunk('IEND', Buffer.alloc(0))]);
    await expect(resizeAliasedImageResponse(image(bomb.toString('base64')), { model: alias, prompt: 'test', size: 'auto' }, signal()))
      .rejects.toMatchObject({ code: 'invalid_response', status: 502 });
  });

  it('rejects a second valid-CRC IHDR that changes decoder dimensions while retaining the same inflated byte count', async () => {
    const duplicate = Buffer.concat([signature, header(8192, 1, 8, 0), header(65536, 1, 1, 0),
      chunk('IDAT', deflateSync(Buffer.alloc(8193))), endChunk()]);
    expect(duplicate.length).toBe(113);
    await expect(resizeAliasedImageResponse(image(duplicate.toString('base64')), { model: alias, prompt: 'test', size: 'auto' }, signal()))
      .rejects.toMatchObject({ code: 'invalid_response', status: 502 });
  });

  it.each(['missing-IEND', 'nonempty-IEND', 'after-IEND', 'missing-IDAT', 'split-IDAT', 'nonfirst-IHDR'] as const)(
    'rejects structurally invalid PNG chunks: %s', async (kind) => {
      const compressed = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
      const idat = chunk('IDAT', compressed), ihdr = header(1, 1);
      const ancillary = chunk('tEXt', Buffer.from('key\0value'));
      const chunks = kind === 'missing-IEND' ? [ihdr, idat]
        : kind === 'nonempty-IEND' ? [ihdr, idat, chunk('IEND', Buffer.from([0]))]
        : kind === 'after-IEND' ? [ihdr, idat, endChunk(), ancillary]
        : kind === 'missing-IDAT' ? [ihdr, endChunk()]
        : kind === 'split-IDAT' ? [ihdr, chunk('IDAT', compressed.subarray(0, 2)), ancillary, chunk('IDAT', compressed.subarray(2)), endChunk()]
        : [ancillary, ihdr, idat, endChunk()];
      await expect(resizeAliasedImageResponse(image(Buffer.concat([signature, ...chunks]).toString('base64')),
        { model: alias, prompt: 'test', size: 'auto' }, signal())).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
    });

  it('decodes and preserves a valid Adam7-interlaced PNG while reporting its actual dimensions', async () => {
    const raw = Buffer.from([0,255,0,0,255, 0,0,255,0,255, 0,0,0,255,255,255,255,255,255]);
    const interlaced = Buffer.concat([signature, header(2, 2, 8, 6, 1), chunk('IDAT', deflateSync(raw)), endChunk()]);
    const source = image(interlaced.toString('base64'));
    const result = await resizeAliasedImageResponse(source, { model: alias, prompt: 'test', size: 'auto' }, signal());
    expect(result.size).toBe('2x2');
    expect(result.data).toEqual(source.data);
    expect([...PNG.sync.read(interlaced).data]).toEqual([255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255]);
  });

  it('bounds inflated bytes for Adam7-interlaced PNGs before the decoder allocates them', async () => {
    const bomb = Buffer.concat([signature, header(2, 2, 8, 6, 1), chunk('IDAT', deflateSync(Buffer.alloc(1024 * 1024))), endChunk()]);
    await expect(resizeAliasedImageResponse(image(bomb.toString('base64')), { model: alias, prompt: 'test', size: 'auto' }, signal()))
      .rejects.toMatchObject({ code: 'invalid_response', status: 502 });
  });

  it('does not allow an encoded PNG to escape the original image byte budget', async () => {
    const original = Buffer.from(png(1, 1), 'base64');
    const excess = Buffer.concat([original.subarray(0, -12), chunk('tEXt', Buffer.alloc(13 * 1024 * 1024)), original.subarray(-12)]);
    await expect(resizeAliasedImageResponse(image(excess.toString('base64')), { model: alias, prompt: 'test', size: 'auto' }, signal()))
      .rejects.toMatchObject({ code: 'invalid_response', status: 502 });
  });

  it('leaves native and unknown model bytes and metadata untouched', async () => {
    const source = image('aW1hZ2U=');
    expect(await resizeAliasedImageResponse(source, { model: 'gpt-image-2.5-flare', prompt: 'test', size: '4x4' }, signal())).toBe(source);
  });

  it('returns a genuine default 4K PNG through Session while sending only the native base model', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(image()));
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', fetch });
    const result = await backend.generateImages({ model: 'gpt-image-2.5-sunburst-4k', prompt: 'test' }, context);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ model: 'gpt-image-2.5-sunburst', prompt: 'test', size: '3840x2160' });
    expect(result.size).toBe('3840x2160');
    const bytes = Buffer.from(result.data[0].b64_json, 'base64');
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([3840, 2160]);
    expect(PNG.sync.read(bytes).data.length).toBe(3840 * 2160 * 4);
  }, 15_000);

  it('cancels decode/filter/encode work and releases its slot only after natural worker exit', async () => {
    const caller = new AbortController();
    const pending = resizeAliasedImageResponse(image(png(3, 3)), { model: alias, prompt: 'test' }, caller.signal);
    setTimeout(() => caller.abort(new DOMException('Cancelled', 'AbortError')), 0);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect((await resizeAliasedImageResponse(image(), { model: alias, prompt: 'next', size: '2x2' }, signal())).size).toBe('2x2');
  });

  it('retains the absolute Session deadline after the upstream JSON has finished', async () => {
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', imageRequestTimeoutMs: 100,
      fetch: async () => Response.json(image(png(3, 3))) });
    await expect(backend.generateImages({ model: 'gpt-image-2.5-flare-4k', prompt: 'test' }, context))
      .rejects.toMatchObject({ code: 'timeout', status: 504 });
    expect((await resizeAliasedImageResponse(image(), { model: alias, prompt: 'next', size: '2x2' }, signal())).size).toBe('2x2');
  });

  it('keeps the validated transform target stable if a direct caller mutates its request while upstream is pending', async () => {
    let release!: (value: Response) => void;
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid',
      fetch: async () => new Promise<Response>((resolve) => { release = resolve; }) });
    const request = { model: alias, prompt: 'test', size: '2x2' };
    const pending = backend.generateImages(request, context);
    request.model = 'gpt-image-2'; request.size = '99999x99999';
    release(Response.json(image()));
    expect((await pending).size).toBe('2x2');
  });
});
