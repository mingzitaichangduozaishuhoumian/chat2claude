import { Hono } from 'hono';
import type { ChatGptBackendClient, ChatGptDiscoveredModel, ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';
import type { ReasoningEffort, SpeedPreference } from '@chatgpt-to-claude/protocol-mapper';
import type { ChatGptBackendProvider } from '../config/env.js';
import type { AccountPool } from '../services/account-pool.js';
import type { ModelRegistry } from '../services/model-registry.js';
import { DEV_API_KEY_PREFIX, type RuntimeApiKeys } from '../services/runtime-api-keys.js';
import { ChatGptAuthFlowService } from '../services/chatgpt-auth-flow.js';
import { ChatGptProvisioningError, SetupProvisioner, type ProvisionResult, type ProvisioningTarget } from '../services/setup-provisioner.js';
import type { DurableRuntimeState } from '../services/durable-runtime-state.js';
import { accountDiscoveryContext } from '../services/refresh-aware-backend.js';
import type { AdminOperationalState } from '../services/admin-operational-state.js';
import type { LocalAdminSession } from '../services/local-admin-session.js';
import { AccountQuotaNotFoundError, AccountQuotaService, type AccountQuotaResult } from '../services/account-quota-service.js';
import { renderAdminPage } from './admin-page.js';

export interface AdminRouteOptions {
  accountPool: AccountPool;
  modelRegistry: ModelRegistry;
  backend: ChatGptBackendClient;
  ready?: Promise<unknown>;
  runtimeApiKeys: RuntimeApiKeys;
  durableState?: DurableRuntimeState;
  operationalState?: AdminOperationalState;
  envApiKeys: string[];
  defaultReasoningEffort: ReasoningEffort;
  defaultResponseSpeed: SpeedPreference;
  backendProvider: ChatGptBackendProvider;
  authFlow?: ChatGptAuthFlowService;
  setupProvisioner?: SetupProvisioner;
  localAdminSession?: LocalAdminSession;
  quotaService?: AccountQuotaService;
}

export function createAdminRoute(options: AdminRouteOptions): Hono {
  const app = new Hono();
  const authFlow = options.authFlow ?? new ChatGptAuthFlowService();
  const quotaService = options.quotaService ?? new AccountQuotaService({
    accountPool: options.accountPool,
    backend: options.backend,
    operationalState: options.operationalState,
  });
  const provisioner = options.setupProvisioner ?? new SetupProvisioner({
    ...options,
    onAccountCredentialsReplaced: (account) => quotaService.invalidateAccount(account),
  });

  app.get('/admin', (c) => {
    const cookie = options.localAdminSession?.issueCookie(c.req.header('host') ?? new URL(c.req.url).host, c.req.url);
    if (cookie) c.header('set-cookie', cookie);
    return c.html(renderAdminPage(status(options)));
  });
  app.get('/admin/api/setup/status', (c) => c.json(status(options)));
  app.get('/admin/api/auth/status', (c) => c.json(authStatus(options)));

  app.post('/admin/api/api-keys/dev-enable', (c) => {
    if (process.env.NODE_ENV === 'production') {
      return c.json({
        type: 'error',
        error: { type: 'permission_error', message: 'Development API key initialization is disabled in production.' },
      }, 403);
    }
    const createKey = () => options.runtimeApiKeys.create(DEV_API_KEY_PREFIX);
    const key = options.durableState ? options.durableState.transaction(createKey) : createKey();
    return c.json({
      ok: true,
      message: 'Development API key enabled. Use the returned key for /v1/*.',
      key,
      status: status(options),
    });
  });

  app.post('/admin/api/auth/chatgpt/start', async (c) => {
    try {
      const input = await readJson(c.req);
      const target = validateProvisioningTarget(options.accountPool, input, 'add');
      return c.json(await authFlow.start({ ...target, returnOrigin: validateAdminReturnOrigin(c.req.raw, input.adminOrigin) }), 201);
    } catch (error) {
      const failure = adminFailure(error, 'Invalid OAuth account intent');
      return c.json({ error: failure.message }, failure.status);
    }
  });
  app.post('/admin/api/auth/chatgpt/callback', async (c) => {
    try {
      const snapshot = await authFlow.completeCallback(await readJson(c.req));
      return snapshot ? c.json(snapshot) : c.json({ error: 'Auth flow not found for callback state' }, 404);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid OAuth callback' }, 400);
    }
  });
  app.get('/admin/api/auth/chatgpt/:id', async (c) => {
    const id = c.req.param('id');
    const snapshot = await authFlow.status(id);
    if (!snapshot) return c.json({ error: 'Auth flow not found' }, 404);
    if (snapshot.state !== 'ready' || snapshot.provisioned) return c.json(snapshot);
    const provisioned = await authFlow.provision(id, async (secret, target, signal, commitBoundary) => sanitizeProvisionResult(await provisioner.provisionTarget(target, secret, signal, commitBoundary)));
    if (!provisioned) return c.json({ error: 'Auth flow not found' }, 404);
    return c.json(provisioned, provisioned.state === 'error' ? normalizeHttpStatus(provisioned.errorStatus, 502) : 200);
  });
  app.post('/admin/api/auth/chatgpt/:id/cancel', async (c) => {
    const snapshot = await authFlow.cancel(c.req.param('id'));
    return snapshot ? c.json(snapshot) : c.json({ error: 'Auth flow not found' }, 404);
  });
  app.post('/admin/api/auth/chatgpt/complete', async (c) => {
    try {
      const input = await readJson(c.req);
      const secret = normalizeManualSecret(input);
      if (!secret.accessToken) return c.json({ error: 'accessToken is required' }, 400);
      const result = input.mode === undefined
        ? await provisioner.provision(secret)
        : await provisioner.provisionTarget(validateProvisioningTarget(options.accountPool, input), secret);
      return c.json(sanitizeProvisionResult(result));
    } catch (error) {
      const failure = adminFailure(error, 'Invalid ChatGPT session');
      return c.json({ error: failure.message }, failure.status);
    }
  });

  app.get('/admin/api/quotas', (c) => c.json({ quotas: quotaService.getAll() }));
  app.post('/admin/api/quotas/refresh', async (c) => {
    const quotas = await quotaService.refreshAll();
    return c.json({ quotas, summary: quotaSummary(quotas) });
  });
  app.post('/admin/api/quotas/:accountId/refresh', async (c) => {
    try {
      return c.json({ quota: await quotaService.refreshAccount(c.req.param('accountId')) });
    } catch (error) {
      if (error instanceof AccountQuotaNotFoundError) return c.json({ error: 'Account not found' }, 404);
      throw error;
    }
  });

  app.get('/admin/api/accounts', (c) => c.json({ accounts: accountsWithRequestStats(options) }));
  app.get('/admin/api/api-keys', (c) => c.json({ apiKeys: options.runtimeApiKeys.listSafe() }));
  app.delete('/admin/api/api-keys/:id', (c) => {
    const revoke = () => options.runtimeApiKeys.revoke(c.req.param('id'));
    const apiKey = options.durableState ? options.durableState.transaction(revoke) : revoke();
    return apiKey ? c.json({ ok: true, apiKey }) : c.json({ error: 'Runtime API key not found' }, 404);
  });
  app.post('/admin/api/accounts', async (c) => {
    try {
      const input = validateMockAccountCreate(await readJson(c.req));
      const addAccount = () => options.accountPool.add(input);
      const account = options.durableState ? options.durableState.transaction(addAccount) : addAccount();
      return c.json({ account }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid account' }, 400);
    }
  });
  app.patch('/admin/api/accounts/:id', async (c) => {
    const id = c.req.param('id');
    if (!options.accountPool.get(id)) return c.json({ error: 'Account not found' }, 404);
    try {
      const patch = accountAdminPatch(await readJson(c.req));
      const existing = options.accountPool.get(id)!;
      const updateAccount = () => {
        const account = options.accountPool.update(id, patch);
        if (account && existing.provider === 'chatgpt-session') {
          options.modelRegistry.setAccountActive({ accountId: existing.id, createdAt: existing.createdAt }, account.enabled);
        }
        return account;
      };
      const account = options.durableState ? options.durableState.transaction(updateAccount) : updateAccount();
      return c.json({ account });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid account patch' }, 400);
    }
  });
  app.delete('/admin/api/accounts/:id', (c) => {
    const id = c.req.param('id');
    const existing = options.accountPool.get(id);
    if (!existing) return c.json({ error: 'Account not found' }, 404);
    if (existing.currentConcurrency > 0) return c.json({ error: 'Account has active requests and cannot be deleted' }, 409);
    const removeAccount = () => {
      const account = options.accountPool.remove(id);
      if (account && existing.provider === 'chatgpt-session') {
        options.modelRegistry.removeAccountModels({ accountId: existing.id, createdAt: existing.createdAt });
      }
      return account;
    };
    const account = options.durableState ? options.durableState.transaction(removeAccount) : removeAccount();
    quotaService.removeAccount(existing);
    let operationalWarning: string | undefined;
    try {
      options.operationalState?.removeAccount({ accountId: existing.id, createdAt: existing.createdAt });
    } catch {
      operationalWarning = 'Account credentials were deleted, but admin operational metadata cleanup could not be persisted.';
    }
    return c.json({ ok: true, account, ...(operationalWarning ? { warning: operationalWarning } : {}) });
  });
  app.post('/admin/api/accounts/:id/health-check', async (c) => {
    const id = c.req.param('id');
    const internalAccount = options.accountPool.get(id);
    if (!internalAccount) return c.json({ error: 'Account not found' }, 404);
    if (!options.backend.healthCheck) {
      const healthCheck = () => options.accountPool.healthCheck(id);
      const account = options.durableState ? options.durableState.transaction(healthCheck) : healthCheck();
      return account ? c.json({ ok: true, account }) : c.json({ error: 'Account not found' }, 404);
    }
    const discovery = internalAccount.provider === 'chatgpt-session'
      ? options.accountPool.beginDiscovery(internalAccount, true)
      : undefined;
    if (internalAccount.provider === 'chatgpt-session' && !discovery) return c.json({ error: 'Account changed before health check started' }, 409);
    try {
      let discovered: ChatGptDiscoveredModel[] | undefined;
      const result = internalAccount.provider === 'chatgpt-session'
        ? await options.backend.listModels(accountDiscoveryContext(internalAccount, discovery!.id)).then((models) => {
          discovered = models;
          return { ok: true as const, message: undefined };
        })
        : await options.backend.healthCheck({ account: internalAccount });
      const updateHealth = () => {
        const current = discovery
          ? options.accountPool.isCurrentDiscovery(discovery)
          : options.accountPool.isCurrentHealth(internalAccount);
        if (!current) return undefined;
        const account = result.ok
          ? options.accountPool.markHealthy(id, internalAccount.incarnation)
          : options.accountPool.markError(id, result.message ?? 'Health check failed', internalAccount.incarnation);
        if (account && discovered) {
          options.modelRegistry.replaceAccountModels(
            { accountId: internalAccount.id, createdAt: internalAccount.createdAt },
            discovered,
            account.enabled,
          );
        }
        return account;
      };
      const account = options.durableState ? options.durableState.transaction(updateHealth) : updateHealth();
      const view = discovered ? options.modelRegistry.adminView() : undefined;
      let operationalWarning: string | undefined;
      try {
        if (result.ok && account && discovered) {
          options.operationalState?.recordProvisioningSuccess(
            { accountId: internalAccount.id, createdAt: internalAccount.createdAt },
            discovered,
            { checkedAt: new Date().toISOString(), result: 'healthy', message: null },
          );
        } else if (account) {
          options.operationalState?.setHealthCheck(
            { accountId: internalAccount.id, createdAt: internalAccount.createdAt },
            { checkedAt: new Date().toISOString(), result: 'unhealthy', message: result.message ?? 'Health check failed' },
          );
        }
      } catch {
        operationalWarning = 'Health result was applied, but admin operational metadata could not be updated.';
      }
      return c.json({ ok: result.ok, message: result.message, account, view, ...(operationalWarning ? { warning: operationalWarning } : {}) });
    } catch (error) {
      const markError = () => {
        const current = discovery
          ? options.accountPool.isCurrentDiscovery(discovery)
          : options.accountPool.isCurrentHealth(internalAccount);
        return current ? options.accountPool.markError(id, error, internalAccount.incarnation) : undefined;
      };
      const account = options.durableState ? options.durableState.transaction(markError) : markError();
      let operationalWarning: string | undefined;
      try {
        if (account) {
          options.operationalState?.setHealthCheck(
            { accountId: internalAccount.id, createdAt: internalAccount.createdAt },
            { checkedAt: new Date().toISOString(), result: 'unhealthy', message: 'Health check request failed.' },
          );
        }
      } catch {
        operationalWarning = 'Health failure was applied, but admin operational metadata could not be updated.';
      }
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error), account, ...(operationalWarning ? { warning: operationalWarning } : {}) }, 502);
    } finally {
      if (discovery) options.accountPool.endDiscovery(discovery);
    }
  });

  app.get('/admin/api/models', async (c) => {
    if (options.ready) await options.ready;
    return c.json(options.modelRegistry.adminView());
  });
  app.post('/admin/api/models', async (c) => {
    if (options.ready) await options.ready;
    try {
      const input = await readJson(c.req);
      const create = () => options.modelRegistry.create(input);
      const model = options.durableState ? options.durableState.transaction(create) : create();
      return c.json({ model, view: options.modelRegistry.adminView() }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid model alias' }, 400);
    }
  });
  app.patch('/admin/api/models/:id', async (c) => {
    if (options.ready) await options.ready;
    const patch = await readJson(c.req);
    const update = () => options.modelRegistry.update(c.req.param('id'), patch);
    const model = options.durableState ? options.durableState.transaction(update) : update();
    return model ? c.json({ model, view: options.modelRegistry.adminView() }) : c.json({ error: 'Model alias not found' }, 404);
  });
  app.delete('/admin/api/models/:id', async (c) => {
    if (options.ready) await options.ready;
    try {
      const remove = () => options.modelRegistry.remove(c.req.param('id'));
      const model = options.durableState ? options.durableState.transaction(remove) : remove();
      return model ? c.json({ ok: true, model, view: options.modelRegistry.adminView() }) : c.json({ error: 'Model alias not found' }, 404);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid model alias deletion' }, 400);
    }
  });
  app.post('/admin/api/models/reset', async (c) => {
    if (options.ready) await options.ready;
    const reset = () => options.modelRegistry.reset();
    const models = options.durableState ? options.durableState.transaction(reset) : reset();
    return c.json({ models, view: options.modelRegistry.adminView() });
  });
  app.post('/admin/api/models/refresh', async (c) => {
    if (options.ready) await options.ready;
    if (options.backendProvider !== 'session') return c.json(await options.modelRegistry.refreshFromBackend(options.backend));
    const accounts = options.accountPool.snapshot().accounts.filter((account) =>
      account.provider === 'chatgpt-session' && account.enabled && account.status === 'available');
    if (accounts.length === 0) return c.json({ error: 'No available chatgpt-session account. Import and health-check a ChatGPT session account before refreshing models.' }, 409);
    const refreshedAccounts: Array<{ accountId: string; ok: boolean; models?: string[]; error?: string }> = [];
    for (const account of accounts) {
      const discovery = options.accountPool.beginDiscovery(account);
      if (!discovery) {
        refreshedAccounts.push({ accountId: account.id, ok: false, error: 'Account changed before model discovery started.' });
        continue;
      }
      try {
        const models = await options.backend.listModels(accountDiscoveryContext(account, discovery.id));
        if (!options.accountPool.isCurrentDiscovery(discovery)) {
          refreshedAccounts.push({ accountId: account.id, ok: false, error: 'Account changed while model discovery was in progress.' });
          continue;
        }
        options.modelRegistry.replaceAccountModels({ accountId: account.id, createdAt: account.createdAt }, models, account.enabled);
        try {
          options.operationalState?.recordProvisioningSuccess(
            { accountId: account.id, createdAt: account.createdAt },
            models,
            { checkedAt: new Date().toISOString(), result: 'healthy', message: null },
          );
        } catch { /* discovery remains valid in memory; persistence warning is reported below */ }
        refreshedAccounts.push({ accountId: account.id, ok: true, models: models.map((model) => model.id) });
      } catch {
        refreshedAccounts.push({ accountId: account.id, ok: false, error: 'Model discovery failed.' });
      } finally {
        options.accountPool.endDiscovery(discovery);
      }
    }
    return c.json({ ...options.modelRegistry.adminView(), refreshedAccounts });
  });
  return app;
}

