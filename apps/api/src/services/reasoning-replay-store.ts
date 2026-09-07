import { createHash } from 'node:crypto';
import { parseResponsesReplayItem, ResponsesReplayBudget, type ChatGptCompletionResponse, type ChatGptInputItem, type ChatGptReplayItem } from '@chatgpt-to-claude/chatgpt-backend';
import type { Account, AccountProvider } from './account-pool.js';

export interface ReplayScope { owner?: string; provider: AccountProvider; model: string; }
type ReplayAccount = Pick<Account, 'id' | 'incarnation' | 'provider'>;
type ReplayBundle = Pick<ChatGptCompletionResponse, 'replayItems' | 'replayEligible'>;
export interface ReasoningReplayStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxRecords?: number;
  maxBytes?: number;
  maxOwnerRecords?: number;
  maxOwnerBytes?: number;
}
interface RecordData {
  owner: string;
  provider: AccountProvider;
  model: string;
  account: ReplayAccount;
  calls: Array<{ id: string; name: string; arguments: unknown }>;
  replayItems: ChatGptReplayItem[];
}
interface Entry { data: RecordData; key: string; callKey: string; wire: string; bytes: number; expiresAt: number; }
const DEFAULTS = { ttlMs: 10 * 60_000, maxRecords: 2048, maxBytes: 64 * 1024 * 1024, maxOwnerRecords: 256, maxOwnerBytes: 8 * 1024 * 1024 };

/** Runtime-only secret storage. JS private slots intentionally resist JSON/inspect,
 * including showHidden. No exportState, owner listing, or Admin integration.
 * TTL is lazy; FIFO eviction bounds retained bytes even when no cleanup is requested.
 */
export class ReasoningReplayStore {
  #records = new Map<number, Entry>();
  #sequence = 0;
  #now: () => number;
  #limits: typeof DEFAULTS;

