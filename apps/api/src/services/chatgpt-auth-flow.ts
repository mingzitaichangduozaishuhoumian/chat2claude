import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';
import { CodexOAuthClient } from './codex-oauth-client.js';
import type { ProvisionCommitBoundary } from './provision-commit.js';
import { ChatGptProvisioningError } from './setup-provisioner.js';

export type ChatGptAuthFlowState = 'idle' | 'starting' | 'link_ready' | 'waiting' | 'exchanging' | 'provisioning' | 'ready' | 'expired' | 'cancelled' | 'error';

export type ChatGptAuthFlowMode = 'add' | 'reauthorize';
export type ChatGptAuthAccountIntent = { mode: 'add' } | { mode: 'reauthorize'; accountId: string };

export interface ChatGptAuthFlowSnapshot {
  id: string;
  state: ChatGptAuthFlowState;
  mode: ChatGptAuthFlowMode;
  accountId?: string;
  authorizeUrl: string;
  message: string;
  createdAt: string;
  expiresAt: string;
  openedByService?: boolean;
  error?: string;
  provisioned?: boolean;
  provisionResult?: unknown;
  errorStatus?: number;
}

export interface ChatGptAuthFlowServiceOptions {
  now?: () => Date;
  ttlMs?: number;
  fetch?: typeof fetch;
  callbackPort?: number;
  enableCallbackListener?: boolean;
  oauthClient?: CodexOAuthClient;
  oauthRequestTimeoutMs?: number;
  /** @internal Minimal deterministic seam for loopback bind regression tests. */
  callbackServerFactory?: (requestListener: (req: IncomingMessage, res: ServerResponse) => void) => Server;
}

export interface StartChatGptAuthFlowInput {
  returnOrigin?: string;
  mode?: ChatGptAuthFlowMode;
  accountId?: string;
}

export interface CompleteCallbackInput {
  redirectUrl?: string;
  redirect_url?: string;
}

export type ChatGptProvisioner = (secret: ChatGptSessionSecret, target: ChatGptAuthAccountIntent, signal: AbortSignal, commitBoundary: ProvisionCommitBoundary) => Promise<unknown>;

interface InternalFlow extends ChatGptAuthFlowSnapshot {
  oauthState: string;
  codeVerifier?: string;
  redirectUri: string;
  returnOrigin?: string;
  code?: string;
  secret?: ChatGptSessionSecret;
  generation: number;
  operationController?: AbortController;
  exchangePromise?: Promise<void>;
  provisionPromise?: Promise<void>;
  oneTimeProvisionResult?: unknown;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const CALLBACK_PATH = '/auth/callback';
const CALLBACK_HOST_IPV6 = '::1';
const CALLBACK_HOST_IPV4 = '127.0.0.1';
const DEFAULT_CALLBACK_PORT = 1455;
const FALLBACK_CALLBACK_PORT = 1457;
const CALLBACK_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export class ChatGptAuthFlowService {
  private readonly flows = new Map<string, InternalFlow>();
  private readonly flowIdByState = new Map<string, string>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly oauthClient: CodexOAuthClient;
  private readonly callbackServerFactory: NonNullable<ChatGptAuthFlowServiceOptions['callbackServerFactory']>;
  private readonly preferredCallbackPort: number;
  private readonly callbackPortExplicit: boolean;
  private callbackPort: number;
  private callbackServers: Server[] = [];
  private callbackServerReady = false;
  private callbackServerError: string | undefined;
  private callbackListenerPromise: Promise<void> | undefined;

  constructor(private readonly options: ChatGptAuthFlowServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.oauthClient = options.oauthClient ?? new CodexOAuthClient({ fetch: options.fetch, now: this.now, timeoutMs: options.oauthRequestTimeoutMs });
    this.callbackServerFactory = options.callbackServerFactory ?? ((requestListener) => createServer(requestListener));
    this.callbackPortExplicit = options.callbackPort !== undefined;
    this.preferredCallbackPort = options.callbackPort ?? DEFAULT_CALLBACK_PORT;
    this.callbackPort = this.preferredCallbackPort;
  }

  async start(input: StartChatGptAuthFlowInput = {}): Promise<ChatGptAuthFlowSnapshot> {
    const returnOrigin = validateReturnOrigin(input.returnOrigin);
    const target = normalizeAccountIntent(input);
    if (this.options.enableCallbackListener !== false) await this.ensureCallbackListener();
    const id = randomBytes(24).toString('base64url');
    const createdAt = this.now();
    const oauthState = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(64).toString('base64url');
    const redirectUri = callbackRedirectUri(this.callbackPort);
    const flow: InternalFlow = {
      id,
      state: 'link_ready',
      ...target,
      authorizeUrl: this.oauthClient.buildAuthorizeUrl({ state: oauthState, codeVerifier, redirectUri }),
      message: this.callbackServerReady
        ? `请在新窗口完成 Codex OAuth 授权；本地 localhost:${this.callbackPort} callback listener 会通过可用的 IPv6/IPv4 loopback 接收回调。`
        : `请打开或复制 Codex OAuth 授权链接完成授权。授权后如果浏览器显示无法连接 localhost:${this.callbackPort}，请复制地址栏 callback URL 回后台粘贴。${this.callbackServerError ? ' 本地 callback listener 未能启动。' : ''}`,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.ttlMs).toISOString(),
      openedByService: false,
      oauthState,
      codeVerifier,
      redirectUri,
      returnOrigin,
      generation: 0,
    };
    this.flows.set(id, flow);
    this.flowIdByState.set(oauthState, id);
    this.armExpiryDeadline(flow);
    return publicSnapshot(flow);
  }

