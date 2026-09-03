import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatGptBackendClient, ChatGptBackendRequestContext, ChatGptDiscoveredModel } from '@chatgpt-to-claude/chatgpt-backend';
import {
  normalizeReasoningEffort,
  normalizeSpeedPreference,
  type ReasoningEffort,
  type SpeedPreference,
} from '@chatgpt-to-claude/protocol-mapper';

export interface ModelCapabilities {
  reasoning_effort: ReasoningEffort[];
  response_speed: SpeedPreference[];
  thinking: boolean;
}

export interface ModelDefaults {
  reasoning_effort: ReasoningEffort;
  speed: SpeedPreference;
}

export interface AliasOverlay {
  id: string;
  type: 'model';
  display_name: string;
  builtIn: boolean;
  enabled: boolean;
  backendModel?: string;
  capabilities: ModelCapabilities;
  defaults: ModelDefaults;
}

export interface RuntimeModel extends AliasOverlay {
  source: 'alias' | 'discovered';
  backendModel?: string;
  discovered?: ChatGptDiscoveredModel;
  status: 'bound' | 'unbound' | 'stale' | 'passthrough';
}

export interface ModelResolution {
  model: RuntimeModel;
  backendModel: string;
}

export interface ModelPatch {
  backendModel?: unknown;
  enabled?: unknown;
  defaults?: {
    reasoning_effort?: unknown;
    speed?: unknown;
  };
  capabilities?: unknown;
}

export interface ModelRegistryOptions {
  defaults?: unknown;
  configPath?: string;
  env?: Pick<NodeJS.ProcessEnv, 'MODEL_REGISTRY_JSON'>;
  discoveredModels?: ChatGptDiscoveredModel[];
}

export interface AdminModelsView {
  aliases: RuntimeModel[];
  discovered: RuntimeModel[];
  combined: RuntimeModel[];
}

export interface PreparedModelProvisioning {
  aliases: AliasOverlay[];
  discoveredModels: ChatGptDiscoveredModel[];
  boundAliases: Record<string, string>;
}

const REASONING_EFFORTS: ReasoningEffort[] = ['off', 'minimal', 'low', 'medium', 'high', 'max'];
const RESPONSE_SPEEDS: SpeedPreference[] = ['fastest', 'fast', 'balanced', 'quality'];

export class ModelRegistry {
  private readonly defaultAliases: AliasOverlay[];
  private aliases: AliasOverlay[];
  private discoveredModels: ChatGptDiscoveredModel[];

  constructor(options: ModelRegistryOptions = {}) {
    this.defaultAliases = loadDefaultAliases(options);
    this.aliases = cloneAliases(this.defaultAliases);
    this.discoveredModels = cloneDiscoveredModels(options.discoveredModels ?? []);
  }

  async refreshFromBackend(backend: ChatGptBackendClient, context?: ChatGptBackendRequestContext): Promise<AdminModelsView> {
    return this.replaceDiscoveredModels(await backend.listModels(context));
  }

  replaceDiscoveredModels(models: ChatGptDiscoveredModel[]): AdminModelsView {
    this.discoveredModels = cloneDiscoveredModels(models);
    return this.adminView();
  }

  prepareProvisioning(models: ChatGptDiscoveredModel[], aliasId: string, backendModel?: string, preserveExistingBinding = false): PreparedModelProvisioning {
    const aliases = cloneAliases(this.aliases);
    const boundAliases: Record<string, string> = {};
    const index = aliases.findIndex((alias) => alias.id === aliasId);
    // Startup discovery chooses a default only for an unbound alias. A persisted
    // or manually selected backend is an explicit user choice and survives refresh.
    if (backendModel && index !== -1 && (!preserveExistingBinding || !aliases[index].backendModel)) {
      aliases[index] = { ...aliases[index], backendModel, enabled: true };
      boundAliases[aliasId] = backendModel;
    }
    return { aliases, discoveredModels: cloneDiscoveredModels(models), boundAliases };
  }

