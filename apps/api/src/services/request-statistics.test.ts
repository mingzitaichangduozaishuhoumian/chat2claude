import { describe, expect, it } from 'vitest';
import { AdminOperationalState } from './admin-operational-state.js';
import { createAccountRequestTracker, trackStreamStatistics } from './request-statistics.js';

const identity = { accountId: 'account-1', createdAt: '2026-09-04T00:00:00.000Z' };

describe('per-account request statistics', () => {
  it('records each acquired request exactly once and only accepts finite non-negative integer usage', () => {
    const state = new AdminOperationalState({ path: 'unused.json', debounceMs: 60_000 });
    const tracker = createAccountRequestTracker(state, identity);

    tracker.finish('success', { inputTokens: 12, outputTokens: 5 });
    tracker.finish('failure', { inputTokens: 99, outputTokens: 99 });

    expect(state.snapshot().accounts[0]?.requestStats).toEqual({
      totalRequests: 1,
      successfulRequests: 1,
      failedRequests: 0,
      cancelledRequests: 0,
      inputTokens: 12,
      outputTokens: 5,
      lastRequestAt: expect.any(String),
      inFlight: 0,
    });

    const invalid = createAccountRequestTracker(state, identity);
    invalid.finish('failure', { inputTokens: 1.5, outputTokens: Number.POSITIVE_INFINITY });
    expect(state.snapshot().accounts[0]?.requestStats).toMatchObject({
      totalRequests: 2,
      successfulRequests: 1,
      failedRequests: 1,
      inputTokens: 12,
      outputTokens: 5,
    });
  });

  it('records stream completion, errors, and client cancellation exactly once', async () => {
    const state = new AdminOperationalState({ path: 'unused.json', debounceMs: 60_000 });
    const complete = createAccountRequestTracker(state, identity);
    for await (const _event of trackStreamStatistics(events([{ type: 'done', usage: { inputTokens: 2, outputTokens: 3 } }]), complete)) { /* consume */ }

    const failure = createAccountRequestTracker(state, identity);
    await expect(consume(trackStreamStatistics(failingEvents(), failure))).rejects.toThrow('stream failed');

    const cancellation = createAccountRequestTracker(state, identity);
    const iterator = trackStreamStatistics(events([{ type: 'text_delta', text: 'partial' }]), cancellation)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    expect(state.snapshot().accounts[0]?.requestStats).toMatchObject({
      totalRequests: 3,
      successfulRequests: 1,
      failedRequests: 1,
      cancelledRequests: 1,
      inputTokens: 2,
      outputTokens: 3,
      inFlight: 0,
    });
  });

  it('keeps delete-and-recreate account incarnations isolated', () => {
    const state = new AdminOperationalState({ path: 'unused.json', debounceMs: 60_000 });
    const oldIdentity = { accountId: 'reused-id', createdAt: '2026-09-04T00:00:00.000Z' };
    const newIdentity = { accountId: 'reused-id', createdAt: '2026-09-04T00:01:00.000Z' };
    createAccountRequestTracker(state, oldIdentity).finish('success');
    state.removeAccount(oldIdentity);
    createAccountRequestTracker(state, newIdentity).finish('failure');

    expect(state.snapshot().accounts).toEqual([expect.objectContaining({
      accountId: 'reused-id',
      createdAt: newIdentity.createdAt,
      requestStats: expect.objectContaining({ totalRequests: 1, successfulRequests: 0, failedRequests: 1 }),
    })]);
  });

  it('records cancellation separately and isolates operational persistence failures', () => {
    const failingState = {
      recordRequestStarted: () => { throw new Error('persistence unavailable'); },
      recordRequestFinished: () => { throw new Error('persistence unavailable'); },
    } as unknown as AdminOperationalState;

    expect(() => {
      const tracker = createAccountRequestTracker(failingState, identity);
      tracker.finish('cancelled');
    }).not.toThrow();
  });
});

async function* events(items: Array<{ type: 'text_delta'; text: string } | { type: 'done'; usage?: { inputTokens?: number; outputTokens?: number } }>) {
  yield* items;
}

async function* failingEvents() {
  throw new Error('stream failed');
}

async function consume(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _item of iterable) { /* consume */ }
}
