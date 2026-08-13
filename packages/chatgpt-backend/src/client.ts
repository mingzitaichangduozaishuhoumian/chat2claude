import type { ChatGptStreamEvent } from './events.js';
export type ChatGptReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max';
export type ChatGptSpeedPreference = 'fastest' | 'fast' | 'balanced' | 'quality';
export interface ChatGptMessage { role: 'user' | 'assistant' | 'system'; content: string; }
export interface ChatGptCompletionRequest { messages: ChatGptMessage[]; maxTokens: number; model: string; reasoningEffort?: ChatGptReasoningEffort; speedPreference?: ChatGptSpeedPreference; backendOptions?: Record<string, unknown>; }
export interface ChatGptCompletionResponse { text: string; finishReason: 'stop' | 'length'; }
export interface ChatGptDiscoveredModel { id: string; displayName?: string; capabilities?: Record<string, unknown>; raw?: unknown; }
export interface ChatGptBackendClient { complete(request: ChatGptCompletionRequest): Promise<ChatGptCompletionResponse>; stream(request: ChatGptCompletionRequest): AsyncIterable<ChatGptStreamEvent>; listModels(): Promise<ChatGptDiscoveredModel[]>; }
