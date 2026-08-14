import type { ChatGptBackendClient, ChatGptBackendHealthCheckResult, ChatGptBackendRequestContext, ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptDiscoveredModel, ChatGptSessionSecret } from './client.js';
import type { ChatGptStreamEvent } from './events.js';

export interface SessionChatGptBackendOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

type JsonObject = Record<string, unknown>;

export class SessionChatGptBackend implements ChatGptBackendClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SessionChatGptBackendOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listModels(context?: ChatGptBackendRequestContext): Promise<ChatGptDiscoveredModel[]> {
    if (!context?.account) return [];
    const secret = requireSessionSecret(context);
    const response = await this.fetchWithTimeout(`${this.baseUrl}/backend-api/codex/models`, {
      method: 'GET',
      headers: this.headers(secret, false),
    });
    if (!response.ok) throw new Error(`ChatGPT models discovery failed: HTTP ${response.status}`);
    return parseDiscoveredModels(await response.json());
  }

  async healthCheck(context?: ChatGptBackendRequestContext): Promise<ChatGptBackendHealthCheckResult> {
    try {
      await this.listModels(context);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse> {
    let text = '';
    for await (const event of this.stream(request, context)) {
      if (event.type === 'text_delta') text += event.text;
    }
    return { text, finishReason: 'stop' };
  }

  async *stream(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): AsyncIterable<ChatGptStreamEvent> {
    const secret = requireSessionSecret(context);
    const response = await this.fetchWithTimeout(`${this.baseUrl}/backend-api/codex/responses`, {
      method: 'POST',
      headers: this.headers(secret, true),
      body: JSON.stringify({
        model: request.model,
        input: request.messages.map((message) => ({ role: message.role, content: message.content })),
        stream: true,
        store: false,
        instructions: '',
      }),
    });
    if (!response.ok) throw new Error(`ChatGPT responses request failed: HTTP ${response.status}`);

    for await (const data of iterateSseData(response)) {
      if (data === '[DONE]') break;
      const parsed = parseJson(data);
      if (!parsed) continue;
      const delta = extractTextDelta(parsed);
      if (delta) yield { type: 'text_delta', text: delta };
      if (isDoneEvent(parsed)) break;
    }
    yield { type: 'done' };
  }

  private headers(secret: ChatGptSessionSecret, includeContentType: boolean): Headers {
    const headers = new Headers();
    headers.set('authorization', `Bearer ${secret.accessToken}`);
    headers.set('accept', 'text/event-stream');
    if (includeContentType) headers.set('content-type', 'application/json');
    if (secret.cookie) headers.set('cookie', secret.cookie);
    if (secret.userAgent) headers.set('user-agent', secret.userAgent);
    if (secret.deviceId) headers.set('oai-device-id', secret.deviceId);
    return headers;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseDiscoveredModels(value: unknown): ChatGptDiscoveredModel[] {
  const rawModels = readModelArray(value);
  if (!rawModels) return [];
  const ids = new Set<string>();
  const models: ChatGptDiscoveredModel[] = [];
  for (const item of rawModels) {
    const model = normalizeDiscoveredModel(item);
    if (!model || ids.has(model.id)) continue;
    ids.add(model.id);
    models.push(model);
  }
  return models;
}

function readModelArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as JsonObject;
  const candidates = [raw.models, raw.data, readPath(raw, ['body', 'models'])];
  return candidates.find((candidate): candidate is unknown[] => Array.isArray(candidate));
}

function normalizeDiscoveredModel(value: unknown): ChatGptDiscoveredModel | undefined {
  if (typeof value === 'string' && value.trim()) return { id: value.trim() };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as JsonObject;
  const id = readNonEmptyString(raw.id) ?? readNonEmptyString(raw.slug) ?? readNonEmptyString(raw.name) ?? readNonEmptyString(raw.model);
  if (!id) return undefined;
  const displayName = readNonEmptyString(raw.display_name) ?? readNonEmptyString(raw.displayName) ?? readNonEmptyString(raw.title) ?? readNonEmptyString(raw.name);
  return {
    id,
    displayName,
    capabilities: raw.capabilities && typeof raw.capabilities === 'object' && !Array.isArray(raw.capabilities) ? { ...(raw.capabilities as Record<string, unknown>) } : undefined,
    raw,
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireSessionSecret(context?: ChatGptBackendRequestContext): ChatGptSessionSecret {
  const account = context?.account;
  if (!account) throw new Error('ChatGPT session backend requires an account context.');
  if (account.provider && account.provider !== 'chatgpt-session') throw new Error(`ChatGPT session backend requires a chatgpt-session account, got ${account.provider}.`);
  const secret = account.secret;
  if (!secret || secret.type !== 'chatgpt-session') throw new Error(`ChatGPT session account ${account.id} is missing a chatgpt-session secret.`);
  if (!secret.accessToken?.trim()) throw new Error(`ChatGPT session account ${account.id} is missing secret.accessToken.`);
  return secret;
}

async function* iterateSseData(response: Response): AsyncIterable<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drainSseBuffer(buffer, (next) => { buffer = next; });
    }
  } finally {
    reader.releaseLock();
  }
  buffer += decoder.decode();
  yield* drainSseBuffer(`${buffer}\n\n`, (next) => { buffer = next; });
}

function* drainSseBuffer(buffer: string, setBuffer: (value: string) => void): Iterable<string> {
  let boundary = findSseFrameBoundary(buffer);
  while (boundary) {
    const frame = buffer.slice(0, boundary.index);
    buffer = buffer.slice(boundary.index + boundary.length);
    const data = frame.split(/\r?\n/)
      .map((line) => line.startsWith('data:') ? line.slice(5).trimStart() : undefined)
      .filter((line): line is string => line !== undefined)
      .join('\n')
      .trim();
    if (data) yield data;
    boundary = findSseFrameBoundary(buffer);
  }
  setBuffer(buffer);
}

function findSseFrameBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseJson(data: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : undefined;
  } catch {
    return undefined;
  }
}

function extractTextDelta(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const object = value as JsonObject;
  const candidates = [
    object.output_text_delta,
    object.delta,
    object.text,
    object.content,
    readPath(object, ['message', 'delta', 'content']),
    readPath(object, ['message', 'content']),
    readPath(object, ['response', 'output_text_delta']),
    readPath(object, ['item', 'content']),
    readPath(object, ['data', 'output_text_delta']),
  ];
  for (const candidate of candidates) {
    const text = normalizeTextCandidate(candidate);
    if (text) return text;
  }
  return undefined;
}

function normalizeTextCandidate(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(normalizeTextCandidate).filter((item): item is string => Boolean(item)).join('') || undefined;
  if (value && typeof value === 'object') {
    const raw = value as JsonObject;
    return normalizeTextCandidate(raw.text ?? raw.content ?? raw.value);
  }
  return undefined;
}

function readPath(value: JsonObject, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as JsonObject)[segment];
  }
  return current;
}

function isDoneEvent(value: JsonObject): boolean {
  const type = value.type;
  return type === 'done' || type === 'response.completed' || type === 'message_stop' || value.done === true;
}
