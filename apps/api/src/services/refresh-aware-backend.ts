import { ChatGptBackendError, type ChatGptBackendClient, type ChatGptBackendHealthCheckResult, type ChatGptBackendRequestContext, type ChatGptCompletionRequest, type ChatGptCompletionResponse, type ChatGptDiscoveredModel } from '@chatgpt-to-claude/chatgpt-backend';
import type { ChatGptStreamEvent } from '@chatgpt-to-claude/chatgpt-backend';
import { markAccountCredentialError } from './account-pool.js';
import type { SessionCredentialManager } from './session-credential-manager.js';

const CANDIDATE_CONTEXT = Symbol('candidateSessionContext');
type InternalRequestContext = ChatGptBackendRequestContext & { [CANDIDATE_CONTEXT]?: true };

export function candidateSessionContext(account: NonNullable<ChatGptBackendRequestContext['account']>, signal?: AbortSignal): ChatGptBackendRequestContext {
  return { account, signal, [CANDIDATE_CONTEXT]: true } as InternalRequestContext;
}

export class RefreshAwareChatGptBackend implements ChatGptBackendClient {
  constructor(
    private readonly transport: ChatGptBackendClient,
    private readonly credentials: SessionCredentialManager,
  ) {}

  async listModels(context?: ChatGptBackendRequestContext): Promise<ChatGptDiscoveredModel[]> {
    return this.withOneUnauthorizedRetry(context, (freshContext) => this.transport.listModels(freshContext));
  }

  async healthCheck(context?: ChatGptBackendRequestContext): Promise<ChatGptBackendHealthCheckResult> {
    try {
      await this.listModels(context);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'ChatGPT session health check failed.' };
    }
  }

  async complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse> {
    return this.withOneUnauthorizedRetry(context, (freshContext) => this.transport.complete(request, freshContext));
  }

  async *stream(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): AsyncIterable<ChatGptStreamEvent> {
    if (!context?.account || isCandidateContext(context)) {
      yield* this.transport.stream(request, context);
      return;
    }
    let account = await this.credentials.getFreshAccount(context.account);
    let yielded = false;
    try {
      for await (const event of this.transport.stream(request, { ...context, account })) {
        yielded = true;
        yield event;
      }
      return;
    } catch (error) {
      if (yielded || !isUnauthorized(error)) throw markAccountCredentialError(error, account);
    }

    const failedAccessToken = account.secret?.accessToken;
    account = await this.credentials.getFreshAccount(context.account, failedAccessToken);
    try {
      yield* this.transport.stream(request, { ...context, account });
    } catch (error) {
      throw markAccountCredentialError(error, account);
    }
  }

  private async withOneUnauthorizedRetry<T>(context: ChatGptBackendRequestContext | undefined, request: (context: ChatGptBackendRequestContext | undefined) => Promise<T>): Promise<T> {
    if (!context?.account || isCandidateContext(context)) return request(context);
    let account = await this.credentials.getFreshAccount(context.account);
    try {
      return await request({ ...context, account });
    } catch (error) {
      if (!isUnauthorized(error)) throw markAccountCredentialError(error, account);
    }
    const failedAccessToken = account.secret?.accessToken;
    account = await this.credentials.getFreshAccount(context.account, failedAccessToken);
    try {
      return await request({ ...context, account });
    } catch (error) {
      throw markAccountCredentialError(error, account);
    }
  }
}

function isCandidateContext(context: ChatGptBackendRequestContext): boolean {
  return (context as InternalRequestContext)[CANDIDATE_CONTEXT] === true;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ChatGptBackendError && error.code === 'unauthorized';
}
