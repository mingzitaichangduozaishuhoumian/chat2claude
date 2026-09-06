import { adminPageViewSource } from './admin-page-view.js';
import { adminPageLocaleSource } from './admin-page-locale.js';

export function adminPageClientScript(): string {
  return `${adminPageViewSource()}
let currentFlowId = null;
let pollTimer = null;
let accountsCache = [];
let quotasCache = [];
let modelsCache = { aliases: [], discovered: [] };
let apiKeysCache = [];
const overviewLoadState = { accounts: 'loading', models: 'loading', keys: 'loading' };
let quotaRequestState = { status: 'idle', error: null };
const pendingQuotaAccounts = new Set();
let quotaRefreshAllPending = false;
const curlExample = document.getElementById('curl-example');
curlExample.textContent = curlExample.dataset.template.replace('__ORIGIN__', window.location.origin);
document.getElementById('base-url').textContent = window.location.origin;
document.getElementById('endpoint').textContent = window.location.origin + '/v1/messages';
document.getElementById('ready-curl').textContent = curlExample.textContent;
const adminKeyInput = document.getElementById('admin-api-key');
const rememberAdminKeyInput = document.getElementById('remember-admin-api-key');
const adminKeyFallback = document.getElementById('admin-key-fallback');
const adminSessionState = document.getElementById('admin-session-state');
const globalLiveRegion = document.getElementById('global-live-region');
let pageAdminApiKey = '';
let localAdminSessionActive = false;
const modeButtons = { simple: document.getElementById('mode-simple'), professional: document.getElementById('mode-professional') };
const moduleButtons = document.querySelectorAll('[data-admin-module]');
const modules = document.querySelectorAll('.admin-module');

function renderOverviewPanel() {
  document.getElementById('overview').innerHTML = renderAdminOverview({
    accounts: accountsCache, quotas: quotasCache, models: modelsCache, keyCount: apiKeysCache.length,
    states: { ...overviewLoadState, quotas: quotaRequestState.status }, localSession: localAdminSessionActive,
  });
}
function announce(message) { globalLiveRegion.textContent = message; }
function setAdminMode(mode) {
  const professional = mode === 'professional';
  document.documentElement.dataset.adminMode = professional ? 'professional' : 'simple';
  Object.entries(modeButtons).forEach(([name, button]) => button.setAttribute('aria-pressed', String(name === mode)));
  try { localStorage.setItem('adminViewMode', mode); } catch { /* Keep mode usable without storage. */ }
}
modeButtons.simple.addEventListener('click', () => setAdminMode('simple'));
modeButtons.professional.addEventListener('click', () => setAdminMode('professional'));
let savedAdminMode;
try { savedAdminMode = localStorage.getItem('adminViewMode'); } catch { /* Use simple mode. */ }
setAdminMode(savedAdminMode === 'professional' ? 'professional' : 'simple');

function selectModule(name) {
  const aliases = { accounts: 'authentication', authorization: 'authentication', quotas: 'quota', 'api-config': 'api-access' };
  name = aliases[name] || name;
  if (!Array.from(moduleButtons).some((button) => button.dataset.adminModule === name)) name = 'overview';
  moduleButtons.forEach((button) => {
    const selected = button.dataset.adminModule === name;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  modules.forEach((module) => { module.hidden = module.dataset.moduleName !== name; });
  history.replaceState(history.state, '', '#' + name);
}
function focusModuleTab(index) {
  const button = moduleButtons[index];
  if (!button) return;
  selectModule(button.dataset.adminModule);
  button.focus();
}
moduleButtons.forEach((button, index) => {
  button.addEventListener('click', () => selectModule(button.dataset.adminModule));
  button.addEventListener('keydown', (event) => {
    const lastIndex = moduleButtons.length - 1;
    let targetIndex;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') targetIndex = index === lastIndex ? 0 : index + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') targetIndex = index === 0 ? lastIndex : index - 1;
    else if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = lastIndex;
    else return;
    event.preventDefault();
    focusModuleTab(targetIndex);
  });
});
selectModule(location.hash.slice(1));
window.addEventListener('hashchange', () => selectModule(location.hash.slice(1)));

document.getElementById('save-admin-api-key').addEventListener('click', async () => {
  saveAdminApiKey(adminKeyInput.value.trim(), rememberAdminKeyInput.checked);
  const key = adminKeyInput.value.trim();
  renderResult({ message: key ? (rememberAdminKeyInput.checked ? 'Admin API Key 已明确保存到此浏览器。' : 'Admin API Key 仅在当前页面启用；刷新或关闭后不会保留。') : 'Admin API Key 已清除。' });
  if (key) await Promise.all([loadAccounts(), loadApiKeys(), loadModels(), loadQuotas()]);
});

const oauthFlowStorageKey = 'chat2claude.oauthFlow';
captureOAuthFlowFromQuery();
document.getElementById('auth-chatgpt').addEventListener('click', () => startOAuthFlow('add'));
async function startOAuthFlow(mode, accountId) {
  const popup = window.open('about:blank', '_blank');
  try {
    const body = await postJson('/admin/api/auth/chatgpt/start', { adminOrigin: window.location.origin, mode: mode, accountId: accountId });
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
}
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
document.getElementById('copy-runtime-api-key').addEventListener('click', () => { void copyOneTimeRuntimeApiKey(); });
document.getElementById('dismiss-runtime-api-key').addEventListener('click', () => {
  clearOneTimeRuntimeApiKey();
  renderResult({ message: '一次性 Runtime API Key 显示已清除。' });
});
let generatingRuntimeApiKey = false;
document.getElementById('generate-runtime-api-key').addEventListener('click', async () => {
  if (generatingRuntimeApiKey) return;
  const button = document.getElementById('generate-runtime-api-key');
  generatingRuntimeApiKey = true;
  button.setAttribute('disabled', '');
  try {
    const body = await postJson('/admin/api/api-keys');
    showOneTimeRuntimeApiKey(body.apiKey);
    renderResult({ ok: body.ok, message: '已生成新的 Runtime API Key；现有 Key 保持有效。' });
    await copyOneTimeRuntimeApiKey({ suppressResult: true });
    await loadApiKeys();
  } catch (error) {
    renderResult({ error: error.message });
  } finally {
    generatingRuntimeApiKey = false;
    button.removeAttribute('disabled');
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

const manualMode = document.getElementById('manual-mode');
const manualAccountId = document.getElementById('manual-account-id');
manualMode.addEventListener('change', () => { manualAccountId.disabled = manualMode.value !== 'reauthorize'; });
document.getElementById('manual-complete').addEventListener('click', async () => {
  const mode = manualMode.value;
  const accountId = manualAccountId.value;
  if (mode === 'reauthorize' && !accountId) { renderResult({ error: '请选择需要重新授权的 session 账号。' }); return; }
  try {
    const body = await postJson('/admin/api/auth/chatgpt/complete', {
      mode: mode, accountId: mode === 'reauthorize' ? accountId : undefined,
      accessToken: document.getElementById('session-access-token').value,
      cookie: document.getElementById('session-cookie').value,
      deviceId: document.getElementById('session-device-id').value,
      userAgent: document.getElementById('session-user-agent').value,
    });
    renderResult(body); showReady(body);
    await Promise.all([loadAccounts(), loadApiKeys(), loadModels(), loadQuotas()]);
  } catch (error) { renderResult({ error: error.message }); }
});

function schedulePoll(delay) { clearPoll(); pollTimer = setTimeout(pollAuth, delay); }
function clearPoll() { if (pollTimer) clearTimeout(pollTimer); pollTimer = null; }
function showAuthLink(authorizeUrl) {
  const area = document.getElementById('auth-link-area');
  const link = document.getElementById('auth-link');
  const copyButton = document.getElementById('copy-auth-link');
  const urlDisplay = document.getElementById('auth-url-display');
  const hasUrl = typeof authorizeUrl === 'string' && authorizeUrl.length > 0;
  area.hidden = !hasUrl; link.hidden = !hasUrl; copyButton.hidden = !hasUrl; urlDisplay.hidden = !hasUrl;
  if (!hasUrl) { link.removeAttribute('href'); urlDisplay.textContent = ''; return; }
  link.href = authorizeUrl;
  link.textContent = '打开 Codex OAuth 授权页';
  urlDisplay.textContent = authorizeUrl;
}
async function pollAuth() {
  if (!currentFlowId) return;
  try {
    const body = await getJson('/admin/api/auth/chatgpt/' + encodeURIComponent(currentFlowId));
    restoreAuthControls(body); renderResult(body);
    if (body.provisionResult) {
      clearOAuthFlow(); showReady(body.provisionResult);
      await Promise.all([loadAccounts(), loadApiKeys(), loadModels(), loadQuotas()]); return;
    }
    if (['expired', 'cancelled', 'error'].includes(body.state)) { clearOAuthFlow(); return; }
    schedulePoll(1800);
  } catch (error) { handleOAuthFlowFailure(error); }
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
  if (flowId !== null) { url.searchParams.delete('oauth_flow'); history.replaceState(history.state, '', url.pathname + url.search + url.hash); }
}
function rememberOAuthFlow(flowId) { sessionStorage.setItem(oauthFlowStorageKey, JSON.stringify({ flowId, origin: window.location.origin })); }
function clearOAuthFlow() { clearPoll(); currentFlowId = null; sessionStorage.removeItem(oauthFlowStorageKey); document.getElementById('cancel-auth').disabled = true; showAuthLink(); }
async function restoreOAuthFlow() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(oauthFlowStorageKey) || 'null'); } catch { sessionStorage.removeItem(oauthFlowStorageKey); return; }
  if (!saved || typeof saved.flowId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(saved.flowId) || saved.origin !== window.location.origin) { sessionStorage.removeItem(oauthFlowStorageKey); return; }
  currentFlowId = saved.flowId;
  try {
    const body = await getJson('/admin/api/auth/chatgpt/' + encodeURIComponent(currentFlowId));
    restoreAuthControls(body); renderResult(body);
    if (body.provisionResult) { clearOAuthFlow(); showReady(body.provisionResult); await Promise.all([loadAccounts(), loadApiKeys(), loadModels(), loadQuotas()]); }
    else if (['expired', 'cancelled', 'error'].includes(body.state)) clearOAuthFlow();
    else schedulePoll(0);
  } catch (error) { handleOAuthFlowFailure(error); }
}
function handleOAuthFlowFailure(error) {
  clearOAuthFlow();
  if (error && error.status === 404) {
    const message = '服务重启或流程过期，请重新授权。';
    document.getElementById('auth-message').textContent = message; renderResult({ error: message }); return;
  }
  showAuthError(error);
}
function showAuthError(error) {
  const message = error instanceof Error ? error.message : String(error);
  document.getElementById('auth-message').textContent = 'OAuth 操作失败：' + message;
  renderResult({ error: 'OAuth 操作失败：' + message });
}
function showReady(result) {
  const endpoint = window.location.origin + '/v1/messages';
  const hasRawKey = showOneTimeRuntimeApiKey(result.apiKey);
  if (hasRawKey) selectModule('api-access');
  document.getElementById('api-config').hidden = false;
  document.getElementById('endpoint').textContent = endpoint;
  const curl = curlExample.dataset.template.replace('__ORIGIN__', window.location.origin);
  document.getElementById('ready-curl').textContent = curl; curlExample.textContent = curl;
  document.getElementById('key-state').textContent = '已配置';
  document.getElementById('auth-message').textContent = hasRawKey ? '初始化完成：已创建账号并生成 Runtime API Key，请立即复制保存。' : '授权完成：账号凭据已更新，现有 Runtime API Key 保持有效且不会再次显示原始值。';
}
function showOneTimeRuntimeApiKey(value) {
  const apiKey = document.getElementById('api-key');
  const display = document.getElementById('runtime-api-key-once');
  const status = document.getElementById('runtime-key-copy-status');
  const hasRawKey = typeof value === 'string' && value.length > 0;
  if (!hasRawKey) return false;
  apiKey.textContent = value;
  apiKey.dataset.value = value;
  status.textContent = '请立即复制保存；关闭或清除显示后无法恢复原始 Key。';
  display.hidden = false;
  return true;
}
async function copyOneTimeRuntimeApiKey(options) {
  const key = document.getElementById('api-key').dataset.value;
  const status = document.getElementById('runtime-key-copy-status');
  if (!key) return false;
  try {
    await navigator.clipboard.writeText(key);
    status.textContent = '已复制到剪贴板。请立即保存；刷新页面后不会再次显示原始 Key。';
    if (!options?.suppressResult) renderResult({ message: 'Runtime API Key 已复制。' });
    return true;
  } catch {
    status.textContent = '剪贴板不可用，请手动选中上方完整 Key 并立即保存。';
    if (!options?.suppressResult) renderResult({ error: 'Runtime API Key 复制失败，请手动选中并立即保存。' });
    return false;
  }
}
function clearOneTimeRuntimeApiKey() {
  const apiKey = document.getElementById('api-key');
  apiKey.textContent = '';
  delete apiKey.dataset.value;
  document.getElementById('runtime-key-copy-status').textContent = '';
  document.getElementById('runtime-api-key-once').hidden = true;
}

async function loadAccounts() {
  try {
    const body = await getJson('/admin/api/accounts');
    accountsCache = Array.isArray(body.accounts) ? body.accounts : [];
    overviewLoadState.accounts = 'loaded';
    updateManualAccountOptions(accountsCache);
    document.getElementById('accounts').innerHTML = renderAccountCards(accountsCache);
    bindAccountActions();
    // Account metadata only enriches quota cards; it must not reset a quota load/error result.
    renderQuotaPanel();
  } catch (error) { overviewLoadState.accounts = 'error'; document.getElementById('accounts').innerHTML = loadFailureHtml('账号数据加载失败，未加载。', error); }
  renderOverviewPanel();
}
function bindAccountActions() {
  document.querySelectorAll('[data-account-health]').forEach((button) => button.addEventListener('click', async () => {
    await withPendingButton(button, '正在刷新', async () => {
      try {
        const body = await postJson('/admin/api/accounts/' + encodeURIComponent(button.dataset.accountHealth) + '/health-check');
        renderResult(body);
      } finally {
        // A failed POST can still update discovery status and retain a cached catalog.
        await Promise.all([loadAccounts(), loadModels()]);
      }
    });
  }));
  document.querySelectorAll('[data-account-reauthorize]').forEach((button) => button.addEventListener('click', () => startOAuthFlow('reauthorize', button.dataset.accountReauthorize)));
  document.querySelectorAll('[data-account-toggle]').forEach((button) => button.addEventListener('click', async () => {
    const enabled = button.dataset.enabled !== 'true';
    const body = await patchJson('/admin/api/accounts/' + encodeURIComponent(button.dataset.accountToggle), { enabled }); renderResult(body); await loadAccounts();
  }));
  document.querySelectorAll('[data-account-settings]').forEach((button) => button.addEventListener('click', () => { document.querySelector('[data-account-settings-form="' + CSS.escape(button.dataset.accountSettings) + '"]').hidden = false; }));
  document.querySelectorAll('[data-account-settings-cancel]').forEach((button) => button.addEventListener('click', () => { button.closest('form').hidden = true; }));
  document.querySelectorAll('[data-account-settings-form]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = await patchJson('/admin/api/accounts/' + encodeURIComponent(form.dataset.accountSettingsForm), { label: form.elements.label.value, maxConcurrency: Number(form.elements.maxConcurrency.value) }); renderResult(body); await loadAccounts();
  }));
  document.querySelectorAll('[data-account-delete]').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm(translateAdminText('确认删除此账号？账号凭据、动态模型关联和配额缓存将被移除，操作无法恢复。', adminLocale))) return;
    const body = await deleteJson('/admin/api/accounts/' + encodeURIComponent(button.dataset.accountDelete)); renderResult(body); await Promise.all([loadAccounts(), loadModels(), loadQuotas()]);
  }));
}
function updateManualAccountOptions(accounts) {
  const selected = manualAccountId.value;
  const sessionAccounts = accounts.filter((account) => account.provider === 'chatgpt-session');
  manualAccountId.innerHTML = '<option value="">请选择 session 账号</option>' + sessionAccounts.map((account) => '<option data-i18n-ignore value="' + esc(account.id) + '">' + esc(account.label || account.id) + ' (' + esc(account.id) + ')</option>').join('');
  if (sessionAccounts.some((account) => account.id === selected)) manualAccountId.value = selected;
}

async function loadQuotas() {
  quotaRequestState = { status: 'loading', error: null }; renderQuotaPanel();
  try {
    const body = await getJson('/admin/api/quotas');
    quotasCache = Array.isArray(body.quotas) ? body.quotas : [];
    quotaRequestState = { status: 'loaded', error: null };
  } catch (error) {
    quotaRequestState = { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
  renderQuotaPanel();
}
function quotaRequestErrorHtml() {
  if (quotaRequestState.status === 'loading') return '<p class="muted" role="status">正在读取配额缓存。</p>';
  if (quotaRequestState.status !== 'error') return '';
  return '<div class="quota-request-error" role="alert"><strong>配额数据加载失败</strong><span>' + esc(quotaRequestState.error || '未知错误') + '</span><button type="button" class="secondary" data-retry-quotas>重试配额加载</button></div>';
}
function quotaRefreshFeedback(quota) {
  if (!quota || quota.supported === false || quota.error?.code === 'unsupported') return '此账号不支持配额查询，无法刷新。';
  if (quota.status === 'fresh') return '账号配额刷新成功，数据为新鲜状态。';
  if (quota.status === 'stale') return '账号配额刷新完成，但返回的是陈旧数据。';
  if (quota.status === 'error') return '账号配额刷新完成，但上游返回错误状态。';
  if (quota.status === 'unknown') return '账号配额刷新完成，但上游未返回可用状态。';
  return '账号配额刷新完成，但返回了未知配额状态。';
}
function renderQuotaPanel() {
  renderOverviewPanel();
  document.getElementById('quotas').innerHTML = quotaRequestErrorHtml() + renderQuotaCards(quotasCache, accountsCache);
  document.querySelectorAll('[data-retry-quotas]').forEach((button) => button.addEventListener('click', loadQuotas));
  document.querySelectorAll('[data-quota-refresh]').forEach((button) => {
    const accountId = button.dataset.quotaRefresh;
    button.disabled = quotaRefreshAllPending || pendingQuotaAccounts.has(accountId);
    button.addEventListener('click', () => refreshQuotaAccount(accountId));
  });
  document.getElementById('refresh-all-quotas').disabled = quotaRefreshAllPending || pendingQuotaAccounts.size > 0;
}
async function refreshQuotaAccount(accountId) {
  if (quotaRefreshAllPending || pendingQuotaAccounts.has(accountId)) return;
  pendingQuotaAccounts.add(accountId); renderQuotaPanel(); announce('正在刷新账号配额。');
  try {
    const body = await postJson('/admin/api/quotas/' + encodeURIComponent(accountId) + '/refresh');
    const index = quotasCache.findIndex((item) => item.accountId === accountId);
    if (index === -1) quotasCache.push(body.quota); else quotasCache[index] = body.quota;
    const feedback = quotaRefreshFeedback(body.quota);
    renderResult({ ...body, message: feedback }); announce(feedback);
    await loadAccounts();
  } catch (error) { renderResult({ error: error.message }); announce('账号配额刷新失败。'); }
  finally { pendingQuotaAccounts.delete(accountId); renderQuotaPanel(); }
}
document.getElementById('refresh-all-quotas').addEventListener('click', async () => {
  if (quotaRefreshAllPending || pendingQuotaAccounts.size > 0) return;
  quotaRefreshAllPending = true; renderQuotaPanel(); announce('正在刷新全部账号配额。');
  try {
    const body = await postJson('/admin/api/quotas/refresh');
    quotasCache = Array.isArray(body.quotas) ? body.quotas : [];
    quotaRequestState = { status: 'loaded', error: null };
    renderResult(body);
    await loadAccounts();
    const summary = body.summary || {};
    const fresh = Number(summary.fresh || 0);
    const stale = Number(summary.stale || 0);
    const error = Number(summary.error || 0);
    const unknown = Number(summary.unknown || 0);
    const incomplete = stale + error + unknown;
    announce(incomplete > 0 ? '全部配额刷新完成，但结果不完整。新鲜 ' + fresh + '，陈旧 ' + stale + '，错误 ' + error + '，未知 ' + unknown + '。' : '全部账号配额刷新成功。新鲜 ' + fresh + '。');
  } catch (error) { renderResult({ error: error.message }); announce('全部账号配额刷新失败。'); }
  finally { quotaRefreshAllPending = false; renderQuotaPanel(); }
});

async function loadApiKeys() {
  try {
    const body = await getJson('/admin/api/api-keys');
    const apiKeys = Array.isArray(body.apiKeys) ? body.apiKeys : [];
    apiKeysCache = apiKeys; overviewLoadState.keys = 'loaded';
    document.getElementById('api-keys-count').textContent = String(apiKeys.length);
    document.getElementById('api-keys').innerHTML = apiKeys.length ? '<div class="table-wrap"><table><thead><tr><th>ID</th><th>名称</th><th>安全前缀</th><th>创建时间</th><th>操作</th></tr></thead><tbody>' + apiKeys.map((apiKey) => '<tr><td><code>' + esc(apiKey.id) + '</code></td><td data-i18n-ignore>' + esc(apiKey.name || '-') + '</td><td><code>' + esc(apiKey.prefix) + '</code></td><td>' + esc(apiKey.createdAt) + '</td><td><button class="secondary" data-revoke-key="' + esc(apiKey.id) + '">撤销</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">没有运行时 API Key。</div>';
    document.querySelectorAll('[data-revoke-key]').forEach((button) => button.addEventListener('click', async () => {
      if (!window.confirm(translateAdminText('确认撤销此运行时 API Key？撤销后对应客户端会立即失效。', adminLocale))) return;
      const result = await deleteJson('/admin/api/api-keys/' + encodeURIComponent(button.dataset.revokeKey)); renderResult(result); await loadApiKeys();
    }));
  } catch (error) { overviewLoadState.keys = 'error'; document.getElementById('api-keys-count').textContent = '-'; document.getElementById('api-keys').innerHTML = loadFailureHtml('运行时 API Key 加载失败，未加载。', error); }
  renderOverviewPanel();
}
document.getElementById('refresh-api-keys').addEventListener('click', loadApiKeys);

async function loadModels() {
  try {
    const body = await getJson('/admin/api/models');
    const aliases = Array.isArray(body.aliases) ? body.aliases : (Array.isArray(body.models) ? body.models : []);
    const discovered = Array.isArray(body.discovered) ? body.discovered : [];
    modelsCache = { aliases, discovered }; overviewLoadState.models = 'loaded';
    const discoveryHtml = discovered.length ? '<div class="row">' + discovered.map((model) => '<span class="state-badge neutral" title="' + esc(capabilitySummary(model.capabilities)) + '">' + esc(model.id) + '</span>').join('') + '</div>' : '<div class="empty">Backend discovery 暂无模型；不会假设所有控制项都可用。</div>';
    const discoverySection = '<div data-professional-only><p class="muted">Backend discovery（选项与顺序直接来自 catalog）</p>' + discoveryHtml + '</div>';
    const builtInAliases = aliases.filter((model) => model.builtIn);
    document.getElementById('model-availability').innerHTML = builtInAliases.length ? '<div class="row">' + builtInAliases.map((model) => '<span class="state-badge neutral"><code>' + esc(model.id) + '</code>：' + (model.status === 'unbound' ? '未绑定，请在下方模型映射中选择后端模型并保存' : esc(model.status || '-')) + '</span>').join('') + '</div>' : '<div class="empty">暂无内置 alias。</div>';
    document.getElementById('model-backend').innerHTML = backendOptionsHtml('', discovered, true);
    document.getElementById('models').innerHTML = aliases.length ? discoverySection + '<div class="table-wrap"><table><thead><tr><th>Alias</th><th>Backend Model</th><th data-professional-only>状态</th><th>启用</th><th data-professional-only>目标能力与默认参数</th><th>操作</th></tr></thead><tbody>' + aliases.map((model) => '<tr><td><code>' + esc(model.id) + '</code>' + (model.builtIn ? ' <span class="muted">内置</span>' : '') + '</td><td><select data-field="backendModel" data-id="' + esc(model.id) + '" aria-label="Alias ' + esc(model.id) + ' 的 Backend Model">' + backendOptionsHtml(model.backendModel || '', discovered, true) + '</select></td><td data-professional-only>' + esc(model.status || '-') + '</td><td><input type="checkbox" data-field="enabled" data-id="' + esc(model.id) + '" aria-label="Alias ' + esc(model.id) + ' 是否启用" ' + (model.enabled ? 'checked' : '') + ' /></td><td data-professional-only><div class="stack" data-controls-for="' + esc(model.id) + '">' + controlSelectsHtml(model, model.defaults, model.id) + capabilityStateHtml(model) + '</div></td><td><button data-save-model="' + esc(model.id) + '">保存</button>' + (model.builtIn ? '' : ' <button class="secondary" data-professional-only data-delete-model="' + esc(model.id) + '">删除</button>') + '</td></tr>').join('') + '</tbody></table></div>' : discoverySection + '<div class="empty">暂无 alias overlay。</div>';
    bindModelActions(aliases, discovered);
  } catch (error) { overviewLoadState.models = 'error'; const failure = loadFailureHtml('模型数据加载失败，未加载。', error); document.getElementById('model-availability').innerHTML = failure; document.getElementById('models').innerHTML = failure; }
  renderOverviewPanel();
}
function bindModelActions(aliases, discovered) {
  document.querySelectorAll('[data-field="backendModel"]').forEach((select) => select.addEventListener('change', () => {
    const alias = aliases.find((model) => model.id === select.dataset.id);
    const target = discovered.find((model) => model.id === select.value);
    const host = document.querySelector('[data-controls-for="' + CSS.escape(select.dataset.id) + '"]');
    if (alias && host) host.innerHTML = controlSelectsHtml(target || { capabilities: unknownCapabilities() }, alias.defaults, alias.id) + capabilityStateHtml(target || { capabilities: unknownCapabilities(), configuration_issues: [] });
  }));
  document.querySelectorAll('[data-save-model]').forEach((button) => button.addEventListener('click', () => saveModel(button.dataset.saveModel)));
  document.querySelectorAll('[data-delete-model]').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm(translateAdminText('确认删除此自定义模型 alias？删除后无法恢复。', adminLocale))) return;
    const body = await deleteJson('/admin/api/models/' + encodeURIComponent(button.dataset.deleteModel)); renderResult(body); await loadModels();
  }));
}
async function saveModel(id) {
  const byField = (field) => document.querySelector('[data-id="' + CSS.escape(id) + '"][data-field="' + field + '"]');
  const patch = { backendModel: byField('backendModel').value, enabled: byField('enabled').checked };
  if (document.documentElement.dataset.adminMode === 'professional') patch.defaults = { reasoning_effort: byField('reasoning_effort').value, service_tier: byField('speed').value };
  const body = await patchJson('/admin/api/models/' + encodeURIComponent(id), patch); renderResult(body); await loadModels();
}
function backendOptionsHtml(current, discovered, allowEmpty) {
  const values = discovered.map((model) => ({ value: model.id, label: model.display_name || model.id, provider: true }));
  if (current && !values.some((option) => option.value === current)) values.unshift({ value: current, label: current + '（已失效）' });
  if (allowEmpty) values.unshift({ value: '', label: '未绑定' });
  return values.map((option) => '<option value="' + esc(option.value) + '" ' + (option.provider ? 'data-i18n-ignore ' : '') + (option.value === current ? 'selected' : '') + '>' + esc(option.label) + '</option>').join('');
}
function controlSelectsHtml(model, defaults, aliasId) {
  const capabilities = model.capabilities || unknownCapabilities();
  const reasoning = (capabilities.reasoning_effort_options || []).map((option) => ({ value: option.effort, label: reasoningLabel(option.effort), description: option.description }));
  const isFast = (value) => ['fast', 'fastest', 'priority'].includes(String(value || '').toLowerCase());
  const supportedTiers = capabilities.service_tiers || [];
  const supportsFast = capabilities.fast_mode || supportedTiers.some((option) => isFast(option.id));
  const currentTier = isFast(defaults.speed) ? 'priority' : defaults.speed;
  const tiers = [{ value: 'standard', label: 'Standard（发送 service_tier: default）' }, { value: 'auto', label: 'Auto（省略 service_tier）' }];
  if (supportsFast || isFast(defaults.speed)) tiers.push({ value: 'priority', label: supportsFast ? 'Fast' : 'Fast（配置不受目标支持）' });
  tiers.push(...supportedTiers.filter((option) => !isFast(option.id) && !['standard', 'default', 'auto'].includes(String(option.id).toLowerCase())).map((option) => ({ value: option.id, label: option.name || option.id, description: option.description, provider: true })));
  return '<label>推理 ' + selectHtml(aliasId, 'reasoning_effort', reasoning, defaults.reasoning_effort) + '</label><label>服务层级 ' + selectHtml(aliasId, 'speed', tiers, currentTier) + '</label>';
}
function selectHtml(id, field, options, current) {
  const normalized = String(current || '').toLowerCase();
  if (current && !options.some((option) => String(option.value).toLowerCase() === normalized)) options = [{ value: current, label: current + '（配置不受目标支持）' }].concat(options);
  return '<select data-field="' + field + '" data-id="' + esc(id) + '">' + options.map((option) => '<option value="' + esc(option.value) + '" ' + (option.provider ? 'data-i18n-ignore ' : '') + 'title="' + esc(option.description || '') + '" ' + (String(option.value).toLowerCase() === normalized ? 'selected' : '') + '>' + esc(option.label) + '</option>').join('') + '</select>';
}
function reasoningLabel(effort) { const value = String(effort).toLowerCase(); if (value === 'low') return 'Light（官方 low）'; if (value === 'ultra') return 'Ultra（兼容最高强度）'; return effort; }
function capabilityStateHtml(model) {
  const capabilities = model.capabilities || unknownCapabilities(); const states = capabilities.metadata_status || {};
  const parts = ['推理元数据：' + (states.reasoning === 'known' ? '已发现' : '未知'), '服务层级元数据：' + (states.service_tier === 'known' ? '已发现' : '未知')];
  if (capabilities.ultra_lossy) parts.push(capabilities.ultra_mapped_effort ? 'Ultra 会有损映射到 ' + capabilities.ultra_mapped_effort + '，不会把 ultra 发给上游' : 'Ultra 没有安全的非 ultra 映射；显式请求会拒绝，隐式默认会省略');
  if (Array.isArray(model.configuration_issues) && model.configuration_issues.length) parts.push(model.configuration_issues.join('；'));
  return '<span class="muted">' + esc(parts.join(' · ')) + '</span>';
}
function capabilitySummary(capabilities) { const value = capabilities || unknownCapabilities(); return 'reasoning: ' + ((value.reasoning_effort || []).join(', ') || '未知') + '; service tiers: ' + ((value.response_speed || []).join(', ') || '未知'); }
function unknownCapabilities() { return { reasoning_effort_options: [], service_tiers: [], metadata_status: { reasoning: 'unknown', service_tier: 'unknown' } }; }

document.getElementById('create-model-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = document.getElementById('model-alias-id').value.trim(); const displayName = document.getElementById('model-display-name').value.trim(); const backendModel = document.getElementById('model-backend').value.trim();
  const body = await postJson('/admin/api/models', { id, display_name: displayName || id, backendModel: backendModel || undefined }); renderResult(body); await loadModels(); if (!body.error) event.target.reset();
});
document.getElementById('reset-models').addEventListener('click', async () => { const body = await postJson('/admin/api/models/reset'); renderResult(body); await loadModels(); });
document.getElementById('refresh-models').addEventListener('click', async () => { const body = await postJson('/admin/api/models/refresh'); renderResult(body); await Promise.all([loadModels(), loadAccounts()]); });

function renderResult(body) {
  const outcomes = Array.isArray(body.refreshedAccounts) ? body.refreshedAccounts : [];
  const feedback = outcomes.map((item) => item.accountId + ': ' + item.message).join('；') || body.message || (typeof body.error === 'string' ? body.error : '');
  if (feedback) announce(feedback);
  document.getElementById('result-message').textContent = feedback || '';
  document.getElementById('result').textContent = JSON.stringify(redactApiKeys(body), null, 2);
}
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
  const response = await fetchWithAdminKey(url, init); let body;
  try { body = await response.json(); } catch { body = {}; }
  if (response.ok) return body;
  const message = body?.error?.message || body?.error || body?.message || ('HTTP ' + response.status);
  if (response.status === 401) {
    setAdminSessionState(false);
    if (document.documentElement.dataset.adminMode === 'simple') {
      setAdminMode('professional');
    }
    selectModule('admin-access');
    adminKeyFallback.open = true;
    adminKeyInput.focus();
    renderResult({ error: '未认证/数据未加载。请使用高级“远程管理凭据（Admin API Key）”后重试。' });
  }
  const error = new Error(message); error.status = response.status; throw error;
}
function loadFailureHtml(message, error) { return '<div class="empty">' + esc(message + ' ' + (error instanceof Error ? error.message : String(error))) + '</div>'; }
async function fetchWithAdminKey(url, init) {
  const options = { ...(init || {}) }; const headers = new Headers(options.headers || {});
  const key = localAdminSessionActive ? '' : getStoredAdminApiKey();
  if (key) headers.set('x-api-key', key); options.headers = headers; return fetch(url, options);
}
async function verifyLocalAdminSession() {
  try { const response = await fetch('/admin/api/accounts'); localAdminSessionActive = response.ok; } catch { localAdminSessionActive = false; }
  setAdminSessionState(localAdminSessionActive); return localAdminSessionActive;
}
function setAdminSessionState(active) {
  localAdminSessionActive = active; adminSessionState.className = 'session-strip' + (active ? '' : ' warn');
  adminSessionState.innerHTML = active ? '<span class="state-badge positive">本地会话已连接</span><div><strong>管理操作已通过 HttpOnly 浏览器会话完成</strong><span class="muted">此页面无需 Admin API Key。会话仅适用于本机可信访问，服务重启或会话失效后会自动回退到显式 Key。</span></div>' : '<span class="state-badge warning">需要显式 Key</span><div><strong>未检测到可用的本地管理会话</strong><span class="muted">远程访问、自动化或会话失效时，请展开 fallback 并手动提供 Admin API Key。</span></div>';
}
function getStoredAdminApiKey() { return pageAdminApiKey || localStorage.getItem('adminApiKey') || ''; }
function saveAdminApiKey(key, persistent) { pageAdminApiKey = key; if (key && persistent) localStorage.setItem('adminApiKey', key); else localStorage.removeItem('adminApiKey'); adminKeyInput.value = key; }
${adminPageLocaleSource()}
async function withPendingButton(button, label, action) { const original = button.textContent; button.disabled = true; button.textContent = label; try { await action(); } catch (error) { renderResult({ error: error.message }); } finally { button.disabled = false; button.textContent = original; } }

void loadQuotas();
renderOverviewPanel();
verifyLocalAdminSession().then(async () => { await Promise.all([loadAccounts(), loadApiKeys(), loadModels()]); await restoreOAuthFlow(); });
`;
}
