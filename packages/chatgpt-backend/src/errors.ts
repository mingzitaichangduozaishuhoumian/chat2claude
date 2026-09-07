import type { ChatGptModelDiscoveryDiagnostic } from './client.js';

export type ChatGptBackendErrorCode = 'unauthorized' | 'rate_limited' | 'upstream_error' | 'timeout' | 'network_error' | 'invalid_response' | 'invalid_request';

const DIAGNOSTIC_VALUES = {
  eventType: ['error', 'response.error', 'response.failed', 'response.incomplete', 'response.completed', 'response.output_item.added', 'response.output_item.done', 'response.function_call_arguments.delta', 'response.function_call_arguments.done'],
  responseStatus: ['completed', 'failed', 'in_progress', 'cancelled', 'queued', 'incomplete'],
  responseErrorType: ['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'server_error', 'api_error'],
  responseErrorParam: ['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'service_tier', 'stream', 'store', 'include', 'max_output_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'truncation', 'prompt_cache_options', 'prompt_cache_retention', 'context_management', 'previous_response_id', 'metadata', 'text'],
  responseErrorCode: ['unsupported_parameter', 'unsupported_value', 'invalid_value', 'invalid_type', 'missing_required_parameter', 'unknown_parameter', 'invalid_request_error', 'model_not_found', 'invalid_api_key', 'insufficient_quota', 'context_length_exceeded', 'server_error', 'rate_limit_exceeded', 'invalid_prompt', 'data_residency_mismatch', 'bio_policy', 'misalignment_policy_violation', 'vector_store_timeout', 'invalid_image', 'invalid_image_format', 'invalid_base64_image', 'invalid_image_url', 'image_too_large', 'image_too_small', 'image_parse_error', 'image_content_policy_violation', 'invalid_image_mode', 'image_file_too_large', 'unsupported_image_media_type', 'empty_image_file', 'failed_to_download_image', 'image_file_not_found'],
  incompleteReason: ['max_output_tokens', 'max_messages', 'content_filter', 'steered'],
  failurePhase: ['request_fetch', 'response_headers', 'response_event', 'response_incomplete', 'response_body_read', 'response_protocol'],
} as const;

export type ChatGptSafeDiagnostic = Readonly<{
  [K in keyof typeof DIAGNOSTIC_VALUES]?: typeof DIAGNOSTIC_VALUES[K][number] | 'unknown';
} & { httpStatus?: number }>;

/** Copy allowlisted primitives only, including at runtime for non-TypeScript callers. */
export function sanitizeBackendDiagnostic(value: unknown): ChatGptSafeDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const safe: Record<string, string | number> = {};
  for (const key of Object.keys(DIAGNOSTIC_VALUES) as Array<keyof typeof DIAGNOSTIC_VALUES>) {
    if (raw[key] === undefined) continue;
    const allowed: readonly string[] = DIAGNOSTIC_VALUES[key];
    if (typeof raw[key] === 'string' && allowed.includes(raw[key])) safe[key] = raw[key];
    else if (key !== 'failurePhase') safe[key] = 'unknown';
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
}

export class ChatGptBackendError extends Error {
  public readonly code: ChatGptBackendErrorCode;
  public readonly status?: number;
  public override readonly cause?: unknown;
  public readonly discoveryDiagnostic?: ChatGptModelDiscoveryDiagnostic;
  public readonly safeDiagnostic?: ChatGptSafeDiagnostic;

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
  }
}

function isBackendErrorCode(value: unknown): value is ChatGptBackendErrorCode {
  return value === 'unauthorized' || value === 'rate_limited' || value === 'upstream_error' || value === 'timeout' || value === 'network_error' || value === 'invalid_response' || value === 'invalid_request';
}