  async completeCallback(input: CompleteCallbackInput): Promise<ChatGptAuthFlowSnapshot | undefined> {
    const rawRedirectUrl = clean(input.redirectUrl) ?? clean(input.redirect_url);
    if (!rawRedirectUrl) throw new Error('Full OAuth callback URL is required.');
    const prelim = readCallbackParameters(rawRedirectUrl);
    if (!prelim.state) throw new Error('OAuth callback state is required.');
    const flowId = this.flowIdByState.get(prelim.state);
    if (!flowId) return undefined;
    const flow = this.flows.get(flowId);
    if (!flow) {
      this.flowIdByState.delete(prelim.state);
      return undefined;
    }
    const parsed = parseAndValidateCallbackUrl(rawRedirectUrl, flow.redirectUri);
    if (isTerminal(flow.state) || flow.code || flow.secret) return undefined;
    if (this.isExpired(flow)) {
      this.expire(flow);
      return publicSnapshot(flow);
    }
    if (!parsed.error && !parsed.code) throw new Error('OAuth callback code is required.');
    this.flowIdByState.delete(prelim.state);
    if (parsed.error) {
      this.invalidateOperations(flow);
      flow.state = 'error';
      flow.error = 'Codex OAuth authorization was rejected.';
      flow.message = 'Codex OAuth 授权失败，请重新授权。';
      this.clearExpiryDeadline(flow);
      return publicSnapshot(flow);
    }
    flow.code = parsed.code;
    await this.exchangeCode(flow);
    return publicSnapshot(flow);
  }

  async status(id: string): Promise<ChatGptAuthFlowSnapshot | undefined> {
    const flow = this.flows.get(id);
    if (!flow) return undefined;
    if (flow.provisioned) return publicSnapshot(flow);
    if (isTerminal(flow.state)) return publicSnapshot(flow);
    if (this.isExpired(flow)) {
      this.expire(flow);
      return publicSnapshot(flow);
    }
    if (flow.secret?.accessToken) return publicSnapshot(flow);
    if (flow.code) await this.exchangeCode(flow);
    else if (!flow.exchangePromise) {
      flow.state = flow.state === 'link_ready' ? 'waiting' : flow.state;
      flow.message = `请在浏览器完成 Codex OAuth 授权；如果 localhost:${this.callbackPort} callback 失败，请把浏览器地址栏里的完整 callback URL 粘贴到后台。`;
    }
    return publicSnapshot(flow);
  }

