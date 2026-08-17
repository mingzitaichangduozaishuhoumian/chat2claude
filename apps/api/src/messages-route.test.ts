import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { ChatGptBackendError, SessionChatGptBackend, type ChatGptBackendClient, type ChatGptBackendRequestContext, type ChatGptCompletionRequest, type ChatGptCompletionResponse, type ChatGptDiscoveredModel, type ChatGptSessionSecret } from '@chatgpt-to-claude/chatgpt-backend';
import { createApp } from './app.js';
import { createAdminRoute } from './routes/admin.js';
import { createMessagesRoute } from './routes/messages.js';
import { createModelsRoute } from './routes/models.js';
import { createOpenAiChatRoute } from './routes/openai-chat.js';
import { createOpenAiResponsesRoute } from './routes/openai-responses.js';
import { apiKeyAuth } from './middleware/auth.js';
import { AccountPool } from './services/account-pool.js';
import { ModelRegistry } from './services/model-registry.js';
import { RequestLog } from './services/request-log.js';
import { RuntimeApiKeys } from './services/runtime-api-keys.js';
import { ChatGptAuthFlowService } from './services/chatgpt-auth-flow.js';

const discoveredModels = [{ id: 'backend-test-model', displayName: 'Backend Test Model' }];
const env = {
  port: 3000,
  host: '127.0.0.1',
  apiKeys: ['test-key'],
  logLevel: 'error' as const,
  mockResponsePrefix: 'Echo:',
  mockBackendModelsJson: JSON.stringify(discoveredModels),
  chatGptBackend: 'mock' as const,
  chatGptBaseUrl: 'https://chatgpt.com',
  chatGptRequestTimeoutMs: 60000,
  defaultReasoningEffort: 'medium' as const,
  defaultResponseSpeed: 'balanced' as const,
};
const jsonHeaders = { 'content-type': 'application/json', 'x-api-key': 'test-key' };

describe('/v1/chat/completions', () => {
  it('is protected by the /v1 API key middleware', async () => {
    const app = createApp({ ...env, apiKeys: ['secret'] });
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(401);
  });

  it('returns an OpenAI non-streaming chat completion with text content', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, reasoning_effort: 'low', response_speed: 'fast', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { object: string; model: string; choices: Array<{ message: { role: string; content: string }; finish_reason: string }>; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('sonnet');
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toBe('Echo:[effort=low,speed=fast] hello');
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
  });

  it('streams OpenAI chat completion chunks with text deltas', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"delta":{"role":"assistant"}');
    expect(text).toContain('Echo:[effort=med');
    expect(text).toContain('ium,speed=balanc');
    expect(text).toContain('ed] hello');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('data: [DONE]');
  });

  it('returns OpenAI tool_calls when a function tool is forced', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({
      model: 'sonnet',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'call weather' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { choices: Array<{ message: { content: string | null; tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }; finish_reason: string }> };
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.content).toBeNull();
    expect(body.choices[0].message.tool_calls).toEqual([{ id: 'call_mock_get_weather', type: 'function', function: { name: 'get_weather', arguments: '{}' } }]);
  });

  it('streams OpenAI tool call deltas when a function tool is forced', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({
      model: 'sonnet',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'call weather' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'required',
    }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"tool_calls":[{"index":0,"id":"call_mock_get_weather","type":"function","function":{"name":"get_weather","arguments":"{}"}}]');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).toContain('data: [DONE]');
  });

  it('preserves unsupported OpenAI chat content array parts as placeholders', async () => {
    const backend = new InspectingBackend([{ id: 'backend-test-model' }]);
    const app = createOpenAiChatRoute({ backend, requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool: new AccountPool() });
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      model: 'sonnet',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look ' }, { type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] }],
    }) });
    expect(res.status).toBe(200);
    expect(backend.lastRequest?.messages[0].content).toBe('look [unsupported:image_url]');
    expect(backend.lastRequest?.inputItems).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'look ' }, { type: 'image', imageUrl: 'https://example.test/image.png' }] },
    ]);
  });

  it('maps assistant tool_calls and tool messages into backend context text', async () => {
    const backend = new InspectingBackend([{ id: 'backend-test-model' }]);
    const app = createOpenAiChatRoute({ backend, requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool: new AccountPool() });
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      model: 'sonnet',
      messages: [
        { role: 'assistant', content: 'checking', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      ],
    }) });
    expect(res.status).toBe(200);
    expect(backend.lastRequest?.messages).toEqual([
      { role: 'assistant', content: 'checking\n[tool_call:call_1:get_weather] {"city":"Paris"}' },
      { role: 'user', content: '[tool_result:call_1] sunny' },
    ]);
    expect(backend.lastRequest?.inputItems).toEqual([
      { type: 'message', role: 'assistant', content: 'checking' },
      { type: 'function_call', callId: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } },
      { type: 'function_call_output', callId: 'call_1', output: 'sunny' },
    ]);
  });

  it('returns an OpenAI error for an unknown model', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'unknown-model', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { type: string; message: string; code: null } };
    expect(body.error.type).toBe('not_found_error');
    expect(body.error.message).toContain('Unknown model: unknown-model');
    expect(body.error.code).toBeNull();
  });

  it('returns an OpenAI error for a disabled alias', async () => {
    const app = createApp(env);
    const patchRes = await app.request('/admin/api/models/sonnet', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    expect(patchRes.status).toBe(200);
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('Model is disabled: sonnet');
  });

  it('returns an OpenAI error for an unbound alias', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'opus', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('Model alias is not bound to a backend model: opus');
  });

  it('returns an OpenAI error for a stale alias binding', async () => {
    const app = createApp(env);
    const patchRes = await app.request('/admin/api/models/sonnet', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backendModel: 'missing-backend-model' }) });
    expect(patchRes.status).toBe(200);
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('Model alias sonnet is bound to missing backend model: missing-backend-model');
  });

  it('maps backend unauthorized errors to an OpenAI authentication error', async () => {
    const backend = new ThrowingCompleteBackend([{ id: 'backend-test-model' }], new ChatGptBackendError('ChatGPT session expired: HTTP 401', 'unauthorized', { status: 401 }));
    const app = createOpenAiChatRoute({ backend, requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool: new AccountPool() });

    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message).toContain('HTTP 401');
  });

  it('releases account concurrency after an OpenAI non-streaming chat request', async () => {
    const accountPool = new AccountPool();
    const app = createOpenAiChatRoute({ backend: new InspectingBackend([{ id: 'backend-test-model' }]), requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool });
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(accountPool.list()[0].currentConcurrency).toBe(0);
    expect(accountPool.list()[0].status).toBe('available');
  });

  it('releases account concurrency and records error when an OpenAI streaming chat backend throws', async () => {
    const accountPool = new AccountPool();
    const app = createOpenAiChatRoute({ backend: new ThrowingStreamBackend([{ id: 'backend-test-model' }]), requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool });
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', stream: true, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(accountPool.list()[0].currentConcurrency).toBe(1);
    await expect(res.text()).rejects.toThrow('backend stream boom');
    expect(accountPool.list()[0].currentConcurrency).toBe(0);
    expect(accountPool.list()[0].status).toBe('error');
    expect(accountPool.list()[0].lastError).toBe('backend stream boom');
  });

  it('releases account concurrency after an OpenAI streaming chat request is consumed', async () => {
    const accountPool = new AccountPool();
    const app = createOpenAiChatRoute({ backend: new InspectingBackend([{ id: 'backend-test-model' }]), requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool });
    const res = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', stream: true, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(accountPool.list()[0].currentConcurrency).toBe(1);
    await res.text();
    expect(accountPool.list()[0].currentConcurrency).toBe(0);
    expect(accountPool.list()[0].status).toBe('available');
  });
});

