import type { ChatGptBackendClient, ChatGptCompletionRequest, ChatGptCompletionResponse, ChatGptDiscoveredModel } from './client.js';
import type { ChatGptStreamEvent } from './events.js';
export interface MockChatGptBackendOptions { responsePrefix?: string; models?: ChatGptDiscoveredModel[]; env?: Partial<Pick<NodeJS.ProcessEnv, 'MOCK_BACKEND_MODELS_JSON'>>; }
export class MockChatGptBackend implements ChatGptBackendClient {
  private readonly responsePrefix: string;
  private readonly models: ChatGptDiscoveredModel[];
  constructor(options: MockChatGptBackendOptions = {}) {
    this.responsePrefix = options.responsePrefix ?? 'Echo:';
    this.models = cloneDiscoveredModels(options.models ?? parseModelsFromEnv(options.env ?? process.env));
  }
  async listModels(): Promise<ChatGptDiscoveredModel[]> { return cloneDiscoveredModels(this.models); }
  async complete(request: ChatGptCompletionRequest): Promise<ChatGptCompletionResponse> { return { text: this.buildText(request), finishReason: 'stop' }; }
  async *stream(request: ChatGptCompletionRequest): AsyncIterable<ChatGptStreamEvent> {
    const text = this.buildText(request);
    for (const chunk of chunkText(text, 16)) yield { type: 'text_delta', text: chunk };
    yield { type: 'done' };
  }
  private buildText(request: ChatGptCompletionRequest): string {
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
    const effort = request.reasoningEffort ?? 'off';
    const speed = request.speedPreference ?? 'balanced';
    return `${this.responsePrefix}[effort=${effort},speed=${speed}] ${lastUser?.content ?? ''}`.trim();
  }
}
function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks.length ? chunks : [''];
}

function parseModelsFromEnv(env: Partial<Pick<NodeJS.ProcessEnv, 'MOCK_BACKEND_MODELS_JSON'>>): ChatGptDiscoveredModel[] {
  if (!env.MOCK_BACKEND_MODELS_JSON?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.MOCK_BACKEND_MODELS_JSON) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid MOCK_BACKEND_MODELS_JSON: ${detail}`);
  }
  return parseDiscoveredModels(parsed, 'MOCK_BACKEND_MODELS_JSON');
}

function parseDiscoveredModels(value: unknown, label: string): ChatGptDiscoveredModel[] {
  const rawModels = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { models?: unknown }).models) ? (value as { models: unknown[] }).models : undefined;
  if (!rawModels) throw new Error(`Invalid ${label}: expected an array or { "models": [...] }.`);
  const ids = new Set<string>();
  return rawModels.map((item, index) => {
    const model = normalizeDiscoveredModel(item, `${label}[${index}]`);
    if (ids.has(model.id)) throw new Error(`Invalid ${label}: duplicate model id "${model.id}".`);
    ids.add(model.id);
    return model;
  });
}

function normalizeDiscoveredModel(value: unknown, label: string): ChatGptDiscoveredModel {
  if (typeof value === 'string' && value.trim()) return { id: value.trim() };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}: expected a model id string or object.`);
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined;
  if (!id) throw new Error(`Invalid ${label}.id: expected a non-empty string.`);
  return {
    id,
    displayName: typeof (raw.display_name ?? raw.displayName) === 'string' && String(raw.display_name ?? raw.displayName).trim() ? String(raw.display_name ?? raw.displayName).trim() : undefined,
    capabilities: raw.capabilities && typeof raw.capabilities === 'object' && !Array.isArray(raw.capabilities) ? { ...(raw.capabilities as Record<string, unknown>) } : undefined,
    raw,
  };
}

function cloneDiscoveredModels(models: ChatGptDiscoveredModel[]): ChatGptDiscoveredModel[] {
  return models.map((model) => ({
    ...model,
    capabilities: model.capabilities ? { ...model.capabilities } : undefined,
  }));
}
