import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Logger } from '@chatgpt-to-claude/shared';
import { accessLog, normalizeAccessPath, setAccessLogMetadata, summarizeQuery, type HttpAccessLog } from './access-log.js';
import { apiKeyAuth } from './auth.js';
import { RuntimeApiKeys } from '../services/runtime-api-keys.js';
import { createApp } from '../app.js';

function capturedLogger(entries: HttpAccessLog[]): Logger {
  return {
    debug: () => undefined,
    info: (message, meta) => { if (message === 'HTTP access') entries.push(meta as HttpAccessLog); },
    warn: () => undefined,
    error: () => undefined,
  };
}

describe('accessLog', () => {
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
    expect(entries.map((entry) => entry.model)).toEqual([
      '<invalid-model-id>',
      '<invalid-model-id>',
      '<invalid-model-id>',
    ]);
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
      logLevel: 'info', mockResponsePrefix: 'Echo:', mockBackendModelsJson: JSON.stringify([{ id: 'backend-test-model' }]),
      chatGptBackend: 'mock', chatGptBaseUrl: 'https://chatgpt.com', chatGptRequestTimeoutMs: 60_000,
      defaultReasoningEffort: 'medium', defaultResponseSpeed: 'balanced', dataDir: '', runtimeStatePath: '', operationalStatePath: '',
    });
    const headers = { 'content-type': 'application/json', 'x-api-key': 'test-key' };

    try {
      await app.request('/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'backend-test-model', max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'private Claude prompt' }] }) });
      await app.request('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'backend-test-model', stream: false, messages: [{ role: 'user', content: 'private OpenAI prompt' }] }) });
      await app.request('/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model: 'backend-test-model', stream: true, input: 'private Responses prompt', tools: [{ type: 'function', name: 'private_tool', parameters: { type: 'object' } }] }) });

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
