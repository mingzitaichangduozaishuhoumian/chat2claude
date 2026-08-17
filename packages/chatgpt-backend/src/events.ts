import type { ChatGptFinishReason, ChatGptToolCall } from './client.js';

export interface ChatGptTextDeltaEvent { type: 'text_delta'; text: string; }
export interface ChatGptToolCallEvent { type: 'tool_call'; toolCall: ChatGptToolCall; }
export interface ChatGptDoneEvent { type: 'done'; finishReason?: ChatGptFinishReason; }
export type ChatGptStreamEvent = ChatGptTextDeltaEvent | ChatGptToolCallEvent | ChatGptDoneEvent;