  async provision(id: string, provisioner: ChatGptProvisioner): Promise<ChatGptAuthFlowSnapshot | undefined> {
    const flow = this.flows.get(id);
    if (!flow) return undefined;
    if (flow.provisioned || isTerminal(flow.state)) return publicSnapshot(flow);
    if (this.isExpired(flow)) {
      this.expire(flow);
      return publicSnapshot(flow);
    }
    if (!flow.secret?.accessToken) return publicSnapshot(flow);
    if (!flow.provisionPromise) {
      const generation = flow.generation;
      const controller = new AbortController();
      flow.operationController = controller;
      flow.state = 'provisioning';
      flow.message = '正在健康检查、刷新模型并生成 API Key。';
      const secret = { ...flow.secret };
      flow.provisionPromise = (async () => {
        let committed = false;
        const commitBoundary: ProvisionCommitBoundary = (commit) => {
          if (committed) throw new Error('ChatGPT setup provisioning commit was already used.');
          const result = this.commitProvisioning(flow, generation, controller, commit);
          committed = true;
          return result;
        };
        try {
          await provisioner(secret, flow.mode === 'reauthorize' ? { mode: 'reauthorize', accountId: flow.accountId! } : { mode: 'add' }, controller.signal, commitBoundary);
          if (!committed) throw new Error('ChatGPT setup provisioning returned without committing.');
        } catch (error) {
          if (!this.operationIsCurrent(flow, generation, controller)) return;
          if (this.expireIfNeeded(flow)) return;
          const failure = publicProvisioningFailure(error);
          flow.state = 'error';
          flow.error = failure.error;
          flow.message = failure.message;
          flow.errorStatus = failure.status;
          flow.secret = undefined;
          this.clearExpiryDeadline(flow);
        } finally {
          if (flow.operationController === controller) flow.operationController = undefined;
        }
      })();
    }
    await flow.provisionPromise;
    return this.consumeOneTimeProvisionResult(flow);
  }

  async cancel(id: string): Promise<ChatGptAuthFlowSnapshot | undefined> {
    const flow = this.flows.get(id);
    if (!flow) return undefined;
    if (!isTerminal(flow.state) && !flow.provisioned) {
      this.invalidateOperations(flow);
      flow.state = 'cancelled';
      flow.message = '授权流程已取消。';
      this.flowIdByState.delete(flow.oauthState);
      clearFlowSecrets(flow);
      this.clearExpiryDeadline(flow);
    }
    return publicSnapshot(flow);
  }

  async close(): Promise<void> {
    for (const flow of this.flows.values()) {
      this.invalidateOperations(flow);
      this.clearExpiryDeadline(flow);
    }
    await this.callbackListenerPromise?.catch(() => undefined);
    const servers = this.callbackServers;
    this.callbackServers = [];
    this.callbackServerReady = false;
    this.callbackListenerPromise = undefined;
    await closeServers(servers);
  }

  private async exchangeCode(flow: InternalFlow): Promise<void> {
    if (!flow.exchangePromise) {
      const generation = flow.generation;
      const controller = new AbortController();
      flow.operationController = controller;
      flow.state = 'exchanging';
      flow.message = '正在通过 OpenAI Codex OAuth token endpoint 换取访问 token。';
      const code = flow.code;
      const codeVerifier = flow.codeVerifier;
      flow.exchangePromise = (async () => {
        try {
          if (!code || !codeVerifier) throw new Error('OAuth flow is missing exchange credentials.');
          const secret = await this.oauthClient.exchangeCode({ code, codeVerifier, redirectUri: flow.redirectUri, state: flow.oauthState, signal: controller.signal });
          if (!this.operationIsCurrent(flow, generation, controller) || this.expireIfNeeded(flow)) return;
          flow.secret = secret;
          flow.state = 'ready';
          flow.message = 'Codex OAuth 授权成功，正在自动初始化。';
          flow.code = undefined;
          flow.codeVerifier = undefined;
        } catch {
          if (!this.operationIsCurrent(flow, generation, controller)) return;
          if (this.expireIfNeeded(flow)) return;
          flow.state = 'error';
          flow.error = 'Codex OAuth token exchange failed.';
          flow.message = 'Codex OAuth token exchange 失败，可重新授权或使用高级手动导入。';
          flow.code = undefined;
          flow.codeVerifier = undefined;
          this.clearExpiryDeadline(flow);
        } finally {
          if (flow.operationController === controller) flow.operationController = undefined;
        }
      })();
    }
    await flow.exchangePromise;
  }

