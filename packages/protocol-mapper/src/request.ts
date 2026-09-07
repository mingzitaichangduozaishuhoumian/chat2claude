import type { ChatGptCompletionRequest, ChatGptImageDetail, ChatGptInputContentPart, ChatGptInputItem, ChatGptMessage, ChatGptTool, ChatGptToolChoice } from '@chatgpt-to-claude/chatgpt-backend';
import { validateClaudeToolContract, type ClaudeContentBlock, type ClaudeMessagesRequest, type ClaudeTool, type ClaudeToolChoice } from '@chatgpt-to-claude/claude-protocol';
import { normalizeClaudeMessagesToCanonical, flattenCanonicalContentForTextBackend, type CanonicalContentBlock, type CanonicalMappingDiagnostic } from './canonical.js';
import { resolveReasoningSpeed, type ReasoningSpeedDefaults } from './reasoning.js';
export { normalizeClaudeMessagesToCanonical, flattenCanonicalContentForTextBackend } from './canonical.js';
export interface BackendRequestOptions {
  backendModel?: string;
  backendOptions?: Record<string, unknown>;
  resolvedControls?: { reasoningEffort?: string; serviceTier?: string };
}

export function mapClaudeRequestToChatGpt(request: ClaudeMessagesRequest, defaults: ReasoningSpeedDefaults = {}, options: BackendRequestOptions = {}): ChatGptCompletionRequest {
  validateClaudeToolContract(request);
  const canonical = normalizeClaudeMessagesToCanonical(request);
  const messages: ChatGptMessage[] = canonical.messages.map((message) => ({
    role: message.role === 'tool' ? 'user' : message.role,
    content: flattenCanonicalContentForTextBackend(message.content, canonical.diagnostics),
  }));
  const resolved = options.resolvedControls ? undefined : resolveReasoningSpeed(request, defaults);
  const stopSequences = normalizeStopSequences(request.stop_sequences);
  const claudeRequest = preserveClaudeRequestFields(request, canonical.diagnostics);
  const backendOptions = {
    ...options.backendOptions,
    mappingDiagnostics: canonical.diagnostics,
    ...(claudeRequest ? { claudeRequest } : {}),
  };
  return {
    messages,
    inputItems: mapCanonicalInputItems(canonical.messages, canonical.diagnostics),
    maxTokens: request.max_tokens,
    model: options.backendModel ?? request.model,
    ...(options.resolvedControls
      ? {
          ...(options.resolvedControls.reasoningEffort === undefined ? {} : { reasoningEffort: options.resolvedControls.reasoningEffort }),
          ...(options.resolvedControls.serviceTier === undefined ? {} : { serviceTier: options.resolvedControls.serviceTier }),
        }
      : {
          reasoningEffort: resolved!.reasoningEffort,
          speedPreference: resolved!.speedPreference,
        }),
    temperature: typeof request.temperature === 'number' ? request.temperature : undefined,
    topP: typeof request.top_p === 'number' ? request.top_p : undefined,
    stopSequences,
    tools: mapClaudeTools(request.tools),
    toolChoice: mapClaudeToolChoice(request.tool_choice),
    backendOptions,
  };
}

const CLAUDE_REQUEST_FIELDS = ['metadata', 'service_tier', 'container', 'context_management', 'mcp_servers'] as const;
type PreservedClaudeRequestField = typeof CLAUDE_REQUEST_FIELDS[number];

function preserveClaudeRequestFields(request: ClaudeMessagesRequest, diagnostics: CanonicalMappingDiagnostic[]): Partial<Record<PreservedClaudeRequestField, unknown>> | undefined {
  const preserved: Partial<Record<PreservedClaudeRequestField, unknown>> = {};
  for (const field of CLAUDE_REQUEST_FIELDS) {
    if (request[field] === undefined) continue;
    preserved[field] = request[field];
    diagnostics.push({
      severity: 'info',
      code: 'claude_request_field_preserved',
      path: field,
      message: `Claude request field ${field} has been preserved in backendOptions.claudeRequest, but the current ChatGPT backend does not guarantee native execution.`,
    });
  }
  return Object.keys(preserved).length ? preserved : undefined;
}

