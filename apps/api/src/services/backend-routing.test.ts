import { describe, expect, it } from 'vitest';
import { BackendRouting, normalizeBackendRoutingConfig } from './backend-routing.js';

describe('BackendRouting', () => {
  it('preserves the Codex default and returns detached views', () => {
    const routing = new BackendRouting();
    expect(routing.snapshot()).toEqual({ mode: 'codex' });
    expect(routing.safeView()).toEqual({ webEnabled: false, mode: 'codex', autoPreference: 'codex', contextHandoff: false, configured: false });
    routing.update({ mode: 'auto', gateway: { baseUrl: 'http://localhost:8080/v1/' } });
    const state = routing.snapshot();
    expect(state).toEqual({ mode: 'auto', gateway: { baseUrl: 'http://localhost:8080', models: ['auto'], supportsTools: false } });
    expect(routing.isWebEnabled()).toBe(false);
    state.gateway!.models.push('unexpected');
    expect(routing.snapshot().gateway?.models).toEqual(['auto']);
  });

  it('keeps an omitted or empty key, redacts it, and clears only an explicit null', () => {
    const routing = new BackendRouting();
    routing.update({ gateway: { baseUrl: 'https://gateway.test/prefix/v1', apiKey: 'PRIVATE_KEY', models: ['web-model'] } });
    routing.update({ gateway: { apiKey: '', supportsTools: true } });
    routing.update({ mode: 'web' });
    expect(routing.snapshot().gateway?.apiKey).toBe('PRIVATE_KEY');
    expect(routing.safeView()).toEqual({ webEnabled: false, mode: 'web', autoPreference: 'codex', contextHandoff: false, configured: true, gateway: {
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
    expect(routing.isWebEnabled()).toBe(false);
    expect(routing.safeView()).toMatchObject({ webEnabled: false, autoPreference: 'codex', gateway: { supportsImages: false } });
    expect(routing.safeView().gateway).not.toHaveProperty('modelMappings');
    routing.restore({ mode: 'codex' });
    expect(routing.snapshot()).toEqual({ mode: 'codex' });
    expect(routing.isWebEnabled()).toBe(false);
    expect(routing.safeView().autoPreference).toBe('codex');
    expect(routing.safeView().contextHandoff).toBe(false);
  });

  it('requires an explicit opt-in and retains an existing explicit preference across gateway changes', () => {
    const routing = new BackendRouting({ mode: 'web', autoPreference: 'web', webEnabled: true, contextHandoff: true, gateway: {
      baseUrl: 'https://gateway.test', models: ['auto'], supportsTools: true,
    } });
    routing.update({ gateway: { apiKey: 'PRIVATE_KEY', supportsImages: true } });
    expect(routing.safeView()).toMatchObject({ webEnabled: true, mode: 'web', autoPreference: 'web', contextHandoff: true });
    routing.restore({ mode: 'web', gateway: { baseUrl: 'https://gateway.test', models: ['auto'], supportsTools: true } });
    expect(routing.safeView()).toMatchObject({ webEnabled: false, mode: 'web', autoPreference: 'codex' });
    routing.update({ mode: 'web' });
    expect(routing.isWebEnabled()).toBe(false);
    routing.update({ webEnabled: true });
    expect(routing.isWebEnabled()).toBe(true);
  });

  it('changes visible context handoff independently and preserves it across partial routing updates', () => {
    const routing = new BackendRouting();
    expect(routing.snapshot()).not.toHaveProperty('contextHandoff');
    routing.update({ contextHandoff: true });
    expect(routing.snapshot()).toEqual({ mode: 'codex', contextHandoff: true });
    expect(routing.safeView().contextHandoff).toBe(true);
    routing.update({ mode: 'auto', webEnabled: false });
    expect(routing.safeView()).toMatchObject({ contextHandoff: true, mode: 'auto', webEnabled: false });
    routing.update({ contextHandoff: false });
    expect(routing.snapshot()).toEqual({ mode: 'auto', webEnabled: false, contextHandoff: false });
    routing.restore({ mode: 'web', contextHandoff: true });
    expect(routing.safeView().contextHandoff).toBe(true);
  });

  it.each([null, 'true', 'PRIVATE_VALUE', 1, [], {}])('rejects non-boolean context handoff atomically (case %#)', (contextHandoff) => {
    const routing = new BackendRouting({ mode: 'auto', contextHandoff: true });
    expect(() => routing.update({ contextHandoff, mode: 'web' })).toThrow('contextHandoff');
    expect(() => normalizeBackendRoutingConfig({ mode: 'auto', contextHandoff })).toThrow('contextHandoff');
    expect(() => routing.restore({ mode: 'web', contextHandoff })).toThrow('contextHandoff');
    expect(routing.snapshot()).toEqual({ mode: 'auto', contextHandoff: true });
    try { routing.update({ contextHandoff }); } catch (error) { expect(String(error)).not.toContain('PRIVATE_VALUE'); }
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

  it('keeps strict-tool capability optional and preserves an explicit opt-out across UI gateway updates', () => {
    const routing = new BackendRouting();
    const gateway = { baseUrl: 'https://gateway.test', models: ['web-model'], supportsTools: true };
    routing.update({ gateway });
    expect(routing.snapshot().gateway).not.toHaveProperty('supportsStrictTools');
    expect(routing.safeView().gateway).not.toHaveProperty('supportsStrictTools');
    routing.update({ gateway: { supportsStrictTools: false } });
    expect(routing.safeView().gateway?.supportsStrictTools).toBe(false);
    routing.update({ mode: 'auto', gateway: { ...gateway, supportsImages: false, modelMappings: {} } });
    expect(routing.snapshot().gateway?.supportsStrictTools).toBe(false);
    expect(routing.safeView().gateway?.supportsStrictTools).toBe(false);
    routing.update({ gateway: { supportsStrictTools: true } });
    expect(routing.safeView().gateway?.supportsStrictTools).toBe(true);
  });

  it.each([null, 'false', 'PRIVATE_VALUE', 0, [], {}])('rejects invalid strict-tool capability atomically (case %#)', (supportsStrictTools) => {
    const routing = new BackendRouting({ mode: 'auto', gateway: {
      baseUrl: 'https://gateway.test', models: ['web-model'], supportsTools: true, supportsStrictTools: false,
    } });
    expect(() => routing.update({ mode: 'web', gateway: { supportsStrictTools } })).toThrow('supportsStrictTools');
    expect(() => normalizeBackendRoutingConfig({ mode: 'auto', gateway: { ...routing.snapshot().gateway, supportsStrictTools } })).toThrow('supportsStrictTools');
    expect(routing.snapshot()).toMatchObject({ mode: 'auto', gateway: { supportsStrictTools: false } });
    try { routing.update({ gateway: { supportsStrictTools } }); } catch (error) { expect(String(error)).not.toContain('PRIVATE_VALUE'); }
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
