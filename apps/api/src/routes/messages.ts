import { Hono } from 'hono';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError, parseClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';
import { mapChatGptResponseToClaude, mapChatGptStreamToClaudeSse, mapClaudeRequestToChatGpt, readableStreamFromAsyncIterable, type ReasoningSpeedDefaults } from '@chatgpt-to-claude/protocol-mapper';
import type { RequestLog } from '../services/request-log.js';
import type { ModelRegistry } from '../services/model-registry.js';
export interface MessagesRouteDeps { backend: ChatGptBackendClient; requestLog: RequestLog; modelRegistry: ModelRegistry; defaults?: ReasoningSpeedDefaults; }
export function createMessagesRoute(deps: MessagesRouteDeps): Hono {
  const app = new Hono();
  app.post('/v1/messages', async (c) => {
    try {
      const request = parseClaudeMessagesRequest(await c.req.json());
      const modelDefaults = deps.modelRegistry.reasoningSpeedDefaultsFor(request.model);
      const backendRequest = mapClaudeRequestToChatGpt(request, {
        ...deps.defaults,
        modelDefaults: { ...deps.defaults?.modelDefaults, [request.model]: modelDefaults },
      });
      deps.requestLog.record({ route: '/v1/messages', stream: Boolean(request.stream), model: request.model });
      if (request.stream) {
        const stream = readableStreamFromAsyncIterable(mapChatGptStreamToClaudeSse(request, deps.backend.stream(backendRequest)));
        return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' } });
      }
      const backendResponse = await deps.backend.complete(backendRequest);
      return c.json(mapChatGptResponseToClaude(request, backendResponse));
    } catch (error) {
      const apiError = error instanceof ClaudeApiError ? error : new ClaudeApiError(error instanceof Error ? error.message : 'Invalid request');
      return c.json(apiError.toResponseBody(), apiError.status as 400);
    }
  });
  return app;
}
