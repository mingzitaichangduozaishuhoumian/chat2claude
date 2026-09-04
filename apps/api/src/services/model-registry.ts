import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ChatGptBackendClient,
  ChatGptBackendRequestContext,
  ChatGptDiscoveredModel,
  ChatGptModelControlCapabilities,
  ChatGptReasoningLevelOption,
  ChatGptServiceTierOption,
} from '@chatgpt-to-claude/chatgpt-backend';
import {
  normalizeReasoningEffort,
  normalizeSpeedPreference,
  type ReasoningEffort,
  type SpeedPreference,
} from '@chatgpt-to-claude/protocol-mapper';

export interface ModelCapabilities {
  reasoning_effort: string[];
  reasoning_effort_options: ChatGptReasoningLevelOption[];
  response_speed: string[];
  service_tiers: ChatGptServiceTierOption[];
  thinking: boolean;
  metadata_status: { reasoning: 'known' | 'unknown'; service_tier: 'known' | 'unknown' };
  fast_mode: boolean;
  ultra_lossy: boolean;
  ultra_mapped_effort?: string;
}

export interface ModelDefaults {
  reasoning_effort: ReasoningEffort;
  speed: SpeedPreference;
}

export interface EffectiveModelDefaults {
  reasoning_effort?: string;
  service_tier?: string;
  reasoning_source: 'alias' | 'discovered' | 'omit';
  service_tier_source: 'alias' | 'discovered' | 'omit';
}

export interface AliasOverlay {
  id: string;
  type: 'model';
  display_name: string;
  builtIn: boolean;
  enabled: boolean;
  backendModel?: string;
  /** Legacy persisted policy metadata. Runtime capabilities always come from the selected target. */
  capabilities: ModelCapabilities;
  defaults: ModelDefaults;
}

export interface RuntimeModel extends Omit<AliasOverlay, 'capabilities'> {
  source: 'alias' | 'discovered';
  backendModel?: string;
  capabilities: ModelCapabilities;
  discovered?: ChatGptDiscoveredModel;
  status: 'bound' | 'unbound' | 'stale' | 'passthrough';
  effective_defaults: EffectiveModelDefaults;
  configuration_issues: string[];
}

export interface ModelResolution {
  model: RuntimeModel;
  backendModel: string;
  target: ChatGptDiscoveredModel;
}

export interface ExplicitModelControls {
  reasoningEffort?: unknown;
  serviceTier?: unknown;
}

export interface ResolvedModelControls {
  reasoningEffort?: string;
  serviceTier?: string;
  reasoningSource: 'explicit' | 'alias' | 'discovered' | 'omit';
  serviceTierSource: 'explicit' | 'alias' | 'discovered' | 'omit';
}

