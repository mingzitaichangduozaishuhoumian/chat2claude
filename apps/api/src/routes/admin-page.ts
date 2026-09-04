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
  -d '{"model":"sonnet","max_tokens":128,"messages":[{"role":"user","content":"你好"}]}'`;
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
      <div class="brand"><span class="eyebrow">Local operations console</span><h1>chat2claude 个人自托管控制台</h1><p>用于本人控制或已获明确授权的 ChatGPT/Codex 账号。认证生命周期与 provider 配额观测相互独立，禁止用于公开转售订阅流量或面向不特定第三方的大规模共享。</p></div>
      <div class="mode-toggle" role="group" aria-label="管理界面模式"><button id="mode-simple" type="button" aria-pressed="true">简洁模式</button><button id="mode-professional" type="button" aria-pressed="false">专业模式</button></div>
    </header>

    <div class="workspace">
      <nav class="module-nav" aria-label="Admin 模块" role="tablist">
        <button id="authentication-tab" type="button" role="tab" data-index="01" data-admin-module="authentication" aria-controls="authentication-module" aria-selected="true" tabindex="0">认证管理</button>
        <button id="quota-tab" type="button" role="tab" data-index="02" data-admin-module="quota" aria-controls="quota-module" aria-selected="false" tabindex="-1">配额管理</button>
      </nav>

      <div class="modules">
        <section id="authentication-module" class="admin-module" data-module-name="authentication" role="tabpanel" aria-labelledby="authentication-tab">
          <header class="module-header"><div><span class="eyebrow">Module 01</span><h2 id="authentication-module-title">认证管理</h2><p>管理 ChatGPT OAuth、账号健康、动态模型、并发设置和 Runtime API Key。普通流程只需浏览器授权；手动凭据导入始终是折叠的高级备用入口。</p></div><button id="auth-chatgpt" type="button">添加 ChatGPT 账号</button></header>

          <div class="oauth-layout">
            <section class="panel" aria-labelledby="oauth-title">
              <div class="panel-heading"><div><h3 id="oauth-title">浏览器授权（Codex OAuth）</h3><p class="muted">不会启动独立 Chrome/新 profile；主按钮会在当前浏览器打开授权页。</p></div><span id="key-state" class="state-badge neutral">${escapeHtml(keyState)}</span></div>
              <div id="admin-session-state" class="session-strip" role="status" aria-live="polite"><span class="state-badge neutral">检测中</span><div><strong>正在验证本地管理会话</strong><span class="muted">本机可信访问会自动使用 HttpOnly 浏览器会话；无需 Admin API Key。</span></div></div>
              <details id="admin-key-fallback"><summary>远程访问或自动化：使用显式 Admin API Key</summary><p class="muted">Key 默认只保留在当前页面；勾选后才明确保存到此浏览器（localStorage）。</p><div class="row"><input id="admin-api-key" type="password" placeholder="Admin API Key" autocomplete="off" aria-label="Admin API Key" /><button id="save-admin-api-key" class="secondary" type="button">仅本页启用 Key</button></div><label><input id="remember-admin-api-key" type="checkbox" /> 明确保存到此浏览器（localStorage）</label></details>
              <p class="muted">当前 backend：<code>${escapeHtml(setupStatus.backend.provider)}</code></p>
              <div class="oauth-actions"><button id="auth-chatgpt-inline" type="button" onclick="document.getElementById('auth-chatgpt').click()">授权 ChatGPT</button><button id="cancel-auth" class="secondary" type="button" disabled>取消</button></div>
              <p id="auth-message" class="muted" role="status" aria-live="polite">${escapeHtml(setupStatus.nextStep)}</p>
              <div id="auth-link-area" class="auth-link-area" hidden><div class="auth-link-row"><a id="auth-link" class="pill" target="_blank" rel="noopener noreferrer" hidden>打开 Codex OAuth 授权页</a><button id="copy-auth-link" class="secondary" type="button" hidden>复制授权链接</button></div><code id="auth-url-display" class="auth-url-display" hidden></code></div>
              <div class="stack"><p class="muted">如果授权完成后浏览器显示无法连接本地 callback（默认 1455，必要时自动使用 1457），请原样复制地址栏完整 URL。</p><div class="oauth-callback-row"><input id="oauth-callback-url" aria-label="OAuth callback URL（请粘贴完整 callback URL）" placeholder="粘贴完整 localhost callback URL" /><button id="submit-oauth-callback" class="secondary" type="button">提交 callback URL</button></div></div>
            </section>
            <aside class="panel"><h3>正常流程</h3><ol class="steps"><li><div><strong>浏览器授权</strong><span class="muted">点击后打开 Codex OAuth；链接可点击打开，也可复制。</span></div></li><li><div><strong>自动初始化</strong><span class="muted">创建账号、检查健康并刷新该账号动态模型。</span></div></li><li><div><strong>保存 Runtime Key</strong><span class="muted">原始 Key 仅在首次生成时显示一次。</span></div></li></ol></aside>
          </div>

          <section class="panel" aria-labelledby="accounts-title"><div class="panel-heading"><div><h3 id="accounts-title">认证账号</h3><p class="muted"><span class="sr-only">个人账号池（高级）</span>简洁模式展示身份、套餐、启用、健康、请求结果、最近活动和模型数；专业模式增加内部诊断字段与完整动态模型。</p></div></div><div id="accounts"><div class="empty">正在读取账号状态。</div></div></section>

          <section class="panel"><details id="advanced-import"><summary>高级：手动导入 accessToken / cookie</summary><p class="muted">这不是正常流程。仅在 OAuth 无法使用或已有 session secret 时展开；表单不会返回 token/cookie。</p><div class="stack"><label>导入模式<select id="manual-mode"><option value="add">新增账号</option><option value="reauthorize">重新授权已有账号</option></select></label><label>目标账号<select id="manual-account-id" disabled><option value="">请选择 session 账号</option></select></label><label>Access Token<input id="session-access-token" type="password" autocomplete="off" /></label><label>Cookie（可选）<input id="session-cookie" type="password" autocomplete="off" /></label><label>Device ID（可选）<input id="session-device-id" /></label><label>User Agent（可选）<input id="session-user-agent" /></label><button id="manual-complete" class="secondary" type="button">导入并初始化</button></div></details></section>

          <section class="panel"><h3>内置模型 Alias</h3><p class="muted">Sonnet 会在首次授权时自动选择后端。Haiku、Fable 和 Opus 如显示“未绑定”，需要切换到专业模式选择后端模型后才能调用。</p><div id="model-availability"><div class="empty">正在读取 alias 状态。</div></div></section>

          <section class="panel"><div class="panel-heading"><div><h3>Runtime API Keys</h3><p class="muted">客户端调用 <code>/v1/*</code> 使用的 Key，不是 Admin API Key。当前 <strong id="api-keys-count">0</strong> 个；这里只显示安全前缀。</p></div><button id="refresh-api-keys" class="secondary" type="button">刷新 Key 列表</button></div><div id="api-keys"><div class="empty">正在读取 Runtime API Key。</div></div></section>

          <section class="panel professional-panel" data-professional-only><div class="panel-heading"><div><h3>模型映射（高级管理）</h3><p class="muted">选项仅来自 backend discovery，不硬编码 provider 模型 ID 或速度倍率。</p></div><div class="row"><button id="reset-models" class="secondary" type="button">重置 alias overlay</button><button id="refresh-models" class="secondary" type="button">刷新 backend discovery</button></div></div><form id="create-model-form" class="row"><input id="model-alias-id" required pattern="[a-zA-Z0-9._-]+" placeholder="新 alias，例如 research" aria-label="新模型 alias" /><input id="model-display-name" placeholder="显示名称（可选）" aria-label="模型显示名称" /><select id="model-backend" aria-label="Backend model"><option value="">未绑定（可选）</option></select><button type="submit">创建自定义 alias</button></form><div id="models"><div class="empty">正在加载模型映射。</div></div></section>

          <section id="api-config" class="panel" hidden><h3>API 配置</h3><div class="stack"><p>Endpoint：<code id="endpoint"></code></p><div id="one-time-key-row" hidden><p>新生成的 Runtime API Key（仅本次显示）：<code id="api-key"></code> <button id="copy-runtime-api-key" class="secondary" type="button">复制 Runtime API Key</button></p></div><p id="existing-key-row" class="muted" hidden>现有 Runtime API Key 保持有效；本次不会再次显示原始值。</p><pre id="ready-curl"></pre></div></section>

          <div class="utility-grid"><section class="panel"><h3>结果面板</h3><pre id="result" role="status" aria-live="polite">${escapeHtml(setupStatus.nextStep)}</pre></section><section class="panel"><h3>curl 示例</h3><p class="muted">示例地址由当前页面 origin 生成。</p><pre id="curl-example" data-template="${escapeHtml(curlTemplate)}">${escapeHtml(curlTemplate)}</pre></section></div>
        </section>

        <section id="quota-module" class="admin-module" data-module-name="quota" role="tabpanel" aria-labelledby="quota-tab" hidden>
          <header class="module-header"><div><span class="eyebrow">Module 02</span><h2 id="quota-module-title">配额管理</h2><p>独立读取 ChatGPT provider 返回的 allowance 与时间窗口。五小时和每周窗口只按返回时长识别；其他 meter 原样逐项展示，缺失不会显示为 0%。</p></div><button id="refresh-all-quotas" type="button">刷新全部配额</button></header>
          <section class="panel"><div class="panel-heading"><div><h3>Provider 配额</h3><p class="muted">页面首次加载只读取缓存，不触发上游请求。刷新操作按账号去重；批量刷新允许部分成功。</p></div></div><div id="quotas"><div class="empty">正在读取配额缓存。</div></div></section>
        </section>
      </div>
    </div>
  </main>
  <script>${adminPageClientScript()}</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
