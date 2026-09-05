import type { ChatGptBackendClient, ChatGptModelDiscoveryResult } from '@chatgpt-to-claude/chatgpt-backend';
import type { Account, AccountPool } from './account-pool.js';
import type { AdminOperationalState } from './admin-operational-state.js';
import type { ModelRegistry } from './model-registry.js';
import { accountDiscoveryContext } from './refresh-aware-backend.js';
import { discoverAccountModels, discoveryFailure, discoveryMessage, unknownDiscovery, type ModelDiscoveryState } from './model-discovery.js';

export interface AccountDiscoveryOutcome {
  accountId: string;
  ok: boolean;
  applied: boolean;
  discovery: ModelDiscoveryState;
  modelCount: number;
  models?: string[];
  requestFailed?: boolean;
  message: string;
  warning?: string;
}

export async function refreshAccountModels(options: {
  accountPool: AccountPool; modelRegistry: ModelRegistry; backend: ChatGptBackendClient;
  operationalState?: AdminOperationalState;
  onHealth?: (error?: unknown) => void;
}, account: Account, commit?: (result: ChatGptModelDiscoveryResult) => void): Promise<AccountDiscoveryOutcome> {
  const identity = { accountId: account.id, createdAt: account.createdAt };
  const previous = options.operationalState?.snapshot().accounts.find((item) => item.accountId === account.id && item.createdAt === account.createdAt);
  let state = previous?.discovery ?? unknownDiscovery();
  let count = previous?.discoveredModels.length ?? options.modelRegistry.snapshot().accountCatalogs.find((catalog) => catalog.identity.accountId === account.id && catalog.identity.createdAt === account.createdAt)?.models.length ?? 0;
  const operation = options.accountPool.beginDiscovery(account, Boolean(options.onHealth));
  const changed = (): AccountDiscoveryOutcome => ({ accountId: account.id, ok: false, applied: false, discovery: state, modelCount: count, message: 'Account changed during model discovery; result discarded.' });
  if (!operation) return changed();
  const at = new Date().toISOString();
  let warning: string | undefined;
  try {
    let result: ChatGptModelDiscoveryResult;
    try {
      result = await discoverAccountModels(options.backend, accountDiscoveryContext(account, operation.id));
    } catch (error) {
      if (!options.accountPool.isCurrentDiscovery(operation)) return { ...changed(), requestFailed: true };
      state = { status: 'error', attemptedAt: at, succeededAt: state.succeededAt, stale: count > 0 || state.succeededAt !== null, ...discoveryFailure(error) };
      try { options.operationalState?.recordDiscoveryFailure(identity, error, at); }
      catch { warning = 'Discovery metadata could not be persisted.'; }
      if (state.error !== 'invalid_response') options.onHealth?.(error);
      return { accountId: account.id, ok: false, applied: true, requestFailed: true, discovery: state, modelCount: count, message: discoveryMessage(state, count), ...(warning ? { warning } : {}) };
    }
    if (!options.accountPool.isCurrentDiscovery(operation)) return changed();
    if (result.status !== 'unknown') {
      if (commit) commit(result);
      else options.modelRegistry.replaceAccountModels(identity, result.models, account.enabled);
      count = result.models.length;
    }
    state = { status: result.status, attemptedAt: at, succeededAt: result.status === 'unknown' ? state.succeededAt : at, stale: result.status === 'unknown' && count > 0, ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) };
    try {
      options.operationalState?.recordDiscovery(identity, result, at);
      state = options.operationalState?.snapshot().accounts.find((item) => item.accountId === account.id && item.createdAt === account.createdAt)?.discovery ?? state;
    } catch { warning = 'Discovery metadata could not be persisted.'; }
    if (result.status !== 'unknown') options.onHealth?.();
    return { accountId: account.id, models: result.status === 'unknown' ? undefined : result.models.map((model) => model.id), ok: result.status !== 'unknown', applied: true, discovery: state, modelCount: count, message: discoveryMessage(state, count), ...(warning ? { warning } : {}) };
  } finally { options.accountPool.endDiscovery(operation); }
}
