import { adminPageI18nSource, localizeAdminMarkup as sharedLocalizeAdminMarkup, type AdminLocale } from './admin-page-i18n.js';
import { presentPlan as sharedPresentPlan, planPresentationText as sharedPlanText, type PlanPresentation } from '../services/plan-presentation.js';
import { discoveryMessage as sharedDiscoveryMessage, unknownDiscovery as sharedUnknownDiscovery, type ModelDiscoveryState } from '../services/model-discovery.js';
import type { ChatGptAccountQuota, ChatGptAdditionalQuotaLimit, ChatGptQuotaWindow } from '@chatgpt-to-claude/chatgpt-backend';
import type { AccountView } from '../services/account-pool.js';
import type { AccountQuotaResult } from '../services/account-quota-service.js';

// Local bindings keep serialized renderer functions independent of module-loader aliases.
const localizeAdminMarkup = sharedLocalizeAdminMarkup;
const presentPlan = sharedPresentPlan;
const planPresentationText = sharedPlanText;
const discoveryMessage = sharedDiscoveryMessage;
const unknownDiscovery = sharedUnknownDiscovery;

export interface AdminAccountView extends AccountView {
  requestStats: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    cancelledRequests: number;
    inputTokens: number;
    outputTokens: number;
    lastRequestAt: string | null;
    inFlight: number;
  };
  modelCount: number;
  plan?: PlanPresentation;
  discovery?: ModelDiscoveryState;
  discoveredModels: Array<{ id: string; displayName?: string }>;
}

export function renderAccountCards(accounts: AdminAccountView[], locale: AdminLocale = 'zh-CN'): string {
  if (!accounts.length) return localizeAdminMarkup('<div class="empty-state"><strong>尚未添加 ChatGPT 账号</strong><span>使用“添加 ChatGPT 账号”完成正常的浏览器授权流程。</span></div>', locale);
  return localizeAdminMarkup(`<div class="account-grid">${accounts.map(renderAccountCard).join('')}</div>`, locale);
}

export function renderQuotaCards(quotas: AccountQuotaResult[], accounts: AdminAccountView[] = [], locale: AdminLocale = 'zh-CN'): string {
  if (!quotas.length) return localizeAdminMarkup('<div class="empty-state"><strong>暂无配额结果</strong><span>配额结果由 provider allowance 查询独立提供；添加账号后可刷新。</span></div>', locale);
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  return localizeAdminMarkup(`<div class="quota-grid">${quotas.map((result) => renderQuotaCard(result, accountsById.get(result.accountId)?.createdAt === result.createdAt ? accountsById.get(result.accountId) : undefined)).join('')}</div>`, locale);
}

export interface AdminOverviewData {
  accounts: AdminAccountView[];
  quotas: AccountQuotaResult[];
  models: { aliases: Array<{ status?: string; enabled?: boolean }>; discovered: unknown[] };
  keyCount: number;
  states: { accounts: string; models: string; keys: string; quotas: string };
  localSession: boolean;
}

