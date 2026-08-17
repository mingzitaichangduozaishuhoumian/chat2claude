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
      const requestFieldEntries = Object.entries({
        tools: request.tools,
        tool_choice: request.tool_choice,
        thinking: request.thinking,
        output_config: request.output_config,
        reasoning_effort: request.reasoning_effort,
        speed: request.speed,
        response_speed: request.response_speed,
        stop_sequences: request.stop_sequences,
        temperature: request.temperature,
        top_p: request.top_p,
        metadata: request.metadata,
        service_tier: request.service_tier,
        container: request.container,
        context_management: request.context_management,
        mcp_servers: request.mcp_servers,
      }).filter(([, value]) => value !== undefined);
      const requestFieldsText = requestFieldEntries.length > 0 ? JSON.stringify(Object.fromEntries(requestFieldEntries)) : '';
      return c.json({ input_tokens: estimateTokens(`${request.model}\n${text}\n${requestFieldsText}`) });
    } catch (error) {
      const apiError = error instanceof ClaudeApiError ? error : new ClaudeApiError(error instanceof Error ? error.message : 'Invalid request');
      return c.json(apiError.toResponseBody(), apiError.status as 400);
    }
  });
  return app;
}
