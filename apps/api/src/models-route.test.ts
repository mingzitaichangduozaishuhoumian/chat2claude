import { describe, expect, it } from 'vitest';
import { createModelsRoute, projectPublicModel } from './routes/models.js';
import type { ModelRegistry, RuntimeModel } from './services/model-registry.js';

function runtimeModel(): RuntimeModel {
  return {
    id: 'sonnet', type: 'model', display_name: 'Sonnet', builtIn: true, enabled: true,
    backendModel: 'astra', defaults: { reasoning_effort: 'ultra', speed: 'standard' },
    source: 'alias', status: 'bound',
    context: { metadata_status: 'unknown' },
    effective_defaults: { reasoning_effort: 'ultra', upstream_reasoning_effort: 'xhigh', delegation: 'caller_tools', reasoning_source: 'alias', service_tier_source: 'omit' },
    configuration_issues: [],
    discovered: {
      id: 'astra',
      controls: {
        reasoning: { metadataKnown: true, supported: [{ effort: 'xhigh', description: 'Base effort' }, { effort: 'ultra' }], defaultEffort: 'xhigh', multiAgentVersion: 'v2', multiAgentReasoningEffort: 'xhigh' },
        serviceTier: { metadataKnown: true, supported: [{ id: 'priority', name: 'Fast' }], fastMode: true },
      },
    },
    capabilities: {
      reasoning_effort: ['xhigh', 'ultra'], reasoning_effort_options: [{ effort: 'xhigh', description: 'Base effort' }, { effort: 'ultra' }],
      response_speed: ['standard', 'priority'], service_tiers: [{ id: 'priority', name: 'Fast' }],
      thinking: true, metadata_status: { reasoning: 'known', service_tier: 'known' }, fast_mode: true,
      ultra_lossy: false, ultra_execution: { reasoning_effort: 'xhigh', delegation: 'caller_tools' },
      ultra_mapped_effort: 'legacy-value',
    },
  };
}

