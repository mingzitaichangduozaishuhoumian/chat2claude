export interface RequestLogEntry { route: string; model?: string; stream?: boolean; time: string; }

export interface RequestLogSummary {
  retained: number;
  streams: number;
  byRoute: Record<string, number>;
}

export interface RequestLogOptions { maxEntries?: number; now?: () => Date; }

/** Stores only safe request metadata, retaining a bounded in-memory window. */
export class RequestLog {
  private readonly entries: RequestLogEntry[] = [];
  private readonly maxEntries: number;
  private readonly now: () => Date;

  constructor(options: RequestLogOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries ?? 200, 'maxEntries');
    this.now = options.now ?? (() => new Date());
  }

  record(entry: Omit<RequestLogEntry, 'time'>): void {
    this.entries.push({ ...entry, time: this.now().toISOString() });
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
  }

  list(): RequestLogEntry[] { return this.entries.map((entry) => ({ ...entry })); }

  summary(): RequestLogSummary {
    const byRoute: Record<string, number> = {};
    let streams = 0;
    for (const entry of this.entries) {
      byRoute[entry.route] = (byRoute[entry.route] ?? 0) + 1;
      if (entry.stream) streams += 1;
    }
    return { retained: this.entries.length, streams, byRoute };
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}