export function renderAdminOverview(data: AdminOverviewData, locale: AdminLocale = 'zh-CN'): string {
  const stateLabels: Record<string, string> = { idle: '尚未加载', loading: '加载中', loaded: '已加载', error: '加载失败；保留上次缓存' };
  const healthy = data.accounts.filter((account) => account.enabled && account.status === 'available').length;
  const disabled = data.accounts.filter((account) => !account.enabled || account.status === 'disabled').length;
  const counts = { fresh: 0, stale: 0, error: 0, unknown: 0 };
  for (const quota of data.quotas) {
    const state = quota.status === 'fresh' && quota.expiresAt && Date.parse(quota.expiresAt) <= Date.now() ? 'stale' : quota.status;
    counts[state] += 1;
  }
  const activities = data.accounts.filter((account) => account.requestStats.lastRequestAt || account.lastUsedAt)
    .sort((left, right) => Date.parse(right.requestStats.lastRequestAt || right.lastUsedAt || '') - Date.parse(left.requestStats.lastRequestAt || left.lastUsedAt || ''))
    .slice(0, 8);
  const activityHtml = activities.length ? `<ol class="activity-list">${activities.map((account) => `<li><div><strong data-i18n-ignore>${esc(account.label)}</strong>${timeHtml(account.requestStats.lastRequestAt || account.lastUsedAt)}</div><div class="stat-line"><span>成功 ${account.requestStats.successfulRequests}</span><span>失败 ${account.requestStats.failedRequests}</span><span>取消 ${account.requestStats.cancelledRequests}</span></div></li>`).join('')}</ol>` : `<p class="empty">${data.states.accounts === 'loaded' ? '尚无账号活动。' : esc(stateLabels[data.states.accounts] || '尚未加载')}</p>`;
  // Named local functions gain tsx's __name wrapper, which cannot be serialized.
  const tiles: Array<[string, number, string, string?]> = [
    ['账号健康', data.accounts.length, data.states.accounts, data.states.accounts === 'loaded' || data.accounts.length ? `健康 ${healthy} · 异常 ${data.accounts.length - healthy - disabled} · 停用 ${disabled}` : ''],
    ['已发现模型', data.models.discovered.length, data.states.models],
    ['可用 alias', data.models.aliases.filter((alias) => alias.enabled && (alias.status === 'bound' || alias.status === 'passthrough')).length, data.states.models],
    ['Runtime Key 数量', data.keyCount, data.states.keys],
  ];
  let tilesHtml = '';
  for (const [label, total, state, detail] of tiles) {
    const value = state === 'loaded' || total > 0 ? numberHtml(total) : '—';
    tilesHtml += `<article class="overview-tile"><h3>${esc(label)}</h3><strong class="overview-value">${value}</strong><p>${esc(stateLabels[state] || '尚未加载')}</p>${detail ? `<p>${esc(detail)}</p>` : ''}</article>`;
  }
  return localizeAdminMarkup(`<div class="overview-grid">${tilesHtml}
  </div><section class="panel overview-status"><div><h3>接入状态</h3><p>${data.localSession ? '本地会话已连接' : '需要显式 Key'}</p><a href="#admin-access">管理访问</a></div><div><h3>配额缓存</h3><p>${esc(stateLabels[data.states.quotas] || '尚未加载')}</p><p>新鲜 ${counts.fresh} · 陈旧 ${counts.stale} · 错误 ${counts.error} · 未知 ${counts.unknown}</p><a href="#quota">配额</a></div><div><h3>下一步</h3><p>${data.states.accounts === 'loaded' ? (data.accounts.length ? '检查模型映射并生成客户端 Runtime Key。' : '先添加账号并完成浏览器授权。') : '尚未加载'}</p><a href="#${data.accounts.length ? 'api-access' : 'authentication'}">${data.accounts.length ? 'API 接入' : '账号与授权'}</a></div></section>
    <section class="panel"><h3>最近账号活动</h3><p class="muted">最近活动来自账号时间戳和累计请求结果，不是完整请求日志。</p>${activityHtml}</section>`, locale);
}

export interface AdminRequestDiagnostic {
  route?: string;
  model?: string;
  stream?: boolean;
  time?: string;
}

export function renderRequestInspector(requests: AdminRequestDiagnostic[], locale: AdminLocale = 'zh-CN'): string {
  if (!requests.length) return localizeAdminMarkup('<div class="empty-state"><strong>暂无最近请求</strong><span>该摘要有界且只保留 route、model、stream 和 time。</span></div>', locale);
  const rows = requests.map((request) => `<tr><td><code>${esc(request.route || '—')}</code></td><td><code>${esc(request.model || '—')}</code></td><td>${request.stream === true ? '是' : request.stream === false ? '否' : '未知'}</td><td>${timeHtml(request.time)}</td></tr>`).join('');
  return localizeAdminMarkup(`<div class="table-wrap request-inspector-table"><table><thead><tr><th>路由</th><th>模型</th><th>流式</th><th>时间</th></tr></thead><tbody>${rows}</tbody></table></div>`, locale);
}

function timeHtml(value: string | null | undefined): string {
  return `<time data-admin-date="${esc(value || '')}">${esc(formatTime(value))}</time>`;
}

function numberHtml(value: number): string {
  return `<span data-admin-number="${value}">${value}</span>`;
}

