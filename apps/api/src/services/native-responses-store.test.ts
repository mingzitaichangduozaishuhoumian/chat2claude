import { inspect } from 'node:util';
import { expect, it } from 'vitest';
import { ResponsesStore } from './responses-store.js';

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
