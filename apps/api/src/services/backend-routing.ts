export type BackendRoutingMode = 'auto' | 'codex' | 'web';
export type BackendAutoPreference = 'web' | 'codex';

export interface BackendRoutingGateway {
  baseUrl: string;
  apiKey?: string;
  models: string[];
  supportsTools: boolean;
  supportsImages?: boolean;
  /** Explicit client model or alias to configured gateway model mapping. */
  modelMappings?: Record<string, string>;
}

export interface BackendRoutingConfig {
  /** Omitted legacy configurations allow the web backend when a gateway exists. */
  webEnabled?: boolean;
  mode: BackendRoutingMode;
  autoPreference?: BackendAutoPreference;
  gateway?: BackendRoutingGateway;
}

export interface BackendRoutingView {
  webEnabled: boolean;
  mode: BackendRoutingMode;
  autoPreference: BackendAutoPreference;
  configured: boolean;
  gateway?: Omit<BackendRoutingGateway, 'apiKey' | 'supportsImages'> & { supportsImages: boolean; apiKeyConfigured: boolean };
}

export class BackendRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendRoutingError';
  }
}

/** Runtime configuration; callers must persist updates in their durable transaction. */
export class BackendRouting {
  private config: BackendRoutingConfig;

  constructor(config: BackendRoutingConfig = { mode: 'codex' }) {
    this.config = normalizeBackendRoutingConfig(config);
  }

  snapshot(): BackendRoutingConfig { return structuredClone(this.config); }

  isWebEnabled(): boolean { return this.config.webEnabled ?? Boolean(this.config.gateway); }

  restore(config: unknown): void { this.config = normalizeBackendRoutingConfig(config); }

  update(patch: unknown): BackendRoutingConfig {
    const raw = object(patch, ['webEnabled', 'mode', 'autoPreference', 'gateway'], 'backend routing');
    const next = this.snapshot();
    if (raw.webEnabled !== undefined) next.webEnabled = enabled(raw.webEnabled);
    if (raw.mode !== undefined) next.mode = mode(raw.mode);
    if (raw.autoPreference !== undefined) next.autoPreference = autoPreference(raw.autoPreference);
    if (raw.gateway === null) delete next.gateway;
    else if (raw.gateway !== undefined) {
      const gateway = object(raw.gateway, ['baseUrl', 'apiKey', 'models', 'supportsTools', 'supportsImages', 'modelMappings'], 'web gateway');
      const previous = next.gateway;
      const apiKey = gateway.apiKey === null ? undefined
        : gateway.apiKey === undefined || gateway.apiKey === '' ? previous?.apiKey
          : secret(gateway.apiKey);
      next.gateway = {
        baseUrl: gateway.baseUrl === undefined ? requiredPreviousUrl(previous) : normalizeGatewayBaseUrl(gateway.baseUrl),
        ...(apiKey ? { apiKey } : {}),
        models: gateway.models === undefined ? previous?.models ?? ['auto'] : modelIds(gateway.models),
        supportsTools: gateway.supportsTools === undefined ? previous?.supportsTools ?? false : boolean(gateway.supportsTools),
        ...(gateway.supportsImages === undefined
          ? previous?.supportsImages === undefined ? {} : { supportsImages: previous.supportsImages }
          : { supportsImages: boolean(gateway.supportsImages, 'supportsImages') }),
        ...(gateway.modelMappings === undefined
          ? previous?.modelMappings === undefined ? {} : { modelMappings: previous.modelMappings }
          : { modelMappings: gateway.modelMappings as Record<string, string> }),
      };
    }
    this.config = normalizeBackendRoutingConfig(next);
    return this.snapshot();
  }

  safeView(): BackendRoutingView {
    const { mode, gateway, autoPreference } = this.config;
    return {
      webEnabled: this.isWebEnabled(),
      mode,
      autoPreference: autoPreference ?? 'web',
      configured: Boolean(gateway),
      ...(gateway ? { gateway: {
        baseUrl: gateway.baseUrl,
        models: [...gateway.models],
        supportsTools: gateway.supportsTools,
        supportsImages: gateway.supportsImages ?? false,
        ...(gateway.modelMappings === undefined ? {} : { modelMappings: Object.fromEntries(Object.entries(gateway.modelMappings)) }),
        apiKeyConfigured: Boolean(gateway.apiKey),
      } } : {}),
    };
  }
}

