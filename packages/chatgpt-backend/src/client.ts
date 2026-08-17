import type { ChatGptStreamEvent } from './events.js';

export type ChatGptReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max';
export type ChatGptSpeedPreference = 'fastest' | 'fast' | 'balanced' | 'quality';
export type ChatGptFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'refusal' | 'interrupted' | 'error' | string;

export interface ChatGptMessage { role: 'user' | 'assistant' | 'system'; content: string; }
export interface ChatGptTool { name: string; description?: string; inputSchema: Record<string, unknown>; strict?: boolean; raw?: unknown; }
export type ChatGptToolChoice = { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string };
export interface ChatGptToolCall { id: string; name: string; input: unknown; }
export interface ChatGptUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; raw?: unknown; }
export interface ChatGptCompletionRequest { messages: ChatGptMessage[]; maxTokens: number; model: string; reasoningEffort?: ChatGptReasoningEffort; speedPreference?: ChatGptSpeedPreference; temperature?: number; topP?: number; stopSequences?: string[]; tools?: ChatGptTool[]; toolChoice?: ChatGptToolChoice; backendOptions?: Record<string, unknown>; }
export interface ChatGptCompletionResponse { text: string; finishReason: ChatGptFinishReason; toolCalls?: ChatGptToolCall[]; usage?: ChatGptUsage; }
export interface ChatGptDiscoveredModel { id: string; displayName?: string; capabilities?: Record<string, unknown>; raw?: unknown; }

export interface ChatGptSessionSecret {
  type: 'chatgpt-session';
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: string;
  email?: string;
  accountId?: string;
  planType?: string;
  cookie?: string;
  deviceId?: string;
  userAgent?: string;
}

export interface ChatGptBackendAccountContext {
  id: string;
  label?: string;
  provider?: 'mock' | 'chatgpt-session';
  secret?: ChatGptSessionSecret;
}

export interface ChatGptBackendRequestContext {
  account?: ChatGptBackendAccountContext;
}

export interface ChatGptBackendHealthCheckResult { ok: boolean; message?: string; }

export interface ChatGptBackendClient {
  complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse>;
  stream(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): AsyncIterable<ChatGptStreamEvent>;
  listModels(context?: ChatGptBackendRequestContext): Promise<ChatGptDiscoveredModel[]>;
  healthCheck?(context?: ChatGptBackendRequestContext): Promise<ChatGptBackendHealthCheckResult>;
}
