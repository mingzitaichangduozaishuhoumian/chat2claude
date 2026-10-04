import { describe, expect, it } from 'vitest';
import { ResponsesToolCalls } from './responses-tools.js';

const identity = { type: 'function_call', id: 'fc_synthetic', call_id: 'call_synthetic', name: 'lookup' };

describe('Responses function call argument fidelity', () => {
  it.each(['added', 'delta', 'done', 'completed'] as const)('retains the original JSON string when finalized from %s', (source) => {
    const argumentsText = ' { "id": 9007199254740993, "ratio": 1.0000000000000001, "empty": null } ';
    const tools = new ResponsesToolCalls(200);
    let emitted = [];
    if (source === 'completed') emitted = tools.accept('response.completed', { response: { output: [{ ...identity, arguments: argumentsText }] } });
    else {
      emitted = tools.accept(source === 'done' ? 'response.output_item.done' : 'response.output_item.added', {
        output_index: 0, item: { ...identity, arguments: source === 'delta' ? '' : argumentsText },
      });
      if (source === 'delta') tools.accept('response.function_call_arguments.delta', { item_id: identity.id, delta: argumentsText });
      emitted.push(...tools.finish());
    }
    expect(emitted).toHaveLength(1);
    expect(emitted[0].rawArguments).toBe(argumentsText);
  });

  it.each([
    ['9007199254740993', '9007199254740992'],
    ['1.0000000000000001', '1'],
    ['1e400', '2e400'],
    ['1e-400', '0'],
  ])('rejects distinct numeric snapshots even when JavaScript rounds %s and %s to the same value', (delta, done) => {
    const tools = new ResponsesToolCalls(200);
    tools.accept('response.output_item.added', { output_index: 0, item: { ...identity, arguments: '' } });
    tools.accept('response.function_call_arguments.delta', { item_id: identity.id, delta: `{"value":${delta}}` });
    expect(() => tools.accept('response.output_item.done', { output_index: 0, item: { ...identity, arguments: `{"value":${done}}` } }))
      .toThrow(expect.objectContaining({ code: 'invalid_response', safeDiagnostic: expect.objectContaining({ protocolStage: 'tool_finalization' }) }));
  });

  it('accepts exact numeric equivalents and property reordering without rewriting the final wire string', () => {
    const tools = new ResponsesToolCalls(200);
    tools.accept('response.output_item.added', { output_index: 0, item: { ...identity, arguments: '{"a":1,"b":9007199254740993}' } });
    const final = ' { "b": 9007199254740993.0, "a": 1e0 } ';
    const emitted = tools.accept('response.output_item.done', { output_index: 0, item: { ...identity, arguments: final } });
    expect(emitted[0].rawArguments).toBe(final);
    expect(tools.finish()).toEqual([]);
  });
});
