import { randomBytes } from 'node:crypto';
import type { Account, AccountPool, AccountView } from './account-pool.js';
import { ChatGptBackendError, type ChatGptBackendClient, type ChatGptDiscoveredModel, type ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';
import type { ModelRegistry, PreparedModelProvisioning } from './model-registry.js';
import { candidateSessionContext } from './refresh-aware-backend.js';
import type { ProvisionCommitBoundary } from './provision-commit.js';
import type { PreparedRuntimeApiKey, RuntimeApiKeys } from './runtime-api-keys.js';
import type { DurableRuntimeState } from './durable-runtime-state.js';
import type { AdminOperationalState } from './admin-operational-state.js';

export const PRIMARY_CHATGPT_ACCOUNT_ID = 'chatgpt-primary';
const PRIMARY_RUNTIME_KEY_NAME = 'chatgpt-primary';

export type ProvisioningStage = 'session_verification' | 'model_preparation' | 'state_commit';
export type ProvisioningTarget = { mode: 'add' } | { mode: 'reauthorize'; accountId: string };
type InternalProvisioningTarget = ProvisioningTarget | { mode: 'legacy-primary' };

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
  operationalState?: AdminOperationalState;
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
  runtimeKeyCreated: boolean;
  apiKey?: string;
  account: AccountView;
  modelsDiscovered: string[];
  boundAliases: Record<string, string>;
}

interface PreparedProvisioningCommit {
  accountId: string;
  expectedTarget?: Pick<Account, 'id' | 'incarnation' | 'configurationRevision' | 'createdAt'>;
  accountInput: Parameters<AccountPool['commitProvisionedSession']>[0];
  models: PreparedModelProvisioning;
  runtimeKey?: PreparedRuntimeApiKey;
  discoveredModels: ChatGptDiscoveredModel[];
}

