import { Hono } from 'hono';
import { ClaudeApiError, parseClaudeCountTokensRequest } from '@chatgpt-to-claude/claude-protocol';
import { estimateClaudeInputTokens } from '@chatgpt-to-claude/protocol-mapper';

export function createCountTokensRoute(): Hono {
  const app = new Hono();
  app.post('/v1/messages/count_tokens', async (c) => {
    try {
      const request = parseClaudeCountTokensRequest(await c.req.json());
      c.header('x-chat2claude-token-count-mode', 'heuristic');
      return c.json({ input_tokens: estimateClaudeInputTokens(request) });
    } catch (error) {
      const apiError = error instanceof ClaudeApiError ? error : new ClaudeApiError(error instanceof Error ? error.message : 'Invalid request');
      return c.json(apiError.toResponseBody(), apiError.status as 400);
    }
  });
  return app;
}
