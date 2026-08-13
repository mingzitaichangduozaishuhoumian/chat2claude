export interface RequestLogEntry { route: string; model?: string; stream?: boolean; time: string; }
export class RequestLog {
  private readonly entries: RequestLogEntry[] = [];
  record(entry: Omit<RequestLogEntry, 'time'>): void { this.entries.push({ ...entry, time: new Date().toISOString() }); }
  list(): RequestLogEntry[] { return [...this.entries]; }
}
