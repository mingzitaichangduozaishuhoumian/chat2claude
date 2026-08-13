import type { ChatGptBackendClient, ChatGptCompletionRequest, ChatGptCompletionResponse } from './client.js';
import type { ChatGptStreamEvent } from './events.js';
export interface MockChatGptBackendOptions { responsePrefix?: string; }
export class MockChatGptBackend implements ChatGptBackendClient {
  private readonly responsePrefix: string;
  constructor(options: MockChatGptBackendOptions = {}) { this.responsePrefix = options.responsePrefix ?? 'Echo:'; }
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
