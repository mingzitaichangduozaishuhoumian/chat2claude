import { describe, expect, it } from 'vitest';
import { CodexOAuthClient } from './codex-oauth-client.js';

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

describe('CodexOAuthClient token metadata', () => {
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