function renderAccountCard(account: AdminAccountView): string {
  const stats = account.requestStats;
  const identity = account.email || account.label;
  const health = accountHealth(account);
  const modelItems = account.discoveredModels.length
    ? account.discoveredModels.map((model) => `<li><code>${esc(model.id)}</code>${model.displayName && model.displayName !== model.id ? `<span data-i18n-ignore>${esc(model.displayName)}</span>` : ''}</li>`).join('')
    : '<li class="muted">尚未发现动态模型</li>';
  return `<article class="account-card" data-account-id="${esc(account.id)}">
    <header class="card-header"><div class="identity"><span class="eyebrow">${esc(account.provider === 'chatgpt-session' ? 'ChatGPT Account' : 'Mock Account')}</span><h3 data-i18n-ignore>${esc(account.label)}</h3><p class="wrap-anywhere" data-i18n-ignore>${esc(identity)}</p></div><span class="state-badge ${health.tone}">${esc(health.label)}</span></header>
    <dl class="account-summary">
      <div><dt>套餐</dt><dd>${esc(planPresentationText(account.plan ?? presentPlan(undefined, account.planType)))}</dd></div>
      <div><dt>启用</dt><dd>${account.enabled ? '已启用' : '已停用'}</dd></div>
      <div><dt>模型数量</dt><dd>${numberHtml(account.modelCount)} · <span>${esc(discoveryMessage(account.discovery ?? unknownDiscovery(), account.modelCount))}</span></dd></div>
      <div><dt>最近活动</dt><dd>${timeHtml(stats.lastRequestAt || account.lastUsedAt)}</dd></div>
    </dl>
    <p class="muted">5x/20x 是套餐类别标识，不代表当前剩余额度。</p>
    <div class="stat-line" aria-label="请求结果统计"><span>成功 ${stats.successfulRequests}</span><span>失败 ${stats.failedRequests}</span><span>取消 ${stats.cancelledRequests}</span><span>总计 ${stats.totalRequests}</span><span>进行中 ${stats.inFlight}</span></div>
    <div class="professional-detail" data-professional-only>
      <dl class="technical-list">
        <div><dt>内部 ID</dt><dd><code class="wrap-anywhere">${esc(account.id)}</code></dd></div>
        <div><dt>上游 ID</dt><dd><code class="wrap-anywhere">${esc(account.upstreamAccountId || '不可用')}</code></dd></div>
        <div><dt>凭据到期</dt><dd>${timeHtml(account.credentialExpiresAt)}</dd></div>
        <div><dt>并发</dt><dd>${account.currentConcurrency} / ${account.maxConcurrency}</dd></div>
        <div><dt>冷却至</dt><dd>${timeHtml(account.cooldownUntil)}</dd></div>
        <div><dt>安全错误码</dt><dd><code>${esc(account.lastErrorCode || '无')}</code></dd></div>
      </dl>
      <p class="wrap-anywhere">最近发现尝试：${timeHtml(account.discovery?.attemptedAt)} · 最近成功：${timeHtml(account.discovery?.succeededAt)}</p>
      ${account.discovery?.diagnostic ? `<p class="wrap-anywhere">安全发现诊断：<code>${esc(JSON.stringify(account.discovery.diagnostic))}</code></p>` : ''}
      <details class="model-disclosure"><summary>动态模型完整列表（${account.modelCount}）</summary><ul>${modelItems}</ul></details>
    </div>
    <div class="card-actions" aria-label="${esc(account.label)} 账号操作">
      <button type="button" class="secondary" data-account-health="${esc(account.id)}">刷新健康与模型</button>
      ${account.provider === 'chatgpt-session' ? `<button type="button" class="secondary" data-account-reauthorize="${esc(account.id)}" data-reauthorize-account="${esc(account.id)}">重新授权</button>` : ''}
      <button type="button" class="secondary" data-account-toggle="${esc(account.id)}" data-enabled="${String(account.enabled)}">${account.enabled ? '停用' : '启用'}</button>
      <button type="button" class="secondary" data-account-settings="${esc(account.id)}">设置</button>
      <button type="button" class="danger-button" data-account-delete="${esc(account.id)}" ${account.currentConcurrency > 0 ? 'disabled title="账号有进行中的请求"' : ''}>删除</button>
    </div>
    <form class="account-settings" data-account-settings-form="${esc(account.id)}" hidden>
      <label>账号标签<input name="label" value="${esc(account.label)}" maxlength="120" /></label>
      <label>最大并发<input name="maxConcurrency" type="number" min="1" max="100" value="${account.maxConcurrency}" /></label>
      <div class="form-actions"><button type="submit">保存设置</button><button type="button" class="secondary" data-account-settings-cancel="${esc(account.id)}">取消</button></div>
    </form>
  </article>`;
}

