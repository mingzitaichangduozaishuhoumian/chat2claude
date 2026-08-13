import { readCommaList, readNumber, type LogLevel } from '@chatgpt-to-claude/shared';
import { normalizeReasoningEffort, normalizeSpeedPreference, type ReasoningEffort, type SpeedPreference } from '@chatgpt-to-claude/protocol-mapper';
export interface AppEnv { port: number; host: string; apiKeys: string[]; logLevel: LogLevel; mockResponsePrefix: string; mockBackendModelsJson?: string; defaultReasoningEffort: ReasoningEffort; defaultResponseSpeed: SpeedPreference; }
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return { port: readNumber(source.PORT, 3000), host: source.HOST ?? '0.0.0.0', apiKeys: readCommaList(source.API_KEYS), logLevel: parseLogLevel(source.LOG_LEVEL), mockResponsePrefix: source.MOCK_RESPONSE_PREFIX ?? 'Echo:', mockBackendModelsJson: source.MOCK_BACKEND_MODELS_JSON, defaultReasoningEffort: normalizeReasoningEffort(source.DEFAULT_REASONING_EFFORT), defaultResponseSpeed: normalizeSpeedPreference(source.DEFAULT_RESPONSE_SPEED) };
}
function parseLogLevel(value: string | undefined): LogLevel { return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info'; }