describe('/v1/responses', () => {
  it('is protected by the /v1 API key middleware', async () => {
    const app = createApp({ ...env, apiKeys: ['secret'] });
    const res = await app.request('/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', input: 'hello' }) });
    expect(res.status).toBe(401);
  });

  it('returns a non-streaming responses text response', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/responses', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_output_tokens: 64, reasoning: { effort: 'low' }, response_speed: 'fast', input: 'hello' }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { object: string; model: string; status: string; output: Array<Record<string, unknown>>; output_text: string; usage: { input_tokens: number; output_tokens: number; total_tokens: number } };
    expect(body.object).toBe('response');
    expect(body.model).toBe('sonnet');
    expect(body.status).toBe('completed');
    expect(body.output).toEqual([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Echo:[effort=low,speed=fast] hello' }] }]);
    expect(body.output_text).toBe('Echo:[effort=low,speed=fast] hello');
    expect(body.usage.total_tokens).toBe(body.usage.input_tokens + body.usage.output_tokens);
  });

  it('streams responses text deltas', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/responses', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_output_tokens: 64, stream: true, input: 'hello' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: response.output_text.delta');
    expect(text).toContain('Echo:[effort=med');
    expect(text).toContain('event: response.completed');
    expect(text).toContain('data: [DONE]');
  });

  it('returns a forced tool call in a non-streaming responses response', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/responses', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({
      model: 'sonnet',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'call weather' }] }],
      tools: [{ type: 'function', name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: {} } }],
      tool_choice: { type: 'function', name: 'get_weather' },
    }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { output: Array<Record<string, unknown>>; output_text: string };
    expect(body.output_text).toBe('');
    expect(body.output).toEqual([{ type: 'function_call', call_id: 'call_mock_get_weather', name: 'get_weather', arguments: '{}' }]);
  });

  it('prepends responses instructions and maps common input item/content shapes', async () => {
    const backend = new InspectingBackend([{ id: 'backend-test-model' }]);
    const app = createOpenAiResponsesRoute({ backend, requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool: new AccountPool() });
    const res = await app.request('/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      model: 'sonnet',
      instructions: 'be concise',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello ' }, { type: 'text', text: 'there ' }, { type: 'image_url', image_url: { url: 'https://example.test/a.png' } }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: { q: 'x' } },
        { type: 'function_call_output', call_id: 'call_1', output: 'done' },
      ],
    }) });
    expect(res.status).toBe(200);
    expect(backend.lastRequest?.messages).toEqual([
      { role: 'system', content: 'be concise' },
      { role: 'user', content: 'hello there [unsupported:image_url]' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: '[function_call:call_1:lookup] {"q":"x"}' },
      { role: 'user', content: '[function_call_output:call_1] done' },
    ]);
    expect(backend.lastRequest?.inputItems).toEqual([
      { type: 'message', role: 'system', content: 'be concise' },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello there ' }, { type: 'image', imageUrl: 'https://example.test/a.png' }] },
      { type: 'message', role: 'assistant', content: 'hi' },
      { type: 'function_call', callId: 'call_1', name: 'lookup', arguments: { q: 'x' } },
      { type: 'function_call_output', callId: 'call_1', output: 'done' },
    ]);
  });

  it('ignores responses forced function tool_choice when name is missing', async () => {
    const backend = new InspectingBackend([{ id: 'backend-test-model' }]);
    const app = createOpenAiResponsesRoute({ backend, requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool: new AccountPool() });
    const res = await app.request('/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      model: 'sonnet',
      input: 'hello',
      tool_choice: { type: 'function', function: {} },
    }) });
    expect(res.status).toBe(200);
    expect(backend.lastRequest?.toolChoice).toBeUndefined();
  });

  it('streams a forced tool call in responses SSE', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/responses', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({
      model: 'sonnet',
      stream: true,
      input: 'call weather',
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'required',
    }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: response.output_item.added');
    expect(text).toContain('"call_id":"call_mock_get_weather"');
    expect(text).toContain('event: response.function_call_arguments.delta');
    expect(text).toContain('"delta":"{}"');
    expect(text).toContain('event: response.completed');
    expect(text).toContain('data: [DONE]');
  });

  it('releases account concurrency after a non-streaming responses request', async () => {
    const accountPool = new AccountPool();
    const app = createOpenAiResponsesRoute({ backend: new InspectingBackend([{ id: 'backend-test-model' }]), requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool });
    const res = await app.request('/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', input: 'hello' }) });
    expect(res.status).toBe(200);
    expect(accountPool.list()[0].currentConcurrency).toBe(0);
    expect(accountPool.list()[0].status).toBe('available');
  });

  it('releases account concurrency after a streaming responses request is consumed', async () => {
    const accountPool = new AccountPool();
    const app = createOpenAiResponsesRoute({ backend: new InspectingBackend([{ id: 'backend-test-model' }]), requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool });
    const res = await app.request('/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', stream: true, input: 'hello' }) });
    expect(res.status).toBe(200);
    expect(accountPool.list()[0].currentConcurrency).toBe(1);
    await res.text();
    expect(accountPool.list()[0].currentConcurrency).toBe(0);
    expect(accountPool.list()[0].status).toBe('available');
  });

  it('releases account concurrency and records error when a streaming responses backend throws', async () => {
    const accountPool = new AccountPool();
    const app = createOpenAiResponsesRoute({ backend: new ThrowingStreamBackend([{ id: 'backend-test-model' }]), requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool });
    const res = await app.request('/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', stream: true, input: 'hello' }) });
    expect(res.status).toBe(200);
    expect(accountPool.list()[0].currentConcurrency).toBe(1);
    await expect(res.text()).rejects.toThrow('backend stream boom');
    expect(accountPool.list()[0].currentConcurrency).toBe(0);
    expect(accountPool.list()[0].status).toBe('error');
    expect(accountPool.list()[0].lastError).toBe('backend stream boom');
  });

  it('returns an OpenAI error for an unknown responses model', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/responses', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'unknown-model', input: 'hello' }) });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('not_found_error');
    expect(body.error.message).toContain('Unknown model: unknown-model');
  });

  it('maps backend rate limit errors to an OpenAI rate_limit_error', async () => {
    const backend = new ThrowingCompleteBackend([{ id: 'backend-test-model' }], new ChatGptBackendError('ChatGPT responses request failed: HTTP 429', 'rate_limited', { status: 429 }));
    const app = createOpenAiResponsesRoute({ backend, requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool: new AccountPool() });

    const res = await app.request('/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', input: 'hello' }) });
    expect(res.status).toBe(429);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).toContain('HTTP 429');
  });
});

