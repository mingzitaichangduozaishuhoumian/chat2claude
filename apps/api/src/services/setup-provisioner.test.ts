import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatGptBackendClient, ChatGptBackendRequestContext } from '@chatgpt-to-claude/chatgpt-backend';
import { AccountPool } from './account-pool.js';
import { ModelRegistry } from './model-registry.js';
import { RuntimeApiKeys } from './runtime-api-keys.js';
import { SetupProvisioner } from './setup-provisioner.js';
import { ChatGptAuthFlowService } from './chatgpt-auth-flow.js';
import { DurableRuntimeState } from './durable-runtime-state.js';
import { RuntimeStateStore } from './runtime-state-store.js';

function setup(backend: ChatGptBackendClient) {
  const accountPool = new AccountPool();
  accountPool.add({ id: 'chatgpt-primary', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'healthy-access', refreshToken: 'healthy-refresh' } });
  const modelRegistry = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
  const runtimeApiKeys = new RuntimeApiKeys();
  return { accountPool, modelRegistry, runtimeApiKeys, provisioner: new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend }) };
}

describe('SetupProvisioner', () => {
  it('validates candidate credentials without overwriting a healthy canonical account on failure', async () => {
    const backend = backendFrom({ listModels: async (context) => {
      expect(context?.account?.secret?.accessToken).toBe('candidate-access');
      throw new Error('candidate rejected');
    } });
    const { provisioner, accountPool, runtimeApiKeys } = setup(backend);
    await expect(provisioner.provision({ type: 'chatgpt-session', accessToken: 'candidate-access' })).rejects.toThrow('candidate rejected');
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('healthy-access');
    expect(accountPool.get('chatgpt-primary')?.status).toBe('available');
    expect(runtimeApiKeys.size).toBe(0);
  });

  it('commits the account, discovery, alias and stable key only after validation succeeds', async () => {
    const backend = backendFrom({ listModels: async (context) => {
      expect(['candidate-access', 'candidate-access-2']).toContain(context?.account?.secret?.accessToken);
      return [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex' }];
    } });
    const { provisioner, accountPool, modelRegistry, runtimeApiKeys } = setup(backend);
    const result = await provisioner.provision({ type: 'chatgpt-session', accessToken: 'candidate-access', refreshToken: 'candidate-refresh' });
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('candidate-access');
    expect(modelRegistry.get('sonnet')).toMatchObject({ backendModel: 'gpt-5-codex', status: 'bound' });
    expect(result.modelsDiscovered).toEqual(['gpt-5-codex']);
    expect(runtimeApiKeys.size).toBe(1);
    const reauthorized = await provisioner.provision({ type: 'chatgpt-session', accessToken: 'candidate-access-2' });
    expect(reauthorized.apiKey).toBe(result.apiKey);
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('candidate-access-2');
  });

  it('atomically persists the provisioned account and named runtime key', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat2claude-provision-'));
    try {
      const backend = backendFrom({ listModels: async () => [{ id: 'gpt-5-codex' }] });
      const accountPool = new AccountPool();
      const modelRegistry = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
      const runtimeApiKeys = new RuntimeApiKeys();
      const store = new RuntimeStateStore({ path: join(directory, 'runtime-state.json') });
      const durableState = new DurableRuntimeState({ accountPool, runtimeApiKeys, store });
      const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend, durableState });

      const result = await provisioner.provision({ type: 'chatgpt-session', accessToken: 'durable-access' });
      const restoredAccounts = new AccountPool();
      const restoredKeys = new RuntimeApiKeys();
      new DurableRuntimeState({ accountPool: restoredAccounts, runtimeApiKeys: restoredKeys, store }).hydrate();
      expect(restoredAccounts.get('chatgpt-primary')?.secret?.accessToken).toBe('durable-access');
      expect(restoredKeys.getOrCreate('chatgpt-primary')).toBe(result.apiKey);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rolls account and key memory back when durable provisioning persistence fails', async () => {
    const backend = backendFrom({ listModels: async () => [{ id: 'gpt-5-codex' }] });
    const { accountPool, modelRegistry, runtimeApiKeys } = setup(backend);
    const store = new RuntimeStateStore({ path: 'unused-runtime-state.json' });
    store.save = () => { throw new Error('injected persist failure'); };
    const durableState = new DurableRuntimeState({ accountPool, runtimeApiKeys, store });
    const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend, durableState });

    await expect(provisioner.provision({ type: 'chatgpt-session', accessToken: 'candidate-access' })).rejects.toThrow('injected persist failure');
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('healthy-access');
    expect(runtimeApiKeys.size).toBe(0);
    expect(modelRegistry.get('sonnet')?.backendModel).toBeUndefined();
  });

  it('does not commit an aborted candidate after asynchronous validation', async () => {
    const models = deferred<Array<{ id: string }>>();
    const backend = backendFrom({ listModels: async () => models.promise });
    const { provisioner, accountPool, runtimeApiKeys } = setup(backend);
    const controller = new AbortController();
    const pending = provisioner.provision({ type: 'chatgpt-session', accessToken: 'candidate-access' }, controller.signal);
    await Promise.resolve();
    controller.abort();
    models.resolve([{ id: 'gpt-5' }]);
    await expect(pending).rejects.toThrow('cancelled');
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('healthy-access');
    expect(runtimeApiKeys.size).toBe(0);
  });

  it('does not commit a candidate when the wall clock crosses the deadline before its timer executes', async () => {
    let now = new Date('2026-08-22T00:00:00.000Z');
    const enteredDiscovery = deferred<void>();
    const models = deferred<Array<{ id: string }>>();
    const backend = backendFrom({ listModels: async () => {
      enteredDiscovery.resolve();
      return models.promise;
    } });
    const { provisioner, accountPool, modelRegistry, runtimeApiKeys } = setup(backend);
    const flow = new ChatGptAuthFlowService({ enableCallbackListener: false, now: () => now, ttlMs: 60_000, fetch: async () => Response.json({ access_token: 'candidate-access' }) });
    const started = await flow.start();
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    await flow.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=code&state=${state}` });
    await flow.status(started.id);
    const pending = flow.provision(started.id, (secret, signal, commitBoundary) => provisioner.provision(secret, signal, commitBoundary));
    await enteredDiscovery.promise;
    now = new Date('2026-08-22T00:01:01.000Z');
    models.resolve([{ id: 'gpt-5-codex' }]);
    await expect(pending).resolves.toMatchObject({ state: 'expired' });
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('healthy-access');
    expect(modelRegistry.get('sonnet')?.backendModel).toBeUndefined();
    expect(runtimeApiKeys.size).toBe(0);
  });

  it('does not leave partial state when the commit boundary rejects validity', async () => {
    const backend = backendFrom({ listModels: async () => [{ id: 'gpt-5-codex' }] });
    const { provisioner, accountPool, modelRegistry, runtimeApiKeys } = setup(backend);
    await expect(provisioner.provision(
      { type: 'chatgpt-session', accessToken: 'candidate-access' },
      undefined,
      () => { throw new Error('operation invalidated'); },
    )).rejects.toThrow('operation invalidated');
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('healthy-access');
    expect(modelRegistry.get('sonnet')?.backendModel).toBeUndefined();
    expect(runtimeApiKeys.size).toBe(0);
  });

  it('samples the deadline once at commit entrance and cannot expire mid synchronous commit', async () => {
    const base = Date.parse('2026-08-22T00:00:00.000Z');
    let commitClockActive = false;
    let commitClockReads = 0;
    const now = () => new Date(commitClockActive ? base + (++commitClockReads * 400) : base);
    const backend = backendFrom({ listModels: async () => {
      commitClockActive = true;
      return [{ id: 'gpt-5-codex' }];
    } });
    const { provisioner, accountPool, modelRegistry, runtimeApiKeys } = setup(backend);
    const flow = new ChatGptAuthFlowService({ enableCallbackListener: false, now, ttlMs: 1_000, fetch: async () => Response.json({ access_token: 'candidate-access' }) });
    const started = await flow.start();
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    await flow.completeCallback({ redirectUrl: `http://localhost:1455/auth/callback?code=code&state=${state}` });
    await flow.status(started.id);

    const completed = await flow.provision(started.id, (secret, signal, commitBoundary) => provisioner.provision(secret, signal, commitBoundary));

    expect(completed).toMatchObject({ state: 'ready', provisioned: true });
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('candidate-access');
    expect(modelRegistry.get('sonnet')).toMatchObject({ backendModel: 'gpt-5-codex', status: 'bound' });
    expect(runtimeApiKeys.size).toBe(1);
    expect(commitClockReads).toBe(1);
  });
});

function backendFrom(overrides: Partial<ChatGptBackendClient>): ChatGptBackendClient {
  return {
    async listModels(_context?: ChatGptBackendRequestContext) { return []; },
    async complete() { return { text: '', finishReason: 'stop' }; },
    async *stream() { yield { type: 'done' as const }; },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
