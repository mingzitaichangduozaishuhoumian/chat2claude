import { presentPlan as sharedPresentPlan, planPresentationText as sharedPlanText, type PlanPresentation } from '../services/plan-presentation.js';
import { discoveryMessage as sharedDiscoveryMessage, unknownDiscovery as sharedUnknownDiscovery, type ModelDiscoveryState } from '../services/model-discovery.js';
import type { ChatGptAccountQuota, ChatGptAdditionalQuotaLimit, ChatGptQuotaWindow } from '@chatgpt-to-claude/chatgpt-backend';
import type { AccountView } from '../services/account-pool.js';
import type { AccountQuotaResult } from '../services/account-quota-service.js';

// Local bindings keep serialized renderer functions independent of module-loader aliases.
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

export function renderAccountCards(accounts: AdminAccountView[]): string {
  if (!accounts.length) return '<div class="empty-state"><strong>尚未添加 ChatGPT 账号</strong><span>使用“添加 ChatGPT 账号”完成正常的浏览器授权流程。</span></div>';
  return `<div class="account-grid">${accounts.map(renderAccountCard).join('')}</div>`;
}

export function renderQuotaCards(quotas: AccountQuotaResult[], accounts: AdminAccountView[] = []): string {
  if (!quotas.length) return '<div class="empty-state"><strong>暂无配额结果</strong><span>配额结果由 provider allowance 查询独立提供；添加账号后可刷新。</span></div>';
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  return `<div class="quota-grid">${quotas.map((result) => renderQuotaCard(result, accountsById.get(result.accountId))).join('')}</div>`;
}

