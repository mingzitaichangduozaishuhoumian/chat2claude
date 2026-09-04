import type { ClaudeMessagesRequest } from '@chatgpt-to-claude/claude-protocol';

export type CanonicalReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | (string & {});
export type ReasoningEffort = CanonicalReasoningEffort | 'ultra';
export type SpeedPreference = 'standard' | 'priority' | (string & {});

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

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'none';
export const DEFAULT_SPEED_PREFERENCE: SpeedPreference = 'standard';

export function resolveReasoningSpeed(request: ClaudeMessagesRequest, defaults: ReasoningSpeedDefaults = {}): ResolvedReasoningSpeed {
  const modelDefaults = defaults.modelDefaults?.[request.model];
  return {
    reasoningEffort: normalizeReasoningEffort(
      request.output_config?.effort ?? request.reasoning_effort ?? modelDefaults?.reasoningEffort ?? defaults.globalReasoningEffort
    ),
    speedPreference: normalizeSpeedPreference(request.service_tier ?? request.speed ?? request.response_speed ?? modelDefaults?.speedPreference ?? defaults.globalSpeedPreference),
  };
}

export function normalizeReasoningEffort(value: unknown, fallback: ReasoningEffort = DEFAULT_REASONING_EFFORT): ReasoningEffort {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'off') return 'none';
  if (normalized === 'light') return 'low';
  if (normalized === 'extra-high') return 'xhigh';
  return normalized as ReasoningEffort;
}

export function normalizeSpeedPreference(value: unknown, fallback: SpeedPreference = DEFAULT_SPEED_PREFERENCE): SpeedPreference {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'fast' || normalized === 'fastest') return 'priority';
  if (normalized === 'balanced' || normalized === 'quality' || normalized === 'default' || normalized === 'standard-only') return 'standard';
  return normalized as SpeedPreference;
}

export function getReasoningConfig(request?: ClaudeMessagesRequest, defaults: ReasoningSpeedDefaults = {}): ReasoningConfig {
  const effort = request ? resolveReasoningSpeed(request, defaults).reasoningEffort : normalizeReasoningEffort(defaults.globalReasoningEffort);
  return { enabled: effort !== 'none', effort };
}