export function mapClaudeTools(tools: ClaudeTool[] | undefined): ChatGptTool[] | undefined {
  return tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema,
    strict: tool.strict,
    raw: tool,
  }));
}

export function mapClaudeToolChoice(toolChoice: ClaudeToolChoice | undefined): ChatGptToolChoice | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice.type === 'tool') return { type: 'tool', name: toolChoice.name };
  return { type: toolChoice.type };
}

function mapCanonicalInputItems(messages: Array<{ role: ChatGptMessage['role'] | 'tool'; content: CanonicalContentBlock[] }>, diagnostics: CanonicalMappingDiagnostic[]): ChatGptInputItem[] {
  const inputItems: ChatGptInputItem[] = [];
  for (const message of messages) {
    const role = message.role === 'tool' ? 'user' : message.role;
    let parts: ChatGptInputContentPart[] = [];
    let hasStructuredPart = false;
    const appendText = (text: string) => {
      if (!text) return;
      const last = parts[parts.length - 1];
      if (last?.type === 'text') last.text += text;
      else parts.push({ type: 'text', text });
    };
    const flushParts = () => {
      if (!parts.length) return;
      inputItems.push({ type: 'message', role, content: hasStructuredPart ? parts : parts.map((part) => part.type === 'text' ? part.text : '').join('') });
      parts = [];
      hasStructuredPart = false;
    };
    for (const block of message.content) {
      if (block.kind === 'tool_use' && role === 'assistant') {
        flushParts();
        inputItems.push({ type: 'function_call', callId: block.id, name: block.name, arguments: block.input });
      } else if (block.kind === 'tool_result') {
        flushParts();
        const output = typeof block.content === 'string' ? block.content : flattenCanonicalContentForTextBackend(block.content, diagnostics);
        inputItems.push({ type: 'function_call_output', callId: block.toolUseId, output, ...(block.isError === undefined ? {} : { isError: block.isError }) });
      } else if (block.kind === 'text') {
        appendText(block.text);
      } else if (block.kind === 'image') {
        const image = imagePartFromClaudeSource(block.source);
        if (image) {
          parts.push(image);
          hasStructuredPart = true;
        } else {
          appendText(flattenCanonicalContentForTextBackend([block], diagnostics));
        }
      } else {
        appendText(flattenCanonicalContentForTextBackend([block], diagnostics));
      }
    }
    flushParts();
  }
  return inputItems;
}

function imagePartFromClaudeSource(source: unknown): ChatGptInputContentPart | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const raw = source as Record<string, unknown>;
  const detail = normalizeImageDetail(raw.detail);
  if (raw.type === 'url' && typeof raw.url === 'string' && raw.url) return { type: 'image', imageUrl: raw.url, ...(detail ? { detail } : {}) };
  if (raw.type === 'base64' && typeof raw.media_type === 'string' && typeof raw.data === 'string' && raw.media_type && raw.data) return { type: 'image', imageUrl: `data:${raw.media_type};base64,${raw.data}`, ...(detail ? { detail } : {}) };
  return undefined;
}

function normalizeImageDetail(value: unknown): ChatGptImageDetail | undefined {
  return value === 'auto' || value === 'low' || value === 'high' ? value : undefined;
}

function normalizeStopSequences(stop: string[] | undefined): string[] | undefined {
  const values = stop?.filter((item) => typeof item === 'string');
  return values?.length ? values : undefined;
}
export function stringifyContent(content: string | ClaudeContentBlock[]): string {
  const diagnostics: CanonicalMappingDiagnostic[] = [];
  return flattenCanonicalContentForTextBackend(normalizeContentForCompatibility(content), diagnostics);
}
function normalizeContentForCompatibility(content: string | ClaudeContentBlock[]) {
  return normalizeClaudeMessagesToCanonical({ model: 'compat', max_tokens: 1, messages: [{ role: 'user', content }] }).messages[0].content;
}
