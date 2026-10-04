import type { ChatGptImageGenerationMetadata } from './client.js';
import type { ChatGptImagePartialEvent } from './events.js';
import { ChatGptBackendError } from './errors.js';

export const RESPONSES_IMAGE_LIMITS = Object.freeze({ itemBytes: 16 * 1024 * 1024, bundleBytes: 64 * 1024 * 1024, items: 10 });
export const RESPONSES_IMAGE_PREVIEW_LIMITS = Object.freeze({ perImage: 3, events: 30, bytes: 64 * 1024 * 1024 });

export function invalidImageOutput(): ChatGptBackendError {
  return new ChatGptBackendError('ChatGPT image output was invalid.', 'invalid_response', { status: 502,
    safeDiagnostic: { failurePhase: 'response_protocol', protocolStage: 'replay_snapshot', protocolReason: 'replay_snapshot' } });
}

/** Independent image budget; never enlarges opaque reasoning/tool replay budgets. */
export class ResponsesImageBudget {
  private bytes = 2;
  private count = 0;
  add(item: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    this.bytes += bytes + (this.count ? 1 : 0);
    if (bytes > RESPONSES_IMAGE_LIMITS.itemBytes || ++this.count > RESPONSES_IMAGE_LIMITS.items || this.bytes > RESPONSES_IMAGE_LIMITS.bundleBytes) throw invalidImageOutput();
  }
}

export function imageMetadata(value: Record<string, unknown>): ChatGptImageGenerationMetadata {
  const metadata: ChatGptImageGenerationMetadata = {};
  const enums = { action: ['generate', 'edit', 'auto'], background: ['transparent', 'opaque', 'auto'], output_format: ['png', 'webp', 'jpeg'], quality: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] } as const;
  for (const key of Object.keys(enums) as Array<keyof typeof enums>) {
    const candidate = value[key];
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate !== 'string' || !(enums[key] as readonly string[]).includes(candidate)) throw invalidImageOutput();
    Object.assign(metadata, { [key]: candidate });
  }
  for (const key of ['size', 'mime_type', 'revised_prompt'] as const) {
    const candidate = value[key];
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate !== 'string') throw invalidImageOutput();
    if (key === 'size' && !/^(?:auto|[1-9][0-9]{0,4}x[1-9][0-9]{0,4})$/.test(candidate)) throw invalidImageOutput();
    metadata[key] = candidate;
  }
  return metadata;
}

export function isImageBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= RESPONSES_IMAGE_LIMITS.itemBytes
    && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value;
}

export class ResponsesImagePartials {
  private readonly images = new Map<string, { index: number; last: number }>();
  private readonly indices = new Map<number, string>();
  private bytes = 0;
  private count = 0;

  accept(frame: Record<string, unknown>): ChatGptImagePartialEvent {
    const { item_id: itemId, output_index: outputIndex, partial_image_index: partialImageIndex, partial_image_b64: partialImageB64 } = frame;
    if (typeof itemId !== 'string' || !itemId || !Number.isSafeInteger(outputIndex) || (outputIndex as number) < 0
      || !Number.isInteger(partialImageIndex) || (partialImageIndex as number) < 0 || (partialImageIndex as number) >= RESPONSES_IMAGE_PREVIEW_LIMITS.perImage
      || !isImageBase64(partialImageB64)) throw invalidImageOutput();
    const previous = this.images.get(itemId);
    if (previous && (previous.index !== outputIndex || (partialImageIndex as number) <= previous.last)
      || this.indices.has(outputIndex as number) && this.indices.get(outputIndex as number) !== itemId) throw invalidImageOutput();
    const { background, output_format, quality, size } = imageMetadata(frame);
    const metadata = { ...(background ? { background } : {}), ...(output_format ? { output_format } : {}), ...(quality ? { quality } : {}), ...(size ? { size } : {}) };
    const event: ChatGptImagePartialEvent = { type: 'image_partial', itemId, outputIndex: outputIndex as number, partialImageIndex: partialImageIndex as number, partialImageB64,
      ...(Object.keys(metadata).length ? { metadata } : {}) };
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    this.bytes += bytes;
    if (bytes > RESPONSES_IMAGE_LIMITS.itemBytes || this.bytes > RESPONSES_IMAGE_PREVIEW_LIMITS.bytes || ++this.count > RESPONSES_IMAGE_PREVIEW_LIMITS.events
      || !previous && this.images.size >= RESPONSES_IMAGE_LIMITS.items) throw invalidImageOutput();
    this.images.set(itemId, { index: outputIndex as number, last: partialImageIndex as number });
    this.indices.set(outputIndex as number, itemId);
    return event;
  }

  finish(output: unknown): void {
    if (!this.images.size) return;
    if (!Array.isArray(output)) throw invalidImageOutput();
    for (const [id, state] of this.images) {
      const item = output[state.index];
      if (!item || typeof item !== 'object' || item.type !== 'image_generation_call' || item.id !== id || item.status !== 'completed') throw invalidImageOutput();
    }
  }
}