export function normalizeBackendRoutingConfig(value: unknown): BackendRoutingConfig {
  const raw = object(value, ['webEnabled', 'mode', 'autoPreference', 'gateway'], 'backend routing');
  const normalizedMode = mode(raw.mode);
  const webEnabled = raw.webEnabled === undefined ? {} : { webEnabled: enabled(raw.webEnabled) };
  const preference = raw.autoPreference === undefined ? {} : { autoPreference: autoPreference(raw.autoPreference) };
  if (raw.gateway === undefined) return { mode: normalizedMode, ...webEnabled, ...preference };
  const gateway = object(raw.gateway, ['baseUrl', 'apiKey', 'models', 'supportsTools', 'supportsImages', 'modelMappings'], 'web gateway');
  const models = modelIds(gateway.models);
  return { mode: normalizedMode, ...webEnabled, ...preference, gateway: {
    baseUrl: normalizeGatewayBaseUrl(gateway.baseUrl),
    ...(gateway.apiKey === undefined ? {} : { apiKey: secret(gateway.apiKey) }),
    models,
    supportsTools: boolean(gateway.supportsTools),
    ...(gateway.supportsImages === undefined ? {} : { supportsImages: boolean(gateway.supportsImages, 'supportsImages') }),
    ...(gateway.modelMappings === undefined ? {} : { modelMappings: modelMappings(gateway.modelMappings, models) }),
  } };
}

/** Keep a gateway root: transports append /v1 endpoint paths exactly once. */
export function normalizeGatewayBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\t\u0000]/.test(value) || /[?#]/.test(value)) throw new BackendRoutingError('Web gateway baseUrl must be an HTTP or HTTPS URL without query or fragment.');
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new BackendRoutingError('Web gateway baseUrl must be an HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new BackendRoutingError('Web gateway baseUrl must use HTTP or HTTPS without credentials, query, or fragment.');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/v1')) path = path.slice(0, -3).replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

function object(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BackendRoutingError(`${label} must be an object.`);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new BackendRoutingError(`${label} contains an unknown field.`);
  return raw;
}

function mode(value: unknown): BackendRoutingMode {
  if (value === 'auto' || value === 'codex' || value === 'web') return value;
  throw new BackendRoutingError('Backend routing mode must be auto, codex, or web.');
}

function autoPreference(value: unknown): BackendAutoPreference {
  if (value === 'web' || value === 'codex') return value;
  throw new BackendRoutingError('Backend autoPreference must be web or codex.');
}

function enabled(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new BackendRoutingError('Backend routing webEnabled must be a boolean.');
  return value;
}

function modelMappings(value: unknown, models: string[]): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new BackendRoutingError('Web gateway modelMappings must be an object.');
  }
  const entries = Object.entries(value);
  if (entries.length > 256 || entries.some(([key, target]) => !key || key.length > 256 || key.trim() !== key
    || /[\u0000-\u001f\u007f]/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)
    || typeof target !== 'string' || !models.includes(target))) {
    throw new BackendRoutingError('Web gateway modelMappings must contain at most 256 valid client model IDs mapped to configured gateway models.');
  }
  return Object.fromEntries(entries);
}

function modelIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new BackendRoutingError('Web gateway models must be a non-empty array of model IDs.');
  }
  const ids = value.map((item: string) => item.trim());
  if (new Set(ids).size !== ids.length) throw new BackendRoutingError('Web gateway models contains duplicate IDs.');
  return ids;
}

function boolean(value: unknown, field = 'supportsTools'): boolean {
  if (typeof value !== 'boolean') throw new BackendRoutingError(`Web gateway ${field} must be a boolean.`);
  return value;
}

function secret(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new BackendRoutingError('Web gateway apiKey must be a non-empty string without line breaks.');
  return value.trim();
}

function requiredPreviousUrl(previous: BackendRoutingGateway | undefined): string {
  if (!previous) throw new BackendRoutingError('Web gateway baseUrl is required.');
  return previous.baseUrl;
}
