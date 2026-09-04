import { describe, expect, it } from 'vitest';
import type { ChatGptDiscoveredModel } from '@chatgpt-to-claude/chatgpt-backend';
import { ModelRegistry, ModelRegistryError } from './model-registry.js';

function catalogModel(overrides: Partial<ChatGptDiscoveredModel> = {}): ChatGptDiscoveredModel {
  return {
    id: 'codex-target',
    controls: {
      reasoning: {
        metadataKnown: true,
        supported: [
          { effort: 'low', description: 'Quick reasoning' },
          { effort: 'future-deep', description: 'Future catalog value' },
          { effort: 'max' },
        ],
        defaultEffort: 'future-deep',
      },
      serviceTier: {
        metadataKnown: true,
        supported: [
          { id: 'economy', name: 'Economy' },
          { id: 'priority', name: 'Priority' },
        ],
        defaultTier: 'economy',
        fastMode: true,
      },
    },
    ...overrides,
  };
}

function registry(model: ChatGptDiscoveredModel, defaults: { reasoning_effort: string; speed: string } = { reasoning_effort: 'medium', speed: 'standard' }): ModelRegistry {
  return new ModelRegistry({
    defaults: {
      aliases: [{
        id: 'sonnet',
        type: 'model',
        display_name: 'Sonnet',
        backendModel: model.id,
        enabled: true,
        capabilities: { reasoning_effort: ['off', 'max'], response_speed: ['quality'], thinking: true },
        defaults,
      }],
    },
    discoveredModels: [model],
  });
}

