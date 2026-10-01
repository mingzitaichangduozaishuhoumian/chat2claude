import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend, parseResponsesReplayItem, RESPONSES_INPUT_REPLAY_LIMITS, ResponsesReplayBudget, type ChatGptCompletionRequest, type ChatGptReasoningReplayItem } from './index.js';

const context = { account: { id: 'synthetic-account', provider: 'chatgpt-session' as const, secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic-token' } } };
const request: ChatGptCompletionRequest = { model: 'synthetic-model', maxTokens: 16, messages: [] };
function sizedReasoning(bytes: number, id: string): ChatGptReasoningReplayItem {
  const item: ChatGptReasoningReplayItem = { type: 'reasoning', id, summary: [], encrypted_content: '' };
  item.encrypted_content = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(item)));
  return item;
}

describe('explicit Responses history budgets', () => {
  it.each([129, 4096])('sends %s prior function calls without applying the single-turn output count limit', async (count) => {
    let wireInputLength = 0;
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async (_url, init) => {
      wireInputLength = JSON.parse(String(init?.body)).input.length;
      return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');
    } });
    const inputItems: NonNullable<ChatGptCompletionRequest['inputItems']> = Array.from({ length: count }, (_, index) => ({
      type: 'replay', item: { type: 'function_call', call_id: `call_${index}`, name: 'lookup', arguments: '{}' },
    }));
    await expect(backend.complete({ ...request, inputItems }, context)).resolves.toMatchObject({ text: '', finishReason: 'stop' });
    expect(wireInputLength).toBe(count);
  });

  it('accepts exactly 8 MiB for one explicit input item but leaves default output parsing bounded', () => {
    const item = sizedReasoning(RESPONSES_INPUT_REPLAY_LIMITS.itemBytes, 'rs_long');
    expect(parseResponsesReplayItem(item, RESPONSES_INPUT_REPLAY_LIMITS)).toHaveProperty('id', 'rs_long');
    expect(() => parseResponsesReplayItem(item)).toThrowError(expect.objectContaining({ code: 'invalid_response' }));
    expect(() => parseResponsesReplayItem({ ...item, encrypted_content: `${item.encrypted_content}x` }, RESPONSES_INPUT_REPLAY_LIMITS)).toThrowError(expect.objectContaining({ code: 'invalid_response' }));
  });

  it('counts complete UTF-8 JSON wire bytes at the 8 MiB input bundle boundary', () => {
    const first = sizedReasoning(4 * 1024 * 1024, 'rs_first');
    const second = sizedReasoning(4 * 1024 * 1024 - 3, 'rs_second');
    expect(Buffer.byteLength(JSON.stringify([first, second]))).toBe(RESPONSES_INPUT_REPLAY_LIMITS.bundleBytes);
    const exact = new ResponsesReplayBudget(RESPONSES_INPUT_REPLAY_LIMITS);
    expect(() => { exact.add(first); exact.add(second); }).not.toThrow();
    const overflow = new ResponsesReplayBudget(RESPONSES_INPUT_REPLAY_LIMITS);
    overflow.add(first);
    expect(() => overflow.add({ ...second, encrypted_content: `${second.encrypted_content}x` })).toThrowError(expect.objectContaining({ code: 'invalid_response' }));
    const providerOutput = new ResponsesReplayBudget();
    expect(() => providerOutput.add(first)).toThrowError(expect.objectContaining({ code: 'invalid_response' }));
  });

  it('keeps the default provider-output count bound at 128', () => {
    const budget = new ResponsesReplayBudget();
    const item = { type: 'function_call' as const, call_id: 'synthetic-call', name: 'lookup', arguments: '{}' };
    for (let i = 0; i < 128; i++) budget.add(item);
    expect(() => budget.add(item)).toThrowError(expect.objectContaining({ code: 'invalid_response' }));
  });
});
