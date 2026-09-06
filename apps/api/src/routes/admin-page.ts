import { ADMIN_PAGE_STYLES } from './admin-page-styles.js';
import { adminPageClientScript } from './admin-page-client.js';

interface AdminSetupStatus {
  apiKeysConfigured: boolean;
  defaultReasoningEffort: string;
  defaultResponseSpeed: string;
  backend: { provider: string };
  nextStep: string;
}

export function renderAdminPage(setupStatus: AdminSetupStatus): string {
  const keyState = setupStatus.apiKeysConfigured ? '已配置' : '待初始化';
  const curlTemplate = `curl __ORIGIN__/v1/messages \\
  -H 'content-type: application/json' \\
  -H 'x-api-key: <your-api-key>' \\
  -d '{"model":"sonnet","max_tokens":128,"messages":[{"role":"user","content":"Hello"}]}'`;
  return `<!doctype html>
<html lang="zh-CN" data-admin-mode="simple">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>chat2claude 个人自托管控制台</title>
  <style>${ADMIN_PAGE_STYLES}</style>
</head>
<body>
  <div id="global-live-region" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
  <main class="admin-shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark" aria-hidden="true">c2c</span><div><h1>chat2claude</h1><span class="muted">个人自托管控制台</span></div></div>
      <div class="console-controls"><div class="mode-toggle" role="group" aria-label="界面语言"><button id="locale-zh-CN" type="button" lang="zh-CN" aria-pressed="true">简体中文</button><button id="locale-en" type="button" lang="en" aria-pressed="false">English</button></div><div class="mode-toggle" role="group" aria-label="管理界面模式"><button id="mode-simple" type="button" aria-pressed="true">简洁模式</button><button id="mode-professional" type="button" aria-pressed="false">专业模式</button></div></div>
    </header>

    <div class="workspace">
      <nav class="module-nav" aria-label="Admin 模块" role="tablist">
        <span class="nav-group" role="presentation">运行</span>
        <button id="overview-tab" type="button" role="tab" data-index="01" data-admin-module="overview" aria-controls="overview-module" aria-selected="true" tabindex="0" data-i18n="概览">概览</button>
        <button id="authentication-tab" type="button" role="tab" data-index="02" data-admin-module="authentication" aria-controls="authentication-module" aria-selected="false" tabindex="-1" data-i18n="账号与授权">账号与授权</button>
        <span class="nav-group" role="presentation">网关</span>
        <button id="models-tab" type="button" role="tab" data-index="03" data-admin-module="models" aria-controls="models-module" aria-selected="false" tabindex="-1" data-i18n="模型映射">模型映射</button>
        <button id="api-access-tab" type="button" role="tab" data-index="04" data-admin-module="api-access" aria-controls="api-access-module" aria-selected="false" tabindex="-1" data-i18n="API 接入">API 接入</button>
        <span class="nav-group" role="presentation">观测</span>
        <button id="quota-tab" type="button" role="tab" data-index="05" data-admin-module="quota" aria-controls="quota-module" aria-selected="false" tabindex="-1" data-i18n="配额">配额</button>
        <span class="nav-group" role="presentation">管理</span>
        <button id="admin-access-tab" type="button" role="tab" data-index="06" data-admin-module="admin-access" aria-controls="admin-access-module" aria-selected="false" tabindex="-1" data-i18n="管理访问">管理访问</button>
      </nav>

      <div class="modules">
        <section id="overview-module" class="admin-module" data-module-name="overview" role="tabpanel" aria-labelledby="overview-tab">
          <header class="module-header"><div><span class="eyebrow">01 / OVERVIEW</span><h2>概览</h2><p>来自现有缓存的运行摘要。最近账号活动不是完整请求日志。</p></div></header>
          <div id="overview" aria-live="polite"><div class="empty">正在读取运行摘要。</div></div>
        </section>

        <section id="authentication-module" class="admin-module" data-module-name="authentication" role="tabpanel" aria-labelledby="authentication-tab" hidden>
          <header class="module-header"><div><span class="eyebrow">02 / ACCOUNTS</span><h2 id="authentication-module-title">账号与授权</h2><p>管理浏览器授权与账号健康。手动凭据导入仅作为专业模式的备用入口。</p></div><button id="auth-chatgpt" type="button">添加 ChatGPT 账号</button></header>

          <div class="oauth-layout">
            <section class="panel" aria-labelledby="oauth-title">
              <div class="panel-heading"><div><h3 id="oauth-title">浏览器授权（Codex OAuth）</h3><p class="muted">不会启动独立 Chrome/新 profile；主按钮会在当前浏览器打开授权页。</p></div><span id="key-state" class="state-badge neutral">${escapeHtml(keyState)}</span></div>

              <p class="muted">当前 backend：<code>${escapeHtml(setupStatus.backend.provider)}</code></p>
              <div class="oauth-actions"><button id="auth-chatgpt-inline" type="button" onclick="document.getElementById('auth-chatgpt').click()">授权 ChatGPT</button><button id="cancel-auth" class="secondary" type="button" disabled>取消</button></div>
              <p id="auth-message" class="muted" role="status" aria-live="polite">${escapeHtml(setupStatus.nextStep)}</p>
              <div id="auth-link-area" class="auth-link-area" hidden><div class="auth-link-row"><a id="auth-link" class="pill" target="_blank" rel="noopener noreferrer" hidden>打开 Codex OAuth 授权页</a><button id="copy-auth-link" class="secondary" type="button" hidden>复制授权链接</button></div><code id="auth-url-display" class="auth-url-display" hidden></code></div>
              <div class="stack"><p class="muted">如果授权完成后浏览器显示无法连接本地 callback（默认 1455，必要时自动使用 1457），请原样复制地址栏完整 URL。</p><div class="oauth-callback-row"><input id="oauth-callback-url" aria-label="OAuth callback URL（请粘贴完整 callback URL）" placeholder="粘贴完整 localhost callback URL" /><button id="submit-oauth-callback" class="secondary" type="button">提交 callback URL</button></div></div>
            </section>
            <aside class="panel"><h3>正常流程</h3><ol class="steps"><li><div><strong>浏览器授权</strong><span class="muted">点击后打开 Codex OAuth；链接可点击打开，也可复制。</span></div></li><li><div><strong>自动初始化</strong><span class="muted">创建账号、检查健康并刷新该账号动态模型。</span></div></li><li><div><strong>保存 Runtime Key</strong><span class="muted">原始 Key 仅在首次生成时显示一次。</span></div></li></ol></aside>
          </div>

          <section class="panel" aria-labelledby="accounts-title"><div class="panel-heading"><div><h3 id="accounts-title">认证账号</h3><p class="muted"><span class="sr-only">个人账号池（高级）</span>简洁模式展示身份、套餐、启用、健康、请求结果、最近活动和模型数；专业模式增加内部诊断字段与完整动态模型。</p></div></div><div id="accounts"><div class="empty">正在读取账号状态。</div></div></section>

          <section class="panel" data-professional-only><details id="advanced-import"><summary>高级：手动导入 accessToken / cookie</summary><p class="muted">这不是正常流程。仅在 OAuth 无法使用或已有 session secret 时展开；表单不会返回 token/cookie。</p><div class="stack"><label>导入模式<select id="manual-mode"><option value="add">新增账号</option><option value="reauthorize">重新授权已有账号</option></select></label><label>目标账号<select id="manual-account-id" disabled><option value="">请选择 session 账号</option></select></label><label>Access Token<input id="session-access-token" type="password" autocomplete="off" /></label><label>Cookie（可选）<input id="session-cookie" type="password" autocomplete="off" /></label><label>Device ID（可选）<input id="session-device-id" /></label><label>User Agent（可选）<input id="session-user-agent" /></label><button id="manual-complete" class="secondary" type="button">导入并初始化</button></div></details></section>

        </section>

        <section id="quota-module" class="admin-module" data-module-name="quota" role="tabpanel" aria-labelledby="quota-tab" hidden>
          <header class="module-header"><div><span class="eyebrow">05 / QUOTAS</span><h2 id="quota-module-title">配额</h2><p>独立读取 ChatGPT provider 返回的 allowance 与时间窗口。五小时和每周窗口只按返回时长识别；其他 meter 原样逐项展示，缺失不会显示为 0%。</p></div><button id="refresh-all-quotas" type="button">刷新全部配额</button></header>
          <section class="panel"><div class="panel-heading"><div><h3>Provider 配额</h3><p class="muted">页面首次加载只读取缓存，不触发上游请求。刷新操作按账号去重；批量刷新允许部分成功。</p></div></div><div id="quotas"><div class="empty">正在读取配额缓存。</div></div></section>
        </section>
        <section id="models-module" class="admin-module" data-module-name="models" role="tabpanel" aria-labelledby="models-tab" hidden>
          <header class="module-header"><div><span class="eyebrow">03 / MODELS</span><h2>模型映射</h2><p>选择已发现的后端模型，并为客户端配置稳定的 alias。</p></div></header>
          <section class="panel"><h3>内置模型 Alias</h3><p class="muted">Sonnet 会在首次授权时自动选择后端。Haiku、Fable 和 Opus 如显示“未绑定”，请在下方模型映射中选择后端模型并保存后再调用；简洁模式即可完成绑定。</p><div id="model-availability"><div class="empty">正在读取 alias 状态。</div></div></section>
          <section class="panel model-mapping-panel"><div class="panel-heading"><div><h3>模型映射</h3><p class="muted">简洁模式可选择 Backend Model、启用并保存；专业模式增加推理、服务层级和自定义 alias 管理。选项仅来自 backend discovery。</p></div><div class="row" data-professional-only><button id="reset-models" class="secondary" type="button" data-professional-only>重置 alias overlay</button><button id="refresh-models" class="secondary" type="button" data-professional-only>刷新 backend discovery</button></div></div><form id="create-model-form" class="row" data-professional-only><input id="model-alias-id" required pattern="[a-zA-Z0-9._-]+" placeholder="新 alias，例如 research" aria-label="新模型 alias" /><input id="model-display-name" placeholder="显示名称（可选）" aria-label="模型显示名称" /><select id="model-backend" aria-label="Backend model"><option value="">未绑定（可选）</option></select><button type="submit">创建自定义 alias</button></form><div id="models"><div class="empty">正在加载模型映射。</div></div></section>
        </section>
        <section id="api-access-module" class="admin-module" data-module-name="api-access" role="tabpanel" aria-labelledby="api-access-tab" hidden>
          <header class="module-header"><div><span class="eyebrow">04 / API ACCESS</span><h2>API 接入</h2><p>使用独立的 Runtime API Key 连接客户端；Base URL 不包含 /v1。</p></div></header>
          <section class="panel" aria-labelledby="runtime-api-keys-title"><div class="panel-heading"><div><h3 id="runtime-api-keys-title">Runtime API Keys</h3><p class="muted">客户端调用 <code>/v1/*</code> 使用的独立凭据，不是 Admin API Key。生成新 Key 不会撤销现有 Key；生成后的 Key 会固定保存，跨浏览器和服务重启保持有效，直至显式撤销。原始值只在本页面本次显示，请立即复制保存。当前 <strong id="api-keys-count">0</strong> 个；列表只显示安全前缀。</p></div><div class="row"><button id="generate-runtime-api-key" type="button">生成新 Key</button><button id="refresh-api-keys" class="secondary" type="button">刷新 Key 列表</button></div></div><div id="runtime-api-key-once" class="one-time-key" hidden><div><strong>新生成的 Runtime API Key（仅本次显示）</strong><code id="api-key"></code><p id="runtime-key-copy-status" class="muted" role="status" aria-live="polite"></p></div><div class="row"><button id="copy-runtime-api-key" class="secondary" type="button">复制 Runtime API Key</button><button id="dismiss-runtime-api-key" class="secondary" type="button">清除显示</button></div></div><div id="api-keys"><div class="empty">正在读取 Runtime API Key。</div></div></section>
          <section id="api-config" class="panel"><h3>API 配置</h3><div class="stack"><p>Endpoint：<code id="endpoint"></code></p><p class="muted">将上方一次性显示的 Runtime API Key 安全保存后，再替换此示例中的占位符。</p><pre id="ready-curl"></pre></div></section>
<section class="panel"><h3>客户端配置</h3><dl class="technical-list"><div><dt>Base URL</dt><dd><code id="base-url"></code></dd></div><div><dt>Claude Code / CC Switch</dt><dd><code>ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN</code></dd></div></dl><p class="muted">将 Base URL 与安全保存的 Runtime API Key 填入客户端，模型可使用 sonnet。</p></section><section class="panel"><h3>curl 示例</h3><p class="muted">示例地址由当前页面 origin 生成。</p><pre id="curl-example" data-template="${escapeHtml(curlTemplate)}">${escapeHtml(curlTemplate)}</pre></section>
        </section>
        <section id="admin-access-module" class="admin-module" data-module-name="admin-access" role="tabpanel" aria-labelledby="admin-access-tab" hidden>
          <header class="module-header"><div><span class="eyebrow">06 / ADMIN ACCESS</span><h2>管理访问</h2><p>本机可信访问自动使用 HttpOnly 会话。远程管理凭据与客户端 Runtime Key 相互独立。</p></div></header>
          <p class="muted">用于本人控制或已获明确授权的 ChatGPT/Codex 账号。认证生命周期与 provider 配额观测相互独立，禁止用于公开转售订阅流量或面向不特定第三方的大规模共享。</p>
<section class="panel">              <div id="admin-session-state" class="session-strip" role="status" aria-live="polite"><span class="state-badge neutral">检测中</span><div><strong>正在验证本地管理会话</strong><span class="muted">本机可信访问会自动使用 HttpOnly 浏览器会话；无需 Admin API Key。</span></div></div>              <details id="admin-key-fallback" data-professional-only><summary>高级：远程管理凭据（Admin API Key）</summary><p class="muted">仅用于远程访问、自动化或本地浏览器会话失效后的管理请求；Key 默认只保留在当前页面，勾选后才明确保存到此浏览器（localStorage）。</p><div class="row"><input id="admin-api-key" type="password" placeholder="Admin API Key" autocomplete="off" aria-label="Admin API Key" /><button id="save-admin-api-key" class="secondary" type="button">仅本页启用 Key</button></div><label><input id="remember-admin-api-key" type="checkbox" /> 明确保存到此浏览器（localStorage）</label></details></section>
        </section>
      </div>
    </div>
    <div class="result-dock"><section class="panel"><h3>结果面板</h3><p id="result-message" role="status" aria-live="polite">${escapeHtml(setupStatus.nextStep)}</p><details data-professional-only><summary>诊断数据</summary><pre id="result" role="status" aria-live="polite" data-i18n-ignore></pre></details></section></div>
  </main>
  <script>${adminPageClientScript()}</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
