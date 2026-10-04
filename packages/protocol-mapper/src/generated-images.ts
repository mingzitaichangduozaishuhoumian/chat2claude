import { isDeepStrictEqual } from 'node:util';
import { ChatGptBackendError, parseImageGenerationCallOutputItem, ResponsesImageBudget, ResponsesImagePartials, type ChatGptCompletionResponse, type ChatGptImageGenerationCallOutputItem, type ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';

const invalid = () => new ChatGptBackendError('Invalid Responses backend output.', 'invalid_response', { status: 502 });
export type ImagePartial = Extract<ChatGptStreamEvent, { type: 'image_partial' }>;

/** Counts unique final images across early snapshots and authoritative output. */
export class NativeImageBudget {
  private readonly images = new Map<string, ChatGptImageGenerationCallOutputItem>();
  private readonly budget = new ResponsesImageBudget();
  add(value: unknown): ChatGptImageGenerationCallOutputItem {
    try {
      const item = parseImageGenerationCallOutputItem(value);
      if (!item) throw invalid();
      const previous = this.images.get(item.id);
      if (previous) {
        if (!isDeepStrictEqual(previous, item)) throw invalid();
        return previous;
      }
      this.budget.add(item);
      this.images.set(item.id, item);
      return item;
    } catch { throw invalid(); }
  }
}

export class NativePreviewBudget {
  private readonly budget = new ResponsesImagePartials();
  add(event: ImagePartial): ImagePartial {
    const metadata = Object.fromEntries(['background', 'output_format', 'quality', 'size'].flatMap((key) => {
      const value = event.metadata?.[key as keyof NonNullable<ImagePartial['metadata']>];
      return value === undefined ? [] : [[key, value]];
    }));
    try {
      return this.budget.accept({ item_id: event.itemId, output_index: event.outputIndex, partial_image_index: event.partialImageIndex, partial_image_b64: event.partialImageB64, ...metadata });
    } catch { throw invalid(); }
  }
}

/** Image payloads have their own budget; other output remains under the text guard. */
export function imageReferences(output: readonly unknown[]): unknown[] {
  return output.map((value) => {
    const item = value as Record<string, unknown> | null;
    return item?.type === 'image_generation_call' ? { type: item.type, id: item.id, status: item.status } : value;
  });
}

export function assertTextResponse(response: Pick<ChatGptCompletionResponse, 'outputItems'>, protocol: 'Claude Messages' | 'Chat Completions'): void {
  if (response.outputItems?.some((item) => item.type === 'image_generation_call')) unsupported(protocol);
}
export function assertTextEvent(event: ChatGptStreamEvent, protocol: 'Claude Messages' | 'Chat Completions'): void {
  if (event.type === 'image_partial' || event.type === 'image_output') unsupported(protocol);
  if (event.type === 'done') assertTextResponse(event, protocol);
}
function unsupported(protocol: string): never {
  throw new ClaudeApiError(`Generated image output is not supported by ${protocol}. Use /v1/images/generations or /v1/responses.`, 501, 'api_error');
}
