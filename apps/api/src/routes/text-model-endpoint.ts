import { CODEX_IMAGE_MODEL_IDS } from '@chatgpt-to-claude/chatgpt-backend';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import type { ModelRegistry } from '../services/model-registry.js';

/** Image endpoints are independent of text discovery, including stale alias targets. */
const imageModelIds = new Set<string>(CODEX_IMAGE_MODEL_IDS);
export function assertTextModelEndpoint(model: string, registry: Pick<ModelRegistry, 'exportState'>): void {
  if (imageModelIds.has(model) || registry.exportState().some((alias) => alias.id === model && alias.backendModel !== undefined && imageModelIds.has(alias.backendModel))) {
    throw new ClaudeApiError('This model uses the Images API. Use /v1/images/generations.', 400, 'invalid_request_error');
  }
}
