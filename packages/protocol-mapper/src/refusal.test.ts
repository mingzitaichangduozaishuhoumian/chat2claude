import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend, type ChatGptOutputItem, type ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
import { mapChatGptResponseToClaude } from './response.js';
import { mapChatGptStreamToClaudeSse } from './streaming.js';
import { mapChatGptResponseToOpenAiChat, mapChatGptStreamToOpenAiChatSse, mapOpenAiChatRequestToChatGpt } from './openai-chat.js';
import { mapChatGptResponseToOpenAiResponses, mapChatGptStreamToOpenAiResponsesSse, mapOpenAiResponsesRequestToChatGpt } from './openai-responses.js';

const refusal = 'I cannot help with that request.';
const claudeRequest = { model: 'model', max_tokens: 32, messages: [] };
const chatRequest = { model: 'model', messages: [] };
const responsesRequest = { model: 'model', input: 'hello' };
const context = { account: { id: 'synthetic-account', provider: 'chatgpt-session' as const, secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic-token' } } };
const backendRequest = { model: 'model', maxTokens: 32, messages: [] };
const refusalMessage: ChatGptOutputItem = { type: 'message', id: 'msg_refusal', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal }] };

function backend(mode: 'delta' | 'final' | 'both') {
  const frames = [
    ...(mode !== 'final' ? [{ type: 'response.refusal.delta', delta: refusal }] : []),
    { type: 'response.completed', response: { status: 'completed', ...(mode !== 'delta' ? { output: [refusalMessage] } : {}) } },
  ];
  return new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')) });
}

async function collect(events: AsyncIterable<string>): Promise<Array<Record<string, any>>> {
  let text = '';
  for await (const event of events) text += event;
  return text.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6)));
}

describe.each(['delta', 'final', 'both'] as const)('session refusal in %s output', (mode) => {
  it('returns visible Claude text and a refusal terminal reason', async () => {
    const response = mapChatGptResponseToClaude(claudeRequest, await backend(mode).complete(backendRequest, context));
    expect(response.content).toEqual([{ type: 'text', text: refusal }]);
    expect(response.stop_reason).toBe('refusal');
    const events = await collect(mapChatGptStreamToClaudeSse(claudeRequest, backend(mode).stream(backendRequest, context)));
    expect(events.filter((event) => event.delta?.type === 'text_delta').map((event) => event.delta.text).join('')).toBe(refusal);
    expect(events.find((event) => event.type === 'message_delta')!.delta.stop_reason).toBe('refusal');
  });

  it('uses the Chat refusal field for JSON and streaming clients', async () => {
    const response = mapChatGptResponseToOpenAiChat(chatRequest, await backend(mode).complete(backendRequest, context));
    expect(response.choices[0]).toMatchObject({ message: { content: null, refusal }, finish_reason: 'stop' });
    const events = await collect(mapChatGptStreamToOpenAiChatSse(chatRequest, backend(mode).stream(backendRequest, context)));
    expect(events.flatMap((event) => event.choices).map((choice) => choice.delta.refusal ?? '').join('')).toBe(refusal);
    expect(events.at(-1)!.choices[0].finish_reason).toBe('stop');
    expect(mapOpenAiChatRequestToChatGpt({ ...chatRequest, messages: [response.choices[0].message] }).inputItems).toEqual([{ type: 'message', role: 'assistant', content: refusal }]);
  });

  it('preserves native refusal parts and emits a matching Responses lifecycle', async () => {
    const response = mapChatGptResponseToOpenAiResponses(responsesRequest, await backend(mode).complete(backendRequest, context));
    expect(response.output_text).toBe('');
    expect(response.output).toEqual([expect.objectContaining({ type: 'message', content: [{ type: 'refusal', refusal }] })]);
    const events = await collect(mapChatGptStreamToOpenAiResponsesSse(responsesRequest, backend(mode).stream(backendRequest, context)));
    expect(events.filter((event) => event.type === 'response.refusal.delta').map((event) => event.delta).join('')).toBe(refusal);
    expect(events.filter((event) => event.type === 'response.refusal.done')).toEqual([expect.objectContaining({ content_index: 0, refusal })]);
    expect(events.filter((event) => event.type === 'response.output_text.delta')).toEqual([]);
    const output = events.at(-1)!.response.output;
    expect(output).toEqual([expect.objectContaining({ type: 'message', content: [{ type: 'refusal', refusal }] })]);
    expect(events.find((event) => event.type === 'response.output_item.done')!.item).toEqual(output[0]);
    expect(mapOpenAiResponsesRequestToChatGpt({ ...responsesRequest, input: output }).inputItems).toEqual([{ type: 'message', role: 'assistant', content: refusal }]);
  });
});

