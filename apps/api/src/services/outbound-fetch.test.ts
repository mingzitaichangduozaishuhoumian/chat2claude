import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGlobalDispatcher, ProxyAgent } from 'undici';
import { createOutboundTransport } from './outbound-fetch.js';
import { loadEnv } from '../config/env.js';
import { AccountPool } from './account-pool.js';
import { createChatGptBackend } from './backend-factory.js';
import { ChatGptAuthFlowService } from './chatgpt-auth-flow.js';
import { CODEX_TOKEN_URL } from './codex-oauth-client.js';
import { createApp } from '../app.js';

afterEach(() => vi.restoreAllMocks());

describe('explicit outbound proxy transport', () => {
  it('leaves fetch and the global dispatcher untouched when unset', async () => {
    const global = getGlobalDispatcher();
    const transport = createOutboundTransport();
    expect(transport.fetch).toBe(fetch);
    expect(getGlobalDispatcher()).toBe(global);
    await transport.close();
  });

  it('preserves request options and adds only an app-owned dispatcher', async () => {
    const original = getGlobalDispatcher();
    const response = new Response('ok');
    const fetchImpl = vi.fn<typeof fetch>(async () => response);
    const transport = createOutboundTransport('http://user:proxy-canary@127.0.0.1:7890', fetchImpl);
    const signal = new AbortController().signal;
    const init = { method: 'POST', body: 'request', signal, headers: { test: 'header' } };
    expect(await transport.fetch('https://chatgpt.test', init)).toBe(response);
    expect(fetchImpl).toHaveBeenCalledWith('https://chatgpt.test', { ...init, dispatcher: expect.any(ProxyAgent) });
    expect(init).not.toHaveProperty('dispatcher');
    expect(getGlobalDispatcher()).toBe(original);
    const dispatcher = (fetchImpl.mock.calls[0][1] as unknown as { dispatcher: ProxyAgent }).dispatcher;
    const close = vi.spyOn(dispatcher, 'close');
    await transport.close();
    expect(close).toHaveBeenCalled();
    expect(transport.close()).toBe(transport.close());
  });

  it.each([
    { name: 'without authentication', proxyCredentials: '', expectedAuthorization: undefined },
    { name: 'with a password', proxyCredentials: 'u%73er:p%72oxy-canary@', expectedAuthorization: `Basic ${Buffer.from('user:proxy-canary').toString('base64')}` },
    { name: 'with an empty password', proxyCredentials: 'user:@', expectedAuthorization: `Basic ${Buffer.from('user:').toString('base64')}` },
  ])('routes native fetch through a local CONNECT proxy ($name)', async ({ proxyCredentials, expectedAuthorization }) => {
    const proxy = createServer();
    const connect = vi.fn();
    let targetRequest = '';
    proxy.on('connect', (request, socket) => {
      connect(request.url, request.headers['proxy-authorization']);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', (data) => {
        targetRequest = data.toString();
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const port = (proxy.address() as AddressInfo).port;
    const transport = createOutboundTransport(`http://${proxyCredentials}127.0.0.1:${port}`);
    try {
      const response = await transport.fetch('http://provider.invalid/test', { signal: AbortSignal.timeout(3000) });
      expect(await response.text()).toBe('ok');
      expect(connect).toHaveBeenCalledWith('provider.invalid:80', expectedAuthorization);
      expect(targetRequest).toContain('GET /test');
      expect(targetRequest.toLowerCase()).not.toContain('proxy-authorization');
      expect(targetRequest).not.toContain('proxy-canary');
    } finally {
      await transport.close();
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('shares the proxy across OAuth exchange, refresh, models, quota and completion traffic', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === CODEX_TOKEN_URL) return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
      if (url.includes('/codex/models')) return Response.json({ models: [{ slug: 'test-model' }] });
      if (url.includes('/wham/')) return Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000 } } });
      return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');
    });
    const transport = createOutboundTransport('http://127.0.0.1:7890', fetchImpl);
    const flow = new ChatGptAuthFlowService({ enableCallbackListener: false, fetch: transport.fetch });
    try {
      const started = await flow.start();
      const state = new URL(started.authorizeUrl).searchParams.get('state');
      await expect(flow.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=code&state=${state}` })).resolves.toMatchObject({ state: 'ready' });
      const pool = new AccountPool({ seedMockAccount: false });
      pool.add({ id: 'session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'expired-access', refreshToken: 'refresh', expiresAt: '2000-01-01T00:00:00Z' } });
      const backend = createChatGptBackend(loadEnv({ CHATGPT_BACKEND: 'session' }), pool, undefined, transport.fetch);
      const context = { account: pool.get('session')! };
      expect(await backend.listModels(context)).toMatchObject([{ id: 'test-model' }]);
      await backend.getAccountQuota!({ account: pool.get('session')! });
      await backend.complete({ model: 'test-model', maxTokens: 8, messages: [{ role: 'user', content: 'hello' }] }, { account: pool.get('session')! });
      expect(fetchImpl.mock.calls.filter(([url]) => String(url) === CODEX_TOKEN_URL)).toHaveLength(2);
      const dispatchers = fetchImpl.mock.calls.map(([, init]) => (init as unknown as { dispatcher: ProxyAgent }).dispatcher);
      expect(dispatchers.length).toBeGreaterThanOrEqual(6);
      expect(dispatchers[0]).toBeInstanceOf(ProxyAgent);
      expect(new Set(dispatchers).size).toBe(1);
    } finally {
      await flow.close();
      await transport.close();
    }
  });

  it('wires app provider fetch explicitly without affecting Hono or exposing proxy credentials', async () => {
    const global = getGlobalDispatcher();
    const fetchImpl = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ models: [] }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let outboundFetch!: typeof fetch;
    const env = loadEnv({ OUTBOUND_PROXY_URL: 'http://user:proxy-canary@127.0.0.1:7890', CHATGPT_BACKEND: 'mock', API_KEYS: 'test-admin-key' });
    const app = createApp(env, {
      runtimeStateStore: null, operationalState: null,
      backendFactory: (pool, durable, transportFetch) => {
        outboundFetch = transportFetch;
        return createChatGptBackend(env, pool, durable, transportFetch);
      },
    });
    try {
      await outboundFetch('https://chatgpt.test/models');
      const dispatcher = (fetchImpl.mock.calls[0][1] as unknown as { dispatcher: ProxyAgent }).dispatcher;
      expect(dispatcher).toBeInstanceOf(ProxyAgent);
      const close = vi.spyOn(dispatcher, 'close');
      for (const path of ['/healthz', '/admin', '/admin/api/setup/status', '/admin/api/accounts']) {
        const response = await app.request(path, { headers: { 'x-api-key': 'test-admin-key' } });
        expect(response.status).toBe(200);
        expect(await response.text()).not.toContain('proxy-canary');
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(getGlobalDispatcher()).toBe(global);
      expect(JSON.stringify(log.mock.calls)).not.toContain('proxy-canary');
      await app.dispose();
      expect(close).toHaveBeenCalled();
    } finally {
      await app.dispose();
    }
  });
});
