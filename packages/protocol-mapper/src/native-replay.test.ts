import { describe, expect, it } from 'vitest';
import type { ChatGptCompletionResponse, ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
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
  it.each([false, true])('emits ordered standard events matching completed output, include=%s', async (include) => {
    const events = await collect([{ type: 'tool_call', toolCall: completion.toolCalls![0] }, { type: 'done', finishReason: 'tool_calls', replayItems: [reasoning, call] }], include);
    const added = events.filter((x) => x.type === 'response.output_item.added');
    const done = events.filter((x) => x.type === 'response.output_item.done');
    expect(added.map((x) => x.item.type)).toEqual(['reasoning', 'function_call']);
    expect(done.map((x) => x.output_index)).toEqual([0, 1]);
    expect(events.at(-1).response.output).toEqual(done.map((x) => x.item));
    expect(events.filter((x) => x.type === 'response.function_call_arguments.done')).toHaveLength(1);
    expect(events.map((x) => x.sequence_number)).toEqual(events.map((_, i) => i));
    expect(events[0].response.status).toBe('in_progress');
    expect(JSON.stringify(events).includes(secret)).toBe(include);
    expect(JSON.stringify(events)).not.toContain('encrypted_content.delta');
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
