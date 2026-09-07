import { randomUUID } from 'node:crypto';
import { presentPlan, type PlanPresentation } from './plan-presentation.js';
import { ChatGptBackendError, type ChatGptAccountQuota, type ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import type { Account, AccountPool, AccountQuotaOperation } from './account-pool.js';
import { AdminOperationalStateError, type AdminOperationalState, type SanitizedQuotaCache, type SanitizedQuotaError } from './admin-operational-state.js';
import { accountQuotaContext } from './refresh-aware-backend.js';

const DEFAULT_TTL_MS = 5 * 60_000;

export interface AccountQuotaResult {
  accountId: string;
  createdAt: string;
  supported: boolean;
  canActiveReset?: boolean;
  plan?: PlanPresentation;
  status: SanitizedQuotaCache['status'];
  fetchedAt?: string;
  expiresAt?: string;
  quota?: ChatGptAccountQuota;
  error?: SanitizedQuotaError;
}

export interface AccountQuotaPersistenceDiagnostic {
  severity: 'warning';
  code: 'operational_persistence_unavailable';
  accountId: string;
  message: string;
}

export interface AccountQuotaServiceOptions {
  accountPool: AccountPool;
  backend: ChatGptBackendClient;
  operationalState?: AdminOperationalState;
  now?: () => Date;
  ttlMs?: number;
  onDiagnostic?: (diagnostic: AccountQuotaPersistenceDiagnostic) => void;
}

interface ActiveRefresh {
  operation: AccountQuotaOperation;
  promise: Promise<AccountQuotaResult>;
}

export class AccountQuotaService {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly caches = new Map<string, SanitizedQuotaCache>();
  private readonly refreshes = new Map<string, ActiveRefresh>();
  private readonly resetNeedsRefresh = new Set<string>();
  private readonly cacheRevisions = new Map<string, { incarnation: number; configurationRevision: number }>();

  constructor(private readonly options: AccountQuotaServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = validTtl(options.ttlMs);
    for (const snapshot of options.operationalState?.snapshot().accounts ?? []) {
      this.caches.set(identityKey(snapshot), cloneCache(snapshot.quotaCache));
    }
  }

  getAll(): AccountQuotaResult[] {
    return this.options.accountPool.snapshot().accounts.map((account) => this.resultFor(account));
  }

  async refreshAll(): Promise<AccountQuotaResult[]> {
    return Promise.all(this.options.accountPool.snapshot().accounts.map(async (account) => {
      try {
        return await this.refreshAccount(account.id);
      } catch (error) {
        // Joining a reset must not lose other accounts' results or retry the mutation.
        const current = this.options.accountPool.get(account.id);
        if (!current || current.incarnation !== account.incarnation || current.configurationRevision !== account.configurationRevision) {
          return this.accountChangedResult(account);
        }
        const result = this.resultFor(current);
        return { ...result, canActiveReset: false, status: result.quota ? 'stale' as const : 'error' as const, error: sanitizeQuotaError(error) };
      }
    }));
  }

  removeAccount(identity: { id: string; createdAt: string }): void {
    this.caches.delete(identityKey(identity));
  }

  invalidateAccount(identity: { id: string; createdAt: string }): void {
    this.caches.delete(identityKey(identity));
    try {
      this.options.operationalState?.setQuotaCache(
        { accountId: identity.id, createdAt: identity.createdAt },
        { status: 'unknown', fetchedAt: null, expiresAt: null },
      );
    } catch (error) {
      if (!(error instanceof AdminOperationalStateError)) throw error;
      this.emitPersistenceDiagnostic(identity.id, 'Quota cache was invalidated in memory, but operational quota persistence is unavailable.');
    }
  }

  refreshAccount(accountId: string): Promise<AccountQuotaResult> {
    const account = this.options.accountPool.get(accountId);
    if (!account) return Promise.reject(new AccountQuotaNotFoundError(accountId));
    if (!this.isSupported(account)) return Promise.resolve(this.unsupportedResult(account));

    const key = activeRefreshKey(account);
    const existing = this.refreshes.get(key);
    if (existing) return existing.promise;

    const operation = this.options.accountPool.beginQuota(account);
    if (!operation) return Promise.resolve(this.accountChangedResult(account));
    const promise = this.performRefresh(account, operation).finally(() => {
      if (this.refreshes.get(key)?.operation.id === operation.id) this.refreshes.delete(key);
      this.options.accountPool.endQuota(operation);
    });
    this.refreshes.set(key, { operation, promise });
    return promise;
  }

  activeReset(accountId: string): Promise<AccountQuotaResult> {
    const account = this.options.accountPool.get(accountId);
    if (!account) return Promise.reject(new AccountQuotaNotFoundError(accountId));
    const key = activeRefreshKey(account);
    if (this.refreshes.has(key)) return Promise.reject(new AccountQuotaResetError('quota_busy', 409));
    if (!this.resultFor(account).canActiveReset) return Promise.reject(new AccountQuotaResetError('reset_unavailable', 409));
    const operation = this.options.accountPool.beginQuota(account);
    if (!operation) return Promise.reject(new AccountQuotaResetError('account_changed', 409));
    const promise = this.performActiveReset(account, operation).finally(() => {
      if (this.refreshes.get(key)?.operation.id === operation.id) this.refreshes.delete(key);
      this.options.accountPool.endQuota(operation);
    });
    this.refreshes.set(key, { operation, promise });
    return promise;
  }

  private async performActiveReset(account: Account, operation: AccountQuotaOperation): Promise<AccountQuotaResult> {
    // Even ambiguous transport failures require an authoritative refresh before another redemption.
    this.resetNeedsRefresh.add(identityKey(account));
    try {
      await this.options.backend.consumeAccountResetCredit!(randomUUID(), accountQuotaContext(account, operation.id));
    } catch {
      throw new AccountQuotaResetError('reset_failed', 502);
    }
    if (!this.options.accountPool.isCurrentQuota(operation)) throw new AccountQuotaResetError('account_changed', 409);
    return this.performRefresh(account, operation, true);
  }

  private async performRefresh(account: Account, operation: AccountQuotaOperation, preserveOnFailure = false): Promise<AccountQuotaResult> {
    try {
      const quota = cloneQuota(await this.options.backend.getAccountQuota!(accountQuotaContext(account, operation.id)));
      if (!this.options.accountPool.isCurrentQuota(operation)) return this.accountChangedResult(account);
      const fetchedAt = this.now();
      const cache: SanitizedQuotaCache = {
        status: 'fresh',
        fetchedAt: fetchedAt.toISOString(),
        expiresAt: new Date(fetchedAt.getTime() + this.ttlMs).toISOString(),
        quota,
      };
      this.store(account, cache);
      const current = this.options.accountPool.get(account.id)!;
      this.cacheRevisions.set(identityKey(account), { incarnation: current.incarnation, configurationRevision: current.configurationRevision });
      this.resetNeedsRefresh.delete(identityKey(account));
      return this.resultFor(current);
    } catch (error) {
      if (!this.options.accountPool.isCurrentQuota(operation)) return this.accountChangedResult(account);
      if (preserveOnFailure) throw new AccountQuotaResetError('reset_refresh_failed', 502);
      const previous = this.caches.get(identityKey(account));
      const safeError = sanitizeQuotaError(error);
      const cache: SanitizedQuotaCache = previous?.quota
        ? { ...cloneCache(previous), status: 'stale', error: safeError }
        : { status: 'error', fetchedAt: null, expiresAt: null, error: safeError };
      this.store(account, cache);
      return this.resultFor(this.options.accountPool.get(account.id) ?? account);
    }
  }

  private store(account: Account, cache: SanitizedQuotaCache): void {
    this.caches.set(identityKey(account), cloneCache(cache));
    try {
      this.options.operationalState?.setQuotaCache(
        { accountId: account.id, createdAt: account.createdAt },
        cache,
      );
    } catch (error) {
      if (!(error instanceof AdminOperationalStateError)) throw error;
      this.emitPersistenceDiagnostic(account.id, 'Quota refresh completed, but operational quota persistence is unavailable.');
    }
  }

  private emitPersistenceDiagnostic(accountId: string, message: string): void {
    this.options.onDiagnostic?.({
      severity: 'warning',
      code: 'operational_persistence_unavailable',
      accountId,
      message,
    });
  }

  private resultFor(account: Account): AccountQuotaResult {
    if (!this.isSupported(account)) return this.unsupportedResult(account);
    const cache = this.caches.get(identityKey(account)) ?? { status: 'unknown', fetchedAt: null, expiresAt: null };
    const status = cache.status === 'fresh' && cache.expiresAt && Date.parse(cache.expiresAt) <= this.now().getTime() ? 'stale' : cache.status;
    return {
      accountId: account.id,
      createdAt: account.createdAt,
      supported: true,
      plan: presentPlan({ ...cache, status }),
      canActiveReset: status === 'fresh' && !cache.error && !cache.quota?.resetCredits?.error
        && typeof this.options.backend.consumeAccountResetCredit === 'function'
        && Number.isSafeInteger(cache.quota?.resetCredits?.availableCount) && (cache.quota?.resetCredits?.availableCount ?? 0) > 0
        && !this.resetNeedsRefresh.has(identityKey(account))
        && this.cacheRevisions.get(identityKey(account))?.incarnation === account.incarnation
        && this.cacheRevisions.get(identityKey(account))?.configurationRevision === account.configurationRevision,
      status,
      ...(cache.fetchedAt ? { fetchedAt: cache.fetchedAt } : {}),
      ...(cache.expiresAt ? { expiresAt: cache.expiresAt } : {}),
      ...(cache.quota ? { quota: cloneQuota(cache.quota) } : {}),
      ...(cache.error ? { error: { ...cache.error } } : {}),
    };
  }

  private unsupportedResult(account: Account): AccountQuotaResult {
    return {
      accountId: account.id,
      createdAt: account.createdAt,
      supported: false,
      plan: presentPlan(undefined, account.secret?.planType),
      status: 'unknown',
      error: { code: 'unsupported', category: 'unsupported', message: 'Account quota is not supported for this account.' },
    };
  }

  private accountChangedResult(original: Account): AccountQuotaResult {
    const account = this.options.accountPool.get(original.id);
    if (!account) return {
      accountId: original.id,
      createdAt: original.createdAt,
      supported: true,
      status: 'unknown',
      error: accountChangedError(),
    };
    const current = this.resultFor(account);
    return {
      ...current,
      status: current.quota ? 'stale' : 'unknown',
      error: accountChangedError(),
    };
  }

  private isSupported(account: Account): boolean {
    return account.provider === 'chatgpt-session' && typeof this.options.backend.getAccountQuota === 'function';
  }
}

export class AccountQuotaResetError extends Error {
  constructor(readonly code: 'quota_busy' | 'reset_unavailable' | 'account_changed' | 'reset_failed' | 'reset_refresh_failed', readonly status: 409 | 502) {
    super(code === 'reset_refresh_failed' ? 'Reset accepted, but authoritative refresh failed. Refresh quota before retrying.' : 'Active reset could not be completed. Refresh quota and check account availability before retrying.');
    this.name = 'AccountQuotaResetError';
  }
}

export class AccountQuotaNotFoundError extends Error {
  constructor(readonly accountId: string) {
    super('Account not found');
    this.name = 'AccountQuotaNotFoundError';
  }
}

function sanitizeQuotaError(error: unknown): SanitizedQuotaError {
  if (!(error instanceof ChatGptBackendError)) return { code: 'unknown', category: 'unknown', message: 'Quota refresh failed.' };
  switch (error.code) {
    case 'unauthorized': return { code: error.code, status: safeStatus(error.status), category: 'authentication', message: 'Quota provider rejected the account credentials.' };
    case 'rate_limited': return { code: error.code, status: safeStatus(error.status), category: 'rate_limit', message: 'Quota provider rate limited the request.' };
    case 'timeout': return { code: error.code, status: safeStatus(error.status), category: 'timeout', message: 'Quota provider request timed out.' };
    case 'network_error': return { code: error.code, status: safeStatus(error.status), category: 'network', message: 'Quota provider could not be reached.' };
    case 'invalid_response': return { code: error.code, status: safeStatus(error.status), category: 'provider', message: 'Quota provider returned an invalid response.' };
    case 'upstream_error': return { code: error.code, status: safeStatus(error.status), category: 'provider', message: 'Quota provider request failed.' };
    default: return { code: error.code, status: safeStatus(error.status), category: 'unknown', message: 'Quota refresh failed.' };
  }
}

function accountChangedError(): SanitizedQuotaError {
  return { code: 'account_changed', category: 'account_changed', message: 'Account configuration changed during quota refresh.' };
}

function safeStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function validTtl(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_TTL_MS;
}

function identityKey(identity: { id?: string; accountId?: string; createdAt: string }): string {
  return JSON.stringify([identity.id ?? identity.accountId, identity.createdAt]);
}

function activeRefreshKey(account: Account): string {
  return account.id;
}

function cloneCache(cache: SanitizedQuotaCache): SanitizedQuotaCache {
  return {
    ...cache,
    ...(cache.quota ? { quota: cloneQuota(cache.quota) } : {}),
    ...(cache.error ? { error: { ...cache.error } } : {}),
  };
}

function cloneQuota(quota: ChatGptAccountQuota): ChatGptAccountQuota {
  return {
    ...quota,
    windows: quota.windows.map((window) => ({ ...window })),
    ...(quota.additionalLimits ? { additionalLimits: quota.additionalLimits.map((limit) => ({ ...limit, windows: limit.windows.map((window) => ({ ...window })) })) } : {}),
    ...(quota.resetCredits ? { resetCredits: {
      ...(Number.isSafeInteger(quota.resetCredits.availableCount) && quota.resetCredits.availableCount! >= 0 ? { availableCount: quota.resetCredits.availableCount } : {}),
      ...(quota.resetCredits.error ? { error: quota.resetCredits.error === 'invalid_response' ? 'invalid_response' as const : 'fetch_failed' as const } : {}),
      ...(quota.resetCredits.credits ? { credits: quota.resetCredits.credits.map(({ status, grantedAt, expiresAt }) => ({ status, ...(grantedAt ? { grantedAt } : {}), expiresAt })) } : {}),
    } } : {}),
  };
}
