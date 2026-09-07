import { expect, it } from 'vitest';
import { ResponsesReplay } from './responses-replay.js';

it('retains completed output ordering and text projection independently of replay eligibility', () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'native-secret' };
  const call = { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{}' };
  const message = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] };
  const result = new ResponsesReplay().accept('response.completed', { response: { output: [reasoning, message, call] } });
  expect(result).toMatchObject({ replayEligible: false, outputItems: [reasoning, message, call] });
});
