import { describe, expect, it, vi } from 'vitest';
import { adminPageClientScript } from './routes/admin-page-client.js';
import { renderAdminPage } from './routes/admin-page.js';
import { ADMIN_MESSAGES, localizeAdminMarkup, translateAdminText } from './routes/admin-page-i18n.js';
import { renderAccountCards, type AdminAccountView } from './routes/admin-page-view.js';

const script = adminPageClientScript();
const controllerSource = script.slice(script.indexOf('function backendRoutingElements()'), script.indexOf('async function getJson('));

interface Element {
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  dataset: Record<string, string>;
  listeners: Map<string, (event: { preventDefault: () => void }) => Promise<void>>;
  addEventListener: (event: string, listener: (event: { preventDefault: () => void }) => Promise<void>) => void;
}

const configured = {
  mode: 'auto', configured: true,
  gateway: { baseUrl: 'http://localhost:8000/v1', models: ['auto', 'web-model'], supportsTools: false, apiKeyConfigured: true },
};

function routingUi(locale = 'zh-CN') {
  const elements = new Map<string, Element>();
  const document = { getElementById(id: string) {
    if (!elements.has(id)) {
      const listeners: Element['listeners'] = new Map();
      elements.set(id, { value: '', checked: false, disabled: false, hidden: false, textContent: '', dataset: {}, listeners,
        addEventListener: (event, listener) => { listeners.set(event, listener); } });
    }
    return elements.get(id)!;
  } };
  const getJson = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(configured);
  const patchJson = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(configured);
  const loadModels = vi.fn(async () => {});
  const loadAccounts = vi.fn(async () => {});
  const pageListeners = new Map<string, () => void>();
  const window = { addEventListener: (event: string, listener: () => void) => pageListeners.set(event, listener) };
  const storage = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() };
  const controller = new Function('document', 'window', 'getJson', 'patchJson', 'loadModels', 'loadAccounts',
    'translateAdminText', 'adminLocale', 'localStorage', 'sessionStorage', `${controllerSource}\nreturn { loadBackendRouting, clearBackendGatewayKey };`)(
      document, window, getJson, patchJson, loadModels, loadAccounts, translateAdminText, locale, storage, storage,
    ) as { loadBackendRouting: () => Promise<void>; clearBackendGatewayKey: () => void };
  const field = document.getElementById;
  const submit = () => field('backend-routing-form').listeners.get('submit')!({ preventDefault: vi.fn() });
  const click = (id: string) => field(id).listeners.get('click')!({ preventDefault: vi.fn() });
  const change = (id: string) => field(id).listeners.get('change')!({ preventDefault: vi.fn() });
  return { ...controller, field, submit, click, change, getJson, patchJson, loadModels, loadAccounts, pageListeners, storage };
}

