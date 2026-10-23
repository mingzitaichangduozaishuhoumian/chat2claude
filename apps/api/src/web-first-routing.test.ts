import { afterEach, describe, expect, it } from 'vitest';
import {
  WebGatewayChatGptBackend,
  type ChatGptBackendClient,
  type ChatGptBackendRequestContext,
  type ChatGptCompletionRequest,
  type ChatGptCompletionResponse,
  type ChatGptDiscoveredModel,
  type ChatGptModelDiscoveryResult,
  type ChatGptReplayItem,
  type ChatGptStreamEvent,
  type WebGatewayConfiguration,
} from '@chatgpt-to-claude/chatgpt-backend';
import { createApp, type Chat2ClaudeApp } from './app.js';
import { loadEnv } from './config/env.js';
import type { AccountPool } from './services/account-pool.js';
import { WEB_GATEWAY_ACCOUNT_ID } from './services/web-gateway-account.js';

const CODEX_MODEL = 'codex-native-model';
const WEB_MODEL = 'auto';
const API_KEY = 'OWNER_API_KEY_CANARY';
const GATEWAY_KEY = 'GATEWAY_API_KEY_CANARY';
const SESSION_KEY = 'CODEX_SESSION_KEY_CANARY';
const CIPHER = 'CODEX_REASONING_CIPHER_CANARY';
const endpoints = ['/v1/messages', '/v1/chat/completions', '/v1/responses'] as const;
type Endpoint = typeof endpoints[number];
const applications: Chat2ClaudeApp[] = [];

afterEach(async () => { await Promise.all(applications.splice(0).map((app) => app.dispose())); });

class CodexBackend implements ChatGptBackendClient {
  readonly calls: Array<{ request: ChatGptCompletionRequest; accountId?: string; stream: boolean }> = [];
  returnReplay = false;
  modelsAvailable = true;

  async listModels(): Promise<ChatGptDiscoveredModel[]> {
    if (!this.modelsAvailable) return [];
    return [{ id: CODEX_MODEL, capabilities: { input_image: true }, controls: {
      reasoning: { metadataKnown: true, supported: [{ effort: 'medium' }], defaultEffort: 'medium' },
      serviceTier: { metadataKnown: true, supported: [], fastMode: false },
    } }];
  }

  async discoverModels(): Promise<ChatGptModelDiscoveryResult> {
    const models = await this.listModels();
    return { models, status: models.length ? 'success' : 'empty' };
  }

  async complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse> {
    this.calls.push({ request: structuredClone(request), accountId: context?.account?.id, stream: false });
    if (this.returnReplay) {
      const replayItems: ChatGptReplayItem[] = [
        { type: 'reasoning', id: 'reasoning_codex_1', summary: [], encrypted_content: CIPHER },
        { type: 'function_call', call_id: 'call_codex_1', name: 'lookup', arguments: '{"q":1}' },
      ];
      return { text: '', terminalSuccessful: true, finishReason: 'tool_calls', replayEligible: true, replayItems,
        toolCalls: [{ id: 'call_codex_1', name: 'lookup', input: { q: 1 } }] };
    }
    return { text: 'codex answer', terminalSuccessful: true, finishReason: 'stop' };
  }

