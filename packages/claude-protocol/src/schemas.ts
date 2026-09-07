import type { ClaudeContentBlock, ClaudeCountTokensRequest, ClaudeMessagesRequest, ClaudeTextBlock } from './types.js';
import { ClaudeApiError } from './errors.js';

export function parseClaudeMessagesRequest(value: unknown): ClaudeMessagesRequest {
  return parseClaudeRequest(value, { requireMaxTokens: true }) as ClaudeMessagesRequest;
}

export function parseClaudeCountTokensRequest(value: unknown): ClaudeCountTokensRequest {
  return parseClaudeRequest(value, { requireMaxTokens: false }) as ClaudeCountTokensRequest;
}

/** Parser failures are the trusted, client-correctable validation boundary. */
function parseClaudeRequest(value: unknown, options: { requireMaxTokens: boolean }): Record<string, unknown> {
  try {
    return parseClaudeRequestBase(value, options);
  } catch (error) {
    if (error instanceof ClaudeApiError) throw error;
    throw new ClaudeApiError(error instanceof Error ? error.message : 'Invalid request');
  }
}

function parseClaudeRequestBase(value: unknown, options: { requireMaxTokens: boolean }): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be an object');
  const body = { ...(value as Record<string, unknown>) };
  if (typeof body.model !== 'string' || !body.model) throw new Error('model is required');
  if (options.requireMaxTokens && (typeof body.max_tokens !== 'number' || body.max_tokens <= 0)) throw new Error('max_tokens must be a positive number');
  if (body.max_tokens !== undefined && (typeof body.max_tokens !== 'number' || body.max_tokens <= 0)) throw new Error('max_tokens must be a positive number');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new Error('stream must be a boolean');
  if (body.temperature !== undefined && typeof body.temperature !== 'number') throw new Error('temperature must be a number');
  if (body.top_p !== undefined && typeof body.top_p !== 'number') throw new Error('top_p must be a number');
  if (body.stop_sequences !== undefined && (!Array.isArray(body.stop_sequences) || body.stop_sequences.some((item) => typeof item !== 'string'))) throw new Error('stop_sequences must be a string array');
  if (body.metadata !== undefined && !isPlainObject(body.metadata)) throw new Error('metadata must be an object');
  if (body.service_tier !== undefined && typeof body.service_tier !== 'string') throw new Error('service_tier must be a string');
  if (!Array.isArray(body.messages)) throw new Error('messages must be an array');
  if (body.system !== undefined) validateSystem(body.system);
  if (body.thinking !== undefined && (!body.thinking || typeof body.thinking !== 'object' || Array.isArray(body.thinking))) throw new Error('thinking must be an object');
  if (body.output_config !== undefined && (!body.output_config || typeof body.output_config !== 'object' || Array.isArray(body.output_config))) throw new Error('output_config must be an object');
  if (body.reasoning_effort !== undefined && typeof body.reasoning_effort !== 'string') throw new Error('reasoning_effort must be a string');
  if (body.speed !== undefined && typeof body.speed !== 'string') throw new Error('speed must be a string');
  if (body.response_speed !== undefined && typeof body.response_speed !== 'string') throw new Error('response_speed must be a string');
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new Error('tools must be an array');
  if (body.tool_choice !== undefined && (!body.tool_choice || typeof body.tool_choice !== 'object' || Array.isArray(body.tool_choice))) throw new Error('tool_choice must be an object');
  const messages: unknown[] = [];
  const liftedSystemGroups: ClaudeTextBlock[][] = [];
  for (const message of body.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('message must be an object');
    const item = message as Record<string, unknown>;
    if (item.role === 'system' || item.role === 'developer') {
      liftedSystemGroups.push(systemBlocksFromMessageContent(item.content));
      continue;
    }
    if (item.role !== 'user' && item.role !== 'assistant') throw new Error('message.role must be user, assistant, system, or developer');
    validateContent(item.content, 'message.content');
    messages.push(message);
  }
  if (liftedSystemGroups.length) {
    const systemGroups = [systemBlocksFromExistingSystem(body.system), ...liftedSystemGroups].filter((group) => group.length);
    body.system = systemGroups.flatMap((group, index) => index === 0 ? group : [{ type: 'text', text: '\n' }, ...group]);
    body.messages = messages;
  }
  return body;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateSystem(system: unknown): void {
  if (typeof system === 'string') return;
  if (!Array.isArray(system)) throw new Error('system must be a string or text block array');
  for (const block of system) validateTextBlock(block, 'system');
}

function systemBlocksFromExistingSystem(system: unknown): ClaudeTextBlock[] {
  if (system === undefined) return [];
  if (typeof system === 'string') return [{ type: 'text', text: system }];
  return [...(system as ClaudeTextBlock[])];
}

function systemBlocksFromMessageContent(content: unknown): ClaudeTextBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw new Error('system/developer message.content must be a string or text block array');
  for (const block of content) validateTextBlock(block, 'system/developer message.content');
  return content as ClaudeTextBlock[];
}

function validateContent(content: unknown, path: string): void {
  if (typeof content === 'string') return;
  if (!Array.isArray(content)) throw new Error(`${path} must be string or array`);
  for (const block of content) validateContentBlock(block, path);
}

function validateContentBlock(block: unknown, path: string): asserts block is ClaudeContentBlock {
  if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error(`${path} block must be an object`);
  const item = block as Record<string, unknown>;
  if (typeof item.type !== 'string' || !item.type) throw new Error(`${path} block.type is required`);
  switch (item.type) {
    case 'text':
      validateTextBlock(item, path);
      return;
    case 'image':
      if (!item.source || typeof item.source !== 'object' || Array.isArray(item.source)) throw new Error(`${path} image.source must be an object`);
      return;
    case 'tool_use':
      if (typeof item.id !== 'string' || !item.id) throw new Error(`${path} tool_use.id is required`);
      if (typeof item.name !== 'string' || !item.name) throw new Error(`${path} tool_use.name is required`);
      if (item.input === undefined) throw new Error(`${path} tool_use.input is required`);
      return;
    case 'tool_result':
      if (typeof item.tool_use_id !== 'string' || !item.tool_use_id) throw new Error(`${path} tool_result.tool_use_id is required`);
      if (item.content !== undefined && typeof item.content !== 'string' && !Array.isArray(item.content)) throw new Error(`${path} tool_result.content must be a string or array`);
      return;
    case 'thinking':
      if (typeof item.thinking !== 'string') throw new Error(`${path} thinking.thinking must be a string`);
      return;
    case 'redacted_thinking':
      if (typeof item.data !== 'string') throw new Error(`${path} redacted_thinking.data must be a string`);
      return;
    default:
      return;
  }
}

function validateTextBlock(block: unknown, path: string): void {
  if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error(`${path} text block must be an object`);
  const item = block as Record<string, unknown>;
  if (item.type !== 'text') throw new Error(`Unsupported content block type: ${String(item.type)}`);
  if (typeof item.text !== 'string') throw new Error(`${path} text block.text must be a string`);
}
