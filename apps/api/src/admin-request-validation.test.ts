import { describe, expect, it } from 'vitest';
import { MockChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { createAdminRoute } from './routes/admin.js';
import { AccountPool } from './services/account-pool.js';
import { ModelRegistry } from './services/model-registry.js';
import { RuntimeApiKeys } from './services/runtime-api-keys.js';

function fixture() {
  const accountPool = new AccountPool();
  const modelRegistry = new ModelRegistry();
  const runtimeApiKeys = new RuntimeApiKeys();
  const app = createAdminRoute({
    accountPool, modelRegistry, runtimeApiKeys, backend: new MockChatGptBackend(),
    envApiKeys: [], defaultReasoningEffort: 'none', defaultResponseSpeed: 'standard', backendProvider: 'mock',
  });
  return { app, accountPool, modelRegistry, runtimeApiKeys };
}

describe('Admin JSON request validation', () => {
  it.each(['{', '[]', 'null', '"text"', '42'])('rejects invalid or non-object body %s without creating state', async (body) => {
    const f = fixture();
    for (const path of ['/admin/api/api-keys', '/admin/api/accounts']) {
      const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: body === '{' ? 'Request body must be valid JSON.' : 'Request body must be a JSON object.' });
    }
    expect(f.runtimeApiKeys.size).toBe(0);
    expect(f.accountPool.list().map((account) => account.id)).toEqual(['mock-account']);
  });

  it.each(['/admin/api/accounts/mock-account', '/admin/api/models/sonnet'])('rejects malformed PATCH to %s rather than reporting a successful save', async (path) => {
    const f = fixture();
    const before = { accounts: f.accountPool.snapshot(), aliases: f.modelRegistry.exportState() };
    const response = await f.app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be valid JSON.' });
    expect({ accounts: f.accountPool.snapshot(), aliases: f.modelRegistry.exportState() }).toEqual(before);
  });

  it('preserves bodyless Runtime API Key creation for existing clients', async () => {
    const f = fixture();
    const response = await f.app.request('/admin/api/api-keys', { method: 'POST' });
    expect(response.status).toBe(201);
    expect(f.runtimeApiKeys.size).toBe(1);
  });
});
