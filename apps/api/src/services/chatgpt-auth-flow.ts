import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
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

export interface ChatGptAuthDriverStartResult {
  authorizeUrl: string;
  message: string;
  openedByService?: boolean;
}

export interface ChatGptAuthDriver {
  start(): Promise<ChatGptAuthDriverStartResult>;
  readSecret(): Promise<ChatGptSessionSecret | undefined>;
  cancel?(): Promise<void> | void;
}

export interface ChatGptAuthFlowServiceOptions {
  driverFactory?: () => ChatGptAuthDriver;
  now?: () => Date;
  ttlMs?: number;
}

interface InternalFlow extends ChatGptAuthFlowSnapshot {
  driver: ChatGptAuthDriver;
}

const CHATGPT_URL = 'https://chatgpt.com/';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class ChatGptAuthFlowService {
  private readonly flows = new Map<string, InternalFlow>();
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(private readonly options: ChatGptAuthFlowServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async start(): Promise<ChatGptAuthFlowSnapshot> {
    const driver = this.options.driverFactory?.() ?? new ChromeCdpAuthDriver();
    const id = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = this.now();
    const flow: InternalFlow = {
      id,
      state: 'starting',
      authorizeUrl: CHATGPT_URL,
      message: '正在打开 ChatGPT 登录页。',
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.ttlMs).toISOString(),
      driver,
    };
    this.flows.set(id, flow);

    try {
      const started = await driver.start();
      flow.authorizeUrl = started.authorizeUrl || CHATGPT_URL;
      flow.message = started.message || '请在打开的 ChatGPT 页面完成登录。';
      flow.openedByService = started.openedByService === true;
      flow.state = 'link_ready';
    } catch (error) {
      flow.authorizeUrl = CHATGPT_URL;
      flow.openedByService = false;
      flow.message = `未能自动打开或连接 Chrome。请手动打开 ChatGPT 登录；自动检测失败时用高级导入。${error instanceof Error ? ` (${error.message})` : ''}`;
      flow.state = 'link_ready';
    }
    return publicSnapshot(flow);
  }

  async status(id: string): Promise<ChatGptAuthFlowSnapshot | undefined> {
    const flow = this.flows.get(id);
    if (!flow) return undefined;
    if (isTerminal(flow.state)) return publicSnapshot(flow);
    if (this.now().getTime() >= Date.parse(flow.expiresAt)) {
      flow.state = 'expired';
      flow.message = '授权流程已过期，请重新点击授权 ChatGPT。';
      return publicSnapshot(flow);
    }

    flow.state = flow.state === 'link_ready' ? 'waiting' : flow.state;
    try {
      const secret = await flow.driver.readSecret();
      if (secret?.accessToken) {
        flow.state = 'ready';
        flow.secret = secret;
        flow.message = '已检测到 ChatGPT 登录状态，正在自动初始化。';
      } else {
        flow.message = '请在打开的页面完成登录；自动检测失败时用高级导入。';
      }
    } catch (error) {
      flow.message = `请在打开的页面完成登录；自动检测失败时用高级导入。${error instanceof Error ? ` (${error.message})` : ''}`;
      flow.state = 'waiting';
    }
    return publicSnapshot(flow);
  }

  async cancel(id: string): Promise<ChatGptAuthFlowSnapshot | undefined> {
    const flow = this.flows.get(id);
    if (!flow) return undefined;
    if (!isTerminal(flow.state)) {
      await flow.driver.cancel?.();
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
}

export class ChromeCdpAuthDriver implements ChatGptAuthDriver {
  private process: ChildProcess | undefined;
  private cdpBaseUrl: string | undefined;
  private startedByService = false;

  constructor(private readonly options: { port?: number; userDataDir?: string; chromePath?: string } = {}) {}

  async start(): Promise<ChatGptAuthDriverStartResult> {
    const port = this.options.port ?? await pickPort(Number(process.env.CHATGPT_AUTH_CDP_PORT || 9222));
    const userDataDir = this.options.userDataDir ?? resolve(process.env.CHATGPT_AUTH_CHROME_PROFILE_DIR || 'data/chrome-profile');
    mkdirSync(userDataDir, { recursive: true });
    const chrome = this.options.chromePath ?? findChromePath();
    if (!chrome) {
      this.cdpBaseUrl = `http://127.0.0.1:${port}`;
      return { authorizeUrl: CHATGPT_URL, message: '未找到 Chrome。请手动打开 ChatGPT 登录；自动检测失败时用高级导入。', openedByService: false };
    }

    this.process = spawn(chrome, [
      `--remote-debugging-address=127.0.0.1`,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      CHATGPT_URL,
    ], { stdio: 'ignore', detached: false });
    this.startedByService = true;
    this.cdpBaseUrl = `http://127.0.0.1:${port}`;
    this.process.once('error', () => undefined);
    return { authorizeUrl: CHATGPT_URL, message: '已打开独立 Chrome 登录窗口，请完成 ChatGPT 登录。本地 CDP 仅绑定 127.0.0.1。', openedByService: true };
  }

  async readSecret(): Promise<ChatGptSessionSecret | undefined> {
    if (!this.cdpBaseUrl) return undefined;
    const page = await findChatGptPage(this.cdpBaseUrl);
    if (!page?.webSocketDebuggerUrl) return undefined;
    const client = await CdpClient.connect(page.webSocketDebuggerUrl);
    try {
      const sessionJson = await client.call('Runtime.evaluate', {
        expression: "fetch('/api/auth/session',{credentials:'include'}).then(r=>r.ok?r.json():{}).then(j=>JSON.stringify(j)).catch(()=>'')",
        awaitPromise: true,
        returnByValue: true,
      }) as { result?: { value?: string } };
      const session = parseJsonObject(sessionJson.result?.value);
      const accessToken = findStringByKey(session, 'accessToken');
      if (!accessToken) return undefined;
      const cookiesResult = await client.call('Storage.getCookies', {}) as { cookies?: Array<{ name?: string; value?: string; domain?: string }> };
      const cookie = (cookiesResult.cookies ?? [])
        .filter((item) => typeof item.name === 'string' && typeof item.value === 'string' && (!item.domain || /chatgpt\.com|openai\.com/i.test(item.domain)))
        .map((item) => `${item.name}=${item.value}`)
        .join('; ');
      const userAgentResult = await client.call('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }) as { result?: { value?: string } };
      return { type: 'chatgpt-session', accessToken, cookie: cookie || undefined, userAgent: userAgentResult.result?.value };
    } finally {
      client.close();
    }
  }

  async cancel(): Promise<void> {
    if (this.startedByService && this.process && !this.process.killed) this.process.kill();
  }
}

async function findChatGptPage(cdpBaseUrl: string): Promise<{ webSocketDebuggerUrl?: string } | undefined> {
  const response = await fetch(`${cdpBaseUrl}/json/list`);
  if (!response.ok) return undefined;
  const pages = await response.json() as Array<{ url?: string; webSocketDebuggerUrl?: string; type?: string }>;
  return pages.find((page) => page.type === 'page' && /chatgpt\.com/i.test(page.url ?? '')) ?? pages.find((page) => page.type === 'page');
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(private readonly ws: WebSocketLike) {
    ws.onmessage = (event: { data: unknown }) => {
      const message = parseJsonObject(String(event.data));
      if (!message) return;
      const id = typeof message.id === 'number' ? message.id : undefined;
      if (id === undefined) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
    ws.onerror = () => undefined;
  }

  static async connect(url: string): Promise<CdpClient> {
    const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
    if (!WebSocketCtor) throw new Error('Node WebSocket is unavailable.');
    const ws = new WebSocketCtor(url);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('CDP WebSocket connect timeout')), 5000);
      ws.onopen = () => { clearTimeout(timer); resolvePromise(); };
      ws.onerror = () => { clearTimeout(timer); rejectPromise(new Error('CDP WebSocket connect failed')); };
    });
    return new CdpClient(ws);
  }

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.ws.send(payload);
    });
  }

  close(): void {
    this.ws.close();
  }
}

interface WebSocketLike {
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

function publicSnapshot(flow: InternalFlow): ChatGptAuthFlowSnapshot {
  const { driver: _driver, secret: _secret, ...snapshot } = flow;
  return { ...snapshot };
}

function isTerminal(state: ChatGptAuthFlowState): boolean {
  return state === 'expired' || state === 'cancelled' || state === 'error';
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function findStringByKey(value: unknown, wantedKey: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === wantedKey && typeof item === 'string' && item.trim()) return item.trim();
    const nested = findStringByKey(item, wantedKey);
    if (nested) return nested;
  }
  return undefined;
}

function findChromePath(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : undefined,
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe') : undefined,
  ].filter((item): item is string => Boolean(item));
  return candidates.find((candidate) => existsSync(candidate));
}

async function pickPort(preferred: number): Promise<number> {
  if (await canListen(preferred)) return preferred;
  for (let port = preferred + 1; port < preferred + 100; port += 1) {
    if (await canListen(port)) return port;
  }
  return preferred;
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePromise(true)));
  });
}
