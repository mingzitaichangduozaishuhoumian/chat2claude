import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend, type ChatGptDiscoveredModel } from '@chatgpt-to-claude/chatgpt-backend';
import { createMessagesRoute } from './routes/messages.js';
import { createOpenAiChatRoute } from './routes/openai-chat.js';
import { createOpenAiResponsesRoute } from './routes/openai-responses.js';
import { AccountPool } from './services/account-pool.js';
import { ModelRegistry } from './services/model-registry.js';
import { RequestLog } from './services/request-log.js';

const aliasId = 'lossless-alias';
const backendModel = 'gpt-lossless-test';
const routes = [
  {
    name: 'Claude Messages', create: createMessagesRoute, path: '/v1/messages',
    body: { max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] },
    controls: (effort: string) => ({ output_config: { effort } }),
  },
  {
    name: 'OpenAI Chat', create: createOpenAiChatRoute, path: '/v1/chat/completions',
    body: { max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] },
    controls: (effort: string) => ({ reasoning_effort: effort }),
  },
  {
    name: 'OpenAI Responses', create: createOpenAiResponsesRoute, path: '/v1/responses',
    body: { max_output_tokens: 64, input: 'hello', store: false },
    controls: (effort: string) => ({ reasoning: { effort } }),
  },
];
type Route = typeof routes[number];
type WireCall = { url: string; method?: string; authorization: string | null; accountId: string | null; body: Record<string, unknown> };

function discoveredModel(efforts: string[] | undefined, multiAgentReasoningEffort?: string): ChatGptDiscoveredModel {
  return {
    id: backendModel,
    ...(efforts === undefined ? {} : {
      controls: {
        reasoning: { metadataKnown: true, supported: efforts.map((effort) => ({ effort })), multiAgentVersion: 'v2', ...(multiAgentReasoningEffort ? { multiAgentReasoningEffort } : {}) },
        serviceTier: { metadataKnown: false, supported: [], fastMode: false },
      },
    }),
  };
}

function fixture(route: Route, supported: string[] | undefined, options: { firstSupported?: string[]; aliasDefault?: string; firstMultiAgentEffort?: string; multiAgentEffort?: string } = {}) {
  const calls: WireCall[] = [];
  const backend = new SessionChatGptBackend({
    baseUrl: 'https://chatgpt.test', timeoutMs: 1000,
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url), method: init?.method, authorization: headers.get('authorization'),
        accountId: headers.get('chatgpt-account-id'), body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      const events = [
        { type: 'response.output_text.delta', delta: 'ok' },
        { type: 'response.completed', response: { status: 'completed' } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const accountPool = new AccountPool({ seedMockAccount: false });
  const modelRegistry = new ModelRegistry({ defaults: { aliases: [{
    id: aliasId, backendModel, enabled: true,
    defaults: { reasoning_effort: options.aliasDefault ?? 'medium', speed: 'standard' },
  }] } });
  // The first account must not win merely because its catalog has the same model ID.
  for (const [id, efforts] of [
    ['first', supported === undefined ? undefined : options.firstSupported ?? ['medium']],
    ['second', supported],
  ] as const) {
    const account = accountPool.add({
      id, provider: 'chatgpt-session', capabilities: ['chatgpt-session', 'messages'],
      secret: { type: 'chatgpt-session', accessToken: `synthetic-token-${id}`, accountId: `synthetic-account-${id}` },
    });
    modelRegistry.replaceAccountModels({ accountId: id, createdAt: account.createdAt }, [discoveredModel(efforts, id === 'first' ? options.firstMultiAgentEffort : options.multiAgentEffort)]);
  }
  const app = route.create({ backend, accountPool, modelRegistry, requestLog: new RequestLog(), backendProvider: 'session' });
  const send = (stream: boolean, controls: Record<string, unknown> = {}) => app.request(route.path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: aliasId, ...route.body, stream, ...controls }),
  });
  return { calls, accountPool, send };
}

async function expectWireEffort(result: ReturnType<typeof fixture>, response: Response, effort: string, stream: boolean) {
  const responseText = await response.text();
  expect(response.status, responseText).toBe(200);
  expect(response.headers.get('content-type')).toContain(stream ? 'text/event-stream' : 'application/json');
  expect(responseText).toContain('ok');
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0]).toMatchObject({
    url: 'https://chatgpt.test/backend-api/codex/responses', method: 'POST',
    authorization: 'Bearer synthetic-token-second', accountId: 'synthetic-account-second',
    body: { model: backendModel, reasoning: { effort }, stream: true },
  });
  expect(result.accountPool.get('first')?.lastUsedAt).toBeNull();
  expect(result.accountPool.get('second')?.lastUsedAt).not.toBeNull();
  expect(result.accountPool.list().map((account) => account.currentConcurrency)).toEqual([0, 0]);
}