describe('/v1/messages', () => {
  it('uses the default mock backend model when model JSON is unset', async () => {
    const app = createApp({ ...env, mockBackendModelsJson: undefined });
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: Array<{ text: string }> };
    expect(body.content[0].text).toBe('Echo:[effort=medium,speed=balanced] hello');
  });

  it('returns a Claude-like non-stream message with resolved effort and speed', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, output_config: { effort: 'high' }, speed: 'fast', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { type: string; role: string; content: Array<{ text: string }>; stop_reason: string };
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.content[0].text).toBe('Echo:[effort=high,speed=fast] hello');
    expect(body.stop_reason).toBe('end_turn');
  });

  it('uses alias overlay defaults when request omits effort and speed', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: Array<{ text: string }> };
    expect(body.content[0].text).toBe('Echo:[effort=medium,speed=balanced] hello');
  });

  it('uses patched alias defaults in mock echo', async () => {
    const app = createApp(env);
    const patchRes = await app.request('/admin/api/models/sonnet', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaults: { reasoning_effort: 'max', speed: 'quality' } }) });
    expect(patchRes.status).toBe(200);

    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: Array<{ text: string }> };
    expect(body.content[0].text).toBe('Echo:[effort=max,speed=quality] hello');
  });

  it('returns Claude SSE stream events', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, stream: true, reasoning_effort: 'low', response_speed: 'quality', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('Echo:[effort=low');
    expect(text).toContain(',speed=quality] ');
    expect(text).toContain('hello');
    expect(text).toContain('event: message_stop');
  });

  it('returns a Claude tool_use response when a tool is forced', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({
      model: 'sonnet',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'call weather' }],
      tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      tool_choice: { type: 'tool', name: 'get_weather' },
    }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { stop_reason: string; content: Array<Record<string, unknown>> };
    expect(body.stop_reason).toBe('tool_use');
    expect(body.content).toEqual([{ type: 'tool_use', id: 'call_mock_get_weather', name: 'get_weather', input: {} }]);
  });

  it('streams Claude tool_use events when a tool is forced', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({
      model: 'sonnet',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'call weather' }],
      tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'tool', name: 'get_weather' },
    }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"content_block":{"type":"tool_use","id":"call_mock_get_weather","name":"get_weather","input":{}}');
    expect(text).toContain('"delta":{"type":"input_json_delta","partial_json":"{}"}');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it('returns a Claude error for an unknown model', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'unknown-model', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(404);
    const body = await res.json() as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('not_found_error');
    expect(body.error.message).toContain('Unknown model: unknown-model');
  });

  it('maps backend rate limit errors to a Claude rate_limit_error', async () => {
    const backend = new ThrowingCompleteBackend([{ id: 'backend-test-model' }], new ChatGptBackendError('ChatGPT responses request failed: HTTP 429', 'rate_limited', { status: 429 }));
    const app = createMessagesRoute({ backend, requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool: new AccountPool() });

    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(429);
    const body = await res.json() as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).toContain('HTTP 429');
  });

  it('returns a Claude error for a disabled alias', async () => {
    const app = createApp(env);
    const patchRes = await app.request('/admin/api/models/sonnet', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    expect(patchRes.status).toBe(200);

    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('Model is disabled: sonnet');
  });

  it('returns a clear error for an unbound alias', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'opus', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('Model alias is not bound to a backend model: opus');
  });

  it('returns a clear error for a stale alias binding', async () => {
    const app = createApp(env);
    const patchRes = await app.request('/admin/api/models/sonnet', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backendModel: 'missing-backend-model' }) });
    expect(patchRes.status).toBe(200);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('Model alias sonnet is bound to missing backend model: missing-backend-model');
  });

  it('passes through a directly discovered backend model', async () => {
    const app = createApp({ ...env, mockBackendModelsJson: JSON.stringify([{ id: 'backend-test-model' }, { id: 'direct-backend-model' }]) });
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'direct-backend-model', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: Array<{ text: string }> };
    expect(body.content[0].text).toBe('Echo:[effort=medium,speed=balanced] hello');
  });

  it('passes account context to backend complete', async () => {
    const backend = new InspectingBackend([{ id: 'backend-test-model' }]);
    const app = createMessagesRoute({ backend, requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool: new AccountPool() });

    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(backend.lastContext?.account?.id).toBe('mock-account');
    expect(backend.lastContext?.account?.provider).toBe('mock');
  });

  it('passes account context to backend stream', async () => {
    const backend = new InspectingBackend([{ id: 'backend-test-model' }]);
    const app = createMessagesRoute({ backend, requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool: new AccountPool() });

    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    await res.text();
    expect(backend.lastContext?.account?.id).toBe('mock-account');
    expect(backend.lastContext?.account?.provider).toBe('mock');
  });

  it('passes resolved backendModel to the backend request', async () => {
    const backend = new InspectingBackend([{ id: 'backend-injected-model' }]);
    const modelRegistry = new ModelRegistry({ discoveredModels: [{ id: 'backend-injected-model' }] });
    const updated = modelRegistry.update('sonnet', { backendModel: 'backend-injected-model' });
    expect(updated?.backendModel).toBe('backend-injected-model');
    const app = createMessagesRoute({ backend, requestLog: new RequestLog(), modelRegistry, accountPool: new AccountPool() });

    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(backend.lastRequest?.model).toBe('backend-injected-model');
  });

  it('maps Claude image blocks to structured backend inputItems while preserving text fallback', async () => {
    const backend = new InspectingBackend([{ id: 'backend-test-model' }]);
    const app = createMessagesRoute({ backend, requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool: new AccountPool() });

    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'see ' }, { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }] }] }) });
    expect(res.status).toBe(200);
    expect(backend.lastRequest?.messages[0]).toEqual({ role: 'user', content: 'see [unsupported:image]' });
    expect(backend.lastRequest?.inputItems).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'see ' }, { type: 'image', imageUrl: 'https://example.test/a.png' }] },
    ]);
  });

  it('prepends Claude system text before backend user messages', async () => {
    const backend = new InspectingBackend([{ id: 'backend-test-model' }]);
    const app = createMessagesRoute({ backend, requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool: new AccountPool() });

    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, system: 'be concise', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(backend.lastRequest?.messages[0]).toEqual({ role: 'system', content: 'be concise' });
    expect(backend.lastRequest?.messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('releases account concurrency after a non-streaming request', async () => {
    const accountPool = new AccountPool();
    const app = createMessagesRoute({ backend: new InspectingBackend([{ id: 'backend-test-model' }]), requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool });
    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(accountPool.list()[0].currentConcurrency).toBe(0);
    expect(accountPool.list()[0].status).toBe('available');
  });

  it('releases account concurrency after a streaming request is consumed', async () => {
    const accountPool = new AccountPool();
    const app = createMessagesRoute({ backend: new InspectingBackend([{ id: 'backend-test-model' }]), requestLog: new RequestLog(), modelRegistry: new ModelRegistry({ discoveredModels }), accountPool });
    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(accountPool.list()[0].currentConcurrency).toBe(1);
    await res.text();
    expect(accountPool.list()[0].currentConcurrency).toBe(0);
    expect(accountPool.list()[0].status).toBe('available');
  });

  it('uses a chatgpt-session account instead of the default mock account in session mode', async () => {
    const backend = new InspectingBackend([{ id: 'backend-test-model' }]);
    const accountPool = new AccountPool();
    accountPool.add({ id: 'session-1', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'token-1' }, capabilities: ['chatgpt-session', 'messages'] });
    const app = createMessagesRoute({ backend, requestLog: new RequestLog(), modelRegistry: new ModelRegistry(), accountPool, backendProvider: 'session' });

    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    expect(backend.listModelsContext?.account?.id).toBe('session-1');
    expect(backend.lastContext?.account?.id).toBe('session-1');
    expect(backend.lastContext?.account?.provider).toBe('chatgpt-session');
  });

  it('returns a clear session account error before model resolution when no session account exists', async () => {
    const app = createMessagesRoute({ backend: new InspectingBackend([{ id: 'backend-test-model' }]), requestLog: new RequestLog(), modelRegistry: new ModelRegistry(), accountPool: new AccountPool(), backendProvider: 'session' });

    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe('overloaded_error');
    expect(body.error.message).toContain('No available chatgpt-session account');
  });
});

