import { describe, expect, it } from 'vitest';
import { normalizeMultiAgentMetadata, SessionChatGptBackend } from './index.js';

const context = { account: { id: 'synthetic-account', secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic-token' } } };
async function discover(raw: unknown) {
  const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid', fetch: async () => Response.json({ models: [raw] }) });
  return backend.discoverModels(context);
}

describe('model discovery compatibility metadata', () => {
  it('uses the 0.160.0 catalog query and matching default client identity', async () => {
    let url = '';
    let headers = new Headers();
    const backend = new SessionChatGptBackend({ baseUrl: 'https://synthetic.invalid/backend-api/', fetch: async (input, init) => {
      url = String(input);
      headers = new Headers(init?.headers);
      return Response.json({ models: [{ slug: 'gpt-6.1-sol' }] });
    } });
    const result = await backend.discoverModels(context);
    expect(url).toBe('https://synthetic.invalid/backend-api/codex/models?client_version=0.160.0');
    expect(headers.get('user-agent')).toBe('codex_cli_rs/0.160.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9');
    expect(headers.get('originator')).toBe('codex_cli_rs');
    expect(headers.get('accept')).toBe('application/json');
    expect(result).toMatchObject({ status: 'success', models: [{ id: 'gpt-6.1-sol' }], diagnostic: { clientVersion: '0.160.0', candidateCount: 1, acceptedCount: 1, rejectedCount: 0 } });
  });

  it.each([null, true, false, 1, 'ultra', [], {}, { effort: 1 }, { extension: 'private' }])('omits unsupported optional multi-agent shapes without treating them as capabilities: %j', async (value) => {
    expect(normalizeMultiAgentMetadata(value)).toBeUndefined();
    const raw = { slug: 'synthetic-model', multi_agent_reasoning: value };
    const result = await discover(raw);
    expect(result).toMatchObject({ status: 'success', diagnostic: { candidateCount: 1, acceptedCount: 1, rejectedCount: 0 } });
    expect(result.models[0].controls?.reasoning).toEqual({ metadataKnown: false, supported: [], defaultEffort: undefined });
    expect(result.models[0].raw).toEqual(raw);
  });

  it('copies only supported hint fields and preserves effort spelling while ignoring malformed values', () => {
    expect(normalizeMultiAgentMetadata({
      effort: ' Future_Deep ', reasoning_effort: ' max ', reasoningEffort: ' xhigh ',
      default_reasoning_level: ' high ', defaultReasoningLevel: ' low ',
      supported_reasoning_levels: [' ultra ', { effort: ' Future_Deep ', extension: 'private' }, null, true, '', { effort: 1 }, []],
      supportedReasoningLevels: [' max '], unknown: 'PRIVATE_OPTIONAL_METADATA',
    })).toEqual({
      effort: 'Future_Deep', reasoning_effort: 'max', reasoningEffort: 'xhigh',
      default_reasoning_level: 'high', defaultReasoningLevel: 'low',
      supported_reasoning_levels: ['ultra', { effort: 'Future_Deep' }], supportedReasoningLevels: ['max'],
    });
    expect(normalizeMultiAgentMetadata({ effort: 1, reasoning_effort: null, supported_reasoning_levels: {}, supportedReasoningLevels: [] })).toEqual({ supportedReasoningLevels: [] });
  });

  it('detaches optional array and object hints from provider data', () => {
    const raw = { supported_reasoning_levels: [{ effort: 'ultra' }] };
    const normalized = normalizeMultiAgentMetadata(raw)!;
    expect(normalized.supported_reasoning_levels).not.toBe(raw.supported_reasoning_levels);
    expect(normalized.supported_reasoning_levels![0]).not.toBe(raw.supported_reasoning_levels[0]);
    raw.supported_reasoning_levels[0].effort = 'changed';
    expect(normalized).toEqual({ supported_reasoning_levels: [{ effort: 'ultra' }] });
  });

  it.each(['multi_agent_reasoning', 'multiAgentReasoning', 'multi_agent', 'multiAgent'])('normalizes the %s catalog spelling without changing explicit Ultra metadata', async (key) => {
    const raw = { slug: 'synthetic-model', supported_reasoning_levels: ['ultra'], multi_agent_version: 'v2', multi_agent_reasoning_effort: 'xhigh', capabilities: { [key]: { effort: ' max ', unknown: 'PRIVATE_OPTIONAL_METADATA' } } };
    const result = await discover(raw);
    expect(result.models[0].controls?.reasoning).toEqual({
      metadataKnown: true, supported: [{ effort: 'ultra' }], defaultEffort: undefined,
      multiAgent: { effort: 'max' }, multiAgentVersion: 'v2', multiAgentReasoningEffort: 'xhigh',
    });
    expect(JSON.stringify(result.models[0].controls)).not.toContain('PRIVATE_OPTIONAL_METADATA');
    expect(result.models[0].raw).toEqual(raw);
  });

  it('keeps explicit Ultra capabilities when the optional legacy hint is a boolean', async () => {
    const result = await discover({ slug: 'synthetic-model', supported_reasoning_levels: ['ultra'], multi_agent_version: 'v2', multi_agent_reasoning_effort: 'xhigh', multi_agent_reasoning: true });
    expect(result.models[0].controls?.reasoning).toEqual({ metadataKnown: true, supported: [{ effort: 'ultra' }], defaultEffort: undefined, multiAgentVersion: 'v2', multiAgentReasoningEffort: 'xhigh' });
  });
});
