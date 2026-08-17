import { Hono } from 'hono';
import { ClaudeApiError, parseClaudeCountTokensRequest } from '@chatgpt-to-claude/claude-protocol';
import { estimateTokens, normalizeClaudeMessagesToCanonical, flattenCanonicalContentForTextBackend } from '@chatgpt-to-claude/protocol-mapper';

export function createCountTokensRoute(): Hono {
  const app = new Hono();
  app.post('/v1/messages/count_tokens', async (c) => {
    try {
      const request = parseClaudeCountTokensRequest(await c.req.json());
      const canonical = normalizeClaudeMessagesToCanonical({
        ...request,
        model: request.model,
        messages: request.messages,
        max_tokens: request.max_tokens ?? 1,
      });
      const text = canonical.messages.map((message) => `${message.role}: ${flattenCanonicalContentForTextBackend(message.content, canonical.diagnostics)}`).join('\n');
      const toolsText = request.tools ? JSON.stringify(request.tools) : '';
      return c.json({ input_tokens: estimateTokens(`${request.model}\n${text}\n${toolsText}`) });
    } catch (error) {
      const apiError = error instanceof ClaudeApiError ? error : new ClaudeApiError(error instanceof Error ? error.message : 'Invalid request');
      return c.json(apiError.toResponseBody(), apiError.status as 400);
    }
  });
  return app;
}
