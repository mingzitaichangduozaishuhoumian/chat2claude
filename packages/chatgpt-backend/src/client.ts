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

/** Provider image lifecycle states. `incomplete` is not an image lifecycle state. */
export type ChatGptImageGenerationCallStatus = 'in_progress' | 'generating' | 'completed' | 'failed';

/** A completed, authoritative image result safe to expose to protocol mappers. */
export interface ChatGptImageGenerationMetadata {
  action?: 'generate' | 'edit' | 'auto';
  background?: 'transparent' | 'opaque' | 'auto';
  output_format?: 'png' | 'webp' | 'jpeg';
  quality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  size?: string;
  mime_type?: string;
  revised_prompt?: string;
}
export interface ChatGptImageGenerationCallOutputItem extends ChatGptImageGenerationMetadata {
  type: 'image_generation_call';
  id: string;
  status: 'completed';
  result: string;
}

export interface ChatGptImageGenerationRequest {
  prompt: string;
  model?: string;
  background?: 'transparent' | 'opaque' | 'auto';
  n?: number;
  quality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  size?: string;
}
export interface ChatGptImageGenerationResponse {
  created: number;
  data: Array<{ b64_json: string; generation_id?: string }>;
  background?: 'transparent' | 'opaque' | 'auto';
  quality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  size?: string;
  output_format?: 'png' | 'webp' | 'jpeg';
  usage?: ChatGptUsage;
}

export type ChatGptOutputItem = ChatGptReplayItem | ChatGptImageGenerationCallOutputItem | {
  type: 'message'; id?: string; role: 'assistant'; status?: ChatGptReplayItemStatus;
  content: Array<{ type: 'output_text'; text: string; annotations: [] } | { type: 'refusal'; refusal: string }>;
};

export type ChatGptInputItem =
  | { type: 'replay'; item: ChatGptReplayItem }
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: string | ChatGptInputContentPart[] }
  | { type: 'function_call'; callId: string; name: string; arguments: unknown }
  | { type: 'function_call_output'; callId: string; output: string | ChatGptInputContentPart[]; isError?: boolean };
export interface ChatGptTool { name: string; description?: string; inputSchema: Record<string, unknown>; strict?: boolean; raw?: unknown; }
export type ChatGptToolChoice = { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string };
export interface ChatGptToolCall { id: string; name: string; input: unknown; /** Validated original JSON arguments for protocols that carry a string. */ rawArguments?: string; }
export interface ChatGptUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; raw?: unknown; }
/** Trusted execution plan resolved against the selected account's model catalog. */
export interface ChatGptReasoningExecution { effort: string; delegation: 'proactive'; }
export interface ChatGptCompletionRequest { messages: ChatGptMessage[]; inputItems?: ChatGptInputItem[]; maxTokens: number; model: string; reasoningEffort?: ChatGptReasoningEffort; reasoningExecution?: ChatGptReasoningExecution; serviceTier?: ChatGptServiceTier; /** @deprecated Use serviceTier. */ speedPreference?: ChatGptSpeedPreference; temperature?: number; topP?: number; stopSequences?: string[]; parallelToolCalls?: boolean; tools?: ChatGptTool[]; toolChoice?: ChatGptToolChoice; backendOptions?: Record<string, unknown>; }
/** Internal projected-content position to provider content_index mapping. */
export interface ChatGptOutputContentIndices { itemId: string; indices: number[]; }
export interface ChatGptCompletionResponse { /** Internal identity metadata; never client-visible output. */ outputContentIndices?: ChatGptOutputContentIndices[]; /** False for legacy EOF compatibility; native Responses must reject it. */ terminalSuccessful?: boolean; /** Ordered text/replay projection for native Responses only. */ outputItems?: ChatGptOutputItem[]; text: string; refusal?: string; finishReason: ChatGptFinishReason; toolCalls?: ChatGptToolCall[]; usage?: ChatGptUsage; /** Successful provider output order; internal only. */ replayItems?: ChatGptReplayItem[]; /** Entire completed output is replayable reasoning/tools with at least one tool. */ replayEligible?: boolean; }
export interface ChatGptReasoningLevelOption { effort: string; description?: string; }
export interface ChatGptServiceTierOption { id: string; name?: string; description?: string; }
export interface ChatGptModelControlCapabilities {
  reasoning: {
    metadataKnown: boolean;
    supported: ChatGptReasoningLevelOption[];
    defaultEffort?: string;
    multiAgent?: unknown;
    /** Recognized catalog protocol version; unknown versions remain in the model's raw metadata. */
    multiAgentVersion?: 'v1' | 'v2';
    /** Provider-advertised effort for multi-agent reasoning; never inferred from the version. */
    multiAgentReasoningEffort?: string;
  };
  serviceTier: {
    metadataKnown: boolean;
    supported: ChatGptServiceTierOption[];
    defaultTier?: string;
    fastMode: boolean;
  };
}
/** Explicit provider catalog values only. Missing fields remain unknown. */
export interface ChatGptModelContextMetadata {
  contextWindow?: number;
  maxContextWindow?: number;
  effectiveContextWindowPercent?: number;
  autoCompactTokenLimit?: number;
}
export interface ChatGptDiscoveredModel { id: string; displayName?: string; capabilities?: Record<string, unknown>; controls?: ChatGptModelControlCapabilities; context?: ChatGptModelContextMetadata; raw?: unknown; }

/** Allowlisted operational metadata only. Never attach provider payloads or error text. */
export interface ChatGptModelDiscoveryDiagnostic {
  clientVersion: string;
  requestContext?: {
    originator: 'codex_cli_rs';
    hasAccountId: boolean;
    hasCookie: boolean;
    hasDeviceId: boolean;
    userAgentSource: 'stored' | 'fallback';
    userAgentFamily: 'stored' | 'codex_cli_rs';
  };
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
  generateImages?(request: ChatGptImageGenerationRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptImageGenerationResponse>;
  complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse>;
  stream(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): AsyncIterable<ChatGptStreamEvent>;
  listModels(context?: ChatGptBackendRequestContext): Promise<ChatGptDiscoveredModel[]>;
  discoverModels?(context?: ChatGptBackendRequestContext): Promise<ChatGptModelDiscoveryResult>;
  healthCheck?(context?: ChatGptBackendRequestContext): Promise<ChatGptBackendHealthCheckResult>;
  getAccountQuota?(context?: ChatGptBackendRequestContext): Promise<ChatGptAccountQuota>;
  consumeAccountResetCredit?(redeemRequestId: string, context?: ChatGptBackendRequestContext): Promise<void>;
}
