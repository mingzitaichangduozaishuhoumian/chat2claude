import type { Context } from 'hono';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import { supportsWebGatewayRequest, type ChatGptCompletionRequest } from '@chatgpt-to-claude/chatgpt-backend';
import type { Account, AccountAcquireOptions, AccountPool, AccountProvider } from './account-pool.js';
import type { BackendRouting, BackendRoutingMode } from './backend-routing.js';
import { checkSessionAccountAvailability } from '../routes/account-acquisition.js';

export interface RequestRoutingDeps { backendProvider?: 'mock' | 'session'; backendRouting?: BackendRouting; accountPool: AccountPool; }

export function requestBackendMode(c: Context, routing?: BackendRouting): BackendRoutingMode {
  const override = c.req.header('x-chat2claude-backend');
  if (override !== undefined && override !== 'auto' && override !== 'codex' && override !== 'web') {
    throw new ClaudeApiError('x-chat2claude-backend must be auto, codex, or web.', 400, 'invalid_request_error');
  }
  if (override === 'web' && !routing?.isWebEnabled()) {
    throw new ClaudeApiError('ChatGPT web access is disabled by the administrator.', 403, 'permission_error');
  }
  const mode = override ?? routing?.snapshot().mode ?? 'codex';
  return mode === 'web' && !routing?.isWebEnabled() ? 'codex' : mode;
}

export function checkRequestBackendAvailability(c: Context, deps: RequestRoutingDeps): void {
  const mode = requestBackendMode(c, deps.backendRouting);
  if (mode === 'web' && !deps.backendRouting?.snapshot().gateway) {
    throw new ClaudeApiError('ChatGPT web gateway is not configured.', 503, 'overloaded_error');
  }
  if (mode === 'web') {
    const reason = deps.accountPool.unavailableReason({ provider: 'chatgpt-web', capability: 'messages' });
    if (reason && reason !== 'account_busy') throw new ClaudeApiError('No available ChatGPT web gateway account.', 503, 'overloaded_error');
  }
  if (deps.backendProvider === 'session' && (mode === 'codex' || !deps.backendRouting?.isWebEnabled() || !deps.backendRouting?.snapshot().gateway)) {
    checkSessionAccountAvailability(c, deps.accountPool);
  }
}

/** Selection happens before dispatch. No cross-provider retry after a request is sent. */
export function requestAccountOptions(c: Context, deps: RequestRoutingDeps, request: ChatGptCompletionRequest, eligible: (account: Account) => boolean, clientModel = request.model, declaredModel = request.model): AccountAcquireOptions {
  const mode = requestBackendMode(c, deps.backendRouting);
  const configuration = deps.backendRouting?.snapshot();
  const gateway = deps.backendRouting?.isWebEnabled() ? configuration?.gateway : undefined;
  const primary: AccountProvider = deps.backendProvider === 'session' ? 'chatgpt-session' : 'mock';
  const mappings = gateway?.modelMappings;
  const mapped = mappings && Object.hasOwn(mappings, clientModel) ? mappings[clientModel]
    : mappings && Object.hasOwn(mappings, declaredModel) ? mappings[declaredModel] : request.model;
  const webCompatible = supportsWebGatewayRequest({ ...request, model: mapped }, gateway);
  const preferred = configuration?.autoPreference === 'web' ? 'chatgpt-web' : primary;
  if (mode === 'web' && !webCompatible) {
    throw new ClaudeApiError('The configured web gateway does not support the requested model or capabilities.', 400, 'invalid_request_error');
  }
  return {
    ...(mode === 'auto' ? {} : { provider: mode === 'web' ? 'chatgpt-web' as const : primary }),
    capability: 'messages',
    priority: (account) => account.provider === preferred ? 0 : 1,
    eligible: (account) => (account.provider === primary || account.provider === 'chatgpt-web' && webCompatible)
      && eligible(account),
  };
}

export function markSelectedBackend(c: Context, account: Account): void {
  c.header('x-chat2claude-backend', account.provider === 'chatgpt-web' ? 'web' : account.provider === 'chatgpt-session' ? 'codex' : 'mock');
}