  async *stream(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): AsyncIterable<ChatGptStreamEvent> {
    this.calls.push({ request: structuredClone(request), accountId: context?.account?.id, stream: true });
    yield { type: 'upstream_ready' };
    yield { type: 'text_delta', text: 'codex answer' };
    yield { type: 'done', terminalSuccessful: true, finishReason: 'stop' };
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object.');
  return value as Record<string, unknown>;
}

function fixture() {
  const codex = new CodexBackend();
  const wire: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  let gatewayConfiguration: WebGatewayConfiguration | undefined;
  let upstreamResponse: (() => Response) | undefined;
  const web = new WebGatewayChatGptBackend({
    getConfiguration: () => gatewayConfiguration,
    fetch: async (input, init) => {
      wire.push({ url: String(input), headers: new Headers(init?.headers), body: object(JSON.parse(String(init?.body))) });
      return upstreamResponse?.() ?? Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'web answer' }, finish_reason: 'stop' }] });
    },
  });
  let pool!: AccountPool;
  const app = createApp(loadEnv({ CHATGPT_BACKEND: 'session', API_KEYS: API_KEY, LOG_LEVEL: 'error', ACCOUNT_ACQUIRE_TIMEOUT_MS: '0' }), {
    runtimeStateStore: null, operationalState: null, webBackend: web,
    backendFactory(accountPool) {
      pool = accountPool;
      pool.add({ id: 'codex-account', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: SESSION_KEY } });
      return codex;
    },
  });
  applications.push(app);
  const headers = { 'content-type': 'application/json', 'x-api-key': API_KEY };
  const patch = async (body: unknown) => {
    const response = await app.request('http://api.test:3000/admin/api/backend-routing', { method: 'PATCH', headers, body: JSON.stringify(body) });
    if (response.ok) {
      const view = object(await response.clone().json());
      const gateway = view.gateway === undefined ? undefined : object(view.gateway);
      gatewayConfiguration = gateway ? { baseUrl: String(gateway.baseUrl), apiKey: GATEWAY_KEY,
        models: gateway.models as string[], supportsTools: gateway.supportsTools as boolean, supportsImages: gateway.supportsImages as boolean } : undefined;
    }
    return response;
  };
  const configure = (gateway: Record<string, unknown> = {}, options: Record<string, unknown> = {}) => patch({
    mode: 'auto', webEnabled: true, autoPreference: 'web', ...options, gateway: { baseUrl: 'http://gateway.test:8090', apiKey: GATEWAY_KEY,
      models: [WEB_MODEL], supportsTools: false, ...gateway },
  });
  const send = (endpoint: Endpoint, extra: Record<string, unknown> = {}, backend?: string) => app.request(endpoint, {
    method: 'POST', headers: { ...headers, ...(backend === undefined ? {} : { 'x-chat2claude-backend': backend }) },
    body: JSON.stringify({ ...payload(endpoint), ...extra }),
  });
  return { app, codex, wire, pool, patch, configure, send, setUpstreamResponse: (value: () => Response) => { upstreamResponse = value; } };
}

function payload(endpoint: Endpoint): Record<string, unknown> {
  return endpoint === '/v1/responses' ? { model: 'sonnet', input: 'hello', max_output_tokens: 64 }
    : { model: 'sonnet', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64 };
}

function tools(endpoint: Endpoint): unknown[] {
  const parameters = { type: 'object', properties: { q: { type: 'number' } } };
  return endpoint === '/v1/messages' ? [{ name: 'lookup', input_schema: parameters }]
    : endpoint === '/v1/responses' ? [{ type: 'function', name: 'lookup', parameters }]
      : [{ type: 'function', function: { name: 'lookup', parameters } }];
}

function imagePayload(endpoint: Endpoint): Record<string, unknown> {
  const url = 'data:image/png;base64,iVBORw0KGgo=';
  if (endpoint === '/v1/responses') return { input: [{ role: 'user', content: [
    { type: 'input_text', text: 'Describe ' }, { type: 'input_image', image_url: url, detail: 'high' }, { type: 'input_text', text: ' please.' },
  ] }] };
  if (endpoint === '/v1/messages') return { messages: [{ role: 'user', content: [
    { type: 'text', text: 'Describe ' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }, { type: 'text', text: ' please.' },
  ] }] };
  return { messages: [{ role: 'user', content: [
    { type: 'text', text: 'Describe ' }, { type: 'image_url', image_url: { url, detail: 'high' } }, { type: 'text', text: ' please.' },
  ] }] };
}

