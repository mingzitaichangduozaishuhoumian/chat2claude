import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { CodexOAuthClient, CODEX_OAUTH_SCOPE } from './codex-oauth-client.js';
import { ChatGptAuthFlowService } from './chatgpt-auth-flow.js';
import { ChatGptProvisioningError } from './setup-provisioner.js';

describe('CodexOAuthClient', () => {
  it('builds the current official authorization request with an honest originator', () => {
    const client = new CodexOAuthClient();
    const url = new URL(client.buildAuthorizeUrl({ state: 'state', codeVerifier: 'verifier', redirectUri: 'http://localhost:1455/auth/callback' }));
    expect(url.searchParams.get('scope')).toBe(CODEX_OAUTH_SCOPE);
    expect(url.searchParams.get('originator')).toBe('chat2claude');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
  });

  it('refreshes with rotation while preserving non-OAuth metadata and the old refresh token when omitted', async () => {
    const requests: URLSearchParams[] = [];
    const responses = [
      { access_token: 'access-2', refresh_token: 'refresh-2', id_token: 'id-2', expires_in: 120 },
      { access_token: 'access-3', expires_in: 120 },
    ];
    const client = new CodexOAuthClient({ now: () => new Date('2026-08-22T00:00:00.000Z'), fetch: async (_url, init) => {
      requests.push(init?.body as URLSearchParams);
      return Response.json(responses.shift());
    } });
    const original = { type: 'chatgpt-session' as const, accessToken: 'access-1', refreshToken: 'refresh-1', idToken: 'id-1', email: 'me@example.test', accountId: 'acct', cookie: 'a=b', deviceId: 'device', userAgent: 'ua' };
    const rotated = await client.refreshSecret(original);
    const retained = await client.refreshSecret(rotated);
    expect(requests[0].get('grant_type')).toBe('refresh_token');
    expect(requests[0].get('refresh_token')).toBe('refresh-1');
    expect(rotated).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', idToken: 'id-2', email: 'me@example.test', accountId: 'acct', cookie: 'a=b', deviceId: 'device', userAgent: 'ua' });
    expect(retained.refreshToken).toBe('refresh-2');
  });

  it('does not expose token endpoint response details in errors', async () => {
    const client = new CodexOAuthClient({ fetch: async () => Response.json({ error_description: 'contains-secret-token' }, { status: 401 }) });
    await expect(client.refreshSecret({ type: 'chatgpt-session', refreshToken: 'refresh-secret' })).rejects.toMatchObject({ message: 'Codex OAuth token request was rejected.', code: 'unauthorized' });
  });

  it('maps token endpoint HTTP 429 to a typed rate limit error', async () => {
    const client = new CodexOAuthClient({ fetch: async () => Response.json({ error: 'rate_limit_exceeded' }, { status: 429 }) });
    await expect(client.refreshSecret({ type: 'chatgpt-session', refreshToken: 'refresh-secret' })).rejects.toMatchObject({
      message: 'Codex OAuth token request was rejected.',
      code: 'rate_limited',
      status: 429,
    });
  });
});

