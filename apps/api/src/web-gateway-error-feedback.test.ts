import { describe, expect, it, vi } from 'vitest';
import { ChatGptBackendError, WebGatewayChatGptBackend } from '@chatgpt-to-claude/chatgpt-backend';
import { mapChatGptBackendError, mapErrorPayload } from './routes/backend-errors.js';

async function gatewayError(fetchImpl: typeof fetch) {
  const backend = new WebGatewayChatGptBackend({ getConfiguration: () => ({ baseUrl: 'https://gateway.invalid', apiKey: 'PRIVATE_KEY', models: ['auto'] }), fetch: fetchImpl });
  return backend.complete({ model: 'auto', messages: [{ role: 'user', content: 'synthetic' }], maxTokens: 10 }).catch((error: unknown) => error);
}

describe('Actionable web gateway client errors', () => {
  it.each([
    [400, 'invalid_request_error', 'model mappings'],
    [401, 'authentication_error', 'API key'],
    [403, 'authentication_error', 'web login'],
    [429, 'rate_limit_error', 'rate limited'],
    [503, 'api_error', 'unavailable'],
  ] as const)('identifies HTTP %s failures with a safe action for JSON and SSE error envelopes', async (status, type, hint) => {
    const error = await gatewayError(vi.fn(async () => Response.json({ message: 'PRIVATE_KEY PRIVATE_PROVIDER_CANARY' }, { status })));
    const mapped = mapChatGptBackendError(error)!;
    expect(mapped.type).toBe(type);
    expect(mapped.message).toContain('ChatGPT web gateway');
    expect(mapped.message).toContain(hint);
    expect(mapped.message).toContain('Codex in Admin');
    expect(mapErrorPayload(error)).toEqual({ type, message: mapped.message });
    expect(JSON.stringify(mapErrorPayload(error))).not.toMatch(/PRIVATE/);
  });

  it('explains that an offline gateway must be started or deselected', async () => {
    const error = await gatewayError(vi.fn(async () => { throw new Error('PRIVATE_PROVIDER_CANARY'); }));
    expect(mapErrorPayload(error).message).toContain('Start the gateway');
    expect(mapChatGptBackendError(error)?.status).toBe(502);
  });

  it('does not mislabel primary backend failures as web errors', () => {
    expect(mapErrorPayload(new ChatGptBackendError('PRIVATE', 'network_error'))).toEqual({ type: 'api_error', message: 'Upstream request failed.' });
  });
});
