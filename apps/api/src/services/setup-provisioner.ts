import type { Account, AccountPool, AccountView } from './account-pool.js';
import type { ChatGptBackendClient, ChatGptDiscoveredModel, ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';
import type { ModelRegistry, PreparedModelProvisioning } from './model-registry.js';
import { candidateSessionContext } from './refresh-aware-backend.js';
import type { ProvisionCommitBoundary } from './provision-commit.js';
import type { PreparedRuntimeApiKey, RuntimeApiKeys } from './runtime-api-keys.js';
import type { DurableRuntimeState } from './durable-runtime-state.js';

export const PRIMARY_CHATGPT_ACCOUNT_ID = 'chatgpt-primary';
const PRIMARY_RUNTIME_KEY_NAME = 'chatgpt-primary';

export interface SetupProvisionerOptions {
  accountPool: AccountPool;
  modelRegistry: ModelRegistry;
  backend: ChatGptBackendClient;
  runtimeApiKeys: RuntimeApiKeys;
  durableState?: DurableRuntimeState;
}

export interface ProvisionResult {
  ok: true;
  apiKey: string;
  account: AccountView;
  modelsDiscovered: string[];
  boundAliases: Record<string, string>;
}

interface PreparedProvisioningCommit {
  account: Account;
  models: PreparedModelProvisioning;
  runtimeKey: PreparedRuntimeApiKey;
  modelIds: string[];
}

export class SetupProvisioner {
  private provisioningTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: SetupProvisionerOptions) {}

  provision(secret: ChatGptSessionSecret, signal?: AbortSignal, commitBoundary: ProvisionCommitBoundary = commitImmediately): Promise<ProvisionResult> {
    const task = this.provisioningTail.then(() => this.provisionSerial(secret, signal, commitBoundary));
    this.provisioningTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async provisionSerial(secret: ChatGptSessionSecret, signal: AbortSignal | undefined, commitBoundary: ProvisionCommitBoundary): Promise<ProvisionResult> {
    assertProvisioningNotCancelled(signal);
    const candidate = createCandidateAccount(secret);
    const context = candidateSessionContext(candidate);
    if (this.options.backend.healthCheck) {
      const health = await this.options.backend.healthCheck(context);
      assertProvisioningNotCancelled(signal);
      if (!health.ok) throw new Error(health.message ?? 'ChatGPT session health check failed');
    }
    const discovered = await this.options.backend.listModels(context);
    assertProvisioningNotCancelled(signal);
    const prepared = this.prepareCommit(candidate, discovered);
    assertProvisioningNotCancelled(signal);
    return commitBoundary((committedAt) => this.commitPrepared(prepared, committedAt));
  }

  private prepareCommit(account: Account, discovered: ChatGptDiscoveredModel[]): PreparedProvisioningCommit {
    const best = chooseBestModel(discovered);
    return {
      account,
      models: this.options.modelRegistry.prepareProvisioning(discovered, 'sonnet', best?.id),
      runtimeKey: this.options.runtimeApiKeys.prepareNamedKey(PRIMARY_RUNTIME_KEY_NAME),
      modelIds: discovered.map((model) => model.id),
    };
  }

  private commitPrepared(prepared: PreparedProvisioningCommit, committedAt: Date): ProvisionResult {
    const commitCoreState = () => {
      const account = this.options.accountPool.commitProvisionedSession({
        id: PRIMARY_CHATGPT_ACCOUNT_ID,
        provider: 'chatgpt-session',
        label: 'ChatGPT Primary Session',
        enabled: true,
        maxConcurrency: 1,
        capabilities: ['chatgpt-session', 'messages'],
        secret: prepared.account.secret,
      }, committedAt);
      const apiKey = this.options.runtimeApiKeys.commitPreparedNamedKey(prepared.runtimeKey);
      return { account, apiKey };
    };
    const { account, apiKey } = this.options.durableState ? this.options.durableState.transaction(commitCoreState) : commitCoreState();
    this.options.modelRegistry.commitPreparedProvisioning(prepared.models);
    return {
      ok: true,
      apiKey,
      account,
      modelsDiscovered: prepared.modelIds,
      boundAliases: { ...prepared.models.boundAliases },
    };
  }
}

export function chooseBestModel(models: ChatGptDiscoveredModel[]): ChatGptDiscoveredModel | undefined {
  return [...models].sort((a, b) => modelScore(b) - modelScore(a))[0];
}

function createCandidateAccount(secret: ChatGptSessionSecret): Account {
  return {
    id: PRIMARY_CHATGPT_ACCOUNT_ID,
    // Candidate-only account; a committed pool account receives its own incarnation.
    incarnation: 0,
    provider: 'chatgpt-session',
    label: 'ChatGPT Primary Session',
    status: 'available',
    enabled: true,
    maxConcurrency: 1,
    currentConcurrency: 0,
    lastUsedAt: null,
    lastError: null,
    lastErrorCode: null,
    cooldownUntil: null,
    capabilities: ['chatgpt-session', 'messages'],
    secret: { ...secret },
    createdAt: new Date().toISOString(),
  };
}

function assertProvisioningNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('ChatGPT setup provisioning was cancelled.');
}

function commitImmediately<T>(commit: (committedAt: Date) => T): T {
  return commit(new Date());
}

function modelScore(model: ChatGptDiscoveredModel): number {
  const text = `${model.id} ${model.displayName ?? ''}`.toLowerCase();
  const keywords: Array<[string, number]> = [
    ['gpt-5', 100],
    ['codex', 80],
    ['thinking', 60],
    ['gpt-4', 40],
  ];
  return keywords.reduce((score, [keyword, value]) => score + (text.includes(keyword) ? value : 0), 0);
}
