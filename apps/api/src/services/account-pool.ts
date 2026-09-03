import { ChatGptBackendError, type ChatGptBackendErrorCode, type ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';

export type AccountStatus = 'available' | 'unhealthy' | 'disabled' | 'error' | 'cooldown';
export type AccountProvider = 'mock' | 'chatgpt-session';

export interface Account {
  id: string;
  /** Runtime-only identity that distinguishes delete/recreate cycles for the same id. */
  incarnation: number;
  label: string;
  provider: AccountProvider;
  status: AccountStatus;
  enabled: boolean;
  maxConcurrency: number;
  currentConcurrency: number;
  lastUsedAt: string | null;
  lastError: string | null;
  lastErrorCode: ChatGptBackendErrorCode | null;
  cooldownUntil: string | null;
  capabilities: string[];
  secret?: ChatGptSessionSecret;
  createdAt: string;
}

export interface AccountView extends Omit<Account, 'secret' | 'incarnation'> {
  hasSecret: boolean;
}

export interface AccountCreateInput {
  id?: unknown;
  label?: unknown;
  provider?: unknown;
  secret?: unknown;
  enabled?: unknown;
  maxConcurrency?: unknown;
  capabilities?: unknown;
}

export interface AccountPatchInput {
  label?: unknown;
  provider?: unknown;
  secret?: unknown;
  status?: unknown;
  enabled?: unknown;
  maxConcurrency?: unknown;
  currentConcurrency?: unknown;
  lastError?: unknown;
  lastErrorCode?: unknown;
  cooldownUntil?: unknown;
  capabilities?: unknown;
}

export interface AccountAcquireOptions {
  provider?: AccountProvider;
  capability?: string;
}

export interface AccountPoolOptions {
  now?: () => Date;
  rateLimitCooldownMs?: number;
  /** Defaults to true to preserve direct AccountPool usage. */
  seedMockAccount?: boolean;
}

export interface SessionSecretVersion {
  accessToken?: string;
  refreshToken?: string;
}

/** v1-compatible persisted form; incarnation exists only for this process lifetime. */
export type PersistedAccount = Omit<Account, 'currentConcurrency' | 'incarnation'>;

export interface AccountPoolState {
  accounts: PersistedAccount[];
}

export interface AccountPoolSnapshot {
  accounts: Account[];
}

interface AccountCredentialErrorOwner extends SessionSecretVersion {
  accountId: string;
}

const ACCOUNT_CREDENTIAL_ERROR_OWNER = Symbol('accountCredentialErrorOwner');
type OwnedCredentialError = Error & { [ACCOUNT_CREDENTIAL_ERROR_OWNER]?: AccountCredentialErrorOwner };

export function markAccountCredentialError<T>(error: T, account: { id: string; secret?: ChatGptSessionSecret }): T {
  if (!(error instanceof Error) || !account.secret) return error;
  Object.defineProperty(error, ACCOUNT_CREDENTIAL_ERROR_OWNER, {
    configurable: true,
    value: { accountId: account.id, accessToken: account.secret.accessToken, refreshToken: account.secret.refreshToken },
  });
  return error;
}

export class AccountPool {
  private readonly accounts: Account[];
  private readonly now: () => Date;
  private readonly rateLimitCooldownMs: number;
  private nextIncarnation = 1;

  constructor(options: AccountPoolOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.rateLimitCooldownMs = typeof options.rateLimitCooldownMs === 'number' && Number.isFinite(options.rateLimitCooldownMs) && options.rateLimitCooldownMs >= 0 ? options.rateLimitCooldownMs : 60_000;
    this.accounts = options.seedMockAccount === false ? [] : [this.createAccount({ id: 'mock-account', label: 'Mock ChatGPT Account' })];
  }

  private createAccount(input: AccountCreateInput): Account {
    return createAccount(input, this.now, this.nextIncarnation++);
  }

  list(): AccountView[] {
    this.refreshExpiredCooldowns();
    return this.accounts.map(toAccountView);
  }

  exportState(): AccountPoolState {
    return { accounts: this.accounts.map(toPersistedAccount) };
  }

  snapshot(): AccountPoolSnapshot {
    return { accounts: this.accounts.map(cloneAccount) };
  }

  importState(state: AccountPoolState): void {
    this.accounts.splice(0, this.accounts.length, ...state.accounts.map((account) => fromPersistedAccount(account, this.nextIncarnation++)));
  }

  restore(snapshot: AccountPoolSnapshot): void {
    this.accounts.splice(0, this.accounts.length, ...snapshot.accounts.map(cloneAccount));
  }

  add(input: AccountCreateInput): AccountView {
    const account = this.createAccount(input);
    if (this.accounts.some((item) => item.id === account.id)) throw new Error(`Account already exists: ${account.id}`);
    this.accounts.push(account);
    return toAccountView(account);
  }

  upsert(input: AccountCreateInput & { id: string }): AccountView {
    const existing = this.accounts.find((item) => item.id === input.id);
    if (!existing) return this.add(input);
    return this.update(input.id, input) ?? this.add(input);
  }

  commitProvisionedSession(input: AccountCreateInput & { id: string }, committedAt: Date): AccountView {
    const committedAtIso = committedAt.toISOString();
    const existingIndex = this.accounts.findIndex((account) => account.id === input.id);
    const existing = existingIndex === -1 ? undefined : this.accounts[existingIndex];
    const secret = normalizeSecret(input.secret, 'chatgpt-session');
    if (!secret?.accessToken) throw new Error('Provisioned ChatGPT session requires an access token.');
    const enabled = typeof input.enabled === 'boolean' ? input.enabled : true;
    const next: Account = {
      id: input.id,
      incarnation: existing?.incarnation ?? this.nextIncarnation++,
      label: normalizeString(input.label, 'ChatGPT Session Account'),
      provider: 'chatgpt-session',
      status: enabled ? 'available' : 'disabled',
      enabled,
      maxConcurrency: normalizePositiveInteger(input.maxConcurrency, existing?.maxConcurrency ?? 1),
      currentConcurrency: existing?.currentConcurrency ?? 0,
      lastUsedAt: committedAtIso,
      lastError: null,
      lastErrorCode: null,
      cooldownUntil: null,
      capabilities: normalizeStringArray(input.capabilities, ['chatgpt-session', 'messages']),
      secret,
      createdAt: existing?.createdAt ?? committedAtIso,
    };
    if (existingIndex === -1) this.accounts.push(next);
    else this.accounts[existingIndex] = next;
    return toAccountView(next);
  }

  update(id: string, patch: AccountPatchInput): AccountView | undefined {
    const index = this.accounts.findIndex((account) => account.id === id);
    if (index === -1) return undefined;
    const current = this.accounts[index];
    const provider = normalizeProvider(patch.provider, current.provider);
    const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
    const status = normalizeStatus(patch.status, enabled ? current.status : 'disabled');
    const nextStatus = enabled ? status : 'disabled';
    const patchedCooldownUntil = normalizeNullableString(patch.cooldownUntil, current.cooldownUntil);
    const shouldClearCooldown = nextStatus !== 'cooldown' && nextStatus !== 'error' && nextStatus !== 'unhealthy';
    const next: Account = {
      ...current,
      label: normalizeString(patch.label, current.label),
      provider,
      status: nextStatus,
      enabled,
      maxConcurrency: normalizePositiveInteger(patch.maxConcurrency, current.maxConcurrency),
      currentConcurrency: normalizeNonNegativeInteger(patch.currentConcurrency, current.currentConcurrency),
      lastError: typeof patch.lastError === 'string' ? patch.lastError : patch.lastError === null ? null : current.lastError,
      lastErrorCode: normalizeBackendErrorCode(patch.lastErrorCode, current.lastErrorCode),
      cooldownUntil: shouldClearCooldown ? null : patchedCooldownUntil,
      capabilities: normalizeStringArray(patch.capabilities, current.capabilities),
      secret: patch.secret === undefined ? current.secret : normalizeSecret(patch.secret, provider),
    };
    this.accounts[index] = next;
    return toAccountView(next);
  }

  get(id: string): Account | undefined {
    const account = this.accounts.find((item) => item.id === id);
    return account ? cloneAccount(account) : undefined;
  }

  remove(id: string): AccountView | undefined {
    const index = this.accounts.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    const [account] = this.accounts.splice(index, 1);
    return toAccountView(account);
  }

  compareAndSwapSessionSecret(id: string, expected: SessionSecretVersion, nextSecret: ChatGptSessionSecret, expectedIncarnation?: number): Account | undefined {
    const account = this.accounts.find((item) => item.id === id);
    if (!account || (expectedIncarnation !== undefined && account.incarnation !== expectedIncarnation) || account.provider !== 'chatgpt-session' || !account.secret) return undefined;
    if (account.secret.accessToken !== expected.accessToken || account.secret.refreshToken !== expected.refreshToken) return undefined;
    const normalized = normalizeSecret(nextSecret, 'chatgpt-session');
    if (!normalized?.accessToken) return undefined;
    account.secret = normalized;
    return cloneAccount(account);
  }

  firstAvailable(options: AccountAcquireOptions = {}): Account | undefined {
    this.refreshExpiredCooldowns();
    const account = this.accounts.find((item) => canAcquire(item, options));
    return account ? cloneAccount(account) : undefined;
  }

  healthCheck(id: string): AccountView | undefined {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) return undefined;
    this.markHealthyAccount(account);
    return toAccountView(account);
  }

  markHealthy(id: string, expectedIncarnation?: number): AccountView | undefined {
    const account = this.accounts.find((item) => item.id === id);
    if (!account || (expectedIncarnation !== undefined && account.incarnation !== expectedIncarnation)) return undefined;
    this.markHealthyAccount(account);
    return toAccountView(account);
  }

  markError(id: string, error: unknown, expectedIncarnation?: number): AccountView | undefined {
    const account = this.accounts.find((item) => item.id === id);
    if (!account || (expectedIncarnation !== undefined && account.incarnation !== expectedIncarnation)) return undefined;
    this.applyReleaseResult(account, error);
    return toAccountView(account);
  }

  acquire(options: AccountAcquireOptions = {}): Account | undefined {
    this.refreshExpiredCooldowns();
    const account = this.accounts.find((item) => canAcquire(item, options));
    if (!account) return undefined;
    account.currentConcurrency += 1;
    account.lastUsedAt = this.now().toISOString();
    return cloneAccount(account);
  }

  release(id: string, error?: unknown): AccountView | undefined {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) return undefined;
    account.currentConcurrency = Math.max(0, account.currentConcurrency - 1);
    this.applyReleaseResult(account, isStaleCredentialError(account, error) ? undefined : error);
    return toAccountView(account);
  }

  private markHealthyAccount(account: Account): void {
    account.lastUsedAt = this.now().toISOString();
    account.lastError = null;
    account.lastErrorCode = null;
    account.cooldownUntil = null;
    account.status = account.enabled ? 'available' : 'disabled';
  }

  private applyReleaseResult(account: Account, error?: unknown): void {
    account.lastUsedAt = this.now().toISOString();
    if (error === undefined) {
      if (account.status === 'available' || account.status === 'disabled') {
        account.lastError = null;
        account.lastErrorCode = null;
        account.cooldownUntil = null;
        account.status = account.enabled ? 'available' : 'disabled';
      }
      return;
    }

    account.lastError = error instanceof Error ? error.message : String(error);
    if (error instanceof ChatGptBackendError) {
      account.lastErrorCode = error.code;
      if (error.code === 'rate_limited') {
        account.cooldownUntil = new Date(this.now().getTime() + this.rateLimitCooldownMs).toISOString();
        account.status = account.enabled ? 'cooldown' : 'disabled';
        return;
      }
      account.cooldownUntil = null;
      account.status = account.enabled ? error.code === 'unauthorized' ? 'unhealthy' : 'error' : 'disabled';
      return;
    }

    account.lastErrorCode = null;
    account.cooldownUntil = null;
    account.status = account.enabled ? 'error' : 'disabled';
  }

  private refreshExpiredCooldowns(): void {
    const nowMs = this.now().getTime();
    for (const account of this.accounts) {
      if (account.status !== 'cooldown' || !account.cooldownUntil) continue;
      const cooldownUntilMs = Date.parse(account.cooldownUntil);
      if (Number.isFinite(cooldownUntilMs) && cooldownUntilMs <= nowMs) {
        account.lastError = null;
        account.lastErrorCode = null;
        account.cooldownUntil = null;
        account.status = account.enabled ? 'available' : 'disabled';
      }
    }
  }
}

