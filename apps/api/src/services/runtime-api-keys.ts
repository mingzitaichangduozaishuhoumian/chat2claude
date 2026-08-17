import { randomBytes } from 'node:crypto';

export const RUNTIME_API_KEY_PREFIX = 'sk-runtime-';
export const DEV_API_KEY_PREFIX = 'sk-dev-';

export class RuntimeApiKeys {
  private readonly keys = new Set<string>();

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
