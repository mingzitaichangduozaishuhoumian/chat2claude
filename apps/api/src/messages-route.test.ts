import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
const env = { port: 3000, host: '127.0.0.1', apiKeys: ['test-key'], logLevel: 'error' as const, mockResponsePrefix: 'Echo:', defaultReasoningEffort: 'medium' as const, defaultResponseSpeed: 'balanced' as const };
const jsonHeaders = { 'content-type': 'application/json', 'x-api-key': 'test-key' };
describe('/v1/messages', () => {
  it('returns a Claude-like non-stream message with resolved effort and speed', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'claude-3-5-sonnet-latest', max_tokens: 64, output_config: { effort: 'high' }, speed: 'fast', messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { type: string; role: string; content: Array<{ text: string }>; stop_reason: string };
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.content[0].text).toBe('Echo:[effort=high,speed=fast] hello');
    expect(body.stop_reason).toBe('end_turn');
  });
  it('uses model registry defaults when request omits effort and speed', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'sonnet', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: Array<{ text: string }> };
    expect(body.content[0].text).toBe('Echo:[effort=medium,speed=balanced] hello');
  });

  it('uses patched model defaults in mock echo', async () => {
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
    const res = await app.request('/v1/messages', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'claude-3-5-sonnet-latest', max_tokens: 64, stream: true, reasoning_effort: 'low', response_speed: 'quality', messages: [{ role: 'user', content: 'hello' }] }) });
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
});

describe('API key auth', () => {
  it('rejects /v1/messages before admin initialization when no API key exists', async () => {
    const app = createApp({ ...env, apiKeys: [] });
    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-3-5-sonnet-latest', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('/admin');
  });

  it('accepts bearer API keys from API_KEYS', async () => {
    const app = createApp({ ...env, apiKeys: ['secret'] });
    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ model: 'claude-3-5-sonnet-latest', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
  });

  it('enables runtime sk-test through admin dev-enable without restart', async () => {
    const app = createApp({ ...env, apiKeys: [] });
    const enableRes = await app.request('/admin/api/api-keys/dev-enable', { method: 'POST' });
    expect(enableRes.status).toBe(200);
    const enableBody = await enableRes.json() as { key: string; status: { apiKeysConfigured: boolean; runtimeApiKeysConfigured: boolean } };
    expect(enableBody.key).toBe('sk-test');
    expect(enableBody.status.apiKeysConfigured).toBe(true);
    expect(enableBody.status.runtimeApiKeysConfigured).toBe(true);

    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' }, body: JSON.stringify({ model: 'claude-3-5-sonnet-latest', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }) });
    expect(res.status).toBe(200);
  });
});

describe('/admin', () => {
  it('returns setup status for mock backend and defaults', async () => {
    const app = createApp({ ...env, apiKeys: [] });
    const res = await app.request('/admin/api/setup/status');
    expect(res.status).toBe(200);
    const body = await res.json() as { apiKeysConfigured: boolean; defaultReasoningEffort: string; defaultResponseSpeed: string; mockBackend: { enabled: boolean; provider: string; chatGptConnected: boolean }; nextStep: string };
    expect(body.apiKeysConfigured).toBe(false);
    expect(body.defaultReasoningEffort).toBe('medium');
    expect(body.defaultResponseSpeed).toBe('balanced');
    expect(body.mockBackend).toEqual({ enabled: true, provider: 'mock', chatGptConnected: false });
    expect(body.nextStep).toContain('/admin');
  });
});

describe('/v1/models', () => {
  it('returns three enabled runtime model aliases', async () => {
    const app = createApp(env);
    const res = await app.request('/v1/models', { headers: { 'x-api-key': 'test-key' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ id: string; claudeModel: string; backendModel: string; enabled: boolean; capabilities: { reasoning_effort: string[]; response_speed: string[]; thinking: boolean }; defaults: { reasoning_effort: string; speed: string } }> };
    expect(body.data.map((model) => model.id)).toEqual(['haiku', 'sonnet', 'opus']);
    expect(body.data).toHaveLength(3);
    expect(body.data[1].claudeModel).toBe('claude-3-5-sonnet-latest');
    expect(body.data[1].backendModel).toBe('gpt-4o');
    expect(body.data[1].enabled).toBe(true);
    expect(body.data[1].capabilities.reasoning_effort).toContain('high');
    expect(body.data[1].capabilities.response_speed).toContain('fast');
    expect(body.data[1].capabilities.thinking).toBe(true);
    expect(body.data[1].defaults).toEqual({ reasoning_effort: 'medium', speed: 'balanced' });
  });
});


describe('/admin/api/accounts', () => {
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


describe('/admin/api/models', () => {
  it('patches and resets runtime models', async () => {
    const app = createApp(env);
    const patchRes = await app.request('/admin/api/models/haiku', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backendModel: 'gpt-test', enabled: false, defaults: { reasoning_effort: 'minimal', speed: 'fastest' } }) });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as { model: { backendModel: string; enabled: boolean; defaults: { reasoning_effort: string; speed: string } } };
    expect(patchBody.model).toMatchObject({ backendModel: 'gpt-test', enabled: false, defaults: { reasoning_effort: 'minimal', speed: 'fastest' } });

    const adminListRes = await app.request('/admin/api/models');
    const adminListBody = await adminListRes.json() as { models: Array<{ id: string; enabled: boolean }> };
    expect(adminListBody.models.find((model) => model.id === 'haiku')?.enabled).toBe(false);

    const publicListRes = await app.request('/v1/models', { headers: { 'x-api-key': 'test-key' } });
    const publicListBody = await publicListRes.json() as { data: Array<{ id: string }> };
    expect(publicListBody.data.map((model) => model.id)).not.toContain('haiku');

    const resetRes = await app.request('/admin/api/models/reset', { method: 'POST' });
    expect(resetRes.status).toBe(200);
    const resetBody = await resetRes.json() as { models: Array<{ id: string; backendModel: string; enabled: boolean; defaults: { reasoning_effort: string; speed: string } }> };
    expect(resetBody.models.find((model) => model.id === 'haiku')).toMatchObject({ backendModel: 'gpt-4o-mini', enabled: true, defaults: { reasoning_effort: 'low', speed: 'fast' } });
  });
});