class InspectingBackend implements ChatGptBackendClient {
  lastRequest: ChatGptCompletionRequest | undefined;
  lastContext: ChatGptBackendRequestContext | undefined;
  listModelsContext: ChatGptBackendRequestContext | undefined;
  constructor(private readonly models: ChatGptDiscoveredModel[] = []) {}

  async listModels(context?: ChatGptBackendRequestContext): Promise<ChatGptDiscoveredModel[]> {
    this.listModelsContext = context;
    return this.models;
  }

  async healthCheck(_context?: ChatGptBackendRequestContext): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse> {
    this.lastRequest = request;
    this.lastContext = context;
    return { text: `backend:${request.model}`, finishReason: 'stop' };
  }

  async *stream(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext) {
    this.lastRequest = request;
    this.lastContext = context;
    yield { type: 'text_delta' as const, text: `backend:${request.model}` };
    yield { type: 'done' as const };
  }
}

class ThrowingCompleteBackend extends InspectingBackend {
  constructor(models: ChatGptDiscoveredModel[], private readonly error: Error) {
    super(models);
  }

  override async complete(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext): Promise<ChatGptCompletionResponse> {
    this.lastRequest = request;
    this.lastContext = context;
    throw this.error;
  }
}

class ThrowingStreamBackend extends InspectingBackend {
  override async *stream(request: ChatGptCompletionRequest, context?: ChatGptBackendRequestContext) {
    yield* super.stream(request, context);
    throw new Error('backend stream boom');
  }
}