describe.each(routes)('$name lossless reasoning to the session wire', (route) => {
  it.each(['max', 'xhigh', 'Future_Deep'].flatMap((effort) => [false, true].map((stream) => ({ effort, stream }))))(
    'preserves $effort on the eligible account (stream=$stream)', async ({ effort, stream }) => {
      const result = fixture(route, [effort]);
      await expectWireEffort(result, await result.send(stream, route.controls(effort)), effort, stream);
    },
  );

  it.each([
    { input: 'off', effort: 'none', stream: false },
    { input: 'light', effort: 'low', stream: true },
    { input: 'extra_high', effort: 'xhigh', stream: true },
  ])('resolves spelling alias $input to advertised $effort', async ({ input, effort, stream }) => {
    const result = fixture(route, [effort]);
    await expectWireEffort(result, await result.send(stream, route.controls(input)), effort, stream);
  });

  it.each([false, true])('executes Ultra with advertised base effort and caller delegation (stream=%s)', async (stream) => {
    const result = fixture(route, ['medium', 'xhigh', 'max', 'ultra'], { firstSupported: ['xhigh', 'max'], multiAgentEffort: 'xhigh' });
    await expectWireEffort(result, await result.send(stream, route.controls('ultra')), 'xhigh', stream);
    const body = result.calls[0].body;
    expect(body.input).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'developer', content: expect.stringContaining('Proactive multi-agent delegation') })]));
    expect(body).not.toHaveProperty('multi_agent');
    expect(body).not.toHaveProperty('reasoningExecution');
    expect(body).not.toHaveProperty('tools');
  });

  it('preserves alias default Ultra eligibility instead of routing to an account with only max', async () => {
    const result = fixture(route, ['max', 'ultra'], { firstSupported: ['max'], aliasDefault: 'ultra' });
    await expectWireEffort(result, await result.send(true), 'max', true);
  });

  it('resolves Ultra base effort after account selection rather than from the merged catalog', async () => {
    const result = fixture(route, ['xhigh', 'max', 'ultra'], { firstSupported: ['xhigh', 'max', 'ultra'], multiAgentEffort: 'xhigh' });
    const response = await result.send(false, route.controls('ultra'));
    expect(await response.text()).toContain('ok');
    expect(response.status).toBe(200);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ accountId: 'synthetic-account-first', body: { reasoning: { effort: 'max' } } });
    expect(result.accountPool.list().map((account) => account.currentConcurrency)).toEqual([0, 0]);
  });

  it('does not let request JSON replace the trusted Ultra execution plan', async () => {
    const result = fixture(route, ['xhigh', 'max', 'ultra'], { multiAgentEffort: 'xhigh' });
    await expectWireEffort(result, await result.send(false, {
      ...route.controls('ultra'), reasoningExecution: { effort: 'low', delegation: 'proactive' },
      backendOptions: { responsesBody: { reasoning: { effort: 'low' }, multi_agent: { enabled: true } } },
    }), 'xhigh', false);
  });

  it.each(['explicit', 'alias default'] as const)('keeps native light distinct from low for %s requests', async (source) => {
    const result = fixture(route, ['light'], { firstSupported: ['low'], aliasDefault: source === 'alias default' ? 'light' : 'medium' });
    const stream = source === 'alias default';
    await expectWireEffort(result, await result.send(stream, source === 'explicit' ? route.controls('light') : {}), 'light', stream);
  });

  it.each([
    { effort: 'Future_Deep', otherEffort: 'future_deep', stream: false },
    { effort: 'future_deep', otherEffort: 'Future_Deep', stream: true },
  ])('selects the exact provider token $effort over $otherEffort on another account', async ({ effort, otherEffort, stream }) => {
    const result = fixture(route, [effort], { firstSupported: [otherEffort] });
    await expectWireEffort(result, await result.send(stream, route.controls(effort)), effort, stream);
  });

  it.each([
    { metadata: 'unsupported', supported: ['xhigh', 'max'], stream: false },
    { metadata: 'unknown', supported: undefined, stream: true },
  ])('rejects explicit ultra before fetching when capabilities are $metadata', async ({ supported, stream }) => {
    const result = fixture(route, supported, { firstSupported: ['xhigh'] });
    const response = await result.send(stream, route.controls('ultra'));
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { type: string; message: string } };
    expect(body.error).toMatchObject({ type: 'invalid_request_error', message: expect.stringContaining('Unsupported reasoning_effort') });
    expect(result.calls).toEqual([]);
    expect(result.accountPool.list().map((account) => account.lastUsedAt)).toEqual([null, null]);
  });
});

describe('explicit reasoning field precedence', () => {
  it.each(routes.filter((route) => route.name !== 'OpenAI Chat'))('$name gives its nested effort priority over reasoning_effort and alias defaults', async (route) => {
    const result = fixture(route, ['xhigh', 'ultra'], { firstSupported: ['max'], aliasDefault: 'max' });
    await expectWireEffort(result, await result.send(false, { reasoning_effort: 'max', ...route.controls('ultra') }), 'xhigh', false);
  });
});
