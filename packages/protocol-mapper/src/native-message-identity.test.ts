import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { mapChatGptStreamToOpenAiResponsesSse } from './openai-responses.js';

const context = { account: { id: 'synthetic', provider: 'chatgpt-session' as const, secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic-token' } } };
const request = { model: 'model', maxTokens: 32, messages: [] };
const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'synthetic-reasoning' };
const textPart = (text: string) => ({ type: 'output_text', text, annotations: [] });
const message = (id: string, content: unknown[]) => ({ type: 'message', id, role: 'assistant', status: 'completed', content });

async function project(frames: unknown[]) {
  const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')) });
  let stream = '';
  for await (const event of mapChatGptStreamToOpenAiResponsesSse({ model: 'model', input: 'hello', include: ['reasoning.encrypted_content'] }, backend.stream(request, context))) stream += event;
  const events = stream.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6)) as Record<string, any>);
  assertAppendLifecycle(events);
  return events;
}

/** The official Responses SDK accumulates added items/parts by sequential append. */
function assertAppendLifecycle(events: Array<Record<string, any>>) {
  const output: Array<Record<string, any>> = [];
  for (const event of events) {
    if (event.type === 'response.output_item.added') {
      expect(event.output_index).toBe(output.length);
      output.push(structuredClone(event.item));
    } else if (event.type === 'response.content_part.added') {
      const message = output[event.output_index];
      expect(message?.type).toBe('message');
      expect(event.content_index).toBe(message.content.length);
      message.content.push(structuredClone(event.part));
    } else if (event.type === 'response.content_part.done') {
      expect(output[event.output_index]?.content[event.content_index]?.type).toBe(event.part.type);
      output[event.output_index].content[event.content_index] = event.part;
    } else if (event.type === 'response.output_item.done') {
      expect(output[event.output_index]?.id).toBe(event.item.id);
      output[event.output_index] = event.item;
    } else if (event.type === 'response.completed') expect(output).toEqual(event.response.output);
  }
}

