export type ClaudeRole = 'user' | 'assistant';
export type ClaudeStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
export interface ClaudeTextBlock { type: 'text'; text: string; }
export type ClaudeContentBlock = ClaudeTextBlock;
export interface ClaudeInputMessage { role: ClaudeRole; content: string | ClaudeContentBlock[]; }
export type ClaudeReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max';
export type ClaudeResponseSpeed = 'fastest' | 'fast' | 'balanced' | 'quality';
export interface ClaudeThinkingConfig { type?: string; budget_tokens?: number; enabled?: boolean; [key: string]: unknown; }
export interface ClaudeOutputConfig { effort?: ClaudeReasoningEffort | string; [key: string]: unknown; }
export interface ClaudeMessagesRequest { model: string; max_tokens: number; messages: ClaudeInputMessage[]; system?: string | ClaudeTextBlock[]; stream?: boolean; stop_sequences?: string[]; temperature?: number; thinking?: ClaudeThinkingConfig; output_config?: ClaudeOutputConfig; reasoning_effort?: ClaudeReasoningEffort | string; speed?: ClaudeResponseSpeed | string; response_speed?: ClaudeResponseSpeed | string; }
export interface ClaudeUsage { input_tokens: number; output_tokens: number; }
export interface ClaudeMessageResponse { id: string; type: 'message'; role: 'assistant'; model: string; content: ClaudeContentBlock[]; stop_reason: ClaudeStopReason; stop_sequence: string | null; usage: ClaudeUsage; }
export type ClaudeSseEventName = 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'ping' | 'error';
export interface ClaudeSseEvent<T = unknown> { event: ClaudeSseEventName; data: T; }
