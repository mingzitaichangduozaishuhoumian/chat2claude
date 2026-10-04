/** Optional legacy catalog hints. Versioned Ultra metadata is normalized separately. */
export interface ChatGptMultiAgentMetadata {
  effort?: string;
  reasoning_effort?: string;
  reasoningEffort?: string;
  default_reasoning_level?: string;
  defaultReasoningLevel?: string;
  supported_reasoning_levels?: Array<string | { effort: string }>;
  supportedReasoningLevels?: Array<string | { effort: string }>;
}

/** Normalize untrusted optional hints without rejecting the discovered model.
 * Keep only understood fields; provider flags and extension values remain raw
 * metadata, never persisted controls or inferred reasoning capabilities.
 */
export function normalizeMultiAgentMetadata(value: unknown): ChatGptMultiAgentMetadata | undefined {
  if (!isObject(value)) return undefined;
  const result: ChatGptMultiAgentMetadata = {};
  for (const key of ['effort', 'reasoning_effort', 'reasoningEffort', 'default_reasoning_level', 'defaultReasoningLevel'] as const) {
    if (!Object.hasOwn(value, key)) continue;
    const effort = nonempty(value[key]);
    if (effort !== undefined) result[key] = effort;
  }
  for (const key of ['supported_reasoning_levels', 'supportedReasoningLevels'] as const) {
    if (!Object.hasOwn(value, key) || !Array.isArray(value[key])) continue;
    result[key] = value[key].flatMap((item): Array<string | { effort: string }> => {
      if (typeof item === 'string') {
        const effort = nonempty(item);
        return effort === undefined ? [] : [effort];
      }
      const effort = isObject(item) && Object.hasOwn(item, 'effort') ? nonempty(item.effort) : undefined;
      return effort === undefined ? [] : [{ effort }];
    });
  }
  return Object.keys(result).length ? result : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
