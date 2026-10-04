import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionChatGptBackend } from './session.js';

const context = { account: { id: 'synthetic', secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic' } } };
const redemptionId = '00000000-0000-4000-8000-000000000000';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('short session operations with stalled response cleanup', () => {
  it.each(['discovery', 'quota', 'redemption'] as const)('bounds %s cleanup after receiving HTTP status', async (operation) => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: operation === 'redemption' ? 200 : 401 }));
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', requestTimeoutMs: 60_000, fetch });
    const pending = (operation === 'discovery' ? backend.listModels(context)
      : operation === 'quota' ? backend.getAccountQuota(context) : backend.consumeAccountResetCredit(redemptionId, context));
    let outcome: unknown = 'pending';
    const settled = pending.then(() => { outcome = 'success'; }, (error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(250);
    if (operation === 'redemption') expect(outcome).toBe('success');
    else expect(outcome).toMatchObject({ code: 'unauthorized', status: 401 });
    await settled;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['discovery', 'quota', 'redemption'] as const)('keeps cancellation and timeout effective during %s cleanup', async (operation) => {
    for (const mode of ['abort', 'timeout'] as const) {
      vi.useFakeTimers();
      const caller = new AbortController();
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const backend = new SessionChatGptBackend({
        baseUrl: 'https://synthetic.invalid', requestTimeoutMs: mode === 'timeout' ? 20 : 60_000,
        fetch: async () => new Response(new ReadableStream({ cancel }), { status: 401 }),
      });
      const requestContext = { ...context, signal: caller.signal };
      const pending = (operation === 'discovery' ? backend.listModels(requestContext)
        : operation === 'quota' ? backend.getAccountQuota(requestContext) : backend.consumeAccountResetCredit(redemptionId, requestContext));
      let outcome: unknown = 'pending';
      const settled = pending.catch((error: unknown) => { outcome = error; });
      await vi.advanceTimersByTimeAsync(5);
      if (mode === 'abort') caller.abort();
      await vi.advanceTimersByTimeAsync(245);
      expect(outcome).toMatchObject(mode === 'abort' ? { name: 'AbortError' } : { code: 'timeout', status: 504 });
      await settled;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });
});
