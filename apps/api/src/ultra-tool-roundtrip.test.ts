import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { createMessagesRoute } from './routes/messages.js';
import { createOpenAiChatRoute } from './routes/openai-chat.js';
import { createOpenAiResponsesRoute } from './routes/openai-responses.js';
import { AccountPool } from './services/account-pool.js';
import { ModelRegistry } from './services/model-registry.js';
import { RequestLog } from './services/request-log.js';

const model = 'ultra-tool-model';
const prompt = 'Delegate the independent review and synthesize its result.';
const toolName = 'Agent';
const callId = 'call_caller_owned_agent';
const toolInput = { task: 'Review the isolated module', budget: 2 };
const toolArguments = JSON.stringify(toolInput);
const toolResult = 'The caller executed its agent: no issues found.';
const finalText = 'The delegated review found no issues.';
const parameters = { type: 'object', properties: { task: { type: 'string' }, budget: { type: 'integer' } }, required: ['task', 'budget'], additionalProperties: false };
const description = 'Delegate a bounded subtask using the caller-owned runtime.';
type JsonObject = Record<string, unknown>;

const routes = [
  {
    name: 'Claude Messages', path: '/v1/messages', create: createMessagesRoute,
    initial: { max_tokens: 128, output_config: { effort: 'ultra' }, messages: [{ role: 'user', content: prompt }], tools: [{ name: toolName, description, input_schema: parameters }] },
    continueWith: (response: JsonObject) => {
      expect(response.stop_reason).toBe('tool_use');
      expect(response.content).toEqual([{ type: 'tool_use', id: callId, name: toolName, input: toolInput }]);
      return { messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: response.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: toolResult }] },
      ] };
    },
    expectFinal: (response: JsonObject) => {
      expect(response.stop_reason).toBe('end_turn');
      expect(response.content).toEqual([{ type: 'text', text: finalText }]);
    },
  },
  {
    name: 'OpenAI Chat', path: '/v1/chat/completions', create: createOpenAiChatRoute,
    initial: { max_tokens: 128, reasoning_effort: 'ultra', messages: [{ role: 'user', content: prompt }], tools: [{ type: 'function', function: { name: toolName, description, parameters } }] },
    continueWith: (response: JsonObject) => {
      const choices = response.choices as Array<{ finish_reason: string; message: JsonObject }>;
      expect(choices[0].finish_reason).toBe('tool_calls');
      expect(choices[0].message.tool_calls).toEqual([{ id: callId, type: 'function', function: { name: toolName, arguments: toolArguments } }]);
      return { messages: [
        { role: 'user', content: prompt },
        choices[0].message,
        { role: 'tool', tool_call_id: callId, content: toolResult },
      ] };
    },
    expectFinal: (response: JsonObject) => {
      const choices = response.choices as Array<{ finish_reason: string; message: JsonObject }>;
      expect(choices[0]).toMatchObject({ finish_reason: 'stop', message: { role: 'assistant', content: finalText } });
      expect(choices[0].message).not.toHaveProperty('tool_calls');
    },
  },
  {
    name: 'OpenAI Responses', path: '/v1/responses', create: createOpenAiResponsesRoute,
    initial: { max_output_tokens: 128, reasoning: { effort: 'ultra' }, input: prompt, store: false, tools: [{ type: 'function', name: toolName, description, parameters }] },
    continueWith: (response: JsonObject) => {
      expect(response.status).toBe('completed');
      expect(response.output).toEqual([expect.objectContaining({ type: 'function_call', call_id: callId, name: toolName, arguments: toolArguments })]);
      return { input: [
        { role: 'user', content: prompt },
        ...(response.output as JsonObject[]),
        { type: 'function_call_output', call_id: callId, output: toolResult },
      ] };
    },
    expectFinal: (response: JsonObject) => {
      expect(response.status).toBe('completed');
      expect(response.output_text).toBe(finalText);
      expect(response.output).toEqual([expect.objectContaining({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: finalText, annotations: [] }] })]);
    },
  },
];

