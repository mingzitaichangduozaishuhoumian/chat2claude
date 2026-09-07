import { isDeepStrictEqual } from 'node:util';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import type { OpenAiResponsesInputItem, OpenAiResponsesRequest, OpenAiResponsesResponse } from '@chatgpt-to-claude/protocol-mapper';
import type { Account } from './account-pool.js';

type Identity = Pick<Account, 'id' | 'incarnation' | 'provider'>;
export interface ResponsesStoreContext { account: Identity; model: string; output: OpenAiResponsesInputItem[]; }
interface RecordData {
  owner: string;
  input: OpenAiResponsesInputItem[];
  output: OpenAiResponsesInputItem[];
  account: Identity;
  model: string;
  expiresAt: number;
  bytes: number;
}
export interface ResponsesStoreOptions { now?: () => number; ttlMs?: number; maxRecords?: number; maxBytes?: number; maxRecordBytes?: number; }
export const RESPONSES_HISTORY_LIMITS = Object.freeze({ items: 4096, bytes: 8 * 1024 * 1024 });
const defaults = { ttlMs: 30 * 60_000, maxRecords: 1000, maxBytes: 64 * 1024 * 1024, maxRecordBytes: 8 * 1024 * 1024 };
export function previousResponseNotFound(): ClaudeApiError { return new ClaudeApiError('Previous response not found.', 404, 'not_found_error'); }

/** No record/public payload getters or debug metadata. Only an explicit expansion
 * can release a detached history for backend dispatch. All persistence is local. */
export class ResponsesStore {
  #records = new Map<string, RecordData>();
  #now: () => number;
  #limits: typeof defaults;
  constructor(options: ResponsesStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#limits = { ...defaults };
    for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
      const value = options[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Responses store limit.');
        this.#limits[key] = value;
      }
    }
  }
  put(owner: string | undefined, request: OpenAiResponsesRequest, response: OpenAiResponsesResponse, context: ResponsesStoreContext): boolean {
    this.#cleanup();
    if (!owner || !context?.account || !context.model || request.store === false || response.status !== 'completed' || !this.#limits.maxRecords || !this.#limits.ttlMs) return false;
    try {
      const input = toInput(request.input);
      const output = context.output;
      checkHistory([...input, ...output]);
      const { id, incarnation, provider } = context.account;
      const data = structuredClone({ owner, input, output, account: { id, incarnation, provider }, model: context.model });
      const bytes = 2 * Buffer.byteLength(JSON.stringify(data), 'utf8') + 256;
      if (bytes > this.#limits.maxBytes || bytes > this.#limits.maxRecordBytes) return false;
      this.#records.delete(response.id);
      let total = this.#bytes();
      while (this.#records.size >= this.#limits.maxRecords || total + bytes > this.#limits.maxBytes) {
        const [id, previous] = this.#records.entries().next().value!;
        this.#records.delete(id);
        total -= previous.bytes;
      }
      this.#records.set(response.id, { ...data, bytes, expiresAt: this.#now() + this.#limits.ttlMs });
      return true;
    } catch { return false; }
  }
  get(owner: string | undefined, id: string): StoredOpenAiResponseRecord | undefined {
    this.#cleanup();
    const record = this.#records.get(id);
    if (!owner || !record || record.owner !== owner) return undefined;
    return new StoredOpenAiResponseRecord(record, () => this.#records.get(id) === record && this.#now() < record.expiresAt);
  }
  count(): number { this.#cleanup(); return this.#records.size; }
  stats(): { records: number; bytes: number } { this.#cleanup(); return { records: this.#records.size, bytes: this.#bytes() }; }
  clear(): void { this.#records.clear(); }
  #bytes(): number { return [...this.#records.values()].reduce((sum, entry) => sum + entry.bytes, 0); }
  #cleanup(): void { for (const [id, record] of this.#records) if (this.#now() >= record.expiresAt) this.#records.delete(id); }
}

export class StoredOpenAiResponseRecord {
  #record: RecordData;
  #active: () => boolean;
  constructor(record: RecordData, active: () => boolean) { this.#record = record; this.#active = active; }
  accepts(account: Identity, model: string): boolean {
    const stored = this.#record;
    return stored.model === model && stored.account?.id === account.id && stored.account.incarnation === account.incarnation && stored.account.provider === account.provider;
  }
  expand(current: OpenAiResponsesRequest['input'], account: Identity, model: string): OpenAiResponsesInputItem[] {
    if (!this.#active() || !this.accepts(account, model)) throw previousResponseNotFound();
    const history = [...this.#record.input, ...this.#record.output];
    const incoming = toInput(current);
    // Exact stable identities may be repeated by stateless clients together with
    // previous_response_id. Drop only matching repetitions in historical order;
    // conflicts/ambiguous identities fail closed rather than changing the lineage.
    let last = -1;
    let appended = false;
    const suffix: OpenAiResponsesInputItem[] = [];
    for (const item of incoming) {
      const matches = history.map((previous, index) => ({ previous, index })).filter(({ previous }) => sameIdentity(previous, item));
      if (!matches.length) { appended = true; suffix.push(item); continue; }
      if (appended || matches.length !== 1 || matches[0].index <= last || !equivalent(matches[0].previous, item)) throw new ClaudeApiError('Conflicting previous response input.', 400, 'invalid_request_error');
      last = matches[0].index;
    }
    const expanded = [...history, ...suffix];
    checkHistory(expanded);
    return structuredClone(expanded);
  }
}
function toInput(input: OpenAiResponsesRequest['input']): OpenAiResponsesInputItem[] { return typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : input; }
function sameIdentity(a: OpenAiResponsesInputItem, b: OpenAiResponsesInputItem): boolean {
  return typeof a.id === 'string' && a.id === b.id || a.type === 'function_call' && b.type === 'function_call' && typeof a.call_id === 'string' && a.call_id === b.call_id;
}
function equivalent(a: OpenAiResponsesInputItem, b: OpenAiResponsesInputItem): boolean {
  if (a.type === 'function_call' && b.type === 'function_call') {
    try {
      const { id: _aId, status: _aStatus, ...aWire } = a;
      const { id: _bId, status: _bStatus, ...bWire } = b;
      return isDeepStrictEqual({ ...aWire, arguments: JSON.parse(String(a.arguments)) }, { ...bWire, arguments: JSON.parse(String(b.arguments)) });
    } catch { return false; }
  }
  return isDeepStrictEqual(a, b);
}
function checkHistory(input: OpenAiResponsesInputItem[]): void {
  if (input.length > RESPONSES_HISTORY_LIMITS.items || Buffer.byteLength(JSON.stringify(input), 'utf8') > RESPONSES_HISTORY_LIMITS.bytes) throw new ClaudeApiError('Responses history limit exceeded.', 400, 'invalid_request_error');
}
