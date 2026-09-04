import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatGptBackendError, SessionChatGptBackend, type ChatGptBackendClient, type ChatGptBackendRequestContext, type ChatGptDiscoveredModel } from '@chatgpt-to-claude/chatgpt-backend';
import { AccountPool } from './account-pool.js';
import { ModelRegistry } from './model-registry.js';
import { RuntimeApiKeys } from './runtime-api-keys.js';
import { SetupProvisioner } from './setup-provisioner.js';
import { ChatGptAuthFlowService } from './chatgpt-auth-flow.js';
import { DurableRuntimeState } from './durable-runtime-state.js';
import { RuntimeStateStore, RuntimeStateStoreError } from './runtime-state-store.js';
import { AdminOperationalState } from './admin-operational-state.js';

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
    await expect(provisioner.provision({ type: 'chatgpt-session', accessToken: 'candidate-access' })).rejects.toThrow('ChatGPT session verification failed.');
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('healthy-access');
    expect(accountPool.get('chatgpt-primary')?.status).toBe('available');
    expect(runtimeApiKeys.size).toBe(0);
  });

  it('reports sanitized model-discovery diagnostics without exposing session data', async () => {
    const diagnostics: unknown[] = [];
    const backend = backendFrom({ listModels: async () => {
      throw new ChatGptBackendError('upstream body contains access-secret', 'unauthorized', { status: 401 });
    } });
    const { accountPool, modelRegistry, runtimeApiKeys } = setup(backend);
    const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });

    await expect(provisioner.provision({ type: 'chatgpt-session', accessToken: 'access-secret' })).rejects.toMatchObject({
      diagnostic: { stage: 'session_verification', code: 'unauthorized', status: 401, message: 'ChatGPT session verification failed.' },
    });
    expect(JSON.stringify(diagnostics)).not.toContain('access-secret');
    expect(JSON.stringify(diagnostics)).not.toContain('upstream body');
  });

  it('reports model preparation separately from session verification', async () => {
    const backend = backendFrom({ listModels: async () => [{ id: 'gpt-5-codex' }] });
    const { accountPool, modelRegistry, runtimeApiKeys } = setup(backend);
    modelRegistry.prepareProvisioning = () => { throw new Error('invalid local model configuration'); };
    const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend });

    await expect(provisioner.provision({ type: 'chatgpt-session', accessToken: 'candidate-access' })).rejects.toMatchObject({
      diagnostic: { stage: 'model_preparation', message: 'ChatGPT model preparation failed.' },
    });
  });

  it('commits the account, discovery, alias and stable key only after validation succeeds', async () => {
    const backend = backendFrom({ listModels: async (context) => {
      const accessToken = context?.account?.secret?.accessToken;
      expect(['candidate-access', 'candidate-access-2']).toContain(accessToken);
      return accessToken === 'candidate-access-2'
        ? [{ id: 'gpt-5-codex-reauthorized', displayName: 'GPT-5 Codex Reauthorized' }]
        : [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex' }];
    } });
    const { provisioner, accountPool, modelRegistry, runtimeApiKeys } = setup(backend);
    const result = await provisioner.provision({ type: 'chatgpt-session', accessToken: 'candidate-access', refreshToken: 'candidate-refresh' });
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('candidate-access');
    expect(modelRegistry.get('sonnet')).toMatchObject({ backendModel: 'gpt-5-codex', status: 'bound' });
    expect(result.modelsDiscovered).toEqual(['gpt-5-codex']);
    expect(runtimeApiKeys.size).toBe(1);
    const reauthorized = await provisioner.provision({ type: 'chatgpt-session', accessToken: 'candidate-access-2' });
    expect(result.runtimeKeyCreated).toBe(true);
    expect(result.apiKey).toBeDefined();
    expect(reauthorized.runtimeKeyCreated).toBe(false);
    expect(reauthorized.apiKey).toBeUndefined();
    expect(reauthorized.modelsDiscovered).toEqual(['gpt-5-codex-reauthorized']);
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('candidate-access-2');
    expect(modelRegistry.get('gpt-5-codex')).toBeUndefined();
    expect(modelRegistry.get('gpt-5-codex-reauthorized')).toMatchObject({ status: 'passthrough' });
    expect(modelRegistry.get('sonnet')).toMatchObject({ backendModel: 'gpt-5-codex', status: 'stale' });
  });

  it('preserves a manual Sonnet binding across reauthorization and persists it with stable credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat2claude-reauthorize-'));
    try {
      const catalog = [{ id: 'catalog-a' }, { id: 'catalog-b' }];
      const backend = backendFrom({ listModels: async () => catalog });
      const accountPool = new AccountPool();
      const modelRegistry = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
      const runtimeApiKeys = new RuntimeApiKeys();
      const store = new RuntimeStateStore({ path: join(directory, 'runtime-state.json') });
      const durableState = new DurableRuntimeState({ accountPool, runtimeApiKeys, modelRegistry, store });
      const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend, durableState });

      const first = await provisioner.provision({ type: 'chatgpt-session', accessToken: 'first-access' });
      expect(modelRegistry.get('sonnet')?.backendModel).toBe('catalog-a');

      durableState.transaction(() => modelRegistry.update('sonnet', { backendModel: 'catalog-b' }));
      const reauthorized = await provisioner.provision({ type: 'chatgpt-session', accessToken: 'second-access' });

      expect(first.runtimeKeyCreated).toBe(true);
      expect(first.apiKey).toBeDefined();
      expect(reauthorized.runtimeKeyCreated).toBe(false);
      expect(reauthorized.apiKey).toBeUndefined();
      expect(reauthorized.boundAliases).toEqual({});
      expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('second-access');
      expect(modelRegistry.get('sonnet')?.backendModel).toBe('catalog-b');

      const restoredAccounts = new AccountPool();
      const restoredKeys = new RuntimeApiKeys();
      const restoredModels = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
      new DurableRuntimeState({ accountPool: restoredAccounts, runtimeApiKeys: restoredKeys, modelRegistry: restoredModels, store }).hydrate();
      expect(restoredAccounts.get('chatgpt-primary')?.secret?.accessToken).toBe('second-access');
      expect(restoredKeys.has(first.apiKey!)).toBe(true);
      expect(restoredModels.get('sonnet')?.backendModel).toBe('catalog-b');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses model discovery as the sole remote session validation request', async () => {
    let modelRequests = 0;
    const backend = backendFrom({
      healthCheck: async (context) => {
        await backend.listModels(context);
        return { ok: true };
      },
      listModels: async () => {
        modelRequests += 1;
        return [{ id: 'gpt-5-codex' }];
      },
    });
    const { provisioner } = setup(backend);

    await provisioner.provision({ type: 'chatgpt-session', accessToken: 'candidate-access' });

    expect(modelRequests).toBe(1);
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
    const durableState = new DurableRuntimeState({ accountPool, runtimeApiKeys, modelRegistry, store });
    const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend, durableState });

    await expect(provisioner.provision({ type: 'chatgpt-session', accessToken: 'candidate-access' })).rejects.toThrow('ChatGPT setup state commit failed.');
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('healthy-access');
    expect(runtimeApiKeys.size).toBe(0);
    expect(modelRegistry.get('sonnet')?.backendModel).toBeUndefined();
  });

  it('returns the live key after a post-rename durability warning and reports only safe diagnostics', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat2claude-provision-committed-'));
    try {
      const diagnostics: unknown[] = [];
      const backend = backendFrom({ listModels: async () => [{ id: 'gpt-5-codex' }] });
      const accountPool = new AccountPool();
      const modelRegistry = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
      const runtimeApiKeys = new RuntimeApiKeys();
      const store = new RuntimeStateStore({ path: join(directory, 'runtime-state.json') });
      const save = store.save.bind(store);
      store.save = (state) => {
        save(state);
        throw new RuntimeStateStoreError('post-rename failure contains durable-access', true);
      };
      const durableState = new DurableRuntimeState({ accountPool, runtimeApiKeys, modelRegistry, store });
      const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend, durableState, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });

      const result = await provisioner.provision({ type: 'chatgpt-session', accessToken: 'durable-access' });

      expect(result).toMatchObject({ ok: true, apiKey: expect.any(String), modelsDiscovered: ['gpt-5-codex'] });
      expect(runtimeApiKeys.has(result.apiKey!)).toBe(true);
      expect(diagnostics).toEqual([{ stage: 'state_commit', severity: 'warning', code: 'durability_confirmation_failed', message: 'ChatGPT setup was committed, but filesystem durability confirmation failed.' }]);
      expect(JSON.stringify(diagnostics)).not.toContain('durable-access');
      expect(JSON.stringify(diagnostics)).not.toContain('post-rename failure');

      const restoredAccounts = new AccountPool();
      const restoredKeys = new RuntimeApiKeys();
      const restoredModels = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
      new DurableRuntimeState({ accountPool: restoredAccounts, runtimeApiKeys: restoredKeys, modelRegistry: restoredModels, store: new RuntimeStateStore({ path: join(directory, 'runtime-state.json') }) }).hydrate();
      expect(restoredAccounts.get('chatgpt-primary')?.secret?.accessToken).toBe('durable-access');
      expect(restoredKeys.has(result.apiKey!)).toBe(true);
      expect(restoredModels.get('sonnet')?.backendModel).toBe('gpt-5-codex');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('aborts the active model transport and releases the queue for the next provisioning attempt', async () => {
    const firstFetchEntered = deferred<void>();
    let fetchCalls = 0;
    let firstFetchAborted = false;
    const backend = new SessionChatGptBackend({
      baseUrl: 'https://chatgpt.test',
      timeoutMs: 60_000,
      fetch: async (_url, init) => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          firstFetchEntered.resolve();
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return reject(new Error('missing transport signal'));
            const abort = () => {
              firstFetchAborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            };
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        }
        return Response.json({ models: [{ id: 'gpt-5-codex' }] });
      },
    });
    const { provisioner, accountPool } = setup(backend);
    const controller = new AbortController();
    const first = provisioner.provision({ type: 'chatgpt-session', accessToken: 'cancelled-access' }, controller.signal);
    await firstFetchEntered.promise;
    const second = provisioner.provision({ type: 'chatgpt-session', accessToken: 'replacement-access' });

    controller.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toMatchObject({ ok: true, modelsDiscovered: ['gpt-5-codex'] });
    expect(firstFetchAborted).toBe(true);
    expect(fetchCalls).toBe(2);
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('replacement-access');
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
    const pending = flow.provision(started.id, (secret, _target, signal, commitBoundary) => provisioner.provision(secret, signal, commitBoundary));
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
    )).rejects.toThrow('ChatGPT setup state commit failed.');
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('healthy-access');
    expect(modelRegistry.get('sonnet')?.backendModel).toBeUndefined();
    expect(runtimeApiKeys.size).toBe(0);
  });

  it('waits for delayed startup discovery and preserves another account catalog when provisioning', async () => {
    const startupGate = deferred<void>();
    const accountPool = new AccountPool();
    const startupAccount = accountPool.add({ id: 'startup-account', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'startup-access' } });
    const modelRegistry = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
    const runtimeApiKeys = new RuntimeApiKeys();
    let provisioningDiscoveries = 0;
    const startupReady = startupGate.promise.then(() => {
      modelRegistry.replaceAccountModels({ accountId: startupAccount.id, createdAt: startupAccount.createdAt }, [{ id: 'startup-model' }]);
    });
    const backend = backendFrom({ listModels: async () => {
      provisioningDiscoveries += 1;
      return [{ id: 'newer-provisioned-model' }];
    } });
    const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend, startupReady });

    const pending = provisioner.provision({ type: 'chatgpt-session', accessToken: 'candidate-access' });
    await Promise.resolve();
    expect(provisioningDiscoveries).toBe(0);

    startupGate.resolve();
    await expect(pending).resolves.toMatchObject({ modelsDiscovered: ['newer-provisioned-model'] });
    expect(provisioningDiscoveries).toBe(1);
    expect(modelRegistry.get('sonnet')).toMatchObject({ backendModel: 'newer-provisioned-model', status: 'bound' });
    expect(modelRegistry.get('startup-model')).toMatchObject({ status: 'passthrough' });
    expect(modelRegistry.get('newer-provisioned-model')).toMatchObject({ status: 'passthrough' });
  });

  it('continues provisioning after failed startup discovery readiness', async () => {
    const accountPool = new AccountPool();
    const modelRegistry = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
    const runtimeApiKeys = new RuntimeApiKeys();
    const backend = backendFrom({ listModels: async () => [{ id: 'recovered-model' }] });
    const startupReady = Promise.reject(new Error('startup discovery failed'));
    const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend, startupReady });

    await expect(provisioner.provision({ type: 'chatgpt-session', accessToken: 'candidate-access' })).resolves.toMatchObject({ modelsDiscovered: ['recovered-model'] });
    expect(modelRegistry.get('sonnet')).toMatchObject({ backendModel: 'recovered-model', status: 'bound' });
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

    const completed = await flow.provision(started.id, (secret, _target, signal, commitBoundary) => provisioner.provision(secret, signal, commitBoundary));

    expect(completed).toMatchObject({ state: 'ready', provisioned: true });
    expect(accountPool.get('chatgpt-primary')?.secret?.accessToken).toBe('candidate-access');
    expect(modelRegistry.get('sonnet')).toMatchObject({ backendModel: 'gpt-5-codex', status: 'bound' });
    expect(runtimeApiKeys.size).toBe(1);
    expect(commitClockReads).toBe(1);
  });

  it('adds distinct opaque accounts, persists them, schedules both, and discloses the runtime key only once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat2claude-multi-account-'));
    try {
      const backend = backendFrom({ listModels: async () => [{ id: 'catalog-a' }] });
      const accountPool = new AccountPool({ seedMockAccount: false });
      const modelRegistry = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
      const runtimeApiKeys = new RuntimeApiKeys();
      const store = new RuntimeStateStore({ path: join(directory, 'runtime-state.json') });
      const durableState = new DurableRuntimeState({ accountPool, runtimeApiKeys, modelRegistry, store });
      const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend, durableState });

      const first = await provisioner.provisionTarget({ mode: 'add' }, { type: 'chatgpt-session', accessToken: 'access-a', accountId: 'upstream-a' });
      const second = await provisioner.provisionTarget({ mode: 'add' }, { type: 'chatgpt-session', accessToken: 'access-b', accountId: 'upstream-b' });

      expect(first.account.id).not.toBe('chatgpt-primary');
      expect(second.account.id).not.toBe(first.account.id);
      expect(first.account.id).toMatch(/^chatgpt-[A-Za-z0-9_-]{24}$/);
      expect(first).toMatchObject({ runtimeKeyCreated: true, apiKey: expect.stringMatching(/^sk-runtime-/) });
      expect(second).toMatchObject({ runtimeKeyCreated: false });
      expect(second).not.toHaveProperty('apiKey');
      expect(accountPool.acquire({ provider: 'chatgpt-session' })?.id).toBe(first.account.id);
      expect(accountPool.acquire({ provider: 'chatgpt-session' })?.id).toBe(second.account.id);

      const restoredAccounts = new AccountPool({ seedMockAccount: false });
      const restoredKeys = new RuntimeApiKeys();
      const restoredModels = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
      new DurableRuntimeState({ accountPool: restoredAccounts, runtimeApiKeys: restoredKeys, modelRegistry: restoredModels, store }).hydrate();
      expect(restoredAccounts.list().map((account) => account.id)).toEqual([first.account.id, second.account.id]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects repeated explicit additions without authoritative upstream identity and commits no state', async () => {
    const backend = backendFrom({ listModels: async () => [{ id: 'catalog-a' }] });
    const accountPool = new AccountPool({ seedMockAccount: false });
    const modelRegistry = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
    const runtimeApiKeys = new RuntimeApiKeys();
    const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(provisioner.provisionTarget(
        { mode: 'add' },
        { type: 'chatgpt-session', accessToken: 'same-access-token' },
      )).rejects.toMatchObject({
        diagnostic: { stage: 'session_verification', code: 'upstream_identity_required', status: 400 },
      });
    }

    expect(accountPool.exportState().accounts).toEqual([]);
    expect(modelRegistry.get('sonnet')?.backendModel).toBeUndefined();
    expect(runtimeApiKeys.size).toBe(0);
  });

  it('accepts an authoritative identity enriched during explicit add discovery', async () => {
    const backend = backendFrom({ listModels: async (context) => {
      if (context?.account?.secret) context.account.secret.accountId = 'discovered-upstream';
      return [{ id: 'catalog-a' }];
    } });
    const accountPool = new AccountPool({ seedMockAccount: false });
    const provisioner = new SetupProvisioner({
      accountPool,
      modelRegistry: new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] }),
      runtimeApiKeys: new RuntimeApiKeys(),
      backend,
    });

    const result = await provisioner.provisionTarget(
      { mode: 'add' },
      { type: 'chatgpt-session', accessToken: 'access-with-discovered-identity' },
    );

    expect(result.account.upstreamAccountId).toBe('discovered-upstream');
    expect(accountPool.get(result.account.id)?.secret?.accountId).toBe('discovered-upstream');
  });

  it('rejects duplicate add and wrong-identity reauthorization without mutating state', async () => {
    const backend = backendFrom({ listModels: async () => [{ id: 'catalog-a' }] });
    const accountPool = new AccountPool({ seedMockAccount: false });
    const modelRegistry = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
    const runtimeApiKeys = new RuntimeApiKeys();
    const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend });
    const first = await provisioner.provisionTarget({ mode: 'add' }, { type: 'chatgpt-session', accessToken: 'access-a', accountId: 'upstream-a' });
    const before = { accounts: accountPool.exportState(), aliases: modelRegistry.exportState(), keys: runtimeApiKeys.exportState() };

    await expect(provisioner.provisionTarget({ mode: 'add' }, { type: 'chatgpt-session', accessToken: 'duplicate', accountId: 'upstream-a' })).rejects.toMatchObject({
      diagnostic: { stage: 'session_verification', code: 'duplicate_upstream_identity', status: 409 },
    });
    await expect(provisioner.provisionTarget({ mode: 'reauthorize', accountId: first.account.id }, { type: 'chatgpt-session', accessToken: 'wrong-user', accountId: 'upstream-b' })).rejects.toMatchObject({
      diagnostic: { stage: 'session_verification', code: 'reauthorization_identity_mismatch', status: 409 },
    });
    expect(accountPool.exportState()).toEqual(before.accounts);
    expect(modelRegistry.exportState()).toEqual(before.aliases);
    expect(runtimeApiKeys.exportState()).toEqual(before.keys);
  });

  it('rejects identity adoption when another session account already owns the upstream identity', async () => {
    const backend = backendFrom({ listModels: async () => [{ id: 'catalog-a' }] });
    const accountPool = new AccountPool({ seedMockAccount: false });
    const modelRegistry = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
    const runtimeApiKeys = new RuntimeApiKeys();
    const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend });
    await provisioner.provisionTarget({ mode: 'add' }, { type: 'chatgpt-session', accessToken: 'owner-access', accountId: 'upstream-x' });
    const incomplete = accountPool.add({ id: 'legacy-incomplete', provider: 'chatgpt-session', secret: { type: 'chatgpt-session', accessToken: 'old-incomplete' } });
    const before = { accounts: accountPool.exportState(), aliases: modelRegistry.exportState(), keys: runtimeApiKeys.exportState() };

    await expect(provisioner.provisionTarget(
      { mode: 'reauthorize', accountId: incomplete.id },
      { type: 'chatgpt-session', accessToken: 'collision-access', accountId: 'upstream-x' },
    )).rejects.toMatchObject({
      diagnostic: { stage: 'session_verification', code: 'duplicate_upstream_identity', status: 409 },
    });
    expect(accountPool.exportState()).toEqual(before.accounts);
    expect(modelRegistry.exportState()).toEqual(before.aliases);
    expect(runtimeApiKeys.exportState()).toEqual(before.keys);
  });

  it.each(['delete', 'recreate', 'settings'] as const)('rejects reauthorization when the target changes during discovery: %s', async (scenario) => {
    const entered = deferred<void>();
    const discovery = deferred<ChatGptDiscoveredModel[]>();
    const backend = backendFrom({ listModels: async () => { entered.resolve(); return discovery.promise; } });
    const accountPool = new AccountPool({ seedMockAccount: false });
    const modelRegistry = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
    const runtimeApiKeys = new RuntimeApiKeys();
    const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend });
    const target = accountPool.add({ id: 'reauth-target', provider: 'chatgpt-session', label: 'Original', secret: { type: 'chatgpt-session', accessToken: 'old-access', accountId: 'upstream-target' } });
    const beforeAliases = modelRegistry.exportState();
    const beforeKeys = runtimeApiKeys.exportState();

    const attempt = provisioner.provisionTarget(
      { mode: 'reauthorize', accountId: target.id },
      { type: 'chatgpt-session', accessToken: 'new-access', accountId: 'upstream-target' },
    );
    await entered.promise;
    if (scenario === 'delete') accountPool.remove(target.id);
    if (scenario === 'recreate') {
      accountPool.remove(target.id);
      accountPool.add({ id: target.id, provider: 'chatgpt-session', label: 'Recreated', secret: { type: 'chatgpt-session', accessToken: 'recreated-access', accountId: 'upstream-recreated' } });
    }
    if (scenario === 'settings') accountPool.update(target.id, { label: 'Changed during discovery', maxConcurrency: 3 });
    discovery.resolve([{ id: 'catalog-new' }]);

    await expect(attempt).rejects.toMatchObject({ diagnostic: { stage: 'state_commit', code: 'reauthorization_target_changed', status: 409 } });
    expect(modelRegistry.exportState()).toEqual(beforeAliases);
    expect(runtimeApiKeys.exportState()).toEqual(beforeKeys);
    if (scenario === 'delete') expect(accountPool.get(target.id)).toBeUndefined();
    if (scenario === 'recreate') expect(accountPool.get(target.id)).toMatchObject({ label: 'Recreated', secret: { accessToken: 'recreated-access', accountId: 'upstream-recreated' } });
    if (scenario === 'settings') expect(accountPool.get(target.id)).toMatchObject({ label: 'Changed during discovery', maxConcurrency: 3, secret: { accessToken: 'old-access' } });
  });

  it('does not invalidate reauthorization for ordinary in-flight concurrency changes', async () => {
    const entered = deferred<void>();
    const discovery = deferred<ChatGptDiscoveredModel[]>();
    const backend = backendFrom({ listModels: async () => { entered.resolve(); return discovery.promise; } });
    const accountPool = new AccountPool({ seedMockAccount: false });
    const target = accountPool.add({ id: 'reauth-target', provider: 'chatgpt-session', maxConcurrency: 2, secret: { type: 'chatgpt-session', accessToken: 'old-access', accountId: 'upstream-target' } });
    const provisioner = new SetupProvisioner({ accountPool, modelRegistry: new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] }), runtimeApiKeys: new RuntimeApiKeys(), backend });

    const attempt = provisioner.provisionTarget(
      { mode: 'reauthorize', accountId: target.id },
      { type: 'chatgpt-session', accessToken: 'new-access', accountId: 'upstream-target' },
    );
    await entered.promise;
    expect(accountPool.acquire({ provider: 'chatgpt-session' })?.id).toBe(target.id);
    discovery.resolve([{ id: 'catalog-new' }]);

    await expect(attempt).resolves.toMatchObject({ account: { id: target.id, currentConcurrency: 1 }, runtimeKeyCreated: true });
    expect(accountPool.get(target.id)?.secret?.accessToken).toBe('new-access');
    accountPool.release(target.id);
  });

  it('reauthorizes only the target, adopts identity for incomplete accounts, preserves settings and aliases', async () => {
    const backend = backendFrom({ listModels: async () => [{ id: 'catalog-a' }, { id: 'catalog-b' }] });
    const accountPool = new AccountPool({ seedMockAccount: false });
    const modelRegistry = new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] });
    const runtimeApiKeys = new RuntimeApiKeys();
    const provisioner = new SetupProvisioner({ accountPool, modelRegistry, runtimeApiKeys, backend });
    const first = await provisioner.provisionTarget({ mode: 'add' }, { type: 'chatgpt-session', accessToken: 'first', accountId: 'upstream-a' });
    const incomplete = accountPool.add({ id: 'legacy-incomplete', provider: 'chatgpt-session', label: 'Keep me', enabled: false, maxConcurrency: 3, secret: { type: 'chatgpt-session', accessToken: 'old' } });
    modelRegistry.update('sonnet', { backendModel: 'catalog-b' });

    const result = await provisioner.provisionTarget({ mode: 'reauthorize', accountId: incomplete.id }, { type: 'chatgpt-session', accessToken: 'new', accountId: 'upstream-new' });

    expect(result).toMatchObject({ account: { id: incomplete.id, label: 'Keep me', enabled: false, maxConcurrency: 3, upstreamAccountId: 'upstream-new' }, runtimeKeyCreated: false, boundAliases: {} });
    expect(accountPool.get(first.account.id)?.secret?.accessToken).toBe('first');
    expect(accountPool.get(incomplete.id)?.secret?.accessToken).toBe('new');
    expect(modelRegistry.get('sonnet')?.backendModel).toBe('catalog-b');
  });

  it('records operational health and discovered models only after credential commit and treats state failure as a warning', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat2claude-operational-provision-'));
    try {
      const diagnostics: unknown[] = [];
      const operationalState = new AdminOperationalState({ path: join(directory, 'operational.json'), debounceMs: 0 });
      const accountPool = new AccountPool({ seedMockAccount: false });
      const provisioner = new SetupProvisioner({
        accountPool,
        modelRegistry: new ModelRegistry({ defaults: [{ id: 'sonnet', enabled: true }] }),
        runtimeApiKeys: new RuntimeApiKeys(),
        backend: backendFrom({ listModels: async () => [{ id: 'model-b' }, { id: 'model-a' }] }),
        operationalState,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      const result = await provisioner.provisionTarget({ mode: 'add' }, { type: 'chatgpt-session', accessToken: 'access', accountId: 'upstream' });
      expect(operationalState.snapshot().accounts).toEqual([expect.objectContaining({
        accountId: result.account.id,
        createdAt: result.account.createdAt,
        discoveredModelIds: ['model-a', 'model-b'],
        lastHealthCheck: expect.objectContaining({ result: 'healthy', message: null }),
      })]);
      expect(diagnostics).toEqual([]);
      await operationalState.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
