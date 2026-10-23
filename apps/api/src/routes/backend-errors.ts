import { ChatGptBackendError, isWebGatewayBackendError } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';

export const INTERNAL_SERVER_ERROR_MESSAGE = 'Internal server error';

/** Only JSON syntax failures at the body parsing boundary are public validation errors. */
export async function parseRequestJson(read: () => Promise<unknown>): Promise<unknown> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SyntaxError) throw new ClaudeApiError('Request body must be valid JSON.', 400, 'invalid_request_error');
    throw error;
  }
}

/**
 * Converts backend failures at the protocol trust boundary.  Only errors
 * created as ClaudeApiError are intentionally public; provider errors retain
 * their established status/type mapping but never disclose provider text.
 */
export function mapChatGptBackendError(error: unknown): ClaudeApiError | undefined {
  if (!(error instanceof ChatGptBackendError)) return undefined;
  if (isWebGatewayBackendError(error)) {
    switch (error.code) {
      case 'invalid_request': return new ClaudeApiError('The ChatGPT web gateway rejected this request. Check its model mappings and supported tools or images, or switch to Codex in Admin.', 400, 'invalid_request_error');
      case 'unauthorized': return new ClaudeApiError('ChatGPT web gateway authentication failed. Check the gateway API key and ChatGPT web login, or switch to Codex in Admin.', 401, 'authentication_error');
      case 'rate_limited': return new ClaudeApiError('The ChatGPT web gateway is rate limited. Wait before retrying or switch to Codex in Admin.', 429, 'rate_limit_error');
      case 'timeout': return new ClaudeApiError('The ChatGPT web gateway timed out. Check the gateway and web login, or switch to Codex in Admin.', 504, 'api_error');
      case 'network_error': return new ClaudeApiError('Cannot connect to the ChatGPT web gateway. Start the gateway and check its address, or switch to Codex in Admin.', 502, 'api_error');
      case 'invalid_response': return new ClaudeApiError('The ChatGPT web gateway returned an invalid or incomplete response. Check its compatibility and web login, or switch to Codex in Admin.', 502, 'api_error');
      case 'upstream_error': return new ClaudeApiError('The ChatGPT web gateway is unavailable. Check the gateway and web login, or switch to Codex in Admin.',
        error.safeDiagnostic?.failurePhase === 'response_headers' && Number.isInteger(error.status) && error.status! >= 400 && error.status! <= 599 ? error.status! : 502, 'api_error');
    }
  }
  switch (error.code) {
    case 'invalid_request':
      return new ClaudeApiError('The upstream provider rejected the request.', 400, 'invalid_request_error');
    case 'unauthorized':
      return new ClaudeApiError('Upstream authentication failed.', 401, 'authentication_error');
    case 'rate_limited':
      return new ClaudeApiError('Upstream rate limit exceeded.', 429, 'rate_limit_error');
    case 'timeout':
      return new ClaudeApiError('Upstream request timed out.', 504, 'api_error');
    case 'network_error':
    case 'invalid_response':
      return new ClaudeApiError('Upstream request failed.', 502, 'api_error');
    case 'upstream_error':
      if (error.safeDiagnostic?.failurePhase === 'response_headers' && Number.isInteger(error.status) && error.status! >= 400 && error.status! <= 599) {
        return new ClaudeApiError('Upstream request failed.', error.status!, 'api_error');
      }
      return new ClaudeApiError('Upstream request failed.', 502, 'api_error');
  }
}

/** Only a caller-aborted request plus AbortError is a cancellation, not an upstream failure. */
export function mapRequestCancellation(error: unknown, signal: AbortSignal): ClaudeApiError | undefined {
  return signal.aborted && error instanceof Error && error.name === 'AbortError'
    ? new ClaudeApiError('Request cancelled.', 499, 'api_error') : undefined;
}

/** Return a safe 5xx protocol error for failures outside the trusted boundary. */
export function unexpectedApiError(): ClaudeApiError {
  return new ClaudeApiError(INTERNAL_SERVER_ERROR_MESSAGE, 500, 'api_error');
}

export function mapErrorPayload(error: unknown): { type: string; message: string } {
  const apiError = error instanceof ClaudeApiError ? error : mapChatGptBackendError(error) ?? unexpectedApiError();
  return { type: apiError.type, message: apiError.message };
}
