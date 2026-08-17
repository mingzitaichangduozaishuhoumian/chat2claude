import type { OpenAiResponsesRequest, OpenAiResponsesResponse } from '@chatgpt-to-claude/protocol-mapper';

export interface StoredOpenAiResponseRecord {
  id: string;
  ownerId: string;
  response: OpenAiResponsesResponse;
  input: OpenAiResponsesRequest['input'];
  metadata?: OpenAiResponsesRequest['metadata'];
  previousResponseId?: OpenAiResponsesRequest['previous_response_id'];
  createdAt: number;
}

export interface ResponsesStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxRecords?: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 1000;

export class ResponsesStore {
  private readonly records = new Map<string, StoredOpenAiResponseRecord>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxRecords: number;

  constructor(options: ResponsesStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  }

  put(ownerId: string, request: OpenAiResponsesRequest, response: OpenAiResponsesResponse): StoredOpenAiResponseRecord {
    this.cleanup();
    const record: StoredOpenAiResponseRecord = {
      id: response.id,
      ownerId,
      response: clone(response),
      input: clone(request.input),
      metadata: request.metadata === undefined ? undefined : clone(request.metadata),
      previousResponseId: request.previous_response_id,
      createdAt: this.now(),
    };
    this.records.set(record.id, clone(record));
    this.enforceMaxRecords();
    return clone(record);
  }

  get(ownerId: string, id: string): StoredOpenAiResponseRecord | undefined {
    this.cleanup();
    const record = this.records.get(id);
    if (!record || record.ownerId !== ownerId || this.isExpired(record)) return undefined;
    return clone(record);
  }

  count(): number {
    this.cleanup();
    return this.records.size;
  }

  private cleanup(): void {
    for (const [id, record] of this.records) {
      if (this.isExpired(record)) this.records.delete(id);
    }
    this.enforceMaxRecords();
  }

  private enforceMaxRecords(): void {
    if (this.maxRecords < 1) {
      this.records.clear();
      return;
    }
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (!oldest) return;
      this.records.delete(oldest);
    }
  }

  private isExpired(record: StoredOpenAiResponseRecord): boolean {
    return this.now() - record.createdAt >= this.ttlMs;
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
