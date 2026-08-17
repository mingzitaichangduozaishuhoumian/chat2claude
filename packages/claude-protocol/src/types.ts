export type ClaudeRole = 'user' | 'assistant';
export type ClaudeStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal' | 'model_context_window_exceeded' | null;

export interface ClaudeTextBlock { type: 'text'; text: string; [key: string]: unknown; }
export interface ClaudeImageBlock { type: 'image'; source: ClaudeImageSource; [key: string]: unknown; }
export type ClaudeImageSource = { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } | { type: 'file'; file_id: string } | Record<string, unknown>;
export interface ClaudeToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown; [key: string]: unknown; }
export interface ClaudeToolResultBlock { type: 'tool_result'; tool_use_id: string; content?: string | ClaudeToolResultContentBlock[]; is_error?: boolean; [key: string]: unknown; }
export interface ClaudeToolResultContentBlock { type: 'text' | 'image'; [key: string]: unknown; }
export interface ClaudeThinkingBlock { type: 'thinking'; thinking: string; signature?: string; [key: string]: unknown; }
export interface ClaudeRedactedThinkingBlock { type: 'redacted_thinking'; data: string; [key: string]: unknown; }
export interface ClaudeUnknownContentBlock { type: string; [key: string]: unknown; }
export type ClaudeContentBlock = ClaudeTextBlock | ClaudeImageBlock | ClaudeToolUseBlock | ClaudeToolResultBlock | ClaudeThinkingBlock | ClaudeRedactedThinkingBlock | ClaudeUnknownContentBlock;

export interface ClaudeInputMessage { role: ClaudeRole; content: string | ClaudeContentBlock[]; }
export type ClaudeReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max';
export type ClaudeResponseSpeed = 'fastest' | 'fast' | 'balanced' | 'quality';
export interface ClaudeThinkingConfig { type?: string; budget_tokens?: number; enabled?: boolean; [key: string]: unknown; }
export interface ClaudeOutputConfig { effort?: ClaudeReasoningEffort | string; [key: string]: unknown; }
export interface ClaudeTool { name: string; description?: string; input_schema: Record<string, unknown>; strict?: boolean; [key: string]: unknown; }
export type ClaudeToolChoice = { type: 'auto' | 'any' | 'none'; disable_parallel_tool_use?: boolean; [key: string]: unknown } | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean; [key: string]: unknown };
export interface ClaudeMessagesRequest {
  model: string;
  max_tokens: number;
  messages: ClaudeInputMessage[];
  system?: string | ClaudeTextBlock[];
  stream?: boolean;
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  thinking?: ClaudeThinkingConfig;
  output_config?: ClaudeOutputConfig;
  reasoning_effort?: ClaudeReasoningEffort | string;
  speed?: ClaudeResponseSpeed | string;
  response_speed?: ClaudeResponseSpeed | string;
  tools?: ClaudeTool[];
  tool_choice?: ClaudeToolChoice;
  metadata?: Record<string, unknown>;
  container?: unknown;
  context_management?: unknown;
  mcp_servers?: unknown;
  service_tier?: string;
  [key: string]: unknown;
}
export interface ClaudeCountTokensRequest {
  model: string;
  messages: ClaudeInputMessage[];
  system?: string | ClaudeTextBlock[];
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  thinking?: ClaudeThinkingConfig;
  output_config?: ClaudeOutputConfig;
  reasoning_effort?: ClaudeReasoningEffort | string;
  speed?: ClaudeResponseSpeed | string;
  response_speed?: ClaudeResponseSpeed | string;
  tools?: ClaudeTool[];
  tool_choice?: ClaudeToolChoice;
  metadata?: Record<string, unknown>;
  container?: unknown;
  context_management?: unknown;
  mcp_servers?: unknown;
  service_tier?: string;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}
export interface ClaudeUsage { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; [key: string]: unknown; }
export interface ClaudeMessageResponse { id: string; type: 'message'; role: 'assistant'; model: string; content: ClaudeContentBlock[]; stop_reason: ClaudeStopReason; stop_sequence: string | null; usage: ClaudeUsage; }
export type ClaudeSseEventName = 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'ping' | 'error';
export interface ClaudeSseEvent<T = unknown> { event: ClaudeSseEventName; data: T; }
