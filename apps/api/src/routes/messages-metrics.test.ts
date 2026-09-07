import { afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SessionChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { createMessagesRoute } from './messages.js';
import { AccountPool } from '../services/account-pool.js';
import { ModelRegistry } from '../services/model-registry.js';
import { RequestLog } from '../services/request-log.js';
import { accessLog } from '../middleware/access-log.js';
import { logHttpRequestFailure } from './stream-lifecycle.js';

afterEach(() => vi.useRealTimers());
it.each([false, true])('logs only safe request sizes on timeout, stream=%s', async stream => {
  vi.useFakeTimers();
  let wire = '';
  const backend = new SessionChatGptBackend({ baseUrl: 'https://test', responseHeaderTimeoutMs: 50,
    fetch: (_url, init) => { wire = init!.body as string; return new Promise(() => {}); } });
  const pool = new AccountPool({ seedMockAccount: false });
  const account = pool.add({ id: 'session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'CANARY' } });
  const models = new ModelRegistry({ defaults: { aliases: [] } });
  models.replaceAccountModels({ accountId: account.id, createdAt: account.createdAt }, [{ id: 'test' }]);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = new Hono();
  app.use('*', accessLog(logger));
  app.route('/', createMessagesRoute({ backend, accountPool: pool, modelRegistry: models, requestLog: new RequestLog(), backendProvider: 'session', logger }));
  const schema = { type: 'object', properties: { text: { type: 'string', description: '中文CANARY' } } };
  const pending = Promise.resolve(app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    model: 'test', max_tokens: 8, stream, system: 'CANARY', upstreamBodyBytes: 999999, sourceMessageCount: 999999, onWireMetrics: 'CANARY',
    tools: [{ name: 'tool', input_schema: schema }], messages: [
      { role: 'user', content: '中文CANARY' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'tool', input: { text: 'CANARY' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'CANARY' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Q0FOQVJZ' } }] },
    ],
  }) })).then(async response => { await response.text(); return response; });
  await vi.advanceTimersByTimeAsync(100);
  await pending;
  expect(logger.error).toHaveBeenCalledWith('HTTP access', expect.objectContaining({
    requestId: expect.any(String), code: 'timeout', timeoutKind: 'response_headers',
    sourceMessageCount: 3, sourceContentBlockCount: 4,
    upstreamBodyBytes: Buffer.byteLength(wire), upstreamInputItemCount: JSON.parse(wire).input.length,
    toolCount: 1, toolSchemaBytes: Buffer.byteLength(JSON.stringify(schema)), replayItemCount: 0, replayApplied: false,
  }));
  expect(JSON.stringify([logger.error.mock.calls, logger.info.mock.calls])).not.toMatch(/CANARY|Q0FOQVJZ|999999/);
  expect(pool.get('session')?.currentConcurrency).toBe(0);
});

it('sanitizes metric callback data again at the log boundary', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logHttpRequestFailure(new Error('CANARY'), { route: '/v1/messages', logger, metrics: { upstreamBodyBytes: 10, replayApplied: false, toolCount: -1, toolSchemaBytes: Infinity, sourceMessageCount: 'CANARY', body: 'CANARY' } as never });
  expect(logger.error).toHaveBeenCalledWith('HTTP request terminated', { route: '/v1/messages', outcome: 'failure', code: 'internal_error', exceptionFamily: 'Error', upstreamBodyBytes: 10, replayApplied: false });
});