describe('ModelRegistry dynamic Codex controls', () => {
  it('projects ordered target capabilities instead of static alias capabilities', () => {
    const model = registry(catalogModel()).get('sonnet')!;
    expect(model.capabilities.reasoning_effort).toEqual(['low', 'future-deep', 'max']);
    expect(model.capabilities.reasoning_effort_options[1]).toEqual({ effort: 'future-deep', description: 'Future catalog value' });
    expect(model.capabilities.response_speed).toEqual(['standard', 'auto', 'economy', 'priority']);
    expect(model.capabilities.service_tiers.map((tier) => tier.id)).toEqual(['economy', 'priority']);
    expect(model.configuration_issues).toContain('Configured reasoning default "medium" is unsupported by target codex-target.');
    expect(model.effective_defaults).toMatchObject({ reasoning_effort: 'future-deep', reasoning_source: 'discovered', service_tier: 'default', service_tier_source: 'alias' });
  });

  it('uses explicit controls before alias and discovered defaults while preserving custom strings', () => {
    const models = registry(catalogModel());
    const resolution = models.resolve('sonnet');
    expect(models.resolveControls(resolution, { reasoningEffort: 'future-deep', serviceTier: 'economy' })).toEqual({
      reasoningEffort: 'future-deep',
      serviceTier: 'economy',
      reasoningSource: 'explicit',
      serviceTierSource: 'explicit',
    });
  });

  it('sends advertised neutral controls and rejects explicit none when unsupported', () => {
    const unsupported = registry(catalogModel());
    expect(() => unsupported.resolveControls(unsupported.resolve('sonnet'), { reasoningEffort: 'off' })).toThrow(/Supported values: low, future-deep, max/);

    const target = catalogModel({
      controls: {
        ...catalogModel().controls!,
        reasoning: {
          metadataKnown: true,
          supported: [{ effort: 'none' }, { effort: 'low' }],
          defaultEffort: 'low',
        },
      },
    });
    const models = registry(target);
    expect(models.resolveControls(models.resolve('sonnet'), { reasoningEffort: 'off', serviceTier: 'quality' })).toEqual({
      reasoningEffort: 'none',
      serviceTier: 'default',
      reasoningSource: 'explicit',
      serviceTierSource: 'explicit',
    });
    expect(models.resolveControls(models.resolve('sonnet'), { reasoningEffort: 'light', serviceTier: 'fast' })).toMatchObject({
      reasoningEffort: 'low',
      serviceTier: 'priority',
    });
  });

  it('lets neutral and auto service controls override a non-neutral discovered default', () => {
    const target = catalogModel({
      controls: {
        ...catalogModel().controls!,
        serviceTier: {
          metadataKnown: true,
          supported: [{ id: 'priority' }],
          defaultTier: 'priority',
          fastMode: true,
        },
      },
    });
    const standard = registry(target, { reasoning_effort: 'low', speed: 'standard' });
    expect(standard.resolveControls(standard.resolve('sonnet'))).toMatchObject({ serviceTier: 'default', serviceTierSource: 'alias' });
    expect(standard.resolveControls(standard.resolve('sonnet'), { serviceTier: 'standard_only' })).toMatchObject({ serviceTier: 'default', serviceTierSource: 'explicit' });
    expect(standard.resolveControls(standard.resolve('sonnet'), { serviceTier: 'auto' })).toEqual({
      reasoningEffort: 'low',
      reasoningSource: 'alias',
      serviceTierSource: 'explicit',
    });
  });

  it('falls back from an unsupported implicit none default and reports the alias issue', () => {
    const models = registry(catalogModel(), { reasoning_effort: 'none', speed: 'standard' });
    expect(models.get('sonnet')?.configuration_issues).toContain('Configured reasoning default "none" is unsupported by target codex-target.');
    expect(models.resolveControls(models.resolve('sonnet'))).toMatchObject({ reasoningEffort: 'future-deep', reasoningSource: 'discovered' });
  });

  it('rejects unsupported explicit controls with ordered supported values', () => {
    const models = registry(catalogModel());
    expect(() => models.resolveControls(models.resolve('sonnet'), { reasoningEffort: 'medium' })).toThrowError(ModelRegistryError);
    try {
      models.resolveControls(models.resolve('sonnet'), { reasoningEffort: 'medium' });
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: 'unsupported_control' });
      expect((error as Error).message).toContain('Supported values: low, future-deep, max');
    }
  });

  it('maps advertised ultra to a safe multi-agent effort without forwarding ultra', () => {
    const target = catalogModel({
      controls: {
        reasoning: {
          metadataKnown: true,
          supported: [{ effort: 'low' }, { effort: 'ultra' }, { effort: 'max' }],
          defaultEffort: 'low',
          multiAgent: { effort: 'xhigh' },
        },
        serviceTier: { metadataKnown: false, supported: [], fastMode: false },
      },
    });
    const models = registry(target, { reasoning_effort: 'ultra', speed: 'standard' });
    expect(models.get('sonnet')?.capabilities).toMatchObject({ ultra_lossy: true, ultra_mapped_effort: 'xhigh' });
    expect(models.resolveControls(models.resolve('sonnet'))).toMatchObject({ reasoningEffort: 'xhigh', reasoningSource: 'alias' });
  });

  it('falls back from ultra to max and then to the last advertised non-ultra effort', () => {
    const withMax = catalogModel({
      controls: {
        reasoning: { metadataKnown: true, supported: [{ effort: 'ultra' }, { effort: 'max' }] },
        serviceTier: { metadataKnown: false, supported: [], fastMode: false },
      },
    });
    expect(registry(withMax, { reasoning_effort: 'ultra', speed: 'standard' }).resolveControls(registry(withMax, { reasoning_effort: 'ultra', speed: 'standard' }).resolve('sonnet')).reasoningEffort).toBe('max');

    const ordered = catalogModel({
      controls: {
        reasoning: { metadataKnown: true, supported: [{ effort: 'low' }, { effort: 'ultra' }, { effort: 'future-last' }] },
        serviceTier: { metadataKnown: false, supported: [], fastMode: false },
      },
    });
    const models = registry(ordered, { reasoning_effort: 'ultra', speed: 'standard' });
    expect(models.resolveControls(models.resolve('sonnet')).reasoningEffort).toBe('future-last');
  });

  it('does not break model metadata when ultra has no safe non-ultra mapping', () => {
    const target = catalogModel({
      controls: {
        reasoning: { metadataKnown: true, supported: [{ effort: 'ultra' }], defaultEffort: 'ultra' },
        serviceTier: { metadataKnown: false, supported: [], fastMode: false },
      },
    });
    const models = registry(target, { reasoning_effort: 'ultra', speed: 'standard' });
    expect(models.get('sonnet')?.capabilities).toMatchObject({ ultra_lossy: true });
    expect(models.get('sonnet')?.capabilities.ultra_mapped_effort).toBeUndefined();
    expect(models.resolveControls(models.resolve('sonnet')).reasoningEffort).toBeUndefined();
    expect(() => models.resolveControls(models.resolve('sonnet'), { reasoningEffort: 'ultra' })).toThrow(/no explicit values|Supported values/);
  });

  it('keeps missing metadata unknown and safely omits invalid implicit defaults', () => {
    const models = registry({ id: 'unknown-target' });
    const runtime = models.get('sonnet')!;
    expect(runtime.capabilities.metadata_status).toEqual({ reasoning: 'unknown', service_tier: 'unknown' });
    expect(runtime.capabilities.reasoning_effort).toEqual([]);
    expect(runtime.effective_defaults.reasoning_source).toBe('omit');
    expect(models.resolveControls(models.resolve('sonnet'))).toEqual({ reasoningSource: 'omit', serviceTier: 'default', serviceTierSource: 'alias' });
  });

  it('keeps account catalogs disjoint while exposing their safe union', () => {
    const models = new ModelRegistry({
      defaults: {
        aliases: [{
          id: 'sonnet', type: 'model', display_name: 'Sonnet', backendModel: 'model-a', enabled: true,
          capabilities: {}, defaults: { reasoning_effort: 'none', speed: 'auto' },
        }],
      },
    });
    const accountA = { accountId: 'account-a', createdAt: '2026-09-04T01:00:00.000Z' };
    const accountB = { accountId: 'account-b', createdAt: '2026-09-04T02:00:00.000Z' };
    models.replaceAccountModels(accountA, [catalogModel({ id: 'model-a' })]);
    models.replaceAccountModels(accountB, [catalogModel({
      id: 'model-b',
      controls: {
        reasoning: { metadataKnown: true, supported: [{ effort: 'low' }], defaultEffort: 'low' },
        serviceTier: { metadataKnown: true, supported: [], fastMode: false },
      },
    })]);

    expect(models.adminView().discovered.map((model) => model.id)).toEqual(['model-a', 'model-b']);
    expect(models.get('sonnet')?.status).toBe('bound');
    expect(models.resolveForAccount('sonnet', accountA).backendModel).toBe('model-a');
    expect(() => models.resolveForAccount('sonnet', accountB)).toThrow(/missing backend model/i);
    expect(models.supportsAccountRequest('sonnet', accountA, { reasoningEffort: 'future-deep' })).toBe(true);
    expect(models.supportsAccountRequest('sonnet', accountB, { reasoningEffort: 'future-deep' })).toBe(false);
  });

  it('updates effective availability when account catalogs are disabled, replaced, and removed', () => {
    const models = new ModelRegistry({
      defaults: {
        aliases: [{
          id: 'sonnet', type: 'model', display_name: 'Sonnet', backendModel: 'model-a', enabled: true,
          capabilities: {}, defaults: { reasoning_effort: 'none', speed: 'auto' },
        }],
      },
    });
    const accountA = { accountId: 'account-a', createdAt: '2026-09-04T01:00:00.000Z' };
    const accountB = { accountId: 'account-b', createdAt: '2026-09-04T02:00:00.000Z' };
    models.replaceAccountModels(accountA, [{ id: 'model-a' }]);
    models.replaceAccountModels(accountB, [{ id: 'model-b' }]);

    models.setAccountActive(accountA, false);
    expect(models.adminView().discovered.map((model) => model.id)).toEqual(['model-b']);
    expect(models.get('sonnet')?.status).toBe('stale');

    models.setAccountActive(accountA, true);
    expect(models.get('sonnet')?.status).toBe('bound');
    models.replaceAccountModels(accountA, [{ id: 'model-a-reauthorized' }]);
    expect(models.adminView().discovered.map((model) => model.id)).toEqual(['model-a-reauthorized', 'model-b']);
    expect(models.get('sonnet')?.status).toBe('stale');

    models.removeAccountModels(accountB);
    expect(models.adminView().discovered.map((model) => model.id)).toEqual(['model-a-reauthorized']);
  });
});
