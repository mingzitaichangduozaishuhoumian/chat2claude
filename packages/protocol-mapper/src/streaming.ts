import type { ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
import type { ClaudeMessageResponse, ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { encodeSseEvent } from '@chatgpt-to-claude/claude-protocol';
import { createMessageId } from '@chatgpt-to-claude/shared';
import { estimateTokens } from './response.js';
export function createClaudeStreamStart(request: ClaudeMessagesRequest): ClaudeMessageResponse {
  return { id: createMessageId(), type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estimateTokens(JSON.stringify(request.messages)), output_tokens: 0 } };
}
export async function* mapChatGptStreamToClaudeSse(request: ClaudeMessagesRequest, events: AsyncIterable<ChatGptStreamEvent>): AsyncIterable<string> {
  let output = '';
  yield encodeSseEvent({ event: 'message_start', data: { type: 'message_start', message: createClaudeStreamStart(request) } });
  yield encodeSseEvent({ event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for await (const event of events) {
    if (event.type === 'text_delta') {
      output += event.text;
      yield encodeSseEvent({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: event.text } } });
    }
  }
  yield encodeSseEvent({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
  yield encodeSseEvent({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: estimateTokens(output) } } });
  yield encodeSseEvent({ event: 'message_stop', data: { type: 'message_stop' } });
}
export function readableStreamFromAsyncIterable(iterable: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({ async pull(controller) { const next = await iterator.next(); if (next.done) { controller.close(); return; } controller.enqueue(encoder.encode(next.value)); }, async cancel() { await iterator.return?.(); } });
}
