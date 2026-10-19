import { describe, expect, it } from 'vitest';
import { BackendRouting, normalizeBackendRoutingConfig } from './backend-routing.js';

describe('BackendRouting', () => {
  it('preserves the Codex default and returns detached views', () => {
    const routing = new BackendRouting();
    expect(routing.snapshot()).toEqual({ mode: 'codex' });
    expect(routing.safeView()).toEqual({ webEnabled: false, mode: 'codex', autoPreference: 'web', configured: false });
    routing.update({ mode: 'auto', gateway: { baseUrl: 'http://localhost:8080/v1/' } });
    const state = routing.snapshot();
    expect(state).toEqual({ mode: 'auto', gateway: { baseUrl: 'http://localhost:8080', models: ['auto'], supportsTools: false } });
    state.gateway!.models.push('unexpected');
    expect(routing.snapshot().gateway?.models).toEqual(['auto']);
  });

  it('keeps an omitted or empty key, redacts it, and clears only an explicit null', () => {
    const routing = new BackendRouting();
    routing.update({ gateway: { baseUrl: 'https://gateway.test/prefix/v1', apiKey: 'PRIVATE_KEY', models: ['web-model'] } });
    routing.update({ gateway: { apiKey: '', supportsTools: true } });
    routing.update({ mode: 'web' });
    expect(routing.snapshot().gateway?.apiKey).toBe('PRIVATE_KEY');
    expect(routing.safeView()).toEqual({ webEnabled: true, mode: 'web', autoPreference: 'web', configured: true, gateway: {
      baseUrl: 'https://gateway.test/prefix', models: ['web-model'], supportsTools: true, supportsImages: false, apiKeyConfigured: true,
    } });
    expect(JSON.stringify(routing.safeView())).not.toContain('PRIVATE_KEY');
    routing.update({ gateway: { apiKey: null } });
    expect(routing.snapshot().gateway).not.toHaveProperty('apiKey');
    expect(routing.safeView().gateway?.apiKeyConfigured).toBe(false);
    routing.update({ gateway: null });
    expect(routing.snapshot()).toEqual({ mode: 'web' });
  });

  it('loads legacy routing without materializing optional preferences or image capability', () => {
    const legacy = { mode: 'auto', gateway: { baseUrl: 'https://gateway.test', models: ['web-model'], supportsTools: false } };
    const routing = new BackendRouting(normalizeBackendRoutingConfig(legacy));
    expect(routing.snapshot()).toEqual(legacy);
    expect(routing.isWebEnabled()).toBe(true);
    expect(routing.safeView()).toMatchObject({ webEnabled: true, autoPreference: 'web', gateway: { supportsImages: false } });
    expect(routing.safeView().gateway).not.toHaveProperty('modelMappings');
    routing.restore({ mode: 'codex' });
    expect(routing.snapshot()).toEqual({ mode: 'codex' });
    expect(routing.isWebEnabled()).toBe(false);
    expect(routing.safeView().autoPreference).toBe('web');
  });

  it('lets the web switch change independently while preserving routing and gateway credentials', () => {
    const routing = new BackendRouting({ mode: 'web', autoPreference: 'codex', gateway: {
      baseUrl: 'https://gateway.test', apiKey: 'PRIVATE_KEY', models: ['web-model'], supportsTools: true,
      supportsImages: true, modelMappings: { sonnet: 'web-model' },
    } });
    const original = routing.snapshot();
    routing.update({ webEnabled: false });
    expect(routing.isWebEnabled()).toBe(false);
    expect(routing.snapshot()).toEqual({ ...original, webEnabled: false });
    expect(routing.safeView()).toMatchObject({ webEnabled: false, configured: true, mode: 'web', gateway: { apiKeyConfigured: true } });
    expect(JSON.stringify(routing.safeView())).not.toContain('PRIVATE_KEY');
    routing.update({ gateway: { supportsTools: false } });
    expect(routing.isWebEnabled()).toBe(false);
    expect(routing.snapshot().gateway?.apiKey).toBe('PRIVATE_KEY');
    routing.update({ webEnabled: true });
    expect(routing.snapshot()).toEqual({ ...original, webEnabled: true, gateway: { ...original.gateway!, supportsTools: false } });
    expect(routing.isWebEnabled()).toBe(true);
  });

  it('stores the web choice before configuring a gateway and retains it when removing a gateway', () => {
    const routing = new BackendRouting();
    routing.update({ webEnabled: true, mode: 'auto' });
    expect(routing.snapshot()).toEqual({ mode: 'auto', webEnabled: true });
    expect(routing.safeView()).toMatchObject({ webEnabled: true, configured: false });
    routing.update({ gateway: { baseUrl: 'https://gateway.test' } });
    expect(routing.safeView()).toMatchObject({ webEnabled: true, configured: true });
    routing.update({ gateway: null });
    expect(routing.snapshot()).toEqual({ mode: 'auto', webEnabled: true });
    expect(routing.isWebEnabled()).toBe(true);
    routing.update({ webEnabled: false });
    expect(routing.snapshot()).toEqual({ mode: 'auto', webEnabled: false });
  });

  it.each([null, 'true', 'PRIVATE_VALUE', 1, [], {}])('rejects non-boolean web choices atomically (case %#)', (webEnabled) => {
    const routing = new BackendRouting({ mode: 'auto', webEnabled: true });
    expect(() => routing.update({ webEnabled, mode: 'web' })).toThrow('webEnabled');
    expect(() => normalizeBackendRoutingConfig({ mode: 'auto', webEnabled })).toThrow('webEnabled');
    expect(() => routing.restore({ mode: 'web', webEnabled })).toThrow('webEnabled');
    expect(routing.snapshot()).toEqual({ mode: 'auto', webEnabled: true });
  });

  it('keeps preference, image support and explicit mappings on partial updates with detached views', () => {
    const routing = new BackendRouting();
    routing.update({ mode: 'auto', autoPreference: 'codex', gateway: {
      baseUrl: 'https://gateway.test', models: ['web-model', 'web-other'], supportsImages: true,
      modelMappings: { sonnet: 'web-model', 'codex-model': 'web-other' },
    } });
    routing.update({ gateway: { supportsTools: true } });
    expect(routing.safeView()).toMatchObject({ autoPreference: 'codex', gateway: {
      supportsTools: true, supportsImages: true, modelMappings: { sonnet: 'web-model', 'codex-model': 'web-other' },
    } });
    const snapshot = routing.snapshot();
    const view = routing.safeView();
    snapshot.gateway!.modelMappings!.sonnet = 'web-other';
    view.gateway!.modelMappings!.sonnet = 'web-other';
    expect(routing.snapshot().gateway?.modelMappings?.sonnet).toBe('web-model');
    routing.update({ autoPreference: 'web', gateway: { supportsImages: false, modelMappings: {} } });
    expect(routing.snapshot()).toMatchObject({ autoPreference: 'web', gateway: { supportsImages: false, modelMappings: {} } });
  });

  it('validates mapping targets against the complete next gateway configuration atomically', () => {
    const routing = new BackendRouting();
    routing.update({ gateway: { baseUrl: 'https://gateway.test', models: ['web-model'], modelMappings: { sonnet: 'web-model' } } });
    const before = routing.snapshot();
    expect(() => routing.update({ autoPreference: 'codex', gateway: { models: ['replacement'] } })).toThrow('modelMappings');
    expect(routing.snapshot()).toEqual(before);
    routing.update({ gateway: { models: ['replacement'], modelMappings: { sonnet: 'replacement' } } });
    expect(routing.snapshot().gateway?.modelMappings).toEqual({ sonnet: 'replacement' });
  });

  it('safely accepts arbitrary ordinary model keys without prototype lookup semantics', () => {
    const routing = new BackendRouting();
    routing.update({ gateway: { baseUrl: 'https://gateway.test', models: ['web-model'],
      modelMappings: Object.fromEntries([['toString', 'web-model'], ['hasOwnProperty', 'web-model']]),
    } });
    expect(Object.entries(routing.snapshot().gateway!.modelMappings!)).toEqual([['toString', 'web-model'], ['hasOwnProperty', 'web-model']]);
    expect(Object.getPrototypeOf(routing.snapshot().gateway!.modelMappings!)).toBe(Object.prototype);
  });

  it.each([
    null, [], 'PRIVATE_VALUE', { '': 'web-model' }, { ' model': 'web-model' }, { 'model\n': 'web-model' },
    { ['a'.repeat(257)]: 'web-model' }, { alias: 'PRIVATE_VALUE' }, { alias: true },
    JSON.parse('{"__proto__":"web-model"}'), { constructor: 'web-model' }, { prototype: 'web-model' },
    Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`model-${index}`, 'web-model'])),
  ])('rejects invalid model mappings without partial mutations or payload disclosure (case %#)', (modelMappings) => {
    const routing = new BackendRouting();
    const patch = { autoPreference: 'codex', gateway: { baseUrl: 'https://gateway.test', models: ['web-model'], modelMappings } };
    expect(() => routing.update(patch)).toThrow('modelMappings');
    try { routing.update(patch); } catch (error) { expect(String(error)).not.toContain('PRIVATE_VALUE'); }
    expect(routing.snapshot()).toEqual({ mode: 'codex' });
  });

  it.each([
    { mode: 'unknown' }, { autoPreference: 'PRIVATE_VALUE' }, { autoPreference: null }, { secret: 'PRIVATE_VALUE' }, { gateway: { extra: true } },
    { gateway: { baseUrl: 'ftp://PRIVATE_VALUE.test' } },
    { gateway: { baseUrl: 'https://PRIVATE_VALUE@gateway.test' } },
    { gateway: { baseUrl: 'https://gateway.test?PRIVATE_VALUE' } },
    { gateway: { baseUrl: 'https://gateway.test#PRIVATE_VALUE' } },
    { gateway: { baseUrl: 'https://gate\nway.test' } },
    { gateway: { baseUrl: 'https://gateway.test', models: [] } },
    { gateway: { baseUrl: 'https://gateway.test', models: ['a', ' a '] } },
    { gateway: { baseUrl: 'https://gateway.test', supportsTools: 'true' } },
    { gateway: { baseUrl: 'https://gateway.test', supportsImages: 'true' } },
    { gateway: { baseUrl: 'https://gateway.test', supportsImages: null } },
    { gateway: { baseUrl: 'https://gateway.test', apiKey: 'PRIVATE_VALUE\nheader' } },
  ])('rejects invalid patches atomically without echoing configuration (case %#)', (patch) => {
    const routing = new BackendRouting();
    expect(() => routing.update(patch)).toThrow();
    try { routing.update(patch); } catch (error) { expect(String(error)).not.toContain('PRIVATE_VALUE'); }
    expect(routing.snapshot()).toEqual({ mode: 'codex' });
  });

  it('validates complete persisted configuration strictly', () => {
    expect(() => normalizeBackendRoutingConfig({ mode: 'auto', gateway: { baseUrl: 'https://gateway.test' } })).toThrow();
    expect(() => normalizeBackendRoutingConfig({ mode: 'codex', gateway: null })).toThrow();
    expect(() => normalizeBackendRoutingConfig({ mode: 'codex', extra: true })).toThrow();
  });
});
