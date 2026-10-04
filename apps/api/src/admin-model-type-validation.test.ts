import { describe, expect, it } from 'vitest';
import { CODEX_IMAGE_MODEL_IDS, MockChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { createAdminRoute } from './routes/admin.js';
import { AccountPool } from './services/account-pool.js';
import { ModelRegistry } from './services/model-registry.js';
import { RuntimeApiKeys } from './services/runtime-api-keys.js';

function fixture(registry = new ModelRegistry({ defaults: { aliases: [] } })) {
  registry.replaceDiscoveredModels([{ id: 'vision-text', capabilities: { input_modalities: ['text', 'image'], image_generation: true } }]);
  const app = createAdminRoute({ accountPool: new AccountPool(), modelRegistry: registry, runtimeApiKeys: new RuntimeApiKeys(), backend: new MockChatGptBackend(),
    envApiKeys: [], defaultReasoningEffort: 'none', defaultResponseSpeed: 'standard', backendProvider: 'mock' });
  return { app, registry, send: (method: string, id: string | undefined, body?: unknown) => app.request('/admin/api/models' + (id ? '/' + encodeURIComponent(id) : ''), {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) };
}
async function expectImagesError(response: Response) {
  expect(response.status).toBe(400);
  const body = await response.json() as { error: string };
  expect(body.error).toContain('Images API');
  expect(body.error).toContain('/v1/images/generations');
}

describe('Admin text alias model-type validation', () => {
  it.each(CODEX_IMAGE_MODEL_IDS)('rejects new %s alias IDs and targets before saving state', async (imageModel) => {
    const f = fixture();
    for (const body of [
      { id: imageModel, backendModel: 'vision-text' },
      { id: 'ordinary-alias', backendModel: imageModel },
      { id: ` ${imageModel} `, enabled: false },
      { id: 'disabled-alias', backendModel: ` ${imageModel} `, enabled: false },
    ]) {
      await expectImagesError(await f.send('POST', undefined, body));
      expect(f.registry.exportState()).toEqual([]);
    }
  });

  it.each(CODEX_IMAGE_MODEL_IDS)('rejects a new %s target even when submitted together with disable', async (imageModel) => {
    const f = fixture();
    f.registry.create({ id: 'ordinary', backendModel: 'vision-text' });
    const before = f.registry.exportState();
    for (const enabled of [true, false]) {
      await expectImagesError(await f.send('PATCH', 'ordinary', { backendModel: ` ${imageModel} `, enabled }));
      expect(f.registry.exportState()).toEqual(before);
    }
  });

  it('keeps legacy image targets loadable, disableable, unbindable and correctable', async () => {
    const original = new ModelRegistry({ defaults: { aliases: [] } });
    original.create({ id: 'legacy', backendModel: CODEX_IMAGE_MODEL_IDS[0], enabled: true });
    const restored = new ModelRegistry({ defaults: { aliases: [] } });
    expect(() => restored.importState(original.exportState())).not.toThrow();
    const f = fixture(restored);
    expect((await f.app.request('/admin/api/models')).status).toBe(200);
    expect((await f.send('PATCH', 'legacy', { backendModel: CODEX_IMAGE_MODEL_IDS[0], enabled: false })).status).toBe(200);
    expect(f.registry.get('legacy')?.enabled).toBe(false);
    await expectImagesError(await f.send('PATCH', 'legacy', { enabled: true }));
    expect((await f.send('PATCH', 'legacy', { backendModel: null })).status).toBe(200);
    expect(f.registry.get('legacy')?.backendModel).toBeUndefined();
    expect((await f.send('PATCH', 'legacy', { backendModel: 'vision-text', enabled: true })).status).toBe(200);
    expect(f.registry.get('legacy')).toMatchObject({ backendModel: 'vision-text', enabled: true });
  });

  it('lets an enabled legacy image target be corrected directly and deleted without extra validation', async () => {
    const f = fixture();
    f.registry.create({ id: 'correctable', backendModel: CODEX_IMAGE_MODEL_IDS[0] });
    expect((await f.send('PATCH', 'correctable', { backendModel: 'vision-text', enabled: true })).status).toBe(200);
    f.registry.create({ id: 'deletable', backendModel: CODEX_IMAGE_MODEL_IDS[1] });
    expect((await f.send('DELETE', 'deletable')).status).toBe(200);
    expect(f.registry.get('deletable')).toBeUndefined();
  });

  it.each(CODEX_IMAGE_MODEL_IDS)('allows disabling, clearing and deleting historical reserved alias ID %s, but never re-enables it', async (imageModel) => {
    const f = fixture();
    f.registry.create({ id: imageModel, backendModel: 'vision-text', enabled: true });
    expect((await f.send('PATCH', imageModel, { enabled: false })).status).toBe(200);
    await expectImagesError(await f.send('PATCH', imageModel, { backendModel: 'vision-text', enabled: true }));
    expect(f.registry.get(imageModel)?.enabled).toBe(false);
    expect((await f.send('PATCH', imageModel, { backendModel: '' })).status).toBe(200);
    expect(f.registry.get(imageModel)?.backendModel).toBeUndefined();
    expect((await f.send('DELETE', imageModel)).status).toBe(200);
  });

  it('does not infer image-model type from name prefixes, vision input or capability flags', async () => {
    const f = fixture();
    expect((await f.send('POST', undefined, { id: 'gpt-image-custom-text-alias', backendModel: 'vision-text' })).status).toBe(201);
    expect((await f.send('POST', undefined, { id: 'future', backendModel: 'unknown-image-capable-model' })).status).toBe(201);
    expect((await f.send('PATCH', 'future', { backendModel: 'another-future-model', defaults: { reasoning_effort: 'high' } })).status).toBe(200);
    expect(f.registry.get('gpt-image-custom-text-alias')?.backendModel).toBe('vision-text');
    expect(f.registry.get('future')).toMatchObject({ backendModel: 'another-future-model', defaults: { reasoning_effort: 'high' } });
  });

  it('keeps nonexistent aliases as 404 and permits normal unbinding', async () => {
    const f = fixture();
    expect((await f.send('PATCH', 'missing', { backendModel: CODEX_IMAGE_MODEL_IDS[0] })).status).toBe(404);
    f.registry.create({ id: 'ordinary', backendModel: 'vision-text' });
    expect((await f.send('PATCH', 'ordinary', { backendModel: null })).status).toBe(200);
    expect(f.registry.get('ordinary')?.backendModel).toBeUndefined();
  });
});
