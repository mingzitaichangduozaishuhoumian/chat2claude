import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountPool } from './account-pool.js';
import { DurableRuntimeState } from './durable-runtime-state.js';
import { RuntimeApiKeys } from './runtime-api-keys.js';
import { ModelRegistry } from './model-registry.js';
import { RuntimeStateStore, type RuntimeStateFileSystem } from './runtime-state-store.js';
import * as nodeFs from 'node:fs';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('RuntimeStateStore', () => {
  it('treats a missing state file as first boot', () => {
    const path = statePath();
    expect(new RuntimeStateStore({ path }).load()).toBeUndefined();
  });

  it('roundtrips plaintext accounts, secrets, runtime keys and named mappings', () => {
    const path = statePath();
    const source = runtime(path);
    source.accounts.add({ id: 'session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'access-secret', refreshToken: 'refresh-secret' } });
    source.accounts.acquire({ provider: 'mock' });
    const key = source.keys.getOrCreate('primary');
    source.durable.persist();

    const restored = runtime(path);
    expect(restored.durable.hydrate()).toBe(true);
    expect(restored.accounts.get('session')?.secret).toMatchObject({ accessToken: 'access-secret', refreshToken: 'refresh-secret' });
    expect(restored.accounts.get('mock-account')?.currentConcurrency).toBe(0);
    expect(restored.keys.getOrCreate('primary')).toBe(key);
    expect(readFileSync(path, 'utf8')).toContain('"version": 2');
  });

  it('roundtrips an AES-256-GCM envelope without plaintext secrets', () => {
    const path = statePath();
    const encryptionKey = Buffer.alloc(32, 7);
    const source = runtime(path, encryptionKey);
    source.accounts.add({ id: 'session', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'never-plaintext' } });
    source.keys.getOrCreate('primary');
    source.durable.persist();

    const serialized = readFileSync(path, 'utf8');
    expect(serialized).toContain('"encryption": "aes-256-gcm"');
    expect(serialized).not.toContain('never-plaintext');
    const restored = runtime(path, encryptionKey);
    restored.durable.hydrate();
    expect(restored.accounts.get('session')?.secret?.accessToken).toBe('never-plaintext');
  });

  it('migrates version 1 state without alias configuration to version 2', () => {
    const path = statePath();
    writeFileSync(path, JSON.stringify({ version: 1, accounts: [], runtimeApiKeys: { keys: ['legacy-key'], namedKeys: {} } }));
    const migrated = new RuntimeStateStore({ path }).load();
    expect(migrated).toMatchObject({ version: 2, runtimeApiKeys: { records: [expect.objectContaining({ key: 'legacy-key' })] }, modelAliases: [] });
  });

  it('migrates legacy reasoning and speed aliases while preserving future values', () => {
    const path = statePath();
    writeFileSync(path, JSON.stringify({
      version: 2,
      accounts: [],
      runtimeApiKeys: { records: [] },
      modelAliases: [{
        id: 'legacy',
        type: 'model',
        display_name: 'Legacy',
        builtIn: false,
        enabled: true,
        capabilities: {
          reasoning_effort: ['off', 'light', 'extra-high', 'future-deep'],
          response_speed: ['balanced', 'fastest', 'future-tier'],
          thinking: true,
        },
        defaults: { reasoning_effort: 'extra-high', speed: 'fast' },
      }],
    }));

    const migrated = new RuntimeStateStore({ path }).load()!;
    expect(migrated.modelAliases[0].defaults).toEqual({ reasoning_effort: 'xhigh', speed: 'priority' });
    expect(migrated.modelAliases[0].capabilities.reasoning_effort).toEqual(['none', 'low', 'xhigh', 'future-deep']);
    expect(migrated.modelAliases[0].capabilities.response_speed).toEqual(['standard', 'priority', 'future-tier']);
  });

  it('honors a valid persisted empty account pool instead of recreating defaults', () => {
    const path = statePath();
    new RuntimeStateStore({ path }).save({ version: 1, accounts: [], runtimeApiKeys: { keys: [], namedKeys: {} } });
    const restored = runtime(path);
    restored.durable.hydrate();
    expect(restored.accounts.list()).toEqual([]);
  });

  it.each([
    ['unknown fields', { version: 1, accounts: [], runtimeApiKeys: { keys: [], namedKeys: {} }, extra: true }],
    ['version mismatch', { version: 2, accounts: [], runtimeApiKeys: { keys: [], namedKeys: {} } }],
    ['malformed schema', { version: 1, accounts: 'no', runtimeApiKeys: { keys: [], namedKeys: {} } }],
  ])('fails closed for %s', (_label, document) => {
    const path = statePath();
    writeFileSync(path, JSON.stringify(document));
    expect(() => new RuntimeStateStore({ path }).load()).toThrow(/runtime state|version/i);
  });

  it('fails closed for corrupt JSON and encryption mismatches without exposing file contents', () => {
    const corruptPath = statePath();
    writeFileSync(corruptPath, '{"secret":"do-not-repeat"');
    expect(() => new RuntimeStateStore({ path: corruptPath }).load()).toThrow('invalid JSON');
    try { new RuntimeStateStore({ path: corruptPath }).load(); } catch (error) { expect(String(error)).not.toContain('do-not-repeat'); }

    const encryptedPath = statePath();
    new RuntimeStateStore({ path: encryptedPath, encryptionKey: Buffer.alloc(32, 1) }).save({ version: 1, accounts: [], runtimeApiKeys: { keys: [], namedKeys: {} } });
    expect(() => new RuntimeStateStore({ path: encryptedPath, encryptionKey: Buffer.alloc(32, 2) }).load()).toThrow(/key or encrypted data does not match/i);
    expect(() => new RuntimeStateStore({ path: encryptedPath }).load()).toThrow(/STATE_ENCRYPTION_KEY/);
  });

  it('uses restrictive modes where supported and cleans temporary files after atomic failure', () => {
    const path = statePath();
    const store = new RuntimeStateStore({ path });
    store.save({ version: 1, accounts: [], runtimeApiKeys: { keys: [], namedKeys: {} } });
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    }

    const failingFs: RuntimeStateFileSystem = {
      readFileSync: nodeFs.readFileSync,
      mkdirSync: nodeFs.mkdirSync,
      chmodSync: nodeFs.chmodSync,
      openSync: nodeFs.openSync,
      writeSync: nodeFs.writeSync,
      fsyncSync: nodeFs.fsyncSync,
      closeSync: nodeFs.closeSync,
      renameSync() { const error = new Error('injected rename failure') as NodeJS.ErrnoException; error.code = 'EIO'; throw error; },
      unlinkSync: nodeFs.unlinkSync,
    };
    expect(() => new RuntimeStateStore({ path, fs: failingFs }).save({ version: 1, accounts: [], runtimeApiKeys: { keys: [], namedKeys: {} } })).toThrow(/atomically \(EIO\)/);
    expect(readdirSync(dirname(path)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('keeps memory aligned with the renamed file when directory fsync fails', () => {
    const path = statePath();
    const accounts = new AccountPool();
    const keys = new RuntimeApiKeys();
    const modelRegistry = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
    accounts.add({ id: 'existing', provider: 'mock' });
    new DurableRuntimeState({ accountPool: accounts, runtimeApiKeys: keys, modelRegistry, store: new RuntimeStateStore({ path }) }).persist();

    let renamed = false;
    const failingFs: RuntimeStateFileSystem = {
      readFileSync: nodeFs.readFileSync,
      mkdirSync: nodeFs.mkdirSync,
      chmodSync: nodeFs.chmodSync,
      openSync: nodeFs.openSync,
      writeSync: nodeFs.writeSync,
      fsyncSync(fd) {
        if (renamed) {
          const error = new Error('injected directory fsync failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        nodeFs.fsyncSync(fd);
      },
      closeSync: nodeFs.closeSync,
      renameSync(oldPath, newPath) {
        nodeFs.renameSync(oldPath, newPath);
        renamed = true;
      },
      unlinkSync: nodeFs.unlinkSync,
    };
    const durable = new DurableRuntimeState({ accountPool: accounts, runtimeApiKeys: keys, modelRegistry, store: new RuntimeStateStore({ path, fs: failingFs }) });

    expect(durable.transaction(() => {
      accounts.add({ id: 'persisted', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'persisted-access-secret' } });
      keys.add('persisted-runtime-key');
      return modelRegistry.update('sonnet', { backendModel: 'persisted-backend-model' });
    })).toMatchObject({ id: 'sonnet', backendModel: 'persisted-backend-model' });
    expect(accounts.get('persisted')?.secret?.accessToken).toBe('persisted-access-secret');
    expect(keys.has('persisted-runtime-key')).toBe(true);
    expect(modelRegistry.get('sonnet')?.backendModel).toBe('persisted-backend-model');

    const restoredAccounts = new AccountPool();
    const restoredKeys = new RuntimeApiKeys();
    const restoredModels = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
    expect(new DurableRuntimeState({ accountPool: restoredAccounts, runtimeApiKeys: restoredKeys, modelRegistry: restoredModels, store: new RuntimeStateStore({ path }) }).hydrate()).toBe(true);
    expect(restoredAccounts.get('persisted')?.secret?.accessToken).toBe('persisted-access-secret');
    expect(restoredKeys.has('persisted-runtime-key')).toBe(true);
    expect(restoredModels.get('sonnet')?.backendModel).toBe('persisted-backend-model');
  });
});

function statePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'chat2claude-state-'));
  directories.push(directory);
  return join(directory, 'runtime-state.json');
}

function runtime(path: string, encryptionKey?: Uint8Array) {
  const accounts = new AccountPool();
  const keys = new RuntimeApiKeys();
  const store = new RuntimeStateStore({ path, encryptionKey });
  return { accounts, keys, store, durable: new DurableRuntimeState({ accountPool: accounts, runtimeApiKeys: keys, store }) };
}
