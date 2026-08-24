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
  defaultReasoningEffort: ReasoningEffort;
  defaultResponseSpeed: SpeedPreference;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const host = source.HOST?.trim() || '127.0.0.1';
  const apiKeys = readCommaList(source.API_KEYS);
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
    defaultReasoningEffort: normalizeReasoningEffort(source.DEFAULT_REASONING_EFFORT),
    defaultResponseSpeed: normalizeSpeedPreference(source.DEFAULT_RESPONSE_SPEED),
  };
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function parseBoolean(value: string | undefined): boolean { return value?.trim().toLowerCase() === 'true'; }
function parseLogLevel(value: string | undefined): LogLevel { return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info'; }
function parseBackendProvider(value: string | undefined): ChatGptBackendProvider { return value === 'session' ? 'session' : 'mock'; }
