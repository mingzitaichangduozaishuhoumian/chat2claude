import {
  normalizeReasoningEffort,
  normalizeSpeedPreference,
  type ReasoningEffort,
  type SpeedPreference,
} from '@chatgpt-to-claude/protocol-mapper';

export interface ModelCapabilities {
  reasoning_effort: ReasoningEffort[];
  response_speed: SpeedPreference[];
  thinking: boolean;
}

export interface ModelDefaults {
  reasoning_effort: ReasoningEffort;
  speed: SpeedPreference;
}

export interface RuntimeModel {
  id: string;
  type: 'model';
  display_name: string;
  claudeModel: string;
  backendModel: string;
  enabled: boolean;
  capabilities: ModelCapabilities;
  defaults: ModelDefaults;
}

export interface ModelPatch {
  claudeModel?: unknown;
  backendModel?: unknown;
  enabled?: unknown;
  defaults?: {
    reasoning_effort?: unknown;
    speed?: unknown;
  };
}

const REASONING_EFFORTS: ReasoningEffort[] = ['off', 'minimal', 'low', 'medium', 'high', 'max'];
const RESPONSE_SPEEDS: SpeedPreference[] = ['fastest', 'fast', 'balanced', 'quality'];

const DEFAULT_MODELS: RuntimeModel[] = [
  createDefaultModel('haiku', 'Claude Haiku', 'claude-3-5-haiku-latest', 'gpt-4o-mini', 'low', 'fast'),
  createDefaultModel('sonnet', 'Claude Sonnet', 'claude-3-5-sonnet-latest', 'gpt-4o', 'medium', 'balanced'),
  createDefaultModel('opus', 'Claude Opus', 'claude-3-opus-latest', 'gpt-4.1', 'high', 'quality'),
];

export class ModelRegistry {
  private models = cloneModels(DEFAULT_MODELS);

  list(): RuntimeModel[] {
    return cloneModels(this.models);
  }

  get(id: string): RuntimeModel | undefined {
    const model = this.models.find((item) => item.id === id);
    return model ? cloneModel(model) : undefined;
  }

  update(id: string, patch: ModelPatch): RuntimeModel | undefined {
    const index = this.models.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    const current = this.models[index];
    const next: RuntimeModel = {
      ...current,
      claudeModel: typeof patch.claudeModel === 'string' && patch.claudeModel.trim() ? patch.claudeModel.trim() : current.claudeModel,
      backendModel: typeof patch.backendModel === 'string' && patch.backendModel.trim() ? patch.backendModel.trim() : current.backendModel,
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      defaults: {
        reasoning_effort: normalizeReasoningEffort(patch.defaults?.reasoning_effort, current.defaults.reasoning_effort),
        speed: normalizeSpeedPreference(patch.defaults?.speed, current.defaults.speed),
      },
    };
    this.models[index] = next;
    return cloneModel(next);
  }

  reset(): RuntimeModel[] {
    this.models = cloneModels(DEFAULT_MODELS);
    return this.list();
  }

  reasoningSpeedDefaultsFor(modelId: string): { reasoningEffort?: ReasoningEffort; speedPreference?: SpeedPreference } | undefined {
    const model = this.models.find((item) => item.id === modelId && item.enabled);
    if (!model) return undefined;
    return { reasoningEffort: model.defaults.reasoning_effort, speedPreference: model.defaults.speed };
  }
}

function createDefaultModel(
  id: string,
  displayName: string,
  claudeModel: string,
  backendModel: string,
  reasoningEffort: ReasoningEffort,
  speed: SpeedPreference,
): RuntimeModel {
  return {
    id,
    type: 'model',
    display_name: `${displayName} (mock)`,
    claudeModel,
    backendModel,
    enabled: true,
    capabilities: { reasoning_effort: REASONING_EFFORTS, response_speed: RESPONSE_SPEEDS, thinking: true },
    defaults: { reasoning_effort: reasoningEffort, speed },
  };
}

function cloneModels(models: RuntimeModel[]): RuntimeModel[] {
  return models.map(cloneModel);
}

function cloneModel(model: RuntimeModel): RuntimeModel {
  return {
    ...model,
    capabilities: {
      reasoning_effort: [...model.capabilities.reasoning_effort],
      response_speed: [...model.capabilities.response_speed],
      thinking: model.capabilities.thinking,
    },
    defaults: { ...model.defaults },
  };
}