  private ensureCallbackListener(): Promise<void> {
    if (this.callbackServerReady) return Promise.resolve();
    if (!this.callbackListenerPromise) {
      this.callbackListenerPromise = this.initializeCallbackListener().finally(() => {
        this.callbackListenerPromise = undefined;
      });
    }
    return this.callbackListenerPromise;
  }

  private async initializeCallbackListener(): Promise<void> {
    if (this.callbackServerReady) return;
    this.callbackServerError = undefined;
    const ports = this.callbackPortExplicit ? [this.preferredCallbackPort] : [DEFAULT_CALLBACK_PORT, FALLBACK_CALLBACK_PORT];
    for (const port of ports) {
      if (await this.tryListen(port)) return;
    }
  }

  private async tryListen(port: number): Promise<boolean> {
    const opened: Server[] = [];
    const ipv6 = await this.listenOnLoopback(port, CALLBACK_HOST_IPV6, true);
    if (ipv6.server) opened.push(ipv6.server);
    else if (!isIpv6Unavailable(ipv6.error)) {
      this.callbackServerError = ipv6.error.message;
      return false;
    }

    const ipv4 = await this.listenOnLoopback(port, CALLBACK_HOST_IPV4, false);
    if (!ipv4.server) {
      this.callbackServerError = ipv4.error.message;
      await closeServers(opened);
      return false;
    }
    opened.push(ipv4.server);

    this.callbackServers = opened;
    this.callbackPort = port;
    this.callbackServerReady = true;
    this.callbackServerError = undefined;
    return true;
  }

