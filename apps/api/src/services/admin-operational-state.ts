import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { dirname } from 'node:path';
import type { ChatGptDiscoveredModel, ChatGptModelControlCapabilities, ChatGptReasoningLevelOption, ChatGptServiceTierOption } from '@chatgpt-to-claude/chatgpt-backend';

const OPERATIONAL_STATE_VERSION = 1;
const DEFAULT_DEBOUNCE_MS = 1_000;

export interface OperationalAccountIdentity {
  accountId: string;
  createdAt: string;
}

export interface OperationalRequestStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  lastRequestAt: string | null;
  inFlight: number;
}

export interface OperationalHealthCheck {
  checkedAt: string;
  result: 'healthy' | 'unhealthy';
  message: string | null;
}

export interface SanitizedQuotaSnapshot {
  id: string;
  used?: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
}

export interface SanitizedQuotaCache {
  status: 'empty' | 'fresh' | 'stale';
  fetchedAt: string | null;
  expiresAt: string | null;
  snapshots: SanitizedQuotaSnapshot[];
}

export interface OperationalAccountSnapshot extends OperationalAccountIdentity {
  requestStats: OperationalRequestStats;
  lastHealthCheck: OperationalHealthCheck | null;
  discoveredModelIds: string[];
  discoveredModels: ChatGptDiscoveredModel[];
  quotaCache: SanitizedQuotaCache;
}

type PersistedRequestStats = Omit<OperationalRequestStats, 'inFlight'>;
interface PersistedOperationalAccount extends OperationalAccountIdentity {
  requestStats: PersistedRequestStats;
  lastHealthCheck: OperationalHealthCheck | null;
  discoveredModelIds: string[];
  discoveredModels: ChatGptDiscoveredModel[];
  quotaCache: SanitizedQuotaCache;
}
interface OperationalStateDocument {
  version: 1;
  accounts: PersistedOperationalAccount[];
}

export interface OperationalStateFileSystem {
  readFileSync(path: string, encoding: BufferEncoding): string;
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
  chmodSync(path: string, mode: number): void;
  openSync(path: string, flags: string, mode?: number): number;
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
}

export interface AdminOperationalStateOptions {
  path: string;
  debounceMs?: number;
  fs?: OperationalStateFileSystem;
}

export class AdminOperationalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminOperationalStateError';
  }
}

export class AdminOperationalState {
  private readonly fs: OperationalStateFileSystem;
  private readonly debounceMs: number;
  private readonly accounts = new Map<string, OperationalAccountSnapshot>();
  private persistTimer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private disposed = false;
  private persistenceError?: AdminOperationalStateError;

  constructor(private readonly options: AdminOperationalStateOptions) {
    this.fs = options.fs ?? nodeFs;
    this.debounceMs = options.debounceMs === undefined ? DEFAULT_DEBOUNCE_MS : nonNegativeInteger(options.debounceMs, 'debounceMs');
  }

