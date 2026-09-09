import { isDeepStrictEqual } from 'node:util';
import type { ChatGptCompletionResponse, ChatGptOutputItem, ChatGptReplayItem } from './client.js';
import { ChatGptBackendError, type ChatGptReplayDebugDiagnostic } from './errors.js';

type JsonObject = Record<string, unknown>;
/** UTF-8 JSON wire bytes, including all allowed fields, not just ciphertext. */
export const RESPONSES_REPLAY_LIMITS = Object.freeze({ itemBytes: 256 * 1024, bundleBytes: 1024 * 1024, items: 128 });

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
function textParts(value: unknown, type: 'summary_text' | 'reasoning_text'): boolean {
  return Array.isArray(value) && value.length <= RESPONSES_REPLAY_LIMITS.items && value.every((part) => {
    if (!object(part)) return false;
    fields(part, ['type', 'text']);
    return part.type === type && typeof part.text === 'string';
  });
}

/** Validate and detach a restricted wire object. Missing/null ciphertext is not replayable. */
export function parseResponsesReplayItem(value: unknown): ChatGptReplayItem | undefined {
  if (!object(value)) throw invalidReplay();
  if (value.type !== 'reasoning' && value.type !== 'function_call') return undefined;
  if (value.type === 'reasoning' && (value.encrypted_content === undefined || value.encrypted_content === null)) return undefined;
  if (value.status !== undefined && (typeof value.status !== 'string' || !['in_progress', 'completed', 'incomplete'].includes(value.status))) throw invalidReplay();
  if (value.type === 'reasoning') {
    fields(value, ['type', 'id', 'summary', 'content', 'status', 'encrypted_content']);
    if (!nonempty(value.id) || !nonempty(value.encrypted_content) || !textParts(value.summary, 'summary_text')
      || value.content !== undefined && !textParts(value.content, 'reasoning_text')) throw invalidReplay();
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
  if (Buffer.byteLength(wire, 'utf8') > RESPONSES_REPLAY_LIMITS.itemBytes) throw invalidReplay();
  return JSON.parse(wire) as ChatGptReplayItem;
}

/** Separate budgets bound pending done snapshots and the authoritative completed bundle. */
export class ResponsesReplayBudget {
  private bytes = 2; // JSON array brackets
  private count = 0;
  add(item: ChatGptReplayItem): void {
    this.bytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + (this.count ? 1 : 0);
    if (++this.count > RESPONSES_REPLAY_LIMITS.items || this.bytes > RESPONSES_REPLAY_LIMITS.bundleBytes) throw invalidReplay();
  }
}

interface Snapshot { item: ChatGptReplayItem; index?: number; }
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

/** Done is corroboration only. Only a successful completed.output can commit replay.
 * No fallback from added/deltas/done/[DONE]/EOF: older streams keep their tool behavior
 * but cannot accidentally create an incomplete replay bundle.
 */
export class ResponsesReplay {
  private readonly done = new ReplaySnapshots();

  accept(type: unknown, frame: JsonObject): Pick<ChatGptCompletionResponse, 'replayItems' | 'replayEligible' | 'outputItems'> | undefined {
    try {
      if (type === 'response.output_item.done') {
      const item = frame.item;
      if (!object(item) || item.type !== 'reasoning' && item.type !== 'function_call') return undefined;
      // Legacy partial tool snapshots still belong to ResponsesToolCalls, not replay.
      if (item.type === 'function_call' && item.arguments === undefined) return undefined;
      const replay = parseResponsesReplayItem(item);
      if (!replay) return undefined;
      const index = frame.output_index;
      if (index !== undefined && (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)) throw invalidReplay();
      this.done.add(replay, index as number | undefined);
      return undefined;
    }
    if (type !== 'response.completed' || !object(frame.response)) return undefined;
    const response = frame.response;
    if (response.status !== undefined && response.status !== 'completed') return undefined;
    if (response.output === undefined) return undefined;
    if (!Array.isArray(response.output)) throw invalidReplay();
    const output = new ReplaySnapshots();
    const budget = new ResponsesReplayBudget();
    const ordered: ChatGptReplayItem[] = [];
    const projection: ChatGptOutputItem[] = [];
    if (response.output.length > RESPONSES_REPLAY_LIMITS.items) throw invalidReplay();
    for (const [index, raw] of response.output.entries()) {
      if (object(raw) && raw.type === 'message') {
        if (!Array.isArray(raw.content) || raw.content.length > RESPONSES_REPLAY_LIMITS.items) throw invalidReplay();
        const content: Array<{ type: 'output_text'; text: string; annotations: [] }> = [];
        for (const part of raw.content) {
          if (!object(part)) throw invalidReplay();
          if (part.type === 'output_text') {
            if (typeof part.text !== 'string') throw invalidReplay();
            content.push({ type: 'output_text', text: part.text, annotations: [] });
          }
        }
        projection.push({ type: 'message', role: 'assistant', ...(typeof raw.id === 'string' ? { id: raw.id } : {}), status: 'completed', content });
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
    // A completed output with no replayable items cannot commit done snapshots.
    if (ordered.length) for (const snapshot of this.done.entries) {
      const final = output.lookup(snapshot.item, snapshot.index);
      if (!final) throw invalidReplay('done_snapshot_missing');
      if (!isDeepStrictEqual(final.item, snapshot.item)) throw invalidReplay('done_snapshot_mismatch');
      if (snapshot.index !== undefined && snapshot.index !== final.index) throw invalidReplay('output_index_mismatch');
    }
    if (Buffer.byteLength(JSON.stringify(projection), 'utf8') > 4 * 1024 * 1024) throw invalidReplay();
    const hasMessages = projection.some((item) => item.type === 'message');
      return ordered.length || hasMessages ? {
        ...(ordered.length ? { replayItems: ordered, replayEligible: ordered.length === response.output.length && ordered.some((item) => item.type === 'function_call') } : {}),
        ...(hasMessages ? { outputItems: projection } : {}),
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
