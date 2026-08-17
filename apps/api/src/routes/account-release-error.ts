import { ChatGptBackendError } from '@chatgpt-to-claude/chatgpt-backend';

export function accountReleaseError(error: unknown): ChatGptBackendError | undefined {
  return error instanceof ChatGptBackendError ? error : undefined;
}
