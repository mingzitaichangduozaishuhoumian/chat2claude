import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { SessionChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { apiKeyAuth } from '../middleware/auth.js';
import { AccountPool } from '../services/account-pool.js';
import { ModelRegistry } from '../services/model-registry.js';
import { ResponsesStore } from '../services/responses-store.js';
import { RequestLog } from '../services/request-log.js';
import { RuntimeApiKeys } from '../services/runtime-api-keys.js';
import { SessionCredentialManager } from '../services/session-credential-manager.js';
import { CodexOAuthClient } from '../services/codex-oauth-client.js';
import { RefreshAwareChatGptBackend } from '../services/refresh-aware-backend.js';
import { createOpenAiResponsesRoute } from './openai-responses.js';

const cipher = 'HISTORY_REFRESH_CIPHER_CANARY';
const history = 'OLD_USER_TEXT_CANARY';
function fixture(opaque: boolean, identity: 'unknown' | 'different' | 'same', gate?: { promise: Promise<void>; started: () => void }) {
  let now = Date.parse('2026-09-01T00:00:00Z');
  const clock = () => new Date(now);
  const pool = new AccountPool({ seedMockAccount: false });
  pool.add({ id: 'local-private-account', provider: 'chatgpt-session', secret: { accessToken: 'old-token', refreshToken: 'refresh-token', expiresAt: new Date(now + 120_000).toISOString(), ...(identity === 'unknown' ? {} : { accountId: 'old-upstream' }) } });
  const account = pool.get('local-private-account')!;
  const registry = new ModelRegistry();
  registry.replaceAccountModels({ accountId: account.id, createdAt: account.createdAt }, [{ id: 'model' }]);
  const captured: any[] = [];
  const transport = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
    captured.push(JSON.parse(String(init?.body)));
    const output = [
      ...(opaque ? [{ type: 'reasoning', id: 'rs_one', summary: [], encrypted_content: cipher }] : []),
      { type: 'message', id: 'msg_one', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }] },
    ];
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`);
  } });
  const refresh = vi.fn(async () => {
    gate?.started();
    if (gate) await gate.promise;
    return Response.json({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600, id_token: `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: identity === 'same' ? 'old-upstream' : 'new-upstream' } })).toString('base64url')}.signature` });
  });
  const backend = new RefreshAwareChatGptBackend(transport, new SessionCredentialManager({ accountPool: pool, now: clock, oauthClient: new CodexOAuthClient({ now: clock, fetch: refresh }) }));
  const store = new ResponsesStore();
  const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const app = new Hono();
  app.use('*', apiKeyAuth(['owner'], new RuntimeApiKeys()));
  app.route('/', createOpenAiResponsesRoute({ backend, accountPool: pool, modelRegistry: registry, responsesStore: store, requestLog: new RequestLog(), backendProvider: 'session', logger: logs }));
  const post = async (body: Record<string, unknown>, signal?: AbortSignal) => app.request('/v1/responses', { signal, method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'owner' }, body: JSON.stringify({ model: 'model', input: 'next', ...body }) });
  return { post, pool, account, captured, refresh, logs, expire: () => { now += 180_000; } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('native history affinity across actual credential refresh', () => {
  for (const stream of [false, true]) it.each([false, true])(`does not poison concurrent reauthorization while old refresh awaits, stream=${stream}, cancel=%s`, async (cancel) => {
    const gate = deferred();
    const started = deferred();
    const f = fixture(false, 'unknown', { promise: gate.promise, started: started.resolve });
    const { id } = await (await f.post({ input: history })).json() as { id: string };
    f.expire();
    const controller = new AbortController();
    const pending = f.post({ previous_response_id: id, stream }, controller.signal).then(async (response) => ({ status: response.status, body: await response.text() }));
    await started.promise;
    f.pool.commitProvisionedSession({ id: f.account.id, secret: { accessToken: 'replacement-token', refreshToken: 'replacement-refresh', accountId: 'replacement-upstream', expiresAt: '2099-01-01T00:00:00Z' } }, new Date());
    const replacement = f.pool.get(f.account.id)!;
    expect(replacement.incarnation).not.toBe(f.account.incarnation);
    if (cancel) controller.abort();
    gate.resolve();
    if (cancel) expect((await pending).status).toBe(499);
    else {
      const result = await pending;
      if (!cancel) {
        expect(result.status).toBe(400);
        expect(result.body).toContain('invalid_request_error');
        for (const value of [history, id, f.account.id, 'replacement-upstream']) expect(result.body).not.toContain(value);
      }
    }
    await vi.waitFor(() => expect(f.pool.get(f.account.id)?.currentConcurrency).toBe(0));
    expect(f.captured).toHaveLength(1);
    expect(f.pool.get(f.account.id)).toMatchObject({ status: 'available', cooldownUntil: null, healthRevision: replacement.healthRevision, secret: replacement.secret });
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect((await f.post({ input: 'ordinary' })).status).toBe(200);
  });
  it.each([false, true])('cancels history during refresh without dispatch or unhealthy release, stream=%s', async (stream) => {
    const gate = deferred();
    const started = deferred();
    const f = fixture(false, 'different', { promise: gate.promise, started: started.resolve });
    const { id } = await (await f.post({ input: history })).json() as { id: string };
    f.expire();
    const abort = new AbortController();
    const pending = f.post({ previous_response_id: id, stream }, abort.signal).then((response) => response.text());
    await started.promise;
    abort.abort();
    gate.resolve();
    expect(await pending).toContain('Request cancelled.');
    await vi.waitFor(() => expect(f.pool.get(f.account.id)?.currentConcurrency).toBe(0));
    expect(f.captured).toHaveLength(1);
    expect(f.pool.get(f.account.id)).toMatchObject({ status: 'available', currentConcurrency: 0, cooldownUntil: null });
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect((await f.post({ input: 'ordinary' })).status).toBe(200);
  });

  it.each([false, true])('keeps concurrent ordinary requests independent of rejected history, stream=%s', async (stream) => {
    const gate = deferred();
    const started = deferred();
    const f = fixture(true, 'different', { promise: gate.promise, started: started.resolve });
    f.pool.update(f.account.id, { maxConcurrency: 2 });
    const { id } = await (await f.post({ input: history })).json() as { id: string };
    f.expire();
    const rejected = f.post({ previous_response_id: id, stream }).then((response) => response.text());
    await started.promise;
    const ordinary = f.post({ input: 'concurrent ordinary' }).then(async (response) => { expect(response.status).toBe(200); return response.text(); });
    gate.resolve();
    const [failure] = await Promise.all([rejected, ordinary]);
    expect(failure).toContain('invalid_request_error');
    expect(f.captured).toHaveLength(2);
    expect(JSON.stringify(f.captured[1])).not.toContain(history);
    expect(f.pool.get(f.account.id)).toMatchObject({ status: 'available', currentConcurrency: 0, cooldownUntil: null });
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });
  for (const opaque of [false, true]) for (const stream of [false, true]) {
    it.each(['unknown', 'different', 'same'] as const)(`protects ${opaque ? 'opaque' : 'text'} history, stream=${stream}, identity=%s`, async (identity) => {
      const f = fixture(opaque, identity);
      const first = await f.post({ input: history });
      expect(first.status).toBe(200);
      const { id } = await first.json() as { id: string };
      f.expire();
      const response = await f.post({ previous_response_id: id, stream });
      const body = await response.text();
      if (identity === 'same') {
        expect(response.status).toBe(200);
        if (stream) expect(body).toContain('event: response.completed');
        expect(f.captured).toHaveLength(2);
        expect(JSON.stringify(f.captured[1])).toContain(history);
        expect(f.pool.get(f.account.id)?.incarnation).toBe(f.account.incarnation);
      } else {
        expect(f.captured).toHaveLength(1);
        expect(response.status).toBe(400);
        expect(body).toContain('invalid_request_error');
        if (stream) expect(body).not.toMatch(/event:|data:/);
        for (const value of [cipher, history, id, f.account.id, 'old-upstream', 'new-upstream']) expect(body).not.toContain(value);
        expect(f.pool.get(f.account.id)?.incarnation).not.toBe(f.account.incarnation);
      }
      expect(f.refresh).toHaveBeenCalledTimes(1);
      expect(f.pool.get(f.account.id)).toMatchObject({ status: 'available', currentConcurrency: 0, cooldownUntil: null, lastError: null });
      const ordinary = await f.post({ input: 'ordinary request', stream });
      expect(ordinary.status).toBe(200);
      const ordinaryBody = await ordinary.text();
      if (stream) expect(ordinaryBody).toContain('event: response.completed');
      expect(f.captured).toHaveLength(identity === 'same' ? 3 : 2);
      expect(JSON.stringify(f.captured.at(-1))).not.toContain(history);
      expect(JSON.stringify(f.logs)).not.toContain(cipher);
      expect(f.pool.get(f.account.id)?.currentConcurrency).toBe(0);
    });
  }
});