  hydrate(): boolean {
    this.assertActive();
    let serialized: string;
    try {
      serialized = this.fs.readFileSync(this.options.path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw new AdminOperationalStateError(`Unable to read admin operational state file (${safeErrorCode(error)}).`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new AdminOperationalStateError('Admin operational state file contains invalid JSON.');
    }
    const document = validateDocument(parsed);
    this.accounts.clear();
    for (const account of document.accounts) {
      const snapshot = fromPersisted(account);
      this.accounts.set(identityKey(snapshot), snapshot);
    }
    this.dirty = false;
    this.persistenceError = undefined;
    return true;
  }

  snapshot(): { version: 1; accounts: OperationalAccountSnapshot[] } {
    this.assertActive();
    return { version: OPERATIONAL_STATE_VERSION, accounts: [...this.accounts.values()].map(cloneAccount) };
  }

  recordRequestStarted(identity: OperationalAccountIdentity): void {
    const account = this.getOrCreate(identity);
    account.requestStats.inFlight += 1;
    this.schedulePersist();
  }

  recordRequestFinished(identity: OperationalAccountIdentity, result: { success: boolean; inputTokens?: number; outputTokens?: number; at?: string }): void {
    const account = this.getOrCreate(identity);
    account.requestStats.inFlight = Math.max(0, account.requestStats.inFlight - 1);
    account.requestStats.totalRequests += 1;
    if (result.success) account.requestStats.successfulRequests += 1;
    else account.requestStats.failedRequests += 1;
    account.requestStats.inputTokens += optionalNonNegativeNumber(result.inputTokens, 'inputTokens') ?? 0;
    account.requestStats.outputTokens += optionalNonNegativeNumber(result.outputTokens, 'outputTokens') ?? 0;
    account.requestStats.lastRequestAt = result.at === undefined ? new Date().toISOString() : timestamp(result.at, 'at');
    this.schedulePersist();
  }

  setHealthCheck(identity: OperationalAccountIdentity, healthCheck: OperationalHealthCheck): void {
    const account = this.getOrCreate(identity);
    account.lastHealthCheck = {
      checkedAt: timestamp(healthCheck.checkedAt, 'checkedAt'),
      result: enumValue(healthCheck.result, ['healthy', 'unhealthy'] as const, 'result'),
      message: sanitizeHealthMessage(healthCheck.message),
    };
    this.schedulePersist();
  }

  setDiscoveredModelIds(identity: OperationalAccountIdentity, modelIds: string[]): void {
    this.setDiscoveredModels(identity, normalizeModelIds(modelIds).map((id) => ({ id })));
  }

  setDiscoveredModels(identity: OperationalAccountIdentity, models: ChatGptDiscoveredModel[]): void {
    const account = this.getOrCreate(identity);
    account.discoveredModels = sanitizeDiscoveredModels(models);
    account.discoveredModelIds = account.discoveredModels.map((model) => model.id);
    this.schedulePersist();
  }

  recordProvisioningSuccess(identity: OperationalAccountIdentity, models: ChatGptDiscoveredModel[], healthCheck: OperationalHealthCheck): void {
    const validatedIdentity = validateIdentity(identity, 'account identity');
    const validatedModels = sanitizeDiscoveredModels(models);
    const validatedHealth = validateHealthCheck(healthCheck, 'health check');
    const account = this.getOrCreate(validatedIdentity);
    account.discoveredModels = validatedModels;
    account.discoveredModelIds = validatedModels.map((model) => model.id);
    account.lastHealthCheck = validatedHealth;
    this.schedulePersist();
  }

  removeAccount(identity: OperationalAccountIdentity): boolean {
    this.assertWritable();
    const removed = this.accounts.delete(identityKey(validateIdentity(identity, 'account identity')));
    if (removed) this.schedulePersist();
    return removed;
  }

  setQuotaCache(identity: OperationalAccountIdentity, quotaCache: SanitizedQuotaCache): void {
    const account = this.getOrCreate(identity);
    account.quotaCache = validateQuotaCache(quotaCache, 'quotaCache');
    this.schedulePersist();
  }

  cleanupOrphans(validAccounts: OperationalAccountIdentity[]): number {
    this.assertWritable();
    const valid = new Set(validAccounts.map((identity) => identityKey(validateIdentity(identity, 'valid account'))));
    let removed = 0;
    for (const key of this.accounts.keys()) {
      if (valid.has(key)) continue;
      this.accounts.delete(key);
      removed += 1;
    }
    if (removed > 0) this.schedulePersist();
    return removed;
  }

  async flush(): Promise<void> {
    this.assertWritable();
    this.clearTimer();
    if (this.persistenceError) throw this.persistenceError;
    if (!this.dirty) return;
    this.persistNow();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.flush();
    } finally {
      this.clearTimer();
      this.disposed = true;
    }
  }

  private getOrCreate(identity: OperationalAccountIdentity): OperationalAccountSnapshot {
    this.assertWritable();
    const validated = validateIdentity(identity, 'account identity');
    const key = identityKey(validated);
    let account = this.accounts.get(key);
    if (!account) {
      account = {
        ...validated,
        requestStats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0, lastRequestAt: null, inFlight: 0 },
        lastHealthCheck: null,
        discoveredModelIds: [],
        discoveredModels: [],
        quotaCache: { status: 'empty', fetchedAt: null, expiresAt: null, snapshots: [] },
      };
      this.accounts.set(key, account);
    }
    return account;
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      if (!this.dirty || this.disposed) return;
      try {
        this.persistNow();
      } catch (error) {
        this.persistenceError = error instanceof AdminOperationalStateError ? error : new AdminOperationalStateError('Unable to persist admin operational state.');
      }
    }, this.debounceMs);
  }

  private persistNow(): void {
    const document = validateDocument({
      version: OPERATIONAL_STATE_VERSION,
      accounts: [...this.accounts.values()].map(toPersisted),
    });
    const contents = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    atomicWrite(this.fs, this.options.path, contents);
    this.dirty = false;
    this.persistenceError = undefined;
  }

  private clearTimer(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
  }

  private assertActive(): void {
    if (this.disposed) throw new AdminOperationalStateError('Admin operational state service is disposed.');
  }

  private assertWritable(): void {
    this.assertActive();
    if (this.persistenceError) throw this.persistenceError;
  }
}

