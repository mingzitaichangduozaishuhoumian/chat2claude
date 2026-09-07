import { refreshAccountModels } from './services/account-model-discovery.js';
import { Hono } from 'hono';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { createLogger } from '@chatgpt-to-claude/shared';
import { loadEnv, type AppEnv } from './config/env.js';
import { accessLog } from './middleware/access-log.js';
import { adminApiAuth, apiKeyAuth } from './middleware/auth.js';
import { healthRoute } from './routes/health.js';
import { createModelsRoute } from './routes/models.js';
import { createMessagesRoute } from './routes/messages.js';
import { createOpenAiChatRoute } from './routes/openai-chat.js';
import { createOpenAiResponsesRoute } from './routes/openai-responses.js';
import { createCountTokensRoute } from './routes/count-tokens.js';
import { createMetricsRoute } from './routes/metrics.js';
import { createAdminRoute } from './routes/admin.js';
import { AccountPool } from './services/account-pool.js';
import { RequestLog } from './services/request-log.js';
import { RuntimeApiKeys } from './services/runtime-api-keys.js';
import { ModelRegistry } from './services/model-registry.js';
import { ResponsesStore } from './services/responses-store.js';
import { createChatGptBackend } from './services/backend-factory.js';
import { ChatGptAuthFlowService } from './services/chatgpt-auth-flow.js';
import { RuntimeStateStore } from './services/runtime-state-store.js';
import { DurableRuntimeState } from './services/durable-runtime-state.js';
import { LocalAdminSession } from './services/local-admin-session.js';
import { chooseBestModel, SetupProvisioner } from './services/setup-provisioner.js';
import { AdminOperationalState } from './services/admin-operational-state.js';
import { AccountQuotaService } from './services/account-quota-service.js';

export type Chat2ClaudeApp = Hono & { dispose: () => Promise<void> };

export interface CreateAppOptions {
  authFlow?: ChatGptAuthFlowService;
  runtimeStateStore?: RuntimeStateStore | null;
  operationalState?: AdminOperationalState | null;
  backend?: ChatGptBackendClient;
  backendFactory?: (accountPool: AccountPool, durableState: DurableRuntimeState | undefined) => ChatGptBackendClient;
}

