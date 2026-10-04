import type { ChatGptImageGenerationRequest, ChatGptImageGenerationResponse, ChatGptUsage } from './client.js';
import { ChatGptBackendError } from './errors.js';
import { imageMetadata, invalidImageOutput, isImageBase64, ResponsesImageBudget, RESPONSES_IMAGE_LIMITS } from './image-output.js';

export const DEFAULT_CODEX_IMAGE_MODEL = 'gpt-image-2';
export const DEFAULT_IMAGE_REQUEST_TIMEOUT_MS = 300_000;

export function imageGenerationBody(request: ChatGptImageGenerationRequest): Record<string, unknown> {
  const fail = () => { throw new ChatGptBackendError('Invalid image generation request.', 'invalid_request', { status: 400 }); };
  if (!request || typeof request.prompt !== 'string' || !request.prompt.trim()) fail();
  const model = request.model ?? DEFAULT_CODEX_IMAGE_MODEL;
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(model)) fail();
  if (request.n !== undefined && (!Number.isSafeInteger(request.n) || request.n < 1 || request.n > RESPONSES_IMAGE_LIMITS.items)) fail();
  if (request.background !== undefined && !['transparent', 'opaque', 'auto'].includes(request.background)) fail();
  if (request.quality !== undefined && !['low', 'medium', 'high', 'auto'].includes(request.quality)) fail();
  if (request.size !== undefined && (typeof request.size !== 'string' || !/^(?:auto|[1-9][0-9]{0,4}x[1-9][0-9]{0,4})$/.test(request.size))) fail();
  return { prompt: request.prompt, model,
    ...(request.background === undefined ? {} : { background: request.background }),
    ...(request.n === undefined ? {} : { n: request.n }),
    ...(request.quality === undefined ? {} : { quality: request.quality }),
    ...(request.size === undefined ? {} : { size: request.size }) };
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
  if (quality === 'xhigh' || quality === 'max') throw invalidImageOutput();
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
