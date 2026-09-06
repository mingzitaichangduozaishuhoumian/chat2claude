import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Vitest's transform differs from `tsx watch`; serialize in the real dev loader.
function devScript(): string {
  return execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import { adminPageClientScript } from './src/routes/admin-page-client.ts'; process.stdout.write(adminPageClientScript());",
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 20_000 });
}

describe('Admin browser source under the tsx development loader', () => {
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
    const storage = { getItem: (key: string) => key === 'adminLocale' ? locale : null, setItem: vi.fn(), removeItem: vi.fn() };
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ accounts: [], quotas: [], keys: [], aliases: [], discovered: [] }) }));
    const location = { origin: 'http://localhost:3000', href: 'http://localhost:3000/admin', hash: '', search: '' };
    const context = {
      document: { getElementById, querySelectorAll: () => [], documentElement: { dataset: {} },
        createTreeWalker: () => ({ nextNode: () => null }) },
      window: { location, addEventListener: vi.fn() }, location, history: { replaceState: vi.fn() },
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
  });
});
