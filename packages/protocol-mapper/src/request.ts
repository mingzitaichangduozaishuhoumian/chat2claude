import type { ChatGptCompletionRequest, ChatGptMessage, ChatGptTool, ChatGptToolChoice } from '@chatgpt-to-claude/chatgpt-backend';
import type { ClaudeContentBlock, ClaudeMessagesRequest, ClaudeTool, ClaudeToolChoice } from '@chatgpt-to-claude/claude-protocol';
import { normalizeClaudeMessagesToCanonical, flattenCanonicalContentForTextBackend, type CanonicalMappingDiagnostic } from './canonical.js';
import { resolveReasoningSpeed, type ReasoningSpeedDefaults } from './reasoning.js';
export { normalizeClaudeMessagesToCanonical, flattenCanonicalContentForTextBackend } from './canonical.js';
export interface BackendRequestOptions { backendModel?: string; backendOptions?: Record<string, unknown>; }

export function mapClaudeRequestToChatGpt(request: ClaudeMessagesRequest, defaults: ReasoningSpeedDefaults = {}, options: BackendRequestOptions = {}): ChatGptCompletionRequest {
  const canonical = normalizeClaudeMessagesToCanonical(request);
  const messages: ChatGptMessage[] = canonical.messages.map((message) => ({
    role: message.role === 'tool' ? 'user' : message.role,
    content: flattenCanonicalContentForTextBackend(message.content, canonical.diagnostics),
  }));
  const resolved = resolveReasoningSpeed(request, defaults);
  const stopSequences = normalizeStopSequences(request.stop_sequences);
  return {
    messages,
    maxTokens: request.max_tokens,
    model: options.backendModel ?? request.model,
    reasoningEffort: resolved.reasoningEffort,
    speedPreference: resolved.speedPreference,
    temperature: typeof request.temperature === 'number' ? request.temperature : undefined,
    topP: typeof request.top_p === 'number' ? request.top_p : undefined,
    stopSequences,
    tools: mapClaudeTools(request.tools),
    toolChoice: mapClaudeToolChoice(request.tool_choice),
    backendOptions: { ...options.backendOptions, mappingDiagnostics: canonical.diagnostics },
  };
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