function toPersisted(account: OperationalAccountSnapshot): PersistedOperationalAccount {
  const { inFlight: _inFlight, ...requestStats } = account.requestStats;
  return {
    accountId: account.accountId,
    createdAt: account.createdAt,
    requestStats: { ...requestStats },
    lastHealthCheck: account.lastHealthCheck ? { ...account.lastHealthCheck } : null,
    discoveredModelIds: [...account.discoveredModelIds],
    discoveredModels: cloneDiscoveredModels(account.discoveredModels),
    quotaCache: cloneQuotaCache(account.quotaCache),
  };
}

function fromPersisted(account: PersistedOperationalAccount): OperationalAccountSnapshot {
  return {
    accountId: account.accountId,
    createdAt: account.createdAt,
    requestStats: { ...account.requestStats, inFlight: 0 },
    lastHealthCheck: account.lastHealthCheck ? { ...account.lastHealthCheck } : null,
    discoveredModelIds: [...account.discoveredModelIds],
    discoveredModels: cloneDiscoveredModels(account.discoveredModels),
    quotaCache: cloneQuotaCache(account.quotaCache),
  };
}

function cloneAccount(account: OperationalAccountSnapshot): OperationalAccountSnapshot {
  return {
    ...account,
    requestStats: { ...account.requestStats },
    lastHealthCheck: account.lastHealthCheck ? { ...account.lastHealthCheck } : null,
    discoveredModelIds: [...account.discoveredModelIds],
    discoveredModels: cloneDiscoveredModels(account.discoveredModels),
    quotaCache: cloneQuotaCache(account.quotaCache),
  };
}

function cloneQuotaCache(cache: SanitizedQuotaCache): SanitizedQuotaCache {
  return { ...cache, snapshots: cache.snapshots.map((snapshot) => ({ ...snapshot })) };
}

function validateDocument(value: unknown): OperationalStateDocument {
  const root = strictObject(value, ['version', 'accounts'], 'admin operational state');
  if (root.version !== OPERATIONAL_STATE_VERSION) throw invalid('unsupported version; expected version 1');
  if (!Array.isArray(root.accounts)) throw invalid('accounts must be an array');
  const accounts = root.accounts.map((account, index) => validateAccount(account, index));
  const keys = accounts.map(identityKey);
  if (new Set(keys).size !== keys.length) throw invalid('accounts contains duplicate identities');
  return { version: OPERATIONAL_STATE_VERSION, accounts };
}

function validateAccount(value: unknown, index: number): PersistedOperationalAccount {
  const label = `accounts[${index}]`;
  const raw = strictObject(value, ['accountId', 'createdAt', 'requestStats', 'lastHealthCheck', 'discoveredModelIds', 'discoveredModels', 'quotaCache'], label, ['discoveredModels']);
  const identity = validateIdentity(raw, label);
  const stats = strictObject(raw.requestStats, ['totalRequests', 'successfulRequests', 'failedRequests', 'inputTokens', 'outputTokens', 'lastRequestAt'], `${label}.requestStats`);
  const requestStats: PersistedRequestStats = {
    totalRequests: nonNegativeInteger(stats.totalRequests, `${label}.requestStats.totalRequests`),
    successfulRequests: nonNegativeInteger(stats.successfulRequests, `${label}.requestStats.successfulRequests`),
    failedRequests: nonNegativeInteger(stats.failedRequests, `${label}.requestStats.failedRequests`),
    inputTokens: nonNegativeNumber(stats.inputTokens, `${label}.requestStats.inputTokens`),
    outputTokens: nonNegativeNumber(stats.outputTokens, `${label}.requestStats.outputTokens`),
    lastRequestAt: nullableTimestamp(stats.lastRequestAt, `${label}.requestStats.lastRequestAt`),
  };
  if (requestStats.successfulRequests + requestStats.failedRequests !== requestStats.totalRequests) throw invalid(`${label}.requestStats result counts must equal totalRequests`);
  if (!Array.isArray(raw.discoveredModelIds)) throw invalid(`${label}.discoveredModelIds must be an array`);
  const discoveredModelIds = raw.discoveredModelIds.map((id, modelIndex) => nonEmptyString(id, `${label}.discoveredModelIds[${modelIndex}]`));
  if (new Set(discoveredModelIds).size !== discoveredModelIds.length) throw invalid(`${label}.discoveredModelIds contains duplicates`);
  const discoveredModels = raw.discoveredModels === undefined
    ? discoveredModelIds.map((id) => ({ id }))
    : validateDiscoveredModels(raw.discoveredModels, `${label}.discoveredModels`);
  if (discoveredModels.length !== discoveredModelIds.length || discoveredModels.some((model, index) => model.id !== discoveredModelIds[index])) {
    throw invalid(`${label}.discoveredModels must match discoveredModelIds in order`);
  }
  return {
    ...identity,
    requestStats,
    lastHealthCheck: raw.lastHealthCheck === null ? null : validateHealthCheck(raw.lastHealthCheck, `${label}.lastHealthCheck`),
    discoveredModelIds,
    discoveredModels,
    quotaCache: validateQuotaCache(raw.quotaCache, `${label}.quotaCache`),
  };
}

