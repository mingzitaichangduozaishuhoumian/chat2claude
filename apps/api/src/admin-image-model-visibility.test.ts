import { describe, expect, it, vi } from 'vitest';
import { adminPageClientScript } from './routes/admin-page-client.js';
import { renderAdminPage } from './routes/admin-page.js';
import { adminPageViewSource, renderAccountCards, renderImageModels, type AdminAccountView } from './routes/admin-page-view.js';
import type { PublicImageModel } from './routes/models.js';
import { localizeAdminMarkup } from './routes/admin-page-i18n.js';

const image: PublicImageModel = { id: 'gpt-image-2', type: 'model', display_name: 'GPT Image 2', source: 'image_endpoint', endpoint: '/v1/images/generations', capabilities: { image_generation: true }, availability: 'backend_dependent' };
const script = adminPageClientScript();
const helpers = script.slice(script.indexOf('function backendOptionsHtml('), script.indexOf("document.getElementById('create-model-form')"));
const load = script.slice(script.indexOf('async function loadModels()'), script.indexOf('function bindModelActions('));
const pending = script.slice(script.indexOf('async function withPendingButton('), script.indexOf('void loadQuotas();'));
const accountBindings = script.slice(script.indexOf('function bindAccountActions()'), script.indexOf('function updateManualAccountOptions('));

function account(imageModels?: PublicImageModel[]): AdminAccountView {
  return { id: 'synthetic-account', label: 'Synthetic account', provider: 'chatgpt-session', status: 'available', enabled: true,
    maxConcurrency: 1, currentConcurrency: 0, lastUsedAt: null, lastError: null, lastErrorCode: null, cooldownUntil: null,
    capabilities: ['messages'], createdAt: '2026-10-04T00:00:00Z', hasSecret: true, modelCount: 10,
    discoveredModels: Array.from({ length: 10 }, (_, index) => ({ id: `text-model-${index}` })), imageModels,
    discovery: { status: 'success', attemptedAt: '2026-10-04T00:00:00Z', succeededAt: '2026-10-04T00:00:00Z', stale: false },
    requestStats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0, cancelledRequests: 0, inputTokens: 0, outputTokens: 0, lastRequestAt: null, inFlight: 0 },
  };
}

function modelsHarness(action?: 'toggle' | 'health', fail = false) {
  let callback!: () => Promise<void>;
  const button = { disabled: false, textContent: 'Action', dataset: { accountToggle: 'synthetic-account', accountHealth: 'synthetic-account', enabled: 'true' },
    addEventListener: (_event: string, listener: typeof callback) => { callback = listener; },
  };
  let payload: Record<string, unknown> = {
    aliases: [{ id: 'sonnet', backendModel: 'text-model-0', defaults: {}, status: 'bound', enabled: true }],
    discovered: account().discoveredModels,
    imageModels: [image],
  };
  const elements = new Map<string, { innerHTML: string }>();
  const document = {
    getElementById: (id: string) => { if (!elements.has(id)) elements.set(id, { innerHTML: '' }); return elements.get(id)!; },
    querySelectorAll: (selector: string) => selector === `[data-account-${action}]` ? [button] : [],
  };
  const loadModels = new Function('document', 'getJson', 'bindModelActions', `let modelsCache; const overviewLoadState = {}; function renderOverviewPanel() {}
${adminPageViewSource()}\n${helpers}\n${load}\nreturn loadModels;`)(document, async () => payload, vi.fn());
  const loadAccounts = vi.fn(async () => {});
  const renderResult = vi.fn();
  const mutate = vi.fn(async () => { payload = { ...payload, imageModels: [] }; if (fail) throw new Error('Refresh failed'); return {}; });
  new Function('document', 'patchJson', 'postJson', 'renderResult', 'loadAccounts', 'loadModels', `${pending}\n${accountBindings}\nbindAccountActions();`)(document, mutate, mutate, renderResult, loadAccounts, loadModels);
  return { loadModels, loadAccounts, elements, mutate, renderResult, button, click: () => callback(), setPayload: (value: Record<string, unknown>) => { payload = value; } };
}

