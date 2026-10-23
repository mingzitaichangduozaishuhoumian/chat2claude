import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkWebGatewayConnection, type WebGatewayConfiguration } from './index.js';

const configuration: WebGatewayConfiguration = { baseUrl: 'http://gateway.test', apiKey: 'GATEWAY_KEY_CANARY', models: ['auto'] };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function probe(responses: Response[]) {
  const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => responses.shift()!);
  return { fetchMock, check: (config: WebGatewayConfiguration = configuration) => checkWebGatewayConnection({ configuration: config, fetch: fetchMock }) };
}

describe('checkWebGatewayConnection', () => {
  it('returns unconfigured without performing a request', async () => {
    const fetchMock = vi.fn();
    expect(await checkWebGatewayConnection({ configuration: undefined, fetch: fetchMock })).toEqual({ state: 'unconfigured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks only GET models with isolated authorization and safe transport settings', async () => {
    const { fetchMock, check } = probe([Response.json({ data: [] })]);
    const result = await check();
    expect(result).toEqual({ state: 'reachable', method: 'models', httpStatus: 200, checkedAt: expect.any(String) });
    expect(Number.isFinite(Date.parse(result.checkedAt!))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gateway.test/v1/models');
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal) });
    expect(init!.body).toBeUndefined();
    expect(Object.fromEntries(new Headers(init!.headers))).toEqual({ accept: 'application/json', authorization: 'Bearer GATEWAY_KEY_CANARY' });
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it.each([404, 405])('falls back from models HTTP %s to the pinned process-only health response', async (status) => {
    const cancel = vi.fn();
    const unavailable = new Response(new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }), { status });
    const { fetchMock, check } = probe([unavailable, Response.json({ status: 'ok' })]);
    expect(await check()).toMatchObject({ state: 'reachable', method: 'health', httpStatus: 200 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['http://gateway.test/v1/models', 'http://gateway.test/health']);
    expect(fetchMock.mock.calls.every(([, init]) => init!.method === 'GET' && init!.body === undefined)).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['http://gateway.test/v1/', 'http://gateway.test/prefix/v1', 'http://gateway.test/prefix/'])('respects API prefixes and removes only the terminal v1 segment: %s', async (baseUrl) => {
    const { fetchMock, check } = probe([new Response(null, { status: 404 }), Response.json({ status: 'ok' })]);
    await check({ ...configuration, baseUrl, apiKey: undefined });
    const base = baseUrl.replace(/\/+$/, '');
    const root = base.endsWith('/v1') ? base.slice(0, -3) : base;
    expect(fetchMock.mock.calls[0][0]).toBe(`${root}/v1/models`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${root}/health`);
    expect(new Headers(fetchMock.mock.calls[0][1]!.headers).has('authorization')).toBe(false);
  });

  it.each([401, 403, 429, 500, 503, 400])('classifies HTTP %s without exposing or reading its body', async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull() { throw new Error('BODY_CANARY'); }, cancel }, { highWaterMark: 0 });
    const { fetchMock, check } = probe([new Response(body, { status })]);
    const result = await check();
    expect(result).toMatchObject({ state: status === 401 || status === 403 ? 'auth_failed' : status === 429 || status >= 500 ? 'not_ready' : 'invalid_response', httpStatus: status, method: 'models' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it.each([401, 403, 503, 404, 405])('classifies fallback health HTTP %s without probing other routes', async (status) => {
    const { fetchMock, check } = probe([new Response(null, { status: 404 }), new Response('PRIVATE_BODY_CANARY', { status })]);
    expect(await check()).toMatchObject({ state: status === 401 || status === 403 ? 'auth_failed' : status === 503 ? 'not_ready' : 'unsupported', method: 'health', httpStatus: status });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { data: null }, { data: {} }, [], null])('rejects malformed models shape: %j', async (payload) => {
    const { fetchMock, check } = probe([Response.json(payload)]);
    expect(await check()).toMatchObject({ state: 'invalid_response', method: 'models' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { status: 'unknown' }, { status: true }, { status: { toString: null } }, { ok: true }, null])('rejects unrecognized health responses: %j', async (payload) => {
    const { check } = probe([new Response(null, { status: 404 }), Response.json(payload)]);
    expect(await check()).toMatchObject({ state: 'invalid_response', method: 'health' });
  });

  it.each(['not_ready', 'degraded', 'unhealthy', 'stuck', 'error', 'starting'])('reports explicit health state %s as not ready', async (status) => {
    const { check } = probe([new Response(null, { status: 404 }), Response.json({ status, reason: 'BODY_CANARY' })]);
    const result = await check();
    expect(result).toMatchObject({ state: 'not_ready', method: 'health', httpStatus: 200 });
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it.each(['<html>LOGIN_BODY_CANARY</html>', '{"data":'])('rejects a non-JSON body without exposing it', async (body) => {
    const { check } = probe([new Response(body)]);
    const result = await check();
    expect(result.state).toBe('invalid_response');
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it('rejects malformed UTF-8', async () => {
    const { check } = probe([new Response(new Uint8Array([0xff]))]);
    expect((await check()).state).toBe('invalid_response');
  });

  it.each([true, false])('bounds response bodies at 64 KiB, declared length=%s', async (declared) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new Uint8Array(64 * 1024 + 1)); }, cancel }, { highWaterMark: 0 });
    const { check } = probe([new Response(body, { headers: declared ? { 'content-length': String(64 * 1024 + 1) } : {} })]);
    expect((await check()).state).toBe('invalid_response');
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each(['ftp://gateway.test', 'http://user:URL_SECRET_CANARY@gateway.test', 'http://gateway.test/?token=URL_SECRET_CANARY', 'http://gateway.test/#SECRET_CANARY', 'invalid'])('does not fetch invalid or credential-bearing addresses: %s', async (baseUrl) => {
    const { fetchMock, check } = probe([]);
    const result = await check({ ...configuration, baseUrl });
    expect(result.state).toBe('invalid_response');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it('rejects invalid key headers without making a request', async () => {
    const { fetchMock, check } = probe([]);
    expect((await check({ ...configuration, apiKey: 'HEADER_CANARY\r\ninvalid' })).state).toBe('invalid_response');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sanitizes network failures, including redirect rejection', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('URL_CANARY HEADER_CANARY COOKIE_CANARY'); });
    const result = await checkWebGatewayConnection({ configuration, fetch: fetchMock });
    expect(result).toMatchObject({ state: 'unreachable', method: 'models' });
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it('honors an already cancelled caller without invoking fetch or exposing its reason', async () => {
    const controller = new AbortController();
    controller.abort('ABORT_CANARY');
    const fetchMock = vi.fn();
    const error = await checkWebGatewayConnection({ configuration, fetch: fetchMock, signal: controller.signal }).catch((value: unknown) => value);
    expect(error).toMatchObject({ name: 'AbortError', message: 'Web gateway connection check was cancelled.' });
    expect((error as Error).cause).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels active reads, releases the reader and does not await stuck cleanup', async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); }, cancel }, { highWaterMark: 0 });
    const fetchMock = vi.fn(async () => new Response(body));
    const pending = checkWebGatewayConnection({ configuration, fetch: fetchMock, signal: controller.signal });
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort(new Error('ABORT_CANARY'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('uses one bounded deadline across fallback and cancels a late response', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let resolve!: (response: Response) => void;
    const late = new Promise<Response>((done) => { resolve = done; });
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        await new Promise<void>((done) => setTimeout(done, 20));
        return new Response(null, { status: 404 });
      }
      return late;
    });
    const pending = checkWebGatewayConnection({ configuration, fetch: fetchMock, timeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toMatchObject({ state: 'timeout', method: 'health' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolve(new Response(new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps the total deadline at five seconds regardless of the generation timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    const pending = checkWebGatewayConnection({ configuration, fetch: fetchMock, timeoutMs: 300_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ state: 'timeout', method: 'models' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a stalled response body and releases its lock', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); }, cancel }, { highWaterMark: 0 });
    const pending = checkWebGatewayConnection({ configuration, fetch: vi.fn(async () => new Response(body)), timeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toMatchObject({ state: 'timeout', method: 'models', httpStatus: 200 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
