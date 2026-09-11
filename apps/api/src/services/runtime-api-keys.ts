import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const RUNTIME_API_KEY_PREFIX = 'sk-runtime-';
export const DEV_API_KEY_PREFIX = 'sk-dev-';

export interface RuntimeApiKeyRecord {
  id: string;
  key: string;
  name?: string;
  createdAt: string;
}

export interface RuntimeApiKeyView {
  id: string;
  name?: string;
  createdAt: string;
  prefix: string;
}

export interface PreparedRuntimeApiKey {
  id: string;
  name: string;
  key: string;
  createdAt: string;
}

export interface RuntimeApiKeysSnapshot {
  records: RuntimeApiKeyRecord[];
}

export interface LegacyRuntimeApiKeysSnapshot {
  keys: string[];
  namedKeys: Record<string, string>;
}

export type RuntimeApiKeysPersistedSnapshot = RuntimeApiKeysSnapshot | LegacyRuntimeApiKeysSnapshot;

export class RuntimeApiKeys {
  private readonly records = new Map<string, RuntimeApiKeyRecord>();
  private readonly idsByKey = new Map<string, string>();
  private readonly idsByName = new Map<string, string>();

  list(): string[] {
    return Array.from(this.idsByKey.keys());
  }

  listSafe(): RuntimeApiKeyView[] {
    return Array.from(this.records.values(), toSafeView).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  exportState(): RuntimeApiKeysSnapshot {
    return { records: Array.from(this.records.values(), cloneRecord) };
  }

  snapshot(): RuntimeApiKeysSnapshot {
    return this.exportState();
  }

  importState(snapshot: RuntimeApiKeysPersistedSnapshot): void {
    this.restore(snapshot);
  }

  restore(snapshot: RuntimeApiKeysPersistedSnapshot): void {
    this.records.clear();
    this.idsByKey.clear();
    this.idsByName.clear();
    for (const record of normalizeSnapshot(snapshot)) this.insert(record);
  }

  add(key: string): void {
    const normalized = key.trim();
    if (normalized && !this.idsByKey.has(normalized)) this.insert(createRecord(normalized));
  }

  create(prefix = RUNTIME_API_KEY_PREFIX, name?: string): string {
    const key = `${prefix}${randomBytes(24).toString('base64url')}`;
    this.insert(createRecord(key, name));
    return key;
  }

  getOrCreate(name: string, prefix = RUNTIME_API_KEY_PREFIX): string {
    return this.commitPreparedNamedKey(this.prepareNamedKey(name, prefix));
  }

  prepareNamedKey(name: string, prefix = RUNTIME_API_KEY_PREFIX): PreparedRuntimeApiKey {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error('Runtime API key name is required.');
    const existing = this.getByName(normalizedName);
    return existing
      ? { id: existing.id, name: normalizedName, key: existing.key, createdAt: existing.createdAt }
      : { id: randomUUID(), name: normalizedName, key: `${prefix}${randomBytes(24).toString('base64url')}`, createdAt: new Date().toISOString() };
  }

  commitPreparedNamedKey(prepared: PreparedRuntimeApiKey): string {
    const existing = this.getByName(prepared.name);
    if (existing) return existing.key;
    if (this.idsByKey.has(prepared.key)) throw new Error('Runtime API key already exists with a different name.');
    this.insert({ id: prepared.id, name: prepared.name, key: prepared.key, createdAt: prepared.createdAt });
    return prepared.key;
  }

  revoke(id: string): RuntimeApiKeyView | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    this.records.delete(id);
    this.idsByKey.delete(record.key);
    if (record.name) this.idsByName.delete(record.name);
    return toSafeView(record);
  }

  has(key: string): boolean {
    return this.idsByKey.has(key);
  }

  /** Non-secret record identity; revoke/recreate must not inherit replay state. */
  identityForKey(key: string): string | undefined {
    return this.idsByKey.get(key);
  }

  hasAny(): boolean {
    return this.records.size > 0;
  }

  get isEmpty(): boolean {
    return this.records.size === 0;
  }

  get size(): number {
    return this.records.size;
  }

  private getByName(name: string): RuntimeApiKeyRecord | undefined {
    const id = this.idsByName.get(name);
    return id ? this.records.get(id) : undefined;
  }

  private insert(record: RuntimeApiKeyRecord): void {
    if (this.records.has(record.id) || this.idsByKey.has(record.key) || (record.name && this.idsByName.has(record.name))) throw new Error('Runtime API key snapshot contains duplicate identifiers.');
    const stored = cloneRecord(record);
    this.records.set(stored.id, stored);
    this.idsByKey.set(stored.key, stored.id);
    if (stored.name) this.idsByName.set(stored.name, stored.id);
  }
}

function normalizeSnapshot(snapshot: RuntimeApiKeysPersistedSnapshot): RuntimeApiKeyRecord[] {
  if ('records' in snapshot) return snapshot.records.map(cloneRecord);
  const namesByKey = new Map<string, string>();
  for (const [name, key] of Object.entries(snapshot.namedKeys)) namesByKey.set(key, name);
  return snapshot.keys.map((key) => createRecord(key, namesByKey.get(key), legacyRuntimeApiKeyId(key)));
}

function createRecord(key: string, name?: string, id: string = randomUUID(), createdAt = new Date().toISOString()): RuntimeApiKeyRecord {
  return { id, key, ...(name ? { name } : {}), createdAt };
}

export function legacyRuntimeApiKeyId(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function cloneRecord(record: RuntimeApiKeyRecord): RuntimeApiKeyRecord {
  return { ...record };
}

function toSafeView(record: RuntimeApiKeyRecord): RuntimeApiKeyView {
  return { id: record.id, ...(record.name ? { name: record.name } : {}), createdAt: record.createdAt, prefix: record.key.slice(0, Math.min(record.key.length, 12)) };
}
