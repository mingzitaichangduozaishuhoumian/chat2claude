import { describe, expect, it } from 'vitest';
import type { ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
import { mapChatGptResponseToOpenAiResponses, mapChatGptStreamToOpenAiResponsesSse, NATIVE_RESPONSES_OUTPUT_BYTES, type OpenAiResponsesResponse } from './openai-responses.js';

const request = { model: 'model', input: 'hello' };
async function finish(events: AsyncIterable<ChatGptStreamEvent>): Promise<OpenAiResponsesResponse | undefined> {
  let completed: OpenAiResponsesResponse | undefined;
  for await (const event of mapChatGptStreamToOpenAiResponsesSse(request, events)) {
    if (event.startsWith('event: response.completed\n')) completed = JSON.parse(event.split('\ndata: ')[1]).response;
  }
  return completed;
}
function projection(response: OpenAiResponsesResponse | undefined) {
  return response && { ...response, id: '', created_at: 0, output: response.output.map(({ id: _id, ...item }) => item) };
}

describe('Responses retained-state stream budget', () => {
  it.each(['a', '雪', '😀'])('matches nonstream for one-unit and 100-unit chunks: %s', async (unit) => {
    const text = unit.repeat(150 * 1024);
    const expected = projection(mapChatGptResponseToOpenAiResponses(request, { text, finishReason: 'stop' }));
    for (const width of [1, 100]) {
      async function* source(): AsyncIterable<ChatGptStreamEvent> {
        for (let offset = 0; offset < text.length; offset += width) yield { type: 'text_delta', text: text.slice(offset, offset + width) };
        yield { type: 'done', finishReason: 'stop' };
      }
      const result = await finish(source()).then((response) => ({ response, error: false }), () => ({ response: undefined, error: true }));
      expect(result.error).toBe(false);
      expect(projection(result.response)).toEqual(expected);
    }
  });
  it.each(['a', '雪', '😀'])('rejects over 4 MiB retained UTF-8 text before requesting terminal: %s', async (unit) => {
    let terminalRequested = false;
    async function* source(): AsyncIterable<ChatGptStreamEvent> {
      const text = unit.repeat(Math.floor(NATIVE_RESPONSES_OUTPUT_BYTES / Buffer.byteLength(unit, 'utf8')) + 1);
      yield { type: 'text_delta', text };
      terminalRequested = true;
      yield { type: 'done', finishReason: 'stop' };
    }
    await expect(finish(source())).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
    expect(terminalRequested).toBe(false);
  });
  it('still bounds retained tools and terminal metadata', async () => {
    for (const terminal of [false, true]) {
      async function* source(): AsyncIterable<ChatGptStreamEvent> {
        const payload = 'x'.repeat(NATIVE_RESPONSES_OUTPUT_BYTES);
        if (terminal) yield { type: 'done', replayItems: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: payload }] };
        else yield { type: 'tool_call', toolCall: { id: 'call_1', name: 'lookup', input: { payload } } };
      }
      await expect(finish(source())).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
    }
  });
  it('retains the final serialized response guard independently of retained text bytes', async () => {
    let reachedTerminal = false;
    async function* source(): AsyncIterable<ChatGptStreamEvent> {
      yield { type: 'text_delta', text: 'x'.repeat(3 * 1024 * 1024) };
      reachedTerminal = true;
      yield { type: 'done', finishReason: 'stop' };
    }
    await expect(finish(source())).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
    expect(reachedTerminal).toBe(true);
  });
});
