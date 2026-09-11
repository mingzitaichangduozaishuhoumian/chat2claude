import { describe, expect, it, vi } from 'vitest';
import { adminPageClientScript } from './routes/admin-page-client.js';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { adminPageViewSource, renderAccountCards, renderQuotaCards, renderAdminOverview, renderRequestInspector, type AdminAccountView, type AdminOverviewData } from './routes/admin-page-view.js';

describe('Admin UI redesign contracts', () => {
  it('places recommended direct setup before optional CC Switch with copyable configurations', async () => {
    const app = createApp(loadEnv({ NODE_ENV: 'test' }));
    try {
      const html = await (await app.request('/admin')).text();
      const markup = html.slice(html.indexOf('<body>'), html.indexOf('<script>'));
      expect(markup.indexOf('直接接入 Claude Code（推荐）')).toBeLessThan(markup.indexOf('通过 CC Switch 接入（可选）'));
      expect(markup).toContain('无需第三方工具');
      expect(markup).toContain('不是必需项，也不是本项目依赖');
      for (const name of ['claude-code', 'cc-switch']) {
        expect(markup).toContain(`id="copy-${name}-config"`);
        expect(markup).toContain(`<pre id="${name}-config" data-i18n-ignore></pre>`);
        expect(markup).toContain(`id="${name}-copy-status" role="status" aria-live="polite"`);
      }
      const setupClient = adminPageClientScript().slice(0, adminPageClientScript().indexOf('const overviewLoadState'));
      expect(setupClient).toContain("ANTHROPIC_AUTH_TOKEN: '<your-runtime-api-key>'");
      expect(setupClient).toContain('const copiedConfig = keyAtCopy ?');
      expect(setupClient).toContain("window.addEventListener('pagehide', () => clearOneTimeRuntimeApiKey());");
      expect(setupClient).not.toContain('clientSetupConfig(true)');
    } finally { await app.dispose(); }
  });
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
    const loadModels = new Function('document', 'getJson', 'bindModelActions', `let modelsCache; const overviewLoadState = {}; function renderOverviewPanel() {}
${adminPageViewSource()}\n${helpers}\n${load}\nreturn loadModels;`)(document, async () => ({
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

    expect(html).toContain('id="runtime-api-key-name"');
    expect(html).toContain('placeholder="Key 名称（可选）"');
    expect(html).toContain('aria-label="Runtime API Key 名称（可选）"');
    expect(html).toContain('id="generate-runtime-api-key"');
    expect(html).toContain('生成新 Key 不会撤销现有 Key');
    expect(html).toContain('id="runtime-api-key-once"');
    expect(html).toContain('id="copy-runtime-api-key"');
    expect(html).toContain('id="dismiss-runtime-api-key"');
    expect(html).toContain('id="runtime-key-copy-status"');
    expect(html).toContain('<details id="admin-key-fallback" data-professional-only>');
    expect(html).toContain('高级：外部管理访问（Admin API Key）');
    expect(html).toContain('优先在本机浏览器使用 HttpOnly 会话');
    expect(html).toContain('本项目不创建隧道、不配置 NAT、也不发布服务');
    expect(html).toContain('Admin API Key（API_KEYS）与本机 HttpOnly 会话用于受保护的');
    expect(html).toContain('Runtime API Key 仅用于');
    expect(html).toContain('访问受保护的 Admin API 会被拒绝');
    expect(html).toContain('普通客户端应使用 Runtime API Key');
    expect(html).toContain('跨浏览器和服务重启保持有效，直至显式撤销');
    expect(html).toContain('[data-admin-mode="simple"] [id="admin-key-fallback"]');
    expect(html).toContain("postJson('/admin/api/api-keys', name ? { name } : undefined)");
    expect(html).toContain('let generatingRuntimeApiKey = false;');
    expect(html).toContain('await loadApiKeys();');
    expect(html).toContain('function showOneTimeRuntimeApiKey(value)');
    expect(html).toContain('function clearOneTimeRuntimeApiKey()');
    expect(html).toContain('delete apiKey.dataset.value;');
    expect(html).toContain("key === 'apiKey' || key === 'key' ? '<one-time-key-hidden>'");
    expect(html).toContain('剪贴板不可用，请手动选中上方完整 Key 并立即保存。');
    expect(html).toContain("setAdminMode('professional');");
    expect(html).toContain("selectModule('admin-access');");
    expect(html).toContain('adminKeyInput.focus();');
    await app.dispose();
  });

  it('keeps the professional request inspector limited to safe diagnostic metadata', async () => {
    const app = createApp(loadEnv({ NODE_ENV: 'test' }));
    try {
      const html = await (await app.request('/admin')).text();
      expect(html).toContain('id="request-diagnostics"');
      expect(html).toContain('id="refresh-request-diagnostics"');
      expect(html).toContain("getJson('/admin/api/diagnostics/requests')");
      expect(html).toContain('renderRequestInspector(requestDiagnosticsCache)');
      const inspector = renderRequestInspector([{ route: '/v1/messages', model: 'sonnet', stream: true, time: '2026-09-09T00:00:00.000Z', body: 'REQUEST-BODY-CANARY', headers: 'HEADER-CANARY', secret: 'SECRET-CANARY' } as any]);
      expect(inspector).toContain('/v1/messages');
      expect(inspector).toContain('sonnet');
      expect(inspector).toContain('是');
      expect(inspector).not.toContain('REQUEST-BODY-CANARY');
      expect(inspector).not.toContain('HEADER-CANARY');
      expect(inspector).not.toContain('SECRET-CANARY');
    } finally { await app.dispose(); }
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
      expect(html).not.toContain('<dd>ChatGPT Pro 5x · prolite');
    }
  });
  it('renders distinct authentication and quota workspaces with independent data calls', async () => {
    const app = createApp(loadEnv({ NODE_ENV: 'test' }));
    const html = await (await app.request('/admin')).text();

    expect(html).toContain('data-admin-module="authentication"');
    expect(html).toContain('data-admin-module="quota"');
    expect(html).toContain('id="authentication-module"');
    expect(html).toContain('id="quota-module"');
    expect(html).toContain('账号与授权');
    expect(html).toContain('配额');
    expect(html).toContain("getJson('/admin/api/accounts')");
    expect(html).toContain("getJson('/admin/api/quotas')");
    expect(html).toContain("postJson('/admin/api/quotas/refresh')");
    expect(html).toContain("'/admin/api/quotas/' + encodeURIComponent(accountId) + (activeReset ? '/active-reset' : '/refresh')");
    expect(html).toContain("localStorage.setItem('adminViewMode', mode)");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(':focus-visible');
    expect(html).toContain('@media(max-width:420px)');
    expect(html).not.toMatch(/gradient\s*\(/i);
    expect(html.match(/<style>([\s\S]*?)<\/style>/)?.[1]).not.toMatch(/#[0-9a-f]*[89a-f][0-9a-f]*[5-9a-f][0-9a-f]*/i);
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
    expect(html).toContain('data-admin-module="overview" aria-controls="overview-module" aria-selected="true" tabindex="0"');
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
    expect(html).toContain('ChatGPT Plus');
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
  it('keeps six unique destinations with linked tabs and each workflow owned by one panel', async () => {
    const app = createApp(loadEnv({ NODE_ENV: 'test' }));
    try {
      const html = await (await app.request('/admin')).text();
      const markup = html.slice(html.indexOf('<body>'), html.indexOf('<script>'));
      const destinations = ['overview', 'authentication', 'models', 'api-access', 'quota', 'admin-access'];
      expect([...markup.matchAll(/data-admin-module="([^"]+)"/g)].map((match) => match[1])).toEqual(destinations);
      const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
      expect(new Set(ids).size).toBe(ids.length);
      for (const destination of destinations) {
        expect(markup).toContain(`aria-controls="${destination}-module"`);
        expect(markup).toContain(`aria-labelledby="${destination}-tab"`);
      }
      expect(markup.indexOf('id="models-module"')).toBeLessThan(markup.indexOf('id="create-model-form"'));
      expect(markup.indexOf('id="api-access-module"')).toBeLessThan(markup.indexOf('id="runtime-api-key-once"'));
      expect(markup.indexOf('id="admin-access-module"')).toBeLessThan(markup.indexOf('id="admin-api-key"'));
      expect(markup).toContain('data-i18n="概览"');
    } finally { await app.dispose(); }
  });

  it('routes legacy/new hashes and keyboard navigation without rebuilding destination contents', () => {
    const script = adminPageClientScript();
    const navigation = script.slice(script.indexOf('function selectModule(name)'), script.indexOf("document.getElementById('save-admin-api-key')"));
    const names = ['overview', 'authentication', 'models', 'api-access', 'quota', 'admin-access'];
    const listeners: Array<Record<string, (event?: { key: string; preventDefault: () => void }) => void>> = [];
    const buttons = names.map((name, index) => ({ dataset: { adminModule: name }, tabIndex: -1, setAttribute: vi.fn(), focus: vi.fn(), addEventListener: (event: string, handler: (event?: { key: string; preventDefault: () => void }) => void) => { (listeners[index] ??= {})[event] = handler; } }));
    const modules = names.map((name) => ({ dataset: { moduleName: name }, hidden: true, draft: 'preserved' }));
    const history = { state: {}, replaceState: vi.fn() };
    const window = { addEventListener: vi.fn() };
    const select = new Function('moduleButtons', 'modules', 'history', 'location', 'window', `${navigation}\nreturn selectModule;`)(buttons, modules, history, { hash: '#quota' }, window);
    expect(modules[4].hidden).toBe(false);
    for (const [hash, expected] of [['authentication', 1], ['accounts', 1], ['api-config', 3], ['quotas', 4], ['models', 2], ['admin-access', 5], ['unknown', 0]]) {
      select(hash);
      expect(modules.map((module) => !module.hidden)).toEqual(names.map((_name, index) => index === expected));
    }
    listeners[0].keydown({ key: 'ArrowUp', preventDefault: vi.fn() });
    expect(buttons[5].focus).toHaveBeenCalled();
    listeners[5].keydown({ key: 'ArrowDown', preventDefault: vi.fn() });
    expect(buttons[0].focus).toHaveBeenCalled();
    expect(modules.every((module) => module.draft === 'preserved')).toBe(true);
  });

  it.each(['/admin/api/quotas', '/admin/api/quotas/refresh', '/admin/api/quotas/session/refresh', '/admin/api/quotas/session/active-reset'])('keeps quota 401 recovery local for %s', async (url) => {
    const script = adminPageClientScript();
    const request = script.slice(script.indexOf('async function requestJson('), script.indexOf('function loadFailureHtml('));
    const selectModule = vi.fn();
    const setAdminMode = vi.fn();
    const fallback = { open: false };
    const input = { focus: vi.fn() };
    const requestJson = new Function('fetchWithAdminKey', 'document', 'setAdminSessionState', 'setAdminMode', 'selectModule', 'adminKeyFallback', 'adminKeyInput', 'renderResult', `${request}\nreturn requestJson;`)(
      async () => Response.json({ error: 'provider-raw-secret' }, { status: 401 }),
      { documentElement: { dataset: { adminMode: 'simple' } } }, vi.fn(), setAdminMode, selectModule, fallback, input, vi.fn(),
    );
    await expect(requestJson(url)).rejects.toMatchObject({ status: 401, message: expect.stringContaining('配额管理认证已失效') });
    expect(selectModule).not.toHaveBeenCalled();
    expect(setAdminMode).not.toHaveBeenCalled();
    expect(input.focus).not.toHaveBeenCalled();
    expect(fallback.open).toBe(false);
  });

  it('requires confirmation before reset, suppresses double clicks, and retains a local failure', async () => {
    const script = adminPageClientScript();
    const action = script.slice(script.indexOf('async function refreshQuotaAccount('), script.indexOf("document.getElementById('refresh-all-quotas').addEventListener"));
    const confirm = vi.fn(() => false);
    let reject!: (error: Error) => void;
    const post = vi.fn(() => new Promise((_resolve, rej) => { reject = rej; }));
    const fixture = { accountId: 'session', canActiveReset: true, status: 'fresh', expiresAt: '2099-01-01T00:00:00Z', quota: { windows: [], resetCredits: { availableCount: 3 } } };
    const run = new Function('window', 'postJson', 'fixture', `let quotasCache = [fixture]; const pendingQuotaAccounts = new Set(); let quotaRefreshAllPending = false; let quotaRequestState = {}; const adminLocale = 'en';
      function translateAdminText(text) { return text; } function renderQuotaPanel() {} function announce() {} function renderResult() {} function quotaRefreshFeedback() {}
      ${action}\nreturn { refreshQuotaAccount, state: () => quotaRequestState };` )({ confirm }, post, fixture);
    await run.refreshQuotaAccount('session', true);
    expect(post).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    const pending = run.refreshQuotaAccount('session', true);
    await run.refreshQuotaAccount('session', true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/admin/api/quotas/session/active-reset', { confirm: true });
    reject(new Error('local authentication recovery'));
    await pending;
    expect(run.state()).toEqual({ status: 'error', error: 'local authentication recovery' });
    expect(fixture.quota.resetCredits.availableCount).toBe(3);
    expect(fixture.canActiveReset).toBe(false);
  });

  it('emphasizes provider plan and identity and gates reset independently of missing counts', () => {
    const fixture = account({ id: 'session', email: 'synthetic@example.test', planType: 'must-not-infer' });
    const base = { accountId: fixture.id, createdAt: fixture.createdAt, supported: true, status: 'fresh' as const,
      canActiveReset: true, expiresAt: '2099-01-01T00:00:00Z', quota: { planType: 'plus', windows: [], resetCredits: { availableCount: 3 } } };
    const html = renderQuotaCards([base], [fixture], 'en');
    expect(html).toContain('quota-account-identity');
    expect(html).toContain('synthetic@example.test');
    expect(html).toContain('quota-plan-badge');
    expect(html).toContain('<strong data-i18n-ignore>ChatGPT Plus</strong>');
    expect(html).toContain('Available reset credits');
    expect(html).toContain('data-admin-number="3"');
    expect(html).toContain('data-quota-reset="session"');
    expect(html).toContain('Consume one provider reset credit');
    expect(html).not.toContain('must-not-infer');
    for (const result of [
      { ...base, canActiveReset: false }, { ...base, status: 'stale' as const },
      { ...base, expiresAt: '2000-01-01T00:00:00Z' }, { ...base, supported: false },
      { ...base, quota: { windows: [] } },
      { ...base, quota: { windows: [], resetCredits: { availableCount: 0 } } },
      { ...base, quota: { windows: [], resetCredits: { error: 'fetch_failed' as const } } },
    ]) expect(renderQuotaCards([result], [fixture])).not.toContain('data-quota-reset=');
  });

  it.each(['zh-CN', 'en'] as const)('renders mapped Pro labels prominently in server quota cards for %s', (locale) => {
    const quotas = ['prolite', 'pro'].map((planType, index) => ({
      accountId: `plan-${planType}`, createdAt: `2026-09-0${index + 1}T00:00:00.000Z`, supported: true as const, status: 'fresh' as const,
      quota: { planType, allowed: true, limitReached: false, windows: [], additionalLimits: [] },
    }));
    const html = renderQuotaCards(quotas, [], locale);
    expect(html).toContain('<strong data-i18n-ignore>ChatGPT Pro 5x</strong>');
    expect(html).toContain('<strong data-i18n-ignore>ChatGPT Pro 20x</strong>');
    expect(html).not.toContain('<strong data-i18n-ignore>prolite</strong>');
    expect(html).not.toContain('<strong data-i18n-ignore>pro</strong>');
  });

  it.each(['simple', 'professional'])('opens and focuses Admin Access after a 401 in %s mode', async (mode) => {
    const script = adminPageClientScript();
    const request = script.slice(script.indexOf('async function requestJson('), script.indexOf('function loadFailureHtml('));
    const selectModule = vi.fn();
    const setAdminMode = vi.fn();
    const fallback = { open: false };
    const input = { focus: vi.fn() };
    const requestJson = new Function('fetchWithAdminKey', 'document', 'setAdminSessionState', 'setAdminMode', 'selectModule', 'adminKeyFallback', 'adminKeyInput', 'renderResult', `${request}\nreturn requestJson;`)(
      async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
      { documentElement: { dataset: { adminMode: mode } } }, vi.fn(), setAdminMode, selectModule, fallback, input, vi.fn(),
    );
    await expect(requestJson('/admin/api/accounts')).rejects.toMatchObject({ status: 401 });
    expect(selectModule).toHaveBeenCalledWith('admin-access');
    expect(fallback.open).toBe(true);
    expect(input.focus).toHaveBeenCalled();
    if (mode === 'simple') expect(setAdminMode).toHaveBeenCalledWith('professional');
  });

  it('renders true cached overview data, independent failures and sorted account activity', () => {
    const data: AdminOverviewData = {
      accounts: [account({ id: 'older', label: 'Older', lastUsedAt: '2026-09-01T00:00:00Z' }), account({ id: 'newer', label: 'Newer', status: 'disabled', enabled: false, requestStats: { ...account().requestStats, lastRequestAt: '2026-09-05T00:00:00Z' } })],
      quotas: [{ accountId: 'older', createdAt: '', supported: true, status: 'fresh', expiresAt: '2000-01-01T00:00:00Z' }, { accountId: 'newer', createdAt: '', supported: true, status: 'error' }],
      models: { discovered: [{ id: 'real-provider-model' }], aliases: [{ enabled: true, status: 'bound' }, { enabled: true, status: 'unbound' }] },
      keyCount: 2, states: { accounts: 'loaded', models: 'loaded', keys: 'error', quotas: 'loaded' }, localSession: true,
    };
    const renderBrowser = new Function(`${adminPageViewSource()}; return renderAdminOverview;`)() as typeof renderAdminOverview;
    const html = renderBrowser(data, 'en');
    expect(html).toContain('Healthy 1 · Unhealthy 0 · Disabled 1');
    expect(html).toContain('Fresh 0 · Stale 1 · Error 1 · Unknown 0');
    expect(html).toContain('Load failed; retaining last cache');
    expect(html).toContain('data-admin-number="2"');
    expect(html.indexOf('Newer')).toBeLessThan(html.indexOf('Older'));
    expect(data.accounts.map((item) => item.id)).toEqual(['older', 'newer']);
    expect(html).toContain('not a complete request log');
    const empty = { ...data, accounts: [], quotas: [], keyCount: 0, models: { aliases: [], discovered: [] } };
    expect(renderAdminOverview(empty, 'en')).toContain('No account activity yet.');
    expect(renderAdminOverview({ ...empty, states: { ...data.states, accounts: 'loading' } }, 'en')).toContain('Loading');
    expect(renderAdminOverview({ ...empty, states: { ...data.states, accounts: 'loading' } }, 'en')).not.toContain('No account activity yet.');
    const overviewClient = adminPageClientScript().split('function renderOverviewPanel()')[1].split('function announce')[0];
    expect(overviewClient).not.toMatch(/fetch|getJson|postJson|localStorage/);
  });

  it('renders bilingual accounts and quotas without translating identities or inventing usage', () => {
    const fixture = account({ label: '健康', discovery: { status: 'success', attemptedAt: null, succeededAt: null, stale: false } });
    const english = renderAccountCards([fixture], 'en');
    expect(english).toContain('<h3 data-i18n-ignore>健康</h3>');
    expect(english).toContain('Discovered 2 account models');
    expect(english).toContain('Refresh health &amp; models');
    expect(english).toContain('operator@example.test');
    const quotas = renderQuotaCards([{ accountId: fixture.id, createdAt: fixture.createdAt, status: 'unknown', supported: true }], [fixture], 'en');
    expect(quotas).toContain('Five-hour window unavailable');
    expect(quotas).toContain('Not fetched');
    expect(quotas).not.toContain('role="progressbar"');
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