function accountsWithRequestStats(options: AdminRouteOptions) {
  const operations = new Map((options.operationalState?.snapshot().accounts ?? []).map((account) => [JSON.stringify([account.accountId, account.createdAt]), account]));
  return options.accountPool.list().map((account) => {
    const operational = operations.get(JSON.stringify([account.id, account.createdAt]));
    const discoveredModels = operational?.discoveredModels ?? [];
    return {
      ...account,
      requestStats: operational?.requestStats ?? {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        cancelledRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        lastRequestAt: null,
        inFlight: 0,
      },
      modelCount: discoveredModels.length,
      discoveredModels: discoveredModels.map((model) => ({ id: model.id, ...(model.displayName ? { displayName: model.displayName } : {}) })),
    };
  });
}

function quotaSummary(quotas: AccountQuotaResult[]): { total: number; fresh: number; stale: number; error: number; unknown: number } {
  return {
    total: quotas.length,
    fresh: quotas.filter((quota) => quota.status === 'fresh').length,
    stale: quotas.filter((quota) => quota.status === 'stale').length,
    error: quotas.filter((quota) => quota.status === 'error').length,
    unknown: quotas.filter((quota) => quota.status === 'unknown').length,
  };
}

class AdminRequestError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = 'AdminRequestError';
  }
}

