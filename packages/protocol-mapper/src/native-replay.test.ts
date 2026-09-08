import { describe, expect, it } from 'vitest';
import type { ChatGptCompletionResponse, ChatGptOutputItem, ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
import { mapOpenAiResponsesRequestToChatGpt, mapChatGptResponseToOpenAiResponses, mapChatGptStreamToOpenAiResponsesSse } from './openai-responses.js';

const secret = 'NATIVE_REPLAY_CANARY';
const reasoning = { type: 'reasoning' as const, id: 'rs_1', summary: [], encrypted_content: secret };
const call = { type: 'function_call' as const, id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: ' {"x":1} ' };
const completion: ChatGptCompletionResponse = { text: '', finishReason: 'tool_calls', toolCalls: [{ id: call.call_id, name: call.name, input: { x: 1 } }], replayItems: [reasoning, call] };
const request = { model: 'model', input: 'hello' };
async function collect(events: ChatGptStreamEvent[], include = true) {
  async function* source() { yield* events; }
  const chunks = [];
  for await (const chunk of mapChatGptStreamToOpenAiResponsesSse({ ...request, ...(include ? { include: ['reasoning.encrypted_content' as const] } : {}) }, source())) chunks.push(chunk);
  return chunks.join('').split('\n\n').filter((x) => x.startsWith('event:')).map((x) => JSON.parse(x.split('\ndata: ')[1]));
}
function assertOutputLifecycleReconciles(events: Array<Record<string, any>>) {
  const completed = events.find((x) => x.type === 'response.completed');
  expect(completed).toBeTruthy();
  const completedOutput = completed!.response.output;
  const added = events.filter((x) => x.type === 'response.output_item.added');
  const done = events.filter((x) => x.type === 'response.output_item.done');
  expect(done).toHaveLength(added.length);
  const doneByIndex = new Map(done.map((x) => [x.output_index, x]));
  expect(doneByIndex.size).toBe(done.length);
  for (const itemAdded of added) {
    const itemDone = doneByIndex.get(itemAdded.output_index);
    expect(itemDone).toBeTruthy();
    expect(itemDone!.item.id).toBe(itemAdded.item.id);
    expect(completedOutput[itemDone!.output_index]).toMatchObject({ id: itemDone!.item.id, type: itemDone!.item.type });
  }
}

describe('native Responses replay projection', () => {
  it('maps reasoning structurally, excluding it from text fallback', () => {
    const mapped = mapOpenAiResponsesRequestToChatGpt({ ...request, input: [reasoning, call] });
    expect(mapped.inputItems?.[0]).toEqual({ type: 'replay', item: reasoning });
    expect(JSON.stringify(mapped.messages)).not.toContain(secret);
    expect(JSON.stringify(mapped.messages)).not.toContain('unsupported:reasoning');
  });
  it.each([false, true])('preserves ordered wire calls without duplicates, include=%s', (include) => {
    const response = mapChatGptResponseToOpenAiResponses({ ...request, ...(include ? { include: ['reasoning.encrypted_content' as const] } : {}) }, completion);
    expect(response.output.map((item) => item.type)).toEqual(['reasoning', 'function_call']);
    expect(response.output[1]).toMatchObject(call);
    expect(JSON.stringify(response).includes(secret)).toBe(include);
  });
  it.each([false, true])('streams terminal tool lifecycle with authoritative replay identities, include=%s', async (include) => {
    const events = await collect([{ type: 'tool_call', toolCall: completion.toolCalls![0] }, { type: 'done', finishReason: 'tool_calls', replayItems: [reasoning, call] }], include);
    const added = events.filter((x) => x.type === 'response.output_item.added');
    const done = events.filter((x) => x.type === 'response.output_item.done');
    expect(added.map((x) => x.item.type)).toEqual(['reasoning', 'function_call']);
    expect(done.map((x) => x.item.type)).toEqual(['reasoning', 'function_call']);
    expect(events.at(-1).response.output.map((item: { type: string }) => item.type)).toEqual(['reasoning', 'function_call']);
    assertOutputLifecycleReconciles(events);
    expect(events.filter((x) => x.type === 'response.function_call_arguments.done')).toHaveLength(1);
    expect(events.map((x) => x.sequence_number)).toEqual(events.map((_, i) => i));
    expect(events[0].response.status).toBe('in_progress');
    expect(JSON.stringify(events).includes(secret)).toBe(include);
    expect(JSON.stringify(events)).not.toContain('encrypted_content.delta');
  });
  it('reconciles incremental text with mixed authoritative delayed terminal output', async () => {
    const authoritativeMessage: ChatGptOutputItem = { type: 'message', id: 'msg_authoritative', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] };
    const authoritativeReasoning: ChatGptOutputItem = { ...reasoning, id: 'rs_after_message' };
    const authoritativeCall: ChatGptOutputItem = { ...call, id: 'fc_after_reasoning' };
    const events = await collect([
      { type: 'text_delta', text: 'hello' },
      { type: 'tool_call', toolCall: { id: authoritativeCall.call_id, name: authoritativeCall.name, input: { x: 1 } } },
      { type: 'done', finishReason: 'tool_calls', outputItems: [authoritativeMessage, authoritativeReasoning, authoritativeCall], replayItems: [authoritativeReasoning, authoritativeCall] },
    ]);
    const completedOutput = events.at(-1).response.output;
    expect(completedOutput.map((item: { type: string }) => item.type)).toEqual(['message', 'reasoning', 'function_call']);
    assertOutputLifecycleReconciles(events);
    const messageAdded = events.filter((x) => x.type === 'response.output_item.added' && x.item.type === 'message');
    expect(messageAdded).toHaveLength(1);
    expect(completedOutput.filter((item: { type: string }) => item.type === 'message')).toHaveLength(1);
    expect(completedOutput[0].id).toBe(messageAdded[0].item.id);
    const textDelta = events.find((x) => x.type === 'response.output_text.delta');
    expect(textDelta).toMatchObject({ item_id: completedOutput[0].id, output_index: 0, delta: 'hello' });
    expect(events.findIndex((x) => x.type === 'response.output_text.delta')).toBeLessThan(events.findIndex((x) => x.type === 'response.completed'));
    expect(events.filter((x) => x.type === 'response.function_call_arguments.done')).toHaveLength(1);
    expect(events.find((x) => x.type === 'response.function_call_arguments.done')).toMatchObject({ item_id: 'fc_after_reasoning', output_index: 2, arguments: authoritativeCall.arguments });
  });
  it('does not synthesize success on EOF', async () => {
    await expect(collect([{ type: 'text_delta', text: 'tentative' }])).rejects.toThrow();
  });
  it('does not commit when source throws after done', async () => {
    let stored = false;
    async function* source(): AsyncIterable<ChatGptStreamEvent> { yield { type: 'done', finishReason: 'stop' }; throw new Error('failure'); }
    await expect((async () => { for await (const _ of mapChatGptStreamToOpenAiResponsesSse(request, source(), { onCompleted: () => { stored = true; } })) {} })()).rejects.toThrow('failure');
    expect(stored).toBe(false);
  });
  it('bounds buffered output', async () => {
    await expect(collect([{ type: 'text_delta', text: 'x'.repeat(4 * 1024 * 1024 + 1) }, { type: 'done', finishReason: 'stop' }])).rejects.toThrow();
  });
});