function createSessionAdminApp(backend: ChatGptBackendClient): Hono {
  const app = new Hono();
  const accountPool = new AccountPool();
  const modelRegistry = new ModelRegistry();
  app.route('/', createModelsRoute({ modelRegistry }));
  app.route('/', createAdminRoute({
    accountPool,
    modelRegistry,
    backend,
    runtimeApiKeys: new RuntimeApiKeys(),
    envApiKeys: [],
    defaultReasoningEffort: 'medium',
    defaultResponseSpeed: 'balanced',
    backendProvider: 'session',
  }));
  return app;
}

function createProvisioningTestApp(options: { authFlow?: ChatGptAuthFlowService; protectModels?: boolean } = {}): Hono {
  const app = new Hono();
  const accountPool = new AccountPool();
  const modelRegistry = new ModelRegistry();
  const runtimeApiKeys = new RuntimeApiKeys();
  const backend = new InspectingBackend([{ id: 'plain-model' }, { id: 'gpt-5-thinking' }]);
  if (options.protectModels) app.use('/v1/*', apiKeyAuth([], runtimeApiKeys));
  app.route('/', createModelsRoute({ modelRegistry }));
  app.route('/', createMessagesRoute({ backend, requestLog: new RequestLog(), modelRegistry, accountPool, backendProvider: 'session' }));
  app.route('/', createAdminRoute({
    accountPool,
    modelRegistry,
    backend,
    runtimeApiKeys,
    envApiKeys: [],
    defaultReasoningEffort: 'medium',
    defaultResponseSpeed: 'balanced',
    backendProvider: 'session',
    authFlow: options.authFlow ?? new ChatGptAuthFlowService({ enableCallbackListener: false }),
  }));
  return app;
}

function createOAuthTestFlow(tokenResponse: Record<string, unknown> = { access_token: 'token-ready', refresh_token: 'refresh-ready', id_token: 'id-ready', expires_in: 3600 }): ChatGptAuthFlowService {
  return new ChatGptAuthFlowService({
    enableCallbackListener: false,
    fetch: async (url, init) => {
      expect(String(url)).toBe('https://auth.openai.com/oauth/token');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
      const body = init?.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
      expect(body.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
      expect(body.get('code_verifier')).toBeTruthy();
      return Response.json(tokenResponse);
    },
  });
}

describe('API key auth', () => {
  it('rejects /v1/messages before admin initialization when no API key exists', async () => {
    const app = createApp({ ...env, apiKeys: [] });
    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('/admin');
  });

  it('protects /v1/messages/count_tokens with the same API key middleware', async () => {
    const app = createApp({ ...env, apiKeys: ['secret'] });
    const res = await app.request('/v1/messages/count_tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(401);
  });

  it('accepts bearer API keys from API_KEYS', async () => {
    const app = createApp({ ...env, apiKeys: ['secret'] });
    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
  });

  it('enables a random runtime development key through admin dev-enable without restart', async () => {
    const app = createApp({ ...env, apiKeys: [] });
    const firstEnableRes = await app.request('/admin/api/api-keys/dev-enable', { method: 'POST' });
    const secondEnableRes = await app.request('/admin/api/api-keys/dev-enable', { method: 'POST' });
    expect(firstEnableRes.status).toBe(200);
    expect(secondEnableRes.status).toBe(200);
    const firstEnableBody = await firstEnableRes.json() as { key: string; status: { apiKeysConfigured: boolean; runtimeApiKeysConfigured: boolean } };
    const secondEnableBody = await secondEnableRes.json() as { key: string };
    expect(firstEnableBody.key).toMatch(/^sk-dev-[A-Za-z0-9_-]+$/);
    expect(secondEnableBody.key).toMatch(/^sk-dev-[A-Za-z0-9_-]+$/);
    expect(secondEnableBody.key).not.toBe(firstEnableBody.key);
    expect(firstEnableBody.status.apiKeysConfigured).toBe(true);
    expect(firstEnableBody.status.runtimeApiKeysConfigured).toBe(true);

    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': firstEnableBody.key }, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
  });

  it('rejects admin dev-enable in production', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app = createApp({ ...env, apiKeys: [] });
      const res = await app.request('/admin/api/api-keys/dev-enable', { method: 'POST' });
      expect(res.status).toBe(403);
      const body = await res.json() as { type: string; error: { type: string; message: string } };
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('permission_error');
      expect(body.error.message).toContain('disabled in production');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
});

describe('/admin', () => {
  it('redirects the root path to the admin console', async () => {
    const app = createApp(env);
    const res = await app.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
  });

  it('returns an empty favicon response instead of a 404', async () => {
    const app = createApp(env);
    const res = await app.request('/favicon.ico');
    expect(res.status).toBe(204);
  });

  it('returns the server-rendered admin HTML page', async () => {
    const app = createApp(env);
    const res = await app.request('/admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('ChatGPT to Claude 运维控制台');
    expect(html).toContain('浏览器授权（Codex OAuth）');
    expect(html).toContain('不会启动独立 Chrome/新 profile');
    expect(html).toContain('id="auth-link"');
    expect(html).toContain('id="copy-auth-link"');
    expect(html).toContain('id="oauth-callback-url"');
    expect(html).toContain('id="submit-oauth-callback"');
    expect(html).toContain('<details id="advanced-import">');
    expect(html).toContain('高级：手动导入 accessToken / cookie');
    expect(html).toContain('__ORIGIN__');
    expect(html).not.toContain('localhost:3000/v1/messages');
  });

  it('returns setup status for mock backend and defaults', async () => {
    const app = createApp({ ...env, apiKeys: [] });
    const res = await app.request('/admin/api/setup/status');
    expect(res.status).toBe(200);
    const body = await res.json() as { apiKeysConfigured: boolean; defaultReasoningEffort: string; defaultResponseSpeed: string; backend: { enabled: boolean; provider: string; chatGptConnected: boolean }; nextStep: string };
    expect(body.apiKeysConfigured).toBe(false);
    expect(body.defaultReasoningEffort).toBe('medium');
    expect(body.defaultResponseSpeed).toBe('balanced');
    expect(body.backend).toEqual({ enabled: true, provider: 'mock', chatGptConnected: false });
    expect(body.nextStep).toContain('/admin');
  });
});

describe('/v1/messages/count_tokens', () => {
  it('returns estimated input_tokens for text and structured blocks', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        model: 'sonnet',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'weather result: ' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '72F' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aaa' } },
        ] }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { input_tokens: number };
    expect(Object.keys(body)).toEqual(['input_tokens']);
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  it('includes system text in estimated input_tokens', async () => {
    const app = createApp(env);
    const withoutSystem = await app.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ model: 'sonnet', messages: [{ role: 'user', content: 'hello' }] }),
    });
    const withSystem = await app.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ model: 'sonnet', system: 'Always answer with detailed operational constraints.', messages: [{ role: 'user', content: 'hello' }] }),
    });

    expect(withoutSystem.status).toBe(200);
    expect(withSystem.status).toBe(200);
    const withoutBody = await withoutSystem.json() as { input_tokens: number };
    const withBody = await withSystem.json() as { input_tokens: number };
    expect(withBody.input_tokens).toBeGreaterThan(withoutBody.input_tokens);
  });

  it('returns Claude-like validation errors for invalid count token requests', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('model is required');
  });

  it('rejects invalid optional max_tokens and tools on count token requests', async () => {
    const app = createApp(env);
    const badMaxTokens = await app.request('/v1/messages/count_tokens', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 0, messages: [] }) });
    expect(badMaxTokens.status).toBe(400);
    const badTools = await app.request('/v1/messages/count_tokens', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', tools: {}, messages: [] }) });
    expect(badTools.status).toBe(400);
  });
});