function validateProvisioningTarget(accountPool: AccountPool, input: Record<string, unknown>, defaultMode?: 'add'): ProvisioningTarget {
  const mode = input.mode ?? defaultMode;
  const accountId = typeof input.accountId === 'string' && input.accountId.trim() ? input.accountId.trim() : undefined;
  if (mode === 'add') {
    if (accountId) throw new AdminRequestError('OAuth add mode must not include accountId.', 400);
    return { mode: 'add' };
  }
  if (mode !== 'reauthorize') throw new AdminRequestError('OAuth mode must be add or reauthorize.', 400);
  if (!accountId) throw new AdminRequestError('OAuth reauthorize mode requires accountId.', 400);
  const account = accountPool.get(accountId);
  if (!account) throw new AdminRequestError('Reauthorization account not found.', 404);
  if (account.provider !== 'chatgpt-session') throw new AdminRequestError('Reauthorization target must be a chatgpt-session account.', 409);
  return { mode: 'reauthorize', accountId };
}

function adminFailure(error: unknown, fallback: string): { message: string; status: 400 | 404 | 409 | 500 | 502 } {
  if (error instanceof AdminRequestError) return { message: error.message, status: error.status };
  if (error instanceof ChatGptProvisioningError) return { message: error.message, status: normalizeHttpStatus(error.diagnostic.status, 400) };
  return { message: error instanceof Error ? error.message : fallback, status: 400 };
}

