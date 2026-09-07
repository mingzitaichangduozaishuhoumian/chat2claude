import { ChatGptBackendError, type ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';

export interface PreparedStream {
  events: AsyncIterable<ChatGptStreamEvent>;
  /** Abort I/O first, then give the original iterator a bounded teardown budget. */
  close(): Promise<void>;
}

export async function boundedClose(operation: () => unknown): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation).catch(() => {}),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 250); }),
    ]);
  } finally { clearTimeout(timer); }
}
function cancelled(): Error { return new DOMException('Request was cancelled.', 'AbortError'); }
function invalid(): ChatGptBackendError { return new ChatGptBackendError('Upstream response was invalid.', 'invalid_response', { status: 502 }); }

/** Acquire once, prefetch once; the protocol mappers' local preludes are not readiness. */
export async function prepareStream(source: AsyncIterable<ChatGptStreamEvent>, options: { signal?: AbortSignal; abort: () => void }): Promise<PreparedStream> {
  let iterator: AsyncIterator<ChatGptStreamEvent>;
  try { iterator = source[Symbol.asyncIterator](); }
  catch (error) { options.abort(); throw error; }
  const signal = options.signal;
  let closing: Promise<void> | undefined;
  let closed = false;
  let used = false;
  let buffered: ChatGptStreamEvent | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    // Schedule return before aborting so synchronous abort listeners share closing.
    closing = boundedClose(() => iterator.return?.());
    options.abort();
    return closing;
  };
  const onAbort = () => { void close(); };
  const next = async (): Promise<IteratorResult<ChatGptStreamEvent>> => {
    if (signal?.aborted || closed) throw cancelled();
    let listener!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      listener = () => reject(cancelled());
      signal?.addEventListener('abort', listener, { once: true });
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => iterator.next()), aborted]);
      if (signal?.aborted || closed) throw cancelled();
      return result;
    } finally { signal?.removeEventListener('abort', listener); }
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const first = await next();
    if (first.done || !first.value || typeof first.value !== 'object') throw invalid();
    if (first.value.type !== 'upstream_ready') {
      if (!validBusinessEvent(first.value)) throw invalid();
      buffered = first.value;
    }
    return {
      close,
      events: {
        [Symbol.asyncIterator]() {
          if (used) throw new Error('Prepared stream is single-use.');
          used = true;
          return (async function* () {
            let exhausted = false;
            try {
              if (signal?.aborted || closed) throw cancelled();
              if (buffered) { const first = buffered; buffered = undefined; yield first; }
              while (true) {
                const result = await next();
                if (result.done) { exhausted = true; return; }
                if (result.value.type === 'upstream_ready') continue;
                yield result.value;
              }
            } finally {
              // Natural exhaustion leaves the signal alive for downstream replay
              // commit and serialization; the outer lifecycle closes afterwards.
              if (!exhausted) await close();
            }
          })();
        },
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function validBusinessEvent(event: ChatGptStreamEvent): boolean {
  if (!event || typeof event !== 'object') return false;
  if (event.type === 'text_delta') return typeof event.text === 'string';
  if (event.type === 'tool_call') return Boolean(event.toolCall && typeof event.toolCall.id === 'string' && event.toolCall.id && typeof event.toolCall.name === 'string' && event.toolCall.name && event.toolCall.input && typeof event.toolCall.input === 'object' && !Array.isArray(event.toolCall.input));
  return event.type === 'done' && event.terminalSuccessful !== false;
}