describe('/v1/models', () => {
  it('returns enabled resolved aliases and discovered passthrough models', async () => {
    const app = createApp({ ...env, mockBackendModelsJson: JSON.stringify([{ id: 'backend-test-model' }, { id: 'direct-backend-model' }]) });
    const res = await app.request('/v1/models', { headers: { 'x-api-key': 'test-key' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ id: string; backendModel: string; enabled: boolean; source: string; status: string; capabilities: { reasoning_effort: string[]; response_speed: string[]; thinking: boolean }; defaults: { reasoning_effort: string; speed: string } }> };
    expect(body.data.map((model) => model.id)).toContain('sonnet');
    expect(body.data.map((model) => model.id)).toContain('direct-backend-model');
    expect(body.data.map((model) => model.id)).not.toContain('opus');
    const sonnet = body.data.find((model) => model.id === 'sonnet');
    expect(sonnet).toMatchObject({ backendModel: 'backend-test-model', enabled: true, source: 'alias', status: 'bound', defaults: { reasoning_effort: 'medium', speed: 'balanced' } });
    expect(sonnet?.capabilities.reasoning_effort).toContain('high');
    expect(sonnet?.capabilities.response_speed).toContain('fast');
    expect(sonnet?.capabilities.thinking).toBe(true);
  });
});

describe('/admin/api/accounts', () => {
  it('adds a chatgpt-session account and redacts secret from admin views', async () => {
    const app = createApp(env);
    const addRes = await app.request('/admin/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'session-1', provider: 'chatgpt-session', label: 'Session 1', secret: { type: 'chatgpt-session', accessToken: 'token-1', cookie: 'cookie-1', deviceId: 'device-1', userAgent: 'ua-1' }, capabilities: ['chatgpt-session', 'messages'] }) });
    expect(addRes.status).toBe(201);
    const addBody = await addRes.json() as { account: Record<string, unknown> };
    expect(addBody.account).toMatchObject({ id: 'session-1', provider: 'chatgpt-session', hasSecret: true });
    expect(addBody.account).not.toHaveProperty('secret');

    const listRes = await app.request('/admin/api/accounts');
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { accounts: Array<Record<string, unknown>> };
    const session = listBody.accounts.find((account) => account.id === 'session-1');
    expect(session).toMatchObject({ provider: 'chatgpt-session', hasSecret: true });
    expect(session).not.toHaveProperty('secret');
  });

  it('adds, lists, patches, and health-checks runtime accounts', async () => {
    const app = createApp(env);
    const addRes = await app.request('/admin/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'mock-2', label: 'Mock 2', maxConcurrency: 3, capabilities: ['mock', 'messages'] }) });
    expect(addRes.status).toBe(201);
    const addBody = await addRes.json() as { account: { id: string; label: string; maxConcurrency: number; status: string; enabled: boolean } };
    expect(addBody.account).toMatchObject({ id: 'mock-2', label: 'Mock 2', maxConcurrency: 3, status: 'available', enabled: true });

    const listRes = await app.request('/admin/api/accounts');
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { accounts: Array<{ id: string }> };
    expect(listBody.accounts.map((account) => account.id)).toContain('mock-2');

    const patchRes = await app.request('/admin/api/accounts/mock-2', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, lastError: 'manual disable' }) });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as { account: { status: string; enabled: boolean; lastError: string } };
    expect(patchBody.account).toMatchObject({ status: 'disabled', enabled: false, lastError: 'manual disable' });

    const healthRes = await app.request('/admin/api/accounts/mock-2/health-check', { method: 'POST' });
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json() as { ok: boolean; account: { status: string; lastError: string | null; lastUsedAt: string | null } };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.account.status).toBe('disabled');
    expect(healthBody.account.lastError).toBeNull();
    expect(healthBody.account.lastUsedAt).toEqual(expect.any(String));
  });
});