describe('/v1/models Ultra public projection', () => {
  it('publishes explicit Ultra execution and multi-agent metadata using a field whitelist', async () => {
    const model = runtimeModel();
    const canary = { internalSecret: 'ULTRA-PROJECTION-SECRET-CANARY' };
    for (const object of [model, model.defaults, model.effective_defaults, model.capabilities, model.capabilities.metadata_status,
      model.capabilities.ultra_execution!, model.capabilities.reasoning_effort_options[0], model.discovered!,
      model.discovered!.controls!.reasoning, model.discovered!.controls!.reasoning.supported[0]]) Object.assign(object, canary);
    model.discovered!.raw = canary;
    const app = createModelsRoute({ modelRegistry: { list: () => [model] } as unknown as ModelRegistry });

    const response = await app.request('/v1/models');
    const body = await response.json() as { data: ReturnType<typeof projectPublicModel>[] };
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain('ULTRA-PROJECTION-SECRET-CANARY');
    const projected = body.data[0];
    expect(projected.capabilities.ultra_execution).toEqual({ reasoning_effort: 'xhigh', delegation: 'caller_tools' });
    expect(projected.capability_projection.ultra_execution).toEqual(projected.capabilities.ultra_execution);
    expect(projected.capabilities).toMatchObject({ ultra_lossy: false, ultra_mapped_effort: 'legacy-value' });
    expect(projected.effective_defaults).toEqual({ reasoning_effort: 'ultra', upstream_reasoning_effort: 'xhigh', delegation: 'caller_tools', reasoning_source: 'alias', service_tier_source: 'omit' });
    expect(projected.discovered!.controls!.reasoning).toEqual({
      metadataKnown: true, supported: [{ effort: 'xhigh', description: 'Base effort' }, { effort: 'ultra' }],
      defaultEffort: 'xhigh', multiAgentVersion: 'v2', multiAgentReasoningEffort: 'xhigh',
    });
    expect(projected.discovered).not.toHaveProperty('raw');
    expect(projected).not.toHaveProperty('backendModel');
  });

  it('copies nested public data without sharing mutable references with the catalog or other projections', () => {
    const source = runtimeModel();
    const original = structuredClone(source);
    const projected = projectPublicModel(source);
    expect(projected.capabilities.ultra_execution).not.toBe(source.capabilities.ultra_execution);
    expect(projected.capability_projection.ultra_execution).not.toBe(projected.capabilities.ultra_execution);
    expect(projected.capabilities.metadata_status).not.toBe(source.capabilities.metadata_status);
    expect(projected.discovered!.controls!.reasoning.supported[0]).not.toBe(source.discovered!.controls!.reasoning.supported[0]);

    projected.capabilities.ultra_execution!.reasoning_effort = 'max';
    projected.capabilities.reasoning_effort.push('future');
    projected.capabilities.reasoning_effort_options[0].description = 'Changed';
    projected.capabilities.service_tiers[0].name = 'Changed';
    projected.capabilities.metadata_status.reasoning = 'unknown';
    projected.defaults.reasoning_effort = 'max';
    projected.effective_defaults.upstream_reasoning_effort = 'max';
    projected.discovered!.controls!.reasoning.supported[0].effort = 'low';
    projected.discovered!.controls!.reasoning.multiAgentReasoningEffort = 'max';
    projected.discovered!.controls!.serviceTier.supported[0].name = 'Changed';
    projected.configuration_issues.push('Changed');

    expect(source).toEqual(original);
    expect(projected.capability_projection.ultra_execution!.reasoning_effort).toBe('xhigh');
    expect(projected.capability_projection.reasoning_effort).toEqual(['xhigh', 'ultra']);
    expect(projected.capability_projection.metadata_status.reasoning).toBe('known');
  });

  it('keeps absent multi-agent effort and absent Ultra execution absent', () => {
    const source = runtimeModel();
    delete source.discovered!.controls!.reasoning.multiAgentReasoningEffort;
    delete source.capabilities.ultra_execution;
    delete source.capabilities.ultra_mapped_effort;
    const projected = projectPublicModel(source);
    expect(projected.discovered!.controls!.reasoning.multiAgentVersion).toBe('v2');
    expect(projected.discovered!.controls!.reasoning).not.toHaveProperty('multiAgentReasoningEffort');
    expect(projected.capabilities).not.toHaveProperty('ultra_execution');
    expect(projected.capability_projection).not.toHaveProperty('ultra_execution');
    expect(projected.capabilities).not.toHaveProperty('ultra_mapped_effort');
  });

  it('projects account-dependent Ultra without inventing a global base effort', () => {
    const source = runtimeModel();
    source.capabilities.ultra_execution = { delegation: 'caller_tools', account_dependent: true };
    delete source.effective_defaults.upstream_reasoning_effort;
    source.effective_defaults.reasoning_account_dependent = true;
    Object.assign(source.capabilities.ultra_execution, { internalSecret: 'ACCOUNT-DEPENDENT-SECRET-CANARY' });
    const projected = projectPublicModel(source);

    expect(projected.capabilities.ultra_execution).toEqual({ delegation: 'caller_tools', account_dependent: true });
    expect(projected.capability_projection.ultra_execution).toEqual(projected.capabilities.ultra_execution);
    expect(projected.capabilities.ultra_execution).not.toHaveProperty('reasoning_effort');
    expect(projected.effective_defaults).toMatchObject({ reasoning_effort: 'ultra', delegation: 'caller_tools', reasoning_account_dependent: true });
    expect(projected.effective_defaults).not.toHaveProperty('upstream_reasoning_effort');
    expect(JSON.stringify(projected)).not.toContain('ACCOUNT-DEPENDENT-SECRET-CANARY');
    expect(projected.capabilities.ultra_execution).not.toBe(source.capabilities.ultra_execution);
    projected.capabilities.ultra_execution!.reasoning_effort = 'max';
    expect(source.capabilities.ultra_execution).not.toHaveProperty('reasoning_effort');
    expect(projected.capability_projection.ultra_execution).not.toHaveProperty('reasoning_effort');
  });
});
