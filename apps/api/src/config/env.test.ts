import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';
import { DEFAULT_CODEX_CLIENT_VERSION } from '@chatgpt-to-claude/chatgpt-backend';

describe('loadEnv', () => {
  it('uses direct outbound traffic by default and accepts HTTP/HTTPS proxies', () => {
    expect(loadEnv({}).outboundProxyUrl).toBeUndefined();
    expect(loadEnv({ OUTBOUND_PROXY_URL: ' ' }).outboundProxyUrl).toBeUndefined();
    expect(loadEnv({ OUTBOUND_PROXY_URL: 'http://127.0.0.1:7890' }).outboundProxyUrl).toBe('http://127.0.0.1:7890/');
    expect(loadEnv({ OUTBOUND_PROXY_URL: 'https://user:password@proxy.test:7892' }).outboundProxyUrl).toBe('https://user:password@proxy.test:7892/');
  });

  it.each(['socks5://canary:secret@localhost:7890', 'ftp://canary.test', 'canary', 'http://', 'http://proxy.test/path', 'http://proxy.test?canary', 'http://proxy.test#canary', 'http://canary:%ZZ@proxy.test', 'http://proxy.\ntest'])('rejects invalid proxy configuration safely (case %#)', (value) => {
    expect(() => loadEnv({ OUTBOUND_PROXY_URL: value })).toThrow('OUTBOUND_PROXY_URL must be an HTTP or HTTPS proxy URL without a path, query, or fragment.');
    try { loadEnv({ OUTBOUND_PROXY_URL: value }); } catch (error) {
      expect(String(error)).not.toContain('canary');
      expect(error).not.toHaveProperty('cause');
    }
  });

  it('defaults access logs to text and acquisition timeout to 30 seconds', () => {
    expect(loadEnv({})).toMatchObject({ accessLogFormat: 'text', accountAcquireTimeoutMs: 30_000 });
    expect(loadEnv({ ACCESS_LOG_FORMAT: 'json', ACCOUNT_ACQUIRE_TIMEOUT_MS: '0' })).toMatchObject({ accessLogFormat: 'json', accountAcquireTimeoutMs: 0 });
    expect(loadEnv({ ACCESS_LOG_FORMAT: 'detailed' }).accessLogFormat).toBe('detailed');
    expect(loadEnv({ ACCESS_LOG_FORMAT: 'simple' }).accessLogFormat).toBe('text');
    expect(loadEnv({ ACCOUNT_ACQUIRE_TIMEOUT_MS: '1200' }).accountAcquireTimeoutMs).toBe(1200);
  });

  it.each(['-1', '1.5', 'NaN', 'Infinity', '2147483648', 'secret-value'])('rejects invalid acquisition timeout safely (%s)', (value) => {
    expect(() => loadEnv({ ACCOUNT_ACQUIRE_TIMEOUT_MS: value })).toThrow('ACCOUNT_ACQUIRE_TIMEOUT_MS must be an integer between 0 and 2147483647 ms.');
  });

  it('rejects unsupported access log formats without echoing them', () => {
    expect(() => loadEnv({ ACCESS_LOG_FORMAT: 'secret-value' })).toThrow('ACCESS_LOG_FORMAT must be text, detailed, or json.');
  });

  it('uses the centralized Codex protocol version and accepts an explicit override', () => {
    expect(loadEnv({}).codexClientVersion).toBe(DEFAULT_CODEX_CLIENT_VERSION);
    expect(loadEnv({ CODEX_CLIENT_VERSION: '2.3.4' }).codexClientVersion).toBe('2.3.4');
    expect(loadEnv({ CODEX_CLIENT_VERSION: '2.3.4-alpha.2+build.7' }).codexClientVersion).toBe('2.3.4-alpha.2+build.7');
  });

  it.each(['', ' ', ' 1.2.3', '1.2.3 ', 'v1.2.3', '1.2', '01.2.3', '1.02.3', '1.2.03', '1.2.3-01', '1.2.3-', '1.2.3+','1.2.3\n', '1.2.3\r\nsecret-header: secret', 'secret-value', `1.2.3+${'a'.repeat(129)}`])('rejects an invalid Codex client version safely (%j)', (value) => {
    expect(() => loadEnv({ CODEX_CLIENT_VERSION: value })).toThrow('CODEX_CLIENT_VERSION must be a valid SemVer version');
    try { loadEnv({ CODEX_CLIENT_VERSION: value }); } catch (error) {
      expect(String(error)).not.toContain('secret-value');
      expect(String(error)).not.toContain('secret-header');
    }
  });

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
