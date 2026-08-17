import type { ChatGptFinishReason, ChatGptToolCall, ChatGptUsage } from './client.js';

export interface ChatGptTextDeltaEvent { type: 'text_delta'; text: string; }
export interface ChatGptToolCallEvent { type: 'tool_call'; toolCall: ChatGptToolCall; }
export interface ChatGptDoneEvent { type: 'done'; finishReason?: ChatGptFinishReason; usage?: ChatGptUsage; }
export type ChatGptStreamEvent = ChatGptTextDeltaEvent | ChatGptToolCallEvent | ChatGptDoneEvent;
