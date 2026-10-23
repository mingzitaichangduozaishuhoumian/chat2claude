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
  open: boolean;
  textContent: string;
  dataset: Record<string, string>;
  listeners: Map<string, (event: { preventDefault: () => void }) => Promise<void>>;
  addEventListener: (event: string, listener: (event: { preventDefault: () => void }) => Promise<void>) => void;
}

const configured = {
  mode: 'auto', webEnabled: true, autoPreference: 'web', configured: true,
  gateway: { baseUrl: 'http://localhost:8000/v1', models: ['auto', 'web-model'], supportsTools: false, apiKeyConfigured: true },
};

function routingUi(locale = 'zh-CN') {
  const elements = new Map<string, Element>();
  const document = { getElementById(id: string) {
    if (!elements.has(id)) {
      const listeners: Element['listeners'] = new Map();
      elements.set(id, { value: '', checked: false, disabled: false, hidden: false, open: false, textContent: '', dataset: {}, listeners,
        addEventListener: (event, listener) => { listeners.set(event, listener); } });
    }
    return elements.get(id)!;
  } };
  const getJson = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(configured);
  const patchJson = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(configured);
  const postJson = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ connection: { state: 'unchecked' } });
  const loadModels = vi.fn(async () => {});
  const loadAccounts = vi.fn(async () => {});
  const pageListeners = new Map<string, () => void>();
  const window = { addEventListener: (event: string, listener: () => void) => pageListeners.set(event, listener) };
  const storage = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() };
  const controller = new Function('document', 'window', 'getJson', 'patchJson', 'postJson', 'loadModels', 'loadAccounts',
    'translateAdminText', 'adminLocale', 'localStorage', 'sessionStorage', `${controllerSource}\nreturn { loadBackendRouting, clearBackendGatewayKey };`)(
      document, window, getJson, patchJson, postJson, loadModels, loadAccounts, translateAdminText, locale, storage, storage,
    ) as { loadBackendRouting: () => Promise<void>; clearBackendGatewayKey: () => void };
  const field = document.getElementById;
  const submit = () => field('backend-routing-form').listeners.get('submit')!({ preventDefault: vi.fn() });
  const click = (id: string) => field(id).listeners.get('click')!({ preventDefault: vi.fn() });
  const change = (id: string) => field(id).listeners.get('change')!({ preventDefault: vi.fn() });
  const input = (id: string) => field(id).listeners.get('input')!({ preventDefault: vi.fn() });
  const configure = async () => { field('backend-web-configuration').open = true; await field('backend-web-configuration').listeners.get('toggle')!({ preventDefault: vi.fn() }); };
  return { ...controller, field, submit, click, change, input, configure, getJson, patchJson, postJson, loadModels, loadAccounts, pageListeners, storage };
}

