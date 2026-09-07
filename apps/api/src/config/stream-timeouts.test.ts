import { expect, it } from 'vitest';
import { loadEnv } from './env.js';

it('decouples streaming defaults from the short-operation timeout', () => {
  expect(loadEnv({ CHATGPT_REQUEST_TIMEOUT_MS: '50' })).toMatchObject({ chatGptRequestTimeoutMs: 50, chatGptResponseHeaderTimeoutMs: 60000, chatGptStreamIdleTimeoutMs: 300000, chatGptStreamTotalTimeoutMs: 0 });
});
it('accepts explicit zero total and positive overrides', () => {
  expect(loadEnv({ CHATGPT_RESPONSE_HEADER_TIMEOUT_MS: '10', CHATGPT_STREAM_IDLE_TIMEOUT_MS: '20', CHATGPT_STREAM_TOTAL_TIMEOUT_MS: '0' })).toMatchObject({ chatGptResponseHeaderTimeoutMs: 10, chatGptStreamIdleTimeoutMs: 20, chatGptStreamTotalTimeoutMs: 0 });
});
for (const name of ['CHATGPT_RESPONSE_HEADER_TIMEOUT_MS', 'CHATGPT_STREAM_IDLE_TIMEOUT_MS', 'CHATGPT_STREAM_TOTAL_TIMEOUT_MS']) {
  it.each(['-1', '1.5', 'NaN', 'Infinity', 'abc', '2147483648', ''])(`rejects invalid ${name}=%s`, value => {
    expect(() => loadEnv({ [name]: value })).toThrow(name);
  });
  if (name !== 'CHATGPT_STREAM_TOTAL_TIMEOUT_MS') it(`rejects zero ${name}`, () => expect(() => loadEnv({ [name]: '0' })).toThrow(name));
}
