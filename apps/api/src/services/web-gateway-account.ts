import { configuredWebGatewayModels } from '@chatgpt-to-claude/chatgpt-backend';
import type { AccountPool } from './account-pool.js';
import type { BackendRouting, BackendRoutingConfig } from './backend-routing.js';
import type { ModelRegistry } from './model-registry.js';

export const WEB_GATEWAY_ACCOUNT_ID = 'chatgpt-web-gateway';

/** Gateway credentials live in routing state, independently of Codex OAuth accounts. */
export function syncWebGatewayAccount(routing: BackendRouting, pool: AccountPool, models: ModelRegistry, previous?: BackendRoutingConfig, bindAlias = true): void {
  const { gateway, mode } = routing.snapshot();
  let account = pool.get(WEB_GATEWAY_ACCOUNT_ID);
  if (account && account.provider !== 'chatgpt-web') throw new Error('The web gateway account ID is already in use.');
  const enabled = account?.enabled ?? true;
  const maxConcurrency = account?.maxConcurrency ?? 1;
  const changed = previous !== undefined && JSON.stringify(previous.gateway) !== JSON.stringify(gateway);
  if (account && (!gateway || changed)) {
    models.removeAccountModels({ accountId: account.id, createdAt: account.createdAt });
    pool.remove(account.id);
    account = undefined;
  }
  if (!gateway) return;
  if (!account) {
    const view = pool.add({ id: WEB_GATEWAY_ACCOUNT_ID, provider: 'chatgpt-web', label: 'ChatGPT Web Gateway', enabled, maxConcurrency, capabilities: ['chatgpt-web', 'messages'] });
    account = pool.get(view.id)!;
  }
  const catalog = configuredWebGatewayModels(gateway);
  const identity = { accountId: account.id, createdAt: account.createdAt };
  const active = account.enabled && routing.isWebEnabled();
  models.replaceAccountModels(identity, catalog, active);
  // Let Codex finish startup discovery before considering a default web alias.
  if (bindAlias && active && mode !== 'codex') {
    const prepared = models.prepareProvisioning(catalog, 'sonnet', catalog[0]?.id, 'bind-if-unbound');
    models.commitPreparedProvisioning(prepared, identity, active);
  }
}
