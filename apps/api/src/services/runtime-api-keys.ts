export class RuntimeApiKeys {
  private readonly keys = new Set<string>();

  list(): string[] {
    return Array.from(this.keys);
  }

  add(key: string): void {
    const normalized = key.trim();
    if (normalized) this.keys.add(normalized);
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  get size(): number {
    return this.keys.size;
  }
}
