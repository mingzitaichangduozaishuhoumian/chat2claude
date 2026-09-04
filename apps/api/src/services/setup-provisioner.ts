import type { Account, AccountPool, AccountView } from './account-pool.js';
import { ChatGptBackendError, type ChatGptBackendClient, type ChatGptDiscoveredModel, type ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';
import type { ModelRegistry, PreparedModelProvisioning } from './model-registry.js';
import { candidateSessionContext } from './refresh-aware-backend.js';
import type { ProvisionCommitBoundary } from './provision-commit.js';
import type { PreparedRuntimeApiKey, RuntimeApiKeys } from './runtime-api-keys.js';
import type { DurableRuntimeState } from './durable-runtime-state.js';

export const PRIMARY_CHATGPT_ACCOUNT_ID = 'chatgpt-primary';
const PRIMARY_RUNTIME_KEY_NAME = 'chatgpt-primary';

export type ProvisioningStage = 'session_verification' | 'model_preparation' | 'state_commit';

export interface ProvisioningDiagnostic {
  stage: ProvisioningStage;
  severity?: 'warning';
  code?: string;
  status?: number;
  message: string;
}

export interface SetupProvisionerOptions {
  accountPool: AccountPool;
  modelRegistry: ModelRegistry;
  backend: ChatGptBackendClient;
  runtimeApiKeys: RuntimeApiKeys;
  durableState?: DurableRuntimeState;
  startupReady?: Promise<unknown>;
  onDiagnostic?: (diagnostic: ProvisioningDiagnostic) => void;
}

export class ChatGptProvisioningError extends Error {
  constructor(public readonly diagnostic: ProvisioningDiagnostic, options?: { cause?: unknown }) {
    super(diagnostic.message, options);
    this.name = 'ChatGptProvisioningError';
  }
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
    await waitForStartupReadiness(this.options.startupReady, signal);
    assertProvisioningNotCancelled(signal);
    const candidate = createCandidateAccount(secret);
    const context = candidateSessionContext(candidate, signal);
    let discovered: ChatGptDiscoveredModel[];
    try {
      // Model discovery is the single remote validation request. A second
      // health-check would repeat the same credentials and consume a request.
      discovered = await this.options.backend.listModels(context);
      assertProvisioningNotCancelled(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw this.provisioningError('session_verification', error);
    }

    let prepared: PreparedProvisioningCommit;
    try {
      prepared = this.prepareCommit(candidate, discovered);
      assertProvisioningNotCancelled(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw this.provisioningError('model_preparation', error);
    }

    try {
      return commitBoundary((committedAt) => this.commitPrepared(prepared, committedAt));
    } catch (error) {
      throw this.provisioningError('state_commit', error);
    }
  }

  private provisioningError(stage: ProvisioningStage, error: unknown): ChatGptProvisioningError {
    if (error instanceof ChatGptProvisioningError) return error;
    const diagnostic = provisioningDiagnostic(stage, error);
    this.options.onDiagnostic?.(diagnostic);
    return new ChatGptProvisioningError(diagnostic, { cause: error });
  }

  private prepareCommit(account: Account, discovered: ChatGptDiscoveredModel[]): PreparedProvisioningCommit {
    const best = chooseBestModel(discovered);
    return {
      account,
      models: this.options.modelRegistry.prepareProvisioning(discovered, 'sonnet', best?.id, 'bind-if-unbound'),
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
      this.options.modelRegistry.commitPreparedProvisioning(prepared.models);
      return { account, apiKey };
    };
    // DurableRuntimeState owns all rollback decisions for durable commits. A
    // post-rename warning means the new snapshot is authoritative, so return the
    // committed one-time key while reporting only a sanitized diagnostic.
    let committed: ReturnType<typeof commitCoreState>;
    if (this.options.durableState) {
      const outcome = this.options.durableState.transactionWithOutcome(commitCoreState);
      committed = outcome.value;
      if (outcome.durability === 'committed_unconfirmed') this.options.onDiagnostic?.(committedDurabilityWarning());
    } else {
      committed = commitCoreState();
    }
    const { account, apiKey } = committed;
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
  // Catalog order is authoritative. Avoid guessing model quality from names or
  // hard-coding provider model IDs that can change independently of this proxy.
  return models[0];
}

function committedDurabilityWarning(): ProvisioningDiagnostic {
  return {
    stage: 'state_commit',
    severity: 'warning',
    code: 'durability_confirmation_failed',
    message: 'ChatGPT setup was committed, but filesystem durability confirmation failed.',
  };
}

function provisioningDiagnostic(stage: ProvisioningStage, error: unknown): ProvisioningDiagnostic {
  const message = stage === 'session_verification'
    ? 'ChatGPT session verification failed.'
    : stage === 'model_preparation'
      ? 'ChatGPT model preparation failed.'
      : 'ChatGPT setup state commit failed.';
  if (error instanceof ChatGptBackendError) {
    return { stage, code: error.code, ...(error.status === undefined ? {} : { status: error.status }), message };
  }
  return { stage, message };
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

async function waitForStartupReadiness(ready: Promise<unknown> | undefined, signal: AbortSignal | undefined): Promise<void> {
  if (!ready) return;
  const settled = ready.then(() => undefined, () => undefined);
  if (!signal) {
    await settled;
    return;
  }
  assertProvisioningNotCancelled(signal);
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(provisioningCancelledError());
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    await Promise.race([settled, cancelled]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function assertProvisioningNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw provisioningCancelledError();
}

function provisioningCancelledError(): Error {
  return new Error('ChatGPT setup provisioning was cancelled.');
}

function commitImmediately<T>(commit: (committedAt: Date) => T): T {
  return commit(new Date());
}