function sse(events: JsonObject[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

describe.each(routes)('$name Ultra caller-owned delegation roundtrip', (route) => {
  it('returns the delegation call to the caller and accepts its result on the next turn', async () => {
    const wire: Array<{ body: JsonObject; headers: Headers }> = [];
    const backend = new SessionChatGptBackend({
      baseUrl: 'https://chatgpt.test', timeoutMs: 1000,
      fetch: async (_url, init) => {
        wire.push({ body: JSON.parse(String(init?.body)) as JsonObject, headers: new Headers(init?.headers) });
        if (wire.length === 1) {
          const item = { type: 'function_call', id: 'fc_agent', call_id: callId, name: toolName, arguments: toolArguments };
          return sse([
            { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
            { type: 'response.function_call_arguments.delta', item_id: item.id, delta: toolArguments },
            { type: 'response.function_call_arguments.done', item_id: item.id, arguments: toolArguments },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: { status: 'completed' } },
          ]);
        }
        return sse([
          { type: 'response.output_text.delta', delta: finalText },
          { type: 'response.completed', response: { status: 'completed' } },
        ]);
      },
    });
    const accountPool = new AccountPool({ seedMockAccount: false });
    const account = accountPool.add({ id: 'ultra-tools', provider: 'chatgpt-session', capabilities: ['chatgpt-session', 'messages'], secret: { type: 'chatgpt-session', accessToken: 'synthetic-ultra-token', accountId: 'synthetic-ultra-account' } });
    const modelRegistry = new ModelRegistry({ defaults: [] });
    modelRegistry.replaceAccountModels({ accountId: account.id, createdAt: account.createdAt }, [{ id: model, controls: {
      reasoning: { metadataKnown: true, supported: ['xhigh', 'max', 'ultra'].map((effort) => ({ effort })), multiAgentReasoningEffort: 'xhigh' },
      serviceTier: { metadataKnown: false, supported: [], fastMode: false },
    } }]);
    const app = route.create({ backend, accountPool, modelRegistry, requestLog: new RequestLog(), backendProvider: 'session' });
    const send = (continuation: JsonObject = {}) => app.request(route.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, ...route.initial, stream: false, ...continuation }) });

    const firstResponse = await send();
    const first = await firstResponse.json() as JsonObject;
    expect(firstResponse.status, JSON.stringify(first)).toBe(200);
    expect(wire).toHaveLength(1); // The service returns the call; it never executes the caller's Agent tool.
    const secondResponse = await send(route.continueWith(first));
    const second = await secondResponse.json() as JsonObject;
    expect(secondResponse.status, JSON.stringify(second)).toBe(200);
    route.expectFinal(second);
    expect(wire).toHaveLength(2);

    for (const { body, headers } of wire) {
      expect(body.reasoning).toEqual({ effort: 'xhigh' });
      const hints = (body.input as JsonObject[]).filter((item) => item.role === 'developer' && typeof item.content === 'string' && item.content.includes('Proactive multi-agent delegation'));
      expect(hints).toHaveLength(1);
      expect(body.tools).toEqual([{ type: 'function', name: toolName, description, parameters, strict: false }]);
      expect(body).not.toHaveProperty('multi_agent');
      expect(body).not.toHaveProperty('reasoningExecution');
      expect(headers.get('openai-beta') ?? '').not.toContain('multi_agent');
    }
    const continuedInput = wire[1].body.input as JsonObject[];
    expect(continuedInput.filter((item) => item.type === 'function_call')).toEqual([expect.objectContaining({ type: 'function_call', call_id: callId, name: toolName, arguments: toolArguments })]);
    expect(continuedInput.filter((item) => item.type === 'function_call_output')).toEqual([{ type: 'function_call_output', call_id: callId, output: toolResult }]);
    expect(accountPool.get(account.id)?.currentConcurrency).toBe(0);
  });
});
