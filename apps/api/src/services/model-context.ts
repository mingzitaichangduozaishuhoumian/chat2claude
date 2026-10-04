import { normalizeModelContext, type ChatGptModelContextMetadata } from '@chatgpt-to-claude/chatgpt-backend';

export interface ModelContextView {
  metadata_status: 'known' | 'unknown' | 'account_dependent';
  context_window?: number;
  max_context_window?: number;
  effective_context_window_percent?: number;
  auto_compact_token_limit?: number;
}

export function modelContextView(value?: ChatGptModelContextMetadata, accountDependent = false): ModelContextView {
  const context = normalizeModelContext(value);
  return {
    metadata_status: accountDependent ? 'account_dependent' : context ? 'known' : 'unknown',
    ...(context?.contextWindow === undefined ? {} : { context_window: context.contextWindow }),
    ...(context?.maxContextWindow === undefined ? {} : { max_context_window: context.maxContextWindow }),
    ...(context?.effectiveContextWindowPercent === undefined ? {} : { effective_context_window_percent: context.effectiveContextWindowPercent }),
    ...(context?.autoCompactTokenLimit === undefined ? {} : { auto_compact_token_limit: context.autoCompactTokenLimit }),
  };
}

/** Public allowlist also protects callers passing runtime objects with extensions. */
export function projectModelContext(value?: ModelContextView): ModelContextView {
  return modelContextView({
    contextWindow: value?.context_window,
    maxContextWindow: value?.max_context_window,
    effectiveContextWindowPercent: value?.effective_context_window_percent,
    autoCompactTokenLimit: value?.auto_compact_token_limit,
  }, value?.metadata_status === 'account_dependent');
}
