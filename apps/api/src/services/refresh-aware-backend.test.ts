import { describe, expect, it } from 'vitest';
import { ChatGptBackendError, type ChatGptBackendClient, type ChatGptBackendRequestContext, type ChatGptCompletionRequest } from '@chatgpt-to-claude/chatgpt-backend';
import { AccountPool } from './account-pool.js';
import { CodexOAuthClient } from './codex-oauth-client.js';
import { RefreshAwareChatGptBackend } from './refresh-aware-backend.js';
import { SessionCredentialManager } from './session-credential-manager.js';

const request: ChatGptCompletionRequest = { model: 'model', maxTokens: 10, messages: [{ role: 'user', content: 'hi' }] };

function setup(backend: ChatGptBackendClient) {
  const pool = new AccountPool();
  pool.add({ id: 'session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: '2026-08-22T02:00:00.000Z' } });
  let refreshes = 0;
  const oauthClient = new CodexOAuthClient({ now: () => new Date('2026-08-22T00:00:00.000Z'), fetch: async () => {
    refreshes += 1;
    return Response.json({ access_token: `access-${refreshes + 1}`, refresh_token: `refresh-${refreshes + 1}`, expires_in: 3600 });
  } });
  const wrapper = new RefreshAwareChatGptBackend(backend, new SessionCredentialManager({ accountPool: pool, oauthClient, now: () => new Date('2026-08-22T00:00:00.000Z') }));
  return { wrapper, pool, getRefreshes: () => refreshes, context: { account: pool.get('session')! } };
}

describe('RefreshAwareChatGptBackend', () => {
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
