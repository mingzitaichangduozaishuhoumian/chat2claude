import type { ChatGptFinishReason, ChatGptOutputItem, ChatGptReplayItem, ChatGptToolCall, ChatGptUsage } from './client.js';

export interface ChatGptTextDeltaEvent { type: 'text_delta'; text: string; }
export interface ChatGptToolCallEvent { type: 'tool_call'; toolCall: ChatGptToolCall; }
export interface ChatGptDoneEvent { type: 'done'; terminalSuccessful?: boolean; outputItems?: ChatGptOutputItem[]; finishReason?: ChatGptFinishReason; usage?: ChatGptUsage; /** Internal carrier, never client-visible content. */ replayItems?: ChatGptReplayItem[]; /** Fixed internal completeness marker for implicit replay. */ replayEligible?: boolean; }
export type ChatGptStreamEvent = ChatGptTextDeltaEvent | ChatGptToolCallEvent | ChatGptDoneEvent;
