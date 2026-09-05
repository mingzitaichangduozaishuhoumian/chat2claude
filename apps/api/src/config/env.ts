import { resolve } from 'node:path';
import { normalizeCodexClientVersion } from '@chatgpt-to-claude/chatgpt-backend';
import { fileURLToPath } from 'node:url';
import { readCommaList, readNumber, type LogLevel } from '@chatgpt-to-claude/shared';
import { normalizeReasoningEffort, normalizeSpeedPreference, type ReasoningEffort, type SpeedPreference } from '@chatgpt-to-claude/protocol-mapper';

export type ChatGptBackendProvider = 'mock' | 'session';

export interface AppEnv {
  port: number;
  host: string;
  apiKeys: string[];
  allowAnonymousBootstrap: boolean;
  localContainerBootstrap: boolean;
  logLevel: LogLevel;
  mockResponsePrefix: string;
  mockBackendModelsJson?: string;
  chatGptBackend: ChatGptBackendProvider;
  chatGptBaseUrl: string;
  chatGptRequestTimeoutMs: number;
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
    mockResponsePrefix: source.MOCK_RESPONSE_PREFIX ?? 'Echo:',
    mockBackendModelsJson: source.MOCK_BACKEND_MODELS_JSON,
    chatGptBackend: parseBackendProvider(source.CHATGPT_BACKEND),
    chatGptBaseUrl: source.CHATGPT_BASE_URL?.trim() || 'https://chatgpt.com',
    chatGptRequestTimeoutMs: readNumber(source.CHATGPT_REQUEST_TIMEOUT_MS, 60000),
    codexClientVersion: normalizeCodexClientVersion(source.CODEX_CLIENT_VERSION),
    defaultReasoningEffort: normalizeReasoningEffort(source.DEFAULT_REASONING_EFFORT),
    defaultResponseSpeed: normalizeSpeedPreference(source.DEFAULT_RESPONSE_SPEED),
    dataDir,
    runtimeStatePath: resolve(dataDir, 'runtime-state.json'),
    operationalStatePath: resolve(dataDir, 'admin-operational-state.json'),
    stateEncryptionKey: parseStateEncryptionKey(source.STATE_ENCRYPTION_KEY),
  };
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function parseBoolean(value: string | undefined): boolean { return value?.trim().toLowerCase() === 'true'; }
function parseLogLevel(value: string | undefined): LogLevel { return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info'; }
function parseBackendProvider(value: string | undefined): ChatGptBackendProvider { return value === 'session' ? 'session' : 'mock'; }

function parseStateEncryptionKey(value: string | undefined): Uint8Array | undefined {
  if (value === undefined) return undefined;
  const encoded = value;
  if (!encoded || encoded.trim() !== encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('STATE_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('STATE_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  return key;
}
