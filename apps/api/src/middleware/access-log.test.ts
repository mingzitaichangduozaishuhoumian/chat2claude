import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createLogger, type Logger } from '@chatgpt-to-claude/shared';
import { accessLog, getAccessLogStreamLifecycle, getAccessLogTerminal, normalizeAccessPath, setAccessLogMetadata, summarizeQuery, type HttpAccessLog } from './access-log.js';
import { apiKeyAuth } from './auth.js';
import { RuntimeApiKeys } from '../services/runtime-api-keys.js';
import { createApp } from '../app.js';

function capturedLogger(entries: HttpAccessLog[]): Logger {
  const capture = (message: string, meta?: unknown) => { if (message === 'HTTP access' && (meta as HttpAccessLog).phase !== 'request_started') entries.push(meta as HttpAccessLog); };
  return { debug: capture, info: capture, warn: capture, error: capture };
}

describe('accessLog', () => {
  it('normalizes dynamic quota active-reset paths without logging IDs', () => {
    expect(normalizeAccessPath('/admin/api/quotas/private-account/active-reset')).toBe('/admin/api/quotas/:accountId/active-reset');
    expect(normalizeAccessPath('/admin/api/quotas/private%2Faccount/active-reset')).toBe('/admin/api/quotas/:accountId/active-reset');
  });

  it.each(['text', 'json'] as const)('keeps %s logs single-line, sanitized and limited to fixed reasons', async (format) => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = new Hono();
    app.use('*', accessLog(createLogger(), format));
    app.post('/admin/api/accounts/:id', (c) => {
      setAccessLogMetadata(c, { model: 'private-model\ncanary-secret', stream: false });
      setAccessLogMetadata(c, { reason: 'account_busy_timeout' });
      return c.json({ error: 'private upstream canary-secret' }, 503);
    });
    try {
      await app.request('/admin/api/accounts/canary-secret?beta=canary-secret&canary-secret=canary-secret', {
        method: 'POST', headers: { authorization: 'Bearer canary-secret', cookie: 'canary-secret', 'x-forwarded-for': 'canary-secret' }, body: 'canary-secret',
      }, { incoming: { socket: { remoteAddress: 'bad-ip\ncanary-secret' } } });
      expect(sink).toHaveBeenCalledTimes(1);
      const line = String(sink.mock.calls[0][0]);
      expect(line).not.toMatch(/canary-secret|private|[\r\n]/);
      if (format === 'text') {
        expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[[a-f0-9]{8}\] \[ERROR\] \[<invali\] --> 503 \| \d+\.\d{3}s \| POST \/admin\/api\/accounts\/:accountId\?beta&other$/);
      } else {
        expect(JSON.parse(line)).toMatchObject({ level: 'error', message: 'HTTP access', meta: { path: '/admin/api/accounts/:accountId', query: { beta: true, other: true }, reason: 'account_busy_timeout', model: '<invalid-model-id>', durationKind: 'response_ready' } });
        expect(JSON.parse(line).meta.requestId).toHaveLength(36);
      }
    } finally { sink.mockRestore(); }
  });

  it('keeps concise text stream access logging to terminal outcomes only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = new Hono();
    app.use('*', accessLog(createLogger(), 'text'));
    let lifecycle: ReturnType<typeof getAccessLogStreamLifecycle>;
    let terminal: ReturnType<typeof getAccessLogTerminal>;
    app.get('/v1/messages', c => {
      lifecycle = getAccessLogStreamLifecycle(c);
      terminal = getAccessLogTerminal(c);
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    });

    await app.request('/v1/messages');
    lifecycle!({ lifecycle: 'start', downstreamEventCount: 1, downstreamBodyBytes: 12 });
    lifecycle!({ lifecycle: 'active', downstreamEventCount: 4, downstreamBodyBytes: 64 });
    terminal!({ outcome: 'success', downstreamEventCount: 4, downstreamBodyBytes: 64 });

    expect(log.mock.calls.map(([line]) => String(line)).filter(line => line.includes('STREAM START') || line.includes('STREAM ACTIVE'))).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--> STREAM DONE |'));
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });

  it.each(['text', 'json'] as const)('drops non-enum reasons in %s and does not inspect or delay an SSE body', async (format) => {
    const sink = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pull = vi.fn();
    let terminal: ReturnType<typeof getAccessLogTerminal>;
    const body = new ReadableStream<Uint8Array>({ pull, cancel() { terminal?.({ outcome: 'cancelled' }); } }, { highWaterMark: 0 });
    const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    const clone = vi.spyOn(response, 'clone');
    const app = new Hono();
    app.use('*', accessLog(createLogger(), format));
    app.get('/v1/messages', (c) => {
      terminal = getAccessLogTerminal(c);
      setAccessLogMetadata(c, { stream: true, reason: 'secret-injected-reason\n' as HttpAccessLog['reason'] });
      return response;
    });
    try {
      const result = await app.request('/v1/messages');
      expect(result.body).toBe(body);
      expect(pull).not.toHaveBeenCalled();
      expect(clone).not.toHaveBeenCalled();
      expect(sink).not.toHaveBeenCalled();
      await result.body!.cancel();
      if (format === 'text') expect(sink).toHaveBeenCalledWith(expect.stringContaining('--> STREAM CANCELLED |'));
      else {
        expect(sink).toHaveBeenCalledTimes(1);
        expect(String(sink.mock.calls[0][0])).not.toContain('reason');
      }
    } finally { sink.mockRestore(); }
  });

  it('suppresses successful read-only Admin polling only in concise text mode', async () => {
    for (const format of ['text', 'detailed', 'json'] as const) {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const app = new Hono();
      app.use('/admin/api/*', accessLog(createLogger(), format));
      app.get('/admin/api/setup/status', c => c.json({ ok: true }));
      app.on('HEAD', '/admin/api/setup/status', c => c.body(null, 204));
      app.post('/admin/api/setup/status', c => c.json({ ok: true }));
      app.get('/admin/api/auth/status', c => c.json({ error: 'safe' }, 503));
      try {
        await app.request('/admin/api/setup/status');
        await app.request('/admin/api/setup/status', { method: 'HEAD' });
        await app.request('/admin/api/setup/status', { method: 'POST' });
        await app.request('/admin/api/auth/status');
        if (format === 'text') {
          expect(log).toHaveBeenCalledTimes(2); // POST start + success; GET/HEAD 2xx are suppressed.
          expect(error).toHaveBeenCalledTimes(1); // Admin error preserved.
          expect(String(error.mock.calls[0][0])).toContain('--> 503 |');
        } else {
          expect(log.mock.calls.length + warn.mock.calls.length + error.mock.calls.length).toBeGreaterThanOrEqual(7);
        }
      } finally { log.mockRestore(); warn.mockRestore(); error.mockRestore(); }
    }
  });

  it('records response-ready metadata without leaking request secrets or body content', async () => {
    const entries: HttpAccessLog[] = [];
    const app = new Hono();
    app.use('/v1/*', accessLog(capturedLogger(entries)));
    app.post('/v1/messages', async (c) => {
      setAccessLogMetadata(c, { model: 'backend-test-model', stream: true });
      return c.json({ ok: true });
    });

    const response = await app.request('http://example.test/v1/messages?beta=enabled&api_key=query-secret&session=browser-secret', {
      method: 'POST',
      headers: { authorization: 'Bearer header-secret', cookie: 'session=cookie-secret', 'x-api-key': 'key-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'private prompt', tools: [{ input: 'private tool input' }], access_token: 'body-secret' }),
    });

    expect(response.status).toBe(200);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      method: 'POST',
      path: '/v1/messages',
      query: { beta: true, other: true },
      status: 200,
      durationKind: 'response_ready',
      peerIp: 'unknown',
      model: 'backend-test-model',
      stream: true,
    });
    expect(entries[0].requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(entries[0].durationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(entries[0])).not.toMatch(/enabled|query-secret|browser-secret|header-secret|cookie-secret|key-secret|private prompt|private tool input|body-secret/);
  });

  it('sanitizes invalid model IDs without echoing their raw values', async () => {
    const entries: HttpAccessLog[] = [];
    const app = new Hono();
    app.use('/v1/*', accessLog(capturedLogger(entries)));
    const invalidModels = [
      'model with spaces secret-token',
      'model-with-newline\nsecret-token',
      'model-with-trailing-newline\n',
      `model-${'x'.repeat(256)}-secret-token`,
    ];
    let requestIndex = 0;
    app.post('/v1/messages', (c) => {
      setAccessLogMetadata(c, { model: invalidModels[requestIndex++] });
      return c.json({ ok: true });
    });

    for (const model of invalidModels) {
      await app.request('http://example.test/v1/messages', { method: 'POST' });
    }

    expect(entries).toHaveLength(invalidModels.length);
    expect(entries.map((entry) => entry.model)).toEqual(invalidModels.map(() => '<invalid-model-id>'));
    for (const [index, model] of invalidModels.entries()) {
      expect(JSON.stringify(entries[index])).not.toContain(model);
    }
  });

  it('records auth failures, missing routes, and unhandled errors after response creation', async () => {
    const entries: HttpAccessLog[] = [];
    const app = new Hono();
    app.use('/v1/*', accessLog(capturedLogger(entries)));
    app.use('/v1/*', apiKeyAuth(['valid-key'], new RuntimeApiKeys()));
    app.get('/v1/forbidden', (c) => c.json({ error: 'forbidden' }, 403));
    app.get('/v1/fail', () => { throw new Error('raw failure with token secret'); });
    app.onError((_error, c) => c.json({ error: 'internal' }, 500));

    expect((await app.request('/v1/forbidden')).status).toBe(401);
    expect((await app.request('/v1/forbidden', { headers: { 'x-api-key': 'valid-key' } })).status).toBe(403);
    expect((await app.request('/v1/missing', { headers: { 'x-api-key': 'valid-key' } })).status).toBe(404);
    expect((await app.request('/v1/fail', { headers: { 'x-api-key': 'valid-key' } })).status).toBe(500);

    expect(entries.map((entry) => entry.status)).toEqual([401, 403, 404, 500]);
    expect(entries.map((entry) => entry.path)).toEqual(['/v1/:unknown', '/v1/:unknown', '/v1/:unknown', '/v1/:unknown']);
    expect(JSON.stringify(entries)).not.toContain('raw failure with token secret');
  });

  it('adds validated model and stream metadata for all completion protocols', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const app = createApp({
      port: 3000, host: '127.0.0.1', apiKeys: ['test-key'], allowAnonymousBootstrap: true, localContainerBootstrap: false,
      logLevel: 'info', accessLogFormat: 'json', mockResponsePrefix: 'Echo:', mockBackendModelsJson: JSON.stringify([{ id: 'backend-test-model' }]),
      chatGptBackend: 'mock', chatGptBaseUrl: 'https://chatgpt.com', chatGptRequestTimeoutMs: 60_000,
      defaultReasoningEffort: 'medium', defaultResponseSpeed: 'balanced', dataDir: '', runtimeStatePath: '', operationalStatePath: '',
    });
    const headers = { 'content-type': 'application/json', 'x-api-key': 'test-key' };

    try {
      const messages = await app.request('/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'backend-test-model', max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'private Claude prompt' }] }) });
      await messages.text();
      await app.request('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'backend-test-model', stream: false, messages: [{ role: 'user', content: 'private OpenAI prompt' }] }) });
      const responses = await app.request('/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'backend-test-model', stream: true, input: 'private Responses prompt', tools: [{ type: 'function', name: 'private_tool', parameters: { type: 'object' } }] }) });
      await responses.text();

      const entries = consoleLog.mock.calls
        .map(([line]) => JSON.parse(String(line)) as { message?: string; meta?: HttpAccessLog })
        .filter((entry) => entry.message === 'HTTP access')
        .map((entry) => entry.meta!);
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/v1/messages', model: 'backend-test-model', stream: true }),
        expect.objectContaining({ path: '/v1/chat/completions', model: 'backend-test-model', stream: false }),
        expect.objectContaining({ path: '/v1/responses', model: 'backend-test-model', stream: true }),
      ]));
      expect(JSON.stringify(entries)).not.toMatch(/private Claude prompt|private OpenAI prompt|private Responses prompt|private_tool|test-key/);
    } finally {
      consoleLog.mockRestore();
      await app.dispose();
    }
  });

  it('normalizes dynamic covered paths and treats malformed paths conservatively', () => {
    expect(normalizeAccessPath('/admin/api/accounts/account-secret')).toBe('/admin/api/accounts/:accountId');
    expect(normalizeAccessPath('/admin/api/auth/chatgpt/flow-secret/cancel')).toBe('/admin/api/auth/chatgpt/:flowId/cancel');
    expect(normalizeAccessPath('/admin/api/api-keys/key-secret')).toBe('/admin/api/api-keys/:keyId');
    expect(normalizeAccessPath('/admin/api/models/model-secret')).toBe('/admin/api/models/:modelId');
    expect(normalizeAccessPath('/admin/api/accounts/a/extra')).toBe('/admin/api/:unknown');
    expect(normalizeAccessPath('/v1/private/secret')).toBe('/v1/:unknown');
  });

  it('summarizes query parameter presence rather than values', () => {
    expect(summarizeQuery(new URLSearchParams('beta=secret&token=secret&token=another'))).toEqual({ beta: true, other: true });
  });
});
