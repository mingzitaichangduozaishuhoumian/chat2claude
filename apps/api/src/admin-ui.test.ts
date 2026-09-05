import { describe, expect, it, vi } from 'vitest';
import { adminPageClientScript } from './routes/admin-page-client.js';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { adminPageViewSource, renderAccountCards, renderQuotaCards, type AdminAccountView } from './routes/admin-page-view.js';

describe('Admin UI redesign contracts', () => {
  it('keeps basic mapping visible and marks static and dynamic advanced controls professional-only', async () => {
    const app = createApp(loadEnv({ NODE_ENV: 'test' }));
    const html = await (await app.request('/admin')).text();
    expect(html).toMatch(/<section class="panel model-mapping-panel">/);
    expect(html).toMatch(/<form id="create-model-form"[^>]*data-professional-only/);
    expect(html).toMatch(/<button id="reset-models"[^>]*data-professional-only/);
    expect(html).toMatch(/<button id="refresh-models"[^>]*data-professional-only/);
    expect(html).not.toMatch(/需要(?:切换到)?专业模式选择后端模型/);
    expect(html).toContain('[data-admin-mode="simple"] .model-mapping-panel table');
    const script = adminPageClientScript();
    const elements = new Map<string, { innerHTML: string }>();
    const document = { getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, { innerHTML: '' });
      return elements.get(id)!;
    } };
    const helpers = script.slice(script.indexOf('function backendOptionsHtml('), script.indexOf("document.getElementById('create-model-form')"));
    const load = script.slice(script.indexOf('async function loadModels()'), script.indexOf('function bindModelActions('));
    const loadModels = new Function('document', 'getJson', 'bindModelActions', `${adminPageViewSource()}\n${helpers}\n${load}\nreturn loadModels;`)(document, async () => ({
      aliases: [{ id: 'custom', enabled: true, defaults: {}, status: 'unbound' }], discovered: [{ id: 'provider' }],
    }), vi.fn());
    await loadModels();
    const table = elements.get('models')!.innerHTML;
    expect(table).toContain('<th data-professional-only>状态</th>');
    expect(table).toContain('<th data-professional-only>目标能力与默认参数</th>');
    expect(table).toContain('<td data-professional-only>unbound</td>');
    expect(table).toContain('<td data-professional-only><div class="stack"');
    expect(table).toMatch(/<button[^>]*data-professional-only[^>]*data-delete-model="custom"/);
    expect(table).toContain('<button data-save-model="custom">保存</button>');
    expect(table).toMatch(/<div data-professional-only><p class="muted">Backend discovery/);
    await app.dispose();
  });

  it('keeps Runtime key generation visible, one-time, and separate from advanced remote management credentials', async () => {
    const app = createApp(loadEnv({ NODE_ENV: 'test' }));
    const html = await (await app.request('/admin')).text();

    expect(html).toContain('id="generate-runtime-api-key"');
    expect(html).toContain('生成新 Key 不会撤销现有 Key');
    expect(html).toContain('id="runtime-api-key-once"');
    expect(html).toContain('id="copy-runtime-api-key"');
    expect(html).toContain('id="dismiss-runtime-api-key"');
    expect(html).toContain('id="runtime-key-copy-status"');
    expect(html).toContain('<details id="admin-key-fallback" data-professional-only>');
    expect(html).toContain('高级：远程管理凭据（Admin API Key）');
    expect(html).toContain('跨浏览器和服务重启保持有效，直至显式撤销');
    expect(html).toContain('[data-admin-mode="simple"] [id="admin-key-fallback"]');
    expect(html).toContain("postJson('/admin/api/api-keys')");
    expect(html).toContain('let generatingRuntimeApiKey = false;');
    expect(html).toContain('await loadApiKeys();');
    expect(html).toContain('function showOneTimeRuntimeApiKey(value)');
    expect(html).toContain('function clearOneTimeRuntimeApiKey()');
    expect(html).toContain('delete apiKey.dataset.value;');
    expect(html).toContain("key === 'apiKey' || key === 'key' ? '<one-time-key-hidden>'");
    expect(html).toContain('剪贴板不可用，请手动选中上方完整 Key 并立即保存。');
    expect(html).toContain("setAdminMode('professional');");
    expect(html).toContain("selectModule('authentication');");
    expect(html).toContain('adminKeyInput.focus();');
    await app.dispose();
  });

  it('toggles modes without refetch or losing advanced edits and omits defaults in the simple PATCH', async () => {
    const script = adminPageClientScript();
    const fields: Record<string, { value?: string; checked?: boolean }> = {
      backendModel: { value: 'new-target' }, enabled: { checked: true },
      reasoning_effort: { value: 'future-deep' }, speed: { value: 'priority' },
    };
    const document = {
      documentElement: { dataset: { adminMode: 'professional' } },
      querySelector: (selector: string) => fields[selector.match(/data-field="([^"]+)"/)![1]],
    };
    const patchJson = vi.fn(async () => ({}));
    const loadModels = vi.fn();
    const mode = script.slice(script.indexOf('function setAdminMode('), script.indexOf('modeButtons.simple.addEventListener'));
    const save = script.slice(script.indexOf('async function saveModel('), script.indexOf('function backendOptionsHtml('));
    const controls = new Function('document', 'CSS', 'modeButtons', 'localStorage', 'patchJson', 'renderResult', 'loadModels', `${mode}\n${save}\nreturn { setAdminMode, saveModel };`)(
      document, { escape: (value: string) => value }, { simple: { setAttribute: vi.fn() }, professional: { setAttribute: vi.fn() } }, { setItem: vi.fn() }, patchJson, vi.fn(), loadModels,
    );
    controls.setAdminMode('simple');
    controls.setAdminMode('professional');
    expect(fields.reasoning_effort.value).toBe('future-deep');
    expect(fields.speed.value).toBe('priority');
    expect(loadModels).not.toHaveBeenCalled();
    await controls.saveModel('custom');
    expect(patchJson).toHaveBeenLastCalledWith('/admin/api/models/custom', { backendModel: 'new-target', enabled: true, defaults: { reasoning_effort: 'future-deep', service_tier: 'priority' } });
    controls.setAdminMode('simple');
    await controls.saveModel('custom');
    expect(patchJson).toHaveBeenLastCalledWith('/admin/api/models/custom', { backendModel: 'new-target', enabled: true });
  });

  it.each(['fast', 'FASTEST', 'Priority'])('renders one canonical Fast for current %s without changing reasoning semantics', (current) => {
    const script = adminPageClientScript();
    const helpers = script.slice(script.indexOf('function controlSelectsHtml('), script.indexOf("document.getElementById('create-model-form')"));
    const render = new Function(`${adminPageViewSource()}\n${helpers}\nreturn controlSelectsHtml;`)();
    for (const supported of [[], [{ id: 'economy' }, { id: 'FASTEST' }, { id: 'flex' }, { id: 'fast' }, { id: 'priority' }]]) {
      const html = render({ capabilities: { service_tiers: supported, reasoning_effort_options: [{ effort: 'low' }] } }, { speed: current, reasoning_effort: 'future-effort' }, 'custom');
      const tiers = html.match(/<select data-field="speed"[^>]*>([\s\S]*?)<\/select>/)![1];
      expect([...tiers.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1])).toEqual(supported.length ? ['standard', 'auto', 'priority', 'economy', 'flex'] : ['standard', 'auto', 'priority']);
      expect(tiers).toMatch(/<option value="priority"[^>]*selected[^>]*>Fast/);
      expect(html).toContain('future-effort（配置不受目标支持）');
      expect(html).toContain('Light（官方 low）');
    }
  });

  it.each([200, 502])('reloads authoritative account and model state after health discovery HTTP %s', async (status) => {
    const script = adminPageClientScript();
    const healthBinding = script.slice(script.indexOf('function bindAccountActions()'), script.indexOf("  document.querySelectorAll('[data-account-reauthorize]')")) + '}';
    const requestJson = script.slice(script.indexOf('async function requestJson('), script.indexOf('function loadFailureHtml('));
    const pendingButton = script.slice(script.indexOf('async function withPendingButton('), script.indexOf('void loadQuotas();'));
    let click!: () => Promise<void>;
    const button = { dataset: { accountHealth: 'synthetic-account' }, disabled: false, textContent: '刷新健康与模型', addEventListener: (_event: string, callback: () => Promise<void>) => { click = callback; } };
    let displayedDiscovery = 'success';
    const expectedDiscovery = status === 502 ? 'error' : 'partial';
    const loadAccounts = vi.fn(async () => { expect(button.disabled).toBe(true); displayedDiscovery = expectedDiscovery; });
    const loadModels = vi.fn(async () => { expect(button.disabled).toBe(true); });
    const renderResult = vi.fn();
    const fetchWithAdminKey = vi.fn(async () => new Response(JSON.stringify({ ok: status === 200, message: status === 502 ? '最新刷新失败，继续使用 1 个缓存模型' : '部分条目被安全忽略' }), { status, headers: { 'content-type': 'application/json' } }));
    const bind = new Function('document', 'fetchWithAdminKey', 'renderResult', 'loadAccounts', 'loadModels', `${requestJson}\n${pendingButton}\nasync function postJson(url) { return requestJson(url, { method: 'POST' }); }\n${healthBinding}\nreturn bindAccountActions;`)(
      { querySelectorAll: () => [button] }, fetchWithAdminKey, renderResult, loadAccounts, loadModels,
    );
    bind();
    await click();
    expect(fetchWithAdminKey).toHaveBeenCalledWith('/admin/api/accounts/synthetic-account/health-check', { method: 'POST' });
    expect(loadAccounts).toHaveBeenCalledTimes(1);
    expect(loadModels).toHaveBeenCalledTimes(1);
    expect(displayedDiscovery).toBe(expectedDiscovery);
    expect(button).toMatchObject({ disabled: false, textContent: '刷新健康与模型' });
    if (status === 502) expect(renderResult).toHaveBeenLastCalledWith({ error: '最新刷新失败，继续使用 1 个缓存模型' });
    else expect(renderResult).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true }));
  });
  it('renders safe plan labels and all discovery outcomes in browser-shared renderers', () => {
    const renderInBrowser = new Function(`${adminPageViewSource()}; return renderAccountCards;`)() as typeof renderAccountCards;
    const cases: Array<[NonNullable<AdminAccountView['discovery']>['status'], number, string]> = [
      ['unknown', 0, '尚无已验证目录'], ['success', 2, '已发现 2 个账号级模型'],
      ['partial', 1, '部分条目被安全忽略'], ['empty', 0, '上游明确返回空目录'],
      ['error', 0, '模型响应格式不兼容'], ['error', 2, '继续使用 2 个缓存模型'],
    ];
    for (const [status, count, message] of cases) {
      const fixture = account({ planType: 'prolite', modelCount: count, discovery: { status, attemptedAt: null, succeededAt: null, stale: status === 'error' && count > 0, error: 'invalid_response' } });
      const html = renderInBrowser([fixture]);
      expect(html).toContain(message);
      expect(html).toContain('ChatGPT Pro 5x');
      expect(html).toContain('prolite');
    }
  });
  it('renders distinct authentication and quota workspaces with independent data calls', async () => {
    const app = createApp(loadEnv({ NODE_ENV: 'test' }));
    const html = await (await app.request('/admin')).text();

    expect(html).toContain('data-admin-module="authentication"');
    expect(html).toContain('data-admin-module="quota"');
    expect(html).toContain('id="authentication-module"');
    expect(html).toContain('id="quota-module"');
    expect(html).toContain('认证管理');
    expect(html).toContain('配额管理');
    expect(html).toContain("getJson('/admin/api/accounts')");
    expect(html).toContain("getJson('/admin/api/quotas')");
    expect(html).toContain("postJson('/admin/api/quotas/refresh')");
    expect(html).toContain("'/admin/api/quotas/' + encodeURIComponent(accountId) + '/refresh'");
    expect(html).toContain("localStorage.setItem('adminViewMode', mode)");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(':focus-visible');
    expect(html).toContain('@media(max-width:420px)');
    expect(html).not.toMatch(/gradient\s*\(/i);
    expect(html).not.toMatch(/#[0-9a-f]*[89a-f][0-9a-f]*[5-9a-f][0-9a-f]*/i);
    expect(html).not.toMatch(/[😀-🙏🌀-🫿]/u);
    expect(html).not.toContain('1.5x');
    expect(html).not.toContain('2x');
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    await app.dispose();
  });

  it('emits linked APG automatic-activation tabs without focusing panel headings', async () => {
    const app = createApp(loadEnv({ NODE_ENV: 'test' }));
    const html = await (await app.request('/admin')).text();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];

    expect(html.match(/id="authentication-tab"/g)).toHaveLength(1);
    expect(html.match(/id="quota-tab"/g)).toHaveLength(1);
    expect(html).toContain('aria-controls="authentication-module"');
    expect(html).toContain('aria-controls="quota-module"');
    expect(html).toContain('aria-labelledby="authentication-tab"');
    expect(html).toContain('aria-labelledby="quota-tab"');
    expect(html).toContain('data-admin-module="authentication" aria-controls="authentication-module" aria-selected="true" tabindex="0"');
    expect(html).toContain('data-admin-module="quota" aria-controls="quota-module" aria-selected="false" tabindex="-1"');
    expect(html).not.toMatch(/<h2\b[^>]*\btabindex=/);
    expect(script).toBeTruthy();

    const tabScript = script!.slice(
      script!.indexOf('function selectModule(name)'),
      script!.indexOf("document.getElementById('save-admin-api-key')"),
    );
    expect(tabScript).toContain("button.tabIndex = selected ? 0 : -1");
    expect(tabScript).toContain("button.addEventListener('click', () => selectModule(button.dataset.adminModule));");
    expect(tabScript).toMatch(/function focusModuleTab\(index\) \{[\s\S]*selectModule\(button\.dataset\.adminModule\);[\s\S]*button\.focus\(\);/);
    expect(tabScript).toContain("event.key === 'ArrowRight'");
    expect(tabScript).toContain("event.key === 'ArrowLeft'");
    expect(tabScript).toContain("event.key === 'Home'");
    expect(tabScript).toContain("event.key === 'End'");
    expect(tabScript).toContain('event.preventDefault();');
    expect(tabScript).toContain('focusModuleTab(targetIndex);');
    expect(tabScript).toContain('index === lastIndex ? 0 : index + 1');
    expect(tabScript).toContain('index === 0 ? lastIndex : index - 1');
    expect(tabScript).not.toMatch(/focusHeading|module-title|querySelector\([^)]*h2[^)]*\)\.focus\(\)|getElementById\([^)]*module[^)]*\)\.focus\(\)/);
    await app.dispose();
  });

  it('renders account fixtures for empty, healthy, disabled, error, multiple, and long-text states', () => {
    expect(renderAccountCards([])).toContain('尚未添加 ChatGPT 账号');

    const html = renderAccountCards([
      account({
        id: 'internal-account-id-with-a-very-long-value-that-must-wrap-safely',
        label: 'Primary operator account with a deliberately long label',
        email: 'operator-with-a-very-long-local-part@example-tenant-with-a-long-domain.test',
        planType: 'plus',
        status: 'available',
        enabled: true,
        modelCount: 3,
        discoveredModels: [{ id: 'dynamic-model-alpha' }, { id: 'dynamic-model-beta-with-a-long-identifier' }, { id: 'dynamic-model-gamma' }],
      }),
      account({ id: 'disabled', label: 'Disabled', status: 'disabled', enabled: false, modelCount: 0, discoveredModels: [] }),
      account({ id: 'error', label: 'Error', status: 'error', enabled: true, lastErrorCode: 'unauthorized', modelCount: 1, discoveredModels: [{ id: 'dynamic-only-model' }] }),
    ]);

    expect(html).toContain('Primary operator account');
    expect(html).toContain('plus');
    expect(html).toContain('健康');
    expect(html).toContain('已停用');
    expect(html).toContain('异常');
    expect(html).toContain('成功 7');
    expect(html).toContain('失败 2');
    expect(html).toContain('取消 1');
    expect(html).toContain('发现状态未知；保留 3 个缓存模型');
    expect(html).toContain('ChatGPT Plus');
    expect(html).toContain('5x/20x 是套餐类别标识，不代表当前剩余额度');
    expect(html).toContain('data-professional-only');
    expect(html).toContain('internal-account-id-with-a-very-long-value');
    expect(html).toContain('dynamic-model-beta-with-a-long-identifier');
    expect(html).toContain('data-account-settings');
    expect(html).toContain('data-account-health');
    expect(html).toContain('data-account-reauthorize');
    expect(html).toContain('data-account-toggle');
    expect(html).toContain('data-account-delete');
  });

  it('renders quota fixtures without inventing missing or unknown usage', () => {
    const accounts = [account({ id: 'fresh' }), account({ id: 'stale' }), account({ id: 'unknown' }), account({ id: 'error' })];
    const html = renderQuotaCards([
      {
        accountId: 'fresh', createdAt: accounts[0].createdAt, supported: true, status: 'fresh', fetchedAt: '2026-09-04T00:00:00.000Z',
        quota: {
          planType: 'plus', allowed: true, limitReached: false,
          windows: [
            { position: 'primary', descriptor: 'provider-primary', durationSeconds: 18_000, usedPercent: 25, resetAt: '2026-09-04T05:00:00.000Z' },
            { position: 'secondary', descriptor: 'provider-secondary', durationSeconds: 604_800, usedPercent: 40, resetAfterSeconds: 3600 },
          ],
          additionalLimits: [
            { meteredFeature: 'feature-a', limitName: 'Feature A', allowed: true, limitReached: false, windows: [{ position: 'primary', descriptor: 'extra-known', durationSeconds: 86_400, usedPercent: 55 }] },
            { meteredFeature: 'feature-b', allowed: false, limitReached: true, windows: [{ position: 'secondary', descriptor: 'extra-unknown-duration' }] },
          ],
        },
      },
      { accountId: 'stale', createdAt: accounts[1].createdAt, supported: true, status: 'stale', fetchedAt: '2026-09-03T00:00:00.000Z', quota: { allowed: true, limitReached: false, windows: [], additionalLimits: [] }, error: { code: 'timeout', category: 'timeout', message: 'Quota provider request timed out.' } },
      { accountId: 'unknown', createdAt: accounts[2].createdAt, supported: true, status: 'unknown' },
      { accountId: 'error', createdAt: accounts[3].createdAt, supported: true, status: 'error', error: { code: 'unauthorized', status: 401, category: 'authentication', message: 'Quota provider rejected the account credentials.' } },
    ], accounts);

    expect(html).toContain('五小时窗口');
    expect(html).toContain('每周窗口');
    expect(html).toContain('已用 25%');
    expect(html).toContain('剩余 75%');
    expect(html).toContain('Feature A');
    expect(html).toContain('extra-unknown-duration');
    expect(html).toContain('时长未知');
    expect(html).toContain('五小时窗口不可用');
    expect(html).toContain('每周窗口不可用');
    expect(html).toContain('数据陈旧');
    expect(html).toContain('尚未获取');
    expect(html).toContain('获取失败');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).not.toContain('五小时窗口</span><span>已用 0%');
    expect(html).not.toContain('每周窗口</span><span>已用 0%');
  });

  it('renders quotas from quota results when account metadata is unavailable', () => {
    const html = renderQuotaCards([{
      accountId: 'quota-only', createdAt: '2026-09-01T00:00:00.000Z', supported: true, status: 'fresh',
      quota: { planType: 'authoritative-provider-plan', allowed: true, limitReached: false, windows: [], additionalLimits: [] },
    }], []);

    expect(html).toContain('quota-only');
    expect(html).toContain('authoritative-provider-plan');
    expect(html).toContain('data-quota-refresh="quota-only"');
  });

  it('uses provider plan before account fallback and clearly handles unsupported quota lookup', () => {
    const accountMetadata = account({ id: 'supported', label: 'Account fallback', planType: 'account-plan' });
    const html = renderQuotaCards([
      { accountId: 'supported', createdAt: accountMetadata.createdAt, supported: true, status: 'fresh', quota: { planType: 'provider-plan', allowed: true, limitReached: false, windows: [], additionalLimits: [] } },
      { accountId: 'unsupported', createdAt: '2026-09-01T00:00:00.000Z', supported: false, status: 'unknown', error: { code: 'unsupported', category: 'unsupported', message: 'Account quota is not supported for this account.' } },
    ], [accountMetadata]);

    expect(html).toContain('provider-plan');
    expect(html).not.toContain('account-plan');
    expect(html).toContain('此账号不支持配额查询');
    expect(html).not.toContain('data-quota-refresh="unsupported"');
  });

  it('keeps quota failures independent and marks stale refresh summaries incomplete', async () => {
    const app = createApp(loadEnv({ NODE_ENV: 'test' }));
    const html = await (await app.request('/admin')).text();

    expect(html).toContain("let quotaRequestState = { status: 'idle', error: null };");
    expect(html).toContain('quotaRequestErrorHtml()');
    expect(html).toContain('data-retry-quotas');
    expect(html).toContain("const incomplete = stale + error + unknown;");
    expect(html).toContain('结果不完整。新鲜 ');
    await app.dispose();
  });

  it('reports each single-account quota refresh outcome accurately', async () => {
    const app = createApp(loadEnv({ NODE_ENV: 'test' }));
    const html = await (await app.request('/admin')).text();

    expect(html).toContain('function quotaRefreshFeedback(quota)');
    expect(html).toContain("quota.status === 'fresh'");
    expect(html).toContain('账号配额刷新成功，数据为新鲜状态。');
    expect(html).toContain("quota.status === 'stale'");
    expect(html).toContain('账号配额刷新完成，但返回的是陈旧数据。');
    expect(html).toContain("quota.status === 'error'");
    expect(html).toContain('账号配额刷新完成，但上游返回错误状态。');
    expect(html).toContain("quota.status === 'unknown'");
    expect(html).toContain('账号配额刷新完成，但上游未返回可用状态。');
    expect(html).toContain("quota.error?.code === 'unsupported'");
    expect(html).toContain('此账号不支持配额查询，无法刷新。');
    expect(html).toContain('renderResult({ ...body, message: feedback }); announce(feedback);');
    await app.dispose();
  });

  it('uses loaded accounts only to enrich quota cards without resetting quota request errors', async () => {
    const app = createApp(loadEnv({ NODE_ENV: 'test' }));
    const html = await (await app.request('/admin')).text();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    const accountLoad = script!.slice(script!.indexOf('async function loadAccounts()'), script!.indexOf('function bindAccountActions()'));

    expect(accountLoad).toContain('accountsCache = Array.isArray(body.accounts) ? body.accounts : [];');
    expect(accountLoad).toContain('bindAccountActions();');
    expect(accountLoad).toContain('renderQuotaPanel();');
    expect(accountLoad).not.toContain('quotaRequestState =');
    expect(accountLoad).not.toContain('quotasCache =');
    await app.dispose();
  });

  it('bounds long dynamic state badges without clipping or page-wide overflow suppression', async () => {
    const app = createApp(loadEnv({ NODE_ENV: 'test' }));
    const html = await (await app.request('/admin')).text();

    expect(html).toContain('.state-badge { display: inline-flex; align-items: center; width: fit-content; min-width: 0; max-width: 100%;');
    expect(html).toContain('white-space: normal; overflow-wrap: anywhere; word-break: break-word;');
    expect(html).toContain("'<span class=\"state-badge neutral\" title=\"' + esc(capabilitySummary(model.capabilities)) + '\">' + esc(model.id) + '</span>'");
    expect(html).not.toContain('.state-badge { display: inline-flex; align-items: center; width: max-content;');
    expect(html).not.toMatch(/(?:html|body|\*)\s*\{[^}]*overflow-x\s*:\s*hidden/i);
    await app.dispose();
  });

  it('applies professional mode dynamically and names model mapping controls by alias', async () => {
    const app = createApp(loadEnv({ NODE_ENV: 'test' }));
    const html = await (await app.request('/admin')).text();

    expect(html).toContain('<html lang="zh-CN" data-admin-mode="simple">');
    expect(html).toContain("document.documentElement.dataset.adminMode = professional ? 'professional' : 'simple';");
    expect(html).toContain('[data-admin-mode="simple"] [data-professional-only]');
    expect(html).not.toContain('data-professional-only hidden');
    expect(html).not.toContain('const professionalPanels =');
    expect(html).toContain("aria-label=\"Alias ' + esc(model.id) + ' 的 Backend Model\"");
    expect(html).toContain("aria-label=\"Alias ' + esc(model.id) + ' 是否启用\"");
    const token = html.match(/--ink-faint:\s*rgb\((\d+)\s+(\d+)\s+(\d+)\)/);
    expect(token).toBeTruthy();
    expect(contrastRatio(token!.slice(1).map(Number), [248, 247, 242])).toBeGreaterThanOrEqual(4.7);
    await app.dispose();
  });
});

function contrastRatio(foreground: number[], background: number[]): number {
  const luminance = (color: number[]) => {
    const [red, green, blue] = color.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

function account(overrides: Partial<AdminAccountView> = {}): AdminAccountView {
  return {
    id: 'account', label: 'Account', provider: 'chatgpt-session', status: 'available', enabled: true,
    maxConcurrency: 2, currentConcurrency: 0, lastUsedAt: '2026-09-04T00:00:00.000Z', lastError: null,
    lastErrorCode: null, cooldownUntil: null, capabilities: ['messages'], createdAt: '2026-09-01T00:00:00.000Z',
    hasSecret: true, email: 'operator@example.test', upstreamAccountId: 'upstream-account', planType: 'plus',
    credentialExpiresAt: '2026-10-01T00:00:00.000Z', modelCount: 2,
    discoveredModels: [{ id: 'dynamic-model-one' }, { id: 'dynamic-model-two' }],
    requestStats: { totalRequests: 10, successfulRequests: 7, failedRequests: 2, cancelledRequests: 1, inputTokens: 100, outputTokens: 50, lastRequestAt: '2026-09-04T00:00:00.000Z', inFlight: 0 },
    ...overrides,
  };
}
