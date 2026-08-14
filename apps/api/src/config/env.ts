import { readCommaList, readNumber, type LogLevel } from '@chatgpt-to-claude/shared';
import { normalizeReasoningEffort, normalizeSpeedPreference, type ReasoningEffort, type SpeedPreference } from '@chatgpt-to-claude/protocol-mapper';

export type ChatGptBackendProvider = 'mock' | 'session';

export interface AppEnv {
  port: number;
  host: string;
  apiKeys: string[];
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
  return {
    port: readNumber(source.PORT, 3000),
    host: source.HOST ?? '0.0.0.0',
    apiKeys: readCommaList(source.API_KEYS),
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

function parseLogLevel(value: string | undefined): LogLevel { return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info'; }
function parseBackendProvider(value: string | undefined): ChatGptBackendProvider { return value === 'session' ? 'session' : 'mock'; }
