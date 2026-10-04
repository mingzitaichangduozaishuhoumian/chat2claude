import type { ChatGptModelContextMetadata } from './client.js';

export const MODEL_CONTEXT_FIELDS = ['contextWindow', 'maxContextWindow', 'effectiveContextWindowPercent', 'autoCompactTokenLimit'] as const;

/** Detach allowlisted catalog values without coercion or inferred defaults. */
export function normalizeModelContext(value: unknown): ChatGptModelContextMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const context: ChatGptModelContextMetadata = {};
  for (const key of MODEL_CONTEXT_FIELDS) {
    const candidate = raw[key];
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate <= 0) continue;
    if (key === 'effectiveContextWindowPercent' && candidate > 100) continue;
    context[key] = candidate;
  }
  return Object.keys(context).length ? context : undefined;
}
