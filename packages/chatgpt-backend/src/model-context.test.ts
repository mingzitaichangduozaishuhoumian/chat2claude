import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend, normalizeModelContext } from './index.js';

const context = { account: { id: 'synthetic', secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic' } } };
async function discover(model: unknown) {
  const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', fetch: async () => Response.json({ models: [model] }) });
  return (await backend.listModels(context))[0];
}

describe('provider context window catalog metadata', () => {
  it('preserves explicit window values independently without inferring an effective limit', async () => {
    const model = await discover({ slug: 'provider-model', context_window: 270_000, max_context_window: 1_050_000, effective_context_window_percent: 95, auto_compact_token_limit: 250_000, other: 'private' });
    expect(model.context).toEqual({ contextWindow: 270_000, maxContextWindow: 1_050_000, effectiveContextWindowPercent: 95, autoCompactTokenLimit: 250_000 });
    expect(model.context).not.toHaveProperty('effectiveContextWindow');
    expect(JSON.stringify(model.context)).not.toContain('private');
  });

  it('recognizes catalog capability/camelCase variants and gives explicit root fields priority', async () => {
    const model = await discover({ id: 'provider-model', context_window: 160_000, capabilities: { contextWindow: 96_000, maxContextWindow: 800_000, effectiveContextWindowPercent: 90, autoCompactTokenLimit: 145_000 } });
    expect(model.context).toEqual({ contextWindow: 160_000, maxContextWindow: 800_000, effectiveContextWindowPercent: 90, autoCompactTokenLimit: 145_000 });
  });

  it.each(['gpt-6-astra', { id: 'gpt-6-terra' }, { id: 'future', context_window: null }, { id: 'future', max_context_window: '1000000' }])('keeps unadvertised context unknown: %j', async (raw) => {
    expect(await discover(raw)).not.toHaveProperty('context');
  });

  it.each([0, -1, 1.5, '123', Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, null, true, {}])('rejects malformed window values without coercion: %j', (value) => {
    expect(normalizeModelContext({ contextWindow: value, maxContextWindow: value, autoCompactTokenLimit: value })).toBeUndefined();
  });

  it.each([0, 101, 99.5, '95'])('does not accept an invalid effective window percentage: %j', (value) => {
    expect(normalizeModelContext({ contextWindow: 123_456, effectiveContextWindowPercent: value })).toEqual({ contextWindow: 123_456 });
  });

  it('does not replace a malformed explicit root value with another catalog source', async () => {
    expect((await discover({ id: 'provider-model', context_window: 0, capabilities: { context_window: 100_000 }, max_context_window: 500_000 })).context)
      .toEqual({ maxContextWindow: 500_000 });
  });
});
