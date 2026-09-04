import { Hono } from 'hono';
import type { ChatGptBackendClient, ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';
import type { ReasoningEffort, SpeedPreference } from '@chatgpt-to-claude/protocol-mapper';
import type { ChatGptBackendProvider } from '../config/env.js';
import type { AccountPool } from '../services/account-pool.js';
import type { ModelRegistry } from '../services/model-registry.js';
import { DEV_API_KEY_PREFIX, type RuntimeApiKeys } from '../services/runtime-api-keys.js';
import { ChatGptAuthFlowService } from '../services/chatgpt-auth-flow.js';
import { SetupProvisioner, type ProvisionResult } from '../services/setup-provisioner.js';
import type { DurableRuntimeState } from '../services/durable-runtime-state.js';
import type { LocalAdminSession } from '../services/local-admin-session.js';

export interface AdminRouteOptions {
  accountPool: AccountPool;
  modelRegistry: ModelRegistry;
  backend: ChatGptBackendClient;
  ready?: Promise<unknown>;
  runtimeApiKeys: RuntimeApiKeys;
  durableState?: DurableRuntimeState;
  envApiKeys: string[];
  defaultReasoningEffort: ReasoningEffort;
  defaultResponseSpeed: SpeedPreference;
  backendProvider: ChatGptBackendProvider;
  authFlow?: ChatGptAuthFlowService;
  setupProvisioner?: SetupProvisioner;
  localAdminSession?: LocalAdminSession;
}

export function createAdminRoute(options: AdminRouteOptions): Hono {
  const app = new Hono();
  const authFlow = options.authFlow ?? new ChatGptAuthFlowService();
  const provisioner = options.setupProvisioner ?? new SetupProvisioner(options);

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
      return c.json(await authFlow.start({ returnOrigin: validateAdminReturnOrigin(c.req.raw, input.adminOrigin) }), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid admin origin' }, 400);
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
    const provisioned = await authFlow.provision(id, async (secret, signal, commitBoundary) => sanitizeProvisionResult(await provisioner.provision(secret, signal, commitBoundary)));
    if (!provisioned) return c.json({ error: 'Auth flow not found' }, 404);
    return c.json(provisioned, provisioned.state === 'error' ? 502 : 200);
  });
  app.post('/admin/api/auth/chatgpt/:id/cancel', async (c) => {
    const snapshot = await authFlow.cancel(c.req.param('id'));
    return snapshot ? c.json(snapshot) : c.json({ error: 'Auth flow not found' }, 404);
  });
  app.post('/admin/api/auth/chatgpt/complete', async (c) => {
    try {
      const secret = normalizeManualSecret(await readJson(c.req));
      if (!secret.accessToken) return c.json({ error: 'accessToken is required' }, 400);
      const result = await provisioner.provision(secret);
      return c.json(sanitizeProvisionResult(result));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid ChatGPT session' }, 400);
    }
  });

  app.get('/admin/api/accounts', (c) => c.json({ accounts: options.accountPool.list() }));
  app.get('/admin/api/api-keys', (c) => c.json({ apiKeys: options.runtimeApiKeys.listSafe() }));
  app.delete('/admin/api/api-keys/:id', (c) => {
    const revoke = () => options.runtimeApiKeys.revoke(c.req.param('id'));
    const apiKey = options.durableState ? options.durableState.transaction(revoke) : revoke();
    return apiKey ? c.json({ ok: true, apiKey }) : c.json({ error: 'Runtime API key not found' }, 404);
  });
  app.post('/admin/api/accounts', async (c) => {
    try {
      const input = await readJson(c.req);
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
      const updateAccount = () => options.accountPool.update(id, patch);
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
    const removeAccount = () => options.accountPool.remove(id);
    const account = options.durableState ? options.durableState.transaction(removeAccount) : removeAccount();
    return c.json({ ok: true, account });
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
    try {
      const result = await options.backend.healthCheck({ account: internalAccount });
      const updateHealth = () => result.ok ? options.accountPool.markHealthy(id, internalAccount.incarnation) : options.accountPool.markError(id, result.message ?? 'Health check failed', internalAccount.incarnation);
      const account = options.durableState ? options.durableState.transaction(updateHealth) : updateHealth();
      const view = result.ok && account && internalAccount.provider === 'chatgpt-session'
        ? await options.modelRegistry.refreshFromBackend(options.backend, { account: internalAccount })
        : undefined;
      return c.json({ ok: result.ok, message: result.message, account, view });
    } catch (error) {
      const markError = () => options.accountPool.markError(id, error, internalAccount.incarnation);
      const account = options.durableState ? options.durableState.transaction(markError) : markError();
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error), account }, 502);
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
    const context = options.backendProvider === 'session' ? sessionRefreshContext(options.accountPool) : undefined;
    if (options.backendProvider === 'session' && !context) return c.json({ error: 'No available chatgpt-session account. Import and health-check a ChatGPT session account before refreshing models.' }, 409);
    return c.json(await options.modelRegistry.refreshFromBackend(options.backend, context));
  });
  return app;
}

function sessionRefreshContext(accountPool: AccountPool) {
  const account = accountPool.firstAvailable({ provider: 'chatgpt-session' });
  return account ? { account } : undefined;
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
    apiKey: result.apiKey,
    account: result.account,
    modelsDiscovered: result.modelsDiscovered,
    boundAliases: result.boundAliases,
  };
}

