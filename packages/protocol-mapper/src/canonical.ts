import type { ClaudeContentBlock, ClaudeMessagesRequest, ClaudeTool, ClaudeToolChoice } from '@chatgpt-to-claude/claude-protocol';

export type CanonicalRole = 'system' | 'user' | 'assistant' | 'tool';
export type CanonicalFinishReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal' | 'model_context_window_exceeded' | 'content_filter' | 'interrupted' | 'error' | 'unknown';

export interface CanonicalMessage { role: CanonicalRole; content: CanonicalContentBlock[]; providerMeta?: Record<string, unknown>; }
export type CanonicalContentBlock = CanonicalTextBlock | CanonicalImageBlock | CanonicalToolUseBlock | CanonicalToolResultBlock | CanonicalThinkingBlock | CanonicalRedactedThinkingBlock | CanonicalUnsupportedBlock;
export interface CanonicalTextBlock { kind: 'text'; text: string; }
export interface CanonicalImageBlock { kind: 'image'; source: unknown; }
export interface CanonicalToolUseBlock { kind: 'tool_use'; id: string; name: string; input: unknown; }
export interface CanonicalToolResultBlock { kind: 'tool_result'; toolUseId: string; content: string | CanonicalContentBlock[]; isError?: boolean; }
export interface CanonicalThinkingBlock { kind: 'thinking'; thinking: string; signature?: string; }
export interface CanonicalRedactedThinkingBlock { kind: 'redacted_thinking'; data: string; }
export interface CanonicalUnsupportedBlock { kind: 'unsupported'; blockType: string; raw: unknown; }
export type CanonicalTool = ClaudeTool;
export type CanonicalToolChoice = ClaudeToolChoice;
export interface CanonicalUsage { inputTokens?: number; outputTokens?: number; estimated?: boolean; raw?: unknown; }
export type CanonicalStreamEvent = { type: 'text_delta'; text: string } | { type: 'done'; finishReason?: CanonicalFinishReason; usage?: CanonicalUsage } | { type: 'diagnostic'; diagnostic: CanonicalMappingDiagnostic };
export interface CanonicalMappingDiagnostic { severity: 'info' | 'warning' | 'error'; code: string; message: string; path?: string; }
export interface CanonicalRequest { model: string; messages: CanonicalMessage[]; tools?: CanonicalTool[]; toolChoice?: CanonicalToolChoice; diagnostics: CanonicalMappingDiagnostic[]; raw: ClaudeMessagesRequest; }

export function normalizeClaudeMessagesToCanonical(request: ClaudeMessagesRequest): CanonicalRequest {
  const diagnostics: CanonicalMappingDiagnostic[] = [];
  const messages: CanonicalMessage[] = [];
  const system = normalizeSystem(request.system, diagnostics);
  if (system.length) messages.push({ role: 'system', content: system });
  request.messages.forEach((message, messageIndex) => {
    messages.push({ role: message.role, content: normalizeContent(message.content, diagnostics, `messages[${messageIndex}].content`) });
  });
  return { model: request.model, messages, tools: request.tools, toolChoice: request.tool_choice, diagnostics, raw: request };
}

export function flattenCanonicalContentForTextBackend(blocks: CanonicalContentBlock[], diagnostics: CanonicalMappingDiagnostic[] = [], path = 'content'): string {
  return blocks.map((block, index) => flattenBlock(block, diagnostics, `${path}[${index}]`)).filter(Boolean).join('');
}

function normalizeSystem(system: ClaudeMessagesRequest['system'], diagnostics: CanonicalMappingDiagnostic[]): CanonicalContentBlock[] {
  if (!system) return [];
  if (typeof system === 'string') return system ? [{ kind: 'text', text: system }] : [];
  return system.map((block, index) => normalizeBlock(block as ClaudeContentBlock, diagnostics, `system[${index}]`));
}

function normalizeContent(content: string | ClaudeContentBlock[], diagnostics: CanonicalMappingDiagnostic[], path: string): CanonicalContentBlock[] {
  if (typeof content === 'string') return content ? [{ kind: 'text', text: content }] : [];
  return content.map((block, index) => normalizeBlock(block, diagnostics, `${path}[${index}]`));
}

function normalizeBlock(block: ClaudeContentBlock, diagnostics: CanonicalMappingDiagnostic[], path: string): CanonicalContentBlock {
  switch (block.type) {
    case 'text': return { kind: 'text', text: String(block.text ?? '') };
    case 'image':
      diagnostics.push({ severity: 'warning', code: 'image_text_backend_placeholder', message: 'Image content is preserved in canonical IR but downgraded to a text placeholder for the current backend.', path });
      return { kind: 'image', source: block.source };
    case 'tool_use':
      diagnostics.push({ severity: 'warning', code: 'tool_use_text_backend_placeholder', message: 'tool_use is preserved in canonical IR but downgraded to a text placeholder for the current backend.', path });
      return { kind: 'tool_use', id: String(block.id ?? ''), name: String(block.name ?? ''), input: block.input };
    case 'tool_result':
      return { kind: 'tool_result', toolUseId: String(block.tool_use_id ?? ''), content: normalizeToolResultContent(block.content, diagnostics, `${path}.content`), isError: typeof block.is_error === 'boolean' ? block.is_error : undefined };
    case 'thinking':
      diagnostics.push({ severity: 'info', code: 'thinking_text_backend_omitted', message: 'thinking is preserved in canonical IR but omitted from text backend replay.', path });
      return { kind: 'thinking', thinking: String(block.thinking ?? ''), signature: typeof block.signature === 'string' ? block.signature : undefined };
    case 'redacted_thinking':
      diagnostics.push({ severity: 'info', code: 'redacted_thinking_text_backend_omitted', message: 'redacted_thinking is preserved in canonical IR but omitted from text backend replay.', path });
      return { kind: 'redacted_thinking', data: String(block.data ?? '') };
    default:
      diagnostics.push({ severity: 'error', code: 'unsupported_content_block', message: `Unsupported content block type: ${block.type}`, path });
      return { kind: 'unsupported', blockType: block.type, raw: block };
  }
}

function normalizeToolResultContent(content: unknown, diagnostics: CanonicalMappingDiagnostic[], path: string): string | CanonicalContentBlock[] {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item, index) => {
      if (item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string') return normalizeBlock(item as ClaudeContentBlock, diagnostics, `${path}[${index}]`);
      return { kind: 'unsupported', blockType: String((item as { type?: unknown } | undefined)?.type ?? 'unknown'), raw: item } satisfies CanonicalUnsupportedBlock;
    });
  }
  return String(content);
}

function flattenBlock(block: CanonicalContentBlock, diagnostics: CanonicalMappingDiagnostic[], path: string): string {
  switch (block.kind) {
    case 'text': return block.text;
    case 'tool_result': {
      const body = typeof block.content === 'string' ? block.content : flattenCanonicalContentForTextBackend(block.content, diagnostics, `${path}.content`);
      return `[tool_result:${block.toolUseId}${block.isError ? ':error' : ''}] ${body}`;
    }
    case 'image': return '[unsupported:image]';
    case 'tool_use': return `[unsupported:tool_use:${block.name}]`;
    case 'thinking': return '';
    case 'redacted_thinking': return '';
    case 'unsupported':
      diagnostics.push({ severity: 'error', code: 'unsupported_content_block', message: `Unsupported content block type: ${block.blockType}`, path });
      return `[unsupported:${block.blockType}]`;
  }
}