export interface ModelPatch {
  backendModel?: unknown;
  enabled?: unknown;
  defaults?: {
    reasoning_effort?: unknown;
    speed?: unknown;
    service_tier?: unknown;
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

export interface AccountModelIdentity {
  accountId: string;
  createdAt: string;
}

interface AccountModelCatalog {
  identity: AccountModelIdentity;
  active: boolean;
  models: ChatGptDiscoveredModel[];
}

export interface ModelRegistrySnapshot {
  aliases: AliasOverlay[];
  discoveredModels: ChatGptDiscoveredModel[];
  accountCatalogs: AccountModelCatalog[];
}

export type ProvisioningBindingMode = 'replace' | 'bind-if-unbound';

export class ModelRegistry {
  private readonly defaultAliases: AliasOverlay[];
  private aliases: AliasOverlay[];
  private discoveredModels: ChatGptDiscoveredModel[];
  private readonly accountCatalogs = new Map<string, AccountModelCatalog>();

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

  replaceAccountModels(identity: AccountModelIdentity, models: ChatGptDiscoveredModel[], active = true): AdminModelsView {
    const normalizedIdentity = normalizeAccountIdentity(identity);
    this.accountCatalogs.set(accountIdentityKey(normalizedIdentity), {
      identity: normalizedIdentity,
      active,
      models: cloneDiscoveredModels(models),
    });
    return this.adminView();
  }

  setAccountActive(identity: AccountModelIdentity, active: boolean): boolean {
    const catalog = this.accountCatalogs.get(accountIdentityKey(normalizeAccountIdentity(identity)));
    if (!catalog) return false;
    catalog.active = active;
    return true;
  }

  removeAccountModels(identity: AccountModelIdentity): boolean {
    return this.accountCatalogs.delete(accountIdentityKey(normalizeAccountIdentity(identity)));
  }

  prepareProvisioning(models: ChatGptDiscoveredModel[], aliasId: string, backendModel?: string, bindingMode: ProvisioningBindingMode = 'replace'): PreparedModelProvisioning {
    const aliases = cloneAliases(this.aliases);
    const discoveredModels = cloneDiscoveredModels(models);
    const boundAliases: Record<string, string> = {};
    const index = aliases.findIndex((alias) => alias.id === aliasId);
    const mayBind = bindingMode === 'replace' || !aliases[index]?.backendModel;
    if (backendModel && index !== -1 && mayBind && discoveredModels.some((model) => model.id === backendModel)) {
      aliases[index] = { ...aliases[index], backendModel, enabled: true };
      boundAliases[aliasId] = backendModel;
    }
    return { aliases, discoveredModels, boundAliases };
  }

  commitPreparedProvisioning(prepared: PreparedModelProvisioning, identity?: AccountModelIdentity, active = true): void {
    this.aliases = cloneAliases(prepared.aliases);
    if (identity) this.replaceAccountModels(identity, prepared.discoveredModels, active);
    else this.discoveredModels = cloneDiscoveredModels(prepared.discoveredModels);
  }

  list(): RuntimeModel[] {
    const discoveredModels = this.effectiveDiscoveredModels();
    const aliases = this.aliases.map((alias) => this.toRuntimeAlias(alias, discoveredModels));
    const aliasIds = new Set(this.aliases.map((alias) => alias.id));
    const passthrough = discoveredModels.filter((model) => !aliasIds.has(model.id)).map((model) => discoveredToRuntimeModel(model));
    return [...aliases, ...passthrough].map(cloneRuntimeModel);
  }

  adminView(): AdminModelsView {
    const discoveredModels = this.effectiveDiscoveredModels();
    const aliases = this.aliases.map((alias) => this.toRuntimeAlias(alias, discoveredModels)).map(cloneRuntimeModel);
    const discovered = discoveredModels.map(discoveredToRuntimeModel).map(cloneRuntimeModel);
    return { aliases, discovered, combined: this.list() };
  }

  get(id: string): RuntimeModel | undefined {
    const model = this.list().find((item) => item.id === id);
    return model ? cloneRuntimeModel(model) : undefined;
  }

  resolve(id: string): ModelResolution {
    const discoveredModels = this.effectiveDiscoveredModels();
    return this.resolveAgainst(id, discoveredModels);
  }

  resolveForAccount(id: string, identity: AccountModelIdentity): ModelResolution {
    const catalog = this.accountCatalogs.get(accountIdentityKey(normalizeAccountIdentity(identity)));
    if (!catalog || !catalog.active) throw new ModelRegistryError(`No active discovered catalog for account: ${identity.accountId}`, 'unknown', 404);
    return this.resolveAgainst(id, catalog.models);
  }

  supportsAccountRequest(id: string, identity: AccountModelIdentity, explicit: ExplicitModelControls = {}): boolean {
    try {
      const resolution = this.resolveForAccount(id, identity);
      this.resolveControls(resolution, explicit);
      return true;
    } catch {
      return false;
    }
  }

  resolveControls(resolution: ModelResolution, explicit: ExplicitModelControls = {}): ResolvedModelControls {
    const alias = resolution.model.source === 'alias' ? this.aliases.find((item) => item.id === resolution.model.id) : undefined;
    const reasoning = resolveReasoningControl(resolution.target, explicit.reasoningEffort, alias?.defaults.reasoning_effort);
    const serviceTier = resolveServiceTierControl(resolution.target, explicit.serviceTier, alias?.defaults.speed);
    return {
      ...(reasoning.value ? { reasoningEffort: reasoning.value } : {}),
      ...(serviceTier.value ? { serviceTier: serviceTier.value } : {}),
      reasoningSource: reasoning.source,
      serviceTierSource: serviceTier.source,
    };
  }

  accountControlRequirements(resolution: ModelResolution, explicit: ExplicitModelControls = {}): ExplicitModelControls {
    const resolved = this.resolveControls(resolution, explicit);
    return {
      ...(explicit.reasoningEffort !== undefined
        ? { reasoningEffort: explicit.reasoningEffort }
        : resolved.reasoningSource === 'alias' && resolved.reasoningEffort
          ? { reasoningEffort: resolved.reasoningEffort }
          : {}),
      ...(explicit.serviceTier !== undefined
        ? { serviceTier: explicit.serviceTier }
        : resolved.serviceTierSource === 'alias' && resolved.serviceTier
          ? { serviceTier: resolved.serviceTier }
          : {}),
    };
  }

  update(id: string, patch: ModelPatch): RuntimeModel | undefined {
    const index = this.aliases.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    const current = this.aliases[index];
    const rawSpeed = patch.defaults?.service_tier ?? patch.defaults?.speed;
    const next: AliasOverlay = {
      ...current,
      backendModel: readOptionalStringPatch(patch.backendModel, current.backendModel),
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      capabilities: patch.capabilities === undefined ? current.capabilities : normalizeCapabilities(patch.capabilities),
      defaults: {
        reasoning_effort: normalizeReasoningEffort(patch.defaults?.reasoning_effort, current.defaults.reasoning_effort),
        speed: normalizeSpeedPreference(rawSpeed, current.defaults.speed),
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

  exportState(): AliasOverlay[] { return cloneAliases(this.aliases); }

  importState(aliases: AliasOverlay[]): boolean {
    const normalized = parseAliasConfig({ aliases }, 'runtime state');
    const defaultIds = new Set(this.defaultAliases.map((alias) => alias.id));
    if (normalized.some((alias) => alias.builtIn !== defaultIds.has(alias.id))) throw new Error('Invalid model alias runtime state: built-in aliases must match the configured registry.');
    const persisted = new Map(normalized.map((alias) => [alias.id, alias]));
    this.aliases = [...this.defaultAliases.map((alias) => persisted.get(alias.id) ?? alias), ...normalized.filter((alias) => !alias.builtIn)];
    return this.defaultAliases.some((alias) => !persisted.has(alias.id));
  }

  snapshot(): ModelRegistrySnapshot {
    return {
      aliases: cloneAliases(this.aliases),
      discoveredModels: cloneDiscoveredModels(this.discoveredModels),
      accountCatalogs: [...this.accountCatalogs.values()].map(cloneAccountCatalog),
    };
  }

  restore(snapshot: ModelRegistrySnapshot): void {
    this.aliases = cloneAliases(snapshot.aliases);
    this.discoveredModels = cloneDiscoveredModels(snapshot.discoveredModels);
    this.accountCatalogs.clear();
    for (const catalog of snapshot.accountCatalogs) this.accountCatalogs.set(accountIdentityKey(catalog.identity), cloneAccountCatalog(catalog));
  }

  reset(): RuntimeModel[] { this.aliases = cloneAliases(this.defaultAliases); return this.list(); }

  reasoningSpeedDefaultsFor(modelId: string): { reasoningEffort?: ReasoningEffort; speedPreference?: SpeedPreference } | undefined {
    const model = this.get(modelId);
    if (!model?.enabled) return undefined;
    return { reasoningEffort: model.defaults.reasoning_effort, speedPreference: model.defaults.speed };
  }

  private effectiveDiscoveredModels(): ChatGptDiscoveredModel[] {
    const catalogs = [this.discoveredModels, ...[...this.accountCatalogs.values()].filter((catalog) => catalog.active).map((catalog) => catalog.models)];
    return mergeDiscoveredCatalogs(catalogs);
  }

  private resolveAgainst(id: string, discoveredModels: ChatGptDiscoveredModel[]): ModelResolution {
    const alias = this.aliases.find((item) => item.id === id);
    if (alias) {
      if (!alias.enabled) throw new ModelRegistryError(`Model is disabled: ${id}`, 'disabled', 400);
      if (!alias.backendModel) throw new ModelRegistryError(`Model alias is not bound to a backend model: ${id}`, 'unbound', 400);
      const target = discoveredModels.find((item) => item.id === alias.backendModel);
      if (!target) throw new ModelRegistryError(`Model alias ${id} is bound to missing backend model: ${alias.backendModel}`, 'stale', 404);
      return { model: this.toRuntimeAlias(alias, discoveredModels), backendModel: alias.backendModel, target: cloneDiscoveredModel(target) };
    }
    const target = discoveredModels.find((item) => item.id === id);
    if (target) return { model: discoveredToRuntimeModel(target), backendModel: target.id, target: cloneDiscoveredModel(target) };
    throw new ModelRegistryError(`Unknown model: ${id}`, 'unknown', 404);
  }

  private toRuntimeAlias(alias: AliasOverlay, discoveredModels = this.effectiveDiscoveredModels()): RuntimeModel {
    const discovered = alias.backendModel ? discoveredModels.find((item) => item.id === alias.backendModel) : undefined;
    const capabilities = effectiveCapabilities(discovered);
    const effective = discovered ? effectiveDefaults(discovered, alias.defaults) : emptyEffectiveDefaults();
    return {
      ...cloneAlias(alias),
      capabilities,
      source: 'alias',
      discovered: discovered ? cloneDiscoveredModel(discovered) : undefined,
      status: !alias.backendModel ? 'unbound' : discovered ? 'bound' : 'stale',
      effective_defaults: effective.defaults,
      configuration_issues: effective.issues,
    };
  }
}

export class ModelRegistryError extends Error {
  constructor(message: string, readonly code: 'disabled' | 'unbound' | 'stale' | 'unknown' | 'unsupported_control', readonly status: 400 | 404) {
    super(message);
    this.name = 'ModelRegistryError';
  }
}

function loadDefaultAliases(options: ModelRegistryOptions): AliasOverlay[] {
  if (options.defaults !== undefined) return parseAliasConfig(options.defaults, 'injected defaults');
  const env = options.env ?? process.env;
  if (env.MODEL_REGISTRY_JSON?.trim()) return parseAliasConfig(parseJson(env.MODEL_REGISTRY_JSON, 'MODEL_REGISTRY_JSON'), 'MODEL_REGISTRY_JSON');
  const configPath = options.configPath ?? findDefaultConfigPath();
  return parseAliasConfig(parseJson(readFileSync(configPath, 'utf8'), configPath), configPath);
}

function findDefaultConfigPath(): string {
  const candidates = [resolve(process.cwd(), 'config/models.json'), resolve(dirname(fileURLToPath(import.meta.url)), '../../../../config/models.json'), resolve(dirname(fileURLToPath(import.meta.url)), '../../../config/models.json')];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Model alias overlay config not found. Expected editable config at ${candidates[0]} or set MODEL_REGISTRY_JSON.`);
  return found;
}

function parseJson(source: string, label: string): unknown {
  try { return JSON.parse(source) as unknown; }
  catch (error) { throw new Error(`Invalid model alias overlay JSON from ${label}: ${error instanceof Error ? error.message : String(error)}`); }
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
  return {
    id,
    type: 'model',
    display_name: readOptionalString(raw.display_name ?? raw.displayName) ?? id,
    builtIn,
    backendModel: readOptionalString(raw.backendModel),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    capabilities: normalizeCapabilities(raw.capabilities),
    defaults: normalizeDefaults(raw.defaults),
  };
}

function normalizeCapabilities(value: unknown): ModelCapabilities {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const reasoning = Array.isArray(raw.reasoning_effort) ? raw.reasoning_effort.map((item) => normalizeReasoningEffort(item)).filter(unique) : [];
  const speeds = Array.isArray(raw.response_speed) ? raw.response_speed.map((item) => normalizeSpeedPreference(item)).filter(unique) : [];
  return {
    reasoning_effort: reasoning,
    reasoning_effort_options: reasoning.map((effort) => ({ effort })),
    response_speed: speeds,
    service_tiers: speeds.filter((id) => id !== 'standard').map((id) => ({ id })),
    thinking: typeof raw.thinking === 'boolean' ? raw.thinking : false,
    metadata_status: { reasoning: reasoning.length ? 'known' : 'unknown', service_tier: speeds.length ? 'known' : 'unknown' },
    fast_mode: speeds.includes('priority'),
    ultra_lossy: false,
  };
}

function normalizeDefaults(value: unknown): ModelDefaults {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    reasoning_effort: normalizeReasoningEffort(raw.reasoning_effort, 'none'),
    speed: normalizeSpeedPreference(raw.service_tier ?? raw.speed, 'standard'),
  };
}

function effectiveCapabilities(model: ChatGptDiscoveredModel | undefined): ModelCapabilities {
  const controls = model?.controls;
  if (!controls) return unknownCapabilities();
  const advertisesUltra = controls.reasoning.supported.some((option) => normalizeReasoningEffort(option.effort) === 'ultra');
  const ultraMappedEffort = advertisesUltra ? mapUltraEffort(controls) : undefined;
  const serviceTiers = cloneServiceOptions(controls.serviceTier.supported);
  if (controls.serviceTier.fastMode && !serviceTiers.some((option) => option.id.toLowerCase() === 'priority')) serviceTiers.push({ id: 'priority', name: 'Priority' });
  return {
    reasoning_effort: controls.reasoning.supported.map((option) => option.effort),
    reasoning_effort_options: controls.reasoning.supported.map((option) => ({ ...option })),
    response_speed: ['standard', 'auto', ...serviceTiers.map((option) => option.id).filter((id) => !['standard', 'default', 'auto'].includes(id.toLowerCase()))],
    service_tiers: serviceTiers,
    thinking: controls.reasoning.supported.some((option) => normalizeReasoningEffort(option.effort) !== 'none'),
    metadata_status: { reasoning: controls.reasoning.metadataKnown ? 'known' : 'unknown', service_tier: controls.serviceTier.metadataKnown ? 'known' : 'unknown' },
    fast_mode: controls.serviceTier.fastMode,
    ultra_lossy: advertisesUltra,
    ...(ultraMappedEffort ? { ultra_mapped_effort: ultraMappedEffort } : {}),
  };
}

function unknownCapabilities(): ModelCapabilities {
  return { reasoning_effort: [], reasoning_effort_options: [], response_speed: [], service_tiers: [], thinking: false, metadata_status: { reasoning: 'unknown', service_tier: 'unknown' }, fast_mode: false, ultra_lossy: false };
}

function effectiveDefaults(model: ChatGptDiscoveredModel, aliasDefaults?: ModelDefaults): { defaults: EffectiveModelDefaults; issues: string[] } {
  const issues: string[] = [];
  const reasoning = resolveImplicitReasoning(model, aliasDefaults?.reasoning_effort, issues);
  const serviceTier = resolveImplicitServiceTier(model, aliasDefaults?.speed, issues);
  return {
    defaults: {
      ...(reasoning.value ? { reasoning_effort: reasoning.value } : {}),
      ...(serviceTier.value ? { service_tier: serviceTier.value } : {}),
      reasoning_source: reasoning.source,
      service_tier_source: serviceTier.source,
    },
    issues,
  };
}

function emptyEffectiveDefaults(): { defaults: EffectiveModelDefaults; issues: string[] } {
  return { defaults: { reasoning_source: 'omit', service_tier_source: 'omit' }, issues: [] };
}

function resolveReasoningControl(model: ChatGptDiscoveredModel, explicit: unknown, aliasDefault: ReasoningEffort | undefined): { value?: string; source: ResolvedModelControls['reasoningSource'] } {
  if (explicit !== undefined) {
    const value = validateReasoning(model, explicit, true);
    return { ...(value ? { value } : {}), source: 'explicit' };
  }
  const implicit = resolveImplicitReasoning(model, aliasDefault, []);
  return { ...implicit, source: implicit.source };
}

function resolveImplicitReasoning(model: ChatGptDiscoveredModel, aliasDefault: ReasoningEffort | undefined, issues: string[]): { value?: string; source: 'alias' | 'discovered' | 'omit' } {
  if (aliasDefault !== undefined) {
    const value = validateReasoning(model, aliasDefault, false);
    if (value !== INVALID) return { ...(value ? { value } : {}), source: 'alias' };
    issues.push(`Configured reasoning default "${aliasDefault}" is unsupported by target ${model.id}.`);
  }
  const discoveredDefault = model.controls?.reasoning.defaultEffort;
  if (discoveredDefault !== undefined) {
    const value = validateReasoning(model, discoveredDefault, false);
    if (value !== INVALID) return { ...(value ? { value } : {}), source: 'discovered' };
    issues.push(`Discovered reasoning default "${discoveredDefault}" is not present in the target supported list.`);
  }
  return { source: 'omit' };
}

function resolveServiceTierControl(model: ChatGptDiscoveredModel, explicit: unknown, aliasDefault: SpeedPreference | undefined): { value?: string; source: ResolvedModelControls['serviceTierSource'] } {
  if (explicit !== undefined) {
    const value = validateServiceTier(model, explicit, true);
    return { ...(value ? { value } : {}), source: 'explicit' };
  }
  const implicit = resolveImplicitServiceTier(model, aliasDefault, []);
  return { ...implicit, source: implicit.source };
}

function resolveImplicitServiceTier(model: ChatGptDiscoveredModel, aliasDefault: SpeedPreference | undefined, issues: string[]): { value?: string; source: 'alias' | 'discovered' | 'omit' } {
  if (aliasDefault !== undefined) {
    const value = validateServiceTier(model, aliasDefault, false);
    if (value !== INVALID) return { ...(value ? { value } : {}), source: 'alias' };
    issues.push(`Configured service tier default "${aliasDefault}" is unsupported by target ${model.id}.`);
  }
  const discoveredDefault = model.controls?.serviceTier.defaultTier;
  if (discoveredDefault !== undefined) {
    const value = validateServiceTier(model, discoveredDefault, false);
    if (value !== INVALID) return { ...(value ? { value } : {}), source: 'discovered' };
    issues.push(`Discovered service tier default "${discoveredDefault}" is not present in the target supported list.`);
  }
  return { source: 'omit' };
}

const INVALID = Symbol('invalid-control');

function validateReasoning(model: ChatGptDiscoveredModel, rawValue: unknown, explicit: true): string | undefined;
function validateReasoning(model: ChatGptDiscoveredModel, rawValue: unknown, explicit: false): string | undefined | typeof INVALID;
function validateReasoning(model: ChatGptDiscoveredModel, rawValue: unknown, explicit: boolean): string | undefined | typeof INVALID {
  if (typeof rawValue !== 'string' || !rawValue.trim()) return invalidControl(model, 'reasoning_effort', rawValue, supportedReasoningValues(model), explicit);
  const normalized = normalizeReasoningEffort(rawValue);
  if (normalized === 'none') {
    const advertisedNone = findAdvertisedReasoning(model, 'none');
    return advertisedNone ?? invalidControl(model, 'reasoning_effort', rawValue, supportedReasoningValues(model), explicit);
  }
  const advertised = findAdvertisedReasoning(model, normalized);
  if (!advertised) return invalidControl(model, 'reasoning_effort', rawValue, supportedReasoningValues(model), explicit);
  if (normalized === 'ultra') {
    const mapped = mapUltraEffort(model.controls!);
    return mapped ?? invalidControl(model, 'reasoning_effort', rawValue, supportedReasoningValues(model).filter((value) => normalizeReasoningEffort(value) !== 'ultra'), explicit);
  }
  return advertised;
}

function validateServiceTier(model: ChatGptDiscoveredModel, rawValue: unknown, explicit: true): string | undefined;
function validateServiceTier(model: ChatGptDiscoveredModel, rawValue: unknown, explicit: false): string | undefined | typeof INVALID;
function validateServiceTier(model: ChatGptDiscoveredModel, rawValue: unknown, explicit: boolean): string | undefined | typeof INVALID {
  if (typeof rawValue !== 'string' || !rawValue.trim()) return invalidControl(model, 'service_tier', rawValue, supportedServiceTierValues(model), explicit);
  const normalized = normalizeSpeedPreference(rawValue);
  if (normalized === 'auto') return undefined;
  if (normalized === 'standard') return 'default';
  const advertised = findAdvertisedServiceTier(model, normalized);
  if (!advertised) return invalidControl(model, 'service_tier', rawValue, supportedServiceTierValues(model), explicit);
  return advertised;
}

function invalidControl(model: ChatGptDiscoveredModel, name: string, value: unknown, supported: string[], explicit: boolean): typeof INVALID {
  if (!explicit) return INVALID;
  const detail = supported.length ? supported.join(', ') : '(metadata unknown; no explicit values can be sent safely)';
  throw new ModelRegistryError(`Unsupported ${name} "${String(value)}" for target model ${model.id}. Supported values: ${detail}.`, 'unsupported_control', 400);
}

function findAdvertisedReasoning(model: ChatGptDiscoveredModel, value: string): string | undefined {
  return model.controls?.reasoning.supported.find((option) => normalizeReasoningEffort(option.effort) === value)?.effort;
}

function findAdvertisedServiceTier(model: ChatGptDiscoveredModel, value: string): string | undefined {
  const advertised = model.controls?.serviceTier.supported.find((option) => option.id.toLowerCase() === value.toLowerCase())?.id;
  if (advertised) return advertised;
  return value === 'priority' && model.controls?.serviceTier.fastMode ? 'priority' : undefined;
}

function supportedReasoningValues(model: ChatGptDiscoveredModel): string[] {
  return model.controls?.reasoning.supported.map((option) => option.effort) ?? [];
}

function supportedServiceTierValues(model: ChatGptDiscoveredModel): string[] {
  const values = model.controls?.serviceTier.supported.map((option) => option.id) ?? [];
  if (model.controls?.serviceTier.fastMode && !values.some((value) => value.toLowerCase() === 'priority')) values.push('priority');
  return ['default', 'auto', ...values.filter((value) => !['default', 'standard', 'auto'].includes(value.toLowerCase()))];
}

function mapUltraEffort(controls: ChatGptModelControlCapabilities): string | undefined {
  const multiAgent = extractMultiAgentEffort(controls.reasoning.multiAgent);
  if (multiAgent) return multiAgent;
  const max = controls.reasoning.supported.find((option) => normalizeReasoningEffort(option.effort) === 'max')?.effort;
  if (max) return max;
  const nonUltra = controls.reasoning.supported.filter((option) => normalizeReasoningEffort(option.effort) !== 'ultra');
  if (nonUltra.length) return nonUltra[nonUltra.length - 1].effort;
  const defaultEffort = controls.reasoning.defaultEffort;
  if (defaultEffort && normalizeReasoningEffort(defaultEffort) !== 'ultra') return defaultEffort;
  return undefined;
}

function extractMultiAgentEffort(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  for (const key of ['effort', 'reasoning_effort', 'reasoningEffort', 'default_reasoning_level', 'defaultReasoningLevel']) {
    const candidate = raw[key];
    if (typeof candidate === 'string' && candidate.trim() && normalizeReasoningEffort(candidate) !== 'ultra') return candidate.trim();
  }
  const supported = raw.supported_reasoning_levels ?? raw.supportedReasoningLevels;
  if (Array.isArray(supported)) {
    for (let index = supported.length - 1; index >= 0; index -= 1) {
      const item = supported[index];
      const candidate = typeof item === 'string' ? item : item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>).effort : undefined;
      if (typeof candidate === 'string' && candidate.trim() && normalizeReasoningEffort(candidate) !== 'ultra') return candidate.trim();
    }
  }
  return undefined;
}

function discoveredToRuntimeModel(model: ChatGptDiscoveredModel): RuntimeModel {
  const effective = effectiveDefaults(model);
  return {
    id: model.id,
    type: 'model',
    display_name: model.displayName ?? model.id,
    builtIn: false,
    enabled: true,
    backendModel: model.id,
    capabilities: effectiveCapabilities(model),
    defaults: normalizeDefaults(undefined),
    effective_defaults: effective.defaults,
    configuration_issues: effective.issues,
    discovered: cloneDiscoveredModel(model),
    source: 'discovered',
    status: 'passthrough',
  };
}

function mergeDiscoveredCatalogs(catalogs: ChatGptDiscoveredModel[][]): ChatGptDiscoveredModel[] {
  const grouped = new Map<string, ChatGptDiscoveredModel[]>();
  for (const catalog of catalogs) {
    for (const model of catalog) {
      const existing = grouped.get(model.id);
      if (existing) existing.push(model);
      else grouped.set(model.id, [model]);
    }
  }
  return [...grouped.values()].map(mergeDiscoveredModels);
}

function mergeDiscoveredModels(models: ChatGptDiscoveredModel[]): ChatGptDiscoveredModel {
  const first = models[0];
  const controls = models.map((model) => model.controls);
  const knownControls = controls.filter((control): control is ChatGptModelControlCapabilities => control !== undefined);
  const reasoningOptions = uniqueBy(
    knownControls.flatMap((control) => control.reasoning.supported),
    (option) => normalizeReasoningEffort(option.effort),
  );
  const serviceTierOptions = uniqueBy(
    knownControls.flatMap((control) => control.serviceTier.supported),
    (option) => option.id.toLowerCase(),
  );
  const reasoningDefaults = uniqueDefined(knownControls.map((control) => control.reasoning.defaultEffort));
  const serviceTierDefaults = uniqueDefined(knownControls.map((control) => control.serviceTier.defaultTier));
  const multiAgentValues = uniqueDefined(knownControls.map((control) => control.reasoning.multiAgent), stableValueKey);
  return {
    id: first.id,
    ...(first.displayName ? { displayName: first.displayName } : {}),
    ...(first.capabilities ? { capabilities: { ...first.capabilities } } : {}),
    ...(knownControls.length > 0 ? {
      controls: {
        reasoning: {
          metadataKnown: controls.every((control) => control?.reasoning.metadataKnown === true),
          supported: reasoningOptions.map((option) => ({ ...option })),
          ...(reasoningDefaults.length === 1 ? { defaultEffort: reasoningDefaults[0] } : {}),
          ...(multiAgentValues.length === 1 ? { multiAgent: multiAgentValues[0] } : {}),
        },
        serviceTier: {
          metadataKnown: controls.every((control) => control?.serviceTier.metadataKnown === true),
          supported: serviceTierOptions.map((option) => ({ ...option })),
          ...(serviceTierDefaults.length === 1 ? { defaultTier: serviceTierDefaults[0] } : {}),
          fastMode: knownControls.some((control) => control.serviceTier.fastMode === true),
        },
      },
    } : {}),
  };
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const current = key(value);
    if (seen.has(current)) return false;
    seen.add(current);
    return true;
  });
}

function uniqueDefined<T>(values: Array<T | undefined>, key: (value: T) => string = (value) => String(value)): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value === undefined) continue;
    const current = key(value);
    if (seen.has(current)) continue;
    seen.add(current);
    result.push(value);
  }
  return result;
}

function stableValueKey(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function normalizeAccountIdentity(identity: AccountModelIdentity): AccountModelIdentity {
  const accountId = readNonEmptyString(identity.accountId, 'account identity.accountId');
  const createdAt = readNonEmptyString(identity.createdAt, 'account identity.createdAt');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid account model identity: createdAt must be a timestamp.');
  return { accountId, createdAt };
}

function accountIdentityKey(identity: AccountModelIdentity): string {
  return JSON.stringify([identity.accountId, identity.createdAt]);
}

function cloneAccountCatalog(catalog: AccountModelCatalog): AccountModelCatalog {
  return { identity: { ...catalog.identity }, active: catalog.active, models: cloneDiscoveredModels(catalog.models) };
}

function cloneAliases(aliases: AliasOverlay[]): AliasOverlay[] { return aliases.map(cloneAlias); }
function cloneAlias(alias: AliasOverlay): AliasOverlay { return { ...alias, capabilities: cloneCapabilities(alias.capabilities), defaults: { ...alias.defaults } }; }
function cloneRuntimeModel(model: RuntimeModel): RuntimeModel { return { ...model, capabilities: cloneCapabilities(model.capabilities), defaults: { ...model.defaults }, effective_defaults: { ...model.effective_defaults }, configuration_issues: [...model.configuration_issues], discovered: model.discovered ? cloneDiscoveredModel(model.discovered) : undefined }; }
function cloneCapabilities(value: ModelCapabilities): ModelCapabilities { return { ...value, reasoning_effort: [...value.reasoning_effort], reasoning_effort_options: value.reasoning_effort_options.map((option) => ({ ...option })), response_speed: [...value.response_speed], service_tiers: cloneServiceOptions(value.service_tiers), metadata_status: { ...value.metadata_status } }; }
function cloneServiceOptions(options: ChatGptServiceTierOption[]): ChatGptServiceTierOption[] { return options.map((option) => ({ ...option })); }
function cloneDiscoveredModels(models: ChatGptDiscoveredModel[]): ChatGptDiscoveredModel[] { return models.map(cloneDiscoveredModel); }
function cloneDiscoveredModel(model: ChatGptDiscoveredModel): ChatGptDiscoveredModel { return { ...model, capabilities: model.capabilities ? { ...model.capabilities } : undefined, controls: model.controls ? { reasoning: { ...model.controls.reasoning, supported: model.controls.reasoning.supported.map((option) => ({ ...option })) }, serviceTier: { ...model.controls.serviceTier, supported: cloneServiceOptions(model.controls.serviceTier.supported) } } : undefined }; }
function unique<T>(value: T, index: number, list: T[]): boolean { return list.indexOf(value) === index; }
function readNonEmptyString(value: unknown, label: string): string { if (typeof value === 'string' && value.trim()) return value.trim(); throw new Error(`Invalid model alias overlay config at ${label}: expected a non-empty string.`); }
function readOptionalString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function readOptionalStringPatch(value: unknown, current: string | undefined): string | undefined { if (value === null) return undefined; if (typeof value === 'string') return value.trim() || undefined; return current; }
