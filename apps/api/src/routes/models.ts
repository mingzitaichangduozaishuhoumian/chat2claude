import { Hono } from 'hono';
import type { EffectiveModelDefaults, ModelCapabilities, ModelDefaults, ModelRegistry, RuntimeModel } from '../services/model-registry.js';
import type { ChatGptModelControlCapabilities, ChatGptReasoningLevelOption, ChatGptServiceTierOption } from '@chatgpt-to-claude/chatgpt-backend';

export interface PublicDiscoveredModel {
  id: string;
  displayName?: string;
  controls?: {
    reasoning: {
      metadataKnown: boolean;
      supported: ChatGptReasoningLevelOption[];
      defaultEffort?: string;
    };
    serviceTier: {
      metadataKnown: boolean;
      supported: ChatGptServiceTierOption[];
      defaultTier?: string;
      fastMode: boolean;
    };
  };
}

export interface PublicModel {
  id: string;
  type: 'model';
  display_name: string;
  builtIn: boolean;
  enabled: boolean;
  defaults: ModelDefaults;
  source: RuntimeModel['source'];
  capabilities: ModelCapabilities;
  discovered?: PublicDiscoveredModel;
  status: RuntimeModel['status'];
  effective_defaults: EffectiveModelDefaults;
  configuration_issues: string[];
  token_counting_mode: 'heuristic';
  capability_projection: Pick<ModelCapabilities, 'reasoning_effort' | 'response_speed' | 'thinking' | 'metadata_status' | 'fast_mode' | 'ultra_lossy'>;
}

export interface ModelsRouteOptions { modelRegistry: ModelRegistry; ready?: Promise<unknown>; }
export function createModelsRoute(options: ModelsRouteOptions): Hono {
  return new Hono().get('/v1/models', async (c) => {
    if (options.ready) await options.ready;
    return c.json({ data: options.modelRegistry.list()
      .filter((model) => model.enabled && model.status !== 'unbound' && model.status !== 'stale')
      .map(projectPublicModel) });
  });
}

function projectPublicModel(model: RuntimeModel): PublicModel {
  const { capabilities } = model;
  return {
    id: model.id,
    type: model.type,
    display_name: model.display_name,
    builtIn: model.builtIn,
    enabled: model.enabled,
    defaults: { ...model.defaults },
    source: model.source,
    capabilities: {
      reasoning_effort: [...capabilities.reasoning_effort],
      reasoning_effort_options: capabilities.reasoning_effort_options.map(projectPublicReasoningOption),
      response_speed: [...capabilities.response_speed],
      service_tiers: capabilities.service_tiers.map(projectPublicServiceTierOption),
      thinking: capabilities.thinking,
      metadata_status: { ...capabilities.metadata_status },
      fast_mode: capabilities.fast_mode,
      ultra_lossy: capabilities.ultra_lossy,
      ...(capabilities.ultra_mapped_effort ? { ultra_mapped_effort: capabilities.ultra_mapped_effort } : {}),
    },
    ...(model.discovered ? { discovered: projectPublicDiscoveredModel(model.discovered) } : {}),
    status: model.status,
    effective_defaults: { ...model.effective_defaults },
    configuration_issues: [...model.configuration_issues],
    token_counting_mode: 'heuristic',
    capability_projection: {
      reasoning_effort: [...capabilities.reasoning_effort],
      response_speed: [...capabilities.response_speed],
      thinking: capabilities.thinking,
      metadata_status: { ...capabilities.metadata_status },
      fast_mode: capabilities.fast_mode,
      ultra_lossy: capabilities.ultra_lossy,
    },
  };
}

function projectPublicDiscoveredModel(discovered: NonNullable<RuntimeModel['discovered']>): PublicDiscoveredModel {
  return {
    id: discovered.id,
    ...(discovered.displayName ? { displayName: discovered.displayName } : {}),
    ...(discovered.controls ? { controls: projectPublicControls(discovered.controls) } : {}),
  };
}

function projectPublicControls(controls: ChatGptModelControlCapabilities): PublicDiscoveredModel['controls'] {
  return {
    reasoning: {
      metadataKnown: controls.reasoning.metadataKnown,
      supported: controls.reasoning.supported.map(projectPublicReasoningOption),
      ...(controls.reasoning.defaultEffort ? { defaultEffort: controls.reasoning.defaultEffort } : {}),
    },
    serviceTier: {
      metadataKnown: controls.serviceTier.metadataKnown,
      supported: controls.serviceTier.supported.map(projectPublicServiceTierOption),
      ...(controls.serviceTier.defaultTier ? { defaultTier: controls.serviceTier.defaultTier } : {}),
      fastMode: controls.serviceTier.fastMode,
    },
  };
}

function projectPublicReasoningOption(option: ChatGptReasoningLevelOption): ChatGptReasoningLevelOption {
  return {
    effort: option.effort,
    ...(option.description ? { description: option.description } : {}),
  };
}

function projectPublicServiceTierOption(option: ChatGptServiceTierOption): ChatGptServiceTierOption {
  return {
    id: option.id,
    ...(option.name ? { name: option.name } : {}),
    ...(option.description ? { description: option.description } : {}),
  };
}
