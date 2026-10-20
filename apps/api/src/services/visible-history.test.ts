import { describe, expect, it } from 'vitest';
import type { ChatGptInputItem } from '@chatgpt-to-claude/chatgpt-backend';
import { visibleInputHistory, visibleResponsesHistory } from './visible-history.js';

describe('visible history handoff projection', () => {
  it('preserves completed public tool IDs and exact argument strings while discarding provider identity and reasoning', () => {
    const args = ' {"id":9007199254740993} ';
    const projected = visibleResponsesHistory([
      { type: 'message', id: 'provider_message', role: 'user', content: 'inspect the project' },
      { type: 'reasoning', id: 'provider_reasoning', status: 'completed', encrypted_content: 'HIDDEN_CIPHER', summary: [{ type: 'summary_text', text: 'HIDDEN_SUMMARY' }] },
      { type: 'function_call', id: 'provider_call', status: 'completed', call_id: 'call_public', name: 'read_file', arguments: args },
      { type: 'function_call_output', call_id: 'call_public', output: 'visible file content' },
      { type: 'message', id: 'provider_answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'result', annotations: [{ private: 'provider_annotation' }] }] },
    ]);
    expect(projected).toEqual([
      { type: 'message', role: 'user', content: 'inspect the project' },
      { type: 'function_call', call_id: 'call_public', name: 'read_file', arguments: args },
      { type: 'function_call_output', call_id: 'call_public', output: 'visible file content' },
      { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'result' }] },
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/HIDDEN|provider_/);
  });

  it('keeps images, text order and direct public tool results detached', () => {
    const input: ChatGptInputItem[] = [
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'before' }, { type: 'image', imageUrl: 'https://images.test/a.png', detail: 'high' }, { type: 'text', text: 'after' }] },
      { type: 'function_call', callId: 'one', name: 'lookup', arguments: { q: 1 } },
      { type: 'function_call_output', callId: 'one', output: 'found', isError: false },
    ];
    const projected = visibleInputHistory(input);
    expect(projected).toEqual(input);
    (projected[0] as Extract<ChatGptInputItem, { type: 'message' }>).content = 'changed';
    expect(input[0]).toMatchObject({ content: expect.any(Array) });
  });

  it.each([
    [{ type: 'computer_call', status: 'completed', screenshot: 'PRIVATE' }],
    [{ type: 'message', role: 'assistant', status: 'incomplete', content: 'partial' }],
    [{ type: 'message', role: 'assistant', content: [{ type: 'output_audio', data: 'PRIVATE' }] }],
    [{ type: 'reasoning', status: 'in_progress', encrypted_content: 'PRIVATE' }],
    [{ type: 'function_call', call_id: 'pending', name: 'lookup', arguments: '{}' }],
    [{ type: 'function_call_output', call_id: 'unknown', output: 'PRIVATE' }],
    [{ type: 'function_call', call_id: 'call', name: 'lookup', arguments: '{}', namespace: 'native' }, { type: 'function_call_output', call_id: 'call', output: 'x' }],
    [{ type: 'function_call', call_id: 'call', name: 'lookup', arguments: '{}' }, { type: 'function_call_output', call_id: 'call', output: 'x' }, { type: 'function_call_output', call_id: 'call', output: 'x' }],
  ].map((input) => [input]))('rejects incomplete, unsupported or ambiguous native history (case %#)', (input) => {
    expect(() => visibleResponsesHistory(input)).toThrow('History cannot be continued');
    try { visibleResponsesHistory(input); } catch (error) { expect(String(error)).not.toContain('PRIVATE'); }
  });
});
