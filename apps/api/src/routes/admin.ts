import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import type { ReasoningEffort, SpeedPreference } from '@chatgpt-to-claude/protocol-mapper';
import type { ChatGptBackendProvider } from '../config/env.js';
import type { AccountPool } from '../services/account-pool.js';
import type { ModelRegistry } from '../services/model-registry.js';
import type { RuntimeApiKeys } from '../services/runtime-api-keys.js';

const DEV_API_KEY_PREFIX = 'sk-dev-';

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
}

export function createAdminRoute(options: AdminRouteOptions): Hono {
  const app = new Hono();
  app.get('/admin', (c) => c.html(renderAdminPage(status(options))));
  app.get('/admin/accounts', (c) => c.json({ accounts: options.accountPool.list() }));
  app.get('/admin/api/setup/status', (c) => c.json(status(options)));
  app.post('/admin/api/api-keys/dev-enable', (c) => {
    if (process.env.NODE_ENV === 'production') {
      return c.json({
        type: 'error',
        error: { type: 'permission_error', message: 'Development API key initialization is disabled in production.' },
      }, 403);
    }
    const key = generateDevApiKey();
    options.runtimeApiKeys.add(key);
    return c.json({
      ok: true,
      message: 'Development API key enabled in memory. Use the returned key for /v1/* until the process restarts.',
      key,
      status: status(options),
    });
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
  return {
    apiKeysConfigured: envApiKeysConfigured || runtimeApiKeysConfigured,
    envApiKeysConfigured,
    runtimeApiKeysConfigured,
    runtimeApiKeysCount: options.runtimeApiKeys.size,
    defaultReasoningEffort: options.defaultReasoningEffort,
    defaultResponseSpeed: options.defaultResponseSpeed,
    backend: { enabled: true, provider: options.backendProvider, chatGptConnected: options.backendProvider === 'session' },
    defaultEndpoint: 'POST /v1/messages',
    nextStep: envApiKeysConfigured || runtimeApiKeysConfigured
      ? 'Call /v1/messages with x-api-key or Authorization: Bearer token. Session backend requires importing a ChatGPT session account first.'
      : 'Open /admin and click Enable development API key, then call /v1/messages with the returned x-api-key.',
  };
}

function generateDevApiKey(): string {
  return `${DEV_API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
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
  <title>ChatGPT to Claude 运维控制台</title>
  <style>
    :root {
      --ink: #07100f;
      --panel: rgba(12, 24, 24, 0.88);
      --panel-strong: rgba(17, 34, 34, 0.96);
      --line: rgba(126, 154, 146, 0.24);
      --line-strong: rgba(236, 185, 82, 0.42);
      --text: #e6eee9;
      --muted: #8fa29b;
      --gold: #e6b451;
      --gold-soft: rgba(230, 180, 81, 0.16);
      --cyan: #42d6c6;
      --cyan-soft: rgba(66, 214, 198, 0.14);
      --danger: #ff7d64;
      --shadow: 0 24px 90px rgba(0, 0, 0, 0.42);
      color-scheme: dark;
    }

    * { box-sizing: border-box; }
    html { min-height: 100%; background: var(--ink); }
    body {
      margin: 0;
      min-height: 100%;
      color: var(--text);
      font-family: "Alibaba PuHuiTi", "HarmonyOS Sans SC", "Source Han Sans SC", "Microsoft YaHei UI", sans-serif;
      background:
        radial-gradient(circle at 20% -10%, rgba(230, 180, 81, 0.2), transparent 34rem),
        radial-gradient(circle at 78% 12%, rgba(66, 214, 198, 0.16), transparent 30rem),
        linear-gradient(135deg, rgba(255,255,255,0.035) 0 1px, transparent 1px 22px),
        linear-gradient(90deg, #050908, #0a1413 45%, #080d0c);
      overflow-x: hidden;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(rgba(255,255,255,0.026) 1px, transparent 1px) 0 0 / 100% 4px,
        radial-gradient(circle at center, transparent 0, rgba(0,0,0,0.24) 72%);
      mix-blend-mode: screen;
      opacity: 0.55;
    }

    main {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0 56px;
      position: relative;
    }
    .shell {
      border: 1px solid var(--line);
      border-radius: 28px;
      background: linear-gradient(180deg, rgba(13,25,24,0.9), rgba(8,14,14,0.94));
      box-shadow: var(--shadow), inset 0 1px 0 rgba(255,255,255,0.05);
      overflow: hidden;
    }
    .hero {
      position: relative;
      padding: 34px clamp(22px, 4vw, 42px) 28px;
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(120deg, rgba(230,180,81,0.13), transparent 40%),
        linear-gradient(270deg, rgba(66,214,198,0.11), transparent 36%);
    }
    .hero::after {
      content: "";
      position: absolute;
      right: 34px;
      top: 26px;
      width: 170px;
      height: 78px;
      border: 1px solid rgba(66,214,198,0.32);
      border-radius: 999px;
      background: repeating-linear-gradient(90deg, rgba(66,214,198,0.18) 0 2px, transparent 2px 14px);
      opacity: 0.38;
      transform: rotate(-7deg);
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 16px;
      color: var(--gold);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }
    .eyebrow::before {
      content: "";
      width: 34px;
      height: 2px;
      background: linear-gradient(90deg, var(--gold), transparent);
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 {
      margin-bottom: 12px;
      font-size: clamp(32px, 6vw, 64px);
      line-height: 0.98;
      letter-spacing: -0.06em;
      max-width: 780px;
      font-weight: 900;
    }
    .hero p {
      max-width: 760px;
      margin-bottom: 0;
      color: #aec0ba;
      line-height: 1.8;
      font-size: 15px;
    }
    .command-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 1px;
      background: var(--line);
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .metric {
      min-height: 118px;
      padding: 20px 22px;
      background: rgba(8, 18, 17, 0.88);
      position: relative;
      overflow: hidden;
    }
    .metric::after {
      content: "";
      position: absolute;
      right: -28px;
      bottom: -36px;
      width: 92px;
      height: 92px;
      border-radius: 50%;
      background: var(--cyan-soft);
      filter: blur(2px);
    }
    .metric b { display: block; margin-bottom: 10px; color: var(--muted); font-size: 12px; letter-spacing: 0.14em; }
    .metric strong { display: block; font-size: 26px; letter-spacing: -0.03em; }
    .metric span { display: block; margin-top: 8px; color: var(--muted); font-size: 13px; }

    .content {
      display: grid;
      grid-template-columns: minmax(0, 1.08fr) minmax(320px, 0.92fr);
      gap: 18px;
      padding: 18px;
    }
    .card {
      position: relative;
      border: 1px solid var(--line);
      border-radius: 22px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.038), transparent),
        var(--panel);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 0 18px 54px rgba(0,0,0,0.18);
      padding: 22px;
      overflow: hidden;
    }
    .card.full { grid-column: 1 / -1; }
    .card.accent::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 3px;
      background: linear-gradient(180deg, var(--gold), var(--cyan));
    }
    .card h2 {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 16px;
      font-size: 18px;
      letter-spacing: -0.02em;
    }
    .card h2::before {
      content: "";
      width: 11px;
      height: 11px;
      border: 1px solid var(--gold);
      background: var(--gold-soft);
      transform: rotate(45deg);
      box-shadow: 0 0 20px rgba(230,180,81,0.42);
    }
    .muted { color: var(--muted); }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 800;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.045);
    }
    .status::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--danger);
      box-shadow: 0 0 18px currentColor;
    }
    .status.ok { color: var(--cyan); border-color: rgba(66,214,198,0.38); background: var(--cyan-soft); }
    .status.ok::before { background: var(--cyan); }
    .status.warn { color: var(--gold); border-color: rgba(230,180,81,0.38); background: var(--gold-soft); }
    .status.warn::before { background: var(--gold); }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .stack { display: grid; gap: 18px; }
    .steps {
      display: grid;
      gap: 12px;
      padding: 0;
      margin: 0;
      list-style: none;
      counter-reset: step;
    }
    .steps li {
      counter-increment: step;
      display: grid;
      grid-template-columns: 34px 1fr;
      gap: 12px;
      align-items: start;
      padding: 13px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255,255,255,0.035);
    }
    .steps li::before {
      content: counter(step, decimal-leading-zero);
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border-radius: 11px;
      color: var(--gold);
      background: var(--gold-soft);
      font-size: 12px;
      font-weight: 900;
    }
    .steps strong { display: block; margin-bottom: 5px; }

    input, select {
      min-height: 40px;
      border: 1px solid rgba(143,162,155,0.34);
      border-radius: 12px;
      padding: 9px 11px;
      color: var(--text);
      background: rgba(2, 8, 8, 0.58);
      outline: none;
      transition: border-color .18s ease, box-shadow .18s ease, background .18s ease;
    }
    input:focus, select:focus {
      border-color: var(--cyan);
      box-shadow: 0 0 0 3px rgba(66,214,198,0.12);
      background: rgba(2, 10, 10, 0.86);
    }
    input::placeholder { color: #64766f; }
    button {
      min-height: 40px;
      border: 1px solid rgba(230,180,81,0.44);
      border-radius: 12px;
      padding: 9px 14px;
      color: #130f07;
      background: linear-gradient(180deg, #f0c66b, #c8912f);
      box-shadow: 0 10px 28px rgba(230,180,81,0.14), inset 0 1px 0 rgba(255,255,255,0.36);
      font-weight: 900;
      cursor: pointer;
      transition: transform .18s ease, filter .18s ease, box-shadow .18s ease;
    }
    button:hover { transform: translateY(-1px); filter: brightness(1.06); box-shadow: 0 14px 34px rgba(230,180,81,0.2); }
    button.secondary {
      color: var(--text);
      border-color: rgba(66,214,198,0.36);
      background: linear-gradient(180deg, rgba(66,214,198,0.2), rgba(66,214,198,0.08));
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
    }
    button.placeholder {
      color: #6f7d78;
      border-color: rgba(143,162,155,0.18);
      background: rgba(255,255,255,0.04);
      cursor: not-allowed;
      box-shadow: none;
    }
    button.placeholder:hover { transform: none; filter: none; }

    .table-wrap {
      margin-top: 16px;
      border: 1px solid var(--line);
      border-radius: 18px;
      overflow: auto;
      background: rgba(0,0,0,0.18);
    }
    table { width: 100%; border-collapse: collapse; min-width: 760px; font-size: 13px; }
    th, td { padding: 12px 12px; border-bottom: 1px solid rgba(143,162,155,0.16); text-align: left; vertical-align: middle; }
    th {
      color: #bfd0ca;
      background: rgba(255,255,255,0.045);
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    tr:last-child td { border-bottom: 0; }
    tr:hover td { background: rgba(66,214,198,0.035); }
    code, pre {
      font-family: "JetBrains Mono", "Cascadia Code", "SFMono-Regular", monospace;
      border-radius: 9px;
      color: #cdeee9;
      background: rgba(66,214,198,0.1);
    }
    code { padding: 2px 6px; }
    pre {
      margin: 0;
      padding: 16px;
      overflow: auto;
      white-space: pre-wrap;
      line-height: 1.6;
      border: 1px solid rgba(66,214,198,0.16);
    }
    .result-panel pre {
      min-height: 168px;
      background:
        linear-gradient(180deg, rgba(66,214,198,0.12), rgba(230,180,81,0.06)),
        rgba(2,8,8,0.76);
    }
    .empty {
      margin-top: 16px;
      border: 1px dashed rgba(230,180,81,0.36);
      border-radius: 18px;
      padding: 22px;
      color: #c6b48c;
      background: rgba(230,180,81,0.07);
    }
    .discovery-line {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin: 12px 0 0;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      border: 1px solid rgba(66,214,198,0.24);
      border-radius: 999px;
      padding: 4px 9px;
      color: #bfe9e4;
      background: rgba(66,214,198,0.08);
      font-size: 12px;
    }

    @media (max-width: 900px) {
      .command-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .content { grid-template-columns: 1fr; }
      .hero::after { display: none; }
    }
    @media (max-width: 560px) {
      main { width: min(100% - 18px, 1180px); padding-top: 9px; }
      .shell { border-radius: 20px; }
      .command-strip { grid-template-columns: 1fr; }
      .content { padding: 10px; }
      .card { padding: 16px; border-radius: 18px; }
      input { width: 100%; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <div class="shell">
      <header class="hero">
        <p class="eyebrow">Operations Console</p>
        <h1>ChatGPT to Claude 运维控制台</h1>
        <p>面向本地联调与 mock 阶段的单文件管理后台。这里集中处理开发 Key、账号池、模型别名与请求示例，保持轻量、可读、可直接部署。</p>
      </header>

      <section class="command-strip" aria-label="运行状态概览">
        <div class="metric"><b>授权链路</b><strong id="key-state-metric">${escapeHtml(keyState)}</strong><span>ENV 与运行时 Key 合并判定</span></div>
        <div class="metric"><b>默认端点</b><strong>${escapeHtml(setupStatus.defaultEndpoint)}</strong><span>Claude 兼容消息入口</span></div>
        <div class="metric"><b>推理强度</b><strong>${escapeHtml(setupStatus.defaultReasoningEffort)}</strong><span>全局 fallback reasoning_effort</span></div>
        <div class="metric"><b>响应速度</b><strong>${escapeHtml(setupStatus.defaultResponseSpeed)}</strong><span>全局 fallback response_speed</span></div>
      </section>

      <div class="content">
        <section class="card accent">
          <h2>授权状态</h2>
          <p>API Key 配置状态：<span id="key-state" class="status ${keyTone}">${escapeHtml(keyState)}</span></p>
          <p class="muted">当前 backend：<code>${escapeHtml(setupStatus.backend.provider)}</code>。开发 Key 存于当前进程内存，重启后失效；session backend 需要先导入 ChatGPT session 账号。</p>
          <div class="row">
            <button id="dev-enable">启用开发 Key</button>
          </div>
        </section>

        <aside class="card">
          <h2>步骤引导</h2>
          <ol class="steps">
            <li><div><strong>初始化访问凭据</strong><span class="muted">点击启用开发 Key，或在环境变量中配置 API_KEYS。</span></div></li>
            <li><div><strong>准备 mock 账号池</strong><span class="muted">添加账号后可执行健康检查，验证并发状态回收。</span></div></li>
            <li><div><strong>校准模型映射</strong><span class="muted">刷新 discovery，再保存 alias 到 backend model 的绑定。</span></div></li>
            <li><div><strong>发起兼容请求</strong><span class="muted">复制下方 curl 示例，origin 会按当前页面自动生成。</span></div></li>
          </ol>
        </aside>

        <section class="card full">
          <h2>账号池</h2>
          <div class="row">
            <input id="account-label" placeholder="账号标识" value="Mock ChatGPT Account" />
            <input id="account-concurrency" type="number" min="1" value="1" aria-label="最大并发" />
            <button id="add-account">添加 mock 账号</button>
          </div>
          <div class="row" style="margin-top:12px">
            <input id="session-label" placeholder="ChatGPT session 标识" value="ChatGPT Session Account" />
            <input id="session-access-token" placeholder="accessToken" />
            <input id="session-cookie" placeholder="cookie（可选）" />
            <input id="session-device-id" placeholder="deviceId（可选）" />
            <input id="session-user-agent" placeholder="userAgent（可选）" />
            <button id="add-session-account" class="secondary">导入 ChatGPT session</button>
          </div>
          <div id="accounts"><div class="empty">正在读取账号池状态。</div></div>
        </section>

        <section class="card full">
          <h2>模型映射</h2>
          <p class="muted">后端模型来自 discovery；alias overlay 负责映射、启用状态与缺省 reasoning_effort / response_speed。</p>
          <div class="row"><button id="reset-models" class="secondary">重置 alias overlay</button><button id="refresh-models" class="secondary">刷新 backend discovery</button></div>
          <div id="models"><div class="empty">正在加载模型映射。</div></div>
        </section>

        <section class="card result-panel">
          <h2>结果面板</h2>
          <pre id="result">${escapeHtml(setupStatus.nextStep)}</pre>
        </section>

        <section class="card">
          <h2>curl 示例</h2>
          <p class="muted">示例地址由浏览器根据当前页面 origin 生成；PORT=3100 时会显示 3100，不再写死 localhost:3000。</p>
          <pre id="curl-example" data-template="${escapeHtml(curlTemplate)}">${escapeHtml(curlTemplate)}</pre>
        </section>
      </div>
    </div>
  </main>
  <script>
    const effortOptions = ['off', 'minimal', 'low', 'medium', 'high', 'max'];
    const speedOptions = ['fastest', 'fast', 'balanced', 'quality'];

    const curlExample = document.getElementById('curl-example');
    curlExample.textContent = curlExample.dataset.template.replace('__ORIGIN__', window.location.origin);

    document.getElementById('dev-enable').addEventListener('click', async () => {
      const body = await postJson('/admin/api/api-keys/dev-enable');
      if (body.status) {
        const configured = body.status.apiKeysConfigured;
        const label = configured ? '已配置' : '待初始化';
        const keyState = document.getElementById('key-state');
        keyState.textContent = label;
        keyState.className = 'status ' + (configured ? 'ok' : 'warn');
        document.getElementById('key-state-metric').textContent = label;
      }
      document.getElementById('result').textContent = body.key ? '开发 Key 已生成：' + body.key + '\n\n请在 /v1/* 请求中使用 x-api-key。该 Key 仅在当前进程内有效。\n\n' + JSON.stringify(body, null, 2) : JSON.stringify(body, null, 2);
    });

    document.getElementById('add-account').addEventListener('click', async () => {
      const label = document.getElementById('account-label').value;
      const maxConcurrency = Number(document.getElementById('account-concurrency').value || 1);
      const body = await postJson('/admin/api/accounts', { provider: 'mock', label, maxConcurrency, capabilities: ['mock', 'messages'] });
      document.getElementById('result').textContent = JSON.stringify(body, null, 2);
      await loadAccounts();
    });

    document.getElementById('add-session-account').addEventListener('click', async () => {
      const label = document.getElementById('session-label').value;
      const accessToken = document.getElementById('session-access-token').value;
      const cookie = document.getElementById('session-cookie').value;
      const deviceId = document.getElementById('session-device-id').value;
      const userAgent = document.getElementById('session-user-agent').value;
      const body = await postJson('/admin/api/accounts', { provider: 'chatgpt-session', label, capabilities: ['chatgpt-session', 'messages'], secret: { type: 'chatgpt-session', accessToken, cookie, deviceId, userAgent } });
      document.getElementById('result').textContent = JSON.stringify(body, null, 2);
      await loadAccounts();
    });

    document.getElementById('reset-models').addEventListener('click', async () => {
      const body = await postJson('/admin/api/models/reset');
      document.getElementById('result').textContent = JSON.stringify(body, null, 2);
      await loadModels();
    });
    document.getElementById('refresh-models').addEventListener('click', async () => {
      const body = await postJson('/admin/api/models/refresh');
      document.getElementById('result').textContent = JSON.stringify(body, null, 2);
      await loadModels();
    });

    async function loadAccounts() {
      const body = await getJson('/admin/api/accounts');
      const accounts = body.accounts || [];
      if (!accounts.length) {
        document.getElementById('accounts').innerHTML = '<div class="empty">账号池为空。添加一个 mock 账号后，可在这里查看状态、并发与健康检查结果。</div>';
        return;
      }
      document.getElementById('accounts').innerHTML = '<div class="table-wrap"><table><thead><tr><th>ID</th><th>标识</th><th>Provider</th><th>状态</th><th>并发</th><th>Secret</th><th>最近使用</th><th>能力</th><th>操作</th></tr></thead><tbody>' + accounts.map((account) =>
        '<tr><td><code>' + esc(account.id) + '</code></td><td>' + esc(account.label) + '</td><td>' + esc(account.provider || 'mock') + '</td><td><span class="pill">' + esc(account.status) + (account.enabled ? '' : ' / disabled') + '</span></td><td>' + account.currentConcurrency + '/' + account.maxConcurrency + '</td><td>' + (account.hasSecret ? '已导入' : '-') + '</td><td>' + esc(account.lastUsedAt || '-') + '</td><td>' + esc((account.capabilities || []).join(', ')) + '</td><td><button class="secondary" data-health="' + esc(account.id) + '">健康检查</button></td></tr>'
      ).join('') + '</tbody></table></div>';
      document.querySelectorAll('[data-health]').forEach((button) => button.addEventListener('click', async () => {
        const body = await postJson('/admin/api/accounts/' + encodeURIComponent(button.dataset.health) + '/health-check');
        document.getElementById('result').textContent = JSON.stringify(body, null, 2);
        await loadAccounts();
      }));
    }

    async function loadModels() {
      const body = await getJson('/admin/api/models');
      const aliases = body.aliases || body.models || [];
      const discovered = body.discovered || [];
      const discoveryHtml = discovered.length
        ? '<div class="discovery-line">' + discovered.map((model) => '<span class="pill">' + esc(model.id) + '</span>').join('') + '</div>'
        : '<div class="empty">Backend discovery 暂无模型。</div>';
      if (!aliases.length) {
        document.getElementById('models').innerHTML = discoveryHtml + '<div class="empty">暂无 alias overlay。请刷新 backend discovery 或检查 MODEL_REGISTRY_JSON。</div>';
        return;
      }
      document.getElementById('models').innerHTML = '<p class="muted">Backend discovery</p>' + discoveryHtml + '<div class="table-wrap"><table><thead><tr><th>Alias</th><th>Backend Model</th><th>状态</th><th>启用</th><th>默认参数</th><th>操作</th></tr></thead><tbody>' + aliases.map((model) =>
        '<tr><td><code>' + esc(model.id) + '</code></td><td><input data-field="backendModel" data-id="' + esc(model.id) + '" value="' + esc(model.backendModel || '') + '" /></td><td><span class="pill">' + esc(model.status || '-') + '</span></td><td><input type="checkbox" data-field="enabled" data-id="' + esc(model.id) + '" ' + (model.enabled ? 'checked' : '') + ' /></td><td>' + selectHtml(model.id, 'reasoning_effort', effortOptions, model.defaults.reasoning_effort) + ' ' + selectHtml(model.id, 'speed', speedOptions, model.defaults.speed) + '</td><td><button data-save-model="' + esc(model.id) + '">保存</button></td></tr>'
      ).join('') + '</tbody></table></div>';
      document.querySelectorAll('[data-save-model]').forEach((button) => button.addEventListener('click', async () => saveModel(button.dataset.saveModel)));
    }

    async function saveModel(id) {
      const byField = (field) => document.querySelector('[data-id="' + CSS.escape(id) + '"][data-field="' + field + '"]');
      const body = await patchJson('/admin/api/models/' + encodeURIComponent(id), {
        backendModel: byField('backendModel').value,
        enabled: byField('enabled').checked,
        defaults: { reasoning_effort: byField('reasoning_effort').value, speed: byField('speed').value },
      });
      document.getElementById('result').textContent = JSON.stringify(body, null, 2);
      await loadModels();
    }

    function selectHtml(id, field, options, current) {
      return '<select data-field="' + field + '" data-id="' + esc(id) + '">' + options.map((option) => '<option value="' + option + '" ' + (option === current ? 'selected' : '') + '>' + option + '</option>').join('') + '</select>';
    }
    async function getJson(url) { return (await fetch(url)).json(); }
    async function postJson(url, body) { return (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json(); }
    async function patchJson(url, body) { return (await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); }
    function esc(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
    loadAccounts();
    loadModels();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