function isStaleCredentialError(account: Account, error: unknown): boolean {
  if (!(error instanceof ChatGptBackendError) || error.code !== 'unauthorized') return false;
  const owner = (error as OwnedCredentialError)[ACCOUNT_CREDENTIAL_ERROR_OWNER];
  if (!owner || owner.accountId !== account.id || !account.secret) return false;
  return owner.accessToken !== account.secret.accessToken || owner.refreshToken !== account.secret.refreshToken;
}

function createAccount(input: AccountCreateInput, now: () => Date, incarnation: number): Account {
  const createdAt = now().toISOString();
  const provider = normalizeProvider(input.provider, 'mock');
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : true;
  return {
    id: normalizeId(input.id),
    incarnation,
    label: normalizeString(input.label, provider === 'mock' ? 'Mock ChatGPT Account' : 'ChatGPT Session Account'),
    provider,
    status: enabled ? 'available' : 'disabled',
    enabled,
    maxConcurrency: normalizePositiveInteger(input.maxConcurrency, 1),
    currentConcurrency: 0,
    lastUsedAt: null,
    lastError: null,
    lastErrorCode: null,
    cooldownUntil: null,
    capabilities: normalizeStringArray(input.capabilities, provider === 'mock' ? ['mock', 'messages'] : ['chatgpt-session', 'messages']),
    secret: normalizeSecret(input.secret, provider),
    createdAt,
  };
}

