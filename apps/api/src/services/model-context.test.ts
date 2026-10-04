import { describe, expect, it } from 'vitest';
import type { ChatGptDiscoveredModel } from '@chatgpt-to-claude/chatgpt-backend';
import { ModelRegistry } from './model-registry.js';
import { modelContextView } from './model-context.js';
import { createModelsRoute, projectPublicModel } from '../routes/models.js';

const identity = (id: string) => ({ accountId: id, createdAt: '2026-10-04T00:00:00.000Z' });
const catalogContext = { contextWindow: 270_000, maxContextWindow: 1_050_000, effectiveContextWindowPercent: 95, autoCompactTokenLimit: 250_000 };
const view = { metadata_status: 'known', context_window: 270_000, max_context_window: 1_050_000, effective_context_window_percent: 95, auto_compact_token_limit: 250_000 };
function registry() {
  return new ModelRegistry({ defaults: { aliases: [{ id: 'alias', backendModel: 'model', display_name: 'Alias', enabled: true }] } });
}

describe('context metadata catalog aggregation and projection', () => {
  it('projects the selected target catalog into aliases, public models and account-specific resolutions', async () => {
    const models = registry();
    models.replaceAccountModels(identity('a'), [{ id: 'model', context: catalogContext }]);
    expect(models.get('alias')?.context).toEqual(view);
    expect(models.resolveForAccount('alias', identity('a')).model.context).toEqual(view);
    const response = await createModelsRoute({ modelRegistry: models }).request('/v1/models');
    const body = await response.json() as { data: Array<{ context: unknown }> };
    expect(body.data).toHaveLength(2);
    expect(body.data.every((model) => JSON.stringify(model.context) === JSON.stringify(view))).toBe(true);
  });

  it('keeps unbound and absent catalogs unknown without a model-name default', () => {
    const models = registry();
    expect(models.get('alias')?.context).toEqual({ metadata_status: 'unknown' });
    models.replaceDiscoveredModels([{ id: 'gpt-6-astra' }]);
    expect(models.get('gpt-6-astra')?.context).toEqual({ metadata_status: 'unknown' });
    expect(modelContextView({ maxContextWindow: 1_050_000 })).toEqual({ metadata_status: 'known', max_context_window: 1_050_000 });
  });

  it.each(['contextWindow', 'maxContextWindow', 'effectiveContextWindowPercent', 'autoCompactTokenLimit'] as const)('omits only conflicting %s values and keeps account-specific truth', (field) => {
    const models = registry();
    const different = { ...catalogContext, [field]: field === 'effectiveContextWindowPercent' ? 90 : catalogContext[field] - 1 };
    models.replaceAccountModels(identity('a'), [{ id: 'model', context: catalogContext }]);
    models.replaceAccountModels(identity('b'), [{ id: 'model', context: different }]);
    const expected = { ...view, metadata_status: 'account_dependent' } as Record<string, unknown>;
    delete expected[{ contextWindow: 'context_window', maxContextWindow: 'max_context_window', effectiveContextWindowPercent: 'effective_context_window_percent', autoCompactTokenLimit: 'auto_compact_token_limit' }[field]];
    expect(models.get('alias')?.context).toEqual(expected);
    expect(models.resolveForAccount('model', identity('a')).target.context).toEqual(catalogContext);
    expect(models.resolveForAccount('model', identity('b')).target.context).toEqual(different);
    models.setAccountActive(identity('b'), false);
    expect(models.get('alias')?.context).toEqual(view);
  });

  it('does not advertise a known account window across another account with unknown limits', () => {
    const models = registry();
    models.replaceAccountModels(identity('a'), [{ id: 'model', context: catalogContext }]);
    models.replaceAccountModels(identity('b'), [{ id: 'model' }]);
    expect(models.get('model')?.context).toEqual({ metadata_status: 'account_dependent' });
    models.replaceAccountModels(identity('a'), [{ id: 'model' }]);
    expect(models.get('model')?.context).toEqual({ metadata_status: 'unknown' });
  });

  it('retains equal values across accounts and follows alias target changes', () => {
    const models = registry();
    for (const id of ['a', 'b']) models.replaceAccountModels(identity(id), [{ id: 'model', context: catalogContext }, { id: 'other', context: { contextWindow: 64_000 } }]);
    expect(models.get('alias')?.context).toEqual(view);
    models.update('alias', { backendModel: 'other' });
    expect(models.get('alias')?.context).toEqual({ metadata_status: 'known', context_window: 64_000 });
  });

  it('deep copies context at catalog, snapshot and public projection boundaries with an exact whitelist', () => {
    const models = registry();
    const source: ChatGptDiscoveredModel = { id: 'model', context: { ...catalogContext } };
    models.replaceAccountModels(identity('a'), [source]);
    source.context!.contextWindow = 1;
    models.snapshot().accountCatalogs[0].models[0].context!.contextWindow = 2;
    const runtime = models.get('model')!;
    Object.assign(runtime.context, { secret: 'CONTEXT_PRIVATE_CANARY' });
    const projected = projectPublicModel(runtime);
    expect(projected.context).toEqual(view);
    expect(projected.context).not.toBe(runtime.context);
    projected.context.context_window = 3;
    runtime.discovered!.context!.contextWindow = 4;
    expect(models.get('model')?.context).toEqual(view);
    expect(JSON.stringify(projected)).not.toContain('CONTEXT_PRIVATE_CANARY');
  });
});
