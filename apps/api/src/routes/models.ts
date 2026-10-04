import { Hono } from 'hono';
import { projectModelContext, type ModelContextView } from '../services/model-context.js';
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
      multiAgentVersion?: 'v1' | 'v2';
      multiAgentReasoningEffort?: string;
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
  context: ModelContextView;
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
  capability_projection: Pick<ModelCapabilities, 'reasoning_effort' | 'response_speed' | 'thinking' | 'metadata_status' | 'fast_mode' | 'ultra_lossy' | 'ultra_execution'>;
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

export function projectPublicModel(model: RuntimeModel): PublicModel {
  const { capabilities } = model;
  return {
    id: model.id,
    type: model.type,
    display_name: model.display_name,
    builtIn: model.builtIn,
    enabled: model.enabled,
    defaults: { reasoning_effort: model.defaults.reasoning_effort, speed: model.defaults.speed },
    source: model.source,
    context: projectModelContext(model.context),
    capabilities: {
      reasoning_effort: [...capabilities.reasoning_effort],
      reasoning_effort_options: capabilities.reasoning_effort_options.map(projectPublicReasoningOption),
      response_speed: [...capabilities.response_speed],
      service_tiers: capabilities.service_tiers.map(projectPublicServiceTierOption),
      thinking: capabilities.thinking,
      metadata_status: { reasoning: capabilities.metadata_status.reasoning, service_tier: capabilities.metadata_status.service_tier },
      fast_mode: capabilities.fast_mode,
      ultra_lossy: capabilities.ultra_lossy,
      ...(capabilities.ultra_mapped_effort ? { ultra_mapped_effort: capabilities.ultra_mapped_effort } : {}),
      ...(capabilities.ultra_execution ? { ultra_execution: projectPublicUltraExecution(capabilities.ultra_execution) } : {}),
    },
    ...(model.discovered ? { discovered: projectPublicDiscoveredModel(model.discovered) } : {}),
    status: model.status,
    effective_defaults: {
      ...(model.effective_defaults.reasoning_effort ? { reasoning_effort: model.effective_defaults.reasoning_effort } : {}),
      ...(model.effective_defaults.upstream_reasoning_effort ? { upstream_reasoning_effort: model.effective_defaults.upstream_reasoning_effort } : {}),
      ...(model.effective_defaults.reasoning_account_dependent === true ? { reasoning_account_dependent: true as const } : {}),
      ...(model.effective_defaults.delegation ? { delegation: model.effective_defaults.delegation } : {}),
      ...(model.effective_defaults.service_tier ? { service_tier: model.effective_defaults.service_tier } : {}),
      reasoning_source: model.effective_defaults.reasoning_source,
      service_tier_source: model.effective_defaults.service_tier_source,
    },
    configuration_issues: [...model.configuration_issues],
    token_counting_mode: 'heuristic',
    capability_projection: {
      reasoning_effort: [...capabilities.reasoning_effort],
      response_speed: [...capabilities.response_speed],
      thinking: capabilities.thinking,
      metadata_status: { reasoning: capabilities.metadata_status.reasoning, service_tier: capabilities.metadata_status.service_tier },
      fast_mode: capabilities.fast_mode,
      ultra_lossy: capabilities.ultra_lossy,
      ...(capabilities.ultra_execution ? { ultra_execution: projectPublicUltraExecution(capabilities.ultra_execution) } : {}),
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
      ...(controls.reasoning.multiAgentVersion ? { multiAgentVersion: controls.reasoning.multiAgentVersion } : {}),
      ...(controls.reasoning.multiAgentReasoningEffort ? { multiAgentReasoningEffort: controls.reasoning.multiAgentReasoningEffort } : {}),
    },
    serviceTier: {
      metadataKnown: controls.serviceTier.metadataKnown,
      supported: controls.serviceTier.supported.map(projectPublicServiceTierOption),
      ...(controls.serviceTier.defaultTier ? { defaultTier: controls.serviceTier.defaultTier } : {}),
      fastMode: controls.serviceTier.fastMode,
    },
  };
}

function projectPublicUltraExecution(execution: NonNullable<ModelCapabilities['ultra_execution']>): NonNullable<ModelCapabilities['ultra_execution']> {
  return {
    ...(execution.reasoning_effort ? { reasoning_effort: execution.reasoning_effort } : {}),
    delegation: execution.delegation,
    ...(execution.account_dependent === true ? { account_dependent: true as const } : {}),
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
