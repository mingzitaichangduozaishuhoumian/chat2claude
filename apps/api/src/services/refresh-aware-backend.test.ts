import { describe, expect, it } from 'vitest';
import { ChatGptBackendError, SessionChatGptBackend, type ChatGptBackendClient, type ChatGptBackendRequestContext, type ChatGptCompletionRequest } from '@chatgpt-to-claude/chatgpt-backend';
import { AccountPool } from './account-pool.js';
import { CodexOAuthClient } from './codex-oauth-client.js';
import { RefreshAwareChatGptBackend } from './refresh-aware-backend.js';
import { SessionCredentialManager } from './session-credential-manager.js';

const request: ChatGptCompletionRequest = { model: 'model', maxTokens: 10, messages: [{ role: 'user', content: 'hi' }] };

function setup(backend: ChatGptBackendClient) {
  const pool = new AccountPool();
  pool.add({ id: 'session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accountId: 'session-upstream', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: '2026-08-22T02:00:00.000Z' } });
  let refreshes = 0;
  const oauthClient = new CodexOAuthClient({ now: () => new Date('2026-08-22T00:00:00.000Z'), fetch: async () => {
    refreshes += 1;
    return Response.json({ access_token: `access-${refreshes + 1}`, refresh_token: `refresh-${refreshes + 1}`, expires_in: 3600 });
  } });
  const wrapper = new RefreshAwareChatGptBackend(backend, new SessionCredentialManager({ accountPool: pool, oauthClient, now: () => new Date('2026-08-22T00:00:00.000Z') }));
  return { wrapper, pool, getRefreshes: () => refreshes, context: { account: pool.get('session')! } };
}

describe('RefreshAwareChatGptBackend', () => {
  it.each(['stream', 'complete', 'models', 'discover', 'quota'] as const)('does not refresh or dispatch pre-aborted %s with expiring credentials', async (operation) => {
    let calls = 0;
    const transport = backendFrom({
      async complete() { calls++; return { text: '', finishReason: 'stop' }; },
      async *stream() { calls++; yield { type: 'done' as const }; },
      async listModels() { calls++; return []; },
      async discoverModels() { calls++; return { models: [], status: 'empty' }; },
      async getAccountQuota() { calls++; return { windows: [] }; },
    });
    const { wrapper, context, pool, getRefreshes } = setup(transport);
    pool.update('session', { secret: { ...pool.get('session')!.secret, expiresAt: '2026-08-22T00:00:30.000Z' } });
    const ctx = { ...context, signal: AbortSignal.abort('sensitive cancellation reason') };
    await expect((async () => {
      if (operation === 'stream') for await (const _event of wrapper.stream(request, ctx)) { /* consume */ }
      else if (operation === 'complete') await wrapper.complete(request, ctx);
      else if (operation === 'models') await wrapper.listModels(ctx);
      else if (operation === 'discover') await wrapper.discoverModels!(ctx);
      else await wrapper.getAccountQuota(ctx);
    })()).rejects.toMatchObject({ name: 'AbortError' });
    expect(getRefreshes()).toBe(0);
    expect(calls).toBe(0);
  });

  it.each(['stream', 'complete', 'models', 'quota'] as const)('checks cancellation before retrying a transport 401 for %s', async (operation) => {
    const controller = new AbortController();
    let calls = 0;
    const fail = () => { calls++; controller.abort(); throw unauthorized(); };
    const { wrapper, context, getRefreshes } = setup(backendFrom({
      async complete() { return fail(); }, async *stream() { fail(); },
      async listModels() { return fail(); }, async getAccountQuota() { return fail(); },
    }));
    const ctx = { ...context, signal: controller.signal };
    await expect((async () => {
      if (operation === 'stream') for await (const _event of wrapper.stream(request, ctx)) { /* consume */ }
      else if (operation === 'complete') await wrapper.complete(request, ctx);
      else if (operation === 'models') await wrapper.listModels(ctx);
      else await wrapper.getAccountQuota(ctx);
    })()).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
    expect(getRefreshes()).toBe(0);
  });

  it('advertises reset only for capable transports and never retries a consume 401', async () => {
    expect(setup(backendFrom({})).wrapper.consumeAccountResetCredit).toBeUndefined();
    const ids: string[] = [];
    const transport = backendFrom({ consumeAccountResetCredit: async (id) => {
      ids.push(id); if (ids.length === 1) throw unauthorized();
    } });
    const { wrapper, context, getRefreshes } = setup(transport);
    await expect(wrapper.consumeAccountResetCredit!('synthetic-id', context)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(ids).toEqual(['synthetic-id']);
    expect(getRefreshes()).toBe(0);
  });

  it.each(['stream', 'complete', 'models', 'quota'] as const)('waits for rejected async 401 body cleanup before refreshing and retrying %s', async (operation) => {
    let finishCancel!: () => void;
    const gate = new Promise<void>((resolve) => { finishCancel = resolve; });
    let cancelling!: () => void;
    const cancelled = new Promise<void>((resolve) => { cancelling = resolve; });
    let cancelCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      // End diagnostic reading before its shared deadline so this tests pending
      // async cleanup, rather than expecting a second budget after a stalled read.
      start(stream) { stream.enqueue(new Uint8Array(65 * 1024)); },
      async cancel() { cancelCalls += 1; cancelling(); await gate; throw new Error('cleanup failed'); },
    });
    let calls = 0;
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 60_000,
      fetch: async () => {
        if (++calls === 1) return new Response(body, { status: 401 });
        if (operation === 'models') return Response.json({ models: [{ id: 'model' }] });
        if (operation === 'quota') return Response.json({ rate_limit: {} });
        return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');
      },
    });
    const { wrapper, context, getRefreshes } = setup(backend);
    let finished = false;
    const pending = (async () => {
      if (operation === 'stream') for await (const _event of wrapper.stream(request, context)) { /* consume */ }
      else if (operation === 'complete') await wrapper.complete(request, context);
      else if (operation === 'models') await wrapper.listModels(context);
      else await wrapper.getAccountQuota(context);
      finished = true;
    })();
    await cancelled;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      expect(finished).toBe(false);
      expect(calls).toBe(1);
      expect(getRefreshes()).toBe(0);
    } finally { finishCancel(); }
    await pending;
    expect(finished).toBe(true);
    expect(calls).toBe(operation === 'quota' ? 3 : 2);
    expect(cancelCalls).toBe(1);
    expect(getRefreshes()).toBe(1);
    expect(body.locked).toBe(false);
  });

  it.each(['stream', 'complete', 'models', 'quota', 'consume'] as const)('preserves abort during async 401 cleanup without OAuth refresh for %s', async (operation) => {
    let finishCancel!: () => void;
    const gate = new Promise<void>((resolve) => { finishCancel = resolve; });
    let started!: () => void;
    const cancelling = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 60_000,
      fetch: async () => {
        calls++;
        return new Response(new ReadableStream({ async cancel() { started(); await gate; } }), { status: 401 });
      },
    });
    const { wrapper, context, getRefreshes } = setup(backend);
    const controller = new AbortController();
    const ctx = { ...context, signal: controller.signal };
    const pending = (async () => {
      if (operation === 'stream') for await (const _event of wrapper.stream(request, ctx)) { /* consume */ }
      else if (operation === 'complete') await wrapper.complete(request, ctx);
      else if (operation === 'models') await wrapper.listModels(ctx);
      else if (operation === 'quota') await wrapper.getAccountQuota(ctx);
      else await wrapper.consumeAccountResetCredit!('11111111-1111-4111-8111-111111111111', ctx);
    })();
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await cancelling;
    controller.abort();
    finishCancel();
    await assertion;
    expect(calls).toBe(1);
    expect(getRefreshes()).toBe(0);
  });

  it('preserves typed discovery results across the existing unauthorized retry', async () => {
    const tokens: string[] = [];
    const result = { models: [{ id: 'synthetic-model' }], status: 'partial' as const, diagnostic: {
      clientVersion: '1.2.3', httpStatus: 200, contentType: 'json' as const, envelope: 'models' as const,
      candidateCount: 2, acceptedCount: 1, rejectedCount: 1, duplicateCount: 0, reasons: ['invalid_model_id' as const],
    } };
    const backend = backendFrom({ discoverModels: async (context) => {
      tokens.push(context?.account?.secret?.accessToken ?? '');
      if (tokens.length === 1) throw unauthorized();
      return result;
    } });
    const { wrapper, context, getRefreshes } = setup(backend);
    await expect(wrapper.discoverModels!(context)).resolves.toBe(result);
    expect(tokens).toEqual(['access-1', 'access-2']);
    expect(getRefreshes()).toBe(1);
  });

  it('does not advertise typed discovery when the wrapped provider lacks it', () => {
    expect(setup(backendFrom({})).wrapper.discoverModels).toBeUndefined();
  });

  it('refreshes and retries once after the first unauthorized response', async () => {
    const tokens: string[] = [];
    const backend = backendFrom({ complete: async (_request, context) => {
      const token = context?.account?.secret?.accessToken ?? '';
      tokens.push(token);
      if (token === 'access-1') throw unauthorized();
      return { text: 'ok', finishReason: 'stop' };
    } });
    const { wrapper, context, pool, getRefreshes } = setup(backend);
    await expect(wrapper.complete(request, context)).resolves.toMatchObject({ text: 'ok' });
    expect(tokens).toEqual(['access-1', 'access-2']);
    expect(getRefreshes()).toBe(1);
    expect(pool.get('session')?.secret).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
  });

  it('does not loop when the retry is also unauthorized', async () => {
    let calls = 0;
    const backend = backendFrom({ complete: async () => { calls += 1; throw unauthorized(); } });
    const { wrapper, context, getRefreshes } = setup(backend);
    await expect(wrapper.complete(request, context)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(calls).toBe(2);
    expect(getRefreshes()).toBe(1);
  });

  it('retries streaming only before the first emitted event', async () => {
    let calls = 0;
    const backend = backendFrom({ stream: async function* (_request, context) {
      calls += 1;
      if (context?.account?.secret?.accessToken === 'access-1') throw unauthorized();
      yield { type: 'text_delta', text: 'ok' } as const;
      yield { type: 'done' } as const;
    } });
    const { wrapper, context, getRefreshes } = setup(backend);
    const events = [];
    for await (const event of wrapper.stream(request, context)) events.push(event);
    expect(events).toEqual([{ type: 'text_delta', text: 'ok' }, { type: 'done' }]);
    expect(calls).toBe(2);
    expect(getRefreshes()).toBe(1);
  });

  it('does not replay streaming after any event was emitted', async () => {
    let calls = 0;
    const backend = backendFrom({ stream: async function* () {
      calls += 1;
      yield { type: 'text_delta', text: 'partial' } as const;
      throw unauthorized();
    } });
    const { wrapper, context, getRefreshes } = setup(backend);
    const iterator = wrapper.stream(request, context)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: { type: 'text_delta', text: 'partial' }, done: false });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(calls).toBe(1);
    expect(getRefreshes()).toBe(0);
  });

  it('proactively refreshes canonical credentials before quota fetch', async () => {
    const tokens: string[] = [];
    const backend = backendFrom({ getAccountQuota: async (context) => {
      tokens.push(context?.account?.secret?.accessToken ?? '');
      return { windows: [] };
    } });
    const { wrapper, context, pool } = setup(backend);
    pool.update('session', { secret: { ...pool.get('session')!.secret, expiresAt: '2026-08-22T00:00:30.000Z' } });

    await expect(wrapper.getAccountQuota!(context)).resolves.toEqual({ windows: [] });
    expect(tokens).toEqual(['access-2']);
  });

  it('retries quota exactly once after unauthorized and stops after a second unauthorized', async () => {
    const tokens: string[] = [];
    const backend = backendFrom({ getAccountQuota: async (context) => {
      tokens.push(context?.account?.secret?.accessToken ?? '');
      throw unauthorized();
    } });
    const { wrapper, context, getRefreshes } = setup(backend);

    await expect(wrapper.getAccountQuota!(context)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(tokens).toEqual(['access-1', 'access-2']);
    expect(getRefreshes()).toBe(1);
  });
});

function unauthorized() {
  return new ChatGptBackendError('Unauthorized', 'unauthorized', { status: 401 });
}

function backendFrom(overrides: Partial<ChatGptBackendClient>): ChatGptBackendClient {
  return {
    async listModels(_context?: ChatGptBackendRequestContext) { return []; },
    async complete() { return { text: '', finishReason: 'stop' }; },
    async *stream() { yield { type: 'done' as const }; },
    ...overrides,
  };
}