  commitPreparedProvisioning(prepared: PreparedModelProvisioning): void {
    this.aliases = prepared.aliases;
    this.discoveredModels = prepared.discoveredModels;
  }

  list(): RuntimeModel[] {
    const aliases = this.aliases.map((alias) => this.toRuntimeAlias(alias));
    const aliasIds = new Set(this.aliases.map((alias) => alias.id));
    const passthrough = this.discoveredModels
      .filter((model) => !aliasIds.has(model.id))
      .map((model) => discoveredToRuntimeModel(model));
    return [...aliases, ...passthrough].map(cloneRuntimeModel);
  }

  adminView(): AdminModelsView {
    const aliases = this.aliases.map((alias) => this.toRuntimeAlias(alias)).map(cloneRuntimeModel);
    const discovered = this.discoveredModels.map(discoveredToRuntimeModel).map(cloneRuntimeModel);
    return { aliases, discovered, combined: this.list() };
  }

  get(id: string): RuntimeModel | undefined {
    const model = this.list().find((item) => item.id === id);
    return model ? cloneRuntimeModel(model) : undefined;
  }

  resolve(id: string): ModelResolution {
    const alias = this.aliases.find((item) => item.id === id);
    if (alias) {
      if (!alias.enabled) throw new ModelRegistryError(`Model is disabled: ${id}`, 'disabled', 400);
      if (!alias.backendModel) throw new ModelRegistryError(`Model alias is not bound to a backend model: ${id}`, 'unbound', 400);
      const discovered = this.discoveredModels.find((item) => item.id === alias.backendModel);
      if (!discovered) throw new ModelRegistryError(`Model alias ${id} is bound to missing backend model: ${alias.backendModel}`, 'stale', 404);
      return { model: this.toRuntimeAlias(alias), backendModel: alias.backendModel };
    }

    const discovered = this.discoveredModels.find((item) => item.id === id);
    if (discovered) {
      return { model: discoveredToRuntimeModel(discovered), backendModel: discovered.id };
    }

    throw new ModelRegistryError(`Unknown model: ${id}`, 'unknown', 404);
  }

  update(id: string, patch: ModelPatch): RuntimeModel | undefined {
    const index = this.aliases.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    const current = this.aliases[index];
    const next: AliasOverlay = {
      ...current,
      backendModel: readOptionalStringPatch(patch.backendModel, current.backendModel),
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      capabilities: patch.capabilities === undefined ? current.capabilities : normalizeCapabilities(patch.capabilities),
      defaults: {
        reasoning_effort: normalizeReasoningEffort(patch.defaults?.reasoning_effort, current.defaults.reasoning_effort),
        speed: normalizeSpeedPreference(patch.defaults?.speed, current.defaults.speed),
      },
    };
    this.aliases[index] = next;
    return this.toRuntimeAlias(next);
  }

  create(input: unknown): RuntimeModel {
    const alias = normalizeAlias(input, 'custom alias', false);
    if (alias.builtIn) throw new Error('Custom model aliases cannot be created as built-ins.');
    if (this.aliases.some((item) => item.id === alias.id)) throw new Error(`Model alias already exists: ${alias.id}`);
    this.aliases.push(alias);
    return this.toRuntimeAlias(alias);
  }

  remove(id: string): RuntimeModel | undefined {
    const index = this.aliases.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    if (this.aliases[index].builtIn) throw new Error(`Built-in model aliases cannot be deleted: ${id}`);
    const [removed] = this.aliases.splice(index, 1);
    return this.toRuntimeAlias(removed);
  }

  exportState(): AliasOverlay[] {
    return cloneAliases(this.aliases);
  }