  private listenOnLoopback(port: number, host: string, ipv6Only: boolean): Promise<{ server: Server; error?: never } | { server?: never; error: NodeJS.ErrnoException }> {
    const server = this.callbackServerFactory((req, res) => { void this.handleCallbackRequest(req, res); });
    return new Promise((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        resolve({ error });
      };
      const onListening = () => {
        server.removeListener('error', onError);
        server.on('error', (error: Error) => {
          this.callbackServerReady = false;
          this.callbackServerError = error.message;
        });
        resolve({ server });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ port, host, ipv6Only });
    });
  }

  private async handleCallbackRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      sendCallbackResponse(res, 404, 'Not Found', false);
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', callbackRedirectUri(this.callbackPort));
    } catch {
      sendCallbackResponse(res, 400, 'Invalid callback', false);
      return;
    }
    if (url.pathname !== CALLBACK_PATH) {
      sendCallbackResponse(res, 404, 'Not Found', false);
      return;
    }
    try {
      const snapshot = await this.completeCallback({ redirectUrl: url.toString() });
      if (!snapshot) {
        sendCallbackResponse(res, 404, '授权流程不存在、已过期或 callback 已使用。', false);
        return;
      }
      if (snapshot.state === 'error') {
        sendCallbackResponse(res, 400, '授权失败，请回到 chat2claude 后台重新授权。', false);
        return;
      }
      const returnOrigin = this.flows.get(snapshot.id)?.returnOrigin;
      if (returnOrigin) {
        const target = new URL('/admin', returnOrigin);
        target.searchParams.set('oauth_flow', snapshot.id);
        sendCallbackRedirect(res, target.toString());
        return;
      }
      sendCallbackResponse(res, 200, '授权已完成，请回到 chat2claude 后台。', true);
    } catch {
      sendCallbackResponse(res, 400, '无效的 OAuth callback。', false);
    }
  }

  private operationIsCurrent(flow: InternalFlow, generation: number, controller: AbortController): boolean {
    return flow.generation === generation && flow.operationController === controller && !controller.signal.aborted && !isTerminal(flow.state);
  }

  private commitProvisioning<T>(flow: InternalFlow, generation: number, controller: AbortController, commit: (committedAt: Date) => T): T {
    if (!this.operationIsCurrent(flow, generation, controller)) throw new Error('ChatGPT setup provisioning was cancelled.');
    const nowMs = this.now().getTime();
    if (nowMs >= Date.parse(flow.expiresAt)) {
      this.expire(flow);
      throw new Error('ChatGPT setup provisioning expired.');
    }
    const result = commit(new Date(nowMs));
    const separated = separateOneTimeProvisionResult(result);
    flow.state = 'ready';
    flow.provisioned = true;
    flow.provisionResult = separated.safeResult;
    flow.oneTimeProvisionResult = separated.oneTimeResult;
    flow.message = 'ChatGPT 授权和 API 初始化已完成。';
    flow.secret = undefined;
    this.clearExpiryDeadline(flow);
    return result;
  }

  private consumeOneTimeProvisionResult(flow: InternalFlow): ChatGptAuthFlowSnapshot {
    const snapshot = publicSnapshot(flow);
    if (flow.oneTimeProvisionResult === undefined) return snapshot;
    const provisionResult = flow.oneTimeProvisionResult;
    flow.oneTimeProvisionResult = undefined;
    return { ...snapshot, provisionResult };
  }

  private expireIfNeeded(flow: InternalFlow): boolean {
    if (!this.isExpired(flow)) return false;
    this.expire(flow);
    return true;
  }

  private isExpired(flow: InternalFlow): boolean {
    return this.now().getTime() >= Date.parse(flow.expiresAt);
  }

  private armExpiryDeadline(flow: InternalFlow): void {
    const delay = Math.max(0, Date.parse(flow.expiresAt) - this.now().getTime());
    const timer = setTimeout(() => {
      if (flow.expiryTimer !== timer || flow.provisioned || isTerminal(flow.state)) return;
      this.expire(flow);
    }, delay);
    timer.unref?.();
    flow.expiryTimer = timer;
  }

  private clearExpiryDeadline(flow: InternalFlow): void {
    if (!flow.expiryTimer) return;
    clearTimeout(flow.expiryTimer);
    flow.expiryTimer = undefined;
  }

  private expire(flow: InternalFlow): void {
    this.invalidateOperations(flow);
    flow.state = 'expired';
    flow.message = '授权流程已过期，请重新点击浏览器授权。';
    this.flowIdByState.delete(flow.oauthState);
    clearFlowSecrets(flow);
    this.clearExpiryDeadline(flow);
  }

  private invalidateOperations(flow: InternalFlow): void {
    flow.generation += 1;
    flow.operationController?.abort();
    flow.operationController = undefined;
    flow.oneTimeProvisionResult = undefined;
  }
}

function publicProvisioningFailure(error: unknown): { error: string; message: string; status?: number } {
  if (!(error instanceof ChatGptProvisioningError)) {
    return {
      error: 'ChatGPT setup provisioning failed.',
      message: '自动初始化失败，可重新授权或使用高级手动导入。',
    };
  }
  const { stage, code, status } = error.diagnostic;
  const details = [code, status === undefined ? undefined : `HTTP ${status}`].filter(Boolean).join(', ');
  const suffix = details ? `（${details}）` : '';
  const action = stage === 'session_verification'
    ? '请重新授权；如果仍失败，请确认账号可使用 Codex。'
    : stage === 'model_preparation'
      ? '请重新授权后重试模型准备。'
      : '请重试；若持续失败，请检查本地运行状态。';
  return {
    error: `${error.diagnostic.message}${suffix}`,
    message: `自动初始化在${provisioningStageLabel(stage)}阶段失败${suffix}。${action}`,
    ...(error.diagnostic.status === undefined ? {} : { status: error.diagnostic.status }),
  };
}

function provisioningStageLabel(stage: ChatGptProvisioningError['diagnostic']['stage']): string {
  return stage === 'session_verification'
    ? '会话验证/模型发现'
    : stage === 'model_preparation'
      ? '模型准备'
      : '状态提交';
}

function isIpv6Unavailable(error: NodeJS.ErrnoException): boolean {
  return error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL' || error.code === 'EPROTONOSUPPORT' || error.code === 'ENOPROTOOPT';
}

