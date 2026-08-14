import type { ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';

export type AccountStatus = 'available' | 'unhealthy' | 'disabled' | 'error';
export type AccountProvider = 'mock' | 'chatgpt-session';

export interface Account {
  id: string;
  label: string;
  provider: AccountProvider;
  status: AccountStatus;
  enabled: boolean;
  maxConcurrency: number;
  currentConcurrency: number;
  lastUsedAt: string | null;
  lastError: string | null;
  capabilities: string[];
  secret?: ChatGptSessionSecret;
  createdAt: string;
}

export interface AccountView extends Omit<Account, 'secret'> {
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
  capabilities?: unknown;
}

export interface AccountAcquireOptions {
  provider?: AccountProvider;
  capability?: string;
}

export class AccountPool {
  private readonly accounts: Account[] = [createAccount({ id: 'mock-account', label: 'Mock ChatGPT Account' })];

  list(): AccountView[] { return this.accounts.map(toAccountView); }

  add(input: AccountCreateInput): AccountView {
    const account = createAccount(input);
    if (this.accounts.some((item) => item.id === account.id)) throw new Error(`Account already exists: ${account.id}`);
    this.accounts.push(account);
    return toAccountView(account);
  }

  update(id: string, patch: AccountPatchInput): AccountView | undefined {
    const index = this.accounts.findIndex((account) => account.id === id);
    if (index === -1) return undefined;
    const current = this.accounts[index];
    const provider = normalizeProvider(patch.provider, current.provider);
    const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
    const status = normalizeStatus(patch.status, enabled ? current.status : 'disabled');
    const next: Account = {
      ...current,
      label: normalizeString(patch.label, current.label),
      provider,
      status: enabled ? status : 'disabled',
      enabled,
      maxConcurrency: normalizePositiveInteger(patch.maxConcurrency, current.maxConcurrency),
      currentConcurrency: normalizeNonNegativeInteger(patch.currentConcurrency, current.currentConcurrency),
      lastError: typeof patch.lastError === 'string' ? patch.lastError : patch.lastError === null ? null : current.lastError,
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

  firstAvailable(options: AccountAcquireOptions = {}): Account | undefined {
    const account = this.accounts.find((item) => canAcquire(item, options));
    return account ? cloneAccount(account) : undefined;
  }

  healthCheck(id: string): AccountView | undefined {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) return undefined;
    account.lastUsedAt = new Date().toISOString();
    account.lastError = null;
    account.status = account.enabled ? 'available' : 'disabled';
    return toAccountView(account);
  }

  markHealthy(id: string): AccountView | undefined {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) return undefined;
    account.lastUsedAt = new Date().toISOString();
    account.lastError = null;
    account.status = account.enabled ? 'available' : 'disabled';
    return toAccountView(account);
  }

  markError(id: string, error: unknown): AccountView | undefined {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) return undefined;
    account.lastUsedAt = new Date().toISOString();
    account.lastError = error instanceof Error ? error.message : String(error);
    account.status = account.enabled ? 'error' : 'disabled';
    return toAccountView(account);
  }

  acquire(options: AccountAcquireOptions = {}): Account | undefined {
    const account = this.accounts.find((item) => canAcquire(item, options));
    if (!account) return undefined;
    account.currentConcurrency += 1;
    account.lastUsedAt = new Date().toISOString();
    return cloneAccount(account);
  }

  release(id: string, error?: unknown): AccountView | undefined {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) return undefined;
    account.currentConcurrency = Math.max(0, account.currentConcurrency - 1);
    if (error !== undefined) {
      account.lastError = error instanceof Error ? error.message : String(error);
      account.status = 'error';
    } else if (account.enabled) {
      account.status = 'available';
    }
    return toAccountView(account);
  }
}

function createAccount(input: AccountCreateInput): Account {
  const now = new Date().toISOString();
  const provider = normalizeProvider(input.provider, 'mock');
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : true;
  return {
    id: normalizeId(input.id),
    label: normalizeString(input.label, provider === 'mock' ? 'Mock ChatGPT Account' : 'ChatGPT Session Account'),
    provider,
    status: enabled ? 'available' : 'disabled',
    enabled,
    maxConcurrency: normalizePositiveInteger(input.maxConcurrency, 1),
    currentConcurrency: 0,
    lastUsedAt: null,
    lastError: null,
    capabilities: normalizeStringArray(input.capabilities, provider === 'mock' ? ['mock', 'messages'] : ['chatgpt-session', 'messages']),
    secret: normalizeSecret(input.secret, provider),
    createdAt: now,
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

function toAccountView(account: Account): AccountView {
  const { secret: _secret, ...view } = account;
  return { ...view, capabilities: [...account.capabilities], hasSecret: Boolean(_secret) };
}

function normalizeId(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return `account-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
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
  return value === 'available' || value === 'unhealthy' || value === 'disabled' || value === 'error' ? value : fallback;
}

function normalizeProvider(value: unknown, fallback: AccountProvider): AccountProvider {
  return value === 'chatgpt-session' || value === 'mock' ? value : fallback;
}

function normalizeSecret(value: unknown, provider: AccountProvider): ChatGptSessionSecret | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (provider !== 'chatgpt-session' && raw.type !== 'chatgpt-session') return undefined;
  const secret: ChatGptSessionSecret = { type: 'chatgpt-session' };
  if (typeof raw.accessToken === 'string' && raw.accessToken.trim()) secret.accessToken = raw.accessToken.trim();
  if (typeof raw.cookie === 'string' && raw.cookie.trim()) secret.cookie = raw.cookie.trim();
  if (typeof raw.deviceId === 'string' && raw.deviceId.trim()) secret.deviceId = raw.deviceId.trim();
  if (typeof raw.userAgent === 'string' && raw.userAgent.trim()) secret.userAgent = raw.userAgent.trim();
  return secret;
}
