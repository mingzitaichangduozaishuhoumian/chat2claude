import { MockChatGptBackend, SessionChatGptBackend, type ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import type { AppEnv } from '../config/env.js';
import type { AccountPool } from './account-pool.js';
import { CODEX_OAUTH_ORIGINATOR, CodexOAuthClient } from './codex-oauth-client.js';
import { RefreshAwareChatGptBackend } from './refresh-aware-backend.js';
import { SessionCredentialManager } from './session-credential-manager.js';
import type { DurableRuntimeState } from './durable-runtime-state.js';

export function createChatGptBackend(env: AppEnv, accountPool: AccountPool, durableState?: DurableRuntimeState): ChatGptBackendClient {
  if (env.chatGptBackend === 'session') {
    const transport = new SessionChatGptBackend({ baseUrl: env.chatGptBaseUrl, timeoutMs: env.chatGptRequestTimeoutMs, originator: CODEX_OAUTH_ORIGINATOR });
    const oauthClient = new CodexOAuthClient({ timeoutMs: env.chatGptRequestTimeoutMs });
    return new RefreshAwareChatGptBackend(transport, new SessionCredentialManager({ accountPool, oauthClient, durableState }));
  }
  return new MockChatGptBackend({ responsePrefix: env.mockResponsePrefix, env: { MOCK_BACKEND_MODELS_JSON: env.mockBackendModelsJson } });
}
