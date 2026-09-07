import { ChatGptBackendError, type ChatGptCompletionRequest, type ChatGptCompletionResponse, type ChatGptDoneEvent, type ChatGptInputItem, type ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import type { Account, AccountPool } from './account-pool.js';
import { bindRequestHistory } from './request-history-binding.js';
import type { ReasoningReplayMatch, ReasoningReplayStore, ReplayScope } from './reasoning-replay-store.js';

/** Shared implicit-replay policy for Claude Messages and OpenAI Chat only. */
export class RequestReasoningReplay {
  #store: ReasoningReplayStore | undefined;
  #scope: ReplayScope;
  #match: ReasoningReplayMatch | undefined;
  constructor(store: ReasoningReplayStore | undefined, scope: ReplayScope, input: ChatGptInputItem[] | undefined) {
    this.#store = store;
    this.#scope = scope;
    this.#match = store?.find(scope, input);
  }

  eligible(account: Account, model: string): boolean { return !this.#match || this.#match.accepts(account, model); }

  apply(request: ChatGptCompletionRequest, account: Account, pool: AccountPool): void {
    if (!this.#match) return;
    // Recheck after the acquisition await: delete/recreate or a health mutation
    // between allocation and dispatch must never send a bundle to a new identity.
    const current = currentAccount(pool, account);
    if (!current || !this.#match.accepts(current, request.model)) {
      throw new ClaudeApiError('No available account supports the requested model and controls.', 503, 'overloaded_error');
    }
    const input = this.#match.apply(request.inputItems, current, request.model);
    if (input) {
      request.inputItems = input;
      bindRequestHistory(request, current);
    }
  }

  complete(response: Pick<ChatGptCompletionResponse, 'replayItems' | 'replayEligible'>, account: Account, model: string, pool: AccountPool, signal?: AbortSignal): void {
    const current = currentAccount(pool, account);
    if (current && model === this.#scope.model) this.#store?.put(this.#scope, current, response, signal);
  }

  async *stream(events: AsyncIterable<ChatGptStreamEvent>, account: Account, model: string, pool: AccountPool, signal?: AbortSignal): AsyncIterable<ChatGptStreamEvent> {
    let terminal: ChatGptDoneEvent | undefined;
    for await (const event of events) {
      if (terminal) throw new ChatGptBackendError('Invalid backend terminal sequence.', 'invalid_response', { status: 502 });
      if (event.type === 'done') terminal = event;
      else yield event;
    }
    // Hold the done event until iteration/disposal succeeds. Exceptions, EOF
    // without done, and consumer cancellation cannot publish tentative replay.
    if (signal?.aborted) throw new DOMException('Request was cancelled.', 'AbortError');
    if (terminal) {
      this.complete(terminal, account, model, pool, signal);
      const { replayItems: _items, replayEligible: _eligible, outputItems: _output, ...visible } = terminal;
      yield visible;
    }
  }
}

function currentAccount(pool: AccountPool, expected: Account): Account | undefined {
  const current = pool.get(expected.id);
  return current && current.incarnation === expected.incarnation && current.provider === expected.provider
    && current.enabled && current.status === 'available' ? current : undefined;
}
