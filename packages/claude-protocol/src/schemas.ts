import type { ClaudeMessagesRequest } from './types.js';
export function parseClaudeMessagesRequest(value: unknown): ClaudeMessagesRequest {
  if (!value || typeof value !== 'object') throw new Error('Request body must be an object');
  const body = value as Record<string, unknown>;
  if (typeof body.model !== 'string' || !body.model) throw new Error('model is required');
  if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) throw new Error('max_tokens must be a positive number');
  if (!Array.isArray(body.messages)) throw new Error('messages must be an array');
  if (body.thinking !== undefined && (!body.thinking || typeof body.thinking !== 'object' || Array.isArray(body.thinking))) throw new Error('thinking must be an object');
  if (body.output_config !== undefined && (!body.output_config || typeof body.output_config !== 'object' || Array.isArray(body.output_config))) throw new Error('output_config must be an object');
  if (body.reasoning_effort !== undefined && typeof body.reasoning_effort !== 'string') throw new Error('reasoning_effort must be a string');
  if (body.speed !== undefined && typeof body.speed !== 'string') throw new Error('speed must be a string');
  if (body.response_speed !== undefined && typeof body.response_speed !== 'string') throw new Error('response_speed must be a string');
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') throw new Error('message must be an object');
    const item = message as Record<string, unknown>;
    if (item.role !== 'user' && item.role !== 'assistant') throw new Error('message.role must be user or assistant');
    if (typeof item.content !== 'string' && !Array.isArray(item.content)) throw new Error('message.content must be string or array');
  }
  return body as unknown as ClaudeMessagesRequest;
}
