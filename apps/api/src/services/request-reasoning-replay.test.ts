import { describe, expect, it } from 'vitest';
import type { ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
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
