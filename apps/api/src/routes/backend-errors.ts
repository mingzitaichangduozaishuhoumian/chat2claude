import { ChatGptBackendError } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';

export function mapChatGptBackendError(error: unknown): ClaudeApiError | undefined {
  if (!(error instanceof ChatGptBackendError)) return undefined;
  switch (error.code) {
    case 'unauthorized':
      return new ClaudeApiError(error.message, 401, 'authentication_error');
    case 'rate_limited':
      return new ClaudeApiError(error.message, 429, 'rate_limit_error');
    case 'timeout':
      return new ClaudeApiError(error.message, 504, 'api_error');
    case 'network_error':
    case 'invalid_response':
    case 'upstream_error':
      return new ClaudeApiError(error.message, 502, 'api_error');
  }
}

export function mapErrorPayload(error: unknown): { type: string; message: string } {
  const apiError = error instanceof ClaudeApiError ? error : mapChatGptBackendError(error) ?? new ClaudeApiError(error instanceof Error ? error.message : 'Invalid request');
  return { type: apiError.type, message: apiError.message };
}
