import type { ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';
import type { Account, AccountPool, SessionSecretVersion } from './account-pool.js';
import type { RuntimeApiKeys } from './runtime-api-keys.js';
import type { ModelRegistry } from './model-registry.js';
import { createRuntimeState, RuntimeStateStoreError, type RuntimeStateStore } from './runtime-state-store.js';

export interface DurableRuntimeStateOptions {
  accountPool: AccountPool;
  runtimeApiKeys: RuntimeApiKeys;
  modelRegistry?: ModelRegistry;
  store: RuntimeStateStore;
  removeMockAccountsOnHydrate?: boolean;
}

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
    if (accounts.length !== state.accounts.length || state.modelAliases.length === 0 || aliasesMigrated) this.persist();
    return true;
  }

  persist(): void {
    this.options.store.save(createRuntimeState(this.options.accountPool.exportState(), this.options.runtimeApiKeys.exportState(), this.options.modelRegistry?.exportState() ?? []));
  }

  transaction<T>(mutation: () => T): T {
    const accounts = this.options.accountPool.snapshot();
    const runtimeApiKeys = this.options.runtimeApiKeys.snapshot();
    const modelAliases = this.options.modelRegistry?.snapshot();
    try {
      const result = mutation();
      this.persist();
      return result;
    } catch (error) {
      if (!(error instanceof RuntimeStateStoreError && error.stateCommitted)) {
        this.options.accountPool.restore(accounts);
        this.options.runtimeApiKeys.restore(runtimeApiKeys);
        if (modelAliases) this.options.modelRegistry?.restore(modelAliases);
      }
      throw error;
    }
  }

  compareAndSwapSessionSecret(accountId: string, expected: SessionSecretVersion, nextSecret: ChatGptSessionSecret, expectedIncarnation?: number): Account | undefined {
    const current = this.options.accountPool.get(accountId);
    if (!current || (expectedIncarnation !== undefined && current.incarnation !== expectedIncarnation) || current.provider !== 'chatgpt-session' || !current.secret) return undefined;
    if (current.secret.accessToken !== expected.accessToken || current.secret.refreshToken !== expected.refreshToken) return undefined;
    return this.transaction(() => this.options.accountPool.compareAndSwapSessionSecret(accountId, expected, nextSecret, expectedIncarnation));
  }
}