describe('Admin upstream selection', () => {
  it('keeps legacy configured gateways off and changes only the draft when the checkbox is ticked', async () => {
    const ui = routingUi('en');
    ui.getJson.mockResolvedValueOnce({ mode: 'web', configured: true, gateway: configured.gateway });
    await ui.loadBackendRouting();
    expect(ui.field('backend-web-enabled').checked).toBe(false);
    expect(ui.field('backend-routing-effective').textContent).toBe('Active policy: Codex only.');
    expect(ui.field('backend-routing-mode-fields').hidden).toBe(true);
    expect(ui.field('backend-routing-mode').disabled).toBe(true);
    expect(ui.field('backend-routing-manual-target').disabled).toBe(true);
    expect(ui.field('backend-routing-preference').disabled).toBe(true);
    expect(ui.field('backend-routing-preference').value).toBe('codex');
    expect(ui.field('backend-routing-dirty').hidden).toBe(true);
    expect(ui.field('backend-connection-status').dataset.connectionState).toBe('unchecked');
    expect(ui.postJson).not.toHaveBeenCalled();
    ui.field('backend-web-enabled').checked = true;
    await ui.change('backend-web-enabled');
    expect(ui.field('backend-routing-mode-fields').hidden).toBe(false);
    expect(ui.field('backend-routing-effective').textContent).toBe('Active policy: Codex only.');
    expect(ui.field('backend-routing-dirty').hidden).toBe(false);
    expect(ui.field('backend-routing-dirty').textContent).toContain('Unsaved changes');
    expect(ui.patchJson).not.toHaveBeenCalled();
  });

  it('keeps the saved policy visible during save and never treats an unverified saved gateway as ready', async () => {
    const ui = routingUi('en');
    ui.getJson.mockResolvedValueOnce({ ...configured, mode: 'web', webEnabled: false });
    await ui.loadBackendRouting();
    ui.field('backend-web-enabled').checked = true;
    await ui.change('backend-web-enabled');
    let complete!: (value: unknown) => void;
    ui.patchJson.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const pending = ui.submit();
    expect(ui.field('backend-routing-effective').textContent).toBe('Active policy: Codex only.');
    expect(ui.field('backend-routing-status').dataset.state).toBe('pending');
    expect(ui.field('save-backend-routing').textContent).toBe('Saving upstream settings.');
    expect(ui.field('check-backend-gateway').disabled).toBe(true);
    complete({ ...configured, mode: 'web', connection: { state: 'unchecked' } });
    await pending;
    expect(ui.field('backend-routing-effective').textContent).toBe('Active policy: ChatGPT Web only.');
    expect(ui.field('backend-routing-dirty').hidden).toBe(true);
    expect(ui.field('backend-routing-status').textContent).toContain('Saving does not verify');
    expect(ui.field('backend-connection-status').dataset.state).toBe('warning');
    expect(ui.field('backend-connection-status').textContent).toContain('Configuration is unverified');
  });

  it('prepares and checks a draft while Web is off without saving, enabling, or erasing the last request failure', async () => {
    const ui = routingUi('en');
    ui.getJson.mockResolvedValueOnce({ ...configured, mode: 'codex', webEnabled: false,
      connection: { state: 'auth_failed' }, lastRequestFailure: { state: 'auth_failed', httpStatus: 401 } });
    await ui.loadBackendRouting();
    await ui.configure();
    expect(ui.field('backend-web-settings').hidden).toBe(false);
    expect(ui.field('backend-gateway-url').disabled).toBe(false);
    expect(ui.field('backend-routing-mode').disabled).toBe(true);
    ui.field('backend-gateway-url').value = 'http://draft-gateway.test/v1';
    ui.field('backend-gateway-key').value = 'DRAFT_KEY';
    await ui.input('backend-routing-form');
    ui.postJson.mockResolvedValueOnce({ connection: { state: 'reachable', checkedAt: '2026-10-23T08:00:00Z' } });
    await ui.click('check-backend-gateway');
    expect(ui.postJson).toHaveBeenCalledWith('/admin/api/backend-routing/check', {
      mode: 'codex', webEnabled: false, autoPreference: 'web', contextHandoff: false, gateway: {
        baseUrl: 'http://draft-gateway.test/v1', models: configured.gateway.models, supportsTools: false,
        supportsImages: false, modelMappings: {}, apiKey: 'DRAFT_KEY',
      },
    });
    expect(ui.patchJson).not.toHaveBeenCalled();
    expect(ui.field('backend-web-enabled').checked).toBe(false);
    expect(ui.field('backend-routing-effective').textContent).toBe('Active policy: Codex only.');
    expect(ui.field('backend-routing-dirty').hidden).toBe(false);
    expect(ui.field('backend-gateway-key').value).toBe('DRAFT_KEY');
    expect(ui.field('backend-connection-status').textContent).toContain('Draft connection check:');
    expect(ui.field('backend-connection-status').textContent).toContain('Sending has not been tested');
    expect(ui.field('backend-last-request-failure').textContent).toContain('Last web request failed:');
    expect(ui.field('backend-last-request-failure').textContent).toContain('API Key');
    expect(ui.field('backend-last-request-failure').hidden).toBe(false);
    ui.field('backend-gateway-key').value = 'DIFFERENT_DRAFT_KEY';
    await ui.input('backend-routing-form');
    expect(ui.field('backend-connection-status').dataset.connectionState).toBe('unchecked');
    ui.patchJson.mockResolvedValueOnce({ ...configured, mode: 'codex', webEnabled: false,
      gateway: { ...configured.gateway, baseUrl: 'http://draft-gateway.test', apiKeyConfigured: true }, connection: { state: 'unchecked' } });
    await ui.submit();
    expect(ui.patchJson.mock.calls.at(-1)?.[1]).toMatchObject({ webEnabled: false, gateway: { apiKey: 'DIFFERENT_DRAFT_KEY' } });
    expect(ui.field('backend-gateway-key').value).toBe('');
    expect(ui.field('backend-web-enabled').checked).toBe(false);
    expect(ui.field('backend-routing-dirty').hidden).toBe(true);
  });

  it.each([
    ['unconfigured', 'warning', 'No web gateway configured'],
    ['unchecked', 'warning', 'Configuration is unverified'],
    ['reachable', 'success', 'Sending has not been tested'],
    ['auth_failed', 'error', 'API Key'],
    ['not_ready', 'warning', 'Sign in to ChatGPT'],
    ['unreachable', 'error', 'Start the gateway service'],
    ['timeout', 'error', 'timed out'],
    ['unsupported', 'warning', 'Sending capability is still unverified'],
    ['invalid_response', 'error', 'unrecognized response'],
    ['UNKNOWN_PRIVATE_STATE', 'error', 'unrecognized response'],
  ])('gives actionable %s connection feedback without enabling Web', async (state, tone, hint) => {
    const ui = routingUi('en');
    ui.getJson.mockResolvedValueOnce({ ...configured, webEnabled: false });
    await ui.loadBackendRouting();
    ui.postJson.mockResolvedValueOnce({ connection: { state, message: 'UNTRUSTED_RAW_MESSAGE' } });
    await ui.click('check-backend-gateway');
    expect(ui.field('backend-connection-status').dataset.state).toBe(tone);
    expect(ui.field('backend-connection-status').textContent).toContain(hint);
    expect(ui.field('backend-routing-status').hidden).toBe(true);
    expect(ui.field('backend-connection-status').textContent).not.toMatch(/UNTRUSTED_RAW_MESSAGE|UNKNOWN_PRIVATE_STATE/);
    expect(ui.patchJson).not.toHaveBeenCalled();
    expect(ui.field('backend-web-enabled').checked).toBe(false);
  });

  it('shows rate limiting separately from connectivity and ignores operational fields when checking for dirty edits', async () => {
    const ui = routingUi('en');
    ui.getJson.mockResolvedValueOnce({ ...configured, connection: { state: 'reachable' }, lastRequestFailure: { state: 'not_ready', httpStatus: 429 } });
    await ui.loadBackendRouting();
    expect(ui.field('backend-connection-status').textContent).toContain('Connection is reachable');
    expect(ui.field('backend-last-request-failure').textContent).toContain('rate limited (429)');
    expect(ui.field('backend-routing-dirty').hidden).toBe(true);
    ui.postJson.mockResolvedValueOnce({ connection: { state: 'not_ready', httpStatus: 429 } });
    await ui.click('check-backend-gateway');
    expect(ui.field('backend-connection-status').textContent).toContain('Retry later');
    expect(ui.field('backend-routing-status').hidden).toBe(true);
    expect(ui.field('backend-routing-dirty').hidden).toBe(true);
  });

  it('blocks an enabled Web save without a URL and keeps the draft visible for correction', async () => {
    const ui = routingUi('en');
    ui.getJson.mockResolvedValueOnce({ mode: 'codex', webEnabled: false, configured: false });
    await ui.loadBackendRouting();
    ui.field('backend-web-enabled').checked = true;
    await ui.change('backend-web-enabled');
    ui.field('backend-routing-mode').value = 'auto';
    await ui.change('backend-routing-mode');
    await ui.submit();
    expect(ui.patchJson).not.toHaveBeenCalled();
    expect(ui.field('backend-web-configuration').open).toBe(true);
    expect(ui.field('backend-routing-status').textContent).toContain('Enter the web gateway URL first');
    expect(ui.field('backend-routing-effective').textContent).toBe('Active policy: Codex only.');
    expect(ui.field('backend-routing-dirty').hidden).toBe(false);
  });

  it.each([401, 500])('keeps connection-check transport errors safe and visible (HTTP %s)', async (status) => {
    const ui = routingUi('en');
    await ui.loadBackendRouting();
    await ui.click('check-backend-gateway');
    expect(ui.field('backend-routing-status').hidden).toBe(true);
    ui.postJson.mockRejectedValueOnce(Object.assign(new Error('<img src=x onerror=alert(1)>PRIVATE_ERROR'), { status }));
    await ui.click('check-backend-gateway');
    expect(ui.field('backend-routing-status').dataset.state).toBe('error');
    expect(ui.field('backend-routing-status').hidden).toBe(false);
    expect(ui.field('backend-routing-status').textContent).not.toMatch(/PRIVATE_ERROR|<img/);
    expect(ui.field('backend-routing-status').textContent).toContain(status === 401 ? 'Admin authentication expired' : 'local admin service');
    expect(ui.field('check-backend-gateway').disabled).toBe(false);
  });

  it('keeps all gateway configuration in the existing Models workspace and simple mode', () => {
    const html = renderAdminPage({ apiKeysConfigured: false, defaultReasoningEffort: 'medium', defaultResponseSpeed: 'standard', backend: { provider: 'session' }, nextStep: '' });
    const panel = html.slice(html.indexOf('<section class="panel" aria-labelledby="backend-routing-title">'), html.indexOf('<section class="panel model-mapping-panel">'));
    expect(panel).not.toContain('data-professional-only');
    expect(panel).toContain('<option value="auto">');
    expect(panel).toContain('<option value="codex" selected>');
    expect(panel).toContain('id="backend-web-enabled" type="checkbox"');
    expect(panel).toContain('id="backend-context-handoff" type="checkbox"');
    expect(panel).toContain('跨后端接续上下文');
    expect(panel).toContain('不共享后端私有会话或思考过程');
    expect(panel).toContain('<option value="manual" selected>');
    expect(panel).toContain('id="backend-routing-manual-target"');
    expect(panel).toContain('id="backend-routing-web-option" value="web" disabled>');
    expect(panel).toContain('id="backend-gateway-key" type="password"');
    expect(panel).toContain('id="backend-gateway-models" value="auto"');
    expect(panel).toContain('id="backend-gateway-tools" type="checkbox" />');
    expect(panel).toContain('id="backend-gateway-images" type="checkbox" />');
    expect(panel).toContain('id="backend-routing-preference" disabled><option value="codex" selected>');
    expect(panel).toContain('id="backend-gateway-model-mappings"');
    expect(panel).toContain('更换调用入口不保证增加额度');
    expect(panel).toContain('自动模式默认 Codex 优先');
    expect(panel).not.toContain('网页优先会优先调用兼容的网页模型');
    expect(panel).toContain('x-chat2claude-backend');
    expect(panel).toContain('role="status" aria-live="polite"');
    expect(panel.indexOf('id="save-backend-routing"')).toBeLessThan(panel.indexOf('id="backend-web-configuration"'));
    expect(panel.indexOf('id="backend-routing-status"')).toBeLessThan(panel.indexOf('id="backend-gateway-url"'));
    expect(panel).toContain('id="backend-routing-effective"');
    expect(panel).toContain('id="check-backend-gateway"');
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
    expect(ui.field('backend-context-handoff').checked).toBe(false);
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
    expect(ui.field('backend-routing-manual-target').disabled).toBe(true);
    expect(ui.field('backend-routing-mode').disabled).toBe(true);
    expect(ui.field('backend-routing-mode-fields').hidden).toBe(true);
    expect(ui.field('backend-routing-effective').textContent).toContain('ChatGPT Web only');
    expect(ui.field('backend-routing-dirty').hidden).toBe(false);
    ui.patchJson.mockResolvedValueOnce({ ...configured, mode: 'web', webEnabled: false });
    await ui.submit();
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', { mode: 'web', webEnabled: false, autoPreference: 'web', contextHandoff: false });
    expect(ui.field('backend-gateway-url').value).toBe(configured.gateway.baseUrl);
    expect(ui.field('backend-gateway-key').value).toBe('draft-key');
    expect(ui.field('backend-gateway-model-mappings').value).toBe('sonnet=auto');
    expect(ui.field('backend-routing-manual-target').value).toBe('web');
    expect(ui.field('backend-gateway-key').disabled).toBe(true);
    expect(ui.field('backend-web-enabled').disabled).toBe(false);
    expect(ui.field('backend-routing-effective').textContent).toContain('Codex only');
    ui.field('backend-web-enabled').checked = true;
    await ui.change('backend-web-enabled');
    await ui.configure();
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
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', { mode: 'web', webEnabled: false, autoPreference: 'web', contextHandoff: false });
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
      mode: 'auto', webEnabled: true, autoPreference: 'web', contextHandoff: false, gateway: { baseUrl: configured.gateway.baseUrl, models: ['auto', 'my-model', 'gpt-5.4'], supportsTools: true, supportsImages: false, modelMappings: {} },
    });
    ui.field('backend-gateway-key').value = 'new-gateway-key';
    await ui.submit();
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', {
      mode: 'auto', webEnabled: true, autoPreference: 'web', contextHandoff: false, gateway: { baseUrl: configured.gateway.baseUrl, models: configured.gateway.models, supportsTools: false, supportsImages: false, modelMappings: {}, apiKey: 'new-gateway-key' },
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
      mode: 'auto', webEnabled: true, autoPreference: 'codex', contextHandoff: false, gateway: { baseUrl: configured.gateway.baseUrl, models: configured.gateway.models,
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

  it('reads and saves context handoff independently of the disabled web gateway', async () => {
    const ui = routingUi('en');
    ui.getJson.mockResolvedValueOnce({ ...configured, webEnabled: false, contextHandoff: true });
    await ui.loadBackendRouting();
    expect(ui.field('backend-context-handoff').checked).toBe(true);
    expect(ui.field('backend-context-handoff').disabled).toBe(false);
    expect(ui.field('backend-web-settings').hidden).toBe(true);
    ui.field('backend-context-handoff').checked = false;
    ui.patchJson.mockResolvedValueOnce({ ...configured, webEnabled: false, contextHandoff: false });
    await ui.submit();
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', {
      mode: 'auto', webEnabled: false, autoPreference: 'web', contextHandoff: false,
    });
    expect(ui.field('backend-context-handoff').checked).toBe(false);
    expect(ui.field('backend-context-handoff').disabled).toBe(false);
    ui.field('backend-context-handoff').checked = true;
    ui.patchJson.mockResolvedValueOnce({ ...configured, webEnabled: false, contextHandoff: true });
    await ui.submit();
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', {
      mode: 'auto', webEnabled: false, autoPreference: 'web', contextHandoff: true,
    });
    ui.patchJson.mockResolvedValueOnce({ mode: 'codex', configured: false, contextHandoff: true });
    await ui.click('clear-backend-gateway');
    expect(ui.field('backend-context-handoff').checked).toBe(true);
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
    ui.field('backend-context-handoff').checked = true;
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
    expect(ui.field('backend-context-handoff').disabled).toBe(true);
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
    expect(ui.field('backend-context-handoff').checked).toBe(true);
    expect(ui.field('backend-routing-preference').value).toBe('codex');
    expect(ui.field('backend-gateway-images').checked).toBe(true);
    expect(ui.field('backend-gateway-model-mappings').value).toBe('sonnet=custom-model');
    expect(ui.field('backend-routing-status').textContent).toContain('Your input is preserved.');
    expect(ui.field('backend-routing-status').textContent).not.toContain('Persistence unavailable');
    expect(ui.field('save-backend-routing').disabled).toBe(false);
    expect(ui.field('refresh-backend-routing').disabled).toBe(false);
    expect(ui.field('backend-context-handoff').disabled).toBe(false);
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
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', { mode: 'auto', webEnabled: false, autoPreference: 'codex', contextHandoff: false });
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
    expect(ui.patchJson).toHaveBeenLastCalledWith('/admin/api/backend-routing', { mode: 'codex', webEnabled: false, gateway: null });
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
      'backend-routing-web-option', 'backend-web-settings', 'backend-web-status', 'backend-context-handoff',
      'backend-routing-mode-fields', 'backend-web-configuration', 'backend-routing-effective', 'backend-routing-dirty',
      'backend-connection-status', 'backend-last-request-failure', 'check-backend-gateway']);
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