describe('ChatGPT one-click auth admin flow', () => {
  it('starts Codex OAuth and returns auth.openai.com authorizeUrl without opening Chrome', async () => {
    const app = createProvisioningTestApp();
    const res = await app.request('/admin/api/auth/chatgpt/start', { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; authorizeUrl: string; state: string; openedByService: boolean };
    const url = new URL(body.authorizeUrl);
    expect(body.id).toMatch(/^flow-/);
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(url.searchParams.get('scope')).toBe('openid email profile offline_access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(body.openedByService).toBe(false);
    expect(body.state).toBe('link_ready');
    expect(JSON.stringify(body)).not.toContain('token-ready');
  });

  it('polls pending, accepts callback URL, exchanges token, provisions once and returns apiKey/account/models/aliases', async () => {
    const app = createProvisioningTestApp({ authFlow: createOAuthTestFlow() });
    const startRes = await app.request('/admin/api/auth/chatgpt/start', { method: 'POST' });
    const startBody = await startRes.json() as { id: string; authorizeUrl: string };
    const oauthState = new URL(startBody.authorizeUrl).searchParams.get('state');
    expect(oauthState).toBeTruthy();

    const pendingRes = await app.request(`/admin/api/auth/chatgpt/${startBody.id}`);
    const pendingBody = await pendingRes.json() as { state: string; provisionResult?: unknown };
    expect(pendingBody.state).toBe('waiting');
    expect(pendingBody.provisionResult).toBeUndefined();

    const callbackRes = await app.request('/admin/api/auth/chatgpt/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirectUrl: `http://localhost:1455/auth/callback?code=code-ready&state=${oauthState}` }),
    });
    expect(callbackRes.status).toBe(200);
    const callbackBody = await callbackRes.json() as { id: string; state: string };
    expect(callbackBody.id).toBe(startBody.id);
    expect(callbackBody.state).toBe('waiting');
    expect(JSON.stringify(callbackBody)).not.toContain('token-ready');
    expect(JSON.stringify(callbackBody)).not.toContain('refresh-ready');

    const readyRes = await app.request(`/admin/api/auth/chatgpt/${startBody.id}`);
    expect(readyRes.status).toBe(200);
    const readyBody = await readyRes.json() as { state: string; provisioned: boolean; provisionResult: { apiKey: string; account: Record<string, unknown>; modelsDiscovered: string[]; boundAliases: Record<string, string> } };
    expect(readyBody.state).toBe('ready');
    expect(readyBody.provisioned).toBe(true);
    expect(readyBody.provisionResult.apiKey).toMatch(/^sk-runtime-/);
    expect(readyBody.provisionResult.account).toMatchObject({ id: 'chatgpt-primary', provider: 'chatgpt-session', hasSecret: true });
    expect(readyBody.provisionResult.account).not.toHaveProperty('secret');
    expect(readyBody.provisionResult.modelsDiscovered).toEqual(['plain-model', 'gpt-5-thinking']);
    expect(readyBody.provisionResult.boundAliases).toEqual({ sonnet: 'gpt-5-thinking' });
    expect(JSON.stringify(readyBody)).not.toContain('token-ready');
    expect(JSON.stringify(readyBody)).not.toContain('refresh-ready');

    const thirdRes = await app.request(`/admin/api/auth/chatgpt/${startBody.id}`);
    const thirdBody = await thirdRes.json() as { provisionResult: { apiKey: string } };
    expect(thirdBody.provisionResult.apiKey).toBe(readyBody.provisionResult.apiKey);
  });

  it('allows the returned apiKey to access /v1/models', async () => {
    const app = createProvisioningTestApp({ authFlow: createOAuthTestFlow({ access_token: 'token-ready' }), protectModels: true });
    const startRes = await app.request('/admin/api/auth/chatgpt/start', { method: 'POST' });
    const { id, authorizeUrl } = await startRes.json() as { id: string; authorizeUrl: string };
    const oauthState = new URL(authorizeUrl).searchParams.get('state');
    await app.request('/admin/api/auth/chatgpt/callback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'code-ready', state: oauthState }) });
    const pollRes = await app.request(`/admin/api/auth/chatgpt/${id}`);
    const pollBody = await pollRes.json() as { provisionResult: { apiKey: string } };

    const modelsRes = await app.request('/v1/models', { headers: { 'x-api-key': pollBody.provisionResult.apiKey } });
    expect(modelsRes.status).toBe(200);
    const models = await modelsRes.json() as { data: Array<{ id: string; backendModel: string }> };
    expect(models.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'sonnet', backendModel: 'gpt-5-thinking' })]));
  });

  it('manual complete creates/updates chatgpt-primary without leaking secret', async () => {
    const app = createProvisioningTestApp();
    const firstRes = await app.request('/admin/api/auth/chatgpt/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessToken: 'manual-token-1', cookie: 'a=b' }) });
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json() as { account: Record<string, unknown>; apiKey: string };
    expect(firstBody.account).toMatchObject({ id: 'chatgpt-primary', provider: 'chatgpt-session', hasSecret: true });
    expect(firstBody.account).not.toHaveProperty('secret');

    const secondRes = await app.request('/admin/api/auth/chatgpt/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: { accessToken: 'manual-token-2' } }) });
    expect(secondRes.status).toBe(200);
    const accountsRes = await app.request('/admin/api/accounts');
    const accountsBody = await accountsRes.json() as { accounts: Array<Record<string, unknown>> };
    expect(accountsBody.accounts.filter((account) => account.id === 'chatgpt-primary')).toHaveLength(1);
    expect(JSON.stringify(accountsBody)).not.toContain('manual-token');
  });
});

