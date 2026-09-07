import type { ChatGptStreamEvent } from './events.js';

export type ChatGptReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | (string & {});
export type ChatGptServiceTier = string;
/** @deprecated Use ChatGptServiceTier. */
export type ChatGptSpeedPreference = ChatGptServiceTier;
export type ChatGptFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'refusal' | 'interrupted' | 'error' | string;

export interface ChatGptMessage { role: 'user' | 'assistant' | 'system'; content: string; }
export type ChatGptImageDetail = 'auto' | 'low' | 'high';
export type ChatGptInputContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl: string; detail?: ChatGptImageDetail };
/** Restricted provider wire shapes, opaque to client-facing protocol mappers.
 * Keep IDs, text and ciphertext verbatim; never turn these into text/tool events.
 */
export type ChatGptReplayItemStatus = 'in_progress' | 'completed' | 'incomplete';
export interface ChatGptReasoningReplayItem {
  type: 'reasoning';
  id: string;
  summary: Array<{ type: 'summary_text'; text: string }>;
  content?: Array<{ type: 'reasoning_text'; text: string }>;
  status?: ChatGptReplayItemStatus;
  encrypted_content: string;
}
export interface ChatGptFunctionCallReplayItem {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: ChatGptReplayItemStatus;
  async?: boolean;
  caller?: { type: 'direct' } | { type: 'program'; caller_id: string } | null;
  namespace?: string;
}
export type ChatGptReplayItem = ChatGptReasoningReplayItem | ChatGptFunctionCallReplayItem;

export type ChatGptOutputItem = ChatGptReplayItem | {
  type: 'message'; id?: string; role: 'assistant'; status?: ChatGptReplayItemStatus;
  content: Array<{ type: 'output_text'; text: string; annotations: [] }>;
};

export type ChatGptInputItem =
  | { type: 'replay'; item: ChatGptReplayItem }
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: string | ChatGptInputContentPart[] }
  | { type: 'function_call'; callId: string; name: string; arguments: unknown }
  | { type: 'function_call_output'; callId: string; output: string; isError?: boolean };
export interface ChatGptTool { name: string; description?: string; inputSchema: Record<string, unknown>; strict?: boolean; raw?: unknown; }
export type ChatGptToolChoice = { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string };
export interface ChatGptToolCall { id: string; name: string; input: unknown; }
export interface ChatGptUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; raw?: unknown; }
export interface ChatGptCompletionRequest { messages: ChatGptMessage[]; inputItems?: ChatGptInputItem[]; maxTokens: number; model: string; reasoningEffort?: ChatGptReasoningEffort; serviceTier?: ChatGptServiceTier; /** @deprecated Use serviceTier. */ speedPreference?: ChatGptSpeedPreference; temperature?: number; topP?: number; stopSequences?: string[]; parallelToolCalls?: boolean; tools?: ChatGptTool[]; toolChoice?: ChatGptToolChoice; backendOptions?: Record<string, unknown>; }
export interface ChatGptCompletionResponse { /** False for legacy EOF compatibility; native Responses must reject it. */ terminalSuccessful?: boolean; /** Ordered text/replay projection for native Responses only. */ outputItems?: ChatGptOutputItem[]; text: string; finishReason: ChatGptFinishReason; toolCalls?: ChatGptToolCall[]; usage?: ChatGptUsage; /** Successful provider output order; internal only. */ replayItems?: ChatGptReplayItem[]; /** Entire completed output is replayable reasoning/tools with at least one tool. */ replayEligible?: boolean; }
export interface ChatGptReasoningLevelOption { effort: string; description?: string; }
export interface ChatGptServiceTierOption { id: string; name?: string; description?: string; }
export interface ChatGptModelControlCapabilities {
  reasoning: {
    metadataKnown: boolean;
    supported: ChatGptReasoningLevelOption[];
    defaultEffort?: string;
    multiAgent?: unknown;
  };
  serviceTier: {
    metadataKnown: boolean;
    supported: ChatGptServiceTierOption[];
    defaultTier?: string;
    fastMode: boolean;
  };
}
export interface ChatGptDiscoveredModel { id: string; displayName?: string; capabilities?: Record<string, unknown>; controls?: ChatGptModelControlCapabilities; raw?: unknown; }

/** Allowlisted operational metadata only. Never attach provider payloads or error text. */
export interface ChatGptModelDiscoveryDiagnostic {
  clientVersion: string;
  httpStatus?: number;
  contentType: 'json' | 'event_stream' | 'html' | 'other' | 'missing';
  envelope: 'models' | 'data' | 'body_models' | 'array' | 'unknown';
  candidateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  reasons: Array<'unknown_envelope' | 'invalid_model_array' | 'invalid_model_id' | 'duplicate_model_id' | 'invalid_json'>;
}

export interface ChatGptModelDiscoveryResult {
  models: ChatGptDiscoveredModel[];
  /** unknown means no account/provider discovery was performed. */
  status: 'unknown' | 'success' | 'empty' | 'partial';
  diagnostic?: ChatGptModelDiscoveryDiagnostic;
}

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

export interface ChatGptWireMetrics {
  upstreamBodyBytes: number;
  upstreamInputItemCount: number;
  replayItemCount: number;
  replayApplied: boolean;
  toolCount: number;
  toolSchemaBytes: number;
}

export interface ChatGptBackendRequestContext {
  /** Internal observer, supplied by the route, never copied from request JSON. */
  onWireMetrics?: (metrics: Readonly<ChatGptWireMetrics>) => void;
  account?: ChatGptBackendAccountContext;
  /** Cancels the entire operation, including active response-body reads until stream disposal. */
  signal?: AbortSignal;
}

export interface ChatGptBackendHealthCheckResult { ok: boolean; message?: string; }

export interface ChatGptQuotaWindow {
  position: 'primary' | 'secondary';
  descriptor: string;
  usedPercent?: number;
  durationSeconds?: number;
  resetAfterSeconds?: number;
  resetAt?: string;
}

export interface ChatGptAdditionalQuotaLimit {
  meteredFeature?: string;
  limitName?: string;
  allowed?: boolean;
  limitReached?: boolean;
  rateLimitReachedType?: string;
  windows: ChatGptQuotaWindow[];
}

export interface ChatGptAccountQuota {
  providerAccountId?: string;
  providerUserId?: string;
  planType?: string;
  allowed?: boolean;
  limitReached?: boolean;
  rateLimitReachedType?: string;
  windows: ChatGptQuotaWindow[];
  additionalLimits?: ChatGptAdditionalQuotaLimit[];
  resetCredits?: {
    availableCount?: number;
    credits?: Array<{ id?: string; status: 'available'; grantedAt?: string; expiresAt: string }>;
    error?: 'fetch_failed' | 'invalid_response';
  };
}

export interface ChatGptBackendClient {
  complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse>;
  stream(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): AsyncIterable<ChatGptStreamEvent>;
  listModels(context?: ChatGptBackendRequestContext): Promise<ChatGptDiscoveredModel[]>;
  discoverModels?(context?: ChatGptBackendRequestContext): Promise<ChatGptModelDiscoveryResult>;
  healthCheck?(context?: ChatGptBackendRequestContext): Promise<ChatGptBackendHealthCheckResult>;
  getAccountQuota?(context?: ChatGptBackendRequestContext): Promise<ChatGptAccountQuota>;
  consumeAccountResetCredit?(redeemRequestId: string, context?: ChatGptBackendRequestContext): Promise<void>;
}