export function createApp(env: AppEnv = loadEnv(), options: CreateAppOptions = {}): Chat2ClaudeApp {
  const app = new Hono() as Chat2ClaudeApp;
  const logger = createLogger(env.logLevel);
  const accountPool = new AccountPool({ seedMockAccount: env.chatGptBackend === 'mock' });
  const runtimeApiKeys = new RuntimeApiKeys();
  const localAdminSession = new LocalAdminSession(env.allowAnonymousBootstrap);
  const modelRegistry = new ModelRegistry();
  const runtimeStateStore = options.runtimeStateStore === undefined
    ? env.runtimeStatePath ? new RuntimeStateStore({ path: env.runtimeStatePath, encryptionKey: env.stateEncryptionKey }) : undefined
    : options.runtimeStateStore ?? undefined;
  const durableState = runtimeStateStore ? new DurableRuntimeState({ accountPool, runtimeApiKeys, modelRegistry, store: runtimeStateStore, removeMockAccountsOnHydrate: env.chatGptBackend === 'session' }) : undefined;
  durableState?.hydrate();
  const operationalState = options.operationalState === undefined
    ? env.operationalStatePath ? new AdminOperationalState({ path: env.operationalStatePath }) : undefined
    : options.operationalState ?? undefined;
  operationalState?.hydrate();
  operationalState?.cleanupOrphans(accountPool.list().map((account) => ({ accountId: account.id, createdAt: account.createdAt })));
  const accountsByIdentity = new Map(accountPool.list().map((account) => [JSON.stringify([account.id, account.createdAt]), account]));
  for (const snapshot of operationalState?.snapshot().accounts ?? []) {
    const account = accountsByIdentity.get(JSON.stringify([snapshot.accountId, snapshot.createdAt]));
    if (account?.provider !== 'chatgpt-session') continue;
    modelRegistry.replaceAccountModels(
      { accountId: snapshot.accountId, createdAt: snapshot.createdAt },
      snapshot.discoveredModels,
      account.enabled,
    );
  }
  const backend = options.backend ?? options.backendFactory?.(accountPool, durableState) ?? createChatGptBackend(env, accountPool, durableState);
  const quotaService = new AccountQuotaService({
    accountPool,
    backend,
    operationalState,
    onDiagnostic: (diagnostic) => logger.warn('ChatGPT quota persistence warning', diagnostic),
  });
  const requestLog = new RequestLog();
  const responsesStore = new ResponsesStore();
  const authFlow = options.authFlow ?? new ChatGptAuthFlowService({ oauthRequestTimeoutMs: env.chatGptRequestTimeoutMs, codexClientVersion: env.codexClientVersion });
  const modelRegistryReady = (env.chatGptBackend === 'session'
    ? refreshSessionAccountCatalogs(accountPool, modelRegistry, backend, durableState, operationalState, logger)
    : modelRegistry.refreshFromBackend(backend)).catch(() => {
      // Startup discovery is best effort. Rehydrated per-account catalogs remain
      // available, and provisioning performs its own authoritative discovery.
      logger.warn('ChatGPT startup model discovery failed.');
    });
  const setupProvisioner = new SetupProvisioner({
    accountPool,
    modelRegistry,
    backend,
    runtimeApiKeys,
    durableState,
    operationalState,
    startupReady: modelRegistryReady,
    onDiagnostic: (diagnostic) => logger.warn(diagnostic.severity === 'warning' ? 'ChatGPT setup provisioning warning' : 'ChatGPT setup provisioning failed', diagnostic),
    onAccountCredentialsReplaced: (account) => quotaService.invalidateAccount(account),
  });
  app.onError((_error, c) => { logger.error('Unhandled API error'); return c.json({ type: 'error', error: { type: 'internal_server_error', message: 'Internal server error' } }, 500); });
  app.get('/', (c) => c.redirect('/admin'));
  app.get('/favicon.ico', (c) => c.body(null, 204));
  app.route('/', healthRoute);
  app.use('/v1/*', accessLog(logger, env.accessLogFormat));
  app.use('/v1/*', apiKeyAuth(env.apiKeys, runtimeApiKeys));
  app.route('/', createModelsRoute({ modelRegistry, ready: modelRegistryReady }));
  app.route('/', createCountTokensRoute());
  app.route('/', createMessagesRoute({ backend, requestLog, modelRegistry, accountPool, operationalState, backendProvider: env.chatGptBackend, ready: modelRegistryReady, accountAcquireTimeoutMs: env.accountAcquireTimeoutMs, defaults: { globalReasoningEffort: env.defaultReasoningEffort, globalSpeedPreference: env.defaultResponseSpeed } }));
  app.route('/', createOpenAiChatRoute({ backend, requestLog, modelRegistry, accountPool, operationalState, backendProvider: env.chatGptBackend, ready: modelRegistryReady, accountAcquireTimeoutMs: env.accountAcquireTimeoutMs, defaults: { globalReasoningEffort: env.defaultReasoningEffort, globalSpeedPreference: env.defaultResponseSpeed } }));
  app.route('/', createOpenAiResponsesRoute({ backend, requestLog, modelRegistry, accountPool, responsesStore, operationalState, backendProvider: env.chatGptBackend, ready: modelRegistryReady, accountAcquireTimeoutMs: env.accountAcquireTimeoutMs, defaults: { globalReasoningEffort: env.defaultReasoningEffort, globalSpeedPreference: env.defaultResponseSpeed } }));
  app.route('/', createMetricsRoute(requestLog));
  app.use('/admin/api/*', accessLog(logger, env.accessLogFormat));
  app.use('/admin/api/*', adminApiAuth(env.apiKeys, runtimeApiKeys, { allowAnonymousBootstrap: env.allowAnonymousBootstrap, localAdminSession }));
  app.route('/', createAdminRoute({ accountPool, modelRegistry, backend, ready: modelRegistryReady, runtimeApiKeys, durableState, operationalState, quotaService, envApiKeys: env.apiKeys, defaultReasoningEffort: env.defaultReasoningEffort, defaultResponseSpeed: env.defaultResponseSpeed, backendProvider: env.chatGptBackend, authFlow, setupProvisioner, localAdminSession }));
  app.dispose = async () => {
    await Promise.all([authFlow.close(), operationalState?.dispose()]);
  };
  return app;
}

async function refreshSessionAccountCatalogs(
  accountPool: AccountPool,
  modelRegistry: ModelRegistry,
  backend: ChatGptBackendClient,
  durableState: DurableRuntimeState | undefined,
  operationalState: AdminOperationalState | undefined,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const accounts = accountPool.snapshot().accounts.filter((account) =>
    account.provider === 'chatgpt-session' && account.enabled && account.status === 'available');
  for (const account of accounts) {
    try {
      const outcome = await refreshAccountModels({ accountPool, modelRegistry, backend, operationalState }, account, (result) => {
        const prepared = modelRegistry.prepareProvisioning(result.models, 'sonnet', chooseBestModel(result.models)?.id, 'bind-if-unbound');
        const commit = () => modelRegistry.commitPreparedProvisioning(prepared, { accountId: account.id, createdAt: account.createdAt }, account.enabled);
        if (Object.keys(prepared.boundAliases).length > 0 && durableState) durableState.transaction(commit);
        else commit();
      });
      if (!outcome.ok || outcome.warning) logger.warn('ChatGPT startup account discovery requires attention.', { accountId: account.id });
    } catch {
      // The transaction owns rollback; a local commit failure must not prevent
      // independent accounts from completing their startup discovery.
      logger.warn('ChatGPT startup account catalog update failed.', { accountId: account.id });
    }
  }
}
