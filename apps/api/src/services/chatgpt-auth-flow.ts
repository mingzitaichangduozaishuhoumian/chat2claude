import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';

export type ChatGptAuthFlowState = 'idle' | 'starting' | 'link_ready' | 'waiting' | 'exchanging' | 'provisioning' | 'ready' | 'expired' | 'cancelled' | 'error';

export interface ChatGptAuthFlowSnapshot {
  id: string;
  state: ChatGptAuthFlowState;
  authorizeUrl: string;
  message: string;
  createdAt: string;
  expiresAt: string;
  openedByService?: boolean;
  secret?: ChatGptSessionSecret;
  error?: string;
  provisioned?: boolean;
  provisionResult?: unknown;
}

export interface ChatGptAuthFlowServiceOptions {
  now?: () => Date;
  ttlMs?: number;
  fetch?: typeof fetch;
  callbackPort?: number;
  enableCallbackListener?: boolean;
}

export interface CompleteCallbackInput {
  redirectUrl?: string;
  redirect_url?: string;
  code?: string;
  state?: string;
}

interface InternalFlow extends ChatGptAuthFlowSnapshot {
  oauthState: string;
  codeVerifier: string;
  code?: string;
  callbackError?: string;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CALLBACK_PATH = '/auth/callback';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 1455;
const CALLBACK_REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

export class ChatGptAuthFlowService {
  private readonly flows = new Map<string, InternalFlow>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly callbackPort: number;
  private callbackServer: Server | undefined;
  private callbackServerReady = false;
  private callbackServerError: string | undefined;

  constructor(private readonly options: ChatGptAuthFlowServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = options.fetch ?? fetch;
    this.callbackPort = options.callbackPort ?? CALLBACK_PORT;
  }

  async start(): Promise<ChatGptAuthFlowSnapshot> {
    const id = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = this.now();
    const oauthState = randomUrlSafe(32);
    const codeVerifier = randomUrlSafe(64);
    const authorizeUrl = buildAuthorizeUrl(oauthState, codeVerifier, this.callbackPort);
    const flow: InternalFlow = {
      id,
      state: 'starting',
      authorizeUrl,
      message: '已生成 Codex OAuth 授权链接，请在当前浏览器中打开完成授权。',
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.ttlMs).toISOString(),
      openedByService: false,
      oauthState,
      codeVerifier,
    };
    this.flows.set(id, flow);

    if (this.options.enableCallbackListener !== false) await this.ensureCallbackListener();
    flow.state = 'link_ready';
    flow.message = this.callbackServerReady
      ? '请复制或点击 Codex OAuth 授权链接，在当前浏览器完成授权；本地 127.0.0.1:1455 会接收回调。'
      : `请复制或点击 Codex OAuth 授权链接完成授权。授权后如果浏览器显示无法连接 localhost:1455，请复制地址栏 callback URL 回后台粘贴。${this.callbackServerError ? ` (${this.callbackServerError})` : ''}`;
    return publicSnapshot(flow);
  }

  async completeCallback(input: CompleteCallbackInput): Promise<ChatGptAuthFlowSnapshot | undefined> {
    const parsed = parseCallbackInput(input);
    if (!parsed.state) throw new Error('OAuth callback state is required.');
    const flow = [...this.flows.values()].find((item) => item.oauthState === parsed.state);
    if (!flow) return undefined;
    if (isTerminal(flow.state)) return publicSnapshot(flow);
    if (this.now().getTime() >= Date.parse(flow.expiresAt)) {
      flow.state = 'expired';
      flow.message = '授权流程已过期，请重新点击浏览器授权。';
      return publicSnapshot(flow);
    }
    if (parsed.error) {
      flow.state = 'error';
      flow.error = parsed.error;
      flow.message = `Codex OAuth 授权失败：${parsed.error}`;
      return publicSnapshot(flow);
    }
    if (!parsed.code) throw new Error('OAuth callback code is required.');
    flow.code = parsed.code;
    flow.state = 'waiting';
    flow.message = '已收到 Codex OAuth callback，正在等待后台轮询换取 token。';
    return publicSnapshot(flow);
  }

  async status(id: string): Promise<ChatGptAuthFlowSnapshot | undefined> {
    const flow = this.flows.get(id);
    if (!flow) return undefined;
    if (isTerminal(flow.state)) return publicSnapshot(flow);
    if (this.now().getTime() >= Date.parse(flow.expiresAt)) {
      flow.state = 'expired';
      flow.message = '授权流程已过期，请重新点击浏览器授权。';
      return publicSnapshot(flow);
    }

    if (flow.secret?.accessToken) return publicSnapshot(flow);
    if (flow.code) {
      await this.exchangeCode(flow);
      return publicSnapshot(flow);
    }
    flow.state = flow.state === 'link_ready' ? 'waiting' : flow.state;
    flow.message = '请在浏览器完成 Codex OAuth 授权；如果 localhost callback 失败，请把浏览器地址栏里的完整 callback URL 粘贴到后台。';
    return publicSnapshot(flow);
  }

  async cancel(id: string): Promise<ChatGptAuthFlowSnapshot | undefined> {
    const flow = this.flows.get(id);
    if (!flow) return undefined;
    if (!isTerminal(flow.state)) {
      flow.state = 'cancelled';
      flow.message = '授权流程已取消。';
    }
    return publicSnapshot(flow);
  }

