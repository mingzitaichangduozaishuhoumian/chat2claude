import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { renderQuotaCards, renderRequestInspector } from './routes/admin-page-view.js';

// Vitest's transform differs from `tsx watch`; serialize in the real dev loader.
function devScript(): string {
  return execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import { adminPageClientScript } from './src/routes/admin-page-client.ts'; process.stdout.write(adminPageClientScript());",
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 20_000 });
}

describe('Admin browser source under the tsx development loader', () => {
  it('serializes reset-credit cards in both locales without loader globals or credit IDs', () => {
    const script = devScript();
    const source = script.slice(0, script.indexOf('let currentFlowId'));
    const quotas = [{ accountId: 'fixture', createdAt: '', supported: true, status: 'fresh', canActiveReset: true,
      expiresAt: '2099-01-01T00:00:00Z', quota: { planType: 'plus', windows: [], resetCredits: { availableCount: 2,
        credits: [{ id: 'hidden-credit-id', status: 'available', expiresAt: '2098-01-01T00:00:00Z' }] } } }];
    for (const locale of ['zh-CN', 'en']) {
      const html = runInNewContext(source + '\nrenderQuotaCards(quotas, [], locale)', { quotas, locale });
      expect(html).toContain('data-quota-reset="fixture"');
      expect(html).toContain(locale === 'en' ? 'Available reset credits' : '可用重置次数');
      expect(html).not.toContain('hidden-credit-id');
    }
  });

  it('serializes the privacy-limited request inspector in both locales', () => {
    const script = devScript();
    const source = script.slice(0, script.indexOf('let currentFlowId'));
    const requests = [{ route: '/v1/messages', model: 'sonnet', stream: true, time: '2026-09-09T00:00:00.000Z', body: 'BODY-CANARY' }];
    for (const locale of ['zh-CN', 'en']) {
      const html = runInNewContext(source + '\nrenderRequestInspector(requests, locale)', { requests, locale });
      expect(html).toContain(locale === 'en' ? 'Route' : '路由');
      expect(html).toContain('/v1/messages');
      expect(html).toContain(locale === 'en' ? 'Yes' : '是');
      expect(html).not.toContain('BODY-CANARY');
    }
    expect(renderRequestInspector(requests)).not.toContain('BODY-CANARY');
  });

  it('executes the serialized overview in both locales without loader globals', () => {
    const script = devScript();
    const source = script.slice(0, script.indexOf('let currentFlowId'));
    const data = { accounts: [], quotas: [], models: { aliases: [], discovered: [] }, keyCount: 0,
      states: { accounts: 'loaded', models: 'loaded', keys: 'loaded', quotas: 'loaded' }, localSession: true };
    for (const locale of ['zh-CN', 'en']) {
      const html = runInNewContext(source + '\nrenderAdminOverview(data, locale)', { data, locale });
      expect(html).toContain('overview-grid');
      expect(html).toContain(locale === 'en' ? 'Account health' : '账号健康');
    }
    expect(runInNewContext(source + '\npresentPlan(undefined, "pro").label')).toBe('ChatGPT Pro 20x');
    expect(runInNewContext(source + '\npresentPlan(undefined, "invalid plan").upstreamId')).toBeNull();
    expect(source).not.toMatch(/\b__name\b/);
  });

  it.each(['zh-CN', 'en'] as const)('localizes only the unknown quota sentinel with SSR/browser parity (%s)', (locale) => {
    const script = devScript();
    const source = script.slice(0, script.indexOf('let currentFlowId'));
    const quotas = [undefined, 'unknown', 'Plan_unknown', 'plus'].map((planType, index) => ({
      accountId: `fixture-${index}`, createdAt: '', supported: true, status: 'fresh' as const,
      quota: { planType, windows: [] },
    }));
    const html = runInNewContext(source + '\nrenderQuotaCards(quotas, [], locale)', { quotas, locale });
    expect(html).toBe(renderQuotaCards(quotas, [], locale));
    expect(html).toContain(`<strong>${locale === 'en' ? 'Plan unknown' : '套餐未知'}</strong>`);
    expect(html).toContain('<strong data-i18n-ignore>unknown</strong>');
    expect(html).toContain('<strong data-i18n-ignore>Plan_unknown</strong>');
    expect(html).toContain('<strong data-i18n-ignore>ChatGPT Plus</strong>');
    if (locale === 'zh-CN') expect(html).not.toContain('Plan unknown');
  });

  it.each(['zh-CN', 'en'])('renders mapped Pro labels prominently in browser quota cards for %s', (locale) => {
    const script = devScript();
    const source = script.slice(0, script.indexOf('let currentFlowId'));
    const quotas = ['prolite', 'pro'].map((planType) => ({
      accountId: planType, createdAt: '', supported: true, status: 'fresh',
      quota: { planType, allowed: true, limitReached: false, windows: [], additionalLimits: [] },
    }));
    const html = runInNewContext(source + '\nrenderQuotaCards(quotas, [], locale)', { quotas, locale });
    expect(html).toContain('<strong data-i18n-ignore>ChatGPT Pro 5x</strong>');
    expect(html).toContain('<strong data-i18n-ignore>ChatGPT Pro 20x</strong>');
    expect(html).not.toContain('<strong data-i18n-ignore>prolite</strong>');
    expect(html).not.toContain('<strong data-i18n-ignore>pro</strong>');
  });

  it.each(['zh-CN', 'en'])('runs the entire generated script through initial cached data loading (%s)', async (locale) => {
    const script = devScript();
    const elements = new Map<string, ReturnType<typeof element>>();
    function element() {
      return { dataset: { template: '__ORIGIN__' }, value: '', textContent: '', innerHTML: '',
        disabled: false, hidden: false, checked: false, addEventListener: vi.fn(), setAttribute: vi.fn(),
        querySelectorAll: () => [], classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() } };
    }
    const getElementById = (id: string) => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id)!;
    };
    const storageData = new Map<string, string>();
    const storage = {
      getItem: (key: string) => key === 'adminLocale' ? locale : storageData.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => storageData.set(key, value)),
      removeItem: vi.fn((key: string) => storageData.delete(key)),
    };
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ accounts: [], quotas: [], keys: [], aliases: [], discovered: [] }) }));
    const location = { origin: 'http://localhost:3000', href: 'http://localhost:3000/admin', hash: '', search: '' };
    const eventListeners = new Map<string, () => void>();
    const context = {
      document: { getElementById, querySelectorAll: () => [], documentElement: { dataset: {} },
        createTreeWalker: () => ({ nextNode: () => null }) },
      window: { location, addEventListener: vi.fn((event: string, listener: () => void) => eventListeners.set(event, listener)) }, location, history: { replaceState: vi.fn() },
      localStorage: storage, sessionStorage: storage, fetch, Headers, URL, URLSearchParams,
      NodeFilter: { SHOW_TEXT: 4 }, MutationObserver: class { observe() {} disconnect() {} },
      setTimeout, clearTimeout, console,
    };
    // The appended promise observes the actual bootstrap chain (including its final OAuth restoration).
    await runInNewContext(script.replace('verifyLocalAdminSession().then(', 'globalThis.bootstrap = verifyLocalAdminSession().then(')
      + '\nbootstrap', context);
    expect(getElementById('overview').innerHTML).toContain('overview-grid');
    expect(getElementById('overview').innerHTML).not.toContain('加载中');
    expect(getElementById('accounts').innerHTML).toContain('尚未添加');
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(5);

    const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
    Object.assign(context, { navigator: { clipboard } });
    const controls = runInNewContext('({ clientSetupConfig, showOneTimeRuntimeApiKey, clearOneTimeRuntimeApiKey, copyClientSetup, copyOneTimeRuntimeApiKey })', context);
    const placeholder = '<your-runtime-api-key>';
    const expectedEnv = {
      ANTHROPIC_BASE_URL: location.origin, ANTHROPIC_AUTH_TOKEN: placeholder,
      ANTHROPIC_MODEL: 'sonnet', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet', ANTHROPIC_DEFAULT_FABLE_MODEL: 'fable',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
    };
    expect(JSON.parse(controls.clientSetupConfig())).toEqual({ env: expectedEnv });
    // Neither restored DOM nor administrative credentials are configuration sources.
    Object.assign(getElementById('api-key').dataset, { value: 'restored-key' });
    getElementById('admin-api-key').value = 'admin-secret';
    expect(controls.clientSetupConfig()).not.toMatch(/restored-key|admin-secret/);

    // Dismissal happens while copy is queued, before clipboard receives either raw-key payload.
    expect(controls.showOneTimeRuntimeApiKey('dismissed-runtime-secret')).toBe(true);
    const queuedClientCopy = controls.copyClientSetup('claude-code');
    const queuedRawKeyCopy = controls.copyOneTimeRuntimeApiKey();
    controls.clearOneTimeRuntimeApiKey();
    await expect(Promise.all([queuedClientCopy, queuedRawKeyCopy])).resolves.toEqual([undefined, false]);
    expect(clipboard.writeText).not.toHaveBeenCalled();

    expect(controls.showOneTimeRuntimeApiKey('pagehide-runtime-secret')).toBe(true);
    const queuedPagehideClientCopy = controls.copyClientSetup('cc-switch');
    const queuedPagehideRawKeyCopy = controls.copyOneTimeRuntimeApiKey();
    eventListeners.get('pagehide')!();
    await expect(Promise.all([queuedPagehideClientCopy, queuedPagehideRawKeyCopy])).resolves.toEqual([undefined, false]);
    expect(clipboard.writeText).not.toHaveBeenCalled();

    expect(controls.showOneTimeRuntimeApiKey('runtime-only-secret')).toBe(true);
    for (const name of ['claude-code', 'cc-switch']) {
      const preview = getElementById(name + '-config');
      expect(preview.textContent).toContain(placeholder);
      expect(preview.textContent).not.toContain('runtime-only-secret');
      await controls.copyClientSetup(name);
      const copiedConfiguration = clipboard.writeText.mock.calls.at(-1)![0];
      expect(JSON.parse(copiedConfiguration)).toEqual({ env: { ...expectedEnv, ANTHROPIC_AUTH_TOKEN: 'runtime-only-secret' } });
      expect(preview.textContent).not.toContain(copiedConfiguration);
      expect(Object.values(preview.dataset)).not.toContain(copiedConfiguration);
      expect(getElementById('api-keys').innerHTML).not.toContain(copiedConfiguration);
      expect([...storageData.values()]).not.toContain(copiedConfiguration);
      expect(getElementById(name + '-copy-status').textContent).toContain(locale === 'en' ? 'Configuration copied' : '配置已复制');
    }
    controls.clearOneTimeRuntimeApiKey();
    for (const name of ['claude-code', 'cc-switch']) {
      expect(getElementById(name + '-copy-status').textContent).toBe('');
      await controls.copyClientSetup(name);
      expect(JSON.parse(clipboard.writeText.mock.calls.at(-1)![0])).toEqual({ env: expectedEnv });
    }
    expect(getElementById('runtime-api-key-once').hidden).toBe(true);
    expect(getElementById('api-key').dataset).not.toHaveProperty('value');
    clipboard.writeText.mockRejectedValueOnce(new Error('blocked'));
    await controls.copyClientSetup('claude-code');
    expect(getElementById('claude-code-copy-status').textContent).toContain(locale === 'en' ? 'Copy failed' : '复制失败');
    expect(eventListeners.get('pagehide')).toBeTypeOf('function');
    expect(controls.showOneTimeRuntimeApiKey('pagehide-runtime-secret')).toBe(true);
    eventListeners.get('pagehide')!();
    expect(getElementById('api-key').dataset).not.toHaveProperty('value');
    for (const name of ['claude-code', 'cc-switch']) {
      expect(getElementById(name + '-config').textContent).toContain(placeholder);
      await controls.copyClientSetup(name);
      expect(JSON.parse(clipboard.writeText.mock.calls.at(-1)![0])).toEqual({ env: expectedEnv });
    }
    // Re-read origin at copy time; no hard-coded host or /v1 suffix.
    location.origin = 'https://gateway.example.test:9443';
    expect(JSON.parse(controls.clientSetupConfig()).env.ANTHROPIC_BASE_URL).toBe(location.origin);
  });
});
