import { Hono } from 'hono';
import type { ChatGptBackendClient, ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';
import type { ReasoningEffort, SpeedPreference } from '@chatgpt-to-claude/protocol-mapper';
import type { ChatGptBackendProvider } from '../config/env.js';
import type { AccountPool } from '../services/account-pool.js';
import type { ModelRegistry } from '../services/model-registry.js';
import { DEV_API_KEY_PREFIX, type RuntimeApiKeys } from '../services/runtime-api-keys.js';
import { ChatGptAuthFlowService } from '../services/chatgpt-auth-flow.js';
import { SetupProvisioner, type ProvisionResult } from '../services/setup-provisioner.js';

export interface AdminRouteOptions {
  accountPool: AccountPool;
  modelRegistry: ModelRegistry;
  backend: ChatGptBackendClient;
  ready?: Promise<unknown>;
  runtimeApiKeys: RuntimeApiKeys;
  envApiKeys: string[];
  defaultReasoningEffort: ReasoningEffort;
  defaultResponseSpeed: SpeedPreference;
  backendProvider: ChatGptBackendProvider;
  authFlow?: ChatGptAuthFlowService;
  setupProvisioner?: SetupProvisioner;
}

export function createAdminRoute(options: AdminRouteOptions): Hono {
  const app = new Hono();
  const authFlow = options.authFlow ?? new ChatGptAuthFlowService();
  const provisioner = options.setupProvisioner ?? new SetupProvisioner(options);

  app.get('/admin', (c) => c.html(renderAdminPage(status(options))));
  app.get('/admin/api/setup/status', (c) => c.json(status(options)));
  app.get('/admin/api/auth/status', (c) => c.json(authStatus(options)));

  app.post('/admin/api/api-keys/dev-enable', (c) => {
    if (process.env.NODE_ENV === 'production') {
      return c.json({
        type: 'error',
        error: { type: 'permission_error', message: 'Development API key initialization is disabled in production.' },
      }, 403);
    }
    const key = options.runtimeApiKeys.create(DEV_API_KEY_PREFIX);
    return c.json({
      ok: true,
      message: 'Development API key enabled in memory. Use the returned key for /v1/* until the process restarts.',
      key,
      status: status(options),
    });
  });

  app.post('/admin/api/auth/chatgpt/start', async (c) => c.json(await authFlow.start(), 201));
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
  app.post('/admin/api/accounts', async (c) => {
    try {
      const account = options.accountPool.add(await readJson(c.req));
      return c.json({ account }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Invalid account' }, 400);
    }
  });
  app.patch('/admin/api/accounts/:id', async (c) => {
    const account = options.accountPool.update(c.req.param('id'), await readJson(c.req));
    return account ? c.json({ account }) : c.json({ error: 'Account not found' }, 404);
  });
  app.post('/admin/api/accounts/:id/health-check', async (c) => {
    const id = c.req.param('id');
    const internalAccount = options.accountPool.get(id);
    if (!internalAccount) return c.json({ error: 'Account not found' }, 404);
    if (!options.backend.healthCheck) {
      const account = options.accountPool.healthCheck(id);
      return account ? c.json({ ok: true, account }) : c.json({ error: 'Account not found' }, 404);
    }
    try {
      const result = await options.backend.healthCheck({ account: internalAccount });
      const account = result.ok ? options.accountPool.markHealthy(id) : options.accountPool.markError(id, result.message ?? 'Health check failed');
      const view = result.ok && internalAccount.provider === 'chatgpt-session'
        ? await options.modelRegistry.refreshFromBackend(options.backend, { account: internalAccount })
        : undefined;
      return c.json({ ok: result.ok, message: result.message, account, view });
    } catch (error) {
      const account = options.accountPool.markError(id, error);
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error), account }, 502);
    }
  });

  app.get('/admin/api/models', async (c) => {
    if (options.ready) await options.ready;
    return c.json(options.modelRegistry.adminView());
  });
  app.patch('/admin/api/models/:id', async (c) => {
    if (options.ready) await options.ready;
    const model = options.modelRegistry.update(c.req.param('id'), await readJson(c.req));
    return model ? c.json({ model, view: options.modelRegistry.adminView() }) : c.json({ error: 'Model alias not found' }, 404);
  });
  app.post('/admin/api/models/reset', async (c) => {
    if (options.ready) await options.ready;
    return c.json({ models: options.modelRegistry.reset(), view: options.modelRegistry.adminView() });
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
      : '打开 /admin 点击“浏览器授权（Codex OAuth）”，复制授权链接到当前浏览器完成授权后，系统会自动初始化账号、模型和 API Key。',
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
  -d '{"model":"sonnet","max_tokens":128,"reasoning_effort":"medium","response_speed":"balanced","messages":[{"role":"user","content":"你好"}]}'`;
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
    h1{margin:0 0 12px;font-size:clamp(32px,6vw,64px);line-height:.98;letter-spacing:-.06em}.hero p{max-width:800px;margin:0;color:#aec0ba;line-height:1.8}.content{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(320px,.92fr);gap:18px;padding:18px}.card{border:1px solid var(--line);border-radius:22px;background:linear-gradient(180deg,rgba(255,255,255,.038),transparent),var(--panel);padding:22px}.card.full{grid-column:1/-1}.muted{color:var(--muted)}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.stack{display:grid;gap:14px}.status{display:inline-flex;gap:8px;padding:7px 12px;border-radius:999px;font-size:13px;font-weight:800;border:1px solid var(--line);background:rgba(255,255,255,.045)}.status.ok{color:var(--cyan);border-color:rgba(66,214,198,.38);background:rgba(66,214,198,.14)}.status.warn{color:var(--gold);border-color:rgba(230,180,81,.38);background:rgba(230,180,81,.16)}
    .steps{display:grid;gap:12px;padding:0;margin:0;list-style:none;counter-reset:step}.steps li{counter-increment:step;display:grid;grid-template-columns:34px 1fr;gap:12px;padding:13px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.035)}.steps li:before{content:counter(step,decimal-leading-zero);display:grid;place-items:center;width:34px;height:34px;border-radius:11px;color:var(--gold);background:rgba(230,180,81,.16);font-size:12px;font-weight:900}.steps strong{display:block;margin-bottom:5px}
    input,select{min-height:40px;border:1px solid rgba(143,162,155,.34);border-radius:12px;padding:9px 11px;color:var(--text);background:rgba(2,8,8,.58);outline:none}button{min-height:40px;border:1px solid rgba(230,180,81,.44);border-radius:12px;padding:9px 14px;color:#130f07;background:linear-gradient(180deg,#f0c66b,#c8912f);font-weight:900;cursor:pointer}button.secondary{color:var(--text);border-color:rgba(66,214,198,.36);background:linear-gradient(180deg,rgba(66,214,198,.2),rgba(66,214,198,.08))}button:disabled{opacity:.58;cursor:not-allowed}.table-wrap{margin-top:16px;border:1px solid var(--line);border-radius:18px;overflow:auto;background:rgba(0,0,0,.18)}table{width:100%;border-collapse:collapse;min-width:760px;font-size:13px}th,td{padding:12px;border-bottom:1px solid rgba(143,162,155,.16);text-align:left}th{color:#bfd0ca;background:rgba(255,255,255,.045);font-size:11px;letter-spacing:.12em;text-transform:uppercase}code,pre{font-family:"Cascadia Code",monospace;border-radius:9px;color:#cdeee9;background:rgba(66,214,198,.1)}code{padding:2px 6px}pre{margin:0;padding:16px;overflow:auto;white-space:pre-wrap;line-height:1.6;border:1px solid rgba(66,214,198,.16)}.empty{margin-top:16px;border:1px dashed rgba(230,180,81,.36);border-radius:18px;padding:18px;color:#c6b48c;background:rgba(230,180,81,.07)}.pill{display:inline-flex;min-height:26px;border:1px solid rgba(66,214,198,.24);border-radius:999px;padding:4px 9px;color:#bfe9e4;background:rgba(66,214,198,.08);font-size:12px}details{border:1px solid var(--line);border-radius:18px;padding:14px;background:rgba(255,255,255,.025)}summary{cursor:pointer;font-weight:900;color:#bfd0ca}@media(max-width:900px){.content{grid-template-columns:1fr}}@media(max-width:560px){button,input{width:100%}.content{padding:10px}.card{padding:16px}}
  </style>
</head>
<body>
  <main><div class="shell">
    <header class="hero"><p class="muted">Personal Self-hosted Console</p><h1>chat2claude 个人自托管控制台</h1><p>这是 local-first 的个人开源兼容层。请只授权本人控制或已获明确授权的 ChatGPT/Codex 账号及其包含的用量；不得公开转售个人订阅流量、向不特定第三方重新提供或进行大规模共享。普通使用走“浏览器授权（Codex OAuth）”：后台只生成授权链接和监听本地 callback，不启动独立 Chrome/新 profile，也不会从已登录 chatgpt.com 页面抓 session。</p></header>
    <div class="content">
      <section class="card">
        <h2>浏览器授权（Codex OAuth）</h2>
        <p>API Key：<span id="key-state" class="status ${keyTone}">${escapeHtml(keyState)}</span></p>
        <div class="row"><input id="admin-api-key" type="password" placeholder="Admin API Key" autocomplete="off" /><button id="save-admin-api-key" class="secondary" type="button">保存 Admin API Key</button></div>
        <label class="muted"><input id="remember-admin-api-key" type="checkbox" /> 记住到本机（长期保存到 localStorage；默认仅当前会话）</label>
        <p class="muted">当前 backend：<code>${escapeHtml(setupStatus.backend.provider)}</code>。不会启动独立 Chrome/新 profile；点击下方按钮后只生成授权链接，你自行在当前浏览器打开。</p>
        <div class="row"><button id="auth-chatgpt">生成 Codex OAuth 授权链接</button><button id="cancel-auth" class="secondary" disabled>取消</button></div>
        <p id="auth-message" class="muted">${escapeHtml(setupStatus.nextStep)}</p>
        <div id="auth-link-area" class="stack" hidden>
          <a id="auth-link" class="pill" hidden>在当前标签打开 Codex OAuth 授权链接</a>
          <button id="copy-auth-link" class="secondary" type="button" hidden>复制授权链接</button>
        </div>
        <div class="stack">
          <p class="muted">如果授权完成后浏览器显示无法连接本地 callback（默认 1455，必要时自动使用 1457），请原样复制地址栏里的完整 URL。后台会严格校验协议、host、端口和路径。</p>
          <div class="row"><input id="oauth-callback-url" placeholder="粘贴授权链接对应的完整 localhost callback URL" /><button id="submit-oauth-callback" class="secondary" type="button">提交 callback URL</button></div>
        </div>
      </section>
      <aside class="card"><h2>3 步完成</h2><ol class="steps"><li><div><strong>浏览器授权</strong><span class="muted">生成 Codex OAuth 链接，在当前浏览器/已登录账号环境中打开授权。</span></div></li><li><div><strong>自动初始化</strong><span class="muted">服务自动创建 chatgpt-primary、health-check、刷新模型并绑定 sonnet。</span></div></li><li><div><strong>复制 API 配置</strong><span class="muted">ready 后复制 endpoint、key 和 curl 示例。</span></div></li></ol></aside>
      <section class="card full" id="api-config" hidden><h2>API 配置</h2><div class="stack"><p>Endpoint：<code id="endpoint"></code></p><p>API Key：<code id="api-key"></code></p><pre id="ready-curl"></pre></div></section>
      <section class="card full"><details id="advanced-import"><summary>高级：手动导入 accessToken / cookie</summary><p class="muted">OAuth 不可用或已有 session secret 时使用。表单会走同一套 provisioning，不会返回 token/cookie。</p><div class="row"><input id="session-access-token" placeholder="accessToken" /><input id="session-cookie" placeholder="cookie（可选）" /><input id="session-device-id" placeholder="deviceId（可选）" /><input id="session-user-agent" placeholder="userAgent（可选）" /><button id="manual-complete" class="secondary">导入并初始化</button></div></details></section>
      <section class="card full"><h2>个人账号池（高级）</h2><p class="muted">仅用于同一自托管操作者管理本人控制或获授权的账号，并进行故障隔离、冷却、并发控制和本地调度；禁止用于公开转售订阅流量或面向不特定第三方的大规模共享。</p><div class="row"><input id="account-label" placeholder="账号标识" value="Mock ChatGPT Account" /><input id="account-concurrency" type="number" min="1" value="1" aria-label="最大并发" /><button id="add-account" class="secondary">添加 mock 账号</button></div><div id="accounts"><div class="empty">正在读取个人账号池状态。</div></div></section>
      <section class="card full"><h2>模型映射（高级管理）</h2><p class="muted">后端模型来自 discovery；alias overlay 负责映射、启用状态与缺省 reasoning_effort / response_speed。</p><div class="row"><button id="reset-models" class="secondary">重置 alias overlay</button><button id="refresh-models" class="secondary">刷新 backend discovery</button></div><div id="models"><div class="empty">正在加载模型映射。</div></div></section>
      <section class="card"><h2>结果面板</h2><pre id="result">${escapeHtml(setupStatus.nextStep)}</pre></section>
      <section class="card"><h2>curl 示例</h2><p class="muted">示例地址由当前页面 origin 生成。</p><pre id="curl-example" data-template="${escapeHtml(curlTemplate)}">${escapeHtml(curlTemplate)}</pre></section>
    </div>
  </div></main>
  <script>
    const effortOptions = ['off', 'minimal', 'low', 'medium', 'high', 'max'];
    const speedOptions = ['fastest', 'fast', 'balanced', 'quality'];
    let currentFlowId = null;
    let pollTimer = null;
    const curlExample = document.getElementById('curl-example');
    curlExample.textContent = curlExample.dataset.template.replace('__ORIGIN__', window.location.origin);
    const adminKeyInput = document.getElementById('admin-api-key');
    const rememberAdminKeyInput = document.getElementById('remember-admin-api-key');
    adminKeyInput.value = getStoredAdminApiKey();
    rememberAdminKeyInput.checked = Boolean(localStorage.getItem('adminApiKey'));
    document.getElementById('save-admin-api-key').addEventListener('click', () => {
      saveAdminApiKey(adminKeyInput.value.trim(), rememberAdminKeyInput.checked);
      document.getElementById('result').textContent = adminKeyInput.value.trim() ? (rememberAdminKeyInput.checked ? 'Admin API Key 已长期保存到本机。' : 'Admin API Key 已保存到当前会话。') : 'Admin API Key 已清除。';
    });

    document.getElementById('auth-chatgpt').addEventListener('click', async () => {
      const body = await postJson('/admin/api/auth/chatgpt/start');
      currentFlowId = body.id;
      document.getElementById('cancel-auth').disabled = false;
      document.getElementById('auth-message').textContent = authStartMessage(body);
      showAuthLink(body.authorizeUrl);
      renderResult(body);
      schedulePoll(1200);
    });
    document.getElementById('cancel-auth').addEventListener('click', async () => {
      if (!currentFlowId) return;
      const body = await postJson('/admin/api/auth/chatgpt/' + encodeURIComponent(currentFlowId) + '/cancel');
      clearPoll();
      document.getElementById('cancel-auth').disabled = true;
      document.getElementById('auth-message').textContent = body.message || '已取消。';
      renderResult(body);
    });
    document.getElementById('copy-auth-link').addEventListener('click', async () => {
      const link = document.getElementById('auth-link').href;
      if (!link) return;
      await navigator.clipboard.writeText(link);
      document.getElementById('auth-message').textContent = '授权链接已复制，请在当前浏览器中打开。';
    });
    document.getElementById('submit-oauth-callback').addEventListener('click', async () => {
      const redirectUrl = document.getElementById('oauth-callback-url').value.trim();
      if (!redirectUrl) { document.getElementById('auth-message').textContent = '请粘贴完整 callback URL。'; return; }
      const body = await postJson('/admin/api/auth/chatgpt/callback', { redirectUrl });
      renderResult(body);
      if (body.id) currentFlowId = body.id;
      document.getElementById('auth-message').textContent = body.message || 'callback 已提交，正在轮询换取 token。';
      schedulePoll(300);
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
      await loadAccounts(); await loadModels();
    });

    function schedulePoll(delay) { clearPoll(); pollTimer = setTimeout(pollAuth, delay); }
    function clearPoll() { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }
    function authStartMessage(body) {
      if (body.authorizeUrl) return body.message || '授权链接已生成；后台不会自动打开窗口，请在当前浏览器中打开链接完成 Codex OAuth。';
      return body.message || '请完成 Codex OAuth 授权。';
    }
    function showAuthLink(authorizeUrl) {
      const area = document.getElementById('auth-link-area');
      const link = document.getElementById('auth-link');
      const copyButton = document.getElementById('copy-auth-link');
      const hasUrl = typeof authorizeUrl === 'string' && authorizeUrl.length > 0;
      area.hidden = !hasUrl;
      link.hidden = !hasUrl;
      copyButton.hidden = !hasUrl;
      if (!hasUrl) return;
      link.href = authorizeUrl;
      link.textContent = authorizeUrl;
    }
    async function pollAuth() {
      if (!currentFlowId) return;
      const body = await getJson('/admin/api/auth/chatgpt/' + encodeURIComponent(currentFlowId));
      document.getElementById('auth-message').textContent = body.message || body.state || '';
      renderResult(body);
      if (body.provisionResult?.apiKey) {
        clearPoll(); document.getElementById('cancel-auth').disabled = true; showReady(body.provisionResult); await loadAccounts(); await loadModels(); return;
      }
      if (['expired','cancelled','error'].includes(body.state)) { clearPoll(); document.getElementById('cancel-auth').disabled = true; return; }
      schedulePoll(1800);
    }
    function showReady(result) {
      if (result.apiKey) saveAdminApiKey(result.apiKey, false);
      const endpoint = window.location.origin + '/v1/messages';
      document.getElementById('api-config').hidden = false;
      document.getElementById('endpoint').textContent = endpoint;
      document.getElementById('api-key').textContent = result.apiKey ? 'API Key 已保存到当前会话' : '<your-api-key>';
      const curl = curlExample.dataset.template.replace('__ORIGIN__', window.location.origin);
      document.getElementById('ready-curl').textContent = curl;
      curlExample.textContent = curl;
      const keyState = document.getElementById('key-state'); keyState.textContent = '已配置'; keyState.className = 'status ok';
      document.getElementById('auth-message').textContent = '初始化完成：已创建账号、刷新模型、绑定 alias 并生成 API Key。';
    }

    document.getElementById('add-account').addEventListener('click', async () => {
      const body = await postJson('/admin/api/accounts', { provider: 'mock', label: document.getElementById('account-label').value, maxConcurrency: Number(document.getElementById('account-concurrency').value || 1), capabilities: ['mock', 'messages'] });
      renderResult(body); await loadAccounts();
    });
    document.getElementById('reset-models').addEventListener('click', async () => { const body = await postJson('/admin/api/models/reset'); renderResult(body); await loadModels(); });
    document.getElementById('refresh-models').addEventListener('click', async () => { const body = await postJson('/admin/api/models/refresh'); renderResult(body); await loadModels(); });

    async function loadAccounts() {
      const body = await getJson('/admin/api/accounts'); const accounts = body.accounts || [];
      if (!accounts.length) { document.getElementById('accounts').innerHTML = '<div class="empty">账号池为空。</div>'; return; }
      document.getElementById('accounts').innerHTML = '<div class="table-wrap"><table><thead><tr><th>ID</th><th>标识</th><th>Provider</th><th>状态</th><th>并发</th><th>Secret</th><th>最近使用</th><th>能力</th><th>操作</th></tr></thead><tbody>' + accounts.map((account) =>
        '<tr><td><code>' + esc(account.id) + '</code></td><td>' + esc(account.label) + '</td><td>' + esc(account.provider || 'mock') + '</td><td><span class="pill">' + esc(account.status) + (account.enabled ? '' : ' / disabled') + '</span></td><td>' + account.currentConcurrency + '/' + account.maxConcurrency + '</td><td>' + (account.hasSecret ? '已导入' : '-') + '</td><td>' + esc(account.lastUsedAt || '-') + '</td><td>' + esc((account.capabilities || []).join(', ')) + '</td><td><button class="secondary" data-health="' + esc(account.id) + '">健康检查</button></td></tr>'
      ).join('') + '</tbody></table></div>';
      document.querySelectorAll('[data-health]').forEach((button) => button.addEventListener('click', async () => { const body = await postJson('/admin/api/accounts/' + encodeURIComponent(button.dataset.health) + '/health-check'); renderResult(body); await loadAccounts(); }));
    }
    async function loadModels() {
      const body = await getJson('/admin/api/models'); const aliases = body.aliases || body.models || []; const discovered = body.discovered || [];
      const discoveryHtml = discovered.length ? '<div class="row">' + discovered.map((model) => '<span class="pill">' + esc(model.id) + '</span>').join('') + '</div>' : '<div class="empty">Backend discovery 暂无模型。</div>';
      if (!aliases.length) { document.getElementById('models').innerHTML = discoveryHtml + '<div class="empty">暂无 alias overlay。</div>'; return; }
      document.getElementById('models').innerHTML = '<p class="muted">Backend discovery</p>' + discoveryHtml + '<div class="table-wrap"><table><thead><tr><th>Alias</th><th>Backend Model</th><th>状态</th><th>启用</th><th>默认参数</th><th>操作</th></tr></thead><tbody>' + aliases.map((model) =>
        '<tr><td><code>' + esc(model.id) + '</code></td><td><input data-field="backendModel" data-id="' + esc(model.id) + '" value="' + esc(model.backendModel || '') + '" /></td><td><span class="pill">' + esc(model.status || '-') + '</span></td><td><input type="checkbox" data-field="enabled" data-id="' + esc(model.id) + '" ' + (model.enabled ? 'checked' : '') + ' /></td><td>' + selectHtml(model.id, 'reasoning_effort', effortOptions, model.defaults.reasoning_effort) + ' ' + selectHtml(model.id, 'speed', speedOptions, model.defaults.speed) + '</td><td><button data-save-model="' + esc(model.id) + '">保存</button></td></tr>'
      ).join('') + '</tbody></table></div>';
      document.querySelectorAll('[data-save-model]').forEach((button) => button.addEventListener('click', async () => saveModel(button.dataset.saveModel)));
    }
    async function saveModel(id) { const byField = (field) => document.querySelector('[data-id="' + CSS.escape(id) + '"][data-field="' + field + '"]'); const body = await patchJson('/admin/api/models/' + encodeURIComponent(id), { backendModel: byField('backendModel').value, enabled: byField('enabled').checked, defaults: { reasoning_effort: byField('reasoning_effort').value, speed: byField('speed').value } }); renderResult(body); await loadModels(); }
    function selectHtml(id, field, options, current) { return '<select data-field="' + field + '" data-id="' + esc(id) + '">' + options.map((option) => '<option value="' + option + '" ' + (option === current ? 'selected' : '') + '>' + option + '</option>').join('') + '</select>'; }
    function renderResult(body) { document.getElementById('result').textContent = JSON.stringify(redactApiKeys(body), null, 2); }
    function redactApiKeys(value) {
      if (Array.isArray(value)) return value.map(redactApiKeys);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'apiKey' ? '<saved-in-browser>' : redactApiKeys(item)]));
    }
    async function getJson(url) { return requestJson(url); }
    async function postJson(url, body) { return requestJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); }
    async function patchJson(url, body) { return requestJson(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
    async function requestJson(url, init) {
      const response = await fetchWithAdminKey(url, init);
      if (response.status !== 401) return response.json();
      const entered = window.prompt('请输入 Admin API Key');
      if (entered && entered.trim()) {
        saveAdminApiKey(entered.trim(), rememberAdminKeyInput.checked);
        const retry = await fetchWithAdminKey(url, init);
        return retry.json();
      }
      document.getElementById('result').textContent = '需要 Admin API Key 才能访问该接口。';
      return response.json();
    }
    async function fetchWithAdminKey(url, init) {
      const options = { ...(init || {}) };
      const headers = new Headers(options.headers || {});
      const key = getStoredAdminApiKey();
      if (key) headers.set('x-api-key', key);
      options.headers = headers;
      return fetch(url, options);
    }
    function getStoredAdminApiKey() { return sessionStorage.getItem('adminApiKey') || localStorage.getItem('adminApiKey') || ''; }
    function saveAdminApiKey(key, persistent) {
      if (key) {
        if (persistent) { localStorage.setItem('adminApiKey', key); sessionStorage.setItem('adminApiKey', key); }
        else { sessionStorage.setItem('adminApiKey', key); localStorage.removeItem('adminApiKey'); }
        adminKeyInput.value = key;
        return;
      }
      localStorage.removeItem('adminApiKey'); sessionStorage.removeItem('adminApiKey'); adminKeyInput.value = '';
    }
    function esc(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
    loadAccounts(); loadModels();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