  getSecret(id: string): ChatGptSessionSecret | undefined {
    const secret = this.flows.get(id)?.secret;
    return secret ? { ...secret } : undefined;
  }

  markProvisioning(id: string): void {
    const flow = this.flows.get(id);
    if (flow && flow.state === 'ready' && !flow.provisioned) {
      flow.state = 'provisioning';
      flow.message = '正在健康检查、刷新模型并生成 API Key。';
    }
  }

  markProvisioned(id: string, provisionResult: unknown): ChatGptAuthFlowSnapshot | undefined {
    const flow = this.flows.get(id);
    if (!flow) return undefined;
    flow.state = 'ready';
    flow.provisioned = true;
    flow.provisionResult = provisionResult;
    flow.message = 'ChatGPT 授权和 API 初始化已完成。';
    return publicSnapshot(flow);
  }

  markError(id: string, error: unknown): ChatGptAuthFlowSnapshot | undefined {
    const flow = this.flows.get(id);
    if (!flow) return undefined;
    flow.state = 'error';
    flow.error = error instanceof Error ? error.message : String(error);
    flow.message = '自动初始化失败，可重新授权或使用高级手动导入。';
    return publicSnapshot(flow);
  }

  private async exchangeCode(flow: InternalFlow): Promise<void> {
    flow.state = 'exchanging';
    flow.message = '正在通过 OpenAI Codex OAuth token endpoint 换取访问 token。';
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: OPENAI_CODEX_CLIENT_ID,
        code: flow.code ?? '',
        redirect_uri: callbackRedirectUri(this.callbackPort),
        code_verifier: flow.codeVerifier,
      });
      const response = await this.fetchImpl(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(readString(payload.error_description) ?? readString(payload.error) ?? `HTTP ${response.status}`);
      const accessToken = readString(payload.access_token);
      if (!accessToken) throw new Error('OAuth token response missing access_token.');
      flow.secret = {
        type: 'chatgpt-session',
        accessToken,
        refreshToken: readString(payload.refresh_token),
        idToken: readString(payload.id_token),
        expiresAt: typeof payload.expires_in === 'number' ? new Date(this.now().getTime() + payload.expires_in * 1000).toISOString() : undefined,
      };
      flow.state = 'ready';
      flow.message = 'Codex OAuth 授权成功，正在自动初始化。';
    } catch (error) {
      flow.state = 'error';
      flow.error = error instanceof Error ? error.message : String(error);
      flow.message = 'Codex OAuth token exchange 失败，可重新授权或使用高级手动导入。';
    }
  }

  private async ensureCallbackListener(): Promise<void> {
    if (this.callbackServerReady || this.callbackServer) return;
    this.callbackServerError = undefined;
    const server = createServer((req, res) => this.handleCallbackRequest(req, res));
    this.callbackServer = server;
    await new Promise<void>((resolvePromise) => {
      server.once('error', (error) => {
        this.callbackServer = undefined;
        this.callbackServerReady = false;
        this.callbackServerError = error instanceof Error ? error.message : String(error);
        resolvePromise();
      });
      server.listen(this.callbackPort, CALLBACK_HOST, () => {
        this.callbackServerReady = true;
        resolvePromise();
      });
    });
  }

  private handleCallbackRequest(req: IncomingMessage, res: ServerResponse): void {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${this.callbackPort}`);
      if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      void this.completeCallback({ code: url.searchParams.get('code') ?? undefined, state: url.searchParams.get('state') ?? undefined, redirectUrl: url.toString() }).finally(() => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>授权已完成</title><body><h1>授权已完成</h1><p>请回到 chat2claude 后台。</p></body></html>');
      });
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Invalid callback');
    }
  }
}

function buildAuthorizeUrl(state: string, codeVerifier: string, callbackPort: number): string {
  const url = new URL(OPENAI_AUTHORIZE_URL);
  // Codex CLI / CLIProxyAPI compatible public OAuth client. This is not a user secret.
  url.searchParams.set('client_id', OPENAI_CODEX_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', callbackRedirectUri(callbackPort));
  url.searchParams.set('scope', 'openid email profile offline_access');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'login');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  return url.toString();
}

function callbackRedirectUri(callbackPort: number): string {
  return callbackPort === CALLBACK_PORT ? CALLBACK_REDIRECT_URI : `http://localhost:${callbackPort}${CALLBACK_PATH}`;
}

function parseCallbackInput(input: CompleteCallbackInput): { code?: string; state?: string; error?: string } {
  const redirectUrl = input.redirectUrl ?? input.redirect_url;
  if (redirectUrl) {
    const url = new URL(redirectUrl);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
      error: url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? undefined,
    };
  }
  return { code: input.code?.trim() || undefined, state: input.state?.trim() || undefined };
}

function publicSnapshot(flow: InternalFlow): ChatGptAuthFlowSnapshot {
  const { secret: _secret, codeVerifier: _codeVerifier, oauthState: _oauthState, code: _code, callbackError: _callbackError, ...snapshot } = flow;
  return { ...snapshot };
}

function isTerminal(state: ChatGptAuthFlowState): boolean {
  return state === 'expired' || state === 'cancelled' || state === 'error';
}

function randomUrlSafe(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
