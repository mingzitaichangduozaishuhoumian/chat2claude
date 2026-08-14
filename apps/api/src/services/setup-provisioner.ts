import type { ChatGptBackendClient, ChatGptDiscoveredModel, ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';
import type { AccountPool, AccountView } from './account-pool.js';
import type { ModelRegistry } from './model-registry.js';
import type { RuntimeApiKeys } from './runtime-api-keys.js';

export const PRIMARY_CHATGPT_ACCOUNT_ID = 'chatgpt-primary';

export interface SetupProvisionerOptions {
  accountPool: AccountPool;
  modelRegistry: ModelRegistry;
  backend: ChatGptBackendClient;
  runtimeApiKeys: RuntimeApiKeys;
}

export interface ProvisionResult {
  ok: true;
  apiKey: string;
  account: AccountView;
  modelsDiscovered: string[];
  boundAliases: Record<string, string>;
}

export class SetupProvisioner {
  constructor(private readonly options: SetupProvisionerOptions) {}

  async provision(secret: ChatGptSessionSecret): Promise<ProvisionResult> {
    const account = this.options.accountPool.upsert({
      id: PRIMARY_CHATGPT_ACCOUNT_ID,
      provider: 'chatgpt-session',
      label: 'ChatGPT Primary Session',
      enabled: true,
      maxConcurrency: 1,
      capabilities: ['chatgpt-session', 'messages'],
      secret,
    });

    const internalAccount = this.options.accountPool.get(account.id);
    if (!internalAccount) throw new Error(`Provisioned account not found: ${account.id}`);

    if (this.options.backend.healthCheck) {
      const health = await this.options.backend.healthCheck({ account: internalAccount });
      if (!health.ok) {
        this.options.accountPool.markError(account.id, health.message ?? 'ChatGPT session health check failed');
        throw new Error(health.message ?? 'ChatGPT session health check failed');
      }
    }
    const healthyAccount = this.options.accountPool.markHealthy(account.id) ?? account;
    const view = await this.options.modelRegistry.refreshFromBackend(this.options.backend, { account: internalAccount });
    const best = chooseBestModel(view.discovered.map((model) => model.discovered ?? { id: model.id, displayName: model.display_name }));
    const boundAliases: Record<string, string> = {};
    if (best) {
      const updated = this.options.modelRegistry.update('sonnet', { backendModel: best.id, enabled: true });
      if (updated?.backendModel) boundAliases.sonnet = updated.backendModel;
    }

    return {
      ok: true,
      apiKey: this.options.runtimeApiKeys.create(),
      account: healthyAccount,
      modelsDiscovered: view.discovered.map((model) => model.id),
      boundAliases,
    };
  }
}

export function chooseBestModel(models: ChatGptDiscoveredModel[]): ChatGptDiscoveredModel | undefined {
  return [...models].sort((a, b) => modelScore(b) - modelScore(a))[0];
}

function modelScore(model: ChatGptDiscoveredModel): number {
  const text = `${model.id} ${model.displayName ?? ''}`.toLowerCase();
  const keywords: Array<[string, number]> = [
    ['gpt-5', 100],
    ['codex', 80],
    ['thinking', 60],
    ['gpt-4', 40],
  ];
  return keywords.reduce((score, [keyword, value]) => score + (text.includes(keyword) ? value : 0), 0);
}
