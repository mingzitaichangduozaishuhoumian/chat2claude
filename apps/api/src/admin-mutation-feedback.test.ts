import { describe, expect, it, vi } from 'vitest';
import { adminPageClientScript } from './routes/admin-page-client.js';

const script = adminPageClientScript();
const modelHandlers = script.slice(script.indexOf("document.getElementById('create-model-form')"), script.indexOf('function renderResult('));
const pendingHelper = script.slice(script.indexOf('async function withPendingButton('), script.indexOf('void loadQuotas();'));

function modelActions() {
  const listeners = new Map<string, (event?: unknown) => Promise<void>>();
  const button = { textContent: 'Save', disabled: false };
  const reset = vi.fn();
  const elements = new Map<string, Record<string, unknown>>();
  const document = { getElementById(id: string) {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'model-alias-id' ? 'existing-alias' : '', ...button, reset,
      querySelector: () => button,
      addEventListener: (_event: string, callback: (event?: unknown) => Promise<void>) => listeners.set(id, callback),
    });
    return elements.get(id)!;
  } };
  const postJson = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  const renderResult = vi.fn();
  const loadModels = vi.fn();
  const loadAccounts = vi.fn();
  new Function('document', 'postJson', 'renderResult', 'loadModels', 'loadAccounts', `${pendingHelper}\n${modelHandlers}`)(document, postJson, renderResult, loadModels, loadAccounts);
  return { listeners, document, postJson, renderResult, loadModels, loadAccounts, reset, button };
}

describe('Admin mutation feedback', () => {
  it.each(['create-model-form', 'reset-models', 'refresh-models'])('reports %s failure without rejecting the browser listener', async (id) => {
    const actions = modelActions();
    actions.postJson.mockRejectedValueOnce(new Error('Model alias already exists'));
    const target = actions.document.getElementById(id);
    const preventDefault = vi.fn();
    await expect(actions.listeners.get(id)!({ target, currentTarget: target, submitter: actions.button, preventDefault })).resolves.toBeUndefined();
    expect(actions.renderResult).toHaveBeenCalledWith({ error: 'Model alias already exists' });
    expect(actions.reset).not.toHaveBeenCalled();
    expect(actions.loadModels).not.toHaveBeenCalled();
    expect(target.disabled).toBe(false);
    expect(actions.button.disabled).toBe(false);
  });

  it('keeps a failed alias editable and allows a successful retry', async () => {
    const actions = modelActions();
    actions.postJson.mockRejectedValueOnce(new Error('Model alias already exists')).mockResolvedValueOnce({ model: { id: 'new-alias' } });
    const target = actions.document.getElementById('create-model-form');
    const submit = () => actions.listeners.get('create-model-form')!({ target, currentTarget: target, submitter: actions.button, preventDefault: vi.fn() });
    await submit();
    expect(actions.document.getElementById('model-alias-id').value).toBe('existing-alias');
    actions.document.getElementById('model-alias-id').value = 'new-alias';
    await submit();
    expect(actions.postJson).toHaveBeenLastCalledWith('/admin/api/models', { id: 'new-alias', display_name: 'new-alias', backendModel: undefined });
    expect(actions.reset).toHaveBeenCalledOnce();
    expect(actions.loadModels).toHaveBeenCalledOnce();
    expect(actions.button.disabled).toBe(false);
  });

  it('ignores another submit while alias creation is pending', async () => {
    const actions = modelActions();
    let complete!: (value: unknown) => void;
    actions.postJson.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const target = actions.document.getElementById('create-model-form');
    const submit = () => actions.listeners.get('create-model-form')!({ target, currentTarget: target, preventDefault: vi.fn() });
    const pending = submit();
    expect(actions.button.disabled).toBe(true);
    await submit();
    expect(actions.postJson).toHaveBeenCalledOnce();
    complete({ model: { id: 'existing-alias' } });
    await pending;
    expect(actions.button.disabled).toBe(false);
  });

  it.each([
    ['[data-account-toggle]', 'accountToggle'],
    ['[data-account-settings-form]', 'accountSettingsForm'],
    ['[data-account-delete]', 'accountDelete'],
    ['[data-revoke-key]', 'revokeKey'],
    ['[data-delete-model]', 'deleteModel'],
  ])('shows %s action failures and restores its button', async (selector, dataField) => {
    let listener!: (event: unknown) => Promise<void>;
    const button = { disabled: false, textContent: 'Apply' };
    const target = { ...button, dataset: { [dataField]: 'fixture', enabled: 'true' },
      elements: { label: { value: 'Fixture' }, maxConcurrency: { value: '2' } },
      querySelector: () => button,
      addEventListener: (_event: string, callback: typeof listener) => { listener = callback; },
    };
    const document = { querySelectorAll: (value: string) => value === selector ? [target] : [], getElementById: () => ({ textContent: '', innerHTML: '' }) };
    const fail = vi.fn(async () => { throw new Error('Administration unavailable'); });
    const renderResult = vi.fn();
    const reload = vi.fn();
    const accountBinding = script.slice(script.indexOf('function bindAccountActions()'), script.indexOf('function updateManualAccountOptions('));
    const modelBinding = script.slice(script.indexOf('function bindModelActions('), script.indexOf('async function saveModel('));
    const keyBinding = script.slice(script.indexOf('async function loadApiKeys()'), script.indexOf("document.getElementById('refresh-api-keys')"));
    const bind = new Function('document', 'window', 'patchJson', 'deleteJson', 'renderResult', 'loadAccounts', 'loadModels', 'loadQuotas', `
      const adminLocale = 'en'; const translateAdminText = value => value; const esc = value => value;
      let apiKeysCache; const overviewLoadState = {}; function renderOverviewPanel() {}
      async function getJson() { return { apiKeys: [{ id: 'fixture', prefix: 'key' }] }; }
      ${pendingHelper}\n${accountBinding}\n${modelBinding}\n${keyBinding}
      return async () => { bindAccountActions(); bindModelActions([], []); await loadApiKeys(); };
    `)(document, { confirm: () => true }, fail, fail, renderResult, reload, reload, reload);
    await bind();
    await expect(listener({ preventDefault: vi.fn() })).resolves.toBeUndefined();
    expect(fail).toHaveBeenCalledOnce();
    expect(renderResult).toHaveBeenCalledWith({ error: 'Administration unavailable' });
    expect(reload).not.toHaveBeenCalled();
    expect(target.disabled).toBe(false);
    expect(button.disabled).toBe(false);
  });
});