async function closeServers(servers: Server[]): Promise<void> {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve());
  })));
}

function callbackRedirectUri(port: number): string {
  return `http://localhost:${port}${CALLBACK_PATH}`;
}

function normalizeAccountIntent(input: StartChatGptAuthFlowInput): ChatGptAuthAccountIntent {
  const mode = input.mode ?? 'add';
  const accountId = clean(input.accountId);
  if (mode === 'add') {
    if (accountId) throw new Error('OAuth add mode must not include accountId.');
    return { mode: 'add' };
  }
  if (mode === 'reauthorize') {
    if (!accountId) throw new Error('OAuth reauthorize mode requires accountId.');
    return { mode, accountId };
  }
  throw new Error('OAuth mode must be add or reauthorize.');
}

function validateReturnOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('OAuth return origin must be an exact HTTP(S) origin.'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash || value !== url.origin) {
    throw new Error('OAuth return origin must be an exact HTTP(S) origin without path, query, hash, or userinfo.');
  }
  return url.origin;
}

interface CallbackParameters { code?: string; state?: string; error?: string }

function readCallbackParameters(rawUrl: string): CallbackParameters {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('OAuth callback URL is invalid.'); }
  const errorDescription = singleParameter(url, 'error_description');
  const error = singleParameter(url, 'error');
  if (errorDescription && error) throw new Error('OAuth callback contains conflicting error parameters.');
  return {
    code: singleParameter(url, 'code'),
    state: singleParameter(url, 'state'),
    error: errorDescription ?? error,
  };
}

function parseAndValidateCallbackUrl(rawUrl: string, expectedRedirectUri: string): CallbackParameters {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('OAuth callback URL is invalid.'); }
  const expected = new URL(expectedRedirectUri);
  if (url.protocol !== expected.protocol || url.hostname !== expected.hostname || url.port !== expected.port || url.pathname !== expected.pathname || url.username || url.password || url.hash) {
    throw new Error('OAuth callback URL does not match this authorization flow.');
  }
  const parsed = readCallbackParameters(rawUrl);
  if (parsed.code && parsed.error) throw new Error('OAuth callback cannot contain both code and error.');
  return parsed;
}

function singleParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new Error(`OAuth callback contains duplicate ${name} parameters.`);
  return clean(values[0]);
}

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function separateOneTimeProvisionResult<T>(result: T): { safeResult: T | Record<string, unknown>; oneTimeResult?: Record<string, unknown> } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { safeResult: result };
  const { apiKey, ...safeResult } = result as Record<string, unknown>;
  if (typeof apiKey !== 'string' || !apiKey) return { safeResult };
  return { safeResult, oneTimeResult: { ...safeResult, apiKey } };
}

function publicSnapshot(flow: InternalFlow): ChatGptAuthFlowSnapshot {
  const { oauthState: _oauthState, codeVerifier: _codeVerifier, redirectUri: _redirectUri, returnOrigin: _returnOrigin, code: _code, secret: _secret, generation: _generation, operationController: _operationController, exchangePromise: _exchangePromise, provisionPromise: _provisionPromise, oneTimeProvisionResult: _oneTimeProvisionResult, expiryTimer: _expiryTimer, ...snapshot } = flow;
  return { ...snapshot };
}

function isTerminal(state: ChatGptAuthFlowState): boolean {
  return state === 'expired' || state === 'cancelled' || state === 'error';
}

function clearFlowSecrets(flow: InternalFlow): void {
  flow.code = undefined;
  flow.codeVerifier = undefined;
  flow.secret = undefined;
}

function sendCallbackRedirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { ...CALLBACK_HEADERS, location, 'content-length': '0' });
  res.end();
}

function sendCallbackResponse(res: ServerResponse, status: number, message: string, html: boolean): void {
  const headers = { ...CALLBACK_HEADERS, 'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' };
  res.writeHead(status, headers);
  res.end(html
    ? `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Codex OAuth</title></head><body><h1>${escapeHtml(message)}</h1></body></html>`
    : message);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
