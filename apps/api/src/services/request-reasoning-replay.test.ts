import { describe, expect, it } from 'vitest';
import type { ChatGptCompletionRequest, ChatGptInputItem, ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
import { AccountPool } from './account-pool.js';
import { ReasoningReplayStore } from './reasoning-replay-store.js';
import { RequestReasoningReplay } from './request-reasoning-replay.js';

const canary = 'STREAM_COMMIT_CANARY';
const scope = { owner: 'owner', provider: 'chatgpt-session' as const, model: 'model' };
const done: ChatGptStreamEvent = { type: 'done', finishReason: 'tool_calls', replayEligible: true, replayItems: [
  { type: 'reasoning', id: 'rs', summary: [], encrypted_content: canary },
  { type: 'function_call', id: 'fc', call_id: 'call', name: 'lookup', arguments: '{}' },
] };

describe('request replay commit barrier', () => {
  it.each(['success', 'error-before', 'error-after', 'EOF', 'abort', 'consumer-cancel', 'account-recreated'] as const)('commits only after successful backend terminal and disposal: %s', async (mode) => {
    const store = new ReasoningReplayStore();
    const pool = new AccountPool({ seedMockAccount: false });
    pool.add({ id: 'a', provider: 'chatgpt-session' });
    const account = pool.get('a')!;
    const replay = new RequestReasoningReplay(store, scope, []);
    const controller = new AbortController();
    let disposed = false;
    async function* backend(): AsyncIterable<ChatGptStreamEvent> {
      try {
        yield { type: 'text_delta', text: 'text' };
        if (mode === 'error-before') throw new Error(canary);
        if (mode === 'EOF') return;
        yield done;
        if (mode === 'error-after') throw new Error(canary);
        if (mode === 'abort') controller.abort();
        if (mode === 'account-recreated') { pool.remove('a'); pool.add({ id: 'a', provider: 'chatgpt-session' }); }
      } finally { disposed = true; }
    }
    const seen: ChatGptStreamEvent[] = [];
    const wrapped = replay.stream(backend(), account, 'model', pool, controller.signal);
    try {
      for await (const event of wrapped) {
        seen.push(event);
        if (mode === 'consumer-cancel') break;
        if (event.type === 'done') {
          expect(disposed).toBe(true);
          if (mode === 'success') expect(store.stats().records).toBe(1);
        }
      }
    } catch { /* transport errors remain owned by the route error mapper */ }
    expect(store.stats().records).toBe(mode === 'success' ? 1 : 0);
    expect(JSON.stringify(seen)).not.toMatch(/STREAM_COMMIT_CANARY|replayItems|replayEligible/);
    expect(disposed).toBe(true);
  });
});

describe('opt-in public replay handoff', () => {
  function fixture(owner = scope.owner, model = scope.model, enabled = true) {
    const pool = new AccountPool({ seedMockAccount: false });
    pool.add({ id: 'source', provider: 'chatgpt-session' });
    pool.add({ id: 'web', provider: 'chatgpt-web' });
    pool.add({ id: 'other-account', provider: 'chatgpt-session' });
    const source = pool.get('source')!;
    const web = pool.get('web')!;
    const store = new ReasoningReplayStore();
    store.put(scope, source, done as Extract<ChatGptStreamEvent, { type: 'done' }>);
    const input: ChatGptInputItem[] = [
      { type: 'message', role: 'user', content: 'inspect' },
      { type: 'function_call', callId: 'call', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', callId: 'call', output: 'visible result' },
    ];
    const replay = new RequestReasoningReplay(store, { ...scope, owner, model }, input, enabled);
    const request: ChatGptCompletionRequest = { model, maxTokens: 16, messages: [], inputItems: input };
    return { pool, source, web, replay, request };
  }

  it('keeps native replay on its original account and only public contracts on another provider', () => {
    const native = fixture();
    expect(native.replay.eligible(native.source, 'model')).toBe(true);
    native.replay.apply(native.request, native.source, native.pool);
    expect(JSON.stringify(native.request)).toContain(canary);
    const handed = fixture();
    expect(handed.replay.eligible(handed.web, 'web-model')).toBe(true);
    handed.request.model = 'web-model';
    handed.replay.apply(handed.request, handed.web, handed.pool);
    expect(JSON.stringify(handed.request)).not.toContain(canary);
    expect(handed.request.inputItems).toContainEqual({ type: 'function_call', callId: 'call', name: 'lookup', arguments: '{}' });
    expect(handed.request.inputItems).toContainEqual({ type: 'function_call_output', callId: 'call', output: 'visible result' });
  });

  it('finds the same owner call group across an explicit model change without transferring ciphertext', () => {
    const f = fixture(scope.owner, 'new-model');
    expect(f.replay.eligible(f.source, 'new-model')).toBe(true);
    f.replay.apply(f.request, f.source, f.pool);
    expect(JSON.stringify(f.request)).not.toContain(canary);
  });

  it('preserves same-provider same-model account affinity even with handoff enabled', () => {
    const f = fixture();
    expect(f.replay.eligible(f.pool.get('other-account')!, 'model')).toBe(false);
    expect(() => f.replay.apply(f.request, f.pool.get('other-account')!, f.pool)).toThrow('No available account');
    const disabled = fixture(scope.owner, scope.model, false);
    expect(disabled.replay.eligible(disabled.web, 'web-model')).toBe(false);
  });

  it('never uses another owner stored replay as native or handoff provenance', () => {
    const f = fixture('another-owner', 'new-model');
    f.replay.apply(f.request, f.source, f.pool);
    expect(JSON.stringify(f.request)).not.toContain(canary);
    expect(f.request.inputItems).not.toContainEqual(expect.objectContaining({ type: 'replay' }));
  });
});
