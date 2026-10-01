import { describe, expect, it } from 'vitest';
import { SessionChatGptBackend, type ChatGptStreamEvent } from './index.js';

const request = { model: 'synthetic-model', maxTokens: 16, messages: [] };
const context = { account: { id: 'synthetic-account', provider: 'chatgpt-session' as const, secret: { type: 'chatgpt-session' as const, accessToken: 'synthetic-token' } } };

describe('session in-band rate limit classification', () => {
  it.each([
    { type: 'error', code: 'rate_limit_exceeded', message: 'RATE_LIMIT_PRIVATE_MESSAGE' },
    { type: 'error', error: { code: 'insufficient_quota', message: 'RATE_LIMIT_PRIVATE_MESSAGE' } },
    { type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'RATE_LIMIT_PRIVATE_MESSAGE' } } },
    { type: 'response.failed', response: { status: 'failed', error: { type: 'rate_limit_error', message: 'RATE_LIMIT_PRIVATE_MESSAGE' } } },
  ])('reports $type as rate_limited even when HTTP headers are 200', async (frame) => {
    for (const ready of [false, true]) {
      const frames = [...(ready ? [{ type: 'response.created', response: { id: 'synthetic-response', status: 'in_progress' } }] : []), frame];
      const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(frames.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 }) });
      const events: ChatGptStreamEvent[] = [];
      const operation = async () => { for await (const event of backend.stream(request, context)) events.push(event); };
      const error = await operation().catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'rate_limited', status: 429, safeDiagnostic: { httpStatus: 200, failurePhase: 'response_event' } });
      expect(events.some((event) => event.type === 'done')).toBe(false);
      expect(JSON.stringify(error)).not.toContain('RATE_LIMIT_PRIVATE_MESSAGE');
    }
  });

  it('does not infer a rate limit from a provider message', async () => {
    const frame = { type: 'error', code: 'unknown', message: 'rate_limit_exceeded' };
    const backend = new SessionChatGptBackend({ baseUrl: 'https://chatgpt.test', timeoutMs: 1000, fetch: async () => new Response(`data: ${JSON.stringify(frame)}\n\n`) });
    await expect(backend.complete(request, context)).rejects.toMatchObject({ code: 'upstream_error', status: 502 });
  });
});
