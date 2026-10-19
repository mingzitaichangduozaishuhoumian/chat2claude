import { resolve } from 'node:path';
import { normalizeCodexClientVersion } from '@chatgpt-to-claude/chatgpt-backend';
import { fileURLToPath } from 'node:url';
import { readCommaList, readNumber, type LogLevel } from '@chatgpt-to-claude/shared';
import { normalizeReasoningEffort, normalizeSpeedPreference, type ReasoningEffort, type SpeedPreference } from '@chatgpt-to-claude/protocol-mapper';
import { normalizeBackendRoutingConfig, type BackendRoutingConfig } from '../services/backend-routing.js';

export type ChatGptBackendProvider = 'mock' | 'session';

export interface AppEnv {
  port: number;
  host: string;
  apiKeys: string[];
  allowAnonymousBootstrap: boolean;
  localContainerBootstrap: boolean;
  logLevel: LogLevel;
  /** Omitted programmatic configs use text and 30 seconds respectively. */
  accessLogFormat?: 'text' | 'detailed' | 'json';
  accountAcquireTimeoutMs?: number;
  sseKeepaliveIntervalMs?: number;
  mockResponsePrefix: string;
  mockBackendModelsJson?: string;
  chatGptBackend: ChatGptBackendProvider;
  backendRouting?: BackendRoutingConfig;
  chatGptBaseUrl: string;
  /** Private transport configuration; never serialize to logs or Admin responses. */
  outboundProxyUrl?: string;
  chatGptRequestTimeoutMs: number;
  chatGptImageRequestTimeoutMs?: number;
  chatGptResponseHeaderTimeoutMs?: number;
  chatGptStreamIdleTimeoutMs?: number;
  chatGptStreamBootstrapTimeoutMs?: number;
  chatGptStreamTotalTimeoutMs?: number;
  /** loadEnv always supplies this; omitted programmatic configs use the protocol default. */
  codexClientVersion?: string;
  defaultReasoningEffort: ReasoningEffort;
  defaultResponseSpeed: SpeedPreference;
  dataDir: string;
  runtimeStatePath: string;
  operationalStatePath: string;
  stateEncryptionKey?: Uint8Array;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const host = source.HOST?.trim() || '127.0.0.1';
  const apiKeys = readCommaList(source.API_KEYS);
  const dataDir = source.DATA_DIR?.trim() ? resolve(source.DATA_DIR.trim()) : fileURLToPath(new URL('../../data', import.meta.url));
  const localContainerBootstrap = parseBoolean(source.LOCAL_CONTAINER_BOOTSTRAP);
  const allowAnonymousBootstrap = isLoopbackHost(host) || localContainerBootstrap;
  if (!isLoopbackHost(host) && apiKeys.length === 0 && !localContainerBootstrap) {
    throw new Error('Refusing non-loopback startup without API_KEYS. Set API_KEYS, or use LOCAL_CONTAINER_BOOTSTRAP=true only for a container published exclusively on host loopback.');
  }
  return {
    port: readNumber(source.PORT, 3000),
    host,
    apiKeys,
    allowAnonymousBootstrap,
    localContainerBootstrap,
    logLevel: parseLogLevel(source.LOG_LEVEL),
    accessLogFormat: parseAccessLogFormat(source.ACCESS_LOG_FORMAT),
    accountAcquireTimeoutMs: parseAccountAcquireTimeout(source.ACCOUNT_ACQUIRE_TIMEOUT_MS),
    sseKeepaliveIntervalMs: parseSseKeepaliveInterval(source.SSE_KEEPALIVE_INTERVAL_MS),
    mockResponsePrefix: source.MOCK_RESPONSE_PREFIX ?? 'Echo:',
    mockBackendModelsJson: source.MOCK_BACKEND_MODELS_JSON,
    chatGptBackend: parseBackendProvider(source.CHATGPT_BACKEND),
    ...routingEnvironment(source),
    chatGptBaseUrl: source.CHATGPT_BASE_URL?.trim() || 'https://chatgpt.com',
    outboundProxyUrl: parseOutboundProxyUrl(source.OUTBOUND_PROXY_URL),
    chatGptRequestTimeoutMs: readNumber(source.CHATGPT_REQUEST_TIMEOUT_MS, 60000),
    chatGptImageRequestTimeoutMs: parseStreamTimeout(source, 'CHATGPT_IMAGE_REQUEST_TIMEOUT_MS', 300_000),
    chatGptResponseHeaderTimeoutMs: parseStreamTimeout(source, 'CHATGPT_RESPONSE_HEADER_TIMEOUT_MS', 60_000),
    chatGptStreamBootstrapTimeoutMs: parseStreamTimeout(source, 'CHATGPT_STREAM_BOOTSTRAP_TIMEOUT_MS', 60_000),
    chatGptStreamIdleTimeoutMs: parseStreamTimeout(source, 'CHATGPT_STREAM_IDLE_TIMEOUT_MS', 300_000),
    chatGptStreamTotalTimeoutMs: parseStreamTimeout(source, 'CHATGPT_STREAM_TOTAL_TIMEOUT_MS', 0),
    codexClientVersion: normalizeCodexClientVersion(source.CODEX_CLIENT_VERSION),
    defaultReasoningEffort: normalizeReasoningEffort(source.DEFAULT_REASONING_EFFORT),
    defaultResponseSpeed: normalizeSpeedPreference(source.DEFAULT_RESPONSE_SPEED),
    dataDir,
    runtimeStatePath: resolve(dataDir, 'runtime-state.json'),
    operationalStatePath: resolve(dataDir, 'admin-operational-state.json'),
    stateEncryptionKey: parseStateEncryptionKey(source.STATE_ENCRYPTION_KEY),
  };
}

