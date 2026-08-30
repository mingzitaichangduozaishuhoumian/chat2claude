import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { dirname } from 'node:path';
import type { ChatGptBackendErrorCode, ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';
import type { AccountProvider, AccountStatus, AccountPoolState, PersistedAccount } from './account-pool.js';
import { legacyRuntimeApiKeyId, type RuntimeApiKeyRecord, type RuntimeApiKeysPersistedSnapshot, type RuntimeApiKeysSnapshot } from './runtime-api-keys.js';

const STATE_VERSION = 1;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

export interface RuntimeStateV1 {
  version: 1;
  accounts: PersistedAccount[];
  runtimeApiKeys: RuntimeApiKeysPersistedSnapshot;
}

interface EncryptedRuntimeStateV1 {
  version: 1;
  encryption: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface RuntimeStateFileSystem {
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

export interface RuntimeStateStoreOptions {
  path: string;
  encryptionKey?: Uint8Array;
  fs?: RuntimeStateFileSystem;
}

export class RuntimeStateStoreError extends Error {
  constructor(message: string, readonly stateCommitted = false) {
    super(message);
    this.name = 'RuntimeStateStoreError';
  }
}

export class RuntimeStateStore {
  private readonly fs: RuntimeStateFileSystem;
  private readonly encryptionKey?: Buffer;

  constructor(private readonly options: RuntimeStateStoreOptions) {
    this.fs = options.fs ?? nodeFs;
    this.encryptionKey = options.encryptionKey ? Buffer.from(options.encryptionKey) : undefined;
    if (this.encryptionKey && this.encryptionKey.length !== 32) throw new RuntimeStateStoreError('Runtime state encryption key must contain exactly 32 bytes.');
  }

  load(): RuntimeStateV1 | undefined {
    let serialized: string;
    try {
      serialized = this.fs.readFileSync(this.options.path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw new RuntimeStateStoreError(`Unable to read runtime state file (${safeErrorCode(error)}).`);
    }

    let document: unknown;
    try {
      document = JSON.parse(serialized);
    } catch {
      throw new RuntimeStateStoreError('Runtime state file contains invalid JSON.');
    }

    if (isEncryptedDocument(document)) {
      const envelope = validateEncryptedDocument(document);
      if (!this.encryptionKey) throw new RuntimeStateStoreError('Runtime state file is encrypted but STATE_ENCRYPTION_KEY is not configured.');
      return validateState(this.decrypt(envelope));
    }
    if (this.encryptionKey) throw new RuntimeStateStoreError('Runtime state encryption mismatch: encrypted state was required.');
    return validateState(document);
  }

  save(state: RuntimeStateV1): void {
    const validated = validateState(state);
    const serialized = `${JSON.stringify(this.encryptionKey ? this.encrypt(validated) : validated, null, 2)}\n`;
    this.atomicWrite(Buffer.from(serialized, 'utf8'));
  }

  private encrypt(state: RuntimeStateV1): EncryptedRuntimeStateV1 {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, this.encryptionKey!, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
    return {
      version: STATE_VERSION,
      encryption: ENCRYPTION_ALGORITHM,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  private decrypt(envelope: EncryptedRuntimeStateV1): unknown {
    try {
      const iv = decodeBase64(envelope.iv, 12, 'iv');
      const tag = decodeBase64(envelope.tag, 16, 'authentication tag');
      const ciphertext = decodeBase64(envelope.ciphertext, undefined, 'ciphertext');
      const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, this.encryptionKey!, iv);
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    } catch (error) {
      if (error instanceof RuntimeStateStoreError) throw error;
      throw new RuntimeStateStoreError('Unable to decrypt runtime state file; the key or encrypted data does not match.');
    }
  }

  private atomicWrite(contents: Buffer): void {
    const parent = dirname(this.options.path);
    const temporaryPath = `${this.options.path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    let fd: number | undefined;
    let stateCommitted = false;
    try {
      this.fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      setModeIfSupported(this.fs, parent, 0o700);
      fd = this.fs.openSync(temporaryPath, 'wx', 0o600);
      let offset = 0;
      while (offset < contents.length) {
        const written = this.fs.writeSync(fd, contents, offset, contents.length - offset);
        if (written <= 0) throw new Error('write returned no progress');
        offset += written;
      }
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = undefined;
      this.fs.renameSync(temporaryPath, this.options.path);
      stateCommitted = true;
      setModeIfSupported(this.fs, this.options.path, 0o600);
      fsyncDirectoryIfSupported(this.fs, parent);
    } catch (error) {
      if (fd !== undefined) {
        try { this.fs.closeSync(fd); } catch { /* best effort */ }
      }
      try { this.fs.unlinkSync(temporaryPath); } catch { /* best effort */ }
      throw new RuntimeStateStoreError(`Unable to persist runtime state atomically (${safeErrorCode(error)}).`, stateCommitted);
    }
  }
}

export function createRuntimeState(accounts: AccountPoolState, runtimeApiKeys: RuntimeApiKeysSnapshot): RuntimeStateV1 {
  return validateState({ version: STATE_VERSION, accounts: accounts.accounts, runtimeApiKeys });
}

function validateState(value: unknown): RuntimeStateV1 {
  const root = strictObject(value, ['version', 'accounts', 'runtimeApiKeys'], 'runtime state');
  if (root.version !== STATE_VERSION) throw new RuntimeStateStoreError('Unsupported runtime state version. Expected version 1.');
  if (!Array.isArray(root.accounts)) throw invalid('accounts must be an array');
  const accounts = root.accounts.map((account, index) => validateAccount(account, index));
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length) throw invalid('accounts contains duplicate ids');
  const runtimeApiKeys = validateRuntimeApiKeys(root.runtimeApiKeys);
  return { version: STATE_VERSION, accounts, runtimeApiKeys };
}

function validateAccount(value: unknown, index: number): PersistedAccount {
  const label = `accounts[${index}]`;
  const raw = strictObject(value, ['id', 'label', 'provider', 'status', 'enabled', 'maxConcurrency', 'lastUsedAt', 'lastError', 'lastErrorCode', 'cooldownUntil', 'capabilities', 'secret', 'createdAt'], label, ['secret']);
  const provider = enumValue(raw.provider, ['mock', 'chatgpt-session'] as const, `${label}.provider`);
  return {
    id: nonEmptyString(raw.id, `${label}.id`),
    label: nonEmptyString(raw.label, `${label}.label`),
    provider,
    status: enumValue(raw.status, ['available', 'unhealthy', 'disabled', 'error', 'cooldown'] as const, `${label}.status`) as AccountStatus,
    enabled: booleanValue(raw.enabled, `${label}.enabled`),
    maxConcurrency: positiveInteger(raw.maxConcurrency, `${label}.maxConcurrency`),
    lastUsedAt: nullableTimestamp(raw.lastUsedAt, `${label}.lastUsedAt`),
    lastError: nullableString(raw.lastError, `${label}.lastError`),
    lastErrorCode: nullableEnum(raw.lastErrorCode, ['unauthorized', 'rate_limited', 'upstream_error', 'timeout', 'network_error', 'invalid_response'] as const, `${label}.lastErrorCode`) as ChatGptBackendErrorCode | null,
    cooldownUntil: nullableTimestamp(raw.cooldownUntil, `${label}.cooldownUntil`),
    capabilities: nonEmptyStringArray(raw.capabilities, `${label}.capabilities`),
    secret: raw.secret === undefined ? undefined : validateSecret(raw.secret, `${label}.secret`, provider),
    createdAt: timestamp(raw.createdAt, `${label}.createdAt`),
  };
}

function validateSecret(value: unknown, label: string, provider: AccountProvider): ChatGptSessionSecret {
  if (provider !== 'chatgpt-session') throw invalid(`${label} is only valid for chatgpt-session accounts`);
  const raw = strictObject(value, ['type', 'accessToken', 'refreshToken', 'idToken', 'expiresAt', 'email', 'accountId', 'planType', 'cookie', 'deviceId', 'userAgent'], label, ['accessToken', 'refreshToken', 'idToken', 'expiresAt', 'email', 'accountId', 'planType', 'cookie', 'deviceId', 'userAgent']);
  if (raw.type !== 'chatgpt-session') throw invalid(`${label}.type must be chatgpt-session`);
  const secret: ChatGptSessionSecret = { type: 'chatgpt-session' };
  for (const field of ['accessToken', 'refreshToken', 'idToken', 'expiresAt', 'email', 'accountId', 'planType', 'cookie', 'deviceId', 'userAgent'] as const) {
    if (raw[field] !== undefined) secret[field] = field === 'expiresAt' ? timestamp(raw[field], `${label}.${field}`) : nonEmptyString(raw[field], `${label}.${field}`);
  }
  if (!secret.accessToken) throw invalid(`${label}.accessToken is required`);
  return secret;
}

function validateRuntimeApiKeys(value: unknown): RuntimeApiKeysSnapshot {
  const raw = strictObject(value, undefined, 'runtimeApiKeys');
  if (Object.prototype.hasOwnProperty.call(raw, 'records')) return validateRuntimeApiKeyRecords(raw);
  return normalizeLegacyRuntimeApiKeys(raw);
}

function validateRuntimeApiKeyRecords(raw: Record<string, unknown>): RuntimeApiKeysSnapshot {
  const validated = strictObject(raw, ['records'], 'runtimeApiKeys');
  if (!Array.isArray(validated.records)) throw invalid('runtimeApiKeys.records must be an array');
  const records = validated.records.map((value, index) => {
    const record = strictObject(value, ['id', 'key', 'name', 'createdAt'], `runtimeApiKeys.records[${index}]`, ['name']);
    return {
      id: nonEmptyString(record.id, `runtimeApiKeys.records[${index}].id`),
      key: nonEmptyString(record.key, `runtimeApiKeys.records[${index}].key`),
      ...(record.name === undefined ? {} : { name: nonEmptyString(record.name, `runtimeApiKeys.records[${index}].name`) }),
      createdAt: timestamp(record.createdAt, `runtimeApiKeys.records[${index}].createdAt`),
    } satisfies RuntimeApiKeyRecord;
  });
  if (new Set(records.map((record) => record.id)).size !== records.length) throw invalid('runtimeApiKeys.records contains duplicate ids');
  if (new Set(records.map((record) => record.key)).size !== records.length) throw invalid('runtimeApiKeys.records contains duplicate keys');
  const names = records.flatMap((record) => record.name ? [record.name] : []);
  if (new Set(names).size !== names.length) throw invalid('runtimeApiKeys.records contains duplicate names');
  return { records };
}

function normalizeLegacyRuntimeApiKeys(raw: Record<string, unknown>): RuntimeApiKeysSnapshot {
  const legacy = strictObject(raw, ['keys', 'namedKeys'], 'runtimeApiKeys');
  if (!Array.isArray(legacy.keys)) throw invalid('runtimeApiKeys.keys must be an array');
  const keys = legacy.keys.map((key, index) => nonEmptyString(key, `runtimeApiKeys.keys[${index}]`));
  if (new Set(keys).size !== keys.length) throw invalid('runtimeApiKeys.keys contains duplicates');
  const namedRaw = strictObject(legacy.namedKeys, undefined, 'runtimeApiKeys.namedKeys');
  const namesByKey = new Map<string, string>();
  for (const [name, key] of Object.entries(namedRaw)) {
    const normalizedName = nonEmptyString(name, 'runtimeApiKeys named key name');
    const normalizedKey = nonEmptyString(key, `runtimeApiKeys.namedKeys.${normalizedName}`);
    if (!keys.includes(normalizedKey)) throw invalid(`runtimeApiKeys.namedKeys.${normalizedName} references an unknown key`);
    namesByKey.set(normalizedKey, normalizedName);
  }
  return { records: keys.map((key) => ({ id: legacyRuntimeApiKeyId(key), key, ...(namesByKey.has(key) ? { name: namesByKey.get(key)! } : {}), createdAt: new Date(0).toISOString() })) };
}

function isEncryptedDocument(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).encryption !== undefined;
}

function validateEncryptedDocument(value: unknown): EncryptedRuntimeStateV1 {
  const raw = strictObject(value, ['version', 'encryption', 'iv', 'tag', 'ciphertext'], 'encrypted runtime state');
  if (raw.version !== STATE_VERSION) throw new RuntimeStateStoreError('Unsupported encrypted runtime state version. Expected version 1.');
  if (raw.encryption !== ENCRYPTION_ALGORITHM) throw new RuntimeStateStoreError('Unsupported runtime state encryption algorithm.');
  return {
    version: STATE_VERSION,
    encryption: ENCRYPTION_ALGORITHM,
    iv: nonEmptyString(raw.iv, 'encrypted runtime state iv'),
    tag: nonEmptyString(raw.tag, 'encrypted runtime state authentication tag'),
    ciphertext: nonEmptyString(raw.ciphertext, 'encrypted runtime state ciphertext'),
  };
}

function strictObject(value: unknown, allowed: string[] | undefined, label: string, optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (allowed) {
    const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) throw invalid(`${label} contains unknown fields`);
    const missing = allowed.filter((key) => !optional.includes(key) && !Object.prototype.hasOwnProperty.call(raw, key));
    if (missing.length > 0) throw invalid(`${label} is missing required fields`);
  }
  return raw;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw invalid(`${label} must be a non-empty string without surrounding whitespace`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : nonEmptyString(value, label);
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

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw invalid(`${label} must be a positive integer`);
  return value;
}

function nonEmptyStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`);
  const result = value.map((item, index) => nonEmptyString(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw invalid(`${label} contains duplicates`);
  return result;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalid(`${label} has an unsupported value`);
  return value as T;
}

function nullableEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T | null {
  return value === null ? null : enumValue(value, allowed, label);
}

function invalid(detail: string): RuntimeStateStoreError {
  return new RuntimeStateStoreError(`Invalid runtime state schema: ${detail}.`);
}

function decodeBase64(value: string, expectedLength: number | undefined, label: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new RuntimeStateStoreError(`Encrypted runtime state ${label} is malformed.`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new RuntimeStateStoreError(`Encrypted runtime state ${label} is malformed.`);
  if (expectedLength !== undefined && decoded.length !== expectedLength) throw new RuntimeStateStoreError(`Encrypted runtime state ${label} has an invalid length.`);
  if (expectedLength === undefined && decoded.length === 0) throw new RuntimeStateStoreError(`Encrypted runtime state ${label} is empty.`);
  return decoded;
}

function setModeIfSupported(fs: RuntimeStateFileSystem, path: string, mode: number): void {
  try { fs.chmodSync(path, mode); } catch (error) {
    if (!isUnsupportedFileSystemOperation(error)) throw error;
  }
}

function fsyncDirectoryIfSupported(fs: RuntimeStateFileSystem, path: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!isUnsupportedFileSystemOperation(error)) throw error;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
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
