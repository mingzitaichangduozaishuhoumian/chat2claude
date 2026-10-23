import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WebGatewayChatGptBackend,
  type ChatGptBackendClient,
  type ChatGptBackendRequestContext,
  type ChatGptCompletionRequest,
  type ChatGptCompletionResponse,
  type ChatGptDiscoveredModel,
  type ChatGptModelDiscoveryResult,
  type ChatGptStreamEvent,
} from '@chatgpt-to-claude/chatgpt-backend';
import { createApp, type Chat2ClaudeApp } from './app.js';
import { loadEnv } from './config/env.js';
import type { AccountPool } from './services/account-pool.js';
import { RuntimeStateStore } from './services/runtime-state-store.js';
import { WEB_GATEWAY_ACCOUNT_ID } from './services/web-gateway-account.js';

const CODEX_MODEL = 'codex-enabled-model';
const WEB_MODEL = 'web-enabled-model';
const KEY = 'WEB_ENABLE_OWNER_KEY_CANARY';
const GATEWAY_KEY = 'WEB_ENABLE_GATEWAY_KEY_CANARY';
const SESSION_TOKEN = 'WEB_ENABLE_SESSION_TOKEN_CANARY';
const endpoints = ['/v1/messages', '/v1/chat/completions', '/v1/responses'] as const;
type Endpoint = typeof endpoints[number];
const applications: Chat2ClaudeApp[] = [];
const directories: string[] = [];
const headers = { 'content-type': 'application/json', 'x-api-key': KEY };

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.dispose()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class CodexBackend implements ChatGptBackendClient {
  readonly calls: Array<{ request: ChatGptCompletionRequest; accountId?: string; stream: boolean }> = [];

  async listModels(): Promise<ChatGptDiscoveredModel[]> {
    return [{ id: CODEX_MODEL, controls: {
      reasoning: { metadataKnown: true, supported: [] },
      serviceTier: { metadataKnown: true, supported: [], fastMode: false },
    } }];
  }

  async discoverModels(): Promise<ChatGptModelDiscoveryResult> {
    return { status: 'success', models: await this.listModels() };
  }

  async complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse> {
    this.calls.push({ request: structuredClone(request), accountId: context?.account?.id, stream: false });
    return { text: 'codex answer', terminalSuccessful: true, finishReason: 'stop' };
  }

  async *stream(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): AsyncIterable<ChatGptStreamEvent> {
    this.calls.push({ request: structuredClone(request), accountId: context?.account?.id, stream: true });
    yield { type: 'upstream_ready' };
    yield { type: 'text_delta', text: 'codex answer' };
    yield { type: 'done', terminalSuccessful: true, finishReason: 'stop' };
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object.');
  return value as Record<string, unknown>;
}

function fixture(options: { withCodex?: boolean; store?: RuntimeStateStore; environment?: NodeJS.ProcessEnv; beforeWebListModels?: () => Promise<void> } = {}) {
  const codex = new CodexBackend();
  const wire: Array<{ url: string; headers: Headers; body?: Record<string, unknown> }> = [];
  const webOperations: string[] = [];
  const adapter = new WebGatewayChatGptBackend({
    getConfiguration: () => ({ baseUrl: 'http://gateway.test:8090', apiKey: GATEWAY_KEY,
      models: [WEB_MODEL], supportsTools: true, supportsImages: true }),
    fetch: async (input, init) => {
      const body = init?.body ? record(JSON.parse(String(init.body))) : undefined;
      wire.push({ url: String(input), headers: new Headers(init?.headers), ...(body ? { body } : {}) });
      if (!body) return Response.json({ data: [{ id: WEB_MODEL }] });
      if (body.stream) return new Response('data: {"choices":[{"index":0,"delta":{"content":"web answer"},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
      return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'web answer' }, finish_reason: 'stop' }] });
    },
  });
  const web: ChatGptBackendClient = {
    listModels: async (context) => {
      webOperations.push('listModels');
      await options.beforeWebListModels?.();
      return adapter.listModels(context);
    },
    healthCheck: async (context) => { webOperations.push('healthCheck'); return adapter.healthCheck(context); },
    complete: async (request, context) => { webOperations.push('complete'); return adapter.complete(request, context); },
    async *stream(request, context) { webOperations.push('stream'); yield* adapter.stream(request, context); },
  };
  let pool!: AccountPool;
  const app = createApp(loadEnv({ CHATGPT_BACKEND: 'session', API_KEYS: KEY, LOG_LEVEL: 'error',
    ACCOUNT_ACQUIRE_TIMEOUT_MS: '0', ...options.environment }), {
    runtimeStateStore: options.store ?? null, operationalState: null, webBackend: web,
    backendFactory(accountPool) {
      pool = accountPool;
      if (options.withCodex !== false && !pool.get('enabled-codex')) pool.add({ id: 'enabled-codex', provider: 'chatgpt-session',
        secret: { type: 'chatgpt-session', accessToken: SESSION_TOKEN } });
      return codex;
    },
  });
  applications.push(app);
  const patch = (body: unknown) => app.request('http://api.test:3000/admin/api/backend-routing', {
    method: 'PATCH', headers, body: JSON.stringify(body),
  });
  const configure = (mode: 'auto' | 'web' | 'codex' = 'auto') => patch({ mode, webEnabled: true, autoPreference: 'web', gateway: {
    baseUrl: 'http://gateway.test:8090/v1', apiKey: GATEWAY_KEY, models: [WEB_MODEL], supportsTools: true, supportsImages: true,
    modelMappings: { sonnet: WEB_MODEL, 'web-only-alias': WEB_MODEL },
  } });
  const send = (endpoint: Endpoint, backend?: string, extra: Record<string, unknown> = {}) => app.request(endpoint, {
    method: 'POST', headers: { ...headers, ...(backend ? { 'x-chat2claude-backend': backend } : {}) },
    body: JSON.stringify({ model: 'sonnet', ...(endpoint === '/v1/responses'
      ? { input: 'hello', max_output_tokens: 32 }
      : { messages: [{ role: 'user', content: 'hello' }], max_tokens: 32 }), ...extra }),
  });
  const view = async () => record(await (await app.request('/admin/api/backend-routing', { headers })).json());
  return { app, pool, codex, wire, webOperations, patch, configure, send, view };
}

