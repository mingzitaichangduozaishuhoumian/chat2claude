import type { ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';

export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max';
export type SpeedPreference = 'fastest' | 'fast' | 'balanced' | 'quality';

export interface ModelReasoningSpeedDefaults {
  reasoningEffort?: ReasoningEffort | string;
  speedPreference?: SpeedPreference | string;
}

export interface ReasoningSpeedDefaults {
  globalReasoningEffort?: ReasoningEffort | string;
  globalSpeedPreference?: SpeedPreference | string;
  modelDefaults?: Record<string, ModelReasoningSpeedDefaults | undefined>;
}

export interface ResolvedReasoningSpeed {
  reasoningEffort: ReasoningEffort;
  speedPreference: SpeedPreference;
}

export interface ReasoningConfig { enabled: boolean; budgetTokens?: number; effort: ReasoningEffort; }

const REASONING_EFFORTS = new Set<ReasoningEffort>(['off', 'minimal', 'low', 'medium', 'high', 'max']);
const SPEED_PREFERENCES = new Set<SpeedPreference>(['fastest', 'fast', 'balanced', 'quality']);
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'off';
export const DEFAULT_SPEED_PREFERENCE: SpeedPreference = 'balanced';

export function resolveReasoningSpeed(request: ClaudeMessagesRequest, defaults: ReasoningSpeedDefaults = {}): ResolvedReasoningSpeed {
  const modelDefaults = defaults.modelDefaults?.[request.model];
  return {
    reasoningEffort: normalizeReasoningEffort(
      request.output_config?.effort ?? request.reasoning_effort ?? modelDefaults?.reasoningEffort ?? defaults.globalReasoningEffort
    ),
    speedPreference: normalizeSpeedPreference(request.speed ?? request.response_speed ?? modelDefaults?.speedPreference ?? defaults.globalSpeedPreference),
  };
}

export function normalizeReasoningEffort(value: unknown, fallback: ReasoningEffort = DEFAULT_REASONING_EFFORT): ReasoningEffort {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-') === 'none' ? 'off' : value.trim().toLowerCase();
  return REASONING_EFFORTS.has(normalized as ReasoningEffort) ? normalized as ReasoningEffort : fallback;
}

export function normalizeSpeedPreference(value: unknown, fallback: SpeedPreference = DEFAULT_SPEED_PREFERENCE): SpeedPreference {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  return SPEED_PREFERENCES.has(normalized as SpeedPreference) ? normalized as SpeedPreference : fallback;
}

export function getReasoningConfig(request?: ClaudeMessagesRequest, defaults: ReasoningSpeedDefaults = {}): ReasoningConfig {
  const effort = request ? resolveReasoningSpeed(request, defaults).reasoningEffort : normalizeReasoningEffort(defaults.globalReasoningEffort);
  return { enabled: effort !== 'off', effort };
}
