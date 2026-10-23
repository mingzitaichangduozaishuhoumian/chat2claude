import { TextDecoder } from 'node:util';
import type { WebGatewayConfiguration } from './web-gateway.js';

export interface WebGatewayConnectionStatus {
  state: 'unconfigured' | 'unchecked' | 'reachable' | 'auth_failed' | 'not_ready' | 'unreachable' | 'timeout' | 'unsupported' | 'invalid_response';
  checkedAt?: string;
  httpStatus?: number;
  method?: 'models' | 'health';
}

export interface WebGatewayConnectionOptions {
  configuration: WebGatewayConfiguration | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const MAX_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 64 * 1024;
const INVALID_RESPONSE = Symbol('invalid gateway probe response');
type ProbeMethod = NonNullable<WebGatewayConnectionStatus['method']>;

/** Checks HTTP connectivity without submitting a prompt or starting a browser login.
 * A reachable result does not establish browser-session or generation readiness.
 */
export async function checkWebGatewayConnection(options: WebGatewayConnectionOptions): Promise<WebGatewayConnectionStatus> {
  if (options.signal?.aborted) throw cancelled();
  if (!options.configuration) return { state: 'unconfigured' };
  const checkedAt = new Date().toISOString();
  const result = (state: WebGatewayConnectionStatus['state'], method?: ProbeMethod, httpStatus?: number): WebGatewayConnectionStatus => ({
    state, checkedAt, ...(method ? { method } : {}), ...(httpStatus === undefined ? {} : { httpStatus }),
  });
  let endpoints: { models: string; health: string };
  let headers: Headers;
  const requestedTimeout = options.timeoutMs ?? MAX_TIMEOUT_MS;
  try {
    if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout <= 0) throw INVALID_RESPONSE;
    endpoints = probeEndpoints(options.configuration);
    headers = new Headers({ accept: 'application/json' });
    if (options.configuration.apiKey) headers.set('authorization', `Bearer ${options.configuration.apiKey}`);
  } catch { return result('invalid_response'); }

  const lifetime = probeLifetime(Math.min(requestedTimeout, MAX_TIMEOUT_MS), options.signal);
  const fetchImpl = options.fetch ?? fetch;
  let method: ProbeMethod = 'models';
  let httpStatus: number | undefined;
  let response: Response | undefined;
  try {
    for (const current of ['models', 'health'] as const) {
      method = current;
      httpStatus = undefined;
      const currentResponse: Response = await lifetime.run<Response>(() => fetchImpl(endpoints[current], {
        method: 'GET', headers, redirect: 'error', credentials: 'omit', signal: lifetime.signal,
      }).then((value) => {
        if (lifetime.signal.aborted) cancelBody(value);
        return value;
      }));
      response = currentResponse;
      httpStatus = currentResponse.status;
      if (httpStatus === 401 || httpStatus === 403) return result('auth_failed', method, httpStatus);
      if (httpStatus === 404 || httpStatus === 405) {
        if (current === 'health') return result('unsupported', method, httpStatus);
        cancelBody(response);
        response = undefined;
        continue;
      }
      if (httpStatus === 429 || httpStatus >= 500) return result('not_ready', method, httpStatus);
      if (!currentResponse.ok) return result('invalid_response', method, httpStatus);
      const payload = await readProbeBody(currentResponse, lifetime);
      lifetime.check();
      if (!isObject(payload)) return result('invalid_response', method, httpStatus);
      if (current === 'models') return result(Array.isArray(payload.data) ? 'reachable' : 'invalid_response', method, httpStatus);
      // The pinned gateway's /health returns only {status:'ok'}. It deliberately
      // does not inspect the browser session and has no /health/ready endpoint.
      if (payload.status === 'ok') return result('reachable', method, httpStatus);
      if (typeof payload.status === 'string' && ['not_ready', 'degraded', 'unhealthy', 'stuck', 'error', 'starting'].includes(payload.status)) {
        return result('not_ready', method, httpStatus);
      }
      return result('invalid_response', method, httpStatus);
    }
    return result('unsupported', method, httpStatus);
  } catch (error) {
    if (options.signal?.aborted) throw cancelled();
    if (lifetime.signal.aborted) return result('timeout', method, httpStatus);
    return result(error === INVALID_RESPONSE ? 'invalid_response' : 'unreachable', method, httpStatus);
  } finally {
    cancelBody(response);
    lifetime.dispose();
  }
}

function probeEndpoints(configuration: WebGatewayConfiguration): { models: string; health: string } {
  const url = new URL(configuration.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || configuration.apiKey !== undefined && (typeof configuration.apiKey !== 'string' || /[\r\n]/.test(configuration.apiKey))) {
    throw INVALID_RESPONSE;
  }
  const base = url.href.replace(/\/+$/, '');
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base;
  return { models: `${base.endsWith('/v1') ? base : `${base}/v1`}/models`, health: `${root}/health` };
}

async function readProbeBody(response: Response, lifetime: ReturnType<typeof probeLifetime>): Promise<unknown> {
  const length = response.headers.get('content-length');
  if ((length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) || !response.body) throw INVALID_RESPONSE;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await lifetime.run(() => reader.read());
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw INVALID_RESPONSE;
      try { text += decoder.decode(chunk.value, { stream: true }); } catch { throw INVALID_RESPONSE; }
    }
    try { return JSON.parse(text + decoder.decode()) as unknown; } catch { throw INVALID_RESPONSE; }
  } finally {
    try { void reader.cancel().catch(() => {}); } catch { /* Do not wait for provider cleanup. */ }
    try { reader.releaseLock(); } catch { /* Pending reads settle on cancellation. */ }
  }
}

function probeLifetime(timeoutMs: number, caller?: AbortSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, timeoutMs);
  caller?.addEventListener('abort', cancel, { once: true });
  if (caller?.aborted) cancel();
  return {
    signal: controller.signal,
    check() { if (controller.signal.aborted) throw INVALID_RESPONSE; },
    dispose() { clearTimeout(timer); caller?.removeEventListener('abort', cancel); },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (controller.signal.aborted) throw INVALID_RESPONSE;
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(INVALID_RESPONSE);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const value = await Promise.race([operation(), aborted]);
        if (controller.signal.aborted) throw INVALID_RESPONSE;
        return value;
      } finally { controller.signal.removeEventListener('abort', onAbort); }
    },
  };
}

function cancelBody(response?: Response): void {
  try { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); } catch { /* Best effort. */ }
}

function cancelled(): Error { const error = new Error('Web gateway connection check was cancelled.'); error.name = 'AbortError'; return error; }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
