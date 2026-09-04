import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

describe('loadEnv', () => {
  it('defaults host to localhost only, permits local bootstrap, and uses the API data directory', () => {
    const env = loadEnv({});
    expect(env).toMatchObject({ host: '127.0.0.1', allowAnonymousBootstrap: true, localContainerBootstrap: false });
    expect(env.runtimeStatePath.replaceAll('\\', '/')).toMatch(/\/apps\/api\/data\/runtime-state\.json$/);
    expect(env.operationalStatePath.replaceAll('\\', '/')).toMatch(/\/apps\/api\/data\/admin-operational-state\.json$/);
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

  it('uses DATA_DIR for the runtime state path', () => {
    const env = loadEnv({ DATA_DIR: './custom-data' });
    expect(env.runtimeStatePath).toBe(resolve(env.dataDir, 'runtime-state.json'));
    expect(env.operationalStatePath).toBe(resolve(env.dataDir, 'admin-operational-state.json'));
  });

  it('strictly validates STATE_ENCRYPTION_KEY without including its value in errors', () => {
    const secret = 'not-a-valid-key-secret';
    expect(() => loadEnv({ STATE_ENCRYPTION_KEY: secret })).toThrow('base64-encoded 32-byte key');
    try { loadEnv({ STATE_ENCRYPTION_KEY: secret }); } catch (error) { expect(String(error)).not.toContain(secret); }
    expect(loadEnv({ STATE_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64') }).stateEncryptionKey).toHaveLength(32);
  });
});