describe('Visible independent image models in Admin', () => {
  it.each(['zh-CN', 'en'] as const)('shows separate text/image counts and image routing outside professional details (%s)', (locale) => {
    const fixture = account([image]);
    const html = renderAccountCards([fixture], locale);
    const simple = html.split('<details class="professional-detail"')[0];
    expect(simple).toContain('<span data-admin-number="10">10</span>');
    expect(simple).toContain('<span data-admin-number="1">1</span>');
    expect(simple).toContain(locale === 'en' ? 'Text models' : '文本模型');
    expect(simple).toContain(locale === 'en' ? 'Image models' : '图片模型');
    expect(simple).toContain('<code title="GPT Image 2">gpt-image-2</code>');
    expect(simple).toContain('POST /v1/images/generations');
    expect(simple).toContain(locale === 'en' ? 'Image models come from a built-in catalog, separate from upstream-discovered text models' : '图片型号来自内置目录，独立于上游发现的文本模型');
    expect(simple).toContain(locale === 'en' ? 'availability depends on account permissions, quota, and upstream support' : '是否可调用取决于账号权限、额度和上游支持');
    expect(html).toContain(locale === 'en' ? 'Context window details' : '上下文窗口详情');
    expect(html).toContain('<details class="model-disclosure" data-model-group="text">');
    expect(html).toContain('<details class="model-disclosure" data-model-group="image">');
    expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|>)/);
    expect(fixture.modelCount).toBe(10);
    expect(fixture.discoveredModels).toHaveLength(10);
    const browser = new Function(`${adminPageViewSource()}\nreturn renderAccountCards;`)();
    expect(browser([fixture], locale)).toBe(html);
  });

  it.each([undefined, []])('treats missing legacy image fields as an empty list (%j)', (models) => {
    const html = renderAccountCards([account(models)]);
    expect(html).toContain('<span data-admin-number="0">0</span>');
    expect(html).toContain('当前没有可用的图片模型');
    expect(html).not.toContain('gpt-image-2');
    expect(renderImageModels(models, 'en')).toContain('No image models are currently available');
  });

  it('counts and lists multiple supplied image models without assuming a fixed catalog', async () => {
    const second = { ...image, id: 'synthetic-image-alt', display_name: 'Synthetic Image Alternative' };
    const html = renderAccountCards([account([image, second])], 'en');
    const simple = html.split('<details class="professional-detail"')[0];
    expect(simple).toContain('<span data-admin-number="10">10</span>');
    expect(simple).toContain('<span data-admin-number="2">2</span>');
    expect(simple).toContain('>gpt-image-2</code>');
    expect(simple).toContain('>synthetic-image-alt</code>');
    expect(simple.match(/POST \/v1\/images\/generations/g)).toHaveLength(1);
    const f = modelsHarness();
    f.setPayload({ aliases: [], discovered: account().discoveredModels, imageModels: [image, second] });
    await f.loadModels();
    expect(f.elements.get('image-models')!.innerHTML).toContain('Synthetic Image Alternative');
    expect(f.elements.get('image-models')!.innerHTML).toContain('gpt-image-2');
    expect(f.elements.get('model-backend')!.innerHTML).not.toMatch(/gpt-image-2|synthetic-image-alt/);
  });

  it('escapes descriptor fields and does not turn the endpoint into an executable link', () => {
    const malicious = { ...image, id: '"><script>MODEL_CANARY</script>', display_name: '<img src=x onerror=NAME_CANARY>', endpoint: 'javascript:ENDPOINT_CANARY<svg>' } as unknown as PublicImageModel;
    const html = renderImageModels([malicious], 'en');
    expect(html).toContain('&lt;script&gt;MODEL_CANARY&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=NAME_CANARY&gt;');
    expect(html).toContain('POST javascript:ENDPOINT_CANARY&lt;svg&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('href=');
  });

  it('excludes image targets from text choices and explains legacy bindings without hiding vision-capable chat models', async () => {
    const f = modelsHarness();
    f.setPayload({
      aliases: [{ id: 'sonnet', backendModel: image.id, defaults: {}, enabled: true, context: { metadata_status: 'known', context_window: 1_000_000 } }],
      discovered: [{ id: image.id }, { id: 'future-image', source: 'image_endpoint' }, { id: 'vision-chat', capabilities: { input_image: true } }],
      imageModels: [],
    });
    await f.loadModels();
    const choices = f.elements.get('model-backend')!.innerHTML;
    expect(choices).toContain('vision-chat');
    expect(choices).not.toMatch(/gpt-image-2|future-image/);
    const mappings = f.elements.get('models')!.innerHTML;
    expect(mappings).toMatch(/<option value="gpt-image-2" disabled selected>/);
    expect(mappings).toContain('图片模型无法通过文本 alias 调用');
    expect(mappings).toContain('/v1/images/generations');
    expect(mappings).not.toMatch(/data-field="reasoning_effort"|data-field="speed"|1,000,000/);
    const english = localizeAdminMarkup(mappings, 'en');
    expect(english).toContain('gpt-image-2 (image model; use the Images API)');
    expect(english).toContain('Image models cannot be called through text aliases.');
  });

  it('places a collapsed image group in the models page in both modes', () => {
    const html = renderAdminPage({ apiKeysConfigured: true, defaultReasoningEffort: 'medium', defaultResponseSpeed: 'standard', backend: { provider: 'session' }, nextStep: 'Ready' });
    const panel = html.match(/<details class="panel image-models-panel"[\s\S]*?<\/details>/)![0];
    expect(panel).toContain('id="image-models"');
    expect(panel).toContain('通过独立 Images API 生成图片，不使用文本 alias。');
    expect(panel).not.toContain('data-professional-only');
    expect(panel).not.toMatch(/<details[^>]*\sopen(?:\s|>)/);
  });

  it('loads the independent panel without adding images to text alias options and clears old entries on legacy responses', async () => {
    const f = modelsHarness();
    await f.loadModels();
    expect(f.elements.get('image-models')!.innerHTML).toContain('gpt-image-2');
    expect(f.elements.get('model-backend')!.innerHTML).toContain('text-model-0');
    expect(f.elements.get('model-backend')!.innerHTML).not.toContain('gpt-image-2');
    expect(f.elements.get('models')!.innerHTML).not.toContain('gpt-image-2');
    f.setPayload({ aliases: [], discovered: [] });
    await f.loadModels();
    expect(f.elements.get('image-models')!.innerHTML).toContain('当前没有可用的图片模型');
    expect(f.elements.get('image-models')!.innerHTML).not.toContain('gpt-image-2');
  });

  it.each(['toggle', 'health'] as const)('updates the image panel after account %s changes', async (action) => {
    const f = modelsHarness(action);
    await f.loadModels();
    expect(f.elements.get('image-models')!.innerHTML).toContain('gpt-image-2');
    await f.click();
    expect(f.loadAccounts).toHaveBeenCalledOnce();
    expect(f.elements.get('image-models')!.innerHTML).toContain('当前没有可用的图片模型');
    expect(f.elements.get('image-models')!.innerHTML).not.toContain('gpt-image-2');
    expect(f.button.disabled).toBe(false);
  });

  it('refreshes image availability even after an account health refresh fails', async () => {
    const f = modelsHarness('health', true);
    await f.loadModels();
    await f.click();
    expect(f.loadAccounts).toHaveBeenCalledOnce();
    expect(f.elements.get('image-models')!.innerHTML).not.toContain('gpt-image-2');
    expect(f.renderResult).toHaveBeenCalledWith({ error: 'Refresh failed' });
  });
});
