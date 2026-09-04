export type ChatGptBackendErrorCode = 'unauthorized' | 'rate_limited' | 'upstream_error' | 'timeout' | 'network_error' | 'invalid_response' | 'invalid_request';

export interface ChatGptBackendErrorOptions {
  code?: ChatGptBackendErrorCode;
  status?: number;
  cause?: unknown;
}

export class ChatGptBackendError extends Error {
  public readonly code: ChatGptBackendErrorCode;
  public readonly status?: number;
  public override readonly cause?: unknown;

  constructor(message: string, codeOrCause?: ChatGptBackendErrorCode | unknown, options: ChatGptBackendErrorOptions = {}) {
    const code = isBackendErrorCode(codeOrCause) ? codeOrCause : options.code ?? 'upstream_error';
    const cause = isBackendErrorCode(codeOrCause) ? options.cause : codeOrCause ?? options.cause;
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ChatGptBackendError';
    this.code = code;
    this.status = options.status;
    this.cause = cause;
  }
}

function isBackendErrorCode(value: unknown): value is ChatGptBackendErrorCode {
  return value === 'unauthorized' || value === 'rate_limited' || value === 'upstream_error' || value === 'timeout' || value === 'network_error' || value === 'invalid_response' || value === 'invalid_request';
}