export function parseOutboundProxyUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    const trimmed = value.trim();
    const url = new URL(trimmed);
    if (!/^https?:\/\//i.test(trimmed) || /[\x00-\x20\x7f]/.test(trimmed)
      || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname
      || url.pathname !== '/' || url.search || url.hash) throw new Error();
    // Reject malformed credential escapes before constructing the dispatcher.
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return url.toString();
  } catch {
    throw new Error('OUTBOUND_PROXY_URL must be an HTTP or HTTPS proxy URL without a path, query, or fragment.');
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function parseAccessLogFormat(value: string | undefined): 'text' | 'detailed' | 'json' {
  if (value === undefined || value === '' || value === 'simple') return 'text';
  if (value === 'text' || value === 'detailed' || value === 'json') return value;
  throw new Error('ACCESS_LOG_FORMAT must be text, detailed, or json.');
}

function parseAccountAcquireTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 30_000;
  const timeout = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isInteger(timeout) || timeout < 0 || timeout > 2_147_483_647) {
    throw new Error('ACCOUNT_ACQUIRE_TIMEOUT_MS must be an integer between 0 and 2147483647 ms.');
  }
  return timeout;
}

function parseSseKeepaliveInterval(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 15_000;
  const interval = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isInteger(interval) || interval < 0 || interval > 2_147_483_647) {
    throw new Error('SSE_KEEPALIVE_INTERVAL_MS must be an integer between 0 and 2147483647 ms.');
  }
  return interval;
}

function parseStreamTimeout(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = source[name];
  if (value === undefined) return fallback;
  const number = Number(value);
  const minimum = name === 'CHATGPT_STREAM_TOTAL_TIMEOUT_MS' ? 0 : 1;
  if (!/^\d+$/.test(value.trim()) || !Number.isInteger(number) || number < minimum || number > 2_147_483_647) {
    throw new Error(`${name} must be an integer between ${minimum} and 2147483647 ms.`);
  }
  return number;
}

function parseBoolean(value: string | undefined): boolean { return value?.trim().toLowerCase() === 'true'; }
function parseLogLevel(value: string | undefined): LogLevel { return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info'; }
function parseBackendProvider(value: string | undefined): ChatGptBackendProvider { return value === 'session' ? 'session' : 'mock'; }

function routingEnvironment(source: NodeJS.ProcessEnv): { backendRouting?: BackendRoutingConfig } {
  const gatewayFields = ['CHATGPT_WEB_API_KEY', 'CHATGPT_WEB_MODELS', 'CHATGPT_WEB_SUPPORTS_TOOLS', 'CHATGPT_WEB_SUPPORTS_IMAGES', 'CHATGPT_WEB_MODEL_MAPPINGS'] as const;
  const fields = ['CHATGPT_ROUTING_MODE', 'CHATGPT_AUTO_PREFERENCE', 'CHATGPT_WEB_ENABLED', 'CHATGPT_WEB_BASE_URL', ...gatewayFields] as const;
  if (!fields.some((field) => source[field] !== undefined)) return {};
  const baseUrl = source.CHATGPT_WEB_BASE_URL?.trim();
  if (!baseUrl && gatewayFields.some((field) => source[field] !== undefined)) throw new Error('CHATGPT_WEB_BASE_URL is required for web gateway configuration.');
  const enabledValue = source.CHATGPT_WEB_ENABLED?.trim().toLowerCase();
  if (enabledValue !== undefined && enabledValue !== 'true' && enabledValue !== 'false') throw new Error('CHATGPT_WEB_ENABLED must be true or false.');
  const toolsValue = source.CHATGPT_WEB_SUPPORTS_TOOLS?.trim().toLowerCase();
  if (toolsValue !== undefined && toolsValue !== 'true' && toolsValue !== 'false') throw new Error('CHATGPT_WEB_SUPPORTS_TOOLS must be true or false.');
  const imagesValue = source.CHATGPT_WEB_SUPPORTS_IMAGES?.trim().toLowerCase();
  if (imagesValue !== undefined && imagesValue !== 'true' && imagesValue !== 'false') throw new Error('CHATGPT_WEB_SUPPORTS_IMAGES must be true or false.');
  let modelMappings: unknown;
  if (source.CHATGPT_WEB_MODEL_MAPPINGS !== undefined) {
    try { modelMappings = JSON.parse(source.CHATGPT_WEB_MODEL_MAPPINGS); }
    catch { throw new Error('CHATGPT_WEB_MODEL_MAPPINGS must be a JSON object mapping client model IDs to configured gateway models.'); }
  }
  const apiKey = source.CHATGPT_WEB_API_KEY?.trim();
  return { backendRouting: normalizeBackendRoutingConfig({
    mode: source.CHATGPT_ROUTING_MODE?.trim() ?? 'codex',
    ...(enabledValue === undefined ? {} : { webEnabled: enabledValue === 'true' }),
    ...(source.CHATGPT_AUTO_PREFERENCE === undefined ? {} : { autoPreference: source.CHATGPT_AUTO_PREFERENCE.trim() }),
    ...(baseUrl ? { gateway: {
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      models: source.CHATGPT_WEB_MODELS === undefined ? ['auto'] : readCommaList(source.CHATGPT_WEB_MODELS),
      supportsTools: toolsValue === 'true',
      ...(imagesValue === undefined ? {} : { supportsImages: imagesValue === 'true' }),
      ...(source.CHATGPT_WEB_MODEL_MAPPINGS === undefined ? {} : { modelMappings }),
    } } : {}),
  }) };
}

function parseStateEncryptionKey(value: string | undefined): Uint8Array | undefined {
  if (value === undefined) return undefined;
  const encoded = value;
  if (!encoded || encoded.trim() !== encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('STATE_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('STATE_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  return key;
}