describe('SessionChatGptBackend', () => {
  it('listModels fetches codex models with account context and parses model ids', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const backend = new SessionChatGptBackend({
      baseUrl: 'https://chatgpt.test/',
      timeoutMs: 1000,
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(url), authorization: headers.get('authorization') });
        return Response.json({ models: [{ id: 'gpt-5-thinking', display_name: 'GPT 5 Thinking' }, { slug: 'codex-mini', title: 'Codex Mini' }] });
      },
    });

    const models = await backend.listModels({ account: { id: 'session-1', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'token-1' } } });
    expect(calls).toEqual([{ url: 'https://chatgpt.test/backend-api/codex/models', authorization: 'Bearer token-1' }]);
    expect(models.map((model) => model.id)).toEqual(['gpt-5-thinking', 'codex-mini']);
    expect(models[0].displayName).toBe('GPT 5 Thinking');
  });
});

describe('session admin model discovery', () => {
  it('refreshes models with the first available session account and exposes them through /v1/models', async () => {
    const backend = new InspectingBackend([{ id: 'backend-session-model' }]);
    const app = createSessionAdminApp(backend);
    const addRes = await app.request('/admin/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'session-1', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'token-1' }, capabilities: ['chatgpt-session', 'messages'] }) });
    expect(addRes.status).toBe(201);
    const healthRes = await app.request('/admin/api/accounts/session-1/health-check', { method: 'POST' });
    expect(healthRes.status).toBe(200);
    expect(backend.listModelsContext?.account?.id).toBe('session-1');

    const patchRes = await app.request('/admin/api/models/sonnet', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backendModel: 'backend-session-model' }) });
    expect(patchRes.status).toBe(200);
    const publicModelsRes = await app.request('/v1/models');
    expect(publicModelsRes.status).toBe(200);
    const publicModels = await publicModelsRes.json() as { data: Array<{ id: string; backendModel: string; status: string }> };
    expect(publicModels.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'sonnet', backendModel: 'backend-session-model', status: 'bound' })]));
    expect(publicModels.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'backend-session-model', backendModel: 'backend-session-model' })]));
  });

  it('returns a clear error when session model refresh has no session account', async () => {
    const app = createSessionAdminApp(new InspectingBackend([{ id: 'backend-session-model' }]));
    const refreshRes = await app.request('/admin/api/models/refresh', { method: 'POST' });
    expect(refreshRes.status).toBe(409);
    const body = await refreshRes.json() as { error: string };
    expect(body.error).toContain('No available chatgpt-session account');
  });
});

describe('/admin/api/models', () => {
  it('uses MODEL_REGISTRY_JSON as alias overlay source and resets back to it', () => {
    const modelRegistry = new ModelRegistry({
      env: {
        MODEL_REGISTRY_JSON: JSON.stringify({
          aliases: [{
            id: 'custom',
            display_name: 'Custom Alias',
            backendModel: 'backend-custom',
            enabled: true,
            defaults: { reasoning_effort: 'low', speed: 'fast' },
          }],
        }),
      },
      discoveredModels: [{ id: 'backend-custom' }, { id: 'changed' }],
    });

    expect(modelRegistry.adminView().aliases).toHaveLength(1);
    expect(modelRegistry.get('custom')?.backendModel).toBe('backend-custom');
    modelRegistry.update('custom', { backendModel: 'changed', defaults: { reasoning_effort: 'max', speed: 'quality' } });
    expect(modelRegistry.get('custom')?.backendModel).toBe('changed');
    const reset = modelRegistry.reset();
    expect(reset[0]).toMatchObject({ id: 'custom', backendModel: 'backend-custom', defaults: { reasoning_effort: 'low', speed: 'fast' } });
  });

  it('patches, lists, refreshes, and resets alias overlay models', async () => {
    const app = createApp(env);
    const patchRes = await app.request('/admin/api/models/haiku', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backendModel: 'backend-test-model', enabled: false, defaults: { reasoning_effort: 'minimal', speed: 'fastest' } }) });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as { model: { backendModel: string; enabled: boolean; defaults: { reasoning_effort: string; speed: string } } };
    expect(patchBody.model).toMatchObject({ backendModel: 'backend-test-model', enabled: false, defaults: { reasoning_effort: 'minimal', speed: 'fastest' } });

    const adminListRes = await app.request('/admin/api/models');
    const adminListBody = await adminListRes.json() as { aliases: Array<{ id: string; enabled: boolean }>; discovered: Array<{ id: string }>; combined: Array<{ id: string }> };
    expect(adminListBody.aliases.find((model) => model.id === 'haiku')?.enabled).toBe(false);
    expect(adminListBody.discovered.map((model) => model.id)).toContain('backend-test-model');
    expect(adminListBody.combined.map((model) => model.id)).toContain('backend-test-model');

    const publicListRes = await app.request('/v1/models', { headers: { 'x-api-key': 'test-key' } });
    const publicListBody = await publicListRes.json() as { data: Array<{ id: string }> };
    expect(publicListBody.data.map((model) => model.id)).not.toContain('haiku');

    const refreshRes = await app.request('/admin/api/models/refresh', { method: 'POST' });
    expect(refreshRes.status).toBe(200);
    const refreshBody = await refreshRes.json() as { discovered: Array<{ id: string }> };
    expect(refreshBody.discovered.map((model) => model.id)).toContain('backend-test-model');

    const resetRes = await app.request('/admin/api/models/reset', { method: 'POST' });
    expect(resetRes.status).toBe(200);
    const resetBody = await resetRes.json() as { models: Array<{ id: string; backendModel?: string; enabled: boolean; defaults: { reasoning_effort: string; speed: string } }> };
    const resetHaiku = resetBody.models.find((model) => model.id === 'haiku');
    expect(resetHaiku?.enabled).toBe(true);
    expect(resetHaiku?.backendModel).toBe('backend-test-model');
    expect(resetHaiku?.defaults).not.toEqual({ reasoning_effort: 'minimal', speed: 'fastest' });
  });
});