function renderAdminPage(setupStatus: ReturnType<typeof status>): string {
  const keyState = setupStatus.apiKeysConfigured ? '已配置' : '待初始化';
  const keyTone = setupStatus.apiKeysConfigured ? 'ok' : 'warn';
  const curlTemplate = `curl __ORIGIN__/v1/messages \\
  -H 'content-type: application/json' \\
  -H 'x-api-key: <your-api-key>' \\
  -d '{"model":"sonnet","max_tokens":128,"messages":[{"role":"user","content":"你好"}]}'`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>chat2claude 个人自托管控制台</title>
  <style>
    :root { --ink:#07100f; --panel:rgba(12,24,24,.88); --line:rgba(126,154,146,.24); --text:#e6eee9; --muted:#8fa29b; --gold:#e6b451; --cyan:#42d6c6; --danger:#ff7d64; color-scheme:dark; }
    *{box-sizing:border-box} body{margin:0;min-height:100vh;color:var(--text);font-family:"Microsoft YaHei UI",system-ui,sans-serif;background:radial-gradient(circle at 20% -10%,rgba(230,180,81,.2),transparent 34rem),radial-gradient(circle at 78% 12%,rgba(66,214,198,.16),transparent 30rem),linear-gradient(90deg,#050908,#0a1413 45%,#080d0c)}
    main{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:32px 0 56px}.shell{border:1px solid var(--line);border-radius:28px;background:linear-gradient(180deg,rgba(13,25,24,.9),rgba(8,14,14,.94));box-shadow:0 24px 90px rgba(0,0,0,.42);overflow:hidden}.hero{padding:34px clamp(22px,4vw,42px) 28px;border-bottom:1px solid var(--line);background:linear-gradient(120deg,rgba(230,180,81,.13),transparent 40%),linear-gradient(270deg,rgba(66,214,198,.11),transparent 36%)}
    h1{margin:0 0 12px;font-size:clamp(32px,6vw,64px);line-height:.98;letter-spacing:-.06em}.hero-heading{justify-content:space-between;align-items:end}.hero-heading h1{margin-bottom:0}.mode-toggle{display:flex;gap:6px}.mode-toggle button[aria-pressed="true"]{color:#130f07;border-color:rgba(230,180,81,.44);background:linear-gradient(180deg,#f0c66b,#c8912f)}.hero p{max-width:800px;margin:0;color:#aec0ba;line-height:1.8}.content{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(320px,.92fr);gap:18px;padding:18px}.card{border:1px solid var(--line);border-radius:22px;background:linear-gradient(180deg,rgba(255,255,255,.038),transparent),var(--panel);padding:22px}.card.full{grid-column:1/-1}.muted{color:var(--muted)}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.stack{display:grid;gap:14px}.status{display:inline-flex;gap:8px;padding:7px 12px;border-radius:999px;font-size:13px;font-weight:800;border:1px solid var(--line);background:rgba(255,255,255,.045)}.status.ok{color:var(--cyan);border-color:rgba(66,214,198,.38);background:rgba(66,214,198,.14)}.status.warn{color:var(--gold);border-color:rgba(230,180,81,.38);background:rgba(230,180,81,.16)}
    .steps{display:grid;gap:12px;padding:0;margin:0;list-style:none;counter-reset:step}.steps li{counter-increment:step;display:grid;grid-template-columns:34px 1fr;gap:12px;padding:13px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.035)}.steps li:before{content:counter(step,decimal-leading-zero);display:grid;place-items:center;width:34px;height:34px;border-radius:11px;color:var(--gold);background:rgba(230,180,81,.16);font-size:12px;font-weight:900}.steps strong{display:block;margin-bottom:5px}
    .oauth-actions{display:flex;gap:10px;flex-wrap:wrap;min-width:0}.auth-link-area{display:grid;gap:10px;min-width:0;max-width:100%;margin-top:14px}.auth-link-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;min-width:0}.auth-url-display{display:block;min-width:0;max-width:100%;padding:10px 12px;border:1px solid rgba(66,214,198,.16);border-radius:12px;overflow-wrap:anywhere;word-break:break-word;white-space:normal}.oauth-callback-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;min-width:0;max-width:100%}.oauth-callback-row input{min-width:0;max-width:100%}
    input,select{min-height:40px;border:1px solid rgba(143,162,155,.34);border-radius:12px;padding:9px 11px;color:var(--text);background:rgba(2,8,8,.58);outline:none}button{min-height:40px;border:1px solid rgba(230,180,81,.44);border-radius:12px;padding:9px 14px;color:#130f07;background:linear-gradient(180deg,#f0c66b,#c8912f);font-weight:900;cursor:pointer}button.secondary{color:var(--text);border-color:rgba(66,214,198,.36);background:linear-gradient(180deg,rgba(66,214,198,.2),rgba(66,214,198,.08))}button:disabled{opacity:.58;cursor:not-allowed}.table-wrap{margin-top:16px;border:1px solid var(--line);border-radius:18px;overflow:auto;background:rgba(0,0,0,.18)}table{width:100%;border-collapse:collapse;min-width:760px;font-size:13px}th,td{padding:12px;border-bottom:1px solid rgba(143,162,155,.16);text-align:left}th{color:#bfd0ca;background:rgba(255,255,255,.045);font-size:11px;letter-spacing:.12em;text-transform:uppercase}code,pre{font-family:"Cascadia Code",monospace;border-radius:9px;color:#cdeee9;background:rgba(66,214,198,.1)}code{padding:2px 6px}pre{margin:0;padding:16px;overflow:auto;white-space:pre-wrap;line-height:1.6;border:1px solid rgba(66,214,198,.16)}.empty{margin-top:16px;border:1px dashed rgba(230,180,81,.36);border-radius:18px;padding:18px;color:#c6b48c;background:rgba(230,180,81,.07)}.pill{display:inline-flex;min-height:26px;border:1px solid rgba(66,214,198,.24);border-radius:999px;padding:4px 9px;color:#bfe9e4;background:rgba(66,214,198,.08);font-size:12px}.session-strip{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;margin:14px 0;padding:13px 14px;border:1px solid rgba(66,214,198,.25);border-left:3px solid var(--cyan);border-radius:14px;background:linear-gradient(90deg,rgba(66,214,198,.12),rgba(66,214,198,.025))}.session-strip.warn{border-color:rgba(230,180,81,.34);border-left-color:var(--gold);background:linear-gradient(90deg,rgba(230,180,81,.13),rgba(230,180,81,.025))}.session-strip strong{display:block;margin-bottom:3px;font-size:13px}.session-strip .muted{font-size:13px;line-height:1.55}details{border:1px solid var(--line);border-radius:18px;padding:14px;background:rgba(255,255,255,.025)}summary{cursor:pointer;font-weight:900;color:#bfd0ca}.key-fallback{margin-top:14px}.key-fallback label{display:block;margin-top:9px;font-size:13px}@media(max-width:900px){.content{grid-template-columns:1fr}}@media(max-width:560px){button,input{width:100%}.content{padding:10px}.card{padding:16px}.oauth-callback-row{grid-template-columns:minmax(0,1fr)}.auth-link-row>*{width:100%}}
  </style>
</head>
<body>
  <main><div class="shell">
    <header class="hero"><p class="muted">Personal Self-hosted Console</p><div class="row hero-heading"><h1>chat2claude 个人自托管控制台</h1><div class="mode-toggle" role="group" aria-label="管理界面模式"><button id="mode-simple" class="secondary" type="button" aria-pressed="true">简洁模式</button><button id="mode-professional" class="secondary" type="button" aria-pressed="false">专业模式</button></div></div><p>这是 local-first 的个人开源兼容层。请只授权本人控制或已获明确授权的 ChatGPT/Codex 账号及其包含的用量；不得公开转售个人订阅流量、向不特定第三方重新提供或进行大规模共享。普通使用走“浏览器授权（Codex OAuth）”：点击主按钮会直接打开新授权标签页，后台监听本地 callback；不会启动独立 Chrome/新 profile，也不会从已登录 chatgpt.com 页面抓 session。</p></header>
    <div class="content">
      <section class="card">
        <h2>浏览器授权（Codex OAuth）</h2>
        <p>API Key：<span id="key-state" class="status ${keyTone}">${escapeHtml(keyState)}</span></p>
        <div id="admin-session-state" class="session-strip" role="status" aria-live="polite"><span class="status">检测中</span><div><strong>正在验证本地管理会话</strong><span class="muted">本机可信访问会自动使用 HttpOnly 浏览器会话；不会读取、展示或保存 Admin API Key。</span></div></div>
        <details id="admin-key-fallback" class="key-fallback"><summary>远程访问或自动化：使用显式 Admin API Key</summary><p class="muted">仅在没有本地浏览器会话时使用。Key 默认只保留在当前页面，关闭或刷新后清除；勾选后才会保存到本机浏览器。</p><div class="row"><input id="admin-api-key" type="password" placeholder="Admin API Key" autocomplete="off" /><button id="save-admin-api-key" class="secondary" type="button">仅本页启用 Key</button></div><label class="muted"><input id="remember-admin-api-key" type="checkbox" /> 明确保存到此浏览器（localStorage）</label></details>
        <p class="muted">当前 backend：<code>${escapeHtml(setupStatus.backend.provider)}</code>。不会启动独立 Chrome/新 profile；点击主按钮会直接打开新的授权标签页。</p>
        <div class="oauth-actions"><button id="auth-chatgpt">打开 Codex OAuth 授权页</button><button id="cancel-auth" class="secondary" disabled>取消</button></div>
        <p id="auth-message" class="muted" role="status" aria-live="polite">${escapeHtml(setupStatus.nextStep)}</p>
        <div id="auth-link-area" class="auth-link-area" hidden>
          <div class="auth-link-row"><a id="auth-link" class="pill" target="_blank" rel="noopener noreferrer" hidden>打开 Codex OAuth 授权页</a><button id="copy-auth-link" class="secondary" type="button" hidden>复制授权链接</button></div>
          <code id="auth-url-display" class="auth-url-display" hidden></code>
        </div>
        <div class="stack">
          <p class="muted">如果授权完成后浏览器显示无法连接本地 callback（默认 1455，必要时自动使用 1457），请原样复制地址栏里的完整 URL。后台会严格校验协议、host、端口和路径。</p>
          <div class="oauth-callback-row"><input id="oauth-callback-url" aria-label="OAuth callback URL（请粘贴完整 callback URL）" placeholder="粘贴授权链接对应的完整 localhost callback URL" /><button id="submit-oauth-callback" class="secondary" type="button">提交 callback URL</button></div>
        </div>
      </section>
      <aside class="card"><h2>3 步完成</h2><ol class="steps"><li><div><strong>浏览器授权</strong><span class="muted">点击后在新标签页打开 Codex OAuth；若被拦截可使用链接或复制 fallback。</span></div></li><li><div><strong>自动初始化</strong><span class="muted">服务自动创建 chatgpt-primary、health-check、刷新模型并绑定 sonnet。</span></div></li><li><div><strong>复制 API 配置</strong><span class="muted">ready 后复制 endpoint、key 和 curl 示例。</span></div></li></ol></aside>
      <section class="card full" id="api-config" hidden><h2>API 配置</h2><div class="stack"><p>Endpoint：<code id="endpoint"></code></p><p>新生成的 Runtime API Key（仅本次显示）：<code id="api-key"></code> <button id="copy-runtime-api-key" class="secondary" type="button">复制 Runtime API Key</button></p><p class="muted">请立即复制并保存。之后后台只会显示安全前缀；如遗失，可撤销后重新授权生成新 Key。</p><pre id="ready-curl"></pre></div></section>
      <section class="card full"><details id="advanced-import"><summary>高级：手动导入 accessToken / cookie</summary><p class="muted">OAuth 不可用或已有 session secret 时使用。表单会走同一套 provisioning，不会返回 token/cookie。</p><div class="row"><input id="session-access-token" placeholder="accessToken" /><input id="session-cookie" placeholder="cookie（可选）" /><input id="session-device-id" placeholder="deviceId（可选）" /><input id="session-user-agent" placeholder="userAgent（可选）" /><button id="manual-complete" class="secondary">导入并初始化</button></div></details></section>
      <section class="card full"><h2>内置模型 Alias</h2><p class="muted">Sonnet 会在首次授权时自动选择后端。Haiku、Fable 和 Opus 如显示“未绑定”，需要切换到专业模式选择后端模型后才能调用。</p><div id="model-availability"><div class="empty">正在读取 alias 状态。</div></div></section>
      <section class="card full professional-panel"><h2>个人账号池（高级）</h2><p class="muted">仅用于同一自托管操作者管理本人控制或获授权的账号，并进行故障隔离、冷却、并发控制和本地调度；禁止用于公开转售订阅流量或面向不特定第三方的大规模共享。</p><div class="row"><input id="account-label" placeholder="账号标识" value="Mock ChatGPT Account" /><input id="account-concurrency" type="number" min="1" value="1" aria-label="最大并发" /><button id="add-account" class="secondary">添加 mock 账号</button></div><div id="accounts"><div class="empty">正在读取个人账号池状态。</div></div></section>
      <section class="card full"><h2>Runtime API Keys</h2><p class="muted">这是 Claude Code 等客户端调用 <code>/v1/*</code> 使用的 Key，不是 Admin API Key。当前 <strong id="api-keys-count">0</strong> 个；这里只显示安全前缀，原始 Key 仅会在创建后显示一次。</p><p class="muted">遗失 Key 时，在此撤销旧 Key，再重新授权生成新 Key 并立即复制保存。撤销会要求确认，且对应客户端会立即失去访问权限。</p><div class="row"><button id="refresh-api-keys" class="secondary" type="button">刷新 Key 列表</button></div><div id="api-keys"><div class="empty">正在读取运行时 API Key。</div></div></section>
      <section class="card full professional-panel"><h2>模型映射（高级管理）</h2><p class="muted">后端模型来自 discovery；alias overlay 负责映射、启用状态与缺省 reasoning_effort / response_speed。</p><div class="row"><button id="reset-models" class="secondary">重置 alias overlay</button><button id="refresh-models" class="secondary">刷新 backend discovery</button></div><form id="create-model-form" class="row"><input id="model-alias-id" required pattern="[a-zA-Z0-9._-]+" placeholder="新 alias，例如 research" aria-label="新模型 alias" /><input id="model-display-name" placeholder="显示名称（可选）" aria-label="模型显示名称" /><select id="model-backend" aria-label="Backend model"><option value="">未绑定（可选）</option></select><button type="submit">创建自定义 alias</button></form><div id="models"><div class="empty">正在加载模型映射。</div></div></section>
      <section class="card"><h2>结果面板</h2><pre id="result" role="status" aria-live="polite">${escapeHtml(setupStatus.nextStep)}</pre></section>
      <section class="card"><h2>curl 示例</h2><p class="muted">示例地址由当前页面 origin 生成。</p><pre id="curl-example" data-template="${escapeHtml(curlTemplate)}">${escapeHtml(curlTemplate)}</pre></section>
    </div>
  </div></main>
  <script>
    let currentFlowId = null;
    let pollTimer = null;
    const curlExample = document.getElementById('curl-example');
    curlExample.textContent = curlExample.dataset.template.replace('__ORIGIN__', window.location.origin);
    const adminKeyInput = document.getElementById('admin-api-key');
    const rememberAdminKeyInput = document.getElementById('remember-admin-api-key');
    const adminKeyFallback = document.getElementById('admin-key-fallback');
    const adminSessionState = document.getElementById('admin-session-state');
    let pageAdminApiKey = '';
    let localAdminSessionActive = false;
    const professionalPanels = document.querySelectorAll('.professional-panel');
    const modeButtons = { simple: document.getElementById('mode-simple'), professional: document.getElementById('mode-professional') };
    function setAdminMode(mode) {
      const professional = mode === 'professional';
      professionalPanels.forEach((panel) => { panel.hidden = !professional; });
      Object.entries(modeButtons).forEach(([name, button]) => button.setAttribute('aria-pressed', String(name === mode)));
      localStorage.setItem('adminViewMode', mode);
    }
    modeButtons.simple.addEventListener('click', () => setAdminMode('simple'));
    modeButtons.professional.addEventListener('click', () => setAdminMode('professional'));
    setAdminMode(localStorage.getItem('adminViewMode') === 'professional' ? 'professional' : 'simple');
    document.getElementById('save-admin-api-key').addEventListener('click', async () => {
      saveAdminApiKey(adminKeyInput.value.trim(), rememberAdminKeyInput.checked);
      const key = adminKeyInput.value.trim();
      document.getElementById('result').textContent = key ? (rememberAdminKeyInput.checked ? 'Admin API Key 已明确保存到此浏览器。' : 'Admin API Key 仅在当前页面启用；刷新或关闭后不会保留。') : 'Admin API Key 已清除。';
      if (key) { await loadAccounts(); await loadApiKeys(); await loadModels(); }
    });

    const oauthFlowStorageKey = 'chat2claude.oauthFlow';
    captureOAuthFlowFromQuery();
    document.getElementById('auth-chatgpt').addEventListener('click', async () => {
      const popup = window.open('about:blank', '_blank');
      try {
        const body = await postJson('/admin/api/auth/chatgpt/start', { adminOrigin: window.location.origin });
        currentFlowId = body.id;
        rememberOAuthFlow(body.id);
        restoreAuthControls(body);
        renderResult(body);
        if (popup) {
          popup.opener = null;
          popup.location.href = body.authorizeUrl;
          popup.focus();
        } else {
          document.getElementById('auth-message').textContent = '浏览器拦截了授权窗口，请点击下方“打开 Codex OAuth 授权页”或复制授权链接。';
        }
        schedulePoll(1200);
      } catch (error) {
        if (popup) popup.close();
        showAuthError(error);
      }
    });
    document.getElementById('cancel-auth').addEventListener('click', async () => {
      if (!currentFlowId) return;
      try {
        const body = await postJson('/admin/api/auth/chatgpt/' + encodeURIComponent(currentFlowId) + '/cancel');
        clearOAuthFlow();
        document.getElementById('auth-message').textContent = body.message || '已取消。';
        renderResult(body);
      } catch (error) { showAuthError(error); }
    });
    document.getElementById('copy-auth-link').addEventListener('click', async () => {
      const link = document.getElementById('auth-link').href;
      if (!link) return;
      try {
        await navigator.clipboard.writeText(link);
        document.getElementById('auth-message').textContent = '授权链接已复制，请在当前浏览器中打开。';
      } catch {
        document.getElementById('auth-message').textContent = '复制失败，请手动选中下方完整授权 URL 复制。';
      }
    });
    document.getElementById('copy-runtime-api-key').addEventListener('click', async () => {
      const key = document.getElementById('api-key').dataset.value;
      if (!key) return;
      try {
        await navigator.clipboard.writeText(key);
        document.getElementById('result').textContent = 'Runtime API Key 已复制。请保存到 Claude Code 或其他客户端配置中；刷新页面后不会再次显示原始 Key。';
      } catch {
        document.getElementById('result').textContent = 'Runtime API Key 复制失败，请手动选中并立即保存。';
      }
    });
    document.getElementById('submit-oauth-callback').addEventListener('click', async () => {
      const redirectUrl = document.getElementById('oauth-callback-url').value.trim();
      if (!redirectUrl) { document.getElementById('auth-message').textContent = '请粘贴完整 callback URL。'; return; }
      try {
        const body = await postJson('/admin/api/auth/chatgpt/callback', { redirectUrl });
        renderResult(body);
        if (body.id) { currentFlowId = body.id; rememberOAuthFlow(body.id); }
        restoreAuthControls(body);
        schedulePoll(300);
      } catch (error) { showAuthError(error); }
    });
    document.getElementById('manual-complete').addEventListener('click', async () => {
      const body = await postJson('/admin/api/auth/chatgpt/complete', {
        accessToken: document.getElementById('session-access-token').value,
        cookie: document.getElementById('session-cookie').value,
        deviceId: document.getElementById('session-device-id').value,
        userAgent: document.getElementById('session-user-agent').value,
      });
      renderResult(body);
      if (body.apiKey) showReady(body);
      await loadAccounts(); await loadApiKeys(); await loadModels();
    });

    function schedulePoll(delay) { clearPoll(); pollTimer = setTimeout(pollAuth, delay); }
    function clearPoll() { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }
    function showAuthLink(authorizeUrl) {
      const area = document.getElementById('auth-link-area');
      const link = document.getElementById('auth-link');
      const copyButton = document.getElementById('copy-auth-link');
      const urlDisplay = document.getElementById('auth-url-display');
      const hasUrl = typeof authorizeUrl === 'string' && authorizeUrl.length > 0;
      area.hidden = !hasUrl;
      link.hidden = !hasUrl;
      copyButton.hidden = !hasUrl;
      urlDisplay.hidden = !hasUrl;
      if (!hasUrl) { link.removeAttribute('href'); urlDisplay.textContent = ''; return; }
      link.href = authorizeUrl;
      link.textContent = '打开 Codex OAuth 授权页';
      urlDisplay.textContent = authorizeUrl;
    }
    async function pollAuth() {
      if (!currentFlowId) return;
      try {
        const body = await getJson('/admin/api/auth/chatgpt/' + encodeURIComponent(currentFlowId));
        restoreAuthControls(body);
        renderResult(body);
        if (body.provisionResult?.apiKey) {
          clearOAuthFlow(); showReady(body.provisionResult); await loadAccounts(); await loadApiKeys(); await loadModels(); return;
        }
        if (['expired', 'cancelled', 'error'].includes(body.state)) { clearOAuthFlow(); return; }
        schedulePoll(1800);
      } catch (error) {
        handleOAuthFlowFailure(error);
      }
    }
    function restoreAuthControls(body) {
      document.getElementById('cancel-auth').disabled = !currentFlowId || ['expired', 'cancelled', 'error'].includes(body.state);
      document.getElementById('auth-message').textContent = body.message || body.state || '';
      showAuthLink(body.authorizeUrl);
    }
    function captureOAuthFlowFromQuery() {
      const url = new URL(window.location.href);
      const flowId = url.searchParams.get('oauth_flow');
      if (flowId && /^[A-Za-z0-9_-]{32}$/.test(flowId)) rememberOAuthFlow(flowId);
      if (flowId !== null) {
        url.searchParams.delete('oauth_flow');
        history.replaceState(history.state, '', url.pathname + url.search + url.hash);
      }
    }
    function rememberOAuthFlow(flowId) {
      sessionStorage.setItem(oauthFlowStorageKey, JSON.stringify({ flowId, origin: window.location.origin }));
    }
    function clearOAuthFlow() {
      clearPoll(); currentFlowId = null; sessionStorage.removeItem(oauthFlowStorageKey);
      document.getElementById('cancel-auth').disabled = true;
      showAuthLink();
    }
    async function restoreOAuthFlow() {
      let saved;
      try { saved = JSON.parse(sessionStorage.getItem(oauthFlowStorageKey) || 'null'); } catch { sessionStorage.removeItem(oauthFlowStorageKey); return; }
      if (!saved || typeof saved.flowId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(saved.flowId) || saved.origin !== window.location.origin) { sessionStorage.removeItem(oauthFlowStorageKey); return; }
      currentFlowId = saved.flowId;
      try {
        const body = await getJson('/admin/api/auth/chatgpt/' + encodeURIComponent(currentFlowId));
        restoreAuthControls(body);
        renderResult(body);
        if (body.provisionResult?.apiKey) { clearOAuthFlow(); showReady(body.provisionResult); await loadAccounts(); await loadApiKeys(); await loadModels(); }
        else if (['expired', 'cancelled', 'error'].includes(body.state)) clearOAuthFlow();
        else schedulePoll(0);
      } catch (error) { handleOAuthFlowFailure(error); }
    }
    function handleOAuthFlowFailure(error) {
      clearOAuthFlow();
      if (error && error.status === 404) {
        const message = '服务重启或流程过期，请重新授权。';
        document.getElementById('auth-message').textContent = message;
        document.getElementById('result').textContent = message;
        return;
      }
      showAuthError(error);
    }
    function showAuthError(error) {
      const message = error instanceof Error ? error.message : String(error);
      document.getElementById('auth-message').textContent = 'OAuth 操作失败：' + message;
      document.getElementById('result').textContent = 'OAuth 操作失败：' + message;
    }
    function showReady(result) {
      const endpoint = window.location.origin + '/v1/messages';
      document.getElementById('api-config').hidden = false;
      document.getElementById('endpoint').textContent = endpoint;
      const apiKey = document.getElementById('api-key');
      apiKey.textContent = result.apiKey || '<your-api-key>';
      apiKey.dataset.value = result.apiKey || '';
      const curl = curlExample.dataset.template.replace('__ORIGIN__', window.location.origin);
      document.getElementById('ready-curl').textContent = curl;
      curlExample.textContent = curl;
      const keyState = document.getElementById('key-state'); keyState.textContent = '已配置'; keyState.className = 'status ok';
      document.getElementById('auth-message').textContent = '初始化完成：已创建账号、刷新模型、绑定 alias 并生成 Runtime API Key，请立即复制保存。';
    }

    document.getElementById('add-account').addEventListener('click', async () => {
      const body = await postJson('/admin/api/accounts', { provider: 'mock', label: document.getElementById('account-label').value, maxConcurrency: Number(document.getElementById('account-concurrency').value || 1), capabilities: ['mock', 'messages'] });
      renderResult(body); await loadAccounts();
    });
    document.getElementById('refresh-api-keys').addEventListener('click', loadApiKeys);
    document.getElementById('create-model-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = document.getElementById('model-alias-id').value.trim();
      const displayName = document.getElementById('model-display-name').value.trim();
      const backendModel = document.getElementById('model-backend').value.trim();
      const body = await postJson('/admin/api/models', { id, display_name: displayName || id, backendModel: backendModel || undefined });
      renderResult(body); await loadModels();
      if (!body.error) document.getElementById('create-model-form').reset();
    });
    document.getElementById('reset-models').addEventListener('click', async () => { const body = await postJson('/admin/api/models/reset'); renderResult(body); await loadModels(); });
    document.getElementById('refresh-models').addEventListener('click', async () => { const body = await postJson('/admin/api/models/refresh'); renderResult(body); await loadModels(); });

    async function loadAccounts() {
      let body;
      try { body = await getJson('/admin/api/accounts'); } catch (error) { document.getElementById('accounts').innerHTML = loadFailureHtml('账号数据加载失败，未加载。', error); return; }
      const accounts = Array.isArray(body.accounts) ? body.accounts : [];
      if (!accounts.length) { document.getElementById('accounts').innerHTML = '<div class="empty">账号池为空。</div>'; return; }
      document.getElementById('accounts').innerHTML = '<div class="table-wrap"><table><thead><tr><th>ID</th><th>标识</th><th>Provider</th><th>状态</th><th>并发</th><th>Secret</th><th>最近使用</th><th>能力</th><th>操作</th></tr></thead><tbody>' + accounts.map((account) =>
        '<tr><td><code>' + esc(account.id) + '</code></td><td>' + esc(account.label) + '</td><td>' + esc(account.provider || 'mock') + '</td><td><span class="pill">' + esc(account.status) + (account.enabled ? '' : ' / disabled') + '</span></td><td>' + account.currentConcurrency + '/' + account.maxConcurrency + '</td><td>' + (account.hasSecret ? '已导入' : '-') + '</td><td>' + esc(account.lastUsedAt || '-') + '</td><td>' + esc((account.capabilities || []).join(', ')) + '</td><td><button class="secondary" data-health="' + esc(account.id) + '">健康检查</button> <button class="secondary" data-delete-account="' + esc(account.id) + '" ' + (account.currentConcurrency > 0 ? 'disabled title="账号有进行中的请求"' : '') + '>删除</button></td></tr>'
      ).join('') + '</tbody></table></div>';
      document.querySelectorAll('[data-health]').forEach((button) => button.addEventListener('click', async () => { const body = await postJson('/admin/api/accounts/' + encodeURIComponent(button.dataset.health) + '/health-check'); renderResult(body); await loadAccounts(); }));
      document.querySelectorAll('[data-delete-account]').forEach((button) => button.addEventListener('click', async () => {
        if (!window.confirm('确认删除此账号？删除后无法恢复。')) return;
        const body = await deleteJson('/admin/api/accounts/' + encodeURIComponent(button.dataset.deleteAccount)); renderResult(body); await loadAccounts();
      }));
    }
    async function loadApiKeys() {
      let body;
      try { body = await getJson('/admin/api/api-keys'); } catch (error) { document.getElementById('api-keys-count').textContent = '-'; document.getElementById('api-keys').innerHTML = loadFailureHtml('运行时 API Key 加载失败，未加载。', error); return; }
      const apiKeys = Array.isArray(body.apiKeys) ? body.apiKeys : [];
      document.getElementById('api-keys-count').textContent = String(apiKeys.length);
      if (!apiKeys.length) { document.getElementById('api-keys').innerHTML = '<div class="empty">没有运行时 API Key。</div>'; return; }
      document.getElementById('api-keys').innerHTML = '<div class="table-wrap"><table><thead><tr><th>ID</th><th>名称</th><th>安全前缀</th><th>创建时间</th><th>操作</th></tr></thead><tbody>' + apiKeys.map((apiKey) =>
        '<tr><td><code>' + esc(apiKey.id) + '</code></td><td>' + esc(apiKey.name || '-') + '</td><td><code>' + esc(apiKey.prefix) + '</code></td><td>' + esc(apiKey.createdAt) + '</td><td><button class="secondary" data-revoke-key="' + esc(apiKey.id) + '">撤销</button></td></tr>'
      ).join('') + '</tbody></table></div>';
      document.querySelectorAll('[data-revoke-key]').forEach((button) => button.addEventListener('click', async () => {
        if (!window.confirm('确认撤销此运行时 API Key？撤销后立即失效。')) return;
        const body = await deleteJson('/admin/api/api-keys/' + encodeURIComponent(button.dataset.revokeKey)); renderResult(body); await loadApiKeys();
      }));
    }
    async function loadModels() {
      let body;
      try { body = await getJson('/admin/api/models'); } catch (error) { const failure = loadFailureHtml('模型数据加载失败，未加载。', error); document.getElementById('model-availability').innerHTML = failure; document.getElementById('models').innerHTML = failure; return; }
      const aliases = Array.isArray(body.aliases) ? body.aliases : (Array.isArray(body.models) ? body.models : []);
      const discovered = Array.isArray(body.discovered) ? body.discovered : [];
      const discoveryHtml = discovered.length ? '<div class="row">' + discovered.map((model) => '<span class="pill" title="' + esc(capabilitySummary(model.capabilities)) + '">' + esc(model.id) + '</span>').join('') + '</div>' : '<div class="empty">Backend discovery 暂无模型；不会假设所有控制项都可用。</div>';
      const builtInAliases = aliases.filter((model) => model.builtIn);
      document.getElementById('model-availability').innerHTML = builtInAliases.length
        ? '<div class="row">' + builtInAliases.map((model) => '<span class="pill"><code>' + esc(model.id) + '</code>：' + (model.status === 'unbound' ? '未绑定，需要专业模式选择后端模型' : esc(model.status || '-')) + '</span>').join('') + '</div>'
        : '<div class="empty">暂无内置 alias。</div>';
      const createBackend = document.getElementById('model-backend');
      createBackend.innerHTML = backendOptionsHtml('', discovered, true);
      if (!aliases.length) { document.getElementById('models').innerHTML = discoveryHtml + '<div class="empty">暂无 alias overlay。</div>'; return; }
      document.getElementById('models').innerHTML = '<p class="muted">Backend discovery（选项与顺序直接来自 catalog）</p>' + discoveryHtml + '<div class="table-wrap"><table><thead><tr><th>Alias</th><th>Backend Model</th><th>状态</th><th>启用</th><th>目标能力与默认参数</th><th>操作</th></tr></thead><tbody>' + aliases.map((model) =>
        '<tr><td><code>' + esc(model.id) + '</code>' + (model.builtIn ? ' <span class="muted">内置</span>' : '') + '</td><td><select data-field="backendModel" data-id="' + esc(model.id) + '">' + backendOptionsHtml(model.backendModel || '', discovered, true) + '</select></td><td><span class="pill">' + esc(model.status || '-') + '</span></td><td><input type="checkbox" data-field="enabled" data-id="' + esc(model.id) + '" ' + (model.enabled ? 'checked' : '') + ' /></td><td><div class="stack" data-controls-for="' + esc(model.id) + '">' + controlSelectsHtml(model, model.defaults, model.id) + capabilityStateHtml(model) + '</div></td><td><button data-save-model="' + esc(model.id) + '">保存</button>' + (model.builtIn ? '' : ' <button class="secondary" data-delete-model="' + esc(model.id) + '">删除</button>') + '</td></tr>'
      ).join('') + '</tbody></table></div>';
      document.querySelectorAll('[data-field="backendModel"]').forEach((select) => select.addEventListener('change', () => {
        const alias = aliases.find((model) => model.id === select.dataset.id);
        const target = discovered.find((model) => model.id === select.value);
        const host = document.querySelector('[data-controls-for="' + CSS.escape(select.dataset.id) + '"]');
        if (alias && host) host.innerHTML = controlSelectsHtml(target || { capabilities: unknownCapabilities() }, alias.defaults, alias.id) + capabilityStateHtml(target || { capabilities: unknownCapabilities(), configuration_issues: [] });
      }));
      document.querySelectorAll('[data-save-model]').forEach((button) => button.addEventListener('click', async () => saveModel(button.dataset.saveModel)));
      document.querySelectorAll('[data-delete-model]').forEach((button) => button.addEventListener('click', async () => {
        if (!window.confirm('确认删除此自定义模型 alias？删除后无法恢复。')) return;
        const body = await deleteJson('/admin/api/models/' + encodeURIComponent(button.dataset.deleteModel)); renderResult(body); await loadModels();
      }));
    }
    async function saveModel(id) { const byField = (field) => document.querySelector('[data-id="' + CSS.escape(id) + '"][data-field="' + field + '"]'); const body = await patchJson('/admin/api/models/' + encodeURIComponent(id), { backendModel: byField('backendModel').value, enabled: byField('enabled').checked, defaults: { reasoning_effort: byField('reasoning_effort').value, service_tier: byField('speed').value } }); renderResult(body); await loadModels(); }
    function backendOptionsHtml(current, discovered, allowEmpty) {
      const values = discovered.map((model) => ({ value: model.id, label: model.display_name || model.id }));
      if (current && !values.some((option) => option.value === current)) values.unshift({ value: current, label: current + '（已失效）' });
      if (allowEmpty) values.unshift({ value: '', label: '未绑定' });
      return values.map((option) => '<option value="' + esc(option.value) + '" ' + (option.value === current ? 'selected' : '') + '>' + esc(option.label) + '</option>').join('');
    }
    function controlSelectsHtml(model, defaults, aliasId) {
      const capabilities = model.capabilities || unknownCapabilities();
      const reasoning = (capabilities.reasoning_effort_options || []).map((option) => ({ value: option.effort, label: reasoningLabel(option.effort), description: option.description }));
      const tiers = [{ value: 'standard', label: 'Standard（发送 service_tier: default）' }, { value: 'auto', label: 'Auto（省略 service_tier）' }].concat((capabilities.service_tiers || []).filter((option) => !['standard', 'default', 'auto'].includes(String(option.id).toLowerCase())).map((option) => ({ value: option.id, label: option.name || option.id, description: option.description })));
      return '<label>推理 ' + selectHtml(aliasId, 'reasoning_effort', reasoning, defaults.reasoning_effort) + '</label><label>服务层级 ' + selectHtml(aliasId, 'speed', tiers, defaults.speed) + '</label>';
    }
    function selectHtml(id, field, options, current) {
      const normalized = String(current || '').toLowerCase();
      if (current && !options.some((option) => String(option.value).toLowerCase() === normalized)) options = [{ value: current, label: current + '（配置不受目标支持）' }].concat(options);
      return '<select data-field="' + field + '" data-id="' + esc(id) + '">' + options.map((option) => '<option value="' + esc(option.value) + '" title="' + esc(option.description || '') + '" ' + (String(option.value).toLowerCase() === normalized ? 'selected' : '') + '>' + esc(option.label) + '</option>').join('') + '</select>';
    }
    function reasoningLabel(effort) {
      const value = String(effort).toLowerCase();
      if (value === 'low') return 'Light（官方 low）';
      if (value === 'ultra') return 'Ultra（兼容最高强度）';
      return effort;
    }
    function capabilityStateHtml(model) {
      const capabilities = model.capabilities || unknownCapabilities();
      const states = capabilities.metadata_status || {};
      const parts = ['推理元数据：' + (states.reasoning === 'known' ? '已发现' : '未知'), '服务层级元数据：' + (states.service_tier === 'known' ? '已发现' : '未知')];
      if (capabilities.ultra_lossy) parts.push(capabilities.ultra_mapped_effort ? 'Ultra 会有损映射到 ' + capabilities.ultra_mapped_effort + '，不会把 ultra 发给上游' : 'Ultra 没有安全的非 ultra 映射；显式请求会拒绝，隐式默认会省略');
      if (Array.isArray(model.configuration_issues) && model.configuration_issues.length) parts.push(model.configuration_issues.join('；'));
      return '<span class="muted">' + esc(parts.join(' · ')) + '</span>';
    }
    function capabilitySummary(capabilities) {
      const value = capabilities || unknownCapabilities();
      return 'reasoning: ' + ((value.reasoning_effort || []).join(', ') || '未知') + '; service tiers: ' + ((value.response_speed || []).join(', ') || '未知');
    }
    function unknownCapabilities() { return { reasoning_effort_options: [], service_tiers: [], metadata_status: { reasoning: 'unknown', service_tier: 'unknown' } }; }
    function renderResult(body) { document.getElementById('result').textContent = JSON.stringify(redactApiKeys(body), null, 2); }
    function redactApiKeys(value) {
      if (Array.isArray(value)) return value.map(redactApiKeys);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'apiKey' || key === 'key' ? '<one-time-key-hidden>' : redactApiKeys(item)]));
    }
    async function getJson(url) { return requestJson(url); }
    async function postJson(url, body) { return requestJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); }
    async function patchJson(url, body) { return requestJson(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
    async function deleteJson(url) { return requestJson(url, { method: 'DELETE' }); }
    async function requestJson(url, init) {
      const response = await fetchWithAdminKey(url, init);
      let body;
      try { body = await response.json(); } catch { body = {}; }
      if (response.ok) return body;
      const message = body?.error?.message || body?.error || body?.message || ('HTTP ' + response.status);
      if (response.status === 401) {
        setAdminSessionState(false);
        adminKeyFallback.open = true;
        document.getElementById('result').textContent = '未认证/数据未加载。请展开“远程访问或自动化”并显式启用 Admin API Key 后重试。';
      }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    function loadFailureHtml(message, error) { return '<div class="empty">' + esc(message + ' ' + (error instanceof Error ? error.message : String(error))) + '</div>'; }
    async function fetchWithAdminKey(url, init) {
      const options = { ...(init || {}) };
      const headers = new Headers(options.headers || {});
      // A connected local HttpOnly session takes precedence over any legacy
      // browser storage. Only remote/session-unavailable access sends a key.
      const key = localAdminSessionActive ? '' : getStoredAdminApiKey();
      if (key) headers.set('x-api-key', key);
      options.headers = headers;
      return fetch(url, options);
    }
    async function verifyLocalAdminSession() {
      try {
        const response = await fetch('/admin/api/accounts');
        localAdminSessionActive = response.ok;
      } catch {
        localAdminSessionActive = false;
      }
      setAdminSessionState(localAdminSessionActive);
      return localAdminSessionActive;
    }
    function setAdminSessionState(active) {
      localAdminSessionActive = active;
      adminSessionState.className = 'session-strip' + (active ? '' : ' warn');
      adminSessionState.innerHTML = active
        ? '<span class="status ok">本地会话已连接</span><div><strong>管理操作已通过 HttpOnly 浏览器会话完成</strong><span class="muted">此页面无需 Admin API Key。会话仅适用于本机可信访问，服务重启或会话失效后会自动回退到显式 Key。</span></div>'
        : '<span class="status warn">需要显式 Key</span><div><strong>未检测到可用的本地管理会话</strong><span class="muted">远程访问、自动化或会话失效时，请展开上方 fallback 并手动提供 Admin API Key；系统不会弹窗索取，也不会默认保存。</span></div>';
    }
    function getStoredAdminApiKey() { return pageAdminApiKey || localStorage.getItem('adminApiKey') || ''; }
    function saveAdminApiKey(key, persistent) {
      pageAdminApiKey = key;
      if (key && persistent) localStorage.setItem('adminApiKey', key);
      else localStorage.removeItem('adminApiKey');
      adminKeyInput.value = key;
    }
    function esc(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
    verifyLocalAdminSession().then(async () => { await Promise.all([loadAccounts(), loadApiKeys(), loadModels()]); await restoreOAuthFlow(); });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
