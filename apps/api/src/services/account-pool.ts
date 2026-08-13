export type AccountStatus = 'available' | 'unhealthy' | 'disabled' | 'error';

export interface Account {
  id: string;
  label: string;
  status: AccountStatus;
  enabled: boolean;
  maxConcurrency: number;
  currentConcurrency: number;
  lastUsedAt: string | null;
  lastError: string | null;
  capabilities: string[];
  createdAt: string;
}

export interface AccountCreateInput {
  id?: unknown;
  label?: unknown;
  enabled?: unknown;
  maxConcurrency?: unknown;
  capabilities?: unknown;
}

export interface AccountPatchInput {
  label?: unknown;
  status?: unknown;
  enabled?: unknown;
  maxConcurrency?: unknown;
  currentConcurrency?: unknown;
  lastError?: unknown;
  capabilities?: unknown;
}

export class AccountPool {
  private readonly accounts: Account[] = [createAccount({ id: 'mock-account', label: 'Mock ChatGPT Account' })];

  list(): Account[] { return this.accounts.map(cloneAccount); }

  add(input: AccountCreateInput): Account {
    const account = createAccount(input);
    if (this.accounts.some((item) => item.id === account.id)) throw new Error(`Account already exists: ${account.id}`);
    this.accounts.push(account);
    return cloneAccount(account);
  }

  update(id: string, patch: AccountPatchInput): Account | undefined {
    const index = this.accounts.findIndex((account) => account.id === id);
    if (index === -1) return undefined;
    const current = this.accounts[index];
    const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
    const status = normalizeStatus(patch.status, enabled ? current.status : 'disabled');
    const next: Account = {
      ...current,
      label: normalizeString(patch.label, current.label),
      status: enabled ? status : 'disabled',
      enabled,
      maxConcurrency: normalizePositiveInteger(patch.maxConcurrency, current.maxConcurrency),
      currentConcurrency: normalizeNonNegativeInteger(patch.currentConcurrency, current.currentConcurrency),
      lastError: typeof patch.lastError === 'string' ? patch.lastError : patch.lastError === null ? null : current.lastError,
      capabilities: normalizeStringArray(patch.capabilities, current.capabilities),
    };
    this.accounts[index] = next;
    return cloneAccount(next);
  }

  healthCheck(id: string): Account | undefined {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) return undefined;
    account.lastUsedAt = new Date().toISOString();
    account.lastError = null;
    account.status = account.enabled ? 'available' : 'disabled';
    return cloneAccount(account);
  }

  acquire(): Account | undefined {
    const account = this.accounts.find((item) => item.enabled && item.status === 'available' && item.currentConcurrency < item.maxConcurrency);
    if (!account) return undefined;
    account.currentConcurrency += 1;
    account.lastUsedAt = new Date().toISOString();
    return cloneAccount(account);
  }

  release(id: string, error?: unknown): Account | undefined {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) return undefined;
    account.currentConcurrency = Math.max(0, account.currentConcurrency - 1);
    if (error !== undefined) {
      account.lastError = error instanceof Error ? error.message : String(error);
      account.status = 'error';
    } else if (account.enabled) {
      account.status = 'available';
    }
    return cloneAccount(account);
  }
}

function createAccount(input: AccountCreateInput): Account {
  const now = new Date().toISOString();
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : true;
  return {
    id: normalizeId(input.id),
    label: normalizeString(input.label, 'Mock ChatGPT Account'),
    status: enabled ? 'available' : 'disabled',
    enabled,
    maxConcurrency: normalizePositiveInteger(input.maxConcurrency, 1),
    currentConcurrency: 0,
    lastUsedAt: null,
    lastError: null,
    capabilities: normalizeStringArray(input.capabilities, ['mock', 'messages']),
    createdAt: now,
  };
}

function cloneAccount(account: Account): Account {
  return { ...account, capabilities: [...account.capabilities] };
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
