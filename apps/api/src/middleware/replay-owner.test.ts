import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { apiKeyAuth } from './auth.js';
import { RuntimeApiKeys } from '../services/runtime-api-keys.js';

describe('authenticated replay owner', () => {
  it('uses stable non-secret env/runtime identities and rotates on revoke/recreate', async () => {
    const keys = new RuntimeApiKeys();
    keys.add('runtime-secret');
    const app = new Hono();
    app.use('*', apiKeyAuth(['env-secret'], keys));
    app.get('/', (c) => c.json({ owner: c.get('reasoningReplayOwner') }));
    const get = async (key: string) => (await app.request('/', { headers: { 'x-api-key': key } })).json() as Promise<{ owner: string }>;
    const env = await get('env-secret');
    const runtime = await get('runtime-secret');
    expect(env.owner).toMatch(/^env:[0-9a-f]{64}$/);
    expect(runtime.owner).toMatch(/^runtime:/);
    expect(env).toEqual(await get('env-secret'));
    expect(runtime).toEqual(await get('runtime-secret'));
    expect(JSON.stringify([env, runtime])).not.toContain('secret');
    keys.revoke(keys.listSafe()[0].id);
    expect((await app.request('/', { headers: { 'x-api-key': 'runtime-secret' } })).status).toBe(401);
    keys.add('runtime-secret');
    expect((await get('runtime-secret')).owner).not.toBe(runtime.owner);
  });
});
