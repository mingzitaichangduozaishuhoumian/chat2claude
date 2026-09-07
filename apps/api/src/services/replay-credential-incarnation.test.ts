import { describe, expect, it } from 'vitest';
import type { ChatGptBackendClient, ChatGptCompletionRequest, ChatGptInputItem, ChatGptReplayItem } from '@chatgpt-to-claude/chatgpt-backend';
import { AccountPool } from './account-pool.js';
import { bindRequestHistory } from './request-history-binding.js';
import { RefreshAwareChatGptBackend } from './refresh-aware-backend.js';
import { SessionCredentialManager } from './session-credential-manager.js';
import { CodexOAuthClient } from './codex-oauth-client.js';
import { ModelRegistry } from './model-registry.js';
import { RuntimeApiKeys } from './runtime-api-keys.js';
import { SetupProvisioner } from './setup-provisioner.js';
import { ReasoningReplayStore } from './reasoning-replay-store.js';
import { ResponsesStore } from './responses-store.js';
import { RequestReasoningReplay } from './request-reasoning-replay.js';

const backend: ChatGptBackendClient = {
  async listModels() { return [{ id: 'model' }]; },
  async complete() { return { text: '', finishReason: 'stop' }; },
  async *stream() { yield { type: 'done', finishReason: 'stop' }; },
};
const replayItems: ChatGptReplayItem[] = [
  { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'OLD_IDENTITY_CIPHER_CANARY' },
  { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' },
];
const input: ChatGptInputItem[] = [
  { type: 'function_call', callId: 'call_1', name: 'lookup', arguments: {} },
  { type: 'function_call_output', callId: 'call_1', output: 'ok' },
];
function fixture(upstreamId?: string) {
  const pool = new AccountPool({ seedMockAccount: false });
  pool.add({ id: 'chatgpt-primary', provider: 'chatgpt-session', secret: { accessToken: 'old-token', refreshToken: 'old-refresh', ...(upstreamId ? { accountId: upstreamId } : {}) } });
  const before = pool.get('chatgpt-primary')!;
  const scope = { owner: 'owner', provider: 'chatgpt-session' as const, model: 'model' };
  const implicit = new ReasoningReplayStore();
  implicit.put(scope, before, { replayEligible: true, replayItems });
  const native = new ResponsesStore();
  native.put('owner', { model: 'model', input: 'first' }, { id: 'resp_one', object: 'response', created_at: 0, model: 'model', status: 'completed', output: [], output_text: '', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }, { account: before, model: 'model', output: replayItems.map((item) => ({ ...item })) });
  const provisioner = new SetupProvisioner({ accountPool: pool, modelRegistry: new ModelRegistry(), runtimeApiKeys: new RuntimeApiKeys(), backend });
  return { pool, before, scope, implicit, native, provisioner };
}
function assertOldReplayRejected(f: ReturnType<typeof fixture>) {
  const current = f.pool.get(f.before.id)!;
  expect(current.incarnation).not.toBe(f.before.incarnation);
  const implicit = new RequestReasoningReplay(f.implicit, f.scope, input);
  const request: ChatGptCompletionRequest = { model: 'model', maxTokens: 64, messages: [], inputItems: structuredClone(input) };
  expect(implicit.eligible(current, 'model')).toBe(false);
  expect(() => implicit.apply(request, current, f.pool)).toThrow();
  expect(request.inputItems).toEqual(input);
  const native = f.native.get('owner', 'resp_one')!;
  expect(native.accepts(current, 'model')).toBe(false);
  expect(() => native.expand('next', current, 'model')).toThrow();
}

describe('credential lifecycle replay incarnation', () => {
  it('rotates legacy unknown identity on actual SetupProvisioner reauthorization', async () => {
    const f = fixture();
    await f.provisioner.provisionTarget({ mode: 'reauthorize', accountId: f.before.id }, { type: 'chatgpt-session', accessToken: 'new-token', accountId: 'different-upstream' });
    expect(f.pool.get(f.before.id)?.secret?.accountId).toBe('different-upstream');
    assertOldReplayRejected(f);
  });
  it('keeps proven identical upstream identity through reauthorization and refresh', async () => {
    const f = fixture('same-upstream');
    await f.provisioner.provisionTarget({ mode: 'reauthorize', accountId: f.before.id }, { type: 'chatgpt-session', accessToken: 'new-token', accountId: 'same-upstream' });
    const authorized = f.pool.get(f.before.id)!;
    expect(authorized.incarnation).toBe(f.before.incarnation);
    const refreshed = f.pool.compareAndSwapSessionSecret(authorized.id, authorized.secret!, { ...authorized.secret!, accessToken: 'renewed', refreshToken: 'renewed-refresh' }, authorized.incarnation)!;
    expect(refreshed.incarnation).toBe(f.before.incarnation);
    expect(f.implicit.find(f.scope, input)?.apply(input, refreshed, 'model')).toContainEqual({ type: 'replay', item: replayItems[0] });
    expect(f.native.get('owner', 'resp_one')?.expand('next', refreshed, 'model')).toHaveLength(4);
  });
  it('rejects explicitly different upstream identity through SetupProvisioner', async () => {
    const f = fixture('old-upstream');
    await expect(f.provisioner.provisionTarget({ mode: 'reauthorize', accountId: f.before.id }, { type: 'chatgpt-session', accessToken: 'new-token', accountId: 'different-upstream' })).rejects.toMatchObject({ diagnostic: { code: 'reauthorization_identity_mismatch' } });
    expect(f.pool.get(f.before.id)).toEqual(f.before);
  });
  it.each(['patch', 'swap', 'delete-recreate'] as const)('invalidates old replay at the account lifecycle boundary: %s', (mode) => {
    const f = fixture();
    if (mode === 'patch') f.pool.update(f.before.id, { secret: { accessToken: 'new-token', accountId: 'new-upstream' } });
    if (mode === 'swap') f.pool.compareAndSwapSessionSecret(f.before.id, f.before.secret!, { type: 'chatgpt-session', accessToken: 'new-token', accountId: 'new-upstream' }, f.before.incarnation);
    if (mode === 'delete-recreate') { f.pool.remove(f.before.id); f.pool.add({ id: f.before.id, provider: f.before.provider, secret: f.before.secret }); }
    assertOldReplayRejected(f);
  });
  it('does not infer reauthorization identity from inherited legacy metadata', async () => {
    const f = fixture('old-upstream');
    await f.provisioner.provision({ type: 'chatgpt-session', accessToken: 'new-token' });
    assertOldReplayRejected(f);
  });
  it.each([false, true])('does not dispatch expanded replay after an uncertain proactive refresh: stream=%s', async (stream) => {
    const f = fixture();
    f.pool.update(f.before.id, { secret: { ...f.before.secret, expiresAt: '2000-01-01T00:00:00.000Z' } });
    const account = f.pool.get(f.before.id)!;
    let dispatched = false;
    const transport: ChatGptBackendClient = {
      ...backend,
      async complete() { dispatched = true; return { text: '', finishReason: 'stop' }; },
      async *stream() { dispatched = true; yield { type: 'done', finishReason: 'stop' }; },
    };
    const wrapper = new RefreshAwareChatGptBackend(transport, new SessionCredentialManager({ accountPool: f.pool, oauthClient: new CodexOAuthClient({ fetch: async () => Response.json({ access_token: 'renewed' }) }) }));
    const request: ChatGptCompletionRequest = { model: 'model', maxTokens: 64, messages: [], inputItems: replayItems.map((item) => ({ type: 'replay', item })) };
    bindRequestHistory(request, account);
    const run = async () => {
      if (stream) { for await (const _ of wrapper.stream(request, { account })) { /* drain */ } }
      else await wrapper.complete(request, { account });
    };
    await expect(run()).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(dispatched).toBe(false);
    expect(f.pool.get(account.id)?.incarnation).not.toBe(account.incarnation);
  });
  it('does not invalidate replay for an account label/health-only update', () => {
    const f = fixture();
    f.pool.update(f.before.id, { label: 'renamed', status: 'available' });
    expect(f.pool.get(f.before.id)?.incarnation).toBe(f.before.incarnation);
  });
});