export class SetupProvisioner {
  private provisioningTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: SetupProvisionerOptions) {}

  /** Backward-compatible single-account path for legacy callers. */
  provision(secret: ChatGptSessionSecret, signal?: AbortSignal, commitBoundary: ProvisionCommitBoundary = commitImmediately): Promise<ProvisionResult> {
    return this.enqueue({ mode: 'legacy-primary' }, secret, signal, commitBoundary);
  }

  provisionTarget(target: ProvisioningTarget, secret: ChatGptSessionSecret, signal?: AbortSignal, commitBoundary: ProvisionCommitBoundary = commitImmediately): Promise<ProvisionResult> {
    return this.enqueue(normalizeProvisioningTarget(target), secret, signal, commitBoundary);
  }

  private enqueue(target: InternalProvisioningTarget, secret: ChatGptSessionSecret, signal: AbortSignal | undefined, commitBoundary: ProvisionCommitBoundary): Promise<ProvisionResult> {
    const task = this.provisioningTail.then(() => this.provisionSerial(target, secret, signal, commitBoundary));
    this.provisioningTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async provisionSerial(target: InternalProvisioningTarget, secret: ChatGptSessionSecret, signal: AbortSignal | undefined, commitBoundary: ProvisionCommitBoundary): Promise<ProvisionResult> {
    await waitForStartupReadiness(this.options.startupReady, signal);
    assertProvisioningNotCancelled(signal);
    const targetState = this.resolveTarget(target);
    const candidateSecret = targetState.existing ? mergeReauthorizationSecret(targetState.existing.secret, secret) : { ...secret };
    if (!candidateSecret.accessToken) throw this.provisioningError('session_verification', new Error('missing access token'));
    const candidate = createCandidateAccount(targetState.accountId, candidateSecret, targetState.existing);
    const context = candidateSessionContext(candidate, signal);
    let discovered: ChatGptDiscoveredModel[];
    try {
      // Model discovery is the single remote validation request. A second
      // health-check would repeat the same credentials and consume a request.
      discovered = await this.options.backend.listModels(context);
      assertProvisioningNotCancelled(signal);
      this.validateIdentity(target, targetState.existing, candidate.secret ?? candidateSecret);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof ChatGptProvisioningError) throw error;
      throw this.provisioningError('session_verification', error);
    }

    let prepared: PreparedProvisioningCommit;
    try {
      prepared = this.prepareCommit(target, candidate, targetState.existing, discovered);
      assertProvisioningNotCancelled(signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof ChatGptProvisioningError) throw error;
      throw this.provisioningError('model_preparation', error);
    }

    try {
      return commitBoundary((committedAt) => this.commitPrepared(prepared, committedAt));
    } catch (error) {
      if (error instanceof ChatGptProvisioningError) throw error;
      throw this.provisioningError('state_commit', error);
    }
  }

  private resolveTarget(target: InternalProvisioningTarget): { accountId: string; existing?: Account } {
    if (target.mode === 'add') return { accountId: createOpaqueAccountId() };
    const accountId = target.mode === 'legacy-primary' ? PRIMARY_CHATGPT_ACCOUNT_ID : target.accountId;
    const existing = this.options.accountPool.get(accountId);
    if (target.mode === 'reauthorize' && !existing) throw conflict('reauthorization_target_not_found', 'ChatGPT reauthorization target no longer exists.', 404);
    if (existing && existing.provider !== 'chatgpt-session') throw conflict('reauthorization_target_invalid', 'ChatGPT reauthorization target is not a session account.', 409);
    return { accountId, existing };
  }

  private validateIdentity(target: InternalProvisioningTarget, existing: Account | undefined, secret: ChatGptSessionSecret): void {
    const upstreamAccountId = clean(secret.accountId);
    const existingUpstreamId = clean(existing?.secret?.accountId);
    if (target.mode !== 'add' && existingUpstreamId && upstreamAccountId && existingUpstreamId !== upstreamAccountId) {
      throw conflict('reauthorization_identity_mismatch', 'The signed-in ChatGPT identity does not match the selected account.', 409);
    }
    if (target.mode === 'add' && !upstreamAccountId) {
      throw conflict(
        'upstream_identity_required',
        'ChatGPT account identity metadata is required before adding this session.',
        400,
      );
    }
    if (!upstreamAccountId) return;
    const duplicate = this.options.accountPool.snapshot().accounts.find((account) =>
      account.provider === 'chatgpt-session' &&
      account.id !== existing?.id &&
      clean(account.secret?.accountId) === upstreamAccountId,
    );
    if (duplicate) throw conflict('duplicate_upstream_identity', 'This ChatGPT identity is already connected. Reauthorize the existing account instead.', 409);
  }

  private provisioningError(stage: ProvisioningStage, error: unknown): ChatGptProvisioningError {
    if (error instanceof ChatGptProvisioningError) return error;
    const diagnostic = provisioningDiagnostic(stage, error);
    this.options.onDiagnostic?.(diagnostic);
    return new ChatGptProvisioningError(diagnostic, { cause: error });
  }

  private prepareCommit(target: InternalProvisioningTarget, account: Account, existing: Account | undefined, discovered: ChatGptDiscoveredModel[]): PreparedProvisioningCommit {
    const isFirstSessionAccount = !this.options.accountPool.list().some((item) => item.provider === 'chatgpt-session');
    const mayBindInitialAlias = target.mode === 'legacy-primary' || (target.mode === 'add' && isFirstSessionAccount);
    const best = mayBindInitialAlias ? chooseBestModel(discovered) : undefined;
    return {
      accountId: account.id,
      expectedTarget: existing ? {
        id: existing.id,
        incarnation: existing.incarnation,
        configurationRevision: existing.configurationRevision,
        createdAt: existing.createdAt,
      } : undefined,
      accountInput: {
        id: account.id,
        provider: 'chatgpt-session',
        label: existing?.label ?? account.label,
        enabled: existing?.enabled ?? true,
        maxConcurrency: existing?.maxConcurrency ?? 1,
        capabilities: existing?.capabilities ?? ['chatgpt-session', 'messages'],
        secret: account.secret,
      },
      models: this.options.modelRegistry.prepareProvisioning(discovered, 'sonnet', best?.id, 'bind-if-unbound'),
      runtimeKey: this.options.runtimeApiKeys.isEmpty ? this.options.runtimeApiKeys.prepareNamedKey(PRIMARY_RUNTIME_KEY_NAME) : undefined,
      discoveredModels: discovered,
    };
  }

  private commitPrepared(prepared: PreparedProvisioningCommit, committedAt: Date): ProvisionResult {
    const commitCoreState = () => {
      this.assertTargetStillCurrent(prepared.expectedTarget);
      const account = this.options.accountPool.commitProvisionedSession(prepared.accountInput, committedAt);
      const apiKey = prepared.runtimeKey ? this.options.runtimeApiKeys.commitPreparedNamedKey(prepared.runtimeKey) : undefined;
      this.options.modelRegistry.commitPreparedProvisioning(
        prepared.models,
        { accountId: account.id, createdAt: account.createdAt },
        account.enabled,
      );
      return { account, apiKey };
    };
    // DurableRuntimeState owns all rollback decisions for credential commits. A
    // post-rename warning means the new snapshot is authoritative.
    let committed: ReturnType<typeof commitCoreState>;
    if (this.options.durableState) {
      const outcome = this.options.durableState.transactionWithOutcome(commitCoreState);
      committed = outcome.value;
      if (outcome.durability === 'committed_unconfirmed') this.options.onDiagnostic?.(committedDurabilityWarning());
    } else {
      committed = commitCoreState();
    }

    this.recordOperationalSuccess(committed.account, prepared.discoveredModels, committedAt);
    return {
      ok: true,
      runtimeKeyCreated: Boolean(prepared.runtimeKey),
      ...(committed.apiKey ? { apiKey: committed.apiKey } : {}),
      account: committed.account,
      modelsDiscovered: prepared.discoveredModels.map((model) => model.id),
      boundAliases: { ...prepared.models.boundAliases },
    };
  }

  private assertTargetStillCurrent(expected: PreparedProvisioningCommit['expectedTarget']): void {
    if (!expected) return;
    const current = this.options.accountPool.get(expected.id);
    if (
      !current ||
      current.provider !== 'chatgpt-session' ||
      current.incarnation !== expected.incarnation ||
      current.configurationRevision !== expected.configurationRevision ||
      current.createdAt !== expected.createdAt
    ) {
      throw conflict(
        'reauthorization_target_changed',
        'The selected ChatGPT account changed while reauthorization was in progress. Start reauthorization again.',
        409,
        'state_commit',
      );
    }
  }

  private recordOperationalSuccess(account: AccountView, models: ChatGptDiscoveredModel[], committedAt: Date): void {
    if (!this.options.operationalState) return;
    try {
      this.options.operationalState.recordProvisioningSuccess(
        { accountId: account.id, createdAt: account.createdAt },
        models,
        { checkedAt: committedAt.toISOString(), result: 'healthy', message: null },
      );
    } catch {
      this.options.onDiagnostic?.({
        stage: 'state_commit',
        severity: 'warning',
        code: 'operational_state_update_failed',
        message: 'ChatGPT credentials were committed, but admin operational metadata could not be updated.',
      });
    }
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

function conflict(code: string, message: string, status: number, stage: ProvisioningStage = 'session_verification'): ChatGptProvisioningError {
  return new ChatGptProvisioningError({ stage, code, status, message });
}

function normalizeProvisioningTarget(target: ProvisioningTarget): ProvisioningTarget {
  if (target.mode === 'add') {
    if ('accountId' in target) throw new Error('Add provisioning target must not include accountId.');
    return { mode: 'add' };
  }
  const accountId = clean(target.accountId);
  if (!accountId) throw new Error('Reauthorization provisioning target requires accountId.');
  return { mode: 'reauthorize', accountId };
}

function createOpaqueAccountId(): string {
  return `chatgpt-${randomBytes(18).toString('base64url')}`;
}

function createCandidateAccount(id: string, secret: ChatGptSessionSecret, existing?: Account): Account {
  return {
    id,
    // Candidate-only account; a committed pool account receives its own incarnation.
    incarnation: existing?.incarnation ?? 0,
    configurationRevision: existing?.configurationRevision ?? 0,
    healthRevision: existing?.healthRevision ?? 0,
    provider: 'chatgpt-session',
    label: existing?.label ?? 'ChatGPT Session Account',
    status: existing?.status ?? 'available',
    enabled: existing?.enabled ?? true,
    maxConcurrency: existing?.maxConcurrency ?? 1,
    currentConcurrency: existing?.currentConcurrency ?? 0,
    lastUsedAt: existing?.lastUsedAt ?? null,
    lastError: existing?.lastError ?? null,
    lastErrorCode: existing?.lastErrorCode ?? null,
    cooldownUntil: existing?.cooldownUntil ?? null,
    capabilities: existing?.capabilities ?? ['chatgpt-session', 'messages'],
    secret: { ...secret },
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
}

function mergeReauthorizationSecret(existing: ChatGptSessionSecret | undefined, incoming: ChatGptSessionSecret): ChatGptSessionSecret {
  const merged: ChatGptSessionSecret = { ...(existing ?? { type: 'chatgpt-session' }), type: 'chatgpt-session' };
  for (const [key, value] of Object.entries(incoming) as Array<[keyof ChatGptSessionSecret, ChatGptSessionSecret[keyof ChatGptSessionSecret]]>) {
    if (value !== undefined && value !== '') Object.assign(merged, { [key]: value });
  }
  return merged;
}

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
