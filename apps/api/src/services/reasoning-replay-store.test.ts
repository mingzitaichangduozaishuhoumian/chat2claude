import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { ChatGptInputItem, ChatGptReplayItem } from '@chatgpt-to-claude/chatgpt-backend';
import { ReasoningReplayStore } from './reasoning-replay-store.js';

const canary = 'STORE_OPAQUE_CANARY';
const scope = { owner: 'runtime-owner-1', provider: 'chatgpt-session' as const, model: 'model' };
const account = { id: 'a', incarnation: 1, provider: 'chatgpt-session' as const };
const reasoning = { type: 'reasoning' as const, id: 'rs', summary: [], encrypted_content: canary };
const call = { type: 'function_call' as const, id: 'fc', call_id: 'call', name: 'lookup', arguments: ' {"q":1,"nested":{"b":2,"a":1}} ' };
const bundle = { replayEligible: true, replayItems: [reasoning, call] };
const history: ChatGptInputItem[] = [
  { type: 'message', role: 'user', content: 'hi' },
  { type: 'function_call', callId: 'call', name: 'lookup', arguments: { nested: { a: 1, b: 2 }, q: 1 } },
  { type: 'function_call_output', callId: 'call', output: 'result' },
];

describe('ReasoningReplayStore', () => {
  it('clones private state, returns opaque affinity handles and structurally replays a matching group', () => {
    const store = new ReasoningReplayStore();
    const items = structuredClone(bundle);
    expect(store.put(scope, account, items)).toBe(true);
    items.replayItems[0] = { ...reasoning, encrypted_content: 'changed' };
    const hit = store.find(scope, history)!;
    expect(hit).toBeDefined();
    expect(hit.accepts(account, 'model')).toBe(true);
    const applied = hit.apply(history, account, 'model')!;
    expect(applied).toEqual([history[0], ...bundle.replayItems.map((item) => ({ type: 'replay', item })), history[2]]);
    (applied[1] as { type: 'replay'; item: typeof reasoning }).item.encrypted_content = 'changed';
    expect(hit.apply(history, account, 'model')).toEqual(store.find(scope, history)!.apply(history, account, 'model'));
    for (const value of [store, hit, store.stats()]) {
      expect(JSON.stringify(value) + inspect(value, { depth: null, showHidden: true })).not.toMatch(/STORE_OPAQUE_CANARY|encrypted_content|call_id|nested/);
    }
  });

  it.each(['owner', 'model', 'provider', 'missing-owner'] as const)('isolates lookup by %s', (field) => {
    const store = new ReasoningReplayStore();
    store.put(scope, account, bundle);
    const other = field === 'missing-owner' ? { ...scope, owner: undefined } : { ...scope, [field]: field === 'provider' ? 'mock' : 'other' };
    expect(store.find(other, history)).toBeUndefined();
  });

  it.each(['id', 'incarnation', 'provider', 'model'] as const)('never applies a match to the wrong account/model: %s', (field) => {
    const store = new ReasoningReplayStore();
    store.put(scope, account, bundle);
    const hit = store.find(scope, history)!;
    const other = field === 'model' ? account : { ...account, [field]: field === 'incarnation' ? 2 : field === 'provider' ? 'mock' : 'b' };
    expect(hit.apply(history, other, field === 'model' ? 'other' : 'model')).toBeUndefined();
  });

  it.each(['name', 'arguments', 'missing-result', 'duplicate-result', 'foreign-result', 'duplicate-id', 'noncontiguous'] as const)('does not guess mismatched or ambiguous history: %s', (mode) => {
    const store = new ReasoningReplayStore();
    store.put(scope, account, bundle);
    const items = structuredClone(history);
    if (mode === 'name') Object.assign(items[1], { name: 'other' });
    if (mode === 'arguments') Object.assign(items[1], { arguments: { q: 2 } });
    if (mode === 'missing-result') items.pop();
    if (mode === 'duplicate-result') items.push(items[2]);
    if (mode === 'foreign-result') items.push({ type: 'function_call_output', callId: 'foreign', output: '' });
    if (mode === 'duplicate-id') items.unshift(items[1], items[2]);
    if (mode === 'noncontiguous') items.splice(2, 0, { type: 'message', role: 'assistant', content: 'text' });
    expect(store.find(scope, items)).toBeUndefined();
  });

  it('matches ordered parallel calls even when results arrive in reverse order', () => {
    const store = new ReasoningReplayStore();
    const second = { ...call, id: 'fc2', call_id: 'call2', name: 'second', arguments: '{}' };
    store.put(scope, account, { replayEligible: true, replayItems: [reasoning, call, second] });
    const items: ChatGptInputItem[] = [history[1], { type: 'function_call', callId: 'call2', name: 'second', arguments: {} },
      { type: 'function_call_output', callId: 'call2', output: '' }, history[2]];
    expect(store.find(scope, items)!.apply(items, account, 'model')).toEqual([
      ...[reasoning, call, second].map((item) => ({ type: 'replay', item })), ...items.slice(2),
    ]);
    expect(store.find(scope, [items[1], items[0], ...items.slice(2)])).toBeUndefined();
  });

  it('only replaces the latest completed group across two consecutive rounds', () => {
    const store = new ReasoningReplayStore();
    store.put(scope, account, bundle);
    const second = { ...call, id: 'fc2', call_id: 'call2', name: 'second', arguments: '{}' };
    const replayItems = [{ ...reasoning, id: 'rs2' }, second];
    store.put(scope, account, { replayEligible: true, replayItems });
    const items: ChatGptInputItem[] = [...history, { type: 'function_call', callId: 'call2', name: 'second', arguments: {} }, { type: 'function_call_output', callId: 'call2', output: '' }];
    expect(store.find(scope, items)!.apply(items, account, 'model')).toEqual([...history, ...replayItems.map((item) => ({ type: 'replay', item })), items[4]]);
  });

  it('refuses ambiguous bundles or accounts instead of choosing the latest', () => {
    const store = new ReasoningReplayStore();
    store.put(scope, account, bundle);
    store.put(scope, account, bundle);
    expect(store.stats().records).toBe(1);
    store.put(scope, { ...account, id: 'b' }, bundle);
    expect(store.find(scope, history)).toBeUndefined();
    const conflict = new ReasoningReplayStore();
    conflict.put(scope, account, bundle);
    conflict.put(scope, account, { ...bundle, replayItems: [{ ...reasoning, encrypted_content: 'different' }, call] });
    expect(conflict.find(scope, history)).toBeUndefined();
  });

  it.each([false, undefined])('requires the backend successful whole-output marker (%s)', (replayEligible) => {
    const store = new ReasoningReplayStore();
    expect(store.put(scope, account, { ...bundle, replayEligible })).toBe(false);
    expect(store.stats()).toEqual({ records: 0, bytes: 0 });
  });

  it('rejects absent owners, cancellations, missing calls, malformed and oversized bundles without leaks', () => {
    const store = new ReasoningReplayStore();
    expect(store.put({ ...scope, owner: undefined }, account, bundle)).toBe(false);
    expect(store.put(scope, account, bundle, AbortSignal.abort(canary))).toBe(false);
    for (const replayItems of [[reasoning], [{ ...reasoning, encrypted_content: 1 }, call], [{ ...reasoning, encrypted_content: 'x'.repeat(300_000) }, call]]) {
      expect(store.put(scope, account, { replayEligible: true, replayItems: replayItems as ChatGptReplayItem[] })).toBe(false);
    }
    expect(store.stats().records).toBe(0);
    expect(inspect(store, { showHidden: true, depth: null })).not.toContain(canary);
  });

  it('expires records and outstanding handles exactly at TTL', () => {
    let now = 0;
    const store = new ReasoningReplayStore({ now: () => now, ttlMs: 100 });
    store.put(scope, account, bundle);
    const hit = store.find(scope, history)!;
    now = 99;
    expect(store.find(scope, history)).toBeDefined();
    now = 100;
    expect(store.find(scope, history)).toBeUndefined();
    expect(hit.apply(history, account, 'model')).toBeUndefined();
    expect(store.stats()).toEqual({ records: 0, bytes: 0 });
  });

  it.each(['maxRecords', 'maxOwnerRecords', 'maxBytes', 'maxOwnerBytes'] as const)('bounds %s with oldest-first eviction', (limit) => {
    const sample = new ReasoningReplayStore();
    sample.put(scope, account, bundle);
    const bytes = sample.stats().bytes;
    const store = new ReasoningReplayStore({ [limit]: limit.includes('Bytes') ? bytes : 1 });
    store.put(scope, account, bundle);
    expect(store.find(scope, history)).toBeDefined();
    store.put(scope, { ...account, id: 'b' }, bundle);
    expect(store.stats().records).toBe(1);
    const hit = store.find(scope, history)!;
    expect(hit.accepts({ ...account, id: 'b' }, 'model')).toBe(true);
  });

  it('per-owner eviction does not evict another owner, and oversized entries preserve old records', () => {
    const store = new ReasoningReplayStore({ maxOwnerRecords: 1, maxBytes: 5000 });
    store.put({ ...scope, owner: 'other' }, account, bundle);
    store.put(scope, account, bundle);
    store.put(scope, { ...account, id: 'b' }, bundle);
    expect(store.find({ ...scope, owner: 'other' }, history)).toBeDefined();
    expect(store.put(scope, account, { ...bundle, replayItems: [{ ...reasoning, encrypted_content: 'x'.repeat(6000) }, call] })).toBe(false);
    expect(store.stats().records).toBe(2);
    store.clear();
    expect(store.stats()).toEqual({ records: 0, bytes: 0 });
  });
});
