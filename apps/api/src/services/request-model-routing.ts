import type { Context } from 'hono';
import type { Account, AccountPool } from './account-pool.js';
import type { BackendRouting } from './backend-routing.js';
import { ModelRegistryError, type ExplicitModelControls, type ModelRegistry, type ModelResolution } from './model-registry.js';
import { requestBackendMode } from './request-backend-routing.js';

export interface ModelRoutingDeps {
  modelRegistry: ModelRegistry;
  accountPool: AccountPool;
  backendRouting?: BackendRouting;
  backendProvider?: 'session' | 'mock';
}

/** Only administrator-declared substitutions can select a different web model. */
export function mappedWebModel(routing: BackendRouting | undefined, clientModel: string, backendModel?: string): string | undefined {
  if (!routing?.isWebEnabled()) return undefined;
  const mappings = routing?.snapshot().gateway?.modelMappings;
  if (!mappings) return undefined;
  if (Object.hasOwn(mappings, clientModel)) return mappings[clientModel];
  if (backendModel !== undefined && Object.hasOwn(mappings, backendModel)) return mappings[backendModel];
  return undefined;
}

export function resolveRequestModel(c: Context, deps: ModelRoutingDeps, id: string): ModelResolution {
  try { return deps.modelRegistry.resolve(id); }
  catch (error) {
    if (!(error instanceof ModelRegistryError) || error.code === 'disabled' || requestBackendMode(c, deps.backendRouting) === 'codex') throw error;
    const declared = deps.modelRegistry.exportState().find((alias) => alias.id === id)?.backendModel;
    const target = mappedWebModel(deps.backendRouting, id, declared);
    if (!target) throw error;
    const account = deps.accountPool.snapshot().accounts.find((candidate) => candidate.provider === 'chatgpt-web' && candidate.enabled);
    if (!account) throw error;
    return deps.modelRegistry.resolveForAccount(id, { accountId: account.id, createdAt: account.createdAt }, target);
  }
}

export function resolveRoutedAccountModel(deps: ModelRoutingDeps, id: string, account: Account, global: ModelResolution): ModelResolution {
  if (account.provider !== 'chatgpt-web' && deps.backendProvider !== 'session') return global;
  return deps.modelRegistry.resolveForAccount(id, { accountId: account.id, createdAt: account.createdAt },
    account.provider === 'chatgpt-web' ? mappedWebModel(deps.backendRouting, id, declaredBackendModel(deps.modelRegistry, id, global.backendModel)) : undefined);
}

export function supportsRoutedAccount(deps: ModelRoutingDeps, id: string, account: Account, global: ModelResolution,
  explicit: ExplicitModelControls, primaryControls: ExplicitModelControls, accepts?: (resolution: ModelResolution) => boolean): boolean {
  try {
    const resolution = resolveRoutedAccountModel(deps, id, account, global);
    deps.modelRegistry.resolveControls(resolution, account.provider === 'chatgpt-web' ? explicit : primaryControls);
    return accepts?.(resolution) ?? true;
  } catch { return false; }
}

/** Keep Codex's original scope when a web substitution has a different model ID. */
export function declaredBackendModel(registry: ModelRegistry, clientModel: string, fallback: string): string {
  return registry.exportState().find((alias) => alias.id === clientModel)?.backendModel ?? fallback;
}
