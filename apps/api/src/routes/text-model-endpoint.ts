import { DEFAULT_CODEX_IMAGE_MODEL } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import type { ModelRegistry } from '../services/model-registry.js';

/** Image endpoints are independent of text discovery, including stale alias targets. */
export function assertTextModelEndpoint(model: string, registry: Pick<ModelRegistry, 'exportState'>): void {
  if (model === DEFAULT_CODEX_IMAGE_MODEL || registry.exportState().some((alias) => alias.id === model && alias.backendModel === DEFAULT_CODEX_IMAGE_MODEL)) {
    throw new ClaudeApiError('This model uses the Images API. Use /v1/images/generations.', 400, 'invalid_request_error');
  }
}
