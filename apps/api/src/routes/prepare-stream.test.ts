import { afterEach, expect, it, vi } from 'vitest';
import type { ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
import { prepareStream } from './prepare-stream.js';
afterEach(() => vi.useRealTimers());
const done: ChatGptStreamEvent = { type: 'done' };
function source(values: ChatGptStreamEvent[]) {
  const next = vi.fn(async () => values.length ? { done: false as const, value: values.shift()! } : { done: true as const, value: undefined });
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  const iterator = { next, return: close };
  const factory = vi.fn(() => iterator);
  return { source: { [Symbol.asyncIterator]: factory }, next, close, factory };
}
it.each<ChatGptStreamEvent>([{ type: 'text_delta', text: 'one' }, { type: 'tool_call', toolCall: { id: 'call', name: 'f', input: {} } }, done])('replays compatibility $type exactly once from the original iterator', async first => {
  const f = source([first]);
  const abort = vi.fn();
  const prepared = await prepareStream(f.source, { abort });
  const events = [];
  for await (const event of prepared.events) events.push(event);
  expect(events).toEqual([first]);
  expect(f.factory).toHaveBeenCalledTimes(1);
  expect(() => prepared.events[Symbol.asyncIterator]()).toThrow();
  await prepared.close(); await prepared.close();
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(abort).toHaveBeenCalledTimes(1);
});
it('consumes only the explicit barrier and filters later internal barriers', async () => {
  const f = source([{ type: 'upstream_ready' }, { type: 'upstream_ready' }, done]);
  const prepared = await prepareStream(f.source, { abort: vi.fn() });
  expect(f.next).toHaveBeenCalledTimes(1);
  const events = [];
  for await (const event of prepared.events) events.push(event);
  expect(events).toEqual([done]);
  await prepared.close();
});
it.each([[], [null], [undefined], [{ type: 'done', terminalSuccessful: false }], [{ type: 'text_delta', text: 5 }], [{ type: 'extension' }]].map(values => ({ values })))('rejects unsuccessful/invalid compatibility bootstrap %#', async ({ values }) => {
  const f = source(values as ChatGptStreamEvent[]);
  const abort = vi.fn();
  await expect(prepareStream(f.source, { abort })).rejects.toMatchObject({ code: 'invalid_response', status: 502 });
  expect(abort).toHaveBeenCalledTimes(1);
  expect(f.close).toHaveBeenCalledTimes(1);
});
it('aborts pending prepare and bounds a never-settling next/return', async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const close = vi.fn(() => new Promise<IteratorResult<ChatGptStreamEvent>>(() => {}));
  const abort = vi.fn();
  const pending = prepareStream({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: close }) }, { signal: caller.signal, abort }).catch(e => e);
  caller.abort('CANARY');
  await vi.advanceTimersByTimeAsync(250);
  expect(await pending).toMatchObject({ name: 'AbortError' });
  expect(close).toHaveBeenCalledTimes(1);
  expect(abort).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('aborts when the iterator factory throws before preparation', async () => {
  const abort = vi.fn();
  const failure = new Error('CANARY');
  await expect(prepareStream({ [Symbol.asyncIterator]() { throw failure; } }, { abort })).rejects.toBe(failure);
  expect(abort).toHaveBeenCalledTimes(1);
});
it('closes upstream on early consumer return', async () => {
  const f = source([{ type: 'text_delta', text: 'one' }, done]);
  const prepared = await prepareStream(f.source, { abort: vi.fn() });
  for await (const _event of prepared.events) break;
  expect(f.close).toHaveBeenCalledTimes(1);
});
it('observes late next/return rejections after the cancellation budget', async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  let rejectNext!: (error: Error) => void;
  let rejectReturn!: (error: Error) => void;
  const pending = prepareStream({ [Symbol.asyncIterator]: () => ({
    next: () => new Promise((_resolve, reject) => { rejectNext = reject; }),
    return: () => new Promise((_resolve, reject) => { rejectReturn = reject; }),
  }) }, { signal: caller.signal, abort: vi.fn() }).catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  caller.abort();
  await vi.advanceTimersByTimeAsync(250);
  expect(await pending).toMatchObject({ name: 'AbortError' });
  rejectNext(new Error('CANARY')); rejectReturn(new Error('CANARY'));
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});
it('closes after prepare without requiring a first consumer pull', async () => {
  const caller = new AbortController();
  const f = source([{ type: 'upstream_ready' }, done]);
  const prepared = await prepareStream(f.source, { signal: caller.signal, abort: vi.fn() });
  caller.abort();
  await prepared.close();
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.next).toHaveBeenCalledTimes(1);
});
