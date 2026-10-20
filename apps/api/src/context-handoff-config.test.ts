import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type Chat2ClaudeApp } from './app.js';
import { loadEnv } from './config/env.js';
import { RuntimeStateStore } from './services/runtime-state-store.js';

const ADMIN_KEY = 'context-handoff-test-admin-key';
const applications: Chat2ClaudeApp[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.dispose()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(store: RuntimeStateStore | null = null, environment: NodeJS.ProcessEnv = {}) {
  const app = createApp(loadEnv({ CHATGPT_BACKEND: 'mock', API_KEYS: ADMIN_KEY, LOG_LEVEL: 'error', ...environment }), {
    runtimeStateStore: store, operationalState: null,
  });
  applications.push(app);
  const headers = { 'content-type': 'application/json', 'x-api-key': ADMIN_KEY };
  const patch = (body: unknown) => app.request('http://api.test/admin/api/backend-routing', {
    method: 'PATCH', headers, body: JSON.stringify(body),
  });
  const view = async () => {
    const response = await app.request('/admin/api/backend-routing', { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return await response.json() as Record<string, unknown>;
  };
  const close = async () => {
    applications.splice(applications.indexOf(app), 1);
    await app.dispose();
  };
  return { app, patch, view, close };
}

function statePath() {
  const directory = mkdtempSync(join(tmpdir(), 'chat2claude-handoff-config-'));
  directories.push(directory);
  return join(directory, 'state.json');
}

describe('Visible context handoff configuration', () => {
  it('defaults off, requires Admin authentication, and preserves gateway state on independent updates', async () => {
    const f = fixture();
    expect(await f.view()).toMatchObject({ mode: 'codex', contextHandoff: false, configured: false });
    expect((await f.app.request('/admin/api/backend-routing')).status).toBe(401);
    expect((await f.app.request('/admin/api/backend-routing', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contextHandoff: true }),
    })).status).toBe(401);
    expect((await f.patch({ gateway: { baseUrl: 'http://gateway.test:8090', apiKey: 'PRIVATE_GATEWAY_KEY' } })).status).toBe(200);
    const response = await f.patch({ contextHandoff: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'codex', contextHandoff: true, gateway: { apiKeyConfigured: true } });
    expect(JSON.stringify(await f.view())).not.toContain('PRIVATE_GATEWAY_KEY');
    expect((await f.patch({ mode: 'auto', webEnabled: false })).status).toBe(200);
    expect(await f.view()).toMatchObject({ mode: 'auto', contextHandoff: true, webEnabled: false, gateway: { apiKeyConfigured: true } });
    expect((await f.patch({ mode: 'codex', gateway: null })).status).toBe(200);
    expect(await f.view()).toMatchObject({ contextHandoff: true, configured: false });
  });

  it('persists both choices encrypted across restarts instead of reapplying environment defaults', async () => {
    const path = statePath();
    const store = new RuntimeStateStore({ path, encryptionKey: Buffer.alloc(32, 8) });
    const first = fixture(store, { CHATGPT_CONTEXT_HANDOFF: 'false' });
    expect((await first.patch({ contextHandoff: true, gateway: { baseUrl: 'http://gateway.test:8090', apiKey: 'PRIVATE_GATEWAY_KEY' } })).status).toBe(200);
    expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE_GATEWAY_KEY');
    await first.close();
    const second = fixture(store, { CHATGPT_CONTEXT_HANDOFF: 'false' });
    expect(await second.view()).toMatchObject({ contextHandoff: true, gateway: { apiKeyConfigured: true } });
    expect((await second.patch({ contextHandoff: false })).status).toBe(200);
    await second.close();
    const third = fixture(store, { CHATGPT_CONTEXT_HANDOFF: 'true' });
    expect(await third.view()).toMatchObject({ contextHandoff: false, gateway: { apiKeyConfigured: true } });
  });

  it.each(['PRIVATE_VALUE', null, 1, []])('rejects malformed handoff updates without changing existing state (case %#)', async (contextHandoff) => {
    const f = fixture();
    expect((await f.patch({ contextHandoff: true })).status).toBe(200);
    const response = await f.patch({ contextHandoff, mode: 'web' });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('PRIVATE_VALUE');
    expect(await f.view()).toMatchObject({ mode: 'codex', contextHandoff: true });
  });

  it('rolls handoff back when the durable write fails', async () => {
    const store = new RuntimeStateStore({ path: statePath(), fs: {
      ...nodeFs, renameSync() { throw Object.assign(new Error('fixture write failure'), { code: 'EIO' }); },
    } });
    const f = fixture(store);
    const response = await f.patch({ contextHandoff: true });
    expect(response.status).toBe(500);
    expect(await f.view()).toMatchObject({ contextHandoff: false });
  });
});
