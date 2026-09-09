import type { ChatGptModelDiscoveryDiagnostic } from './client.js';

export type ChatGptBackendErrorCode = 'unauthorized' | 'rate_limited' | 'upstream_error' | 'timeout' | 'network_error' | 'invalid_response' | 'invalid_request';

const DIAGNOSTIC_VALUES = {
  protocolStage: ['sse_decode', 'frame_validation', 'terminal', 'tool_finalization', 'replay_snapshot'],
  protocolReason: ['malformed_sse_json', 'invalid_lifecycle', 'invalid_text', 'invalid_part', 'invalid_output_item', 'invalid_frame', 'response_incomplete', 'missing_terminal', 'tool_finalization', 'replay_snapshot', 'bootstrap_limit'],
  eventType: ['error', 'response.error', 'response.failed', 'response.incomplete', 'response.completed', 'response.output_item.added', 'response.output_item.done', 'response.function_call_arguments.delta', 'response.function_call_arguments.done'],
  responseStatus: ['completed', 'failed', 'in_progress', 'cancelled', 'queued', 'incomplete'],
  responseErrorType: ['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'server_error', 'api_error'],
  responseErrorParam: ['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'service_tier', 'stream', 'store', 'include', 'max_output_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'truncation', 'prompt_cache_options', 'prompt_cache_retention', 'context_management', 'previous_response_id', 'metadata', 'text'],
  responseErrorCode: ['unsupported_parameter', 'unsupported_value', 'invalid_value', 'invalid_type', 'missing_required_parameter', 'unknown_parameter', 'invalid_request_error', 'model_not_found', 'invalid_api_key', 'insufficient_quota', 'context_length_exceeded', 'server_error', 'rate_limit_exceeded', 'invalid_prompt', 'data_residency_mismatch', 'bio_policy', 'misalignment_policy_violation', 'vector_store_timeout', 'invalid_image', 'invalid_image_format', 'invalid_base64_image', 'invalid_image_url', 'image_too_large', 'image_too_small', 'image_parse_error', 'image_content_policy_violation', 'invalid_image_mode', 'image_file_too_large', 'unsupported_image_media_type', 'empty_image_file', 'failed_to_download_image', 'image_file_not_found'],
  incompleteReason: ['max_output_tokens', 'max_messages', 'content_filter', 'steered'],
  timeoutKind: ['stream_bootstrap', 'response_headers', 'stream_idle', 'stream_total'],
  failurePhase: ['request_fetch', 'response_headers', 'response_event', 'response_incomplete', 'response_body_read', 'response_protocol'],
} as const;

export type ChatGptSafeDiagnostic = Readonly<{
  [K in keyof typeof DIAGNOSTIC_VALUES]?: typeof DIAGNOSTIC_VALUES[K][number] | 'unknown';
} & { httpStatus?: number }>;

/** Debug-only shape data for replay validation. It intentionally contains no provider values. */
export interface ChatGptReplayDebugDiagnostic {
  eventType: 'response.output_item.done' | 'response.completed' | 'other';
  topLevelFields: string[];
  itemType: 'reasoning' | 'function_call' | 'message' | 'other' | 'missing';
  itemStatus: 'in_progress' | 'completed' | 'incomplete' | 'other' | 'missing';
  callerFields?: string[];
  callerType?: 'direct' | 'program' | 'other' | 'missing';
  outputIndex: 'valid' | 'invalid' | 'missing';
  responseOutputCount?: number;
  mismatchReason?: 'validation_failure' | 'duplicate_identity_conflict' | 'done_snapshot_missing' | 'done_snapshot_mismatch' | 'output_snapshot_conflict' | 'output_index_mismatch';
}

const REPLAY_DEBUG_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const REPLAY_DEBUG_MISMATCH_REASONS = new Set<NonNullable<ChatGptReplayDebugDiagnostic['mismatchReason']>>([
  'validation_failure', 'duplicate_identity_conflict', 'done_snapshot_missing', 'done_snapshot_mismatch', 'output_snapshot_conflict', 'output_index_mismatch',
]);

/** Copy the bounded, categorical replay shape only; values from the provider never enter logs. */
export function sanitizeReplayDebugDiagnostic(value: unknown): ChatGptReplayDebugDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const eventType = raw.eventType === 'response.output_item.done' || raw.eventType === 'response.completed' ? raw.eventType : 'other';
  const category = <T extends string>(candidate: unknown, allowed: readonly T[], fallback: T) => typeof candidate === 'string' && (allowed as readonly string[]).includes(candidate) ? candidate as T : fallback;
  const fields = (candidate: unknown) => Array.isArray(candidate)
    ? [...new Set(candidate.filter((field): field is string => typeof field === 'string' && REPLAY_DEBUG_FIELD_NAME.test(field)))].sort().slice(0, 32) : [];
  const diagnostic: ChatGptReplayDebugDiagnostic = {
    eventType,
    topLevelFields: fields(raw.topLevelFields),
    itemType: category(raw.itemType, ['reasoning', 'function_call', 'message', 'other', 'missing'], 'missing'),
    itemStatus: category(raw.itemStatus, ['in_progress', 'completed', 'incomplete', 'other', 'missing'], 'missing'),
    outputIndex: category(raw.outputIndex, ['valid', 'invalid', 'missing'], 'missing'),
  };
  const callerFields = fields(raw.callerFields);
  if (callerFields.length) diagnostic.callerFields = callerFields;
  if (raw.callerType !== undefined) diagnostic.callerType = category<NonNullable<ChatGptReplayDebugDiagnostic['callerType']>>(raw.callerType, ['direct', 'program', 'other', 'missing'], 'missing');
  if (typeof raw.responseOutputCount === 'number' && Number.isSafeInteger(raw.responseOutputCount) && raw.responseOutputCount >= 0 && raw.responseOutputCount <= 128) diagnostic.responseOutputCount = raw.responseOutputCount;
  if (typeof raw.mismatchReason === 'string' && REPLAY_DEBUG_MISMATCH_REASONS.has(raw.mismatchReason as NonNullable<ChatGptReplayDebugDiagnostic['mismatchReason']>)) diagnostic.mismatchReason = raw.mismatchReason as NonNullable<ChatGptReplayDebugDiagnostic['mismatchReason']>;
  return Object.freeze(diagnostic);
}