function renderAccountCard(account: AdminAccountView): string {
  const stats = account.requestStats;
  const identity = account.email || account.label;
  const health = accountHealth(account);
  const modelItems = account.discoveredModels.length
    ? account.discoveredModels.map((model) => `<li><code>${esc(model.id)}</code>${model.displayName && model.displayName !== model.id ? `<span>${esc(model.displayName)}</span>` : ''}</li>`).join('')
    : '<li class="muted">尚未发现动态模型</li>';
  return `<article class="account-card" data-account-id="${esc(account.id)}">
    <header class="card-header"><div class="identity"><span class="eyebrow">${esc(account.provider === 'chatgpt-session' ? 'ChatGPT Account' : 'Mock Account')}</span><h3>${esc(account.label)}</h3><p class="wrap-anywhere">${esc(identity)}</p></div><span class="state-badge ${health.tone}">${esc(health.label)}</span></header>
    <dl class="account-summary">
      <div><dt>套餐</dt><dd>${esc(planPresentationText(account.plan ?? presentPlan(undefined, account.planType)))}</dd></div>
      <div><dt>启用</dt><dd>${account.enabled ? '已启用' : '已停用'}</dd></div>
      <div><dt>模型</dt><dd>${esc(discoveryMessage(account.discovery ?? unknownDiscovery(), account.modelCount))}</dd></div>
      <div><dt>最近活动</dt><dd>${esc(formatTime(stats.lastRequestAt || account.lastUsedAt))}</dd></div>
    </dl>
    <p class="muted">5x/20x 是套餐类别标识，不代表当前剩余额度。</p>
    <div class="stat-line" aria-label="请求结果统计"><span>成功 ${stats.successfulRequests}</span><span>失败 ${stats.failedRequests}</span><span>取消 ${stats.cancelledRequests}</span><span>总计 ${stats.totalRequests}</span></div>
    <div class="professional-detail" data-professional-only>
      <dl class="technical-list">
        <div><dt>内部 ID</dt><dd><code class="wrap-anywhere">${esc(account.id)}</code></dd></div>
        <div><dt>上游 ID</dt><dd><code class="wrap-anywhere">${esc(account.upstreamAccountId || '不可用')}</code></dd></div>
        <div><dt>凭据到期</dt><dd>${esc(formatTime(account.credentialExpiresAt))}</dd></div>
        <div><dt>并发</dt><dd>${account.currentConcurrency} / ${account.maxConcurrency}</dd></div>
        <div><dt>冷却至</dt><dd>${esc(formatTime(account.cooldownUntil))}</dd></div>
        <div><dt>安全错误码</dt><dd><code>${esc(account.lastErrorCode || '无')}</code></dd></div>
      </dl>
      <p class="wrap-anywhere">最近发现尝试：${esc(formatTime(account.discovery?.attemptedAt))} · 最近成功：${esc(formatTime(account.discovery?.succeededAt))}</p>
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
  const planType = planPresentationText(result.plan ?? presentPlan(result, account?.planType));
  const mainWindows = quota?.windows ?? [];
  const fiveHour = mainWindows.find((window) => window.durationSeconds === 18_000);
  const weekly = mainWindows.find((window) => window.durationSeconds === 604_800);
  const otherMain = mainWindows.filter((window) => window !== fiveHour && window !== weekly);
  const additional = quota?.additionalLimits ?? [];
  const allowance = quota ? allowanceText(quota) : 'Provider allowance 未知';
  return `<article class="quota-card" data-quota-account="${esc(result.accountId)}">
    <header class="card-header"><div class="identity"><span class="eyebrow">${esc(planType)}</span><h3>${esc(accountLabel)}</h3><p class="wrap-anywhere">${esc(accountIdentity)}</p></div><span class="state-badge ${state.tone}">${esc(state.label)}</span></header>
    ${result.supported ? `<p class="allowance-state"><strong>${esc(allowance)}</strong><span>仅展示上游返回的 allowance 与 meter，不从套餐、429 或请求统计推断。</span></p>
    <div class="window-grid">
      ${fiveHour ? renderMeter('五小时窗口', fiveHour) : renderUnavailable('五小时窗口不可用')}
      ${weekly ? renderMeter('每周窗口', weekly) : renderUnavailable('每周窗口不可用')}
    </div>
    ${otherMain.length ? `<section class="meter-section"><h4>其他上游窗口</h4>${otherMain.map((window) => renderMeter(window.descriptor || window.position, window)).join('')}</section>` : ''}
    ${additional.map(renderAdditionalLimit).join('')}` : `<p class="allowance-state"><strong>此账号不支持配额查询</strong><span>当前 provider 或账号类型不提供 quota lookup；无法刷新此账号配额。</span></p>`}
    <footer class="quota-footer"><span>最后获取：${esc(formatTime(result.fetchedAt))}</span>${result.error ? `<span>状态详情：${esc(result.error.message)} <code>${esc(result.error.code)}</code></span>` : ''}${result.supported ? `<button type="button" class="secondary" data-quota-refresh="${esc(result.accountId)}">刷新此账号</button>` : ''}</footer>
  </article>`;
}

function renderAdditionalLimit(limit: ChatGptAdditionalQuotaLimit, index: number): string {
  const title = limit.limitName || limit.meteredFeature || `附加额度 ${index + 1}`;
  const state = limit.allowed === false || limit.limitReached === true ? '不可用' : limit.allowed === true ? '可用' : '状态未知';
  const windows = limit.windows.length
    ? limit.windows.map((window) => renderMeter(window.descriptor || window.position, window)).join('')
    : '<p class="unavailable">上游未返回 meter 窗口</p>';
  return `<section class="meter-section"><div class="section-heading"><h4>${esc(title)}</h4><span>${esc(state)}</span></div>${windows}</section>`;
}

function renderMeter(label: string, window: ChatGptQuotaWindow): string {
  const used = validPercent(window.usedPercent);
  const duration = window.durationSeconds === undefined ? '时长未知' : formatDuration(window.durationSeconds);
  const reset = window.resetAt ? `${formatTime(window.resetAt)}（${relativeReset(window.resetAt)}）` : window.resetAfterSeconds !== undefined ? relativeSeconds(window.resetAfterSeconds) : '重置时间未知';
  if (used === undefined) return `<div class="meter-row meter-unknown"><div class="meter-copy"><strong>${esc(label)}</strong><span>用量未知 · ${esc(duration)}</span></div><p>上游未返回百分比，不显示零值进度条。重置：${esc(reset)}</p></div>`;
  const remaining = Math.max(0, 100 - used);
  return `<div class="meter-row"><div class="meter-copy"><strong>${esc(label)}</strong><span>已用 ${formatPercent(used)}% · 剩余 ${formatPercent(remaining)}%</span></div><div class="meter-track" role="progressbar" aria-label="${esc(label)} 已用 ${formatPercent(used)}%" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}" aria-valuetext="已用 ${formatPercent(used)}%，剩余 ${formatPercent(remaining)}%"><span class="meter-fill" style="width:${used}%"></span></div><p>${esc(duration)} · 重置：${esc(reset)}</p></div>`;
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

const browserFunctions = [presentPlan, planPresentationText, discoveryMessage, unknownDiscovery,renderAccountCards, renderQuotaCards, renderAccountCard, renderQuotaCard, renderAdditionalLimit, renderMeter, renderUnavailable, accountHealth, quotaState, allowanceText, validPercent, formatPercent, formatDuration, formatTime, relativeReset, relativeSeconds, esc];

export function adminPageViewSource(): string {
  return browserFunctions.map((fn) => fn.toString()).join('\n');
}
