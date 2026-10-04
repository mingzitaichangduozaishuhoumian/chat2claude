import { describe, expect, it, vi } from 'vitest';
import { adminPageClientScript } from './routes/admin-page-client.js';
import { localizeAdminMarkup } from './routes/admin-page-i18n.js';
import { adminPageViewSource } from './routes/admin-page-view.js';

const script = adminPageClientScript();
const helpers = script.slice(script.indexOf('function backendOptionsHtml('), script.indexOf("document.getElementById('create-model-form')"));
const renderContext = new Function(`${adminPageViewSource()}\n${helpers}\nreturn modelContextHtml;`)() as (model: object) => string;
const knownContext = {
  metadata_status: 'known', context_window: 272_000, max_context_window: 1_050_000,
  effective_context_window_percent: 92, auto_compact_token_limit: 244_800,
};

describe('Admin model context windows', () => {
  it('separates catalog default and maximum windows from estimated budgets in both locales', () => {
    const html = renderContext({ context: knownContext });
    const [simple, professional] = html.split('<div data-professional-only>');
    expect(simple).toContain('目录默认窗口：272,000 tokens');
    expect(simple).toContain('最大窗口：1,050,000 tokens');
    expect(simple).not.toContain('有效预算');
    expect(professional).toContain('目录有效比例：92%');
    expect(professional).toContain('默认窗口有效预算（估算）：250,240 tokens（默认窗口 × 92%）');
    expect(professional).toContain('最大窗口有效预算（估算）：966,000 tokens（最大窗口 × 92%）');
    expect(professional).toContain('目录自动压缩阈值：244,800 tokens');
    expect(professional).toContain('自动压缩是否启用由客户端决定。');
    expect(professional).toContain('不代表客户端或当前会话的实际配置');
    expect(html).not.toContain('当前窗口');
    const english = localizeAdminMarkup(html, 'en');
    expect(english).toContain('Catalog default window: 272,000 tokens');
    expect(english).toContain('Maximum window: 1,050,000 tokens');
    expect(english).toContain('Default-window effective budget (estimated): 250,240 tokens (default window × 92%)');
    expect(english).toContain('Maximum-window effective budget (estimated): 966,000 tokens (maximum window × 92%)');
    expect(english).toContain('Catalog auto-compaction threshold: 244,800 tokens');
    expect(english).not.toMatch(/\p{Script=Han}/u);
  });

  it.each([undefined, {}, { metadata_status: 'unknown' }])('shows missing catalog metadata as unknown (%j)', (context) => {
    const html = renderContext({ context });
    expect(html).toContain('目录默认窗口：未知');
    expect(html).toContain('最大窗口：未知');
    expect(html).not.toContain('tokens');
    expect(html).not.toContain('有效预算');
    const english = localizeAdminMarkup(html, 'en');
    expect(english).toContain('Catalog default window: Unknown');
    expect(english).toContain('Maximum window: Unknown');
    expect(english).not.toMatch(/\p{Script=Han}/u);
  });

  it('does not infer a default window from a maximum or invent an effective percentage', () => {
    const maxOnly = renderContext({ context: { metadata_status: 'known', max_context_window: 1_050_000 } });
    expect(maxOnly).toContain('目录默认窗口：未知');
    expect(maxOnly).toContain('最大窗口：1,050,000 tokens');
    expect(maxOnly).not.toContain('有效预算');
    expect(maxOnly).not.toContain('目录有效比例');
    const maxWithPercent = renderContext({ context: { metadata_status: 'known', max_context_window: 1_050_000, effective_context_window_percent: 90 } });
    expect(maxWithPercent).not.toContain('默认窗口有效预算');
    expect(maxWithPercent).toContain('最大窗口有效预算（估算）：945,000 tokens（最大窗口 × 90%）');
  });

  it('shows only common account values without inventing a single differing window', () => {
    const html = renderContext({ context: {
      metadata_status: 'account_dependent', max_context_window: 1_050_000, effective_context_window_percent: 90,
    } });
    expect(html).toContain('目录默认窗口：未知');
    expect(html).toContain('最大窗口：1,050,000 tokens');
    expect(html).toContain('窗口信息依账号而异');
    expect(html).toContain('仅显示各账号一致的值');
    expect(html).not.toContain('默认窗口有效预算');
    expect(html).not.toMatch(/undefined|NaN/);
    const english = localizeAdminMarkup(html, 'en');
    expect(english).toContain('Window metadata varies by account');
    expect(english).toContain('Only values shared by all accounts are shown');
    expect(english).not.toMatch(/\p{Script=Han}/u);
  });

  it.each([0, 101, -1, 95.5, '95', undefined])('does not calculate a budget from invalid or absent percentage %s', (percent) => {
    const html = renderContext({ context: { ...knownContext, effective_context_window_percent: percent } });
    expect(html).not.toContain('有效预算');
    expect(html).not.toContain('目录有效比例');
  });

  it('rejects invalid display values and floors estimates without unsafe multiplication', () => {
    const invalid = renderContext({ context: { metadata_status: 'known', context_window: '<script>alert(1)</script>', max_context_window: Infinity } });
    expect(invalid).not.toContain('<script>');
    expect(invalid).toContain('目录默认窗口：未知');
    expect(invalid).toContain('最大窗口：未知');
    const bounded = renderContext({ context: { metadata_status: 'known', context_window: Number.MAX_SAFE_INTEGER, effective_context_window_percent: 99 } });
    const expected = (BigInt(Number.MAX_SAFE_INTEGER) * 99n / 100n).toLocaleString('en-US');
    expect(bounded).toContain('默认窗口有效预算（估算）：' + expected + ' tokens');
    const tiny = renderContext({ context: { metadata_status: 'known', context_window: 1, effective_context_window_percent: 1 } });
    expect(tiny).toContain('默认窗口有效预算（估算）：0 tokens');
  });

  it('renders context beneath the target model outside professional-only cells', async () => {
    const elements = new Map<string, { innerHTML: string }>();
    const document = { getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, { innerHTML: '' });
      return elements.get(id)!;
    } };
    const load = script.slice(script.indexOf('async function loadModels()'), script.indexOf('function bindModelActions('));
    const loadModels = new Function('document', 'getJson', 'bindModelActions', `let modelsCache; const overviewLoadState = {}; function renderOverviewPanel() {}
${adminPageViewSource()}\n${helpers}\n${load}\nreturn loadModels;`)(document, async () => ({
      aliases: [{ id: 'sonnet', backendModel: 'provider', defaults: {}, context: knownContext }],
      discovered: [{ id: 'provider', context: knownContext }],
    }), vi.fn());
    await loadModels();
    const table = elements.get('models')!.innerHTML;
    const targetCell = table.match(/<td><select data-field="backendModel"[\s\S]*?<\/td>/)?.[0];
    expect(targetCell).toContain('<div data-context-for="sonnet">');
    expect(targetCell?.split('<div data-professional-only>')[0]).toContain('目录默认窗口：272,000 tokens');
    expect(targetCell?.split('<div data-professional-only>')[0]).toContain('最大窗口：1,050,000 tokens');
  });

  it('updates windows on target changes and clears them when the alias is unbound', () => {
    let change: () => void = () => {};
    const select = { dataset: { id: 'sonnet' }, value: 'new-target', addEventListener: (_event: string, listener: () => void) => { change = listener; } };
    const contextHost = { innerHTML: renderContext({ context: knownContext }) };
    const controlsHost = { innerHTML: '' };
    const document = {
      querySelectorAll: (selector: string) => selector === '[data-field="backendModel"]' ? [select] : [],
      querySelector: (selector: string) => selector.startsWith('[data-context-for=') ? contextHost : controlsHost,
    };
    const bind = script.slice(script.indexOf('function bindModelActions('), script.indexOf('async function saveModel('));
    const bindModelActions = new Function('document', 'CSS', `${adminPageViewSource()}\n${helpers}\n${bind}\nreturn bindModelActions;`)(document, { escape: (value: string) => value });
    bindModelActions([{ id: 'sonnet', defaults: {} }], [{ id: 'new-target', context: { metadata_status: 'known', context_window: 128_000 } }]);
    change();
    expect(contextHost.innerHTML).toContain('目录默认窗口：128,000 tokens');
    expect(contextHost.innerHTML).toContain('最大窗口：未知');
    expect(contextHost.innerHTML).not.toContain('1,050,000');
    select.value = '';
    change();
    expect(contextHost.innerHTML).toContain('目录默认窗口：未知');
    expect(contextHost.innerHTML).not.toContain('128,000');
    expect(contextHost.innerHTML).not.toContain('有效预算');
  });
});
