import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

describe('loadEnv', () => {
  it('defaults host to localhost only and permits local bootstrap', () => {
    expect(loadEnv({})).toMatchObject({ host: '127.0.0.1', allowAnonymousBootstrap: true, localContainerBootstrap: false });
  });

  it('fails closed for a non-loopback host without API keys', () => {
    expect(() => loadEnv({ HOST: '0.0.0.0' })).toThrow('Refusing non-loopback startup without API_KEYS');
  });

  it('allows a non-loopback host with a configured API key without anonymous bootstrap', () => {
    expect(loadEnv({ HOST: '0.0.0.0', API_KEYS: 'secret' })).toMatchObject({ host: '0.0.0.0', apiKeys: ['secret'], allowAnonymousBootstrap: false });
  });

  it('allows the explicit local-container override', () => {
    expect(loadEnv({ HOST: '0.0.0.0', LOCAL_CONTAINER_BOOTSTRAP: 'true' })).toMatchObject({ host: '0.0.0.0', apiKeys: [], allowAnonymousBootstrap: true, localContainerBootstrap: true });
  });
});
