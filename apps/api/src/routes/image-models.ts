import { CODEX_IMAGE_MODEL_IDS, CODEX_IMAGE_RESOLUTION_ALIASES, type ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import type { AccountPool } from '../services/account-pool.js';
import { imageAccountAcquireOptions } from './image-account-eligibility.js';

export interface PublicImageModel {
  id: string;
  type: 'model';
  display_name: string;
  source: 'image_endpoint';
  endpoint: '/v1/images/generations';
  capabilities: { image_generation: true };
  availability: 'backend_dependent';
  alias_of?: string;
  default_size?: string;
  post_processing?: 'resize';
}

export interface ImageModelsOptions {
  backend?: Pick<ChatGptBackendClient, 'generateImages'>;
  accountPool?: Pick<AccountPool, 'unavailableReason'>;
  backendProvider?: 'mock' | 'session';
}

/** Endpoint availability is not provider catalog discovery or verified entitlement. */
export function availableImageModels(options: ImageModelsOptions, accountId?: string): PublicImageModel[] {
  if (typeof options.backend?.generateImages !== 'function' || !options.accountPool) return [];
  const acquire = imageAccountAcquireOptions(options.backendProvider);
  const reason = options.accountPool.unavailableReason(accountId === undefined ? acquire : {
    ...acquire,
    eligible: (account) => account.id === accountId && (acquire.eligible?.(account) ?? true),
  });
  if (reason !== undefined && reason !== 'account_busy') return [];
  return CODEX_IMAGE_MODEL_IDS.map<PublicImageModel>((id) => {
    const alias = Object.hasOwn(CODEX_IMAGE_RESOLUTION_ALIASES, id) ? CODEX_IMAGE_RESOLUTION_ALIASES[id as keyof typeof CODEX_IMAGE_RESOLUTION_ALIASES] : undefined;
    return { id, type: 'model', display_name: 'GPT Image ' + id.slice('gpt-image-'.length).split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '), source: 'image_endpoint',
      endpoint: '/v1/images/generations', capabilities: { image_generation: true }, availability: 'backend_dependent',
      ...(alias ? { alias_of: alias.model, default_size: alias.size, post_processing: 'resize' as const } : {}),
    };
  });
}
