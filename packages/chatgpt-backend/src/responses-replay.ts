import { isDeepStrictEqual } from 'node:util';
import type { ChatGptCompletionResponse, ChatGptImageGenerationCallOutputItem, ChatGptImageGenerationCallStatus, ChatGptOutputItem, ChatGptReplayItem } from './client.js';
import { ChatGptBackendError, type ChatGptReplayDebugDiagnostic } from './errors.js';

type JsonObject = Record<string, unknown>;
export interface ResponsesReplayLimits { readonly itemBytes: number; readonly bundleBytes: number; readonly items: number; }
/** UTF-8 JSON wire bytes, including all allowed fields, not just ciphertext. */
export const RESPONSES_REPLAY_LIMITS = Object.freeze({ itemBytes: 256 * 1024, bundleBytes: 1024 * 1024, items: 128 });
/** Explicit input history can span many turns; provider output/cache budgets stay separate. */
export const RESPONSES_INPUT_REPLAY_LIMITS = Object.freeze({ itemBytes: 8 * 1024 * 1024, bundleBytes: 8 * 1024 * 1024, items: 4096 });

/** Validate a provider image lifecycle without retaining any provider payload. */
export function validateImageGenerationCallLifecycle(value: unknown): ChatGptImageGenerationCallStatus | undefined {
  if (!object(value) || value.type !== 'image_generation_call') return undefined;
  fields(value, ['type', 'id', 'status', 'result', 'image_url', 'url', 'b64_json', 'image_base64', 'mime_type', 'revised_prompt']);
  if (!nonempty(value.id) || !isImageStatus(value.status)) throw invalidReplay();
  if (value.mime_type !== undefined && typeof value.mime_type !== 'string' || value.revised_prompt !== undefined && typeof value.revised_prompt !== 'string') throw invalidReplay();
  for (const field of ['result', 'image_url', 'url', 'b64_json', 'image_base64']) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') throw invalidReplay();
  }
  if (value.status === 'completed' && !imageResult(value)) throw invalidReplay();
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > RESPONSES_REPLAY_LIMITS.itemBytes) throw invalidReplay();
  return value.status;
}

/** Validate, detach, and expose only an authoritative completed generated-image result. */
export function parseImageGenerationCallOutputItem(value: unknown): ChatGptImageGenerationCallOutputItem | undefined {
  const status = validateImageGenerationCallLifecycle(value);
  if (status === undefined) return undefined;
  if (status !== 'completed') throw invalidReplay();
  const image = value as JsonObject;
  const result = imageResult(image);
  if (!result) throw invalidReplay();
  const item: ChatGptImageGenerationCallOutputItem = {
    type: 'image_generation_call', id: image.id as string, status: 'completed', result,
    ...(typeof image.mime_type === 'string' ? { mime_type: image.mime_type } : {}),
    ...(typeof image.revised_prompt === 'string' ? { revised_prompt: image.revised_prompt } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(item), 'utf8') > RESPONSES_REPLAY_LIMITS.itemBytes) throw invalidReplay();
  return item;
}

function isImageStatus(value: unknown): value is ChatGptImageGenerationCallStatus {
  return value === 'in_progress' || value === 'generating' || value === 'completed' || value === 'failed';
}

function imageResult(value: JsonObject): string | undefined {
  for (const candidate of [value.result, value.image_url, value.url, value.b64_json, value.image_base64]) {
    if (nonempty(candidate)) return candidate;
  }
  return undefined;
}

function invalidReplay(mismatchReason: ChatGptReplayDebugDiagnostic['mismatchReason'] = 'validation_failure'): ChatGptBackendError {
  // Do not interpolate provider values or retain a cause (including parser errors).
  return new ChatGptBackendError('ChatGPT session backend replay response was invalid.', 'invalid_response', {
    status: 502,
    safeDiagnostic: { httpStatus: 200, failurePhase: 'response_protocol', protocolStage: 'replay_snapshot', protocolReason: 'replay_snapshot' },
    replayDebugDiagnostic: { eventType: 'other', topLevelFields: [], itemType: 'missing', itemStatus: 'missing', outputIndex: 'missing', mismatchReason },
  });
}