describe('Admin upstream selection', () => {
  it('keeps all gateway configuration in the existing Models workspace and simple mode', () => {
    const html = renderAdminPage({ apiKeysConfigured: false, defaultReasoningEffort: 'medium', defaultResponseSpeed: 'standard', backend: { provider: 'session' }, nextStep: '' });
    const panel = html.slice(html.indexOf('<section class="panel" aria-labelledby="backend-routing-title">'), html.indexOf('<section class="panel model-mapping-panel">'));
    expect(panel).not.toContain('data-professional-only');
    expect(panel).toContain('<option value="auto">');
    expect(panel).toContain('<option value="codex" selected>');
    expect(panel).toContain('id="backend-web-enabled" type="checkbox"');
    expect(panel).toContain('<option value="manual" selected>');
    expect(panel).toContain('id="backend-routing-manual-target"');
    expect(panel).toContain('id="backend-routing-web-option" value="web" disabled>');
    expect(panel).toContain('id="backend-gateway-key" type="password"');
    expect(panel).toContain('id="backend-gateway-models" value="auto"');
    expect(panel).toContain('id="backend-gateway-tools" type="checkbox" />');
    expect(panel).toContain('id="backend-gateway-images" type="checkbox" />');
    expect(panel).toContain('id="backend-routing-preference" disabled><option value="web" selected>');
    expect(panel).toContain('id="backend-gateway-model-mappings"');
    expect(panel).toContain('更换调用入口不保证增加额度');
    expect(panel).toContain('x-chat2claude-backend');
    expect(panel).toContain('role="status" aria-live="polite"');
    expect(html.indexOf('id="models-module"')).toBeLessThan(html.indexOf('id="backend-routing-title"'));
    expect([...html.slice(0, html.indexOf('<script>')).matchAll(/data-admin-module="/g)]).toHaveLength(6);
    expect(localizeAdminMarkup(panel, 'en')).not.toMatch(/\p{Script=Han}/u);
  });

  it('reads only safe gateway configuration and never restores a key or writes browser storage', async () => {
    const ui = routingUi();
    ui.field('backend-gateway-key').value = 'unsaved-key';
    ui.getJson.mockResolvedValueOnce({ ...configured, gateway: { ...configured.gateway, apiKey: 'must-not-render' } });
    await ui.loadBackendRouting();
    expect(ui.getJson).toHaveBeenCalledWith('/admin/api/backend-routing');
    expect(ui.field('backend-routing-mode').value).toBe('auto');
    expect(ui.field('backend-web-enabled').checked).toBe(true);
    expect(ui.field('backend-gateway-models').value).toBe('auto, web-model');
    expect(ui.field('backend-gateway-tools').checked).toBe(false);
    expect(ui.field('backend-routing-preference').value).toBe('web');
    expect(ui.field('backend-gateway-images').checked).toBe(false);
    expect(ui.field('backend-gateway-model-mappings').value).toBe('');
    expect(ui.field('backend-gateway-key').value).toBe('unsaved-key');
    expect(ui.field('backend-gateway-config-status').textContent).toContain('API Key 已设置');
    expect(ui.storage.setItem).not.toHaveBeenCalled();
    expect(ui.storage.getItem).not.toHaveBeenCalled();
    expect(ui.field('backend-routing-status').dataset.state).toBe('success');
    ui.clearBackendGatewayKey();
    expect(ui.field('backend-gateway-key').value).toBe('');
  });

  it.each(['codex', 'web'])('loads manual %s mode and saves it through the existing API mode', async (target) => {
    const ui = routingUi();
    const manual = { ...configured, mode: target, webEnabled: true };
    ui.getJson.mockResolvedValueOnce(manual);
    ui.patchJson.mockResolvedValueOnce(manual);
    await ui.loadBackendRouting();
    expect(ui.field('backend-routing-mode').value).toBe('manual');
    expect(ui.field('backend-routing-manual-target').value).toBe(target);
    expect(ui.field('backend-routing-manual-field').hidden).toBe(false);
    expect(ui.field('backend-routing-preference-field').hidden).toBe(true);
    await ui.submit();
    expect(ui.patchJson.mock.calls.at(-1)?.[1]).toMatchObject({ mode: target, webEnabled: true });
    ui.field('backend-routing-mode').value = 'auto';
    await ui.change('backend-routing-mode');
    expect(ui.field('backend-routing-manual-field').hidden).toBe(true);
    expect(ui.field('backend-routing-preference-field').hidden).toBe(false);
    expect(ui.field('backend-routing-preference').disabled).toBe(false);
    expect(ui.field('backend-routing-manual-target').value).toBe(target);
  });

  it('turns Web off without changing the saved gateway or losing draft configuration and restores controls on re-enable', async () => {
    const ui = routingUi('en');
    ui.getJson.mockResolvedValueOnce({ ...configured, mode: 'web', webEnabled: true });
    await ui.loadBackendRouting();
    ui.field('backend-gateway-key').value = 'draft-key';
    ui.field('backend-gateway-model-mappings').value = 'sonnet=auto';
    ui.field('backend-web-enabled').checked = false;
    await ui.change('backend-web-enabled');
    expect(ui.field('backend-web-settings').hidden).toBe(true);
    expect(ui.field('backend-routing-web-option').disabled).toBe(true);
    expect(ui.field('backend-gateway-url').disabled).toBe(true);
    expect(ui.field('backend-routing-manual-target').disabled).toBe(false);
    expect(ui.field('backend-web-status').textContent).toContain('Only Codex is used');
    ui.patchJson.mockResolvedValueOnce({ ...configured, mode: 'web', webEnabled: false });
    await ui.submit();
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', { mode: 'web', webEnabled: false, autoPreference: 'web' });
    expect(ui.field('backend-gateway-url').value).toBe(configured.gateway.baseUrl);
    expect(ui.field('backend-gateway-key').value).toBe('draft-key');
    expect(ui.field('backend-gateway-model-mappings').value).toBe('sonnet=auto');
    expect(ui.field('backend-routing-manual-target').value).toBe('web');
    expect(ui.field('backend-gateway-key').disabled).toBe(true);
    expect(ui.field('backend-web-enabled').disabled).toBe(false);
    ui.field('backend-web-enabled').checked = true;
    await ui.change('backend-web-enabled');
    expect(ui.field('backend-web-settings').hidden).toBe(false);
    expect(ui.field('backend-routing-web-option').disabled).toBe(false);
    expect(ui.field('backend-gateway-key').disabled).toBe(false);
    ui.patchJson.mockResolvedValueOnce({ ...configured, mode: 'web', webEnabled: true });
    await ui.submit();
    expect(ui.patchJson.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'web', webEnabled: true,
      gateway: { baseUrl: configured.gateway.baseUrl, apiKey: 'draft-key', modelMappings: { sonnet: 'auto' } } });
    expect(ui.field('backend-gateway-key').value).toBe('');
  });

  it('saves a disabled manual Web selection without validating hidden gateway drafts and preserves it after errors', async () => {
    const ui = routingUi();
    ui.getJson.mockResolvedValueOnce({ ...configured, mode: 'web', webEnabled: false });
    await ui.loadBackendRouting();
    ui.field('backend-gateway-url').value = '';
    ui.field('backend-gateway-key').value = 'draft-key';
    ui.field('backend-gateway-model-mappings').value = 'invalid draft';
    ui.patchJson.mockRejectedValueOnce(new Error('Persistence unavailable'));
    await ui.submit();
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', { mode: 'web', webEnabled: false, autoPreference: 'web' });
    expect(ui.field('backend-routing-status').dataset.state).toBe('error');
    expect(ui.field('backend-routing-manual-target').value).toBe('web');
    expect(ui.field('backend-gateway-key').value).toBe('draft-key');
    expect(ui.field('backend-gateway-model-mappings').value).toBe('invalid draft');
    expect(ui.field('backend-gateway-key').disabled).toBe(true);
    expect(ui.field('backend-routing-web-option').disabled).toBe(true);
    expect(ui.field('backend-web-enabled').disabled).toBe(false);
  });

  it('omits a blank password, sends model IDs unchanged, and clears a newly saved password', async () => {
    const ui = routingUi();
    await ui.loadBackendRouting();
    ui.field('backend-gateway-models').value = ' auto, my-model, gpt-5.4 ';
    ui.field('backend-gateway-tools').checked = true;
    await ui.submit();
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', {
      mode: 'auto', webEnabled: true, autoPreference: 'web', gateway: { baseUrl: configured.gateway.baseUrl, models: ['auto', 'my-model', 'gpt-5.4'], supportsTools: true, supportsImages: false, modelMappings: {} },
    });
    ui.field('backend-gateway-key').value = 'new-gateway-key';
    await ui.submit();
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', {
      mode: 'auto', webEnabled: true, autoPreference: 'web', gateway: { baseUrl: configured.gateway.baseUrl, models: configured.gateway.models, supportsTools: false, supportsImages: false, modelMappings: {}, apiKey: 'new-gateway-key' },
    });
    expect(ui.field('backend-gateway-key').value).toBe('');
    expect(ui.loadModels).toHaveBeenCalledTimes(2);
    expect(ui.loadAccounts).toHaveBeenCalledTimes(2);
  });

  it('reads and saves explicit mappings, image support, and the selected auto preference', async () => {
    const ui = routingUi();
    ui.getJson.mockResolvedValueOnce({ ...configured, autoPreference: 'codex', gateway: {
      ...configured.gateway, supportsImages: true, modelMappings: { sonnet: 'auto', 'gpt-5.4': 'web-model' },
    } });
    await ui.loadBackendRouting();
    expect(ui.field('backend-routing-preference').value).toBe('codex');
    expect(ui.field('backend-gateway-images').checked).toBe(true);
    expect(ui.field('backend-gateway-model-mappings').value).toBe('sonnet=auto\ngpt-5.4=web-model');
    ui.field('backend-gateway-model-mappings').value = ' sonnet = auto \r\n\n opus=web-model ';
    await ui.submit();
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', {
      mode: 'auto', webEnabled: true, autoPreference: 'codex', gateway: { baseUrl: configured.gateway.baseUrl, models: configured.gateway.models,
        supportsTools: false, supportsImages: true, modelMappings: { sonnet: 'auto', opus: 'web-model' } },
    });
    ui.field('backend-gateway-model-mappings').value = '';
    await ui.submit();
    expect(ui.patchJson.mock.calls.at(-1)?.[1]).toMatchObject({ gateway: { modelMappings: {} } });
  });

  it.each([
    ['sonnet', 'Invalid web model mapping'], ['=auto', 'Invalid web model mapping'],
    ['sonnet=', 'Invalid web model mapping'], ['sonnet=auto=other', 'Invalid web model mapping'],
    ['son net=auto', 'Invalid web model mapping'], ['sonnet=web model', 'Invalid web model mapping'],
    ['sonnet=auto\nsonnet=web-model', 'Duplicate client model or alias'],
  ])('rejects malformed or duplicate mappings without changing the draft: %s', async (mapping, message) => {
    const ui = routingUi('en');
    await ui.loadBackendRouting();
    ui.field('backend-gateway-model-mappings').value = mapping;
    ui.field('backend-gateway-key').value = 'draft-key';
    await ui.submit();
    expect(ui.patchJson).not.toHaveBeenCalled();
    expect(ui.field('backend-routing-status').textContent).toContain(message);
    expect(ui.field('backend-gateway-model-mappings').value).toBe(mapping);
    expect(ui.field('backend-gateway-key').value).toBe('draft-key');
  });

  it('preserves every draft field on save failure and prevents concurrent refresh or submit', async () => {
    const ui = routingUi('en');
    await ui.loadBackendRouting();
    ui.field('backend-routing-mode').value = 'manual';
    ui.field('backend-routing-manual-target').value = 'web';
    ui.field('backend-gateway-url').value = 'http://example.test/v1';
    ui.field('backend-gateway-key').value = 'retry-key';
    ui.field('backend-gateway-models').value = 'custom-model';
    ui.field('backend-gateway-tools').checked = true;
    ui.field('backend-routing-preference').value = 'codex';
    ui.field('backend-gateway-images').checked = true;
    ui.field('backend-gateway-model-mappings').value = 'sonnet=custom-model';
    let reject!: (error: Error) => void;
    ui.patchJson.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const pending = ui.submit();
    expect(ui.field('backend-routing-status').dataset.state).toBe('pending');
    expect(ui.field('save-backend-routing').disabled).toBe(true);
    expect(ui.field('refresh-backend-routing').disabled).toBe(true);
    expect(ui.field('backend-routing-preference').disabled).toBe(true);
    expect(ui.field('backend-gateway-images').disabled).toBe(true);
    expect(ui.field('backend-gateway-model-mappings').disabled).toBe(true);
    await ui.submit();
    await ui.click('refresh-backend-routing');
    expect(ui.patchJson).toHaveBeenCalledOnce();
    expect(ui.getJson).toHaveBeenCalledOnce();
    reject(new Error('Persistence unavailable'));
    await pending;
    expect(ui.field('backend-routing-mode').value).toBe('manual');
    expect(ui.field('backend-routing-manual-target').value).toBe('web');
    expect(ui.field('backend-gateway-url').value).toBe('http://example.test/v1');
    expect(ui.field('backend-gateway-key').value).toBe('retry-key');
    expect(ui.field('backend-gateway-models').value).toBe('custom-model');
    expect(ui.field('backend-gateway-tools').checked).toBe(true);
    expect(ui.field('backend-routing-preference').value).toBe('codex');
    expect(ui.field('backend-gateway-images').checked).toBe(true);
    expect(ui.field('backend-gateway-model-mappings').value).toBe('sonnet=custom-model');
    expect(ui.field('backend-routing-status').textContent).toContain('Your input is preserved.');
    expect(ui.field('backend-routing-status').textContent).toContain('Persistence unavailable');
    expect(ui.field('save-backend-routing').disabled).toBe(false);
    expect(ui.field('refresh-backend-routing').disabled).toBe(false);
    expect(ui.loadModels).not.toHaveBeenCalled();
  });

  it('keeps draft input when refresh fails and permits mode-only changes without a gateway', async () => {
    const ui = routingUi();
    ui.field('backend-gateway-models').value = 'auto';
    ui.field('backend-gateway-key').value = 'draft-key';
    ui.getJson.mockRejectedValueOnce(new Error('Read failed'));
    await ui.loadBackendRouting();
    expect(ui.field('backend-gateway-key').value).toBe('draft-key');
    expect(ui.field('backend-routing-status').dataset.state).toBe('error');
    ui.field('backend-gateway-key').value = '';
    ui.field('backend-routing-mode').value = 'auto';
    ui.patchJson.mockResolvedValueOnce({ mode: 'auto', configured: false });
    await ui.submit();
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', { mode: 'auto', webEnabled: false, autoPreference: 'web' });
    expect(ui.field('backend-gateway-models').value).toBe('auto');
    expect(ui.field('backend-gateway-tools').checked).toBe(false);
  });

  it('requires a URL for Web mode and clears configuration explicitly into Codex mode', async () => {
    const ui = routingUi();
    ui.field('backend-web-enabled').checked = true;
    ui.field('backend-routing-mode').value = 'manual';
    ui.field('backend-routing-manual-target').value = 'web';
    await ui.submit();
    expect(ui.patchJson).not.toHaveBeenCalled();
    expect(ui.field('backend-routing-status').textContent).toContain('请先填写网页网关地址');
    await ui.loadBackendRouting();
    ui.field('backend-gateway-key').value = 'draft';
    ui.patchJson.mockResolvedValueOnce({ mode: 'codex', configured: false });
    await ui.click('clear-backend-gateway');
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', { mode: 'codex', gateway: null });
    expect(ui.field('backend-routing-mode').value).toBe('manual');
    expect(ui.field('backend-routing-manual-target').value).toBe('codex');
    expect(ui.field('backend-web-enabled').checked).toBe(false);
    expect(ui.field('backend-gateway-url').value).toBe('');
    expect(ui.field('backend-gateway-key').value).toBe('');
    expect(ui.field('backend-routing-status').textContent).toContain('已切换到 Codex');
  });

  it('tolerates an older page fixture without upstream elements', async () => {
    const bind = new Function('document', `${controllerSource}\nreturn loadBackendRouting;`);
    await expect(bind({ getElementById: () => null })()).resolves.toBeUndefined();
  });

  it('keeps existing controls functional when only the new optional elements are absent', async () => {
    const optional = new Set(['backend-routing-preference', 'backend-gateway-images', 'backend-gateway-model-mappings',
      'backend-web-enabled', 'backend-routing-manual-target', 'backend-routing-manual-field', 'backend-routing-preference-field',
      'backend-routing-web-option', 'backend-web-settings', 'backend-web-status']);
    const ui = routingUi();
    const document = { getElementById: (id: string) => optional.has(id) ? null : ui.field(id) };
    const load = new Function('document', 'window', 'getJson', 'patchJson', 'loadModels', 'loadAccounts', 'translateAdminText', 'adminLocale',
      `${controllerSource}\nreturn loadBackendRouting;`)(document, { addEventListener: vi.fn() }, ui.getJson, ui.patchJson,
      ui.loadModels, ui.loadAccounts, translateAdminText, 'en') as () => Promise<void>;
    await load();
    await ui.submit();
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', {
      mode: 'auto', gateway: { baseUrl: configured.gateway.baseUrl, models: configured.gateway.models, supportsTools: false },
    });
  });

  it('labels a web gateway account correctly and manages its settings in the upstream panel', () => {
    const account = { id: 'web-gateway', label: 'Web gateway', provider: 'chatgpt-web', status: 'available', enabled: true,
      currentConcurrency: 0, maxConcurrency: 1, lastUsedAt: null, cooldownUntil: null,
      requestStats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0, cancelledRequests: 0, inputTokens: 0, outputTokens: 0, lastRequestAt: null, inFlight: 0 },
      modelCount: 1, discoveredModels: [{ id: 'auto' }],
    } as AdminAccountView;
    const html = renderAccountCards([account], 'en');
    expect(html).toContain('ChatGPT Web Gateway');
    expect(html).not.toContain('Mock Account');
    expect(html).not.toContain('data-account-settings');
    expect(html).not.toContain('data-account-delete');
    expect(html).not.toContain('data-account-health');
    expect(html).toContain('data-account-toggle');
    expect(html).toContain('Manage the web gateway in Upstream selection.');
    for (const key of ['上游选择', '上游设置已保存。', '上游设置保存失败。输入已保留。', '网页网关已配置；API Key 已设置。',
      '使用 ChatGPT 网页', '自动模式', '手动模式', '手动选择上游', '网页已关闭，仅使用 Codex；配置和选择会保留，重新开启后恢复。']) {
      expect(ADMIN_MESSAGES[key]).toBeTruthy();
      expect(translateAdminText(key, 'en')).not.toMatch(/\p{Script=Han}/u);
    }
  });
});