describe('web gateway master enable switch', () => {
  it('reports web disabled until explicitly enabled, including for legacy configured gateways', async () => {
    const empty = fixture();
    expect(await empty.view()).toMatchObject({ webEnabled: false, configured: false });
    const legacy = fixture({ environment: { CHATGPT_WEB_BASE_URL: 'http://gateway.test:8090', CHATGPT_WEB_MODELS: WEB_MODEL } });
    expect(await legacy.view()).toMatchObject({ webEnabled: false, autoPreference: 'codex', configured: true });
    expect(empty.wire).toHaveLength(0);
    expect(legacy.wire).toHaveLength(0);
  });

  it.each(endpoints)('does not activate a newly configured gateway or saved Web mode at %s until manually enabled', async (endpoint) => {
    const f = fixture();
    expect((await f.patch({ mode: 'web', gateway: { baseUrl: 'http://gateway.test:8090', models: [WEB_MODEL],
      supportsTools: true, modelMappings: { sonnet: WEB_MODEL } } })).status).toBe(200);
    expect(await f.view()).toMatchObject({ configured: true, webEnabled: false, mode: 'web', autoPreference: 'codex' });
    const response = await f.send(endpoint);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('codex');
    expect(await response.text()).toContain('codex answer');
    expect((await f.send(endpoint, 'web')).status).toBe(403);
    expect(f.wire).toHaveLength(0);
    expect(f.webOperations).toHaveLength(0);
    expect((await f.patch({ webEnabled: true })).status).toBe(200);
    const optedIn = await f.send(endpoint);
    expect(optedIn.status).toBe(200);
    expect(optedIn.headers.get('x-chat2claude-backend')).toBe('web');
    await optedIn.text();
    expect(f.wire).toHaveLength(1);
  });

  it('retains the selected mode, credentials, mappings and account identity while disabled', async () => {
    const f = fixture();
    expect((await f.configure('web')).status).toBe(200);
    const before = await f.view();
    const account = f.pool.get(WEB_GATEWAY_ACCOUNT_ID)!;
    const incarnation = account.incarnation;
    const createdAt = account.createdAt;
    expect(before.webEnabled).toBe(true);
    const disabled = await f.patch({ webEnabled: false });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ ...before, webEnabled: false });
    expect(await f.view()).toEqual({ ...before, webEnabled: false });
    expect(f.pool.get(WEB_GATEWAY_ACCOUNT_ID)).toMatchObject({ incarnation, createdAt });
    expect((await f.patch({ webEnabled: true })).status).toBe(200);
    expect(await f.view()).toEqual(before);
    expect(f.pool.get(WEB_GATEWAY_ACCOUNT_ID)).toMatchObject({ incarnation, createdAt });
    const response = await f.send('/v1/chat/completions');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('web');
    expect(await response.text()).toContain('web answer');
    expect(f.wire).toHaveLength(1);
    expect(f.wire[0].headers.get('authorization')).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(JSON.stringify(await f.view())).not.toContain(GATEWAY_KEY);
    expect(f.codex.calls).toHaveLength(0);
  });

  it.each(endpoints.flatMap((endpoint) => (['auto', 'web'] as const).map((mode) => ({ endpoint, mode }))))(
    'runs only Codex for a disabled $mode default at $endpoint, including auto overrides and streams', async ({ endpoint, mode }) => {
      const f = fixture();
      expect((await f.configure(mode)).status).toBe(200);
      expect((await f.patch({ webEnabled: false })).status).toBe(200);
      for (const backend of [undefined, 'auto', 'codex']) {
        for (const stream of [false, true]) {
          const response = await f.send(endpoint, backend, { stream });
          expect(response.status).toBe(200);
          expect(response.headers.get('x-chat2claude-backend')).toBe('codex');
          expect(await response.text()).toContain('codex answer');
        }
      }
      expect(f.codex.calls).toHaveLength(6);
      expect(f.codex.calls.every((call) => call.accountId === 'enabled-codex' && call.request.model === CODEX_MODEL)).toBe(true);
      expect(f.wire).toHaveLength(0);
      expect(f.webOperations).toHaveLength(0);
    });

  it.each(endpoints)('rejects a forced web request while disabled at %s without dispatching either backend', async (endpoint) => {
    const f = fixture();
    expect((await f.configure('web')).status).toBe(200);
    expect((await f.patch({ webEnabled: false })).status).toBe(200);
    for (const stream of [false, true]) {
      const response = await f.send(endpoint, 'web', { stream });
      expect([400, 403]).toContain(response.status);
    }
    expect(f.codex.calls).toHaveLength(0);
    expect(f.wire).toHaveLength(0);
    expect(f.webOperations).toHaveLength(0);
  });

  it.each(endpoints)('does not fall back to the disabled gateway when Codex is unavailable at %s', async (endpoint) => {
    const f = fixture({ withCodex: false });
    expect((await f.configure('web')).status).toBe(200);
    expect((await f.patch({ webEnabled: false })).status).toBe(200);
    expect((await f.send(endpoint, 'auto', { model: CODEX_MODEL })).status).toBe(503);
    expect(f.codex.calls).toHaveLength(0);
    expect(f.wire).toHaveLength(0);
    expect(f.webOperations).toHaveLength(0);
  });

  it('hides web-only models and aliases while preserving the Codex catalog and restores them when enabled', async () => {
    const f = fixture();
    expect((await f.configure('web')).status).toBe(200);
    const list = async (backend?: string) => {
      const response = await f.app.request('/v1/models', { headers: { ...headers, ...(backend ? { 'x-chat2claude-backend': backend } : {}) } });
      expect(response.status).toBe(200);
      return record(await response.json()).data as Array<Record<string, unknown>>;
    };
    const enabled = await list();
    expect(enabled.map((model) => model.id)).toEqual(expect.arrayContaining([WEB_MODEL, 'web-only-alias']));
    expect((await f.patch({ webEnabled: false })).status).toBe(200);
    for (const backend of [undefined, 'auto', 'codex']) {
      const disabled = await list(backend);
      expect(disabled.map((model) => model.id)).toContain(CODEX_MODEL);
      expect(disabled.map((model) => model.id)).not.toContain(WEB_MODEL);
      expect(disabled.map((model) => model.id)).not.toContain('web-only-alias');
      expect(disabled).toContainEqual(expect.objectContaining({ id: 'sonnet', discovered: expect.objectContaining({ id: CODEX_MODEL }) }));
    }
    const blocked = await f.app.request('/v1/models', { headers: { ...headers, 'x-chat2claude-backend': 'web' } });
    expect([400, 403]).toContain(blocked.status);
    expect((await f.patch({ webEnabled: true })).status).toBe(200);
    expect((await list()).map((model) => model.id)).toEqual(expect.arrayContaining([WEB_MODEL, 'web-only-alias']));
    expect(f.wire).toHaveLength(0);
  });

  it('prevents disabled gateway health checks and model refresh from reaching the web transport', async () => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    expect((await f.patch({ webEnabled: false })).status).toBe(200);
    const operations = f.webOperations.length;
    const health = await f.app.request(`/admin/api/accounts/${WEB_GATEWAY_ACCOUNT_ID}/health-check`, { method: 'POST', headers });
    expect(health.status).toBeGreaterThanOrEqual(400);
    const refresh = await f.app.request('/admin/api/models/refresh', { method: 'POST', headers });
    expect(refresh.status).toBe(200);
    expect(f.webOperations).toHaveLength(operations);
    expect(f.wire).toHaveLength(0);
  });

  it('keeps a delayed web model refresh inactive when the master switch is disabled before discovery finishes', async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let releaseDiscovery!: () => void;
    const discoveryPending = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    const f = fixture({ beforeWebListModels: async () => { notifyStarted(); await discoveryPending; } });
    expect((await f.configure()).status).toBe(200);
    const refresh = f.app.request('/admin/api/models/refresh', { method: 'POST', headers });
    await started;
    try {
      expect((await f.patch({ webEnabled: false })).status).toBe(200);
    } finally { releaseDiscovery(); }
    expect((await refresh).status).toBe(200);
    expect(f.webOperations).toEqual(['listModels']);
    const admin = await f.app.request('/admin/api/models', { headers });
    expect(admin.status).toBe(200);
    const discovered = record(await admin.json()).discovered as Array<Record<string, unknown>>;
    expect(discovered.map((model) => model.id)).toContain(CODEX_MODEL);
    expect(discovered.map((model) => model.id)).not.toContain(WEB_MODEL);
    const listing = await f.app.request('/v1/models', { headers });
    expect(listing.status).toBe(200);
    const ids = (record(await listing.json()).data as Array<Record<string, unknown>>).map((model) => model.id);
    expect(ids).toContain(CODEX_MODEL);
    expect(ids).not.toContain(WEB_MODEL);
    expect(ids).not.toContain('web-only-alias');
    expect([400, 403]).toContain((await f.send('/v1/messages', 'web')).status);
    const codex = await f.send('/v1/messages');
    expect(codex.status).toBe(200);
    expect(codex.headers.get('x-chat2claude-backend')).toBe('codex');
    await codex.text();
    expect(f.wire).toHaveLength(0);
  });

  it('does not reactivate the web catalog through an account enable patch while the master switch is disabled', async () => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    expect((await f.patch({ webEnabled: false })).status).toBe(200);
    for (const enabled of [false, true]) {
      const patched = await f.app.request(`/admin/api/accounts/${WEB_GATEWAY_ACCOUNT_ID}`, {
        method: 'PATCH', headers, body: JSON.stringify({ enabled }),
      });
      expect(patched.status).toBe(200);
    }
    expect(f.pool.get(WEB_GATEWAY_ACCOUNT_ID)?.enabled).toBe(true);
    const admin = await f.app.request('/admin/api/models', { headers });
    expect(admin.status).toBe(200);
    const discovered = record(await admin.json()).discovered as Array<Record<string, unknown>>;
    expect(discovered.map((model) => model.id)).toContain(CODEX_MODEL);
    expect(discovered.map((model) => model.id)).not.toContain(WEB_MODEL);
    const listing = await f.app.request('/v1/models', { headers });
    expect(listing.status).toBe(200);
    const ids = (record(await listing.json()).data as Array<Record<string, unknown>>).map((model) => model.id);
    expect(ids).toContain(CODEX_MODEL);
    expect(ids).not.toContain(WEB_MODEL);
    expect(ids).not.toContain('web-only-alias');
    expect([400, 403]).toContain((await f.send('/v1/messages', 'web')).status);
    expect(f.webOperations).toHaveLength(0);
    expect(f.wire).toHaveLength(0);
  });

  it('blocks a web Responses continuation while disabled and resumes it on the same account after re-enabling', async () => {
    const f = fixture();
    expect((await f.configure('web')).status).toBe(200);
    const first = await f.send('/v1/responses');
    expect(first.status).toBe(200);
    const previous = record(await first.json()).id;
    const identity = f.pool.get(WEB_GATEWAY_ACCOUNT_ID)!.incarnation;
    expect(f.wire).toHaveLength(1);
    expect((await f.patch({ webEnabled: false, autoPreference: 'codex', mode: 'auto' })).status).toBe(200);
    expect(f.pool.get(WEB_GATEWAY_ACCOUNT_ID)!.incarnation).toBe(identity);
    for (const backend of [undefined, 'auto', 'codex']) {
      const blocked = await f.send('/v1/responses', backend, { input: 'blocked continuation', previous_response_id: previous });
      expect(blocked.status).toBeGreaterThanOrEqual(400);
    }
    expect(f.wire).toHaveLength(1);
    expect(f.codex.calls).toHaveLength(0);
    expect((await f.patch({ webEnabled: true })).status).toBe(200);
    expect(f.pool.get(WEB_GATEWAY_ACCOUNT_ID)!.incarnation).toBe(identity);
    const resumed = await f.send('/v1/responses', undefined, { input: 'continue', previous_response_id: previous });
    expect(resumed.status).toBe(200);
    expect(resumed.headers.get('x-chat2claude-backend')).toBe('web');
    expect(await resumed.text()).toContain('web answer');
    expect(f.wire).toHaveLength(2);
    expect(f.wire[1].body?.messages).toEqual([
      { role: 'user', content: 'hello' }, { role: 'assistant', content: 'web answer' }, { role: 'user', content: 'continue' },
    ]);
    expect(f.codex.calls).toHaveLength(0);
  });

  it('persists the disabled flag and original credentials through a restart without exposing keys', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat2claude-web-enabled-'));
    directories.push(directory);
    const path = join(directory, 'state.json');
    const store = new RuntimeStateStore({ path, encryptionKey: Buffer.alloc(32, 7) });
    const first = fixture({ store });
    expect((await first.configure('web')).status).toBe(200);
    expect((await first.patch({ webEnabled: false })).status).toBe(200);
    const before = await first.view();
    const createdAt = first.pool.get(WEB_GATEWAY_ACCOUNT_ID)!.createdAt;
    expect(store.load()?.backendRouting).toMatchObject({ webEnabled: false, mode: 'web', gateway: { apiKey: GATEWAY_KEY } });
    expect(readFileSync(path, 'utf8')).not.toContain(GATEWAY_KEY);
    await first.app.dispose();
    applications.splice(applications.indexOf(first.app), 1);
    const restarted = fixture({ store });
    expect(await restarted.view()).toEqual(before);
    expect(restarted.pool.get(WEB_GATEWAY_ACCOUNT_ID)?.createdAt).toBe(createdAt);
    const response = await restarted.send('/v1/messages');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('codex');
    expect(await response.text()).toContain('codex answer');
    expect(restarted.wire).toHaveLength(0);
    expect(restarted.webOperations).toHaveLength(0);
    expect((await restarted.patch({ webEnabled: true })).status).toBe(200);
    expect(await restarted.view()).toEqual({ ...before, webEnabled: true });
    const resumed = await restarted.send('/v1/messages');
    expect(resumed.status).toBe(200);
    expect(resumed.headers.get('x-chat2claude-backend')).toBe('web');
    expect(await resumed.text()).toContain('web answer');
    expect(restarted.wire).toHaveLength(1);
    const safe = JSON.stringify(await restarted.view());
    expect(safe).not.toContain(GATEWAY_KEY);
    expect(safe).not.toContain(SESSION_TOKEN);
    expect(safe).not.toContain(KEY);
  });
});
