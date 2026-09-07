import { MockChatGptBackend, SessionChatGptBackend, type ChatGptBackendClient } from '@chatgpt-to-claude/chatgpt-backend';
import type { AppEnv } from '../config/env.js';
import type { AccountPool } from './account-pool.js';
import { CodexOAuthClient } from './codex-oauth-client.js';
import { RefreshAwareChatGptBackend } from './refresh-aware-backend.js';
import { SessionCredentialManager } from './session-credential-manager.js';
import type { DurableRuntimeState } from './durable-runtime-state.js';

export function createChatGptBackend(env: AppEnv, accountPool: AccountPool, durableState?: DurableRuntimeState, outboundFetch?: typeof fetch): ChatGptBackendClient {
  if (env.chatGptBackend === 'session') {
    const transport = new SessionChatGptBackend({ fetch: outboundFetch, baseUrl: env.chatGptBaseUrl, timeoutMs: env.chatGptRequestTimeoutMs, clientVersion: env.codexClientVersion });
    const oauthClient = new CodexOAuthClient({ fetch: outboundFetch, timeoutMs: env.chatGptRequestTimeoutMs, clientVersion: env.codexClientVersion });
    return new RefreshAwareChatGptBackend(transport, new SessionCredentialManager({ accountPool, oauthClient, durableState }));
  }
  return new MockChatGptBackend({ responsePrefix: env.mockResponsePrefix, env: { MOCK_BACKEND_MODELS_JSON: env.mockBackendModelsJson } });
}