function renderQuotaCard(result: AccountQuotaResult, account: AdminAccountView | undefined): string {
  const state = quotaState(result);
  const quota = result.quota;
  const accountLabel = account?.label || result.accountId;
  const accountIdentity = account?.email || result.accountId;
  const plan = presentPlan(result);
  const canReset = result.supported && result.canActiveReset === true && result.status === 'fresh'
    && Boolean(result.expiresAt && Date.parse(result.expiresAt) > Date.now())
    && !quota?.resetCredits?.error && Number.isSafeInteger(quota?.resetCredits?.availableCount)
    && (quota?.resetCredits?.availableCount ?? 0) > 0;
  const mainWindows = quota?.windows ?? [];
  const fiveHour = mainWindows.find((window) => window.durationSeconds === 18_000);
  const weekly = mainWindows.find((window) => window.durationSeconds === 604_800);
  const otherMain = mainWindows.filter((window) => window !== fiveHour && window !== weekly);
  const additional = quota?.additionalLimits ?? [];
  const allowance = quota ? allowanceText(quota) : 'Provider allowance 未知';
  return `<article class="quota-card" data-quota-account="${esc(result.accountId)}">
    <header class="card-header quota-identity-header"><div class="identity"><span class="eyebrow">${account?.provider === 'mock' ? 'Mock Account' : 'ChatGPT / Codex'}</span><h3 class="quota-account-identity" data-i18n-ignore>${esc(account?.email || accountLabel)}</h3><p class="wrap-anywhere" data-i18n-ignore>${esc(account?.email ? accountLabel : accountIdentity)}</p></div><div class="quota-plan-badge" aria-label="上游套餐"><span>套餐</span><strong${plan.source === 'unknown' ? '' : ' data-i18n-ignore'}>${plan.source === 'unknown' ? '套餐未知' : esc(planPresentationText(plan))}</strong></div></header>
    <div class="quota-observation"><span class="state-badge ${state.tone}">${esc(state.label)}</span>${plan.stale ? '<span>套餐来自陈旧观察</span>' : ''}</div>
    ${result.supported ? `<p class="allowance-state"><strong>${esc(allowance)}</strong><span>仅展示上游返回的 allowance 与 meter，不从套餐、429 或请求统计推断。</span></p>
    <div class="window-grid">
      ${fiveHour ? renderMeter('五小时窗口', fiveHour) : renderUnavailable('五小时窗口不可用')}
      ${weekly ? renderMeter('每周窗口', weekly) : renderUnavailable('每周窗口不可用')}
    </div>
    ${otherMain.length ? `<section class="meter-section"><h4>其他上游窗口</h4>${otherMain.map((window) => renderMeter(window.descriptor || window.position, window, true)).join('')}</section>` : ''}
    ${additional.map(renderAdditionalLimit).join('')}` : `<p class="allowance-state"><strong>此账号不支持配额查询</strong><span>当前 provider 或账号类型不提供 quota lookup；无法刷新此账号配额。</span></p>`}
    ${result.supported ? renderResetCredits(quota?.resetCredits) : ''}
    <footer class="quota-footer"><div><span>最后获取：${timeHtml(result.fetchedAt)}</span><span>缓存到期：${timeHtml(result.expiresAt)}</span></div>${result.error ? `<span>状态详情：${esc(result.error.message)} <code>${esc(result.error.code)}</code></span>` : ''}<div class="card-actions" aria-label="配额操作">${result.supported ? `<button type="button" class="secondary" aria-label="刷新此账号配额" data-quota-refresh="${esc(result.accountId)}">刷新此账号</button>` : ''}${canReset ? `<button type="button" class="danger-button" aria-label="消耗一次上游重置次数" data-quota-reset="${esc(result.accountId)}">主动重置</button>` : ''}</div></footer>
  </article>`;
}

function renderResetCredits(credits: ChatGptAccountQuota['resetCredits']): string {
  const count = credits?.availableCount;
  const known = !credits?.error && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  return `<section class="quota-reset-credits" aria-label="上游重置次数"><div class="quota-credit-summary"><h4>可用重置次数</h4><strong>${known ? numberHtml(count) : '未知'}</strong></div>
    ${credits?.error ? '<p role="status">重置次数读取失败，余额未知；请刷新后重试。</p>' : !known ? '<p>上游未返回重置次数。</p>' : ''}
    ${credits?.credits?.length ? `<ul>${credits.credits.map((credit) => `<li><span>重置次数到期：</span>${timeHtml(credit.expiresAt)}${credit.grantedAt ? `<span> · 发放：</span>${timeHtml(credit.grantedAt)}` : ''}</li>`).join('')}</ul>` : ''}
    <p>主动重置消耗 1 次上游重置次数，不改变本地冷却。缓存到期、配额窗口重置与重置次数到期互不相同。</p></section>`;
}

function renderAdditionalLimit(limit: ChatGptAdditionalQuotaLimit, index: number): string {
  const title = limit.limitName || limit.meteredFeature || `附加额度 ${index + 1}`;
  const state = limit.allowed === false || limit.limitReached === true ? '不可用' : limit.allowed === true ? '可用' : '状态未知';
  const windows = limit.windows.length
    ? limit.windows.map((window) => renderMeter(window.descriptor || window.position, window, true)).join('')
    : '<p class="unavailable">上游未返回 meter 窗口</p>';
  return `<section class="meter-section"><div class="section-heading"><h4${limit.limitName || limit.meteredFeature ? ' data-i18n-ignore' : ''}>${esc(title)}</h4><span>${esc(state)}</span></div>${windows}</section>`;
}