describe('web-first routing without duplicate model calls', () => {
  it.each(['web', 'auto'] as const)('lists explicitly mapped clients and Codex-bound aliases without exposing disabled aliases in %s mode', async (mode) => {
    const f = fixture();
    expect((await f.configure({ modelMappings: { sonnet: WEB_MODEL, 'new-client': WEB_MODEL } }, { mode })).status).toBe(200);
    const listing = await f.app.request('/v1/models', { headers: { 'x-api-key': API_KEY } });
    expect(listing.status).toBe(200);
    const data = object(await listing.json()).data as Array<Record<string, unknown>>;
    expect(data).toContainEqual(expect.objectContaining({ id: 'new-client', discovered: expect.objectContaining({ id: WEB_MODEL }) }));
    expect(data).toContainEqual(expect.objectContaining({ id: 'sonnet', discovered: expect.objectContaining({ id: WEB_MODEL }) }));
    const disabled = await f.app.request('/admin/api/models/sonnet', { method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: JSON.stringify({ enabled: false }) });
    expect(disabled.status).toBe(200);
    const after = await f.app.request('/v1/models', { headers: { 'x-api-key': API_KEY } });
    const afterData = object(await after.json()).data as Array<Record<string, unknown>>;
    expect(afterData.some((model) => model.id === 'sonnet')).toBe(false);
    expect(afterData.some((model) => model.id === 'new-client')).toBe(true);
    expect(f.codex.calls).toHaveLength(0);
    expect(f.wire).toHaveLength(0);
  });

  it('keeps Codex catalog support distinct from mapped web support when Codex is preferred', async () => {
    const f = fixture();
    expect((await f.configure({ modelMappings: { sonnet: WEB_MODEL, 'new-client': WEB_MODEL } }, { autoPreference: 'codex' })).status).toBe(200);
    const automatic = await f.app.request('/v1/models', { headers: { 'x-api-key': API_KEY } });
    const data = object(await automatic.json()).data as Array<Record<string, unknown>>;
    expect(data).toContainEqual(expect.objectContaining({ id: 'sonnet', discovered: expect.objectContaining({ id: CODEX_MODEL }) }));
    expect(data).toContainEqual(expect.objectContaining({ id: 'new-client', discovered: expect.objectContaining({ id: WEB_MODEL }) }));
    const codexOnly = await f.app.request('/v1/models', { headers: { 'x-api-key': API_KEY, 'x-chat2claude-backend': 'codex' } });
    const codexData = object(await codexOnly.json()).data as Array<Record<string, unknown>>;
    expect(codexData.some((model) => model.id === 'new-client')).toBe(false);
    expect((await f.send('/v1/messages', { model: 'new-client' }, 'codex')).status).toBeGreaterThanOrEqual(400);
    expect(f.codex.calls).toHaveLength(0);
    const web = await f.send('/v1/messages', { model: 'new-client' });
    expect(web.status).toBe(200);
    expect(web.headers.get('x-chat2claude-backend')).toBe('web');
    expect(f.wire).toHaveLength(1);
    expect(f.wire[0].body.model).toBe(WEB_MODEL);
    expect(f.codex.calls).toHaveLength(0);
  });

  it.each(endpoints)('serves a stale Codex alias through its explicit web mapping after the original model disappears at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure({ modelMappings: { sonnet: WEB_MODEL } })).status).toBe(200);
    f.codex.modelsAvailable = false;
    const refreshed = await f.app.request('/admin/api/models/refresh', { method: 'POST', headers: { 'x-api-key': API_KEY } });
    expect(refreshed.status).toBe(200);
    const aliases = object(await refreshed.json()).aliases as Array<Record<string, unknown>>;
    expect(aliases).toContainEqual(expect.objectContaining({ id: 'sonnet', backendModel: CODEX_MODEL, status: 'stale' }));
    const response = await f.send(endpoint);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('web');
    expect(f.wire).toHaveLength(1);
    expect(f.wire[0].body.model).toBe(WEB_MODEL);
    expect(f.codex.calls).toHaveLength(0);
  });

  it.each(endpoints)('uses the original declared backend ID to map a stale sonnet alias and list it in web mode at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure({ modelMappings: { [CODEX_MODEL]: WEB_MODEL } })).status).toBe(200);
    f.codex.modelsAvailable = false;
    const refreshed = await f.app.request('/admin/api/models/refresh', { method: 'POST', headers: { 'x-api-key': API_KEY } });
    expect(refreshed.status).toBe(200);
    expect(object(await refreshed.json()).aliases).toContainEqual(expect.objectContaining({ id: 'sonnet', backendModel: CODEX_MODEL, status: 'stale' }));
    const listing = await f.app.request('/v1/models', { headers: { 'x-api-key': API_KEY, 'x-chat2claude-backend': 'web' } });
    expect(listing.status).toBe(200);
    expect(object(await listing.json()).data).toContainEqual(expect.objectContaining({ id: 'sonnet', discovered: expect.objectContaining({ id: WEB_MODEL }) }));
    const response = await f.send(endpoint);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('web');
    expect(f.wire).toHaveLength(1);
    expect(f.wire[0].body.model).toBe(WEB_MODEL);
    expect(f.codex.calls).toHaveLength(0);
  });

  it.each([true, false])('applies backend model substitutions once when the original Codex catalog is available=%s', async (modelsAvailable) => {
    const f = fixture();
    expect((await f.configure({ models: [WEB_MODEL, 'other-web'], modelMappings: { [CODEX_MODEL]: WEB_MODEL, [WEB_MODEL]: 'other-web' } })).status).toBe(200);
    if (!modelsAvailable) {
      f.codex.modelsAvailable = false;
      const refreshed = await f.app.request('/admin/api/models/refresh', { method: 'POST', headers: { 'x-api-key': API_KEY } });
      expect(refreshed.status).toBe(200);
      expect(object(await refreshed.json()).aliases).toContainEqual(expect.objectContaining({ id: 'sonnet', backendModel: CODEX_MODEL, status: 'stale' }));
    }
    const response = await f.send('/v1/chat/completions');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('web');
    expect(f.wire).toHaveLength(1);
    expect(f.wire[0].body.model).toBe(WEB_MODEL);
    expect(f.codex.calls).toHaveLength(0);
  });

  it.each(endpoints)('uses the same exact model on the web when explicitly enabled and preferred at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure({ models: [CODEX_MODEL] })).status).toBe(200);
    const response = await f.send(endpoint, { model: CODEX_MODEL });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('web');
    expect(await response.text()).toContain('web answer');
    expect(f.wire).toHaveLength(1);
    expect(f.wire[0].body.model).toBe(CODEX_MODEL);
    expect(f.codex.calls).toHaveLength(0);
    expect(f.wire[0].headers.get('authorization')).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(f.wire[0].headers.has('x-api-key')).toBe(false);
    expect(JSON.stringify([...f.wire[0].headers])).not.toContain(API_KEY);
    expect(JSON.stringify([...f.wire[0].headers])).not.toContain(SESSION_KEY);
  });

  it.each(endpoints)('switches automatic preference without making planning or review calls at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure({ models: [CODEX_MODEL] })).status).toBe(200);
    for (const preference of ['web', 'codex', 'web'] as const) {
      expect((await f.patch({ autoPreference: preference })).status).toBe(200);
      const response = await f.send(endpoint, { model: CODEX_MODEL });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-chat2claude-backend')).toBe(preference);
      await response.text();
    }
    expect(f.wire).toHaveLength(2);
    expect(f.codex.calls).toHaveLength(1);
  });

  it.each(endpoints)('offloads a Codex-bound sonnet alias through an explicit gateway mapping at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure({ modelMappings: { sonnet: WEB_MODEL } })).status).toBe(200);
    const manual = await f.send(endpoint, {}, 'codex');
    expect(manual.status).toBe(200);
    expect(f.codex.calls[0].request).toMatchObject({ model: CODEX_MODEL, reasoningEffort: 'medium' });
    const auto = await f.send(endpoint);
    expect(auto.status).toBe(200);
    expect(auto.headers.get('x-chat2claude-backend')).toBe('web');
    expect(f.wire).toHaveLength(1);
    expect(f.wire[0].body.model).toBe(WEB_MODEL);
    expect(f.wire[0].body).not.toHaveProperty('reasoning_effort');
    expect(f.codex.calls).toHaveLength(1);
    const again = await f.send(endpoint, {}, 'codex');
    expect(again.status).toBe(200);
    expect(f.codex.calls[1].request.model).toBe(CODEX_MODEL);
    expect(f.wire.length + f.codex.calls.length).toBe(3);
  });

  it.each(endpoints)('accepts an explicitly mapped custom client model without allowing an unmapped unknown model at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure({ modelMappings: { 'my-client-model': WEB_MODEL } })).status).toBe(200);
    const mapped = await f.send(endpoint, { model: 'my-client-model' });
    expect(mapped.status).toBe(200);
    expect(mapped.headers.get('x-chat2claude-backend')).toBe('web');
    expect(f.wire[0].body.model).toBe(WEB_MODEL);
    const unknown = await f.send(endpoint, { model: 'unmapped-client-model' });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(f.wire).toHaveLength(1);
    expect(f.codex.calls).toHaveLength(0);
  });

  it.each(endpoints)('uses Codex when no exact or explicit web model mapping exists at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure()).status).toBe(200);
    const response = await f.send(endpoint);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('codex');
    expect(f.codex.calls[0].request.model).toBe(CODEX_MODEL);
    expect((await f.send(endpoint, {}, 'web')).status).toBeGreaterThanOrEqual(400);
    expect(f.wire).toHaveLength(0);
    expect(f.codex.calls).toHaveLength(1);
  });

  it.each(endpoints)('preserves explicit reasoning requirements when web is preferred at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure({ modelMappings: { sonnet: WEB_MODEL } })).status).toBe(200);
    const response = await f.send(endpoint, { reasoning_effort: 'medium' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('codex');
    expect(f.codex.calls[0].request.reasoningEffort).toBe('medium');
    expect((await f.send(endpoint, { reasoning_effort: 'medium' }, 'web')).status).toBeGreaterThanOrEqual(400);
    expect(f.wire).toHaveLength(0);
    expect(f.codex.calls).toHaveLength(1);
  });

  it.each(endpoints)('falls back only before dispatch when web is busy or disabled at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure({ modelMappings: { sonnet: WEB_MODEL } })).status).toBe(200);
    const lease = f.pool.acquire({ provider: 'chatgpt-web' });
    expect(lease?.id).toBe(WEB_GATEWAY_ACCOUNT_ID);
    try {
      const response = await f.send(endpoint);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-chat2claude-backend')).toBe('codex');
      await response.text();
    } finally { if (lease) f.pool.release(lease); }
    f.pool.update(WEB_GATEWAY_ACCOUNT_ID, { enabled: false });
    const disabled = await f.send(endpoint);
    expect(disabled.status).toBe(200);
    expect(disabled.headers.get('x-chat2claude-backend')).toBe('codex');
    expect(f.codex.calls).toHaveLength(2);
    expect(f.wire).toHaveLength(0);
    expect((await f.send(endpoint, {}, 'web')).status).toBe(503);
    expect(f.codex.calls).toHaveLength(2);
  });

  it.each(endpoints)('filters tools before dispatch without stripping them to fit the web at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure({ modelMappings: { sonnet: WEB_MODEL } })).status).toBe(200);
    const response = await f.send(endpoint, { tools: tools(endpoint) });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('codex');
    expect(f.codex.calls[0].request.tools).toContainEqual(expect.objectContaining({ name: 'lookup' }));
    expect(f.wire).toHaveLength(0);
    expect((await f.send(endpoint, { tools: tools(endpoint) }, 'web')).status).toBeGreaterThanOrEqual(400);
    expect(f.codex.calls).toHaveLength(1);
  });

  it.each(endpoints)('passes mixed image content to the real web adapter only with image opt-in at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure({ modelMappings: { sonnet: WEB_MODEL }, supportsImages: true })).status).toBe(200);
    const response = await f.send(endpoint, imagePayload(endpoint));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-chat2claude-backend')).toBe('web');
    expect(f.codex.calls).toHaveLength(0);
    expect(f.wire).toHaveLength(1);
    const content = (f.wire[0].body.messages as Array<{ content: unknown }>)[0].content;
    expect(content).toEqual([
      { type: 'text', text: 'Describe ' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', ...(endpoint === '/v1/messages' ? {} : { detail: 'high' }) } },
      { type: 'text', text: ' please.' },
    ]);
    expect((await f.patch({ gateway: { supportsImages: false } })).status).toBe(200);
    const fallback = await f.send(endpoint, imagePayload(endpoint));
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get('x-chat2claude-backend')).toBe('codex');
    expect(f.codex.calls).toHaveLength(1);
    expect(f.codex.calls[0].request.inputItems).toContainEqual(expect.objectContaining({ type: 'message', content: expect.arrayContaining([expect.objectContaining({ type: 'image' })]) }));
    expect((await f.send(endpoint, imagePayload(endpoint), 'web')).status).toBeGreaterThanOrEqual(400);
    expect(f.wire).toHaveLength(1);
    expect(f.codex.calls).toHaveLength(1);
  });

  it.each(endpoints)('does not call Codex after a preferred web request was sent and failed at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure({ modelMappings: { sonnet: WEB_MODEL } })).status).toBe(200);
    f.setUpstreamResponse(() => new Response('UPSTREAM_BODY_CANARY', { status: 503 }));
    const response = await f.send(endpoint);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain('UPSTREAM_BODY_CANARY');
    expect(f.wire).toHaveLength(1);
    expect(f.codex.calls).toHaveLength(0);
  });

  it.each(endpoints)('does not retry a preferred web stream after visible content at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure({ modelMappings: { sonnet: WEB_MODEL } })).status).toBe(200);
    f.setUpstreamResponse(() => new Response('data: {"choices":[{"index":0,"delta":{"content":"web partial"},"finish_reason":null}]}\n\n'
      + 'data: {"error":{"message":"STREAM_FAILURE_CANARY"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const response = await f.send(endpoint, { stream: true });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('web partial');
    expect(body).toContain('error');
    expect(body).not.toContain('STREAM_FAILURE_CANARY');
    expect(f.wire).toHaveLength(1);
    expect(f.codex.calls).toHaveLength(0);
  });

  it('pins Responses history to its actual web target across preference changes and rejects a changed mapping', async () => {
    const f = fixture();
    expect((await f.configure({ models: [WEB_MODEL, 'other-web'], modelMappings: { sonnet: WEB_MODEL } })).status).toBe(200);
    const first = await f.send('/v1/responses');
    expect(first.status).toBe(200);
    const previous = object(await first.json()).id;
    expect(previous).toMatch(/^resp_/);
    expect((await f.patch({ autoPreference: 'codex' })).status).toBe(200);
    const second = await f.send('/v1/responses', { previous_response_id: previous, input: 'continue' });
    expect(second.status).toBe(200);
    expect(second.headers.get('x-chat2claude-backend')).toBe('web');
    expect(f.wire[1].body).toMatchObject({ model: WEB_MODEL, messages: [
      { role: 'user', content: 'hello' }, { role: 'assistant', content: 'web answer' }, { role: 'user', content: 'continue' },
    ] });
    expect((await f.patch({ gateway: { modelMappings: { sonnet: 'other-web' } } })).status).toBe(200);
    expect((await f.send('/v1/responses', { previous_response_id: previous, input: 'wrong target' })).status).toBe(503);
    expect(f.wire).toHaveLength(2);
    expect(f.codex.calls).toHaveLength(0);
  });

  it.each(endpoints)('does not use a gateway mapping to bypass a disabled alias at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure({ modelMappings: { sonnet: WEB_MODEL } })).status).toBe(200);
    const disabled = await f.app.request('/admin/api/models/sonnet', { method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: JSON.stringify({ enabled: false }) });
    expect(disabled.status).toBe(200);
    const response = await f.send(endpoint);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(f.wire).toHaveLength(0);
    expect(f.codex.calls).toHaveLength(0);
  });

  it.each(['/v1/messages', '/v1/chat/completions'] as const)('keeps implicit Codex reasoning replay on Codex after web becomes preferred at %s', async (endpoint) => {
    const f = fixture();
    expect((await f.configure({ modelMappings: { sonnet: WEB_MODEL }, supportsTools: true })).status).toBe(200);
    f.codex.returnReplay = true;
    const first = await f.send(endpoint, { tools: tools(endpoint) }, 'codex');
    expect(first.status).toBe(200);
    expect(await first.text()).not.toContain(CIPHER);
    f.codex.returnReplay = false;
    const messages = endpoint === '/v1/messages' ? [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_codex_1', name: 'lookup', input: { q: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_codex_1', content: 'found' }] },
    ] : [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_codex_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] },
      { role: 'tool', tool_call_id: 'call_codex_1', content: 'found' },
    ];
    const continuation = await f.send(endpoint, { messages, tools: tools(endpoint) });
    expect(continuation.status).toBe(200);
    expect(continuation.headers.get('x-chat2claude-backend')).toBe('codex');
    expect(f.codex.calls).toHaveLength(2);
    expect(f.codex.calls[1].request.inputItems).toContainEqual({ type: 'replay', item: { type: 'reasoning', id: 'reasoning_codex_1', summary: [], encrypted_content: CIPHER } });
    expect(f.wire).toHaveLength(0);
  });
});