function object(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).every((key) => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function fields(value: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalidReplay();
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function textParts(value: unknown, type: 'summary_text' | 'reasoning_text', limits: ResponsesReplayLimits): boolean {
  return Array.isArray(value) && value.length <= limits.items && value.every((part) => {
    if (!object(part)) return false;
    fields(part, ['type', 'text']);
    return part.type === type && typeof part.text === 'string';
  });
}

/** Validate and detach a restricted wire object. Missing/null ciphertext is not replayable. */
export function parseResponsesReplayItem(value: unknown, limits: ResponsesReplayLimits = RESPONSES_REPLAY_LIMITS): ChatGptReplayItem | undefined {
  if (!object(value)) throw invalidReplay();
  if (value.type !== 'reasoning' && value.type !== 'function_call') return undefined;
  if (value.type === 'reasoning' && (value.encrypted_content === undefined || value.encrypted_content === null)) return undefined;
  if (value.status !== undefined && (typeof value.status !== 'string' || !['in_progress', 'completed', 'incomplete'].includes(value.status))) throw invalidReplay();
  if (value.type === 'reasoning') {
    fields(value, ['type', 'id', 'summary', 'content', 'status', 'encrypted_content']);
    if (!nonempty(value.id) || !nonempty(value.encrypted_content) || !textParts(value.summary, 'summary_text', limits)
      || value.content !== undefined && !textParts(value.content, 'reasoning_text', limits)) throw invalidReplay();
  } else {
    fields(value, ['type', 'id', 'call_id', 'name', 'arguments', 'status', 'async', 'caller', 'namespace']);
    if (value.id !== undefined && !nonempty(value.id) || !nonempty(value.call_id) || !nonempty(value.name)
      || typeof value.arguments !== 'string' || value.async !== undefined && typeof value.async !== 'boolean'
      || value.namespace !== undefined && typeof value.namespace !== 'string') throw invalidReplay();
    if (value.caller !== undefined && value.caller !== null) {
      if (!object(value.caller)) throw invalidReplay();
      fields(value.caller, value.caller.type === 'direct' ? ['type'] : ['type', 'caller_id']);
      if (value.caller.type !== 'direct' && (value.caller.type !== 'program' || !nonempty(value.caller.caller_id))) throw invalidReplay();
    }
  }
  const wire = JSON.stringify(value);
  if (Buffer.byteLength(wire, 'utf8') > limits.itemBytes) throw invalidReplay();
  return JSON.parse(wire) as ChatGptReplayItem;
}

/** Separate budgets bound pending done snapshots and the authoritative completed bundle. */
export class ResponsesReplayBudget {
  private bytes = 2; // JSON array brackets
  private count = 0;
  constructor(private readonly limits: ResponsesReplayLimits = RESPONSES_REPLAY_LIMITS) {}
  add(item: ChatGptReplayItem | ChatGptImageGenerationCallOutputItem): void {
    this.bytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + (this.count ? 1 : 0);
    if (++this.count > this.limits.items || this.bytes > this.limits.bundleBytes) throw invalidReplay();
  }
}

interface Snapshot { item: ChatGptReplayItem; index?: number; }
interface ImageSnapshot { item: ChatGptImageGenerationCallOutputItem; index?: number; }
interface ImageLifecycleSnapshot {
  id: string;
  status: ChatGptImageGenerationCallStatus;
  result?: string;
  mime_type?: string;
  revised_prompt?: string;
}
class ReplaySnapshots {
  readonly entries: Snapshot[] = [];
  private readonly byId = new Map<string, Snapshot>();
  private readonly byCall = new Map<string, Snapshot>();
  private readonly byIndex = new Map<number, Snapshot>();
  private readonly budget = new ResponsesReplayBudget();

  add(item: ChatGptReplayItem, index?: number): void {
    const previous = this.lookup(item, index);
    if (previous) {
      if (!isDeepStrictEqual(previous.item, item)) throw invalidReplay('output_snapshot_conflict');
      if (previous.index !== undefined && index !== undefined && previous.index !== index) throw invalidReplay('output_index_mismatch');
      if (index !== undefined) { previous.index = index; this.byIndex.set(index, previous); }
      return;
    }
    this.budget.add(item);
    const entry = { item, index };
    this.entries.push(entry);
    if (item.id !== undefined) this.byId.set(item.id, entry);
    if (item.type === 'function_call') this.byCall.set(item.call_id, entry);
    if (index !== undefined) this.byIndex.set(index, entry);
  }

  lookup(item: ChatGptReplayItem, index?: number): Snapshot | undefined {
    const matches = new Set([
      item.id === undefined ? undefined : this.byId.get(item.id),
      item.type === 'function_call' ? this.byCall.get(item.call_id) : undefined,
      index === undefined ? undefined : this.byIndex.get(index),
    ].filter((entry): entry is Snapshot => entry !== undefined));
    if (matches.size > 1) throw invalidReplay('duplicate_identity_conflict');
    return matches.values().next().value;
  }
}

class ImageSnapshots {
  readonly entries: ImageSnapshot[] = [];
  private readonly byId = new Map<string, ImageSnapshot>();
  private readonly byIndex = new Map<number, ImageSnapshot>();
  private readonly budget = new ResponsesReplayBudget();

  add(item: ChatGptImageGenerationCallOutputItem, index?: number, allowDuplicate = true): void {
    const previous = this.lookup(item, index);
    if (previous) {
      if (!allowDuplicate) throw invalidReplay('duplicate_identity_conflict');
      if (!isDeepStrictEqual(previous.item, item)) throw invalidReplay('output_snapshot_conflict');
      if (previous.index !== undefined && index !== undefined && previous.index !== index) throw invalidReplay('output_index_mismatch');
      if (index !== undefined) { previous.index = index; this.byIndex.set(index, previous); }
      return;
    }
    this.budget.add(item);
    const entry = { item, index };
    this.entries.push(entry);
    this.byId.set(item.id, entry);
    if (index !== undefined) this.byIndex.set(index, entry);
  }

  lookup(item: ChatGptImageGenerationCallOutputItem, index?: number): ImageSnapshot | undefined {
    const matches = new Set([this.byId.get(item.id), index === undefined ? undefined : this.byIndex.get(index)]
      .filter((entry): entry is ImageSnapshot => entry !== undefined));
    if (matches.size > 1) throw invalidReplay('duplicate_identity_conflict');
    return matches.values().next().value;
  }
}

class ImageLifecycleSnapshots {
  private readonly byId = new Map<string, ImageLifecycleSnapshot>();

  add(value: JsonObject, status: ChatGptImageGenerationCallStatus): boolean {
    const result = imageResult(value);
    const item: ImageLifecycleSnapshot = {
      id: value.id as string,
      status,
      ...(result === undefined ? {} : { result }),
      ...(typeof value.mime_type === 'string' ? { mime_type: value.mime_type } : {}),
      ...(typeof value.revised_prompt === 'string' ? { revised_prompt: value.revised_prompt } : {}),
    };
    const previous = this.byId.get(item.id);
    if (previous) {
      if (!isDeepStrictEqual(previous, item)) throw invalidReplay('output_snapshot_conflict');
      return false;
    }
    this.byId.set(item.id, item);
    return true;
  }
}

/** Done is corroboration only. Only a successful completed.output can commit replay.
 * No fallback from added/deltas/done/[DONE]/EOF: older streams keep their tool behavior
 * but cannot accidentally create an incomplete replay bundle.
 */
export class ResponsesReplay {
  private readonly done = new ReplaySnapshots();
  private readonly images = new ImageSnapshots();

  accept(type: unknown, frame: JsonObject): Pick<ChatGptCompletionResponse, 'replayItems' | 'replayEligible' | 'outputItems'> | undefined {
    try {
      if (type === 'response.output_item.done') {
      const item = frame.item;
      if (!object(item)) return undefined;
      const index = frame.output_index;
      if (index !== undefined && (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)) throw invalidReplay();
      if (item.type === 'image_generation_call') {
        const status = validateImageGenerationCallLifecycle(item);
        if (status === 'completed') this.images.add(parseImageGenerationCallOutputItem(item)!, index as number | undefined);
        return undefined;
      }
      if (item.type !== 'reasoning' && item.type !== 'function_call') return undefined;
      // Legacy partial tool snapshots still belong to ResponsesToolCalls, not replay.
      if (item.type === 'function_call' && item.arguments === undefined) return undefined;
      const replay = parseResponsesReplayItem(item);
      if (!replay) return undefined;
      this.done.add(replay, index as number | undefined);
      return undefined;
    }
    if (type !== 'response.completed' || !object(frame.response)) return undefined;
    const response = frame.response;
    if (response.status !== undefined && response.status !== 'completed') return undefined;
    if (response.output === undefined) {
      // Tool snapshots retain legacy ResponsesToolCalls finalization without a final output.
      // A completed image requires an authoritative final output before it can be emitted.
      if (this.images.entries.length) throw invalidReplay('done_snapshot_missing');
      return undefined;
    }
    if (!Array.isArray(response.output)) throw invalidReplay();
    const output = new ReplaySnapshots();
    const imageOutput = new ImageSnapshots();
    const imageLifecycles = new ImageLifecycleSnapshots();
    const budget = new ResponsesReplayBudget();
    const ordered: ChatGptReplayItem[] = [];
    const projection: ChatGptOutputItem[] = [];
    if (response.output.length > RESPONSES_REPLAY_LIMITS.items) throw invalidReplay();
    for (const [index, raw] of response.output.entries()) {
      if (object(raw) && raw.type === 'message') {
        if (!Array.isArray(raw.content) || raw.content.length > RESPONSES_REPLAY_LIMITS.items) throw invalidReplay();
        const content: Extract<ChatGptOutputItem, { type: 'message' }>['content'] = [];
        for (const part of raw.content) {
          if (!object(part)) throw invalidReplay();
          if (part.type === 'output_text') {
            if (typeof part.text !== 'string') throw invalidReplay();
            content.push({ type: 'output_text', text: part.text, annotations: [] });
          } else if (part.type === 'refusal') {
            if (typeof part.refusal !== 'string') throw invalidReplay();
            content.push({ type: 'refusal', refusal: part.refusal });
          }
        }
        projection.push({ type: 'message', role: 'assistant', ...(typeof raw.id === 'string' ? { id: raw.id } : {}), status: 'completed', content });
      }
      const imageStatus = validateImageGenerationCallLifecycle(raw);
      if (imageStatus !== undefined) {
        const imageLifecycle = raw as JsonObject;
        const isFirstLifecycle = imageLifecycles.add(imageLifecycle, imageStatus);
        if (!isFirstLifecycle) {
          if (imageStatus === 'completed') throw invalidReplay('duplicate_identity_conflict');
          continue;
        }
        if (imageStatus !== 'completed') continue;
        const image = parseImageGenerationCallOutputItem(raw)!;
        imageOutput.add(image, index, false);
        projection.push(image);
        continue;
      }
      const item = parseResponsesReplayItem(raw);
      if (!item) continue;
      budget.add(item);
      const previous = output.lookup(item);
      if (previous) {
        if (!isDeepStrictEqual(previous.item, item)) throw invalidReplay('output_snapshot_conflict');
      } else {
        output.add(item, index);
        ordered.push(item);
        projection.push(item);
      }
    }
    // A completed output with no replayable items cannot commit replay snapshots.
    if (ordered.length) for (const snapshot of this.done.entries) {
      const final = output.lookup(snapshot.item, snapshot.index);
      if (!final) throw invalidReplay('done_snapshot_missing');
      if (!isDeepStrictEqual(final.item, snapshot.item)) throw invalidReplay('done_snapshot_mismatch');
      if (snapshot.index !== undefined && snapshot.index !== final.index) throw invalidReplay('output_index_mismatch');
    }
    // Completed image done snapshots require the same authoritative final item.
    if (this.images.entries.length) for (const snapshot of this.images.entries) {
      const final = imageOutput.lookup(snapshot.item, snapshot.index);
      if (!final) throw invalidReplay('done_snapshot_missing');
      if (!isDeepStrictEqual(final.item, snapshot.item)) throw invalidReplay('done_snapshot_mismatch');
      if (snapshot.index !== undefined && snapshot.index !== final.index) throw invalidReplay('output_index_mismatch');
    }
    if (Buffer.byteLength(JSON.stringify(projection), 'utf8') > 4 * 1024 * 1024) throw invalidReplay();
    const hasOutputItems = projection.length > 0;
      return ordered.length || hasOutputItems ? {
        ...(ordered.length ? { replayItems: ordered, replayEligible: ordered.length === response.output.length && ordered.some((item) => item.type === 'function_call') } : {}),
        ...(hasOutputItems ? { outputItems: projection } : {}),
      } : undefined;
    } catch (error) {
      if (!(error instanceof ChatGptBackendError) || error.safeDiagnostic?.protocolStage !== 'replay_snapshot') throw error;
      throw new ChatGptBackendError(error.message, error.code, {
        status: error.status,
        safeDiagnostic: error.safeDiagnostic,
        replayDebugDiagnostic: { ...replayDebugDiagnostic(type, frame), ...(error.replayDebugDiagnostic?.mismatchReason ? { mismatchReason: error.replayDebugDiagnostic.mismatchReason } : {}) },
      });
    }
  }
}

function replayDebugDiagnostic(type: unknown, frame: JsonObject): ChatGptReplayDebugDiagnostic {
  const item = object(frame.item) ? frame.item : undefined;
  const caller = object(item?.caller) ? item.caller : undefined;
  const output = object(frame.response) && Array.isArray(frame.response.output) ? frame.response.output : undefined;
  return {
    eventType: type === 'response.output_item.done' || type === 'response.completed' ? type : 'other',
    topLevelFields: Object.keys(frame),
    itemType: item?.type === 'reasoning' || item?.type === 'function_call' || item?.type === 'message' ? item.type : item ? 'other' : 'missing',
    itemStatus: item?.status === 'in_progress' || item?.status === 'completed' || item?.status === 'incomplete' ? item.status : item?.status === undefined ? 'missing' : 'other',
    ...(caller ? { callerFields: Object.keys(caller), callerType: caller.type === 'direct' || caller.type === 'program' ? caller.type : caller.type === undefined ? 'missing' : 'other' } : {}),
    outputIndex: frame.output_index === undefined ? 'missing' : typeof frame.output_index === 'number' && Number.isSafeInteger(frame.output_index) && frame.output_index >= 0 ? 'valid' : 'invalid',
    ...(output ? { responseOutputCount: output.length } : {}),
    mismatchReason: 'validation_failure',
  };
}
