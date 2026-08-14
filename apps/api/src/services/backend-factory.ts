import { MockChatGptBackend, SessionChatGptBackend, type ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import type { AppEnv } from '../config/env.js';

export function createChatGptBackend(env: AppEnv): ChatGptBackendClient {
  if (env.chatGptBackend === 'session') {
    return new SessionChatGptBackend({ baseUrl: env.chatGptBaseUrl, timeoutMs: env.chatGptRequestTimeoutMs });
  }
  return new MockChatGptBackend({ responsePrefix: env.mockResponsePrefix, env: { MOCK_BACKEND_MODELS_JSON: env.mockBackendModelsJson } });
}