describe('mixed native refusal and text parts', () => {
  it('keeps separate content indices and excludes refusal from output_text', async () => {
    const message: ChatGptOutputItem = { type: 'message', id: 'msg_mixed', role: 'assistant', status: 'completed', content: [
      { type: 'output_text', text: 'Explanation. ', annotations: [] },
      { type: 'refusal', refusal },
    ] };
    async function* source(): AsyncIterable<ChatGptStreamEvent> {
      yield { type: 'text_delta', text: 'Explanation. ' };
      yield { type: 'refusal_delta', text: refusal };
      yield { type: 'done', finishReason: 'refusal', outputItems: [message] };
    }
    const events = await collect(mapChatGptStreamToOpenAiResponsesSse(responsesRequest, source()));
    expect(events.filter((event) => event.type === 'response.content_part.done').map((event) => ({ index: event.content_index, part: event.part }))).toEqual(message.content.map((part, index) => ({ index, part })));
    expect(events.at(-1)!.response).toMatchObject({ output_text: 'Explanation. ', output: [expect.objectContaining({ content: message.content })] });
  });

  it.each(['output_text', 'refusal'] as const)('keeps final-only %s provider identities and output order', async (type) => {
    const message: ChatGptOutputItem = { type: 'message', id: 'msg_provider', role: 'assistant', status: 'completed', content: [type === 'refusal'
      ? { type: 'refusal', refusal } : { type: 'output_text', text: 'Final answer', annotations: [] }] };
    const output = [
      { type: 'reasoning', id: 'rs_provider', summary: [], encrypted_content: 'synthetic-reasoning' },
      message,
      { type: 'function_call', id: 'fc_provider', call_id: 'call_provider', name: 'lookup', arguments: '{}' },
    ];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`) });
    const events = await collect(mapChatGptStreamToOpenAiResponsesSse({ ...responsesRequest, include: ['reasoning.encrypted_content'] }, backend.stream(backendRequest, context)));
    expect(events.at(-1)!.response.output).toEqual(output);
    expect(events.filter((event) => event.type === 'response.output_item.added').map((event) => event.item.id)).toEqual(['rs_provider', 'msg_provider', 'fc_provider']);
    expect(events.filter((event) => event.type === 'response.output_item.done').map((event) => event.item)).toEqual(output);
  });
});

describe('leading final-only text', () => {
  it.each(['Claude', 'Chat'] as const)('preserves both messages in %s JSON and streaming responses', async (protocol) => {
    const output = ['First. ', 'Second.'].map((text, index) => ({ type: 'message', id: `msg_${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }));
    const frames = [
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Second.' },
      { type: 'response.completed', response: { status: 'completed', output } },
    ];
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')) });
    const completion = await backend.complete(backendRequest, context);
    if (protocol === 'Claude') {
      expect(mapChatGptResponseToClaude(claudeRequest, completion).content).toEqual([{ type: 'text', text: 'First. Second.' }]);
      const events = await collect(mapChatGptStreamToClaudeSse(claudeRequest, backend.stream(backendRequest, context)));
      expect(events.filter((event) => event.delta?.type === 'text_delta').map((event) => event.delta.text)).toEqual(['Second.', 'First. ']);
    } else {
      expect(mapChatGptResponseToOpenAiChat(chatRequest, completion).choices[0].message.content).toBe('First. Second.');
      const events = await collect(mapChatGptStreamToOpenAiChatSse(chatRequest, backend.stream(backendRequest, context)));
      expect(events.flatMap((event) => event.choices).filter((choice) => choice.delta.content).map((choice) => choice.delta.content)).toEqual(['Second.', 'First. ']);
    }
  });
});
