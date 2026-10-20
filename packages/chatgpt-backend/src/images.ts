import type { ChatGptImageGenerationRequest, ChatGptImageGenerationResponse, ChatGptUsage } from './client.js';
import { ChatGptBackendError } from './errors.js';
import { imageMetadata, invalidImageOutput, isImageBase64, ResponsesImageBudget, RESPONSES_IMAGE_LIMITS } from './image-output.js';

export const DEFAULT_CODEX_IMAGE_MODEL = 'gpt-image-2';
/** Native Codex Images endpoint IDs; availability is account-dependent. */
export const CODEX_IMAGE_BASE_MODEL_IDS = Object.freeze(['gpt-image-1.5', 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5'] as const);
/** Explicit local aliases, following codex2api's resolution presets. These are
 * not native upstream model IDs and never enter the text alias registry. */
export const CODEX_IMAGE_RESOLUTION_ALIASES: Readonly<Record<string, Readonly<{ model: string; size: string }>>> = Object.freeze({
  'gpt-image-2.5-flare-2k': Object.freeze({ model: 'gpt-image-2.5-flare', size: '2048x2048' }),
  'gpt-image-2.5-flare-4k': Object.freeze({ model: 'gpt-image-2.5-flare', size: '3840x2160' }),
  'gpt-image-2.5-sunburst-2k': Object.freeze({ model: 'gpt-image-2.5-sunburst', size: '2048x2048' }),
  'gpt-image-2.5-sunburst-4k': Object.freeze({ model: 'gpt-image-2.5-sunburst', size: '3840x2160' }),
});
export const CODEX_IMAGE_MODEL_IDS = Object.freeze([...CODEX_IMAGE_BASE_MODEL_IDS, ...Object.keys(CODEX_IMAGE_RESOLUTION_ALIASES)]);
export const DEFAULT_IMAGE_REQUEST_TIMEOUT_MS = 300_000;

const extendedQualityModels = new Set([
  'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-sunburst-2026-09-08',
]);
export function isSupportedImageQuality(model: string, quality: unknown): quality is NonNullable<ChatGptImageGenerationRequest['quality']> {
  return typeof quality === 'string' && (['low', 'medium', 'high', 'auto'].includes(quality)
    || extendedQualityModels.has(imageResolutionAlias(model)?.model ?? model) && (quality === 'xhigh' || quality === 'max'));
}

export function imageResolutionAlias(model: string): Readonly<{ model: string; size: string }> | undefined {
  return Object.hasOwn(CODEX_IMAGE_RESOLUTION_ALIASES, model) ? CODEX_IMAGE_RESOLUTION_ALIASES[model] : undefined;
}

export function isSupportedImageSize(model: string, size: unknown): size is string {
  if (typeof size !== 'string' || !/^(?:auto|[1-9][0-9]{0,4}x[1-9][0-9]{0,4})$/.test(size)) return false;
  if (size === 'auto' || !imageResolutionAlias(model)) return true;
  const [width, height] = size.split('x').map(Number);
  return width <= 3840 && height <= 3840 && width * height <= 8_294_400;
}

export function imageGenerationBody(request: ChatGptImageGenerationRequest): Record<string, unknown> {
  const fail = () => { throw new ChatGptBackendError('Invalid image generation request.', 'invalid_request', { status: 400 }); };
  if (!request || typeof request.prompt !== 'string' || !request.prompt.trim()) fail();
  const model = request.model ?? DEFAULT_CODEX_IMAGE_MODEL;
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(model)) fail();
  if (request.n !== undefined && (!Number.isSafeInteger(request.n) || request.n < 1 || request.n > RESPONSES_IMAGE_LIMITS.items)) fail();
  if (request.background !== undefined && !['transparent', 'opaque', 'auto'].includes(request.background)) fail();
  if (request.quality !== undefined && !isSupportedImageQuality(model, request.quality)) fail();
  if (request.size !== undefined && !isSupportedImageSize(model, request.size)) fail();
  const alias = imageResolutionAlias(model);
  const size = request.size ?? alias?.size;
  return { prompt: request.prompt, model: alias?.model ?? model,
    ...(request.background === undefined ? {} : { background: request.background }),
    ...(request.n === undefined ? {} : { n: request.n }),
    ...(request.quality === undefined ? {} : { quality: request.quality }),
    ...(size === undefined ? {} : { size }) };
}

export function parseImageGenerationResponse(value: unknown): ChatGptImageGenerationResponse {
  if (!object(value) || !Number.isSafeInteger(value.created) || (value.created as number) < 0 || !Array.isArray(value.data)
    || !value.data.length || value.data.length > RESPONSES_IMAGE_LIMITS.items) throw invalidImageOutput();
  const budget = new ResponsesImageBudget();
  const data = value.data.map((raw) => {
    if (!object(raw) || !isImageBase64(raw.b64_json)
      || raw.generation_id !== undefined && raw.generation_id !== null && (typeof raw.generation_id !== 'string' || !raw.generation_id)) throw invalidImageOutput();
    const item = { b64_json: raw.b64_json, ...(typeof raw.generation_id === 'string' ? { generation_id: raw.generation_id } : {}) };
    budget.add(item);
    return item;
  });
  const { background, quality, size, output_format } = imageMetadata(value);
  const usage: ChatGptUsage = {};
  if (object(value.usage)) for (const [key, wire] of [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'], ['totalTokens', 'total_tokens']] as const) {
    const count = value.usage[wire];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) usage[key] = count;
  }
  return { created: value.created as number, data,
    ...(background ? { background } : {}), ...(quality ? { quality } : {}), ...(size ? { size } : {}), ...(output_format ? { output_format } : {}),
    ...(Object.keys(usage).length ? { usage } : {}) };
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