  importState(aliases: AliasOverlay[]): boolean {
    const normalized = parseAliasConfig({ aliases }, 'runtime state');
    const defaultIds = new Set(this.defaultAliases.map((alias) => alias.id));
    if (normalized.some((alias) => alias.builtIn !== defaultIds.has(alias.id))) throw new Error('Invalid model alias runtime state: built-in aliases must match the configured registry.');
    const persisted = new Map(normalized.map((alias) => [alias.id, alias]));
    // New built-ins are appended during migration while retaining prior user overrides.
    this.aliases = [
      ...this.defaultAliases.map((alias) => persisted.get(alias.id) ?? alias),
      ...normalized.filter((alias) => !alias.builtIn),
    ];
    return this.defaultAliases.some((alias) => !persisted.has(alias.id));
  }

  snapshot(): AliasOverlay[] {
    return this.exportState();
  }

  restore(snapshot: AliasOverlay[]): void {
    this.aliases = cloneAliases(snapshot);
  }

  reset(): RuntimeModel[] {
    this.aliases = cloneAliases(this.defaultAliases);
    return this.list();
  }

  reasoningSpeedDefaultsFor(modelId: string): { reasoningEffort?: ReasoningEffort; speedPreference?: SpeedPreference } | undefined {
    const model = this.get(modelId);
    if (!model?.enabled) return undefined;
    return { reasoningEffort: model.defaults.reasoning_effort, speedPreference: model.defaults.speed };
  }

  private toRuntimeAlias(alias: AliasOverlay): RuntimeModel {
    const discovered = alias.backendModel ? this.discoveredModels.find((item) => item.id === alias.backendModel) : undefined;
    return {
      ...cloneAlias(alias),
      source: 'alias',
      discovered: discovered ? cloneDiscoveredModel(discovered) : undefined,
      status: !alias.backendModel ? 'unbound' : discovered ? 'bound' : 'stale',
    };
  }
}

export class ModelRegistryError extends Error {
  constructor(message: string, readonly code: 'disabled' | 'unbound' | 'stale' | 'unknown', readonly status: 400 | 404) {
    super(message);
    this.name = 'ModelRegistryError';
  }
}

function loadDefaultAliases(options: ModelRegistryOptions): AliasOverlay[] {
  if (options.defaults !== undefined) return parseAliasConfig(options.defaults, 'injected defaults');

  const env = options.env ?? process.env;
  if (env.MODEL_REGISTRY_JSON?.trim()) {
    return parseAliasConfig(parseJson(env.MODEL_REGISTRY_JSON, 'MODEL_REGISTRY_JSON'), 'MODEL_REGISTRY_JSON');
  }

  const configPath = options.configPath ?? findDefaultConfigPath();
  return parseAliasConfig(parseJson(readFileSync(configPath, 'utf8'), configPath), configPath);
}

function findDefaultConfigPath(): string {
  const candidates = [
    resolve(process.cwd(), 'config/models.json'),
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../../config/models.json'),
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../config/models.json'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Model alias overlay config not found. Expected editable config at ${candidates[0]} or set MODEL_REGISTRY_JSON.`);
  return found;
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid model alias overlay JSON from ${label}: ${detail}`);
  }
}

function parseAliasConfig(value: unknown, label: string): AliasOverlay[] {
  const rawAliases = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { aliases?: unknown }).aliases) ? (value as { aliases: unknown[] }).aliases : undefined;
  if (!rawAliases) throw new Error(`Invalid model alias overlay config from ${label}: expected an array or { "aliases": [...] }.`);

  const aliases = rawAliases.map((item, index) => normalizeAlias(item, `${label} aliases[${index}]`));
  const ids = new Set<string>();
  for (const alias of aliases) {
    if (ids.has(alias.id)) throw new Error(`Invalid model alias overlay config from ${label}: duplicate alias id "${alias.id}".`);
    ids.add(alias.id);
  }
  return aliases;
}

function normalizeAlias(value: unknown, label: string, defaultBuiltIn = true): AliasOverlay {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid model alias overlay config at ${label}: expected an object.`);
  const raw = value as Record<string, unknown>;
  const id = readNonEmptyString(raw.id, `${label}.id`);
  const builtIn = raw.builtIn === undefined ? defaultBuiltIn : raw.builtIn;
  if (typeof builtIn !== 'boolean') throw new Error(`Invalid model alias overlay config at ${label}: builtIn must be a boolean.`);
  const displayName = readOptionalString(raw.display_name ?? raw.displayName) ?? id;
  const backendModel = readOptionalString(raw.backendModel);
  const capabilities = normalizeCapabilities(raw.capabilities);
  const defaults = normalizeDefaults(raw.defaults);
  return {
    id,
    type: 'model',
    display_name: displayName,
    builtIn,
    backendModel,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    capabilities,
    defaults,
  };
}