function canAcquire(account: Account, options: AccountAcquireOptions): boolean {
  if (!account.enabled || account.status !== 'available' || account.currentConcurrency >= account.maxConcurrency) return false;
  if (options.provider && account.provider !== options.provider) return false;
  if (options.capability && !account.capabilities.includes(options.capability)) return false;
  return true;
}

function cloneAccount(account: Account): Account {
  return { ...account, capabilities: [...account.capabilities], secret: account.secret ? { ...account.secret } : undefined };
}

function toPersistedAccount(account: Account): PersistedAccount {
  const { currentConcurrency: _currentConcurrency, incarnation: _incarnation, ...persisted } = cloneAccount(account);
  return persisted;
}

function fromPersistedAccount(account: PersistedAccount, incarnation: number): Account {
  return { ...account, incarnation, currentConcurrency: 0, capabilities: [...account.capabilities], secret: account.secret ? { ...account.secret } : undefined };
}

function toAccountView(account: Account): AccountView {
  const { secret: _secret, incarnation: _incarnation, ...view } = account;
  return { ...view, capabilities: [...account.capabilities], hasSecret: Boolean(_secret) };
}

function normalizeId(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return `account-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeNullableString(value: unknown, fallback: string | null): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value === null) return null;
  return fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const next = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  return next.length > 0 ? next : [...fallback];
}

function normalizeStatus(value: unknown, fallback: AccountStatus): AccountStatus {
  return value === 'available' || value === 'unhealthy' || value === 'disabled' || value === 'error' || value === 'cooldown' ? value : fallback;
}

function normalizeProvider(value: unknown, fallback: AccountProvider): AccountProvider {
  return value === 'chatgpt-session' || value === 'mock' ? value : fallback;
}

function normalizeBackendErrorCode(value: unknown, fallback: ChatGptBackendErrorCode | null): ChatGptBackendErrorCode | null {
  if (value === null) return null;
  return value === 'unauthorized' || value === 'rate_limited' || value === 'upstream_error' || value === 'timeout' || value === 'network_error' || value === 'invalid_response' ? value : fallback;
}

function normalizeSecret(value: unknown, provider: AccountProvider): ChatGptSessionSecret | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (provider !== 'chatgpt-session' && raw.type !== 'chatgpt-session') return undefined;
  const secret: ChatGptSessionSecret = { type: 'chatgpt-session' };
  if (typeof raw.accessToken === 'string' && raw.accessToken.trim()) secret.accessToken = raw.accessToken.trim();
  if (typeof raw.refreshToken === 'string' && raw.refreshToken.trim()) secret.refreshToken = raw.refreshToken.trim();
  if (typeof raw.idToken === 'string' && raw.idToken.trim()) secret.idToken = raw.idToken.trim();
  if (typeof raw.expiresAt === 'string' && raw.expiresAt.trim()) secret.expiresAt = raw.expiresAt.trim();
  if (typeof raw.email === 'string' && raw.email.trim()) secret.email = raw.email.trim();
  if (typeof raw.accountId === 'string' && raw.accountId.trim()) secret.accountId = raw.accountId.trim();
  if (typeof raw.planType === 'string' && raw.planType.trim()) secret.planType = raw.planType.trim();
  if (typeof raw.cookie === 'string' && raw.cookie.trim()) secret.cookie = raw.cookie.trim();
  if (typeof raw.deviceId === 'string' && raw.deviceId.trim()) secret.deviceId = raw.deviceId.trim();
  if (typeof raw.userAgent === 'string' && raw.userAgent.trim()) secret.userAgent = raw.userAgent.trim();
  return secret;
}
