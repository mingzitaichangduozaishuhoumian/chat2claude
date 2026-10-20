import { ChatGptBackendError, MockChatGptBackend, SessionChatGptBackend, type ChatGptBackendClient, type ChatGptBackendRequestContext } from '@chatgpt-to-claude/chatgpt-backend';
import type { AppEnv } from '../config/env.js';
import type { AccountPool } from './account-pool.js';
import { CodexOAuthClient } from './codex-oauth-client.js';
import { RefreshAwareChatGptBackend } from './refresh-aware-backend.js';
import { SessionCredentialManager } from './session-credential-manager.js';
import type { DurableRuntimeState } from './durable-runtime-state.js';
import { assertRequestHistoryBinding } from './request-history-binding.js';

export function createChatGptBackend(env: AppEnv, accountPool: AccountPool, durableState?: DurableRuntimeState, outboundFetch?: typeof fetch): ChatGptBackendClient {
  if (env.chatGptBackend === 'session') {
    const transport = new SessionChatGptBackend({
      fetch: outboundFetch, baseUrl: env.chatGptBaseUrl, clientVersion: env.codexClientVersion,
      requestTimeoutMs: env.chatGptRequestTimeoutMs,
      imageRequestTimeoutMs: env.chatGptImageRequestTimeoutMs ?? 300_000,
      responseHeaderTimeoutMs: env.chatGptResponseHeaderTimeoutMs ?? 60_000,
      streamBootstrapTimeoutMs: env.chatGptStreamBootstrapTimeoutMs ?? 60_000,
      streamIdleTimeoutMs: env.chatGptStreamIdleTimeoutMs ?? 300_000,
      streamTotalTimeoutMs: env.chatGptStreamTotalTimeoutMs ?? 0,
    });
    const oauthClient = new CodexOAuthClient({ fetch: outboundFetch, timeoutMs: env.chatGptRequestTimeoutMs, clientVersion: env.codexClientVersion });
    return new RefreshAwareChatGptBackend(transport, new SessionCredentialManager({ accountPool, oauthClient, durableState }));
  }
  return new MockChatGptBackend({ responsePrefix: env.mockResponsePrefix, env: { MOCK_BACKEND_MODELS_JSON: env.mockBackendModelsJson } });
}

/** Transport dispatch follows the acquired account, never the requested model name. */
export function withWebGatewayBackend(primary: ChatGptBackendClient, web: ChatGptBackendClient, pool: AccountPool, webEnabled: () => boolean = () => true): ChatGptBackendClient {
  const select = (context?: ChatGptBackendRequestContext) => {
    if (context?.account?.provider !== 'chatgpt-web') return primary;
    if (!webEnabled()) throw new ChatGptBackendError('ChatGPT web access is disabled.', 'invalid_request');
    const current = pool.get(context.account.id);
    if (!current || current.provider !== 'chatgpt-web' || !current.enabled
      || ('incarnation' in context.account && context.account.incarnation !== current.incarnation)) {
      throw new ChatGptBackendError('Web gateway configuration changed before dispatch.', 'invalid_request');
    }
    return web;
  };
  const backend: ChatGptBackendClient = {
    complete(request, context) {
      assertRequestHistoryBinding(request, context);
      return select(context).complete(request, context);
    },
    async *stream(request, context) {
      assertRequestHistoryBinding(request, context);
      yield* select(context).stream(request, context);
    },
    listModels: (context) => select(context).listModels(context),
    healthCheck: (context) => select(context).healthCheck?.(context) ?? Promise.resolve({ ok: false }),
  };
  if (primary.discoverModels) backend.discoverModels = async (context) => {
    const target = select(context);
    return target.discoverModels ? target.discoverModels(context) : { status: 'success', models: await target.listModels(context) };
  };
  if (primary.generateImages) backend.generateImages = (request, context) => {
    if (select(context) === web) throw new ChatGptBackendError('Web gateway image generation is not supported.', 'invalid_request');
    return primary.generateImages!(request, context);
  };
  if (primary.getAccountQuota) backend.getAccountQuota = (context) => {
    if (select(context) === web) throw new ChatGptBackendError('Web gateway quota lookup is not supported.', 'invalid_request');
    return primary.getAccountQuota!(context);
  };
  if (primary.consumeAccountResetCredit) backend.consumeAccountResetCredit = (requestId, context) => {
    if (select(context) === web) throw new ChatGptBackendError('Web gateway quota reset is not supported.', 'invalid_request');
    return primary.consumeAccountResetCredit!(requestId, context);
  };
  return backend;
}
