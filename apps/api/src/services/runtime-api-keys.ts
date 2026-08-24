import { randomBytes } from 'node:crypto';

export const RUNTIME_API_KEY_PREFIX = 'sk-runtime-';
export const DEV_API_KEY_PREFIX = 'sk-dev-';

export interface PreparedRuntimeApiKey {
  name: string;
  key: string;
}

export class RuntimeApiKeys {
  private readonly keys = new Set<string>();
  private readonly namedKeys = new Map<string, string>();

  list(): string[] {
    return Array.from(this.keys);
  }

  add(key: string): void {
    const normalized = key.trim();
    if (normalized) this.keys.add(normalized);
  }

  create(prefix = RUNTIME_API_KEY_PREFIX): string {
    const key = `${prefix}${randomBytes(24).toString('base64url')}`;
    this.keys.add(key);
    return key;
  }

  getOrCreate(name: string, prefix = RUNTIME_API_KEY_PREFIX): string {
    return this.commitPreparedNamedKey(this.prepareNamedKey(name, prefix));
  }

  prepareNamedKey(name: string, prefix = RUNTIME_API_KEY_PREFIX): PreparedRuntimeApiKey {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error('Runtime API key name is required.');
    return {
      name: normalizedName,
      key: this.namedKeys.get(normalizedName) ?? `${prefix}${randomBytes(24).toString('base64url')}`,
    };
  }

  commitPreparedNamedKey(prepared: PreparedRuntimeApiKey): string {
    const existing = this.namedKeys.get(prepared.name);
    if (existing) return existing;
    this.keys.add(prepared.key);
    this.namedKeys.set(prepared.name, prepared.key);
    return prepared.key;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  hasAny(): boolean {
    return this.keys.size > 0;
  }

  get isEmpty(): boolean {
    return this.keys.size === 0;
  }

  get size(): number {
    return this.keys.size;
  }
}
