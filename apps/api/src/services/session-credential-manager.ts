import { ChatGptBackendError, type ChatGptBackendAccountContext } from '@chatgpt-to-claude/chatgpt-backend';
import type { Account, AccountPool, SessionSecretVersion } from './account-pool.js';
import { markAccountCredentialError } from './account-pool.js';
import { CodexOAuthClient } from './codex-oauth-client.js';
import type { DurableRuntimeState } from './durable-runtime-state.js';

export interface CredentialRotationDiagnostic {
  severity: 'warning';
  code: 'durability_confirmation_failed';
  message: string;
}

export interface SessionCredentialManagerOptions {
  accountPool: AccountPool;
  oauthClient?: CodexOAuthClient;
  now?: () => Date;
  refreshSkewMs?: number;
  durableState?: DurableRuntimeState;
  onDiagnostic?: (diagnostic: CredentialRotationDiagnostic) => void;
}

interface ActiveCredentialRefresh {
  promise: Promise<Account>;
  discoveryOperationIds: Set<number>;
  quotaOperationIds: Set<number>;
}

export class SessionCredentialManager {
  private readonly oauthClient: CodexOAuthClient;
  private readonly now: () => Date;
  private readonly refreshSkewMs: number;
  private readonly refreshes = new Map<string, ActiveCredentialRefresh>();

  constructor(private readonly options: SessionCredentialManagerOptions) {
    this.oauthClient = options.oauthClient ?? new CodexOAuthClient();
    this.now = options.now ?? (() => new Date());
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
  }

  async getFreshAccount(account: ChatGptBackendAccountContext, failedAccessToken?: string, discoveryOperationId?: number, quotaOperationId?: number): Promise<Account> {
    const canonical = this.requireCanonicalAccount(account.id, (account as Account).incarnation);
    if (canonical.provider !== 'chatgpt-session') return canonical;
    const secret = canonical.secret;
    if (!secret?.accessToken) throw markAccountCredentialError(unauthorized('ChatGPT session account is missing an access token.'), canonical);

    if (failedAccessToken && secret.accessToken !== failedAccessToken) return canonical;
    const forceRefresh = Boolean(failedAccessToken && secret.accessToken === failedAccessToken);
    if (!forceRefresh && !expiresSoon(secret.expiresAt, this.now().getTime(), this.refreshSkewMs)) return canonical;
    return this.refresh(canonical.id, canonical.incarnation, canonical.configurationRevision, { accessToken: secret.accessToken, refreshToken: secret.refreshToken }, discoveryOperationId, quotaOperationId);
  }

  private refresh(accountId: string, incarnation: number, configurationRevision: number, version: SessionSecretVersion, discoveryOperationId?: number, quotaOperationId?: number): Promise<Account> {
    const key = credentialVersionKey(accountId, incarnation, configurationRevision);
    const existing = this.refreshes.get(key);
    if (existing) {
      addOperationOwner(existing, discoveryOperationId, quotaOperationId);
      return existing.promise;
    }
    const active: ActiveCredentialRefresh = { promise: undefined as unknown as Promise<Account>, discoveryOperationIds: new Set(), quotaOperationIds: new Set() };
    addOperationOwner(active, discoveryOperationId, quotaOperationId);
    active.promise = this.performRefresh(accountId, incarnation, configurationRevision, version, active).finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, active);
    return active.promise;
  }

  private async performRefresh(accountId: string, incarnation: number, configurationRevision: number, version: SessionSecretVersion, active: ActiveCredentialRefresh): Promise<Account> {
    const current = this.requireCanonicalAccount(accountId, incarnation);
    if (!ownsCredentialConfiguration(current, configurationRevision)) return current;
    const secret = current.secret;
    if (current.provider !== 'chatgpt-session' || !secret?.accessToken) throw markAccountCredentialError(unauthorized('ChatGPT session account cannot be refreshed.'), current);
    let refreshed;
    try {
      refreshed = await this.oauthClient.refreshSecret(secret);
    } catch (error) {
      const latest = this.requireCanonicalAccount(accountId, incarnation);
      if (!ownsCredentialConfiguration(latest, configurationRevision)) return latest;
      throw markAccountCredentialError(error, current);
    }
    if (this.options.durableState) {
      const outcome = this.options.durableState.compareAndSwapSessionSecretWithOutcome(accountId, version, refreshed, incarnation, [...active.discoveryOperationIds], [...active.quotaOperationIds], configurationRevision);
      if (outcome?.durability === 'committed_unconfirmed') this.options.onDiagnostic?.(committedDurabilityWarning());
      return outcome?.value ?? this.requireCanonicalAccount(accountId, incarnation);
    }
    const updated = this.options.accountPool.compareAndSwapSessionSecret(accountId, version, refreshed, incarnation, [...active.discoveryOperationIds], [...active.quotaOperationIds], configurationRevision);
    return updated ?? this.requireCanonicalAccount(accountId, incarnation);
  }

  private requireCanonicalAccount(accountId: string, incarnation?: number): Account {
    const account = this.options.accountPool.get(accountId);
    if (!account || (incarnation !== undefined && account.incarnation !== incarnation)) throw unauthorized('ChatGPT session account is no longer available.');
    return account;
  }
}

function addOperationOwner(active: ActiveCredentialRefresh, discoveryOperationId?: number, quotaOperationId?: number): void {
  if (discoveryOperationId !== undefined) active.discoveryOperationIds.add(discoveryOperationId);
  if (quotaOperationId !== undefined) active.quotaOperationIds.add(quotaOperationId);
}

function expiresSoon(expiresAt: string | undefined, nowMs: number, skewMs: number): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= nowMs + skewMs;
}

function ownsCredentialConfiguration(account: Account, configurationRevision: number): boolean {
  return account.configurationRevision === configurationRevision;
}

function credentialVersionKey(accountId: string, incarnation: number, configurationRevision: number): string {
  return `${accountId}\0${incarnation}\0${configurationRevision}`;
}

function committedDurabilityWarning(): CredentialRotationDiagnostic {
  return {
    severity: 'warning',
    code: 'durability_confirmation_failed',
    message: 'ChatGPT credential rotation was committed, but filesystem durability confirmation failed.',
  };
}

function unauthorized(message: string): ChatGptBackendError {
  return new ChatGptBackendError(message, 'unauthorized', { status: 401 });
}
