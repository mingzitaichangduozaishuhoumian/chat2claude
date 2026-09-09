import type { ChatGptFinishReason, ChatGptOutputItem, ChatGptReplayItem, ChatGptToolCall, ChatGptUsage } from './client.js';

export interface ChatGptTextDeltaEvent { type: 'text_delta'; text: string; }
export interface ChatGptReasoningDeltaEvent { type: 'reasoning_delta'; text: string; }
export type ChatGptSafeStatus =
  | 'response in progress'
  | 'web search in progress'
  | 'web search searching'
  | 'file search in progress'
  | 'file search searching'
  | 'code interpreter in progress'
  | 'code interpreter interpreting'
  | 'image generation in progress'
  | 'image generation generating'
  | 'mcp call in progress'
  | 'mcp list tools in progress';
export interface ChatGptStatusDeltaEvent { type: 'status_delta'; status: ChatGptSafeStatus; }
export interface ChatGptToolCallEvent { type: 'tool_call'; toolCall: ChatGptToolCall; }
export interface ChatGptDoneEvent { type: 'done'; terminalSuccessful?: boolean; outputItems?: ChatGptOutputItem[]; finishReason?: ChatGptFinishReason; usage?: ChatGptUsage; /** Internal carrier, never client-visible content. */ replayItems?: ChatGptReplayItem[]; /** Fixed internal completeness marker for implicit replay. */ replayEligible?: boolean; }
/** Transport-only barrier; never content, usage, or replay. */
export interface ChatGptUpstreamReadyEvent { type: 'upstream_ready'; }
export type ChatGptStreamEvent = ChatGptTextDeltaEvent | ChatGptReasoningDeltaEvent | ChatGptStatusDeltaEvent | ChatGptToolCallEvent | ChatGptDoneEvent | ChatGptUpstreamReadyEvent;
