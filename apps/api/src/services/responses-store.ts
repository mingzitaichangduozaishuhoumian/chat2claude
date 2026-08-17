import type { OpenAiResponsesRequest, OpenAiResponsesResponse } from '@chatgpt-to-claude/protocol-mapper';

export interface StoredOpenAiResponseRecord {
  id: string;
  response: OpenAiResponsesResponse;
  input: OpenAiResponsesRequest['input'];
  metadata?: OpenAiResponsesRequest['metadata'];
  previousResponseId?: OpenAiResponsesRequest['previous_response_id'];
  createdAt: number;
}

export class ResponsesStore {
  private readonly records = new Map<string, StoredOpenAiResponseRecord>();

  put(request: OpenAiResponsesRequest, response: OpenAiResponsesResponse): StoredOpenAiResponseRecord {
    const record: StoredOpenAiResponseRecord = {
      id: response.id,
      response: clone(response),
      input: clone(request.input),
      metadata: request.metadata === undefined ? undefined : clone(request.metadata),
      previousResponseId: request.previous_response_id,
      createdAt: Date.now(),
    };
    this.records.set(record.id, clone(record));
    return clone(record);
  }

  get(id: string): StoredOpenAiResponseRecord | undefined {
    const record = this.records.get(id);
    return record ? clone(record) : undefined;
  }

  count(): number {
    return this.records.size;
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
