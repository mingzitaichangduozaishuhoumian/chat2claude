import type { ChatGptFinishReason, ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
import type { ClaudeMessageResponse, ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { encodeSseEvent } from '@chatgpt-to-claude/claude-protocol';
import { createMessageId } from '@chatgpt-to-claude/shared';
import { estimateClaudeInputTokens, estimateTokens } from './response.js';
import { mapStopReason } from './stop-reason.js';
export function createClaudeStreamStart(request: ClaudeMessagesRequest): ClaudeMessageResponse {
  return { id: createMessageId(), type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estimateClaudeInputTokens(request), output_tokens: 0 } };
}
export async function* mapChatGptStreamToClaudeSse(request: ClaudeMessagesRequest, events: AsyncIterable<ChatGptStreamEvent>): AsyncIterable<string> {
  let output = '';
  let nextIndex = 0;
  let textBlockOpen = false;
  let thinkingBlockOpen = false;
  let finishReason: ChatGptFinishReason | undefined;
  let outputTokens: number | undefined;
  yield encodeSseEvent({ event: 'message_start', data: { type: 'message_start', message: createClaudeStreamStart(request) } });
  for await (const event of events) {
    if (event.type === 'text_delta') {
      if (thinkingBlockOpen) {
        yield encodeSseEvent({ event: 'content_block_stop', data: { type: 'content_block_stop', index: nextIndex } });
        nextIndex += 1;
        thinkingBlockOpen = false;
      }
      if (!textBlockOpen) {
        yield encodeSseEvent({ event: 'content_block_start', data: { type: 'content_block_start', index: nextIndex, content_block: { type: 'text', text: '' } } });
        textBlockOpen = true;
      }
      output += event.text;
      yield encodeSseEvent({ event: 'content_block_delta', data: { type: 'content_block_delta', index: nextIndex, delta: { type: 'text_delta', text: event.text } } });
    } else if (event.type === 'status_delta' && !textBlockOpen && !thinkingBlockOpen) {
      yield encodeSseEvent({ event: 'content_block_start', data: { type: 'content_block_start', index: nextIndex, content_block: { type: 'thinking', thinking: '' } } });
      thinkingBlockOpen = true;
    } else if (event.type === 'reasoning_delta' && event.text.trim()) {
      if (textBlockOpen) {
        yield encodeSseEvent({ event: 'content_block_stop', data: { type: 'content_block_stop', index: nextIndex } });
        nextIndex += 1;
        textBlockOpen = false;
      }
      if (!thinkingBlockOpen) {
        yield encodeSseEvent({ event: 'content_block_start', data: { type: 'content_block_start', index: nextIndex, content_block: { type: 'thinking', thinking: '' } } });
        thinkingBlockOpen = true;
      }
      yield encodeSseEvent({ event: 'content_block_delta', data: { type: 'content_block_delta', index: nextIndex, delta: { type: 'thinking_delta', thinking: event.text } } });
    } else if (event.type === 'tool_call') {
      if (textBlockOpen || thinkingBlockOpen) {
        yield encodeSseEvent({ event: 'content_block_stop', data: { type: 'content_block_stop', index: nextIndex } });
        nextIndex += 1;
        textBlockOpen = false;
        thinkingBlockOpen = false;
      }
      const toolIndex = nextIndex;
      yield encodeSseEvent({ event: 'content_block_start', data: { type: 'content_block_start', index: toolIndex, content_block: { type: 'tool_use', id: event.toolCall.id, name: event.toolCall.name, input: {} } } });
      const partialJson = JSON.stringify(event.toolCall.input ?? {});
      yield encodeSseEvent({ event: 'content_block_delta', data: { type: 'content_block_delta', index: toolIndex, delta: { type: 'input_json_delta', partial_json: partialJson } } });
      yield encodeSseEvent({ event: 'content_block_stop', data: { type: 'content_block_stop', index: toolIndex } });
      nextIndex += 1;
      finishReason = 'tool_calls';
    } else if (event.type === 'done') {
      finishReason = event.finishReason ?? finishReason;
      outputTokens = event.usage?.outputTokens ?? outputTokens;
    }
  }
  if (textBlockOpen || thinkingBlockOpen) {
    yield encodeSseEvent({ event: 'content_block_stop', data: { type: 'content_block_stop', index: nextIndex } });
    nextIndex += 1;
    textBlockOpen = false;
    thinkingBlockOpen = false;
  }
  if (nextIndex === 0) {
    yield encodeSseEvent({ event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    yield encodeSseEvent({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
  }
  yield encodeSseEvent({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null }, usage: { output_tokens: outputTokens ?? estimateTokens(output) } } });
  yield encodeSseEvent({ event: 'message_stop', data: { type: 'message_stop' } });
}
export interface AsyncIterableStreamOptions {
  signal?: AbortSignal;
  /** HTTP-only: close delivery on downstream abort instead of erroring the response writer. */
  gracefulAbort?: boolean;
  /** Emit SSE comment frames while a pending next() is silent; 0 disables. */
  sseKeepaliveIntervalMs?: number;
  /** Interrupt active I/O before waiting for a pending iterator.next() to settle. */
  onCancel?: (reason: unknown) => void | Promise<void>;
}

export function readableStreamFromAsyncIterable(iterable: AsyncIterable<string>, options: AsyncIterableStreamOptions = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = iterable[Symbol.asyncIterator]();
  let stopped = false;
  let started = false;
  let closing: Promise<void> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let pendingNext: Promise<IteratorResult<string>> | undefined;
  let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
  const keepaliveIntervalMs = options.sseKeepaliveIntervalMs && options.sseKeepaliveIntervalMs > 0 ? options.sseKeepaliveIntervalMs : 0;
  const clearKeepaliveTimer = () => {
    clearTimeout(keepaliveTimer);
    keepaliveTimer = undefined;
  };
  const cleanup = () => { clearKeepaliveTimer(); options.signal?.removeEventListener('abort', abort); };
  const cancel = (reason: unknown): Promise<void> => {
    if (closing) return closing;
    stopped = true;
    cleanup();
    const upstreamCleanup = Promise.resolve().then(() => options.onCancel?.(reason));
    // Enter legacy generators so their finally runs even before the first pull.
    if (!started) {
      started = true;
      void iterator.next().catch(() => {});
    }
    closing = (async () => {
      const iteratorReturn = iterator.return;
      if (!iteratorReturn) {
        await upstreamCleanup.catch(() => {});
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([upstreamCleanup, Promise.resolve().then(() => iteratorReturn.call(iterator))]).catch(() => {}),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 250); }),
        ]);
      } finally { clearTimeout(timer); }
    })();
    return closing;
  };
  const abort = () => {
    if (stopped) return;
    if (options.gracefulAbort) controller.close();
    else controller.error(new DOMException('Request was cancelled.', 'AbortError'));
    void cancel(options.signal?.reason).catch(() => { /* Delivery has already stopped. */ });
  };
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    },
    async pull(controller) {
      if (stopped) return;
      started = true;
      try {
        pendingNext ??= Promise.resolve().then(() => iterator.next());
        clearKeepaliveTimer();
        const keepalive = keepaliveIntervalMs > 0
          ? new Promise<IteratorResult<string>>(resolve => { keepaliveTimer = setTimeout(() => resolve({ done: false, value: ': keepalive\n\n' }), keepaliveIntervalMs); })
          : undefined;
        const next = keepalive ? await Promise.race([pendingNext, keepalive]) : await pendingNext;
        clearKeepaliveTimer();
        if (next.value !== ': keepalive\n\n') pendingNext = undefined;
        if (stopped) return;
        if (next.done) {
          stopped = true;
          cleanup();
          controller.close();
        } else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        pendingNext = undefined;
        if (!stopped) {
          stopped = true;
          cleanup();
          controller.error(error);
        }
      }
    },
    cancel,
  });
}