  constructor(options: ReasoningReplayStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#limits = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as Array<keyof typeof DEFAULTS>) {
      const value = options[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid reasoning replay store limit.');
        this.#limits[key] = value;
      }
    }
  }

  put(scope: ReplayScope, account: ReplayAccount, bundle: ReplayBundle, signal?: AbortSignal): boolean {
    this.#cleanup();
    if (!scope.owner || signal?.aborted || bundle.replayEligible !== true || !bundle.replayItems?.length
      || account.provider !== scope.provider || !this.#limits.ttlMs || !this.#limits.maxRecords || !this.#limits.maxOwnerRecords) return false;
    try {
      const budget = new ResponsesReplayBudget();
      const replayItems = bundle.replayItems.map((item) => {
        const parsed = parseResponsesReplayItem(item);
        if (!parsed) throw new Error('Invalid replay item.');
        budget.add(parsed);
        return parsed;
      });
      const calls = replayItems.filter((item) => item.type === 'function_call').map((item) => ({ id: item.call_id, name: item.name, arguments: canonicalArguments(item.arguments) }));
      if (!calls.length || new Set(calls.map((call) => call.id)).size !== calls.length) return false;
      const data: RecordData = { owner: scope.owner, provider: scope.provider, model: scope.model,
        account: { id: account.id, incarnation: account.incarnation, provider: account.provider }, calls, replayItems };
      const wire = JSON.stringify(data);
      // Count retained wire plus detached data, with conservative index/metadata overhead.
      const bytes = 2 * Buffer.byteLength(wire, 'utf8') + 256;
      if (bytes > this.#limits.maxBytes || bytes > this.#limits.maxOwnerBytes) return false;
      const callKey = hash(calls);
      const key = scopeKey(scope, callKey);
      for (const [id, previous] of this.#records) if (previous.key === key && previous.wire === wire) this.#records.delete(id);
      this.#evict(scope.owner, bytes);
      this.#records.set(++this.#sequence, { data, wire, bytes, key, callKey, expiresAt: this.#now() + this.#limits.ttlMs });
      return true;
    } catch {
      // A backend contract violation is not a cache failure that may alter a response.
      // Never retain or log the caught value, parser message, or candidate payload.
      return false;
    }
  }

  find(scope: ReplayScope, input?: ChatGptInputItem[]): ReasoningReplayMatch | undefined {
    this.#cleanup();
    if (!scope.owner) return undefined;
    const group = latestGroup(input);
    if (!group) return undefined;
    const key = scopeKey(scope, group.key);
    const matches = [...this.#records].filter(([, entry]) => entry.key === key);
    if (matches.length !== 1) return undefined;
    const [id, record] = matches[0];
    return new ReasoningReplayMatch(record, () => this.#records.get(id) === record && this.#now() < record.expiresAt);
  }

  stats(): { records: number; bytes: number } {
    this.#cleanup();
    return { records: this.#records.size, bytes: [...this.#records.values()].reduce((sum, entry) => sum + entry.bytes, 0) };
  }
  clear(): void { this.#records.clear(); }

  #cleanup(): void {
    const now = this.#now();
    for (const [id, record] of this.#records) if (now >= record.expiresAt) this.#records.delete(id);
  }
  #evict(owner: string, bytes: number): void {
    const owned = [...this.#records].filter(([, entry]) => entry.data.owner === owner);
    let ownerBytes = owned.reduce((sum, [, entry]) => sum + entry.bytes, 0);
    while (owned.length >= this.#limits.maxOwnerRecords || ownerBytes + bytes > this.#limits.maxOwnerBytes) {
      const [id, entry] = owned.shift()!;
      this.#records.delete(id);
      ownerBytes -= entry.bytes;
    }
    let totalBytes = [...this.#records.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (this.#records.size >= this.#limits.maxRecords || totalBytes + bytes > this.#limits.maxBytes) {
      const [id, entry] = this.#records.entries().next().value!;
      this.#records.delete(id);
      totalBytes -= entry.bytes;
    }
  }
}

/** Opaque request-local handle. Only apply() returns a detached replay input;
 * serialization/debug inspection of a lookup result cannot expose the bundle.
 */
export class ReasoningReplayMatch {
  #entry: Entry;
  #active: () => boolean;
  constructor(entry: Entry, active: () => boolean) { this.#entry = entry; this.#active = active; }
  accepts(account: ReplayAccount, model: string): boolean {
    const stored = this.#entry.data;
    return stored.model === model && account.provider === stored.provider
      && account.id === stored.account.id && account.incarnation === stored.account.incarnation;
  }
  apply(input: ChatGptInputItem[] | undefined, account: ReplayAccount, model: string): ChatGptInputItem[] | undefined {
    if (!this.#active() || !this.accepts(account, model)) return undefined;
    const group = latestGroup(input);
    if (!group || group.key !== this.#entry.callKey) return undefined;
    return structuredClone([
      ...input!.slice(0, group.start),
      ...this.#entry.data.replayItems.map((item) => ({ type: 'replay' as const, item })),
      ...input!.slice(group.end),
    ]);
  }
}

function latestGroup(input: ChatGptInputItem[] | undefined): { start: number; end: number; key: string } | undefined {
  if (!input?.length) return undefined;
  try {
    let last = input.length - 1;
    while (last >= 0 && input[last].type !== 'function_call') last--;
    if (last < 0) return undefined;
    let start = last;
    while (start > 0 && input[start - 1].type === 'function_call') start--;
    const calls = input.slice(start, last + 1).map((item) => {
      if (item.type !== 'function_call' || !item.callId || !item.name) throw new Error('Invalid call group.');
      return { id: item.callId, name: item.name, arguments: canonicalArguments(item.arguments) };
    });
    const ids = new Set(calls.map((call) => call.id));
    if (ids.size !== calls.length || input.slice(0, start).some((item) => item.type === 'function_call' && ids.has(item.callId))) return undefined;
    const results = input.slice(last + 1);
    // Conservative implicit matching: a contiguous group followed only by its
    // complete, unique result set. Mixed/interleaved groups are cache misses.
    if (results.length !== calls.length || results.some((item) => item.type !== 'function_call_output' || !ids.delete(item.callId)) || ids.size) return undefined;
    return { start, end: last + 1, key: hash(calls) };
  } catch { return undefined; }
}

function canonicalArguments(value: unknown): unknown {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid call arguments.');
  return canonical(parsed, 0);
}
function canonical(value: unknown, depth: number): unknown {
  if (depth > 64) throw new Error('Invalid call arguments.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key], depth + 1)]));
  }
  throw new Error('Invalid call arguments.');
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function scopeKey(scope: ReplayScope, callKey: string): string { return hash([scope.owner, scope.provider, scope.model, callKey]); }
