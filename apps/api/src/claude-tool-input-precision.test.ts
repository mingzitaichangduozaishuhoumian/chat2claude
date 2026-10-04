import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { createMessagesRoute } from './routes/messages.js';
import { AccountPool } from './services/account-pool.js';
import { ModelRegistry } from './services/model-registry.js';
import { RequestLog } from './services/request-log.js';

const model = 'precision-model';

function createPrecisionRoute(rawArguments: string) {
  const item = { type: 'function_call', id: 'fc_precise', call_id: 'call_precise', name: 'lookup', arguments: rawArguments };
  const backend = new SessionChatGptBackend({
    baseUrl: 'https://chatgpt.test', timeoutMs: 1000,
    fetch: async () => new Response([
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { status: 'completed', output: [item] } },
    ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')),
  });
  const accountPool = new AccountPool({ seedMockAccount: false });
  const account = accountPool.add({ id: 'precision-account', provider: 'chatgpt-session', capabilities: ['chatgpt-session', 'messages'], secret: { type: 'chatgpt-session', accessToken: 'synthetic-token' } });
  const modelRegistry = new ModelRegistry({ defaults: [] });
  modelRegistry.replaceAccountModels({ accountId: account.id, createdAt: account.createdAt }, [{ id: model, controls: {
    reasoning: { metadataKnown: true, supported: [{ effort: 'medium' }], defaultEffort: 'medium' },
    serviceTier: { metadataKnown: false, supported: [], fastMode: false },
  } }]);
  const app = createMessagesRoute({ backend, accountPool, modelRegistry, requestLog: new RequestLog(), backendProvider: 'session' });
  return {
    send: () => app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 32, stream: false, messages: [{ role: 'user', content: 'Call lookup.' }] }) }),
    activeRequests: () => accountPool.get(account.id)?.currentConcurrency,
  };
}

describe('Claude nonstream tool input HTTP JSON precision', () => {
  it.each([
    '{"large":9007199254740993,"decimal":1.0000000000000001,"overflow":1e400,"underflow":1e-400,"negativeZero":-0}',
    '{"nested":[{"large":-9007199254740993},0.10000000000000001],"__proto__":{"precision":1.0000000000000001},"string":"9007199254740993"}',
    '{"count":42,"ratio":0.125,"flags":[true,false,null],"nested":{"name":"雪"}}',
  ])('preserves numeric wire values through Session and Hono c.json (%#)', async (rawArguments) => {
    const route = createPrecisionRoute(rawArguments);
    const response = await route.send();
    const wire = await response.text();
    expect(response.status, wire).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    // Compare actual HTTP JSON text: response.json() itself rounds these numbers.
    expect(wire).toContain(`"input":${rawArguments}`);
    expect(wire).toContain('"stop_reason":"tool_use"');
    expect(wire).not.toContain('"rawJSON"');
    expect(wire).not.toContain('"rawArguments"');
    expect(route.activeRequests()).toBe(0);
  });

  it('returns a safe HTTP error instead of silently rounding on an unsupported runtime', async () => {
    const route = createPrecisionRoute('{"secret":"PRIVATE_TOOL_INPUT","large":9007199254740993}');
    const descriptor = Object.getOwnPropertyDescriptor(JSON, 'rawJSON')!;
    Object.defineProperty(JSON, 'rawJSON', { ...descriptor, value: undefined });
    try {
      const response = await route.send();
      const wire = await response.text();
      expect(response.status).toBe(500);
      expect(wire).toContain('JSON.rawJSON');
      expect(wire).not.toContain('PRIVATE_TOOL_INPUT');
      expect(wire).not.toContain('9007199254740992');
      expect(route.activeRequests()).toBe(0);
    } finally { Object.defineProperty(JSON, 'rawJSON', descriptor); }
  });
});