describe('native Responses message identities', () => {
  it.each([false, true])('streams text after validated encrypted reasoning before the terminal arrives (include=%s)', async (include) => {
    const finalMessage = message('msg_live', [textPart('Already visible.')]);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const frame = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 3000, fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(value) {
      controller = value;
      value.enqueue(frame({ type: 'response.output_item.done', output_index: 0, item: reasoning }));
      value.enqueue(frame({ type: 'response.output_text.delta', item_id: 'msg_live', output_index: 1, content_index: 0, delta: 'Already visible.' }));
    } })) });
    const iterator = mapChatGptStreamToOpenAiResponsesSse({ model: 'model', input: 'hello', ...(include ? { include: ['reasoning.encrypted_content' as const] } : {}) }, backend.stream(request, context))[Symbol.asyncIterator]();
    const early: Array<Record<string, any>> = [];
    const nextText = (async () => {
      while (true) {
        const result = await iterator.next();
        if (result.done) throw new Error('Stream finished before the expected text delta.');
        const event = JSON.parse(result.value.split('\ndata: ')[1]);
        early.push(event);
        if (event.type === 'response.output_text.delta') return event;
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let terminalReleased = false;
    const releaseTerminal = () => {
      if (terminalReleased) return;
      terminalReleased = true;
      controller.enqueue(frame({ type: 'response.completed', response: { status: 'completed', output: [reasoning, finalMessage] } }));
      controller.close();
    };
    try {
      const event = await Promise.race([nextText, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Text was delayed until the terminal.')), 1000); })]);
      expect(event).toMatchObject({ item_id: 'msg_live', output_index: 1, content_index: 0, delta: 'Already visible.' });
      expect(early.filter((value) => value.type === 'response.output_item.added').map((value) => value.item.id)).toEqual(['rs_1', 'msg_live']);
      const { encrypted_content: _encrypted, ...visibleReasoning } = reasoning;
      expect(early.find((value) => value.type === 'response.output_item.done')?.item).toEqual(include ? reasoning : visibleReasoning);
      if (!include) expect(JSON.stringify(early)).not.toContain(reasoning.encrypted_content);
      releaseTerminal();
      while (true) {
        const result = await iterator.next();
        if (result.done) break;
        if (result.value.startsWith('event:')) early.push(JSON.parse(result.value.split('\ndata: ')[1]));
      }
      assertAppendLifecycle(early);
      expect(early.filter((value) => value.type === 'response.output_item.done').map((value) => value.item.id)).toEqual(['rs_1', 'msg_live']);
    } finally {
      clearTimeout(timer);
      releaseTerminal();
      await nextText;
      await iterator.return?.();
    }
  });

  it.each([
    { type: 'reasoning', id: 'rs_summary_only', summary: [] },
    { type: 'web_search_call', id: 'web_1', status: 'completed' },
  ])('defers an uncertain projected index after $type and emits a consistent final lifecycle', async (omitted) => {
    const finalMessage = message('msg_after_omitted', [textPart('Search result.')]);
    const events = await project([
      { type: 'response.output_text.delta', item_id: 'msg_after_omitted', output_index: 1, content_index: 0, delta: 'Search result.' },
      { type: 'response.completed', response: { status: 'completed', output: [omitted, finalMessage] } },
    ]);
    expect(events.at(-1)!.response.output).toEqual([finalMessage]);
    for (const event of events.filter((event) => event.output_index !== undefined)) expect(event.output_index).toBe(0);
    expect(events.filter((event) => event.type === 'response.output_item.added').map((event) => event.item.id)).toEqual(['msg_after_omitted']);
    expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join('')).toBe('Search result.');
  });

  it('preserves multiple live messages after reasoning instead of duplicating their concatenated text', async () => {
    const output = [reasoning, message('msg_commentary', [textPart('Checking. ')]), message('msg_final', [textPart('Done.')])];
    const events = await project([
      { type: 'response.output_text.delta', item_id: 'msg_commentary', output_index: 1, content_index: 0, delta: 'Checking. ' },
      { type: 'response.output_text.delta', item_id: 'msg_final', output_index: 2, content_index: 0, delta: 'Done.' },
      { type: 'response.completed', response: { status: 'completed', output } },
    ]);
    expect(events.at(-1)!.response).toMatchObject({ output, output_text: 'Checking. Done.' });
    expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => [event.item_id, event.output_index, event.delta])).toEqual([
      ['msg_commentary', 1, 'Checking. '], ['msg_final', 2, 'Done.'],
    ]);
    expect(events.filter((event) => event.type === 'response.output_item.done').map((event) => event.item)).toEqual(output);
  });

  it('preserves live text and refusal content indices and fills only missing final suffixes', async () => {
    const output = [message('msg_mixed', [{ type: 'refusal', refusal: 'Cannot comply.' }, textPart('Try a safe alternative.')])];
    const events = await project([
      { type: 'response.refusal.delta', item_id: 'msg_mixed', output_index: 0, content_index: 0, delta: 'Cannot ' },
      { type: 'response.output_text.delta', item_id: 'msg_mixed', output_index: 0, content_index: 1, delta: 'Try a safe ' },
      { type: 'response.completed', response: { status: 'completed', output } },
    ]);
    expect(events.at(-1)!.response.output).toEqual(output);
    expect(events.filter((event) => event.type === 'response.refusal.delta').map((event) => [event.content_index, event.delta])).toEqual([[0, 'Cannot '], [0, 'comply.']]);
    expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => [event.content_index, event.delta])).toEqual([[1, 'Try a safe '], [1, 'alternative.']]);
    expect(events.filter((event) => event.type === 'response.content_part.done').map((event) => event.part)).toEqual(output[0].content);
  });

  it('keeps final-only messages after a live message without creating an extra aggregate message', async () => {
    const output = [message('msg_live', [textPart('First. ')]), message('msg_final_only', [textPart('Second.')])];
    const events = await project([
      { type: 'response.output_text.delta', item_id: 'msg_live', output_index: 0, content_index: 0, delta: 'First. ' },
      { type: 'response.completed', response: { status: 'completed', output } },
    ]);
    expect(events.at(-1)!.response.output).toEqual(output);
    expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => [event.item_id, event.delta])).toEqual([['msg_live', 'First. '], ['msg_final_only', 'Second.']]);
  });

  it('keeps an earlier final-only message before a later live message', async () => {
    const output = [message('msg_final_only', [textPart('First. ')]), message('msg_live', [textPart('Second.')])];
    const events = await project([
      { type: 'response.output_text.delta', item_id: 'msg_live', output_index: 1, content_index: 0, delta: 'Second.' },
      { type: 'response.completed', response: { status: 'completed', output } },
    ]);
    expect(events.at(-1)!.response).toMatchObject({ output, output_text: 'First. Second.' });
    expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => [event.item_id, event.delta])).toEqual([['msg_final_only', 'First. '], ['msg_live', 'Second.']]);
  });

  it('does not publish content index one before a final-only content index zero', async () => {
    const output = [message('msg_parts', [textPart('First. '), textPart('Second.')])];
    const events = await project([
      { type: 'response.output_text.delta', item_id: 'msg_parts', output_index: 0, content_index: 1, delta: 'Second.' },
      { type: 'response.completed', response: { status: 'completed', output } },
    ]);
    expect(events.at(-1)!.response.output).toEqual(output);
    expect(events.filter((event) => event.type === 'response.content_part.added').map((event) => event.content_index)).toEqual([0, 1]);
    expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta)).toEqual(['First. ', 'Second.']);
  });

  it.each([0, 1])('projects text after omitted content without exposing raw content indices (output=%s)', async (outputIndex) => {
    const rawMessage = message('msg_filtered_parts', [{ type: 'future_content', secret: 'must-not-leak' }, textPart('Answer.')]);
    const expected = message('msg_filtered_parts', [textPart('Answer.')]);
    const events = await project([
      { type: 'response.output_text.delta', item_id: rawMessage.id, output_index: outputIndex, content_index: 1, delta: 'Answer.' },
      { type: 'response.completed', response: { status: 'completed', output: [...(outputIndex ? [{ type: 'web_search_call', id: 'web_1', status: 'completed' }] : []), rawMessage] } },
    ]);
    expect(events.at(-1)!.response.output).toEqual([expected]);
    expect(events.filter((event) => event.type === 'response.content_part.added').map((event) => event.content_index)).toEqual([0]);
    expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta)).toEqual(['Answer.']);
    expect(JSON.stringify(events)).not.toContain('must-not-leak');
  });

  it('keeps final-only and live repeated text distinct across omitted content', async () => {
    const rawMessage = message('msg_repeated_parts', [textPart('Repeated.'), { type: 'future_content' }, textPart('Repeated.'), { type: 'refusal', refusal: 'Declined.' }]);
    const expected = message('msg_repeated_parts', [textPart('Repeated.'), textPart('Repeated.'), { type: 'refusal', refusal: 'Declined.' }]);
    const events = await project([
      { type: 'response.output_text.delta', item_id: rawMessage.id, output_index: 0, content_index: 2, delta: 'Repeated.' },
      { type: 'response.refusal.delta', item_id: rawMessage.id, output_index: 0, content_index: 3, delta: 'Declined.' },
      { type: 'response.completed', response: { status: 'completed', output: [rawMessage] } },
    ]);
    expect(events.at(-1)!.response.output).toEqual([expected]);
    expect(events.filter((event) => event.type === 'response.content_part.added').map((event) => event.content_index)).toEqual([0, 1, 2]);
    expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => [event.content_index, event.delta])).toEqual([[0, 'Repeated.'], [1, 'Repeated.']]);
  });

  it('retains an already-published text prefix while projecting later content gaps', async () => {
    const rawMessage = message('msg_partial_parts', [textPart('First.'), { type: 'future_content' }, textPart('Second.')]);
    const expected = message('msg_partial_parts', [textPart('First.'), textPart('Second.')]);
    const events = await project([
      { type: 'response.output_text.delta', item_id: rawMessage.id, output_index: 0, content_index: 0, delta: 'First.' },
      { type: 'response.output_text.delta', item_id: rawMessage.id, output_index: 0, content_index: 2, delta: 'Sec' },
      { type: 'response.completed', response: { status: 'completed', output: [rawMessage] } },
    ]);
    expect(events.at(-1)!.response.output).toEqual([expected]);
    expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => [event.content_index, event.delta])).toEqual([[0, 'First.'], [1, 'Second.']]);
  });
});
