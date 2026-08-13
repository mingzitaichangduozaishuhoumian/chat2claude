import { Hono } from 'hono';
import type { ModelRegistry } from '../services/model-registry.js';
export interface ModelsRouteOptions { modelRegistry: ModelRegistry; }
export function createModelsRoute(options: ModelsRouteOptions): Hono {
  return new Hono().get('/v1/models', (c) => c.json({ data: options.modelRegistry.list().filter((model) => model.enabled) }));
}
