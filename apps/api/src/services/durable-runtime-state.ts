import type { ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';
import type { Account, AccountPool, SessionSecretVersion } from './account-pool.js';
import type { RuntimeApiKeys } from './runtime-api-keys.js';
import type { ModelRegistry } from './model-registry.js';
import { createRuntimeState, RuntimeStateStoreError, type RuntimeStateStore } from './runtime-state-store.js';
import type { BackendRouting, BackendRoutingConfig } from './backend-routing.js';

export interface DurableRuntimeStateOptions {
  accountPool: AccountPool;
  runtimeApiKeys: RuntimeApiKeys;
  modelRegistry?: ModelRegistry;
  backendRouting?: BackendRouting;
  store: RuntimeStateStore;
  removeMockAccountsOnHydrate?: boolean;
}

export type DurableTransactionOutcome<T> =
  | { value: T; durability: 'confirmed' }
  | { value: T; durability: 'committed_unconfirmed'; warning: RuntimeStateStoreError };

export class DurableRuntimeState {
  constructor(private readonly options: DurableRuntimeStateOptions) {}

  hydrate(): boolean {
    const state = this.options.store.load();
    if (!state) return false;
    const accounts = this.options.removeMockAccountsOnHydrate
      ? state.accounts.filter((account) => account.provider !== 'mock')
      : state.accounts;
    this.options.accountPool.importState({ accounts });
    this.options.runtimeApiKeys.restore(state.runtimeApiKeys);
    const aliasesMigrated = state.modelAliases.length > 0 && this.options.modelRegistry?.importState(state.modelAliases);
    if (state.backendRouting !== undefined) this.options.backendRouting?.restore(state.backendRouting);
    if (accounts.length !== state.accounts.length || state.modelAliases.length === 0 || aliasesMigrated) this.persist();
    return true;
  }

  persist(): void {
    this.options.store.save(createRuntimeState(this.options.accountPool.exportState(), this.options.runtimeApiKeys.exportState(), this.options.modelRegistry?.exportState() ?? [], this.options.backendRouting?.snapshot()));
  }

  transaction<T>(mutation: () => T): T {
    return this.transactionWithOutcome(mutation).value;
  }

  transactionWithOutcome<T>(mutation: () => T): DurableTransactionOutcome<T> {
    const accounts = this.options.accountPool.snapshot();
    const runtimeApiKeys = this.options.runtimeApiKeys.snapshot();
    const modelAliases = this.options.modelRegistry?.snapshot();
    const backendRouting = this.options.backendRouting?.snapshot();
    let value: T;
    try {
      value = mutation();
    } catch (error) {
      this.restore(accounts, runtimeApiKeys, modelAliases, backendRouting);
      throw error;
    }
    try {
      this.persist();
      return { value, durability: 'confirmed' };
    } catch (error) {
      if (error instanceof RuntimeStateStoreError && error.stateCommitted) {
        return { value, durability: 'committed_unconfirmed', warning: error };
      }
      this.restore(accounts, runtimeApiKeys, modelAliases, backendRouting);
      throw error;
    }
  }

  private restore(accounts: ReturnType<AccountPool['snapshot']>, runtimeApiKeys: ReturnType<RuntimeApiKeys['snapshot']>, modelAliases: ReturnType<ModelRegistry['snapshot']> | undefined, backendRouting: BackendRoutingConfig | undefined): void {
    this.options.accountPool.restore(accounts);
    this.options.runtimeApiKeys.restore(runtimeApiKeys);
    if (modelAliases) this.options.modelRegistry?.restore(modelAliases);
    if (backendRouting) this.options.backendRouting?.restore(backendRouting);
  }

  compareAndSwapSessionSecret(accountId: string, expected: SessionSecretVersion, nextSecret: ChatGptSessionSecret, expectedIncarnation?: number, discoveryOperationIds?: number | readonly number[], quotaOperationIds?: number | readonly number[], expectedConfigurationRevision?: number): Account | undefined {
    const outcome = this.compareAndSwapSessionSecretWithOutcome(accountId, expected, nextSecret, expectedIncarnation, discoveryOperationIds, quotaOperationIds, expectedConfigurationRevision);
    return outcome?.value;
  }

  compareAndSwapSessionSecretWithOutcome(accountId: string, expected: SessionSecretVersion, nextSecret: ChatGptSessionSecret, expectedIncarnation?: number, discoveryOperationIds?: number | readonly number[], quotaOperationIds?: number | readonly number[], expectedConfigurationRevision?: number): DurableTransactionOutcome<Account | undefined> | undefined {
    const current = this.options.accountPool.get(accountId);
    if (!current || (expectedIncarnation !== undefined && current.incarnation !== expectedIncarnation) || (expectedConfigurationRevision !== undefined && current.configurationRevision !== expectedConfigurationRevision) || current.provider !== 'chatgpt-session' || !current.secret) return undefined;
    if (current.secret.accessToken !== expected.accessToken || current.secret.refreshToken !== expected.refreshToken) return undefined;
    return this.transactionWithOutcome(() => this.options.accountPool.compareAndSwapSessionSecret(accountId, expected, nextSecret, expectedIncarnation, discoveryOperationIds, quotaOperationIds, expectedConfigurationRevision));
  }
}
