import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ClaudeApiError } from '@chatgpt-to-claude/claude-protocol';
import { BackendRouting, type BackendRoutingMode } from './backend-routing.js';
import { AccountPool } from './account-pool.js';
import { requestAccountOptions, requestBackendMode } from './request-backend-routing.js';

const gateway = { baseUrl: 'http://gateway.test', models: ['shared-model'], supportsTools: true };
function fixture(routing?: BackendRouting) {
  const pool = new AccountPool({ seedMockAccount: false });
  pool.add({ id: 'codex', provider: 'chatgpt-session', capabilities: ['messages'], secret: { type: 'chatgpt-session', accessToken: 'synthetic-token' } });
  pool.add({ id: 'web', provider: 'chatgpt-web', capabilities: ['messages'] });
  const app = new Hono();
  app.onError((error, c) => error instanceof ClaudeApiError ? c.json({ error: error.message }, error.status as 400) : c.json({ error: 'Unexpected error' }, 500));
  app.get('/', (c) => {
    const mode = requestBackendMode(c, routing);
    const options = requestAccountOptions(c, { accountPool: pool, backendProvider: 'session', backendRouting: routing },
      { model: 'shared-model', messages: [{ role: 'user', content: 'hello' }], maxTokens: 8 }, () => true);
    const codex = pool.get('codex')!, web = pool.get('web')!;
    return c.json({ mode, provider: options.provider ?? 'auto', codexPriority: options.priority!(codex), webPriority: options.priority!(web),
      webEligible: options.eligible!(web), codexEligible: options.eligible!(codex) });
  });
  return (override?: string) => app.request('/', { headers: override === undefined ? {} : { 'x-chat2claude-backend': override } });
}

describe('request backend explicit opt-in', () => {
  it.each(['codex', 'auto', 'web'] as const)('keeps a legacy gateway disabled with saved mode %s', async (mode) => {
    const send = fixture(new BackendRouting({ mode, gateway }));
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: mode === 'web' ? 'codex' : mode, webEligible: false, codexEligible: true,
      codexPriority: 0, webPriority: 1 });
    expect((await send('auto')).status).toBe(200);
    expect(await (await send('auto')).json()).toMatchObject({ mode: 'auto', webEligible: false, codexEligible: true });
    const forced = await send('web');
    expect(forced.status).toBe(403);
    expect(await forced.json()).toEqual({ error: 'ChatGPT web access is disabled by the administrator.' });
  });

  it.each([undefined, false])('cannot enable web with a request header when the administrator choice is %s', async (webEnabled) => {
    const send = fixture(new BackendRouting({ mode: 'web', ...(webEnabled === undefined ? {} : { webEnabled }), gateway }));
    expect((await send('web')).status).toBe(403);
    expect(await (await send()).json()).toMatchObject({ mode: 'codex', provider: 'chatgpt-session', webEligible: false });
  });

  it('also blocks a web override when routing has never been configured', async () => {
    const send = fixture();
    expect((await send('web')).status).toBe(403);
    expect(await (await send()).json()).toMatchObject({ mode: 'codex', webEligible: false });
  });

  it('prefers Codex by default after explicit opt-in while preserving manual web selection', async () => {
    const send = fixture(new BackendRouting({ mode: 'auto', webEnabled: true, gateway }));
    expect(await (await send()).json()).toMatchObject({ mode: 'auto', provider: 'auto', codexPriority: 0, webPriority: 1, webEligible: true });
    expect(await (await send('web')).json()).toMatchObject({ mode: 'web', provider: 'chatgpt-web', webEligible: true });
  });

  it.each(['auto', 'web'] satisfies BackendRoutingMode[])('retains explicitly enabled web and an explicit web preference in %s mode', async (mode) => {
    const send = fixture(new BackendRouting({ mode, webEnabled: true, autoPreference: 'web', gateway }));
    expect(await (await send()).json()).toMatchObject({ mode, codexPriority: 1, webPriority: 0, webEligible: true });
    expect((await send('web')).status).toBe(200);
  });

  it('continues rejecting invalid override values', async () => {
    expect((await fixture(new BackendRouting({ mode: 'codex' }))('invalid')).status).toBe(400);
  });
});
