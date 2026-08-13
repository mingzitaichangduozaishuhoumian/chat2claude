import { Hono } from 'hono';
import type { ModelRegistry } from '../services/model-registry.js';
export interface ModelsRouteOptions { modelRegistry: ModelRegistry; ready?: Promise<unknown>; }
export function createModelsRoute(options: ModelsRouteOptions): Hono {
  return new Hono().get('/v1/models', async (c) => {
    if (options.ready) await options.ready;
    return c.json({ data: options.modelRegistry.list().filter((model) => model.enabled && model.status !== 'unbound' && model.status !== 'stale') });
  });
}
