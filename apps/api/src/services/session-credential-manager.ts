import { ChatGptBackendError, type ChatGptBackendAccountContext } from '@chatgpt-to-claude/chatgpt-backend';
import type { Account, AccountPool, SessionSecretVersion } from './account-pool.js';
import { markAccountCredentialError } from './account-pool.js';
import { CodexOAuthClient } from './codex-oauth-client.js';
import type { DurableRuntimeState } from './durable-runtime-state.js';

export interface SessionCredentialManagerOptions {
  accountPool: AccountPool;
  oauthClient?: CodexOAuthClient;
  now?: () => Date;
  refreshSkewMs?: number;
  durableState?: DurableRuntimeState;
}

export class SessionCredentialManager {
  private readonly oauthClient: CodexOAuthClient;
  private readonly now: () => Date;
  private readonly refreshSkewMs: number;
  private readonly refreshes = new Map<string, Promise<Account>>();

  constructor(private readonly options: SessionCredentialManagerOptions) {
    this.oauthClient = options.oauthClient ?? new CodexOAuthClient();
    this.now = options.now ?? (() => new Date());
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
  }

  async getFreshAccount(account: ChatGptBackendAccountContext, failedAccessToken?: string, discoveryOperationId?: number): Promise<Account> {
    const canonical = this.requireCanonicalAccount(account.id, (account as Account).incarnation);
    if (canonical.provider !== 'chatgpt-session') return canonical;
    const secret = canonical.secret;
    if (!secret?.accessToken) throw markAccountCredentialError(unauthorized('ChatGPT session account is missing an access token.'), canonical);

    if (failedAccessToken && secret.accessToken !== failedAccessToken) return canonical;
    const forceRefresh = Boolean(failedAccessToken && secret.accessToken === failedAccessToken);
    if (!forceRefresh && !expiresSoon(secret.expiresAt, this.now().getTime(), this.refreshSkewMs)) return canonical;
    return this.refresh(canonical.id, canonical.incarnation, { accessToken: secret.accessToken, refreshToken: secret.refreshToken }, discoveryOperationId);
  }

  private refresh(accountId: string, incarnation: number, version: SessionSecretVersion, discoveryOperationId?: number): Promise<Account> {
    const key = credentialVersionKey(accountId, incarnation, version);
    const existing = this.refreshes.get(key);
    if (existing) return existing;
    const refresh = this.performRefresh(accountId, incarnation, version, discoveryOperationId).finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, refresh);
    return refresh;
  }

  private async performRefresh(accountId: string, incarnation: number, version: SessionSecretVersion, discoveryOperationId?: number): Promise<Account> {
    const current = this.requireCanonicalAccount(accountId, incarnation);
    if (!sameCredentialVersion(current, version)) return current;
    const secret = current.secret;
    if (current.provider !== 'chatgpt-session' || !secret?.accessToken) throw markAccountCredentialError(unauthorized('ChatGPT session account cannot be refreshed.'), current);
    let refreshed;
    try {
      refreshed = await this.oauthClient.refreshSecret(secret);
    } catch (error) {
      const latest = this.requireCanonicalAccount(accountId, incarnation);
      if (!sameCredentialVersion(latest, version)) return latest;
      throw markAccountCredentialError(error, current);
    }
    const updated = this.options.durableState
      ? this.options.durableState.compareAndSwapSessionSecret(accountId, version, refreshed, incarnation, discoveryOperationId)
      : this.options.accountPool.compareAndSwapSessionSecret(accountId, version, refreshed, incarnation, discoveryOperationId);
    return updated ?? this.requireCanonicalAccount(accountId, incarnation);
  }

  private requireCanonicalAccount(accountId: string, incarnation?: number): Account {
    const account = this.options.accountPool.get(accountId);
    if (!account || (incarnation !== undefined && account.incarnation !== incarnation)) throw unauthorized('ChatGPT session account is no longer available.');
    return account;
  }
}

function expiresSoon(expiresAt: string | undefined, nowMs: number, skewMs: number): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= nowMs + skewMs;
}

function sameCredentialVersion(account: Account, version: SessionSecretVersion): boolean {
  return account.secret?.accessToken === version.accessToken && account.secret?.refreshToken === version.refreshToken;
}

function credentialVersionKey(accountId: string, incarnation: number, version: SessionSecretVersion): string {
  return `${accountId}\0${incarnation}\0${version.accessToken ?? ''}\0${version.refreshToken ?? ''}`;
}

function unauthorized(message: string): ChatGptBackendError {
  return new ChatGptBackendError(message, 'unauthorized', { status: 401 });
}
