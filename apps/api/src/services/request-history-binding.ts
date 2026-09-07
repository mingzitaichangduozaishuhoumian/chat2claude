import { ChatGptBackendError, type ChatGptBackendRequestContext, type ChatGptCompletionRequest } from '@chatgpt-to-claude/chatgpt-backend';
import type { Account } from './account-pool.js';

type HistoryBinding = Pick<Account, 'id' | 'incarnation' | 'provider'> & { model: string };
// Out-of-band metadata: neither client input nor serialization/inspection can
// supply or reveal the binding. Keep the request object through dispatch.
const bindings = new WeakMap<ChatGptCompletionRequest, HistoryBinding>();

export function bindRequestHistory(request: ChatGptCompletionRequest, account: Pick<Account, 'id' | 'incarnation' | 'provider'>): void {
  bindings.set(request, { id: account.id, incarnation: account.incarnation, provider: account.provider, model: request.model });
}

export function assertRequestHistoryBinding(request: ChatGptCompletionRequest, context: ChatGptBackendRequestContext | undefined): void {
  const binding = bindings.get(request);
  if (!binding) return;
  const account = context?.account as Account | undefined;
  if (!account || account.id !== binding.id || account.incarnation !== binding.incarnation || account.provider !== binding.provider || request.model !== binding.model) {
    // History affinity is a request error, never an authentication failure: no
    // OAuth retry and no unhealthy/cooldown mutation on account release.
    throw new ChatGptBackendError('Previous history is no longer valid.', 'invalid_request', { status: 400 });
  }
}
