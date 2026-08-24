import { createHash } from 'node:crypto';
import { ChatGptBackendError, type ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';

export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
export const CODEX_OAUTH_ORIGINATOR = 'chat2claude';
const DEFAULT_OAUTH_REQUEST_TIMEOUT_MS = 60_000;

export interface CodexOAuthClientOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export interface CodexAuthorizationInput {
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface CodexCodeExchangeInput extends CodexAuthorizationInput {
  code: string;
  signal?: AbortSignal;
}

export class CodexOAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: CodexOAuthClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
  }

  buildAuthorizeUrl(input: CodexAuthorizationInput): string {
    const url = new URL(CODEX_AUTHORIZE_URL);
    url.searchParams.set('client_id', CODEX_OAUTH_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', CODEX_OAUTH_SCOPE);
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', createHash('sha256').update(input.codeVerifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'login');
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    url.searchParams.set('originator', CODEX_OAUTH_ORIGINATOR);
    return url.toString();
  }

  async exchangeCode(input: CodexCodeExchangeInput): Promise<ChatGptSessionSecret> {
    return this.requestToken(new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_OAUTH_CLIENT_ID,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }), undefined, input.signal);
  }

  async refreshSecret(current: ChatGptSessionSecret, signal?: AbortSignal): Promise<ChatGptSessionSecret> {
    const refreshToken = current.refreshToken?.trim();
    if (!refreshToken) throw new ChatGptBackendError('ChatGPT session cannot be refreshed because no refresh token is available.', 'unauthorized', { status: 401 });
    const refreshed = await this.requestToken(new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CODEX_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }), current, signal);
    return {
      ...current,
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? current.refreshToken,
    };
  }

  private async requestToken(body: URLSearchParams, current?: ChatGptSessionSecret, signal?: AbortSignal): Promise<ChatGptSessionSecret> {
    let response: Response;
    let payload: Record<string, unknown> | undefined;
    try {
      ({ response, payload } = await withDeadline(async (requestSignal) => {
        const tokenResponse = await this.fetchImpl(CODEX_TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: requestSignal,
        });
        const tokenPayload = await tokenResponse.json().catch(() => undefined) as Record<string, unknown> | undefined;
        return { response: tokenResponse, payload: tokenPayload };
      }, signal, this.timeoutMs));
    } catch (error) {
      if (error instanceof OAuthRequestTimeoutError) {
        throw new ChatGptBackendError('Codex OAuth token request timed out.', 'timeout', { status: 504, cause: error });
      }
      throw new ChatGptBackendError('Codex OAuth token request failed.', 'network_error', { cause: error });
    }

    if (!response.ok) {
      const code = response.status === 429
        ? 'rate_limited'
        : response.status === 400 || response.status === 401 || response.status === 403
          ? 'unauthorized'
          : 'upstream_error';
      throw new ChatGptBackendError('Codex OAuth token request was rejected.', code, { status: response.status });
    }
    const accessToken = readString(payload?.access_token);
    if (!accessToken) throw new ChatGptBackendError('Codex OAuth token response was invalid.', 'invalid_response');
    const expiresIn = readFiniteNumber(payload?.expires_in);
    return {
      ...(current ?? {}),
      type: 'chatgpt-session',
      accessToken,
      refreshToken: readString(payload?.refresh_token) ?? current?.refreshToken,
      idToken: readString(payload?.id_token) ?? current?.idToken,
      expiresAt: expiresIn === undefined ? current?.expiresAt : new Date(this.now().getTime() + expiresIn * 1000).toISOString(),
    };
  }
}

class OAuthRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Codex OAuth token request exceeded ${timeoutMs}ms.`);
    this.name = 'OAuthRequestTimeoutError';
  }
}

async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, externalSignal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  let timedOut = false;
  let timeoutError: OAuthRequestTimeoutError | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
    rejectAbort(reason);
  };
  const onExternalAbort = () => abort(externalSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutError = new OAuthRequestTimeoutError(timeoutMs);
    abort(timeoutError);
  }, timeoutMs);

  try {
    return await Promise.race([
      operation(controller.signal),
      aborted,
    ]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

function normalizeTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_OAUTH_REQUEST_TIMEOUT_MS;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
