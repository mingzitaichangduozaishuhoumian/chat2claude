import type { ChatGptFinishReason, ChatGptImageGenerationCallOutputItem, ChatGptOutputContentIndices, ChatGptOutputItem, ChatGptReplayItem, ChatGptToolCall, ChatGptUsage } from './client.js';

export interface ChatGptContentDeltaIdentity {
  itemId?: string;
  outputIndex?: number;
  contentIndex?: number;
  /** Safe projected index when every preceding provider item is known to survive projection. */
  projectedOutputIndex?: number;
  /** Detached, validated full prefix for native output item lifecycles; never text content. */
  projectedOutputPrefix?: ChatGptOutputItem[];
  /** Reconciled from authoritative completed output, rather than a live delta. */
  finalSnapshot?: true;
}
export interface ChatGptTextDeltaEvent extends ChatGptContentDeltaIdentity { type: 'text_delta'; text: string; }
export interface ChatGptRefusalDeltaEvent extends ChatGptContentDeltaIdentity { type: 'refusal_delta'; text: string; }
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
/** Safe, allowlisted generated-image result. Native Responses only consumes this event. */
export interface ChatGptImageOutputEvent { type: 'image_output'; item: ChatGptImageGenerationCallOutputItem; }
export interface ChatGptDoneEvent { type: 'done'; terminalSuccessful?: boolean; outputItems?: ChatGptOutputItem[]; /** Internal identity metadata; never client-visible output. */ outputContentIndices?: ChatGptOutputContentIndices[]; finishReason?: ChatGptFinishReason; usage?: ChatGptUsage; /** Internal carrier, never client-visible content. */ replayItems?: ChatGptReplayItem[]; /** Fixed internal completeness marker for implicit replay. */ replayEligible?: boolean; }
/** Transport-only barrier; never content, usage, or replay. */
export interface ChatGptUpstreamReadyEvent { type: 'upstream_ready'; }
export type ChatGptStreamEvent = ChatGptTextDeltaEvent | ChatGptRefusalDeltaEvent | ChatGptReasoningDeltaEvent | ChatGptStatusDeltaEvent | ChatGptToolCallEvent | ChatGptImageOutputEvent | ChatGptDoneEvent | ChatGptUpstreamReadyEvent;
