import { describe, expect, it } from 'vitest';
import type { OpenAiResponsesResponse } from '@chatgpt-to-claude/protocol-mapper';
import { ResponsesStore } from './responses-store.js';

const account = { id: 'source', incarnation: 1, provider: 'chatgpt-session' as const };
const web = { id: 'web', incarnation: 2, provider: 'chatgpt-web' as const };
const response: OpenAiResponsesResponse = { id: 'resp_public', object: 'response', created_at: 0, model: 'client-model', status: 'completed',
  output: [{ type: 'message', id: 'private_message_id', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'visible answer', annotations: [] }] }],
  output_text: 'visible answer', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };

describe('ResponsesStore public continuation boundary', () => {
  function put(store = new ResponsesStore(), output: Record<string, unknown>[] = response.output) {
    expect(store.put('owner', { model: 'client-model', input: 'visible request' }, response,
      { account, model: 'native-model', output })).toBe(true);
    return store;
  }

  it('permits public provider/model handoff without loosening same-model account or incarnation affinity', () => {
    const store = put();
    const record = store.get('owner', response.id)!;
    expect(record.accepts(account, 'native-model')).toBe(true);
    expect(record.canHandoff(web, 'web-model')).toBe(true);
    expect(record.canHandoff(account, 'different-native-model')).toBe(true);
    expect(record.canHandoff({ ...account, id: 'other' }, 'native-model')).toBe(false);
    expect(record.canHandoff({ ...account, incarnation: 99 }, 'native-model')).toBe(false);
    expect(() => record.expand('next', web, 'web-model')).toThrow('Previous response not found');
    expect(record.expandVisible('next')).toEqual([
      { type: 'message', role: 'user', content: 'visible request' },
      { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'visible answer' }] },
      { type: 'message', role: 'user', content: 'next' },
    ]);
    expect(store.get('other-owner', response.id)).toBeUndefined();
    expect(store.get(undefined, response.id)).toBeUndefined();
  });

  it('keeps native hidden reasoning private and rejects newly appended opaque reasoning on a public handoff', () => {
    const store = put(new ResponsesStore(), [
      { type: 'reasoning', id: 'rs_private', encrypted_content: 'PRIVATE_REASONING', summary: [] }, ...response.output,
    ]);
    const record = store.get('owner', response.id)!;
    expect(JSON.stringify(record.expand('next', account, 'native-model'))).toContain('PRIVATE_REASONING');
    expect(JSON.stringify(record.expandVisible('next'))).not.toMatch(/PRIVATE_REASONING|rs_private|private_message_id/);
    expect(() => record.expandVisible([{ type: 'reasoning', id: 'new_private', encrypted_content: 'UNTRUSTED_NATIVE', summary: [] }])).toThrow('Native reasoning input');
  });

  it.each([
    [{ type: 'computer_call', id: 'unknown_native', status: 'completed' }],
    [{ type: 'message', role: 'assistant', status: 'incomplete', content: 'partial' }],
    [{ type: 'function_call', call_id: 'pending', name: 'lookup', arguments: '{}' }],
  ].map((output) => [output]))('keeps unsupported native history bound rather than guessing a visible projection (case %#)', (output) => {
    const store = put(new ResponsesStore(), output);
    const record = store.get('owner', response.id)!;
    expect(record.expand('next', account, 'native-model')).toContainEqual(output[0]);
    expect(() => record.expandVisible('next')).toThrow('History cannot be continued');
  });

  it('checks record expiry again at public expansion and never retains store:false turns', () => {
    let now = 0;
    const store = put(new ResponsesStore({ now: () => now, ttlMs: 1 }));
    const record = store.get('owner', response.id)!;
    now = 2;
    expect(record.canHandoff(web, 'web-model')).toBe(false);
    expect(() => record.expandVisible('next')).toThrow('Previous response not found');
    expect(store.get('owner', response.id)).toBeUndefined();
    expect(store.put('owner', { model: 'client-model', input: 'do not retain', store: false }, response,
      { account, model: 'native-model', output: response.output })).toBe(false);
    expect(store.count()).toBe(0);
  });
});
