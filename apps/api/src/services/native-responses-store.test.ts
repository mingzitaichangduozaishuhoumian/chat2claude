import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ResponsesStore } from './responses-store.js';

it.each(['public', 'private'] as const)('does not retain generated image output in %s storage projections', (source) => {
  const store = new ResponsesStore();
  const item = { type: 'image_generation_call', id: 'img', status: 'completed', result: 'YWJj' };
  const response = { id: 'resp_image', object: 'response' as const, created_at: 0, model: 'm', status: 'completed' as const, output: source === 'public' ? [item] : [], output_text: '', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
  const context = { account: { id: 'a', incarnation: 1, provider: 'mock' as const }, model: 'm', output: source === 'private' ? [item] : [] };
  expect(store.put('owner', { model: 'm', input: 'draw' }, response, context)).toBe(false);
  expect(store.get('owner', response.id)).toBeUndefined();
  expect(store.count()).toBe(0);
});

it('keeps payload out of store/handle inspection and bounds records and bytes', () => {
  const store = new ResponsesStore({ maxRecords: 1, maxBytes: 4096 });
  const request = { model: 'm', input: 'hello' };
  const response = { id: 'resp_one', object: 'response' as const, created_at: 0, model: 'm', status: 'completed' as const, output: [], output_text: '', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
  const context = { account: { id: 'a', incarnation: 1, provider: 'mock' as const }, model: 'm', output: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'STORE_NATIVE_CANARY' }] };
  expect(store.put('owner', request, response, undefined as any)).toBe(false);
  store.put('owner', request, response, context);
  const handle = store.get('owner', response.id)!;
  expect(inspect([store, handle], { showHidden: true, depth: null })).not.toContain('STORE_NATIVE_CANARY');
  expect(JSON.stringify([store, handle])).not.toContain('STORE_NATIVE_CANARY');
  expect(handle.expand('next', context.account, context.model)).toHaveLength(3);
  store.put('owner', request, { ...response, id: 'resp_two' }, context);
  expect(store.get('owner', 'resp_one')).toBeUndefined();
  expect(store.count()).toBe(1);
  expect(() => handle.expand('next', context.account, context.model)).toThrow('Previous response not found.');
  expect(store.put('owner', { ...request, input: 'x'.repeat(4096) }, { ...response, id: 'resp_big' }, context)).toBe(false);
  expect(store.count()).toBe(1);
  const active = store.get('owner', 'resp_two')!;
  const clone = active.expand('next', context.account, context.model);
  clone[1].encrypted_content = 'mutated';
  expect(active.expand('next', context.account, context.model)[1].encrypted_content).toBe('STORE_NATIVE_CANARY');
  store.clear();
  expect(store.count()).toBe(0);
  expect(() => active.expand('next', context.account, context.model)).toThrow('Previous response not found.');
});

it('retains accepted large histories instead of silently dropping them at half the input limit', () => {
  const store = new ResponsesStore();
  const request = { model: 'm', input: 'long context '.repeat(400_000) };
  const response = { id: 'resp_long', object: 'response' as const, created_at: 0, model: 'm', status: 'completed' as const, output: [], output_text: '', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
  const context = { account: { id: 'a', incarnation: 1, provider: 'mock' as const }, model: 'm', output: [] };
  expect(Buffer.byteLength(request.input)).toBeGreaterThan(4 * 1024 * 1024);
  expect(store.put('owner', request, response, context)).toBe(true);
  expect(store.get('owner', response.id)!.expand('next', context.account, context.model)[0].content).toBe(request.input);
  expect(store.stats().bytes).toBeLessThan(64 * 1024 * 1024);
});

describe('Responses history argument equivalence', () => {
  function history(argumentsText: string) {
    const store = new ResponsesStore();
    const account = { id: 'a', incarnation: 1, provider: 'mock' as const };
    const call = { type: 'function_call', id: 'fc', call_id: 'call', name: 'lookup', arguments: argumentsText };
    const response = { id: 'resp', object: 'response' as const, created_at: 0, model: 'm', status: 'completed' as const, output: [], output_text: '', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
    expect(store.put('owner', { model: 'm', input: 'hello' }, response, { account, model: 'm', output: [call] })).toBe(true);
    return { expand: (value: unknown) => store.get('owner', 'resp')!.expand([{ ...call, arguments: value }], account, 'm'), call };
  }

  it.each([
    ['9007199254740992', '9007199254740993'],
    ['0.10000000000000001', '0.1'],
    ['1e400', '1e500'],
    ['1e-400', '2e-400'],
  ])('rejects distinct JSON numbers %s and %s instead of silently restoring the older call', (stored, incoming) => {
    const f = history(`{"id":${stored}}`);
    expect(() => f.expand(`{"id":${incoming}}`)).toThrow('Conflicting previous response input.');
  });

  it('still recognizes equivalent formatting and retains the exact stored argument text', () => {
    const f = history(' { "nested": [true, null, "1e3"], "id": 1000.00 } ');
    expect(f.expand('{"id":1e3,"nested":[true,null,"1e3"]}')).toEqual([{ type: 'message', role: 'user', content: 'hello' }, f.call]);
  });

  it('matches identical large numbers without converting them to JavaScript numbers', () => {
    const f = history('{"id":9007199254740993}');
    expect(f.expand(' { "id": 9007199254740993 } ').at(-1)).toEqual(f.call);
  });
});