describe('ChatGptAuthFlowService', () => {
  it('uses cryptographic URL-safe IDs/state and exchanges a callback immediately only once', async () => {
    let exchanges = 0;
    const service = new ChatGptAuthFlowService({ enableCallbackListener: false, fetch: async () => {
      exchanges += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 });
    } });
    const started = await service.start();
    const authorizeUrl = new URL(started.authorizeUrl);
    const state = authorizeUrl.searchParams.get('state')!;
    expect(started.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizeUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await expect(service.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=code-secret&state=${state}` })).resolves.toMatchObject({ state: 'ready' });
    await expect(service.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=other&state=${state}` })).resolves.toBeUndefined();
    const [first, second] = await Promise.all([service.status(started.id), service.status(started.id)]);
    expect(exchanges).toBe(1);
    expect(first?.state).toBe('ready');
    expect(second?.state).toBe('ready');
    expect(JSON.stringify(first)).not.toContain('secret');
  });

  it.each([
    'https://localhost:1455/auth/callback',
    'http://127.0.0.1:1455/auth/callback',
    'http://localhost:1457/auth/callback',
    'http://localhost:1455/wrong',
    'http://user@localhost:1455/auth/callback',
  ])('rejects callback URL mismatch: %s', async (base) => {
    const service = new ChatGptAuthFlowService({ enableCallbackListener: false });
    const started = await service.start();
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    await expect(service.completeCallback({ redirectUrl: `${base}?code=code&state=${state}` })).rejects.toThrow('does not match');
  });

  it('rejects callback URL fragments', async () => {
    const service = new ChatGptAuthFlowService({ enableCallbackListener: false });
    const started = await service.start();
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    await expect(service.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=code&state=${state}#fragment` })).rejects.toThrow('does not match');
  });

  it('rejects duplicate and conflicting OAuth callback parameters without consuming state', async () => {
    const service = new ChatGptAuthFlowService({ enableCallbackListener: false, fetch: async () => Response.json({ access_token: 'access-secret' }) });
    const started = await service.start();
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    await expect(service.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=a&code=b&state=${state}` })).rejects.toThrow('duplicate code');
    await expect(service.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=a&error=denied&state=${state}` })).rejects.toThrow('both code and error');
    await expect(service.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=valid&state=${state}` })).resolves.toMatchObject({ state: 'ready' });
  });

  it('runs provisioning once and clears the flow secret copy', async () => {
    const service = new ChatGptAuthFlowService({ enableCallbackListener: false, fetch: async () => Response.json({ access_token: 'access-secret' }) });
    const started = await service.start();
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    await service.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=code&state=${state}` });
    await service.status(started.id);
    let calls = 0;
    const provision = async (_secret: unknown, _signal: AbortSignal, commit: <T>(apply: (committedAt: Date) => T) => T) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return commit(() => ({ apiKey: 'key' }));
    };
    const [first, second] = await Promise.all([service.provision(started.id, provision), service.provision(started.id, provision)]);
    expect(calls).toBe(1);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ state: 'ready', provisioned: true, provisionResult: { apiKey: 'key' } });
  });

  it('returns a stage-aware provisioning error without leaking secret or cause details', async () => {
    const service = new ChatGptAuthFlowService({ enableCallbackListener: false, fetch: async () => Response.json({ access_token: 'access-secret' }) });
    const started = await service.start();
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    await service.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=code-secret&state=${state}` });

    const result = await service.provision(started.id, async () => {
      throw new ChatGptProvisioningError({ stage: 'model_preparation', code: 'unauthorized', status: 401, message: 'ChatGPT model preparation failed.' }, { cause: new Error('access-secret / C:\\private\\runtime-state.json') });
    });

    expect(result).toMatchObject({
      state: 'error',
      error: 'ChatGPT model preparation failed.（unauthorized, HTTP 401）',
      message: '自动初始化在模型准备阶段失败（unauthorized, HTTP 401）。请重新授权后重试模型准备。',
    });
    expect(JSON.stringify(result)).not.toContain('access-secret');
    expect(JSON.stringify(result)).not.toContain('runtime-state.json');
  });

  it('rejects raw code/state callback input', async () => {
    const service = new ChatGptAuthFlowService({ enableCallbackListener: false });
    const started = await service.start();
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    await expect(service.completeCallback({ code: 'code', state } as never)).rejects.toThrow('Full OAuth callback URL is required');
  });

  it('does not restore a cancelled flow after an in-flight exchange resolves', async () => {
    const exchange = deferred<Response>();
    const service = new ChatGptAuthFlowService({ enableCallbackListener: false, fetch: async () => exchange.promise });
    const started = await service.start();
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    const completing = service.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=code&state=${state}` });
    await Promise.resolve();
    await expect(service.cancel(started.id)).resolves.toMatchObject({ state: 'cancelled' });
    exchange.resolve(Response.json({ access_token: 'stale-access' }));
    await expect(completing).resolves.toMatchObject({ state: 'cancelled' });
    await expect(service.status(started.id)).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('passes the exchange abort signal to token fetch and leaves cancellation terminal', async () => {
    const entered = deferred<void>();
    const aborted = deferred<void>();
    const service = new ChatGptAuthFlowService({ enableCallbackListener: false, fetch: async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      entered.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted.resolve();
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    } });
    const started = await service.start();
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    const completing = service.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=code&state=${state}` });
    await entered.promise;
    await service.cancel(started.id);
    await aborted.promise;
    await expect(completing).resolves.toMatchObject({ state: 'cancelled' });
    await expect(service.status(started.id)).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('aborts an in-flight token fetch when the flow deadline expires', async () => {
    const entered = deferred<void>();
    const aborted = deferred<void>();
    const service = new ChatGptAuthFlowService({ enableCallbackListener: false, ttlMs: 50, fetch: async (_url, init) => {
      entered.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted.resolve();
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    } });
    const started = await service.start();
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    const completing = service.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=code&state=${state}` });
    await entered.promise;
    await aborted.promise;
    await expect(completing).resolves.toMatchObject({ state: 'expired' });
    await expect(service.status(started.id)).resolves.toMatchObject({ state: 'expired' });
  });

  it('expires instead of committing an in-flight exchange result', async () => {
    let now = new Date('2026-08-22T00:00:00.000Z');
    const exchange = deferred<Response>();
    const service = new ChatGptAuthFlowService({ enableCallbackListener: false, ttlMs: 1000, now: () => now, fetch: async () => exchange.promise });
    const started = await service.start();
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    const completing = service.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=code&state=${state}` });
    await Promise.resolve();
    now = new Date('2026-08-22T00:00:02.000Z');
    exchange.resolve(Response.json({ access_token: 'stale-access' }));
    await expect(completing).resolves.toMatchObject({ state: 'expired' });
  });

  it('aborts provisioning on cancellation and preserves the cancelled state', async () => {
    const service = new ChatGptAuthFlowService({ enableCallbackListener: false, fetch: async () => Response.json({ access_token: 'access-secret' }) });
    const started = await service.start();
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    await service.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=code&state=${state}` });
    await service.status(started.id);
    const entered = deferred<void>();
    const release = deferred<void>();
    let committed = false;
    let aborted = false;
    const provisioning = service.provision(started.id, async (_secret, signal, commit) => {
      entered.resolve();
      await release.promise;
      aborted = signal.aborted;
      if (signal.aborted) return { ok: false };
      return commit(() => {
        committed = true;
        return { ok: true };
      });
    });
    await entered.promise;
    await service.cancel(started.id);
    release.resolve();
    await expect(provisioning).resolves.toMatchObject({ state: 'cancelled' });
    expect(await service.status(started.id)).not.toHaveProperty('provisioned');
    expect(aborted).toBe(true);
    expect(committed).toBe(false);
  });

  it('retains the provisioning completion message on later status polls', async () => {
    const service = new ChatGptAuthFlowService({ enableCallbackListener: false, fetch: async () => Response.json({ access_token: 'access-secret' }) });
    const started = await service.start();
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    await service.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=code&state=${state}` });
    await service.status(started.id);
    const completed = await service.provision(started.id, async (_secret, _signal, commit) => commit(() => ({ ok: true })));
    expect(completed?.message).toBe('ChatGPT 授权和 API 初始化已完成。');
    await expect(service.status(started.id)).resolves.toMatchObject({ state: 'ready', provisioned: true, message: 'ChatGPT 授权和 API 初始化已完成。' });
  });

  it.each(['EAFNOSUPPORT', 'EADDRNOTAVAIL'] as const)('keeps the preferred port when IPv6 bind fails with %s and IPv4 succeeds', async (code) => {
    const listener = scriptedServerFactory([code, 'success']);
    const service = new ChatGptAuthFlowService({ callbackServerFactory: listener.factory });
    try {
      const started = await service.start();
      expect(new URL(started.authorizeUrl).searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
      expect(listener.attempts).toEqual([
        { port: 1455, host: '::1', ipv6Only: true },
        { port: 1455, host: '127.0.0.1', ipv6Only: false },
      ]);
    } finally {
      await service.close();
    }
    expect(listener.openServers()).toHaveLength(0);
  });

  it('falls back immediately after IPv6 EADDRINUSE without trying IPv4 on the occupied port', async () => {
    const listener = scriptedServerFactory(['EADDRINUSE', 'success', 'success']);
    const service = new ChatGptAuthFlowService({ callbackServerFactory: listener.factory });
    try {
      const started = await service.start();
      expect(new URL(started.authorizeUrl).searchParams.get('redirect_uri')).toBe('http://localhost:1457/auth/callback');
      expect(listener.attempts).toEqual([
        { port: 1455, host: '::1', ipv6Only: true },
        { port: 1457, host: '::1', ipv6Only: true },
        { port: 1457, host: '127.0.0.1', ipv6Only: false },
      ]);
    } finally {
      await service.close();
    }
    expect(listener.openServers()).toHaveLength(0);
  });

  it('closes an opened IPv6 socket before falling back when IPv4 reports EADDRINUSE', async () => {
    const listener = scriptedServerFactory(['success', 'EADDRINUSE', 'success', 'success']);
    const service = new ChatGptAuthFlowService({ callbackServerFactory: listener.factory });
    try {
      const started = await service.start();
      expect(new URL(started.authorizeUrl).searchParams.get('redirect_uri')).toBe('http://localhost:1457/auth/callback');
      expect(listener.servers[0].closeCalls).toBe(1);
      expect(listener.servers[0].listening).toBe(false);
      expect(listener.attempts).toEqual([
        { port: 1455, host: '::1', ipv6Only: true },
        { port: 1455, host: '127.0.0.1', ipv6Only: false },
        { port: 1457, host: '::1', ipv6Only: true },
        { port: 1457, host: '127.0.0.1', ipv6Only: false },
      ]);
    } finally {
      await service.close();
    }
    expect(listener.openServers()).toHaveLength(0);
  });

  it('closes every socket opened while both callback ports fail', async () => {
    const listener = scriptedServerFactory(['success', 'EADDRINUSE', 'success', 'EADDRINUSE']);
    const service = new ChatGptAuthFlowService({ callbackServerFactory: listener.factory });
    const started = await service.start();
    expect(new URL(started.authorizeUrl).searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(started.message).toContain('本地 callback listener 未能启动');
    expect(listener.servers.filter((server) => server.closeCalls === 1)).toHaveLength(2);
    expect(listener.openServers()).toHaveLength(0);
    await service.close();
    expect(listener.openServers()).toHaveLength(0);
  });

  it('serializes concurrent listener startup and gives every flow the fallback port', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => blocker.once('error', reject).listen(1455, '127.0.0.1', () => resolve()));
    const service = new ChatGptAuthFlowService();
    try {
      const started = await Promise.all([service.start(), service.start(), service.start()]);
      expect(started.map((flow) => new URL(flow.authorizeUrl).searchParams.get('redirect_uri'))).toEqual([
        'http://localhost:1457/auth/callback',
        'http://localhost:1457/auth/callback',
        'http://localhost:1457/auth/callback',
      ]);
    } finally {
      await service.close();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('uses 1457 when the default 1455 listener is occupied', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => blocker.once('error', reject).listen(1455, '127.0.0.1', () => resolve()));
    const service = new ChatGptAuthFlowService();
    try {
      const started = await service.start();
      expect(new URL(started.authorizeUrl).searchParams.get('redirect_uri')).toBe('http://localhost:1457/auth/callback');
      if (await supportsIpv6Loopback()) {
        const probe = createServer();
        await new Promise<void>((resolve, reject) => probe.once('error', reject).listen({ port: 1455, host: '::1', ipv6Only: true }, () => resolve()));
        await new Promise<void>((resolve) => probe.close(() => resolve()));
      }
    } finally {
      await service.close();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('serves the authorize redirect_uri on localhost and returns defensive callback headers', async () => {
    const port = await reservePort();
    const service = new ChatGptAuthFlowService({ callbackPort: port, fetch: async () => Response.json({ access_token: 'access-secret' }) });
    try {
      const started = await service.start();
      const authorizeUrl = new URL(started.authorizeUrl);
      const state = authorizeUrl.searchParams.get('state')!;
      const callbackUrl = new URL(authorizeUrl.searchParams.get('redirect_uri')!);
      const wrong = await fetch(new URL('/wrong', callbackUrl));
      expect(wrong.status).toBe(404);
      callbackUrl.searchParams.set('code', 'code');
      callbackUrl.searchParams.set('state', state);
      const valid = await fetch(callbackUrl);
      expect(valid.status).toBe(200);
      expect(valid.headers.get('cache-control')).toBe('no-store');
      expect(valid.headers.get('referrer-policy')).toBe('no-referrer');
      expect(valid.headers.get('x-content-type-options')).toBe('nosniff');
      expect(valid.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(await service.status(started.id)).toMatchObject({ state: 'ready' });
      const replay = await fetch(callbackUrl);
      expect(replay.status).toBe(404);
    } finally {
      await service.close();
    }
  });

  it('accepts callbacks on IPv4 and IPv6 loopback when IPv6 is available', async () => {
    const port = await reservePort();
    const ipv6Available = await supportsIpv6Loopback();
    const service = new ChatGptAuthFlowService({ callbackPort: port, fetch: async () => Response.json({ access_token: 'access-secret' }) });
    try {
      const ipv4Flow = await service.start();
      const ipv4Authorize = new URL(ipv4Flow.authorizeUrl);
      const ipv4Callback = callbackForHost(ipv4Authorize, '127.0.0.1', 'ipv4-code');
      expect((await fetch(ipv4Callback)).status).toBe(200);

      if (ipv6Available) {
        const ipv6Flow = await service.start();
        const ipv6Authorize = new URL(ipv6Flow.authorizeUrl);
        const ipv6Callback = callbackForHost(ipv6Authorize, '[::1]', 'ipv6-code');
        expect((await fetch(ipv6Callback)).status).toBe(200);
      }
    } finally {
      await service.close();
    }
  });

  it('closes every loopback listener socket', async () => {
    const port = await reservePort();
    const ipv6Available = await supportsIpv6Loopback();
    const service = new ChatGptAuthFlowService({ callbackPort: port });
    const started = await service.start();
    const redirectUri = new URL(started.authorizeUrl).searchParams.get('redirect_uri')!;
    expect((await fetch(new URL('/wrong', redirectUri))).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/wrong`)).status).toBe(404);
    if (ipv6Available) expect((await fetch(`http://[::1]:${port}/wrong`)).status).toBe(404);

    await service.close();

    await expect(fetch(`http://127.0.0.1:${port}/wrong`)).rejects.toThrow();
    if (ipv6Available) await expect(fetch(`http://[::1]:${port}/wrong`)).rejects.toThrow();
  });

  it.each(['http://localhost:3100/admin', 'http://localhost:3100?next=x', 'http://user@localhost:3100', 'ftp://localhost:3100'])('rejects an unsafe internal return origin: %s', async (returnOrigin) => {
    const service = new ChatGptAuthFlowService({ enableCallbackListener: false });
    await expect(service.start({ returnOrigin })).rejects.toThrow('exact HTTP(S) origin');
  });

  it('redirects successful listener callbacks with a non-sensitive flow locator and defensive headers', async () => {
    const port = await reservePort();
    const service = new ChatGptAuthFlowService({ callbackPort: port, fetch: async () => Response.json({ access_token: 'access-secret' }) });
    try {
      const started = await service.start({ returnOrigin: 'http://localhost:3100' });
      const authorizeUrl = new URL(started.authorizeUrl);
      const callbackUrl = new URL(authorizeUrl.searchParams.get('redirect_uri')!);
      callbackUrl.searchParams.set('code', 'code-secret');
      callbackUrl.searchParams.set('state', authorizeUrl.searchParams.get('state')!);
      const response = await fetch(callbackUrl, { redirect: 'manual' });
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get('location')!);
      expect(location.origin + location.pathname).toBe('http://localhost:3100/admin');
      expect(location.searchParams.get('oauth_flow')).toBe(started.id);
      expect(location.toString()).not.toContain('code-secret');
      expect(location.toString()).not.toContain(authorizeUrl.searchParams.get('state')!);
      expect(location.toString()).not.toContain('access-secret');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(response.headers.get('content-length')).toBe('0');
    } finally {
      await service.close();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function callbackForHost(authorizeUrl: URL, host: string, code: string): URL {
  const callback = new URL(authorizeUrl.searchParams.get('redirect_uri')!);
  callback.host = `${host}:${callback.port}`;
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', authorizeUrl.searchParams.get('state')!);
  return callback;
}

async function supportsIpv6Loopback(): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen({ port: 0, host: '::1', ipv6Only: true }, () => resolve()));
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to reserve port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

type ScriptedListenOutcome = 'success' | 'EAFNOSUPPORT' | 'EADDRNOTAVAIL' | 'EADDRINUSE';
type ScriptedServer = Server & { closeCalls: number };

function scriptedServerFactory(outcomes: ScriptedListenOutcome[]) {
  const remaining = [...outcomes];
  const attempts: Array<{ port: number; host: string; ipv6Only: boolean }> = [];
  const servers: ScriptedServer[] = [];
  const factory = () => {
    const server = new EventEmitter() as ScriptedServer;
    Object.defineProperty(server, 'listening', { configurable: true, value: false, writable: true });
    server.closeCalls = 0;
    server.listen = ((options: { port: number; host: string; ipv6Only: boolean }) => {
      attempts.push({ port: options.port, host: options.host, ipv6Only: options.ipv6Only });
      const outcome = remaining.shift();
      if (!outcome) throw new Error('Unexpected loopback listen attempt');
      queueMicrotask(() => {
        if (outcome === 'success') {
          Object.defineProperty(server, 'listening', { configurable: true, value: true, writable: true });
          server.emit('listening');
          return;
        }
        const error = Object.assign(new Error(`bind ${outcome}`), { code: outcome }) as NodeJS.ErrnoException;
        server.emit('error', error);
      });
      return server;
    }) as unknown as ScriptedServer['listen'];
    server.close = ((callback?: (error?: Error) => void) => {
      server.closeCalls += 1;
      Object.defineProperty(server, 'listening', { configurable: true, value: false, writable: true });
      queueMicrotask(() => callback?.());
      return server;
    }) as unknown as ScriptedServer['close'];
    servers.push(server);
    return server;
  };
  return { factory, attempts, servers, openServers: () => servers.filter((server) => server.listening) };
}