/** Copy allowlisted primitives only, including at runtime for non-TypeScript callers. */
export function sanitizeBackendDiagnostic(value: unknown): ChatGptSafeDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const safe: Record<string, string | number> = {};
  for (const key of Object.keys(DIAGNOSTIC_VALUES) as Array<keyof typeof DIAGNOSTIC_VALUES>) {
    if (raw[key] === undefined) continue;
    const allowed: readonly string[] = DIAGNOSTIC_VALUES[key];
    if (typeof raw[key] === 'string' && allowed.includes(raw[key])) safe[key] = raw[key];
    else if (key !== 'failurePhase' && key !== 'timeoutKind') safe[key] = 'unknown';
  }
  if (typeof raw.httpStatus === 'number' && Number.isInteger(raw.httpStatus) && raw.httpStatus >= 100 && raw.httpStatus <= 599) safe.httpStatus = raw.httpStatus;
  return Object.freeze(safe) as ChatGptSafeDiagnostic;
}

export interface ChatGptBackendErrorOptions {
  code?: ChatGptBackendErrorCode;
  status?: number;
  cause?: unknown;
  discoveryDiagnostic?: ChatGptModelDiscoveryDiagnostic;
  safeDiagnostic?: ChatGptSafeDiagnostic;
  replayDebugDiagnostic?: ChatGptReplayDebugDiagnostic;
}

export class ChatGptBackendError extends Error {
  public readonly code: ChatGptBackendErrorCode;
  public readonly status?: number;
  public override readonly cause?: unknown;
  public readonly discoveryDiagnostic?: ChatGptModelDiscoveryDiagnostic;
  public readonly safeDiagnostic?: ChatGptSafeDiagnostic;
  public readonly replayDebugDiagnostic?: ChatGptReplayDebugDiagnostic;

  constructor(message: string, codeOrCause?: ChatGptBackendErrorCode | unknown, options: ChatGptBackendErrorOptions = {}) {
    const code = isBackendErrorCode(codeOrCause) ? codeOrCause : options.code ?? 'upstream_error';
    const cause = isBackendErrorCode(codeOrCause) ? options.cause : codeOrCause ?? options.cause;
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ChatGptBackendError';
    this.code = code;
    this.status = options.status;
    this.cause = cause;
    this.discoveryDiagnostic = options.discoveryDiagnostic;
    this.safeDiagnostic = sanitizeBackendDiagnostic(options.safeDiagnostic);
    this.replayDebugDiagnostic = sanitizeReplayDebugDiagnostic(options.replayDebugDiagnostic);
  }
}

function isBackendErrorCode(value: unknown): value is ChatGptBackendErrorCode {
  return value === 'unauthorized' || value === 'rate_limited' || value === 'upstream_error' || value === 'timeout' || value === 'network_error' || value === 'invalid_response' || value === 'invalid_request';
}