function validateIdentity(value: unknown, label: string): OperationalAccountIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  return { accountId: nonEmptyString(raw.accountId, `${label}.accountId`), createdAt: timestamp(raw.createdAt, `${label}.createdAt`) };
}

function normalizeModelIds(modelIds: string[]): string[] {
  if (!Array.isArray(modelIds)) throw invalid('modelIds must be an array');
  return [...new Set(modelIds.map((id, index) => nonEmptyString(id, `modelIds[${index}]`)))].sort();
}

function sanitizeDiscoveredModels(models: ChatGptDiscoveredModel[]): ChatGptDiscoveredModel[] {
  if (!Array.isArray(models)) throw invalid('models must be an array');
  const byId = new Map<string, ChatGptDiscoveredModel>();
  models.forEach((model, index) => {
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw invalid(`models[${index}] must be an object`);
    const id = nonEmptyString(model.id, `models[${index}].id`);
    if (!byId.has(id)) byId.set(id, sanitizeDiscoveredModel(model, `models[${index}]`));
  });
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function validateDiscoveredModels(value: unknown, label: string): ChatGptDiscoveredModel[] {
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`);
  const models = value.map((model, index) => {
    const raw = strictObject(model, ['id', 'displayName', 'controls'], `${label}[${index}]`, ['displayName', 'controls']);
    return sanitizeDiscoveredModel(raw as unknown as ChatGptDiscoveredModel, `${label}[${index}]`, true);
  });
  if (new Set(models.map((model) => model.id)).size !== models.length) throw invalid(`${label} contains duplicate ids`);
  return models;
}

function sanitizeDiscoveredModel(model: ChatGptDiscoveredModel, label: string, persisted = false): ChatGptDiscoveredModel {
  const id = nonEmptyString(model.id, `${label}.id`);
  const displayName = model.displayName === undefined ? undefined : nonEmptyString(model.displayName, `${label}.displayName`);
  const controls = model.controls === undefined ? undefined : sanitizeModelControls(model.controls, `${label}.controls`, persisted);
  return { id, ...(displayName ? { displayName } : {}), ...(controls ? { controls } : {}) };
}

function sanitizeModelControls(value: ChatGptModelControlCapabilities, label: string, persisted: boolean): ChatGptModelControlCapabilities {
  const raw = persisted
    ? strictObject(value, ['reasoning', 'serviceTier'], label)
    : value as unknown as Record<string, unknown>;
  const reasoningRaw = persisted
    ? strictObject(raw.reasoning, ['metadataKnown', 'supported', 'defaultEffort', 'multiAgent'], `${label}.reasoning`, ['defaultEffort', 'multiAgent'])
    : raw.reasoning as Record<string, unknown>;
  const serviceRaw = persisted
    ? strictObject(raw.serviceTier, ['metadataKnown', 'supported', 'defaultTier', 'fastMode'], `${label}.serviceTier`, ['defaultTier'])
    : raw.serviceTier as Record<string, unknown>;
  if (!reasoningRaw || !serviceRaw) throw invalid(`${label} must include reasoning and serviceTier`);
  if (!Array.isArray(reasoningRaw.supported)) throw invalid(`${label}.reasoning.supported must be an array`);
  if (!Array.isArray(serviceRaw.supported)) throw invalid(`${label}.serviceTier.supported must be an array`);
  const reasoningSupported = reasoningRaw.supported.map((option, index) => sanitizeReasoningOption(option, `${label}.reasoning.supported[${index}]`, persisted));
  const serviceSupported = serviceRaw.supported.map((option, index) => sanitizeServiceTierOption(option, `${label}.serviceTier.supported[${index}]`, persisted));
  return {
    reasoning: {
      metadataKnown: booleanValue(reasoningRaw.metadataKnown, `${label}.reasoning.metadataKnown`),
      supported: reasoningSupported,
      ...(reasoningRaw.defaultEffort === undefined ? {} : { defaultEffort: nonEmptyString(reasoningRaw.defaultEffort, `${label}.reasoning.defaultEffort`) }),
      ...(reasoningRaw.multiAgent === undefined ? {} : { multiAgent: sanitizeMultiAgent(reasoningRaw.multiAgent, `${label}.reasoning.multiAgent`) }),
    },
    serviceTier: {
      metadataKnown: booleanValue(serviceRaw.metadataKnown, `${label}.serviceTier.metadataKnown`),
      supported: serviceSupported,
      ...(serviceRaw.defaultTier === undefined ? {} : { defaultTier: nonEmptyString(serviceRaw.defaultTier, `${label}.serviceTier.defaultTier`) }),
      fastMode: booleanValue(serviceRaw.fastMode, `${label}.serviceTier.fastMode`),
    },
  };
}

function sanitizeReasoningOption(value: unknown, label: string, persisted: boolean): ChatGptReasoningLevelOption {
  const raw = persisted ? strictObject(value, ['effort', 'description'], label, ['description']) : objectValue(value, label);
  return {
    effort: nonEmptyString(raw.effort, `${label}.effort`),
    ...(raw.description === undefined ? {} : { description: nonEmptyString(raw.description, `${label}.description`) }),
  };
}

function sanitizeServiceTierOption(value: unknown, label: string, persisted: boolean): ChatGptServiceTierOption {
  const raw = persisted ? strictObject(value, ['id', 'name', 'description'], label, ['name', 'description']) : objectValue(value, label);
  return {
    id: nonEmptyString(raw.id, `${label}.id`),
    ...(raw.name === undefined ? {} : { name: nonEmptyString(raw.name, `${label}.name`) }),
    ...(raw.description === undefined ? {} : { description: nonEmptyString(raw.description, `${label}.description`) }),
  };
}

function sanitizeMultiAgent(value: unknown, label: string): unknown {
  const raw = objectValue(value, label);
  const result: Record<string, unknown> = {};
  for (const key of ['effort', 'reasoning_effort', 'reasoningEffort', 'default_reasoning_level', 'defaultReasoningLevel'] as const) {
    if (raw[key] !== undefined) result[key] = nonEmptyString(raw[key], `${label}.${key}`);
  }
  for (const key of ['supported_reasoning_levels', 'supportedReasoningLevels'] as const) {
    const supported = raw[key];
    if (supported === undefined) continue;
    if (!Array.isArray(supported)) throw invalid(`${label}.${key} must be an array`);
    result[key] = supported.map((item, index) => typeof item === 'string'
      ? nonEmptyString(item, `${label}.${key}[${index}]`)
      : { effort: nonEmptyString(objectValue(item, `${label}.${key}[${index}]`).effort, `${label}.${key}[${index}].effort`) });
  }
  return result;
}

function cloneDiscoveredModels(models: ChatGptDiscoveredModel[]): ChatGptDiscoveredModel[] {
  return models.map((model) => sanitizeDiscoveredModel(model, 'discovered model'));
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function validateHealthCheck(value: unknown, label: string): OperationalHealthCheck {
  const raw = strictObject(value, ['checkedAt', 'result', 'message'], label);
  return {
    checkedAt: timestamp(raw.checkedAt, `${label}.checkedAt`),
    result: enumValue(raw.result, ['healthy', 'unhealthy'] as const, `${label}.result`),
    message: persistedHealthMessage(raw.message, `${label}.message`),
  };
}

function validateQuotaCache(value: unknown, label: string): SanitizedQuotaCache {
  const raw = strictObject(value, ['status', 'fetchedAt', 'expiresAt', 'snapshots'], label);
  if (!Array.isArray(raw.snapshots)) throw invalid(`${label}.snapshots must be an array`);
  const snapshots = raw.snapshots.map((snapshot, index) => validateQuotaSnapshot(snapshot, `${label}.snapshots[${index}]`));
  if (new Set(snapshots.map((snapshot) => snapshot.id)).size !== snapshots.length) throw invalid(`${label}.snapshots contains duplicate ids`);
  return {
    status: enumValue(raw.status, ['empty', 'fresh', 'stale'] as const, `${label}.status`),
    fetchedAt: nullableTimestamp(raw.fetchedAt, `${label}.fetchedAt`),
    expiresAt: nullableTimestamp(raw.expiresAt, `${label}.expiresAt`),
    snapshots,
  };
}

function validateQuotaSnapshot(value: unknown, label: string): SanitizedQuotaSnapshot {
  const raw = strictObject(value, ['id', 'used', 'limit', 'remaining', 'resetAt'], label, ['used', 'limit', 'remaining', 'resetAt']);
  return {
    id: nonEmptyString(raw.id, `${label}.id`),
    ...(raw.used === undefined ? {} : { used: nonNegativeNumber(raw.used, `${label}.used`) }),
    ...(raw.limit === undefined ? {} : { limit: nonNegativeNumber(raw.limit, `${label}.limit`) }),
    ...(raw.remaining === undefined ? {} : { remaining: nonNegativeNumber(raw.remaining, `${label}.remaining`) }),
    ...(raw.resetAt === undefined ? {} : { resetAt: timestamp(raw.resetAt, `${label}.resetAt`) }),
  };
}

function atomicWrite(fs: OperationalStateFileSystem, path: string, contents: Buffer): void {
  const parent = dirname(path);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let fd: number | undefined;
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    setModeIfSupported(fs, parent, 0o700);
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    let offset = 0;
    while (offset < contents.length) {
      const written = fs.writeSync(fd, contents, offset, contents.length - offset);
      if (written <= 0) throw new Error('write returned no progress');
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryPath, path);
    setModeIfSupported(fs, path, 0o600);
    fsyncDirectoryIfSupported(fs, parent);
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.unlinkSync(temporaryPath); } catch { /* best effort */ }
    throw new AdminOperationalStateError(`Unable to persist admin operational state atomically (${safeErrorCode(error)}).`);
  }
}

function identityKey(identity: OperationalAccountIdentity): string {
  return JSON.stringify([identity.accountId, identity.createdAt]);
}

function strictObject(value: unknown, allowed: string[], label: string, optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw invalid(`${label} contains unknown fields`);
  const missing = allowed.filter((key) => !optional.includes(key) && !Object.prototype.hasOwnProperty.call(raw, key));
  if (missing.length > 0) throw invalid(`${label} is missing required fields`);
  return raw;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) throw invalid(`${label} must be a non-empty string without surrounding whitespace`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(result))) throw invalid(`${label} must be a valid timestamp`);
  return result;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalid(`${label} must be a boolean`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw invalid(`${label} must be a non-negative integer`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalid(`${label} must be a non-negative finite number`);
  return value;
}

function optionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : nonNegativeNumber(value, label);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalid(`${label} has an unsupported value`);
  return value as T;
}

function sanitizeHealthMessage(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw invalid('health check message must be a string or null');
  const firstLine = value.split(/\r?\n/, 1)[0].trim();
  return firstLine ? firstLine.slice(0, 500) : null;
}

function persistedHealthMessage(value: unknown, label: string): string | null {
  if (value === null) return null;
  const message = nonEmptyString(value, label);
  if (message.length > 500 || /[\r\n]/.test(message)) throw invalid(`${label} must be a single-line string of at most 500 characters`);
  return message;
}

function invalid(detail: string): AdminOperationalStateError {
  return new AdminOperationalStateError(`Invalid admin operational state schema: ${detail}.`);
}

function setModeIfSupported(fs: OperationalStateFileSystem, path: string, mode: number): void {
  try { fs.chmodSync(path, mode); } catch (error) { if (!isUnsupportedFileSystemOperation(error)) throw error; }
}

function fsyncDirectoryIfSupported(fs: OperationalStateFileSystem, path: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!isUnsupportedFileSystemOperation(error)) throw error;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

function isUnsupportedFileSystemOperation(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOSYS' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EINVAL' || code === 'EISDIR'));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined;
}

function safeErrorCode(error: unknown): string {
  return errorCode(error) ?? 'I/O error';
}
