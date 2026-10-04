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

/** Admin writes validate explicit new configuration; persisted legacy aliases
 * still load so their owners can disable, unbind, correct or delete them.
 */
export function assertTextAliasConfiguration(input: Record<string, unknown>, current?: { id: string; backendModel?: string; enabled: boolean }): void {
  const isImage = (value: unknown) => typeof value === 'string' && imageModelIds.has(value.trim());
  const invalid = () => new ClaudeApiError('Image models use the Images API at /v1/images/generations; they cannot be used as text aliases or targets.', 400, 'invalid_request_error');
  if (!current) {
    if (isImage(input.id) || isImage(input.backendModel)) throw invalid();
    return;
  }
  const target = typeof input.backendModel === 'string' ? input.backendModel.trim() || undefined
    : input.backendModel === null ? undefined : current.backendModel;
  const disablingExistingTarget = input.enabled === false && target === current.backendModel;
  if (isImage(input.backendModel) && !disablingExistingTarget
    || input.enabled === true && (isImage(current.id) || isImage(target))) throw invalid();
}