function renderMeter(label: string, window: ChatGptQuotaWindow, providerLabel = false): string {
  const used = validPercent(window.usedPercent);
  const duration = window.durationSeconds === undefined ? '时长未知' : formatDuration(window.durationSeconds);
  const reset = window.resetAt ? `${timeHtml(window.resetAt)} <span>${esc(relativeReset(window.resetAt))}</span>` : esc(window.resetAfterSeconds !== undefined ? relativeSeconds(window.resetAfterSeconds) : '重置时间未知');
  if (used === undefined) return `<div class="meter-row meter-unknown"><div class="meter-copy"><strong${providerLabel ? ' data-i18n-ignore' : ''}>${esc(label)}</strong><span>用量未知 · ${esc(duration)}</span></div><p>上游未返回百分比，不显示零值进度条。重置：${reset}</p></div>`;
  const remaining = Math.max(0, 100 - used);
  return `<div class="meter-row"><div class="meter-copy"><strong${providerLabel ? ' data-i18n-ignore' : ''}>${esc(label)}</strong><span>已用 ${formatPercent(used)}% · 剩余 ${formatPercent(remaining)}%</span></div><div class="meter-track" role="progressbar" aria-label="${esc(label)} 已用 ${formatPercent(used)}%" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}" aria-valuetext="已用 ${formatPercent(used)}%，剩余 ${formatPercent(remaining)}%"><span class="meter-fill" style="width:${used}%"></span></div><p><span>${esc(duration)}</span> · <span>重置：</span>${reset}</p></div>`;
}

function renderUnavailable(message: string): string {
  return `<div class="meter-row meter-unknown"><div class="meter-copy"><strong>${esc(message)}</strong><span>上游响应中没有该时长窗口</span></div></div>`;
}

function accountHealth(account: AdminAccountView): { label: string; tone: string } {
  if (!account.enabled || account.status === 'disabled') return { label: '已停用', tone: 'neutral' };
  if (account.status === 'available') return { label: '健康', tone: 'positive' };
  if (account.status === 'cooldown') return { label: '冷却中', tone: 'warning' };
  return { label: '异常', tone: 'negative' };
}

function quotaState(result: AccountQuotaResult | undefined): { label: string; tone: string } {
  if (!result || result.status === 'unknown') return { label: '尚未获取', tone: 'neutral' };
  if (result.status === 'fresh' && result.expiresAt && Date.parse(result.expiresAt) <= Date.now()) return { label: '数据陈旧', tone: 'warning' };
  if (result.status === 'fresh') return { label: '数据新鲜', tone: 'positive' };
  if (result.status === 'stale') return { label: '数据陈旧', tone: 'warning' };
  return { label: '获取失败', tone: 'negative' };
}

function allowanceText(quota: ChatGptAccountQuota): string {
  if (quota.allowed === false || quota.limitReached === true) return 'Provider allowance：不可用';
  if (quota.allowed === true) return 'Provider allowance：可用';
  return 'Provider allowance：未知';
}

function validPercent(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

function formatDuration(seconds: number): string {
  if (seconds % 604_800 === 0) return `${seconds / 604_800} 周`;
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '不可用';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function relativeReset(value: string): string {
  const delta = Date.parse(value) - Date.now();
  if (!Number.isFinite(delta)) return '相对时间未知';
  return delta <= 0 ? '已到重置时间' : relativeSeconds(Math.ceil(delta / 1000));
}

function relativeSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.ceil(seconds))} 秒后`;
  if (seconds < 3_600) return `${Math.ceil(seconds / 60)} 分钟后`;
  if (seconds < 86_400) return `${Math.ceil(seconds / 3_600)} 小时后`;
  return `${Math.ceil(seconds / 86_400)} 天后`;
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

const browserFunctions = [renderAdminOverview, renderRequestInspector, timeHtml, numberHtml, presentPlan, planPresentationText, discoveryMessage, unknownDiscovery, renderAccountCards, renderQuotaCards, renderAccountCard, renderQuotaCard, renderResetCredits, renderAdditionalLimit, renderMeter, renderUnavailable, accountHealth, quotaState, allowanceText, validPercent, formatPercent, formatDuration, formatTime, relativeReset, relativeSeconds, esc];

export function adminPageViewSource(): string {
  return adminPageI18nSource() + '\n' + browserFunctions.map((fn) => fn.toString()).join('\n');
}
