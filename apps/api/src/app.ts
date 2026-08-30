import { Hono } from 'hono';
import { createLogger } from '@chatgpt-to-claude/shared';
import { loadEnv, type AppEnv } from './config/env.js';
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
import { chooseBestModel, PRIMARY_CHATGPT_ACCOUNT_ID } from './services/setup-provisioner.js';

export type Chat2ClaudeApp = Hono & { dispose: () => Promise<void> };

export interface CreateAppOptions {
  authFlow?: ChatGptAuthFlowService;
  runtimeStateStore?: RuntimeStateStore | null;
}

export function createApp(env: AppEnv = loadEnv(), options: CreateAppOptions = {}): Chat2ClaudeApp {
  const app = new Hono() as Chat2ClaudeApp;
  const logger = createLogger(env.logLevel);
  const accountPool = new AccountPool();
  const runtimeApiKeys = new RuntimeApiKeys();
  const runtimeStateStore = options.runtimeStateStore === undefined
    ? env.runtimeStatePath ? new RuntimeStateStore({ path: env.runtimeStatePath, encryptionKey: env.stateEncryptionKey }) : undefined
    : options.runtimeStateStore ?? undefined;
  const durableState = runtimeStateStore ? new DurableRuntimeState({ accountPool, runtimeApiKeys, store: runtimeStateStore }) : undefined;
  durableState?.hydrate();
  const backend = createChatGptBackend(env, accountPool, durableState);
  const requestLog = new RequestLog();
  const modelRegistry = new ModelRegistry();
  const responsesStore = new ResponsesStore();
  const authFlow = options.authFlow ?? new ChatGptAuthFlowService({ oauthRequestTimeoutMs: env.chatGptRequestTimeoutMs });
  const restoredPrimaryAccount = accountPool.get(PRIMARY_CHATGPT_ACCOUNT_ID);
  const modelRegistryReady = restoredPrimaryAccount?.provider === 'chatgpt-session'
    ? backend.listModels({ account: restoredPrimaryAccount }).then((models) => {
      const prepared = modelRegistry.prepareProvisioning(models, 'sonnet', chooseBestModel(models)?.id);
      modelRegistry.commitPreparedProvisioning(prepared);
    })
    : modelRegistry.refreshFromBackend(backend);
  app.onError((error, c) => { logger.error('Unhandled API error', { error: error.message }); return c.json({ type: 'error', error: { type: 'internal_server_error', message: 'Internal server error' } }, 500); });
  app.get('/', (c) => c.redirect('/admin'));
  app.get('/favicon.ico', (c) => c.body(null, 204));
  app.route('/', healthRoute);
  app.use('/v1/*', apiKeyAuth(env.apiKeys, runtimeApiKeys));
  app.route('/', createModelsRoute({ modelRegistry, ready: modelRegistryReady }));
  app.route('/', createCountTokensRoute());
  app.route('/', createMessagesRoute({ backend, requestLog, modelRegistry, accountPool, backendProvider: env.chatGptBackend, ready: modelRegistryReady, defaults: { globalReasoningEffort: env.defaultReasoningEffort, globalSpeedPreference: env.defaultResponseSpeed } }));
  app.route('/', createOpenAiChatRoute({ backend, requestLog, modelRegistry, accountPool, backendProvider: env.chatGptBackend, ready: modelRegistryReady, defaults: { globalReasoningEffort: env.defaultReasoningEffort, globalSpeedPreference: env.defaultResponseSpeed } }));
  app.route('/', createOpenAiResponsesRoute({ backend, requestLog, modelRegistry, accountPool, responsesStore, backendProvider: env.chatGptBackend, ready: modelRegistryReady, defaults: { globalReasoningEffort: env.defaultReasoningEffort, globalSpeedPreference: env.defaultResponseSpeed } }));
  app.route('/', createMetricsRoute(requestLog));
  app.use('/admin/api/*', adminApiAuth(env.apiKeys, runtimeApiKeys, { allowAnonymousBootstrap: env.allowAnonymousBootstrap }));
  app.route('/', createAdminRoute({ accountPool, modelRegistry, backend, ready: modelRegistryReady, runtimeApiKeys, durableState, envApiKeys: env.apiKeys, defaultReasoningEffort: env.defaultReasoningEffort, defaultResponseSpeed: env.defaultResponseSpeed, backendProvider: env.chatGptBackend, authFlow }));
  app.dispose = () => authFlow.close();
  return app;
}
