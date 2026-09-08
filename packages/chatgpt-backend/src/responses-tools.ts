import type { ChatGptToolCall } from './client.js';
import { ChatGptBackendError } from './errors.js';

type JsonObject = Record<string, unknown>;
interface PendingCall { itemId?: string; index?: number; callId?: string; name?: string; delta: string; addedArguments?: string; arguments?: string; emitted?: boolean; }

/** One Responses stream owns one accumulator; item IDs are never public call IDs. */
export class ResponsesToolCalls {
  private readonly byItem = new Map<string, PendingCall>();
  private readonly byIndex = new Map<number, PendingCall>();
  private readonly byCall = new Map<string, PendingCall>();
  private readonly pending = new Set<PendingCall>();
  private readonly emitted = new Map<string, ChatGptToolCall>();

  constructor(private readonly httpStatus: number) {}

  accept(type: unknown, frame: JsonObject): ChatGptToolCall[] {
    if (type === 'response.completed') {
      const response = object(frame.response);
      if (Array.isArray(response?.output)) for (const [output_index, item] of response.output.entries()) {
        if (object(item)?.type === 'function_call') this.update({ output_index, item }, true);
      }
      return this.finish();
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = object(frame.item);
      // Only a complete, untyped done shape is compatible; explicit unrelated types stay excluded.
      const simplifiedDone = type === 'response.output_item.done' && item?.type === undefined
        && string(item?.id) && string(item?.call_id) && string(item?.name) && typeof item?.arguments === 'string';
      if (item?.type !== 'function_call' && !simplifiedDone) return [];
      const call = this.update(frame, type === 'response.output_item.done');
      // Added snapshots are fallback values, not a finalization barrier for later deltas.
      if (type === 'response.output_item.added' && string(item?.arguments)) this.setArguments(call, item?.arguments, true);
      return type === 'response.output_item.done' ? this.emit(call) : [];
    }
    if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
      const call = this.update(frame, false);
      if (type === 'response.function_call_arguments.delta') {
        if (call.emitted || call.arguments !== undefined || typeof frame.delta !== 'string') throw this.invalid();
        call.delta += frame.delta;
      } else {
        this.setArguments(call, frame.arguments);
      }
    }
    return [];
  }

  compatibility(call: ChatGptToolCall): ChatGptToolCall[] {
    const previous = this.emitted.get(call.id);
    if (previous) {
      if (previous.name !== call.name || stable(previous.input) !== stable(call.input)) throw this.invalid();
      return [];
    }
    this.emitted.set(call.id, call);
    return [call];
  }

  finish(): ChatGptToolCall[] {
    return [...this.pending].flatMap((call) => this.emit(call));
  }

  private update(frame: JsonObject, complete: boolean): PendingCall {
    const item = object(frame.item) ?? frame;
    const itemId = string(frame.item_id) ?? string(item.id);
    const index = typeof frame.output_index === 'number' && Number.isInteger(frame.output_index) && frame.output_index >= 0 ? frame.output_index : undefined;
    const callId = string(item.call_id);
    const matches = [itemId ? this.byItem.get(itemId) : undefined, index === undefined ? undefined : this.byIndex.get(index), callId ? this.byCall.get(callId) : undefined].filter((call): call is PendingCall => Boolean(call));
    if (new Set(matches).size > 1) throw this.invalid();
    const call = matches[0] ?? { delta: '' };
    if (!itemId && index === undefined && !callId) throw this.invalid();
    const name = string(item.name);
    if (call.itemId && itemId && call.itemId !== itemId || call.index !== undefined && index !== undefined && call.index !== index
      || call.callId && callId && call.callId !== callId || call.name && name && call.name !== name) throw this.invalid();
    if (itemId) { call.itemId = itemId; this.byItem.set(itemId, call); }
    if (index !== undefined) { call.index = index; this.byIndex.set(index, call); }
    if (callId) { call.callId = callId; this.byCall.set(callId, call); }
    if (name) call.name = name;
    this.pending.add(call);
    if (complete && item.arguments !== undefined) this.setArguments(call, item.arguments);
    return call;
  }

  private setArguments(call: PendingCall, value: unknown, added = false): void {
    if (typeof value !== 'string') throw this.invalid();
    const parsed = this.parseArguments(value);
    if (!added && call.delta && stable(this.parseArguments(call.delta)) !== stable(parsed)
      || call.addedArguments !== undefined && stable(this.parseArguments(call.addedArguments)) !== stable(parsed)
      || call.arguments !== undefined && stable(this.parseArguments(call.arguments)) !== stable(parsed)) throw this.invalid();
    if (added) call.addedArguments = value;
    else call.arguments = value;
  }

  private emit(call: PendingCall): ChatGptToolCall[] {
    if (call.emitted) return [];
    if (!call.callId || !call.name) throw this.invalid();
    const args = call.arguments ?? (call.delta || call.addedArguments) ?? '';
    this.setArguments(call, args);
    const input = this.parseArguments(args);
    call.emitted = true;
    return this.compatibility({ id: call.callId, name: call.name, input });
  }

  private parseArguments(value: string): JsonObject {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw this.invalid(); }
    if (!object(parsed)) throw this.invalid();
    return parsed as JsonObject;
  }

  private invalid(): ChatGptBackendError {
    return new ChatGptBackendError('ChatGPT session backend tool response was invalid.', 'invalid_response', {
      status: 502, safeDiagnostic: { httpStatus: this.httpStatus, failurePhase: 'response_protocol', protocolStage: 'tool_finalization', protocolReason: 'tool_finalization' },
    });
  }
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
function string(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function stable(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) => {
    const record = object(item);
    return record ? Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]])) : item;
  });
}