function normalizeCapabilities(value: unknown): ModelCapabilities {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    reasoning_effort: normalizeReasoningEffortList(raw.reasoning_effort),
    response_speed: normalizeSpeedList(raw.response_speed),
    thinking: typeof raw.thinking === 'boolean' ? raw.thinking : true,
  };
}

function normalizeDefaults(value: unknown): ModelDefaults {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    reasoning_effort: normalizeReasoningEffort(raw.reasoning_effort, 'medium'),
    speed: normalizeSpeedPreference(raw.speed, 'balanced'),
  };
}

function normalizeReasoningEffortList(value: unknown): ReasoningEffort[] {
  if (!Array.isArray(value)) return [...REASONING_EFFORTS];
  const normalized = value.map((item) => normalizeReasoningEffort(item)).filter((item, index, list) => list.indexOf(item) === index);
  return normalized.length > 0 ? normalized : [...REASONING_EFFORTS];
}

function normalizeSpeedList(value: unknown): SpeedPreference[] {
  if (!Array.isArray(value)) return [...RESPONSE_SPEEDS];
  const normalized = value.map((item) => normalizeSpeedPreference(item)).filter((item, index, list) => list.indexOf(item) === index);
  return normalized.length > 0 ? normalized : [...RESPONSE_SPEEDS];
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`Invalid model alias overlay config at ${label}: expected a non-empty string.`);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readOptionalStringPatch(value: unknown, current: string | undefined): string | undefined {
  if (value === null) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  return current;
}

function discoveredToRuntimeModel(model: ChatGptDiscoveredModel): RuntimeModel {
  return {
    id: model.id,
    type: 'model',
    display_name: model.displayName ?? model.id,
    builtIn: false,
    enabled: true,
    backendModel: model.id,
    capabilities: normalizeCapabilities(model.capabilities),
    defaults: normalizeDefaults(undefined),
    discovered: cloneDiscoveredModel(model),
    source: 'discovered',
    status: 'passthrough',
  };
}

function cloneAliases(aliases: AliasOverlay[]): AliasOverlay[] {
  return aliases.map(cloneAlias);
}

function cloneAlias(alias: AliasOverlay): AliasOverlay {
  return {
    ...alias,
    capabilities: {
      reasoning_effort: [...alias.capabilities.reasoning_effort],
      response_speed: [...alias.capabilities.response_speed],
      thinking: alias.capabilities.thinking,
    },
    defaults: { ...alias.defaults },
  };
}

function cloneRuntimeModel(model: RuntimeModel): RuntimeModel {
  return {
    ...model,
    capabilities: {
      reasoning_effort: [...model.capabilities.reasoning_effort],
      response_speed: [...model.capabilities.response_speed],
      thinking: model.capabilities.thinking,
    },
    defaults: { ...model.defaults },
    discovered: model.discovered ? cloneDiscoveredModel(model.discovered) : undefined,
  };
}

function cloneDiscoveredModels(models: ChatGptDiscoveredModel[]): ChatGptDiscoveredModel[] {
  return models.map(cloneDiscoveredModel);
}

function cloneDiscoveredModel(model: ChatGptDiscoveredModel): ChatGptDiscoveredModel {
  return {
    ...model,
    capabilities: model.capabilities ? { ...model.capabilities } : undefined,
  };
}