function normalizeHttpStatus(status: number | undefined, fallback: 400 | 502): 400 | 404 | 409 | 500 | 502 {
  return status === 400 || status === 404 || status === 409 || status === 500 || status === 502 ? status : fallback;
}

function validateAdminReturnOrigin(request: Request, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('adminOrigin must be an exact HTTP(S) origin.');
  const requested = parseExactHttpOrigin(value, 'adminOrigin');
  const requestOrigin = parseExactHttpOrigin(new URL(request.url).origin, 'request origin');
  const headerOrigin = request.headers.get('origin');
  if (headerOrigin && parseExactHttpOrigin(headerOrigin, 'Origin') !== requestOrigin) {
    throw new Error('Origin does not match the request host.');
  }
  if (requested !== requestOrigin || (headerOrigin && requested !== headerOrigin)) {
    throw new Error('adminOrigin must match the request Host and Origin exactly.');
  }
  return requested;
}

function parseExactHttpOrigin(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an exact HTTP(S) origin.`); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash || value !== url.origin) {
    throw new Error(`${label} must be an exact HTTP(S) origin without path, query, hash, or userinfo.`);
  }
  return url.origin;
}

function validateMockAccountCreate(input: Record<string, unknown>): Record<string, unknown> {
  if (input.provider !== undefined && input.provider !== 'mock') {
    throw new Error('Session accounts must be added through ChatGPT authorization or manual provisioning.');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'secret')) {
    throw new Error('Generic mock account creation does not accept session secrets.');
  }
  return { ...input, provider: 'mock' };
}

function accountAdminPatch(input: Record<string, unknown>): { label?: unknown; enabled?: unknown; maxConcurrency?: unknown } {
  const allowed = ['label', 'enabled', 'maxConcurrency'] as const;
  const unknown = Object.keys(input).filter((field) => !allowed.includes(field as typeof allowed[number]));
  if (unknown.length > 0) throw new Error(`Account patch contains unsupported fields: ${unknown.join(', ')}`);
  return {
    ...(Object.prototype.hasOwnProperty.call(input, 'label') ? { label: input.label } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'enabled') ? { enabled: input.enabled } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'maxConcurrency') ? { maxConcurrency: input.maxConcurrency } : {}),
  };
}

async function readJson(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function status(options: AdminRouteOptions) {
  const envApiKeysConfigured = options.envApiKeys.length > 0;
  const runtimeApiKeysConfigured = options.runtimeApiKeys.size > 0;
  const sessionAccounts = options.accountPool.list().filter((account) => account.provider === 'chatgpt-session' && account.hasSecret);
  const sonnet = options.modelRegistry.get('sonnet');
  return {
    apiKeysConfigured: envApiKeysConfigured || runtimeApiKeysConfigured,
    envApiKeysConfigured,
    runtimeApiKeysConfigured,
    runtimeApiKeysCount: options.runtimeApiKeys.size,
    defaultReasoningEffort: options.defaultReasoningEffort,
    defaultResponseSpeed: options.defaultResponseSpeed,
    backend: { enabled: true, provider: options.backendProvider, chatGptConnected: sessionAccounts.length > 0 },
    chatGptReady: sessionAccounts.length > 0 && Boolean(sonnet?.backendModel) && (envApiKeysConfigured || runtimeApiKeysConfigured),
    defaultEndpoint: 'POST /v1/messages',
    nextStep: sessionAccounts.length > 0
      ? 'ChatGPT session 已导入。请复制 API 配置调用 /v1/messages。'
      : '打开 /admin 点击“浏览器授权（Codex OAuth）”，新标签页会直接打开授权页；若被拦截可点击链接或复制 URL，完成后系统会自动初始化账号、模型和 API Key。',
  };
}

function authStatus(options: AdminRouteOptions) {
  const setup = status(options);
  return {
    ready: setup.chatGptReady,
    accountReady: setup.backend.chatGptConnected,
    apiKeysConfigured: setup.apiKeysConfigured,
    backendProvider: setup.backend.provider,
    sonnet: options.modelRegistry.get('sonnet'),
  };
}

function normalizeManualSecret(value: Record<string, unknown>): ChatGptSessionSecret {
  const raw = value.secret && typeof value.secret === 'object' && !Array.isArray(value.secret) ? value.secret as Record<string, unknown> : value;
  return {
    type: 'chatgpt-session',
    accessToken: typeof raw.accessToken === 'string' ? raw.accessToken.trim() : undefined,
    refreshToken: typeof raw.refreshToken === 'string' && raw.refreshToken.trim() ? raw.refreshToken.trim() : undefined,
    idToken: typeof raw.idToken === 'string' && raw.idToken.trim() ? raw.idToken.trim() : undefined,
    expiresAt: typeof raw.expiresAt === 'string' && raw.expiresAt.trim() ? raw.expiresAt.trim() : undefined,
    email: typeof raw.email === 'string' && raw.email.trim() ? raw.email.trim() : undefined,
    accountId: typeof raw.accountId === 'string' && raw.accountId.trim() ? raw.accountId.trim() : undefined,
    planType: typeof raw.planType === 'string' && raw.planType.trim() ? raw.planType.trim() : undefined,
    cookie: typeof raw.cookie === 'string' && raw.cookie.trim() ? raw.cookie.trim() : undefined,
    deviceId: typeof raw.deviceId === 'string' && raw.deviceId.trim() ? raw.deviceId.trim() : undefined,
    userAgent: typeof raw.userAgent === 'string' && raw.userAgent.trim() ? raw.userAgent.trim() : undefined,
  };
}

function sanitizeProvisionResult(result: ProvisionResult) {
  return {
    ok: result.ok,
    runtimeKeyCreated: result.runtimeKeyCreated,
    ...(result.apiKey ? { apiKey: result.apiKey } : {}),
    account: result.account,
    modelsDiscovered: result.modelsDiscovered,
    boundAliases: result.boundAliases,
  };
}
