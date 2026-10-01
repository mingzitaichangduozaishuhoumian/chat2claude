import { describe, expect, it } from 'vitest';
import type { ChatGptDiscoveredModel, ChatGptModelControlCapabilities } from '@chatgpt-to-claude/chatgpt-backend';
import { ModelRegistry } from './model-registry.js';

type MultiAgentMetadata = Pick<ChatGptModelControlCapabilities['reasoning'], 'multiAgentVersion' | 'multiAgentReasoningEffort'>;
const accountA = { accountId: 'account-a', createdAt: '2026-10-01T00:00:00.000Z' };
const accountB = { accountId: 'account-b', createdAt: '2026-10-01T00:00:00.000Z' };

function model(metadata: MultiAgentMetadata): ChatGptDiscoveredModel {
  return { id: 'catalog-model', controls: {
    reasoning: { metadataKnown: true, supported: [{ effort: 'xhigh' }], ...metadata },
    serviceTier: { metadataKnown: false, supported: [], fastMode: false },
  } };
}

function mergedMetadata(first: MultiAgentMetadata, second: MultiAgentMetadata) {
  const registry = new ModelRegistry({ defaults: [] });
  registry.replaceAccountModels(accountA, [model(first)]);
  registry.replaceAccountModels(accountB, [model(second)]);
  const reasoning = registry.resolve('catalog-model').target.controls!.reasoning;
  return { registry, reasoning };
}

describe('ModelRegistry multi-agent catalog metadata aggregation', () => {
  it('reports account-dependent Ultra effort instead of guessing from the union catalog', () => {
    const registry = new ModelRegistry({ defaults: [] });
    const first = model({ multiAgentReasoningEffort: 'xhigh' });
    first.controls!.reasoning.supported = [{ effort: 'xhigh' }, { effort: 'ultra' }];
    first.controls!.reasoning.defaultEffort = 'ultra';
    const second = model({ multiAgentReasoningEffort: 'high' });
    second.controls!.reasoning.supported = [{ effort: 'high' }, { effort: 'ultra' }];
    second.controls!.reasoning.defaultEffort = 'ultra';
    registry.replaceAccountModels(accountA, [first]);
    registry.replaceAccountModels(accountB, [second]);
    const view = registry.get('catalog-model')!;
    expect(view.capabilities.ultra_execution).toEqual({ delegation: 'caller_tools', account_dependent: true });
    expect(view.effective_defaults).toMatchObject({ reasoning_effort: 'ultra', reasoning_account_dependent: true, delegation: 'caller_tools' });
    expect(view.effective_defaults).not.toHaveProperty('upstream_reasoning_effort');
    const requirements = registry.accountControlRequirements(registry.resolve('catalog-model'), { reasoningEffort: 'ultra' });
    expect(registry.resolveControls(registry.resolveForAccount('catalog-model', accountA), requirements).reasoningExecution?.effort).toBe('xhigh');
    expect(registry.resolveControls(registry.resolveForAccount('catalog-model', accountB), requirements).reasoningExecution?.effort).toBe('high');
    registry.setAccountActive(accountB, false);
    expect(registry.get('catalog-model')!.capabilities.ultra_execution).toEqual({ reasoning_effort: 'xhigh', delegation: 'caller_tools' });
  });

  it('does not use a stronger effort from an account that cannot execute Ultra in its public view', () => {
    const registry = new ModelRegistry({ defaults: [] });
    const first = model({});
    first.controls!.reasoning.supported = [{ effort: 'xhigh' }, { effort: 'ultra' }];
    const second = model({});
    second.controls!.reasoning.supported = [{ effort: 'max' }];
    registry.replaceAccountModels(accountA, [first]);
    registry.replaceAccountModels(accountB, [second]);
    expect(registry.get('catalog-model')!.capabilities.ultra_execution).toEqual({ reasoning_effort: 'xhigh', delegation: 'caller_tools' });
  });

  it('preserves the unique advertised protocol version and exact provider effort', () => {
    const metadata = { multiAgentVersion: 'v2' as const, multiAgentReasoningEffort: 'Future_Deep' };
    const { registry, reasoning } = mergedMetadata(metadata, metadata);
    expect(reasoning).toMatchObject(metadata);
    registry.importState(registry.exportState());
    expect(registry.resolve('catalog-model').target.controls!.reasoning).toMatchObject(metadata);
  });

  it('retains known values without assigning them to an account with missing metadata', () => {
    const metadata = { multiAgentVersion: 'v2' as const, multiAgentReasoningEffort: 'xhigh' };
    const { registry, reasoning } = mergedMetadata({}, metadata);
    expect(reasoning).toMatchObject(metadata);
    const accountReasoning = registry.resolveForAccount('catalog-model', accountA).target.controls!.reasoning;
    expect(accountReasoning).not.toHaveProperty('multiAgentVersion');
    expect(accountReasoning).not.toHaveProperty('multiAgentReasoningEffort');
  });

  it.each([
    { first: { multiAgentVersion: 'v1' as const, multiAgentReasoningEffort: 'xhigh' }, second: { multiAgentVersion: 'v2' as const, multiAgentReasoningEffort: 'xhigh' }, version: undefined, effort: 'xhigh' },
    { first: { multiAgentVersion: 'v2' as const, multiAgentReasoningEffort: 'xhigh' }, second: { multiAgentVersion: 'v2' as const, multiAgentReasoningEffort: 'max' }, version: 'v2', effort: undefined },
    { first: { multiAgentVersion: 'v1' as const, multiAgentReasoningEffort: 'Future_Deep' }, second: { multiAgentVersion: 'v2' as const, multiAgentReasoningEffort: 'future_deep' }, version: undefined, effort: undefined },
  ])('omits conflicting fields independently ($version, $effort)', ({ first, second, version, effort }) => {
    const { registry, reasoning } = mergedMetadata(first, second);
    expect(reasoning.multiAgentVersion).toBe(version);
    expect(reasoning.multiAgentReasoningEffort).toBe(effort);
    if (version === undefined) expect(reasoning).not.toHaveProperty('multiAgentVersion');
    if (effort === undefined) expect(reasoning).not.toHaveProperty('multiAgentReasoningEffort');
    expect(registry.resolveForAccount('catalog-model', accountA).target.controls!.reasoning).toMatchObject(first);
    expect(registry.resolveForAccount('catalog-model', accountB).target.controls!.reasoning).toMatchObject(second);
    registry.setAccountActive(accountA, false);
    expect(registry.resolve('catalog-model').target.controls!.reasoning).toMatchObject(second);
  });

  it('does not infer a multi-agent effort merely from version v2', () => {
    const { reasoning } = mergedMetadata({ multiAgentVersion: 'v2' }, { multiAgentVersion: 'v2' });
    expect(reasoning.multiAgentVersion).toBe('v2');
    expect(reasoning).not.toHaveProperty('multiAgentReasoningEffort');
  });
});
