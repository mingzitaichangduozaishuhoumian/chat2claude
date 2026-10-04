import { expect, it } from 'vitest';
import type { ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { adminPageClientScript } from './routes/admin-page-client.js';
import { localizeAdminMarkup } from './routes/admin-page-i18n.js';

it('advertises a separate Images API and image-model example without adding it to the text catalog', async () => {
  const backend: ChatGptBackendClient = {
    listModels: async () => [{ id: 'text-only' }], async *stream() {}, complete: async () => ({ text: '', finishReason: 'stop' }),
    generateImages: async () => ({ created: 1, data: [{ b64_json: 'aW1hZ2U=' }] }),
  };
  const app = createApp(loadEnv({ NODE_ENV: 'test', API_KEYS: 'synthetic-key' }), { backend, runtimeStateStore: null, operationalState: null });
  try {
    const status = await (await app.request('/admin/api/setup/status')).json();
    expect(status).toMatchObject({ imageGeneration: { endpoint: 'POST /v1/images/generations', defaultModel: 'gpt-image-2', supported: true, responseFormat: 'b64_json', outputFormat: 'png', streaming: 'final_only' } });
    const models = await (await app.request('/v1/models', { headers: { authorization: 'Bearer synthetic-key' } })).json() as { data: Array<{ source?: string }> };
    expect(models).toMatchObject({ data: expect.arrayContaining([{ id: 'gpt-image-2', type: 'model', display_name: 'GPT Image 2', source: 'image_endpoint', endpoint: '/v1/images/generations', capabilities: { image_generation: true }, availability: 'backend_dependent' }]) });
    const catalog = await (await app.request('/admin/api/models', { headers: { authorization: 'Bearer synthetic-key' } })).json() as { aliases: unknown[]; discovered: unknown[]; combined: unknown[]; imageModels: unknown[] };
    expect(catalog.imageModels).toEqual(models.data.filter((model: { source?: string }) => model.source === 'image_endpoint'));
    expect(catalog.imageModels).toHaveLength(5);
    expect(JSON.stringify({ aliases: catalog.aliases, discovered: catalog.discovered, combined: catalog.combined })).not.toContain('gpt-image-2');
    const page = await (await app.request('/admin')).text();
    expect(page).toContain('__ORIGIN__/v1/images/generations');
    expect(page).toContain('&quot;model&quot;:&quot;gpt-image-2&quot;');
    const note = page.match(/<p class="muted">图片生成使用独立 Images API[^<]*<\/p>/)![0];
    expect(localizeAdminMarkup(note, 'en')).toContain('streaming sends the final image only, with no partial previews');
  } finally { await app.dispose(); }
});

it('fills the current origin in both text and image curl examples', () => {
  const script = adminPageClientScript();
  const source = script.slice(script.indexOf('const curlExample ='), script.indexOf("document.getElementById('base-url')"));
  const example = { textContent: '', dataset: { template: 'curl __ORIGIN__/v1/messages\ncurl __ORIGIN__/v1/images/generations' } };
  new Function('document', 'window', source)({ getElementById: () => example }, { location: { origin: 'https://example.test:9443' } });
  expect(example.textContent).toBe('curl https://example.test:9443/v1/messages\ncurl https://example.test:9443/v1/images/generations');
});

it('keeps both curl origins resolved after OAuth completes', () => {
  const script = adminPageClientScript();
  const start = script.indexOf('const curl = curlExample.dataset.template');
  const source = script.slice(start, script.indexOf("document.getElementById('key-state')", start));
  const example = { textContent: '', dataset: { template: 'curl __ORIGIN__/v1/messages\ncurl __ORIGIN__/v1/images/generations' } };
  const ready = { textContent: '' };
  new Function('document', 'window', 'curlExample', source)({ getElementById: () => ready }, { location: { origin: 'https://example.test:9443' } }, example);
  expect(example.textContent).toBe('curl https://example.test:9443/v1/messages\ncurl https://example.test:9443/v1/images/generations');
  expect(ready.textContent).toBe(example.textContent);
});
