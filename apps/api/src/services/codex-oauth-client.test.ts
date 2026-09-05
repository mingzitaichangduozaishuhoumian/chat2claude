import { describe, expect, it } from 'vitest';
import { CodexOAuthClient } from './codex-oauth-client.js';

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

describe('CodexOAuthClient token metadata', () => {
  it('uses official identity for authorization, token exchange, and refresh', async () => {
    const headers: Headers[] = [];
    const client = new CodexOAuthClient({ clientVersion: '2.3.4', fetch: async (_url, init) => {
      headers.push(new Headers(init?.headers));
      return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' });
    } });
    const input = { state: 'state', codeVerifier: 'verifier', redirectUri: 'http://localhost:1455/auth/callback' };
    expect(new URL(client.buildAuthorizeUrl(input)).searchParams.get('originator')).toBe('codex_cli_rs');
    const secret = await client.exchangeCode({ ...input, code: 'code' });
    await client.refreshSecret(secret);
    for (const item of headers) {
      expect(item.get('originator')).toBe('codex_cli_rs');
      expect(item.get('user-agent')).toMatch(/^codex_cli_rs\/2\.3\.4 /);
      expect(item.get('accept')).toBe('application/json');
      expect(item.get('content-type')).toBe('application/x-www-form-urlencoded');
    }
    await client.refreshSecret({ ...secret, userAgent: 'stored-client/7' });
    expect(headers[2].get('user-agent')).toBe('stored-client/7');
  });

  it.each(['pro', 'prolite', 'synthetic-future-plan'])('preserves the raw %s plan claim', async (planType) => {
    const client = new CodexOAuthClient({ fetch: async () => Response.json({ access_token: 'synthetic-access', id_token: jwt({
      'https://api.openai.com/auth': { chatgpt_plan_type: planType },
    }) }) });
    await expect(client.exchangeCode({ code: 'code', codeVerifier: 'verifier', redirectUri: 'http://localhost:1455/auth/callback', state: 'state' })).resolves.toMatchObject({ planType });
  });

  it('rejects unsafe protocol version configuration', () => {
    expect(() => new CodexOAuthClient({ clientVersion: 'secret-invalid-version' })).toThrow('CODEX_CLIENT_VERSION must be a valid SemVer version');
  });

  it('extracts account metadata from the id token payload without exposing the raw token', async () => {
    const idToken = jwt({
      email: 'top@example.test',
      'https://api.openai.com/profile': { email: 'profile@example.test' },
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123', chatgpt_plan_type: 'plus' },
    });
    const client = new CodexOAuthClient({ fetch: async () => Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', id_token: idToken }) });

    const secret = await client.exchangeCode({ code: 'code', codeVerifier: 'verifier', redirectUri: 'http://localhost:1455/auth/callback', state: 'state' });

    expect(secret).toMatchObject({ email: 'top@example.test', accountId: 'acct-123', planType: 'plus' });
    expect(JSON.stringify({ email: secret.email, accountId: secret.accountId, planType: secret.planType })).not.toContain(idToken);
  });

  it('preserves prior metadata when a refresh returns no usable id token claims', async () => {
    const client = new CodexOAuthClient({ fetch: async () => Response.json({ access_token: 'access-2', id_token: 'not-a-jwt' }) });

    const secret = await client.refreshSecret({
      type: 'chatgpt-session',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      email: 'me@example.test',
      accountId: 'acct-1',
      planType: 'pro',
    });

    expect(secret).toMatchObject({ email: 'me@example.test', accountId: 'acct-1', planType: 'pro' });
  });
});
