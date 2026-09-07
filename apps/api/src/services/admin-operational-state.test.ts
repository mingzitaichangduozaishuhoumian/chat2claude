import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminOperationalState, type OperationalStateFileSystem } from './admin-operational-state.js';

const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('AdminOperationalState', () => {
  it('roundtrips unknown/error reset credits and independent authoritative credit expiry', async () => {
    const path = statePath();
    const state = new AdminOperationalState({ path });
    const base = { status: 'fresh' as const, fetchedAt: '2026-09-04T00:00:00.000Z', expiresAt: '2026-09-04T00:05:00.000Z' };
    const credits = { availableCount: 2, credits: [{ status: 'available' as const, grantedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' }] };
    for (const [id, resetCredits] of [['known', credits], ['error', { error: 'fetch_failed' as const }], ['unknown', {}]] as const) {
      state.setQuotaCache({ accountId: id, createdAt: base.fetchedAt }, { ...base, quota: { windows: [], resetCredits } });
    }
    await state.dispose();
    const restored = new AdminOperationalState({ path });
    expect(restored.hydrate()).toBe(true);
    expect(restored.snapshot().accounts.map((item) => item.quotaCache.quota?.resetCredits)).toEqual([credits, { error: 'fetch_failed' }, {}]);
    expect(readFileSync(path, 'utf8')).not.toMatch(/redeem|request_id|stack/);
    await restored.dispose();
  });

  it('roundtrips safe aggregated account state and resets inFlight on hydration', async () => {
    const path = statePath();
    const identity = { accountId: 'account-1', createdAt: '2026-09-04T00:00:00.000Z' };
    const source = new AdminOperationalState({ path, debounceMs: 10 });
    source.recordRequestStarted(identity);
    source.recordRequestFinished(identity, { success: true, inputTokens: 12, outputTokens: 5, at: '2026-09-04T00:01:00.000Z' });
    source.recordRequestStarted(identity);
    source.setHealthCheck(identity, { checkedAt: '2026-09-04T00:02:00.000Z', result: 'healthy', message: null });
    source.setDiscoveredModels(identity, [
      {
        id: 'model-b',
        displayName: 'Model B',
        controls: {
          reasoning: { metadataKnown: true, supported: [{ effort: 'low', description: 'Low' }], defaultEffort: 'low' },
          serviceTier: { metadataKnown: true, supported: [{ id: 'priority', name: 'Priority' }], defaultTier: 'priority', fastMode: true },
        },
        raw: { accessToken: 'must-not-persist' },
      },
      { id: 'model-a' },
      { id: 'model-a' },
    ]);
    source.setQuotaCache(identity, {
      status: 'fresh',
      fetchedAt: '2026-09-04T00:03:00.000Z',
      expiresAt: '2026-09-04T00:08:00.000Z',
      quota: {
        allowed: true,
        rateLimitReachedType: 'primary_window',
        windows: [{ position: 'primary', descriptor: 'five-hour', usedPercent: 4, durationSeconds: 18_000, resetAt: '2026-09-05T00:00:00.000Z' }],
        additionalLimits: [],
      },
    });
    await source.flush();

    const serialized = readFileSync(path, 'utf8');
    expect(serialized).toContain('"version": 1');
    expect(serialized).not.toContain('inFlight');
    for (const forbidden of ['"prompt"', '"output"', '"raw"', '"accessToken"', '"cookie"', '"stack"', '"remaining"']) {
      expect(serialized).not.toContain(forbidden);
    }

    const restored = new AdminOperationalState({ path });
    expect(restored.hydrate()).toBe(true);
    expect(restored.snapshot().accounts).toEqual([expect.objectContaining({
      accountId: 'account-1',
      createdAt: identity.createdAt,
      requestStats: expect.objectContaining({ totalRequests: 1, successfulRequests: 1, failedRequests: 0, inputTokens: 12, outputTokens: 5, inFlight: 0 }),
      lastHealthCheck: { checkedAt: '2026-09-04T00:02:00.000Z', result: 'healthy', message: null },
      discoveredModelIds: ['model-a', 'model-b'],
      discoveredModels: [
        { id: 'model-a' },
        {
          id: 'model-b',
          displayName: 'Model B',
          controls: {
            reasoning: { metadataKnown: true, supported: [{ effort: 'low', description: 'Low' }], defaultEffort: 'low' },
            serviceTier: { metadataKnown: true, supported: [{ id: 'priority', name: 'Priority' }], defaultTier: 'priority', fastMode: true },
          },
        },
      ],
      quotaCache: expect.objectContaining({ status: 'fresh', quota: expect.objectContaining({ rateLimitReachedType: 'primary_window', windows: [expect.objectContaining({ descriptor: 'five-hour', usedPercent: 4 })] }) }),
    })]);
    await restored.dispose();
  });

  it('debounces persistence and flushes pending changes on dispose', async () => {
    vi.useFakeTimers();
    const path = statePath();
    const identity = { accountId: 'account-1', createdAt: '2026-09-04T00:00:00.000Z' };
    const state = new AdminOperationalState({ path, debounceMs: 1_000 });
    state.recordRequestStarted(identity);
    expect(existsSync(path)).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(existsSync(path)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(existsSync(path)).toBe(true);

    const secondPath = statePath();
    const pending = new AdminOperationalState({ path: secondPath, debounceMs: 1_000 });
    pending.setDiscoveredModelIds(identity, ['model-a']);
    expect(existsSync(secondPath)).toBe(false);
    await pending.dispose();
    expect(existsSync(secondPath)).toBe(true);
    await state.dispose();
  });

  it('remains writable after a debounced write was committed but directory fsync confirmation failed', async () => {
    vi.useFakeTimers();
    const path = statePath();
    const identity = { accountId: 'account-1', createdAt: '2026-09-04T00:00:00.000Z' };
    const state = new AdminOperationalState({ path, debounceMs: 10, fs: failFirstDirectoryFsyncFs() });

    state.setDiscoveredModelIds(identity, ['model-a']);
    await vi.advanceTimersByTimeAsync(10);
    expect(() => state.setDiscoveredModelIds(identity, ['model-a', 'model-b'])).not.toThrow();
    await vi.advanceTimersByTimeAsync(10);
    expect(() => state.flushSync()).not.toThrow();

    const restored = new AdminOperationalState({ path });
    expect(restored.hydrate()).toBe(true);
    expect(restored.snapshot().accounts[0].discoveredModelIds).toEqual(['model-a', 'model-b']);
    await state.dispose();
    await restored.dispose();
  });

  it('rehydrates legacy id-only catalogs with unknown capabilities', () => {
    const path = statePath();
    writeFileSync(path, JSON.stringify({
      version: 1,
      accounts: [{
        accountId: 'account-1', createdAt: '2026-09-04T00:00:00.000Z',
        requestStats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0, lastRequestAt: null },
        lastHealthCheck: null, discoveredModelIds: ['legacy-model'], quotaCache: { status: 'empty', fetchedAt: null, expiresAt: null, snapshots: [] },
      }],
    }));

    const state = new AdminOperationalState({ path });
    expect(state.hydrate()).toBe(true);
    expect(state.snapshot().accounts[0]).toMatchObject({
      discoveredModelIds: ['legacy-model'],
      discoveredModels: [{ id: 'legacy-model' }],
    });
  });

  it('fails safely for corrupt or invalid files without exposing their contents', () => {
    const path = statePath();
    writeFileSync(path, '{"accessToken":"do-not-repeat"');
    const corrupt = new AdminOperationalState({ path });
    expect(() => corrupt.hydrate()).toThrow(/invalid JSON/i);
    try { corrupt.hydrate(); } catch (error) { expect(String(error)).not.toContain('do-not-repeat'); }

    writeFileSync(path, JSON.stringify({ version: 1, accounts: [], extra: true }));
    expect(() => new AdminOperationalState({ path }).hydrate()).toThrow(/unknown fields/i);

    writeFileSync(path, JSON.stringify({
      version: 1,
      accounts: [{
        accountId: 'account-1', createdAt: '2026-09-04T00:00:00.000Z',
        requestStats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0, lastRequestAt: null, inFlight: 99 },
        lastHealthCheck: null, discoveredModelIds: [], quotaCache: { status: 'empty', fetchedAt: null, expiresAt: null, snapshots: [] },
      }],
    }));
    expect(() => new AdminOperationalState({ path }).hydrate()).toThrow(/unknown fields/i);
  });

  it('cleans orphaned records by internal account id and createdAt identity', async () => {
    const path = statePath();
    const state = new AdminOperationalState({ path, debounceMs: 10 });
    state.setDiscoveredModelIds({ accountId: 'keep', createdAt: '2026-09-04T00:00:00.000Z' }, ['model-a']);
    state.setDiscoveredModelIds({ accountId: 'recreated', createdAt: '2026-09-03T00:00:00.000Z' }, ['stale-model']);
    state.setDiscoveredModelIds({ accountId: 'deleted', createdAt: '2026-09-02T00:00:00.000Z' }, ['orphan-model']);

    expect(state.cleanupOrphans([
      { accountId: 'keep', createdAt: '2026-09-04T00:00:00.000Z' },
      { accountId: 'recreated', createdAt: '2026-09-04T00:00:00.000Z' },
    ])).toBe(2);
    expect(state.snapshot().accounts).toEqual([expect.objectContaining({ accountId: 'keep' })]);
    await state.flush();
  });
});

function statePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'chat2claude-operational-state-'));
  directories.push(directory);
  return join(directory, 'admin-operational-state.json');
}

function failFirstDirectoryFsyncFs(): OperationalStateFileSystem {
  let renamed = false;
  let failurePending = true;
  return {
    readFileSync: nodeFs.readFileSync,
    mkdirSync: nodeFs.mkdirSync,
    chmodSync: nodeFs.chmodSync,
    openSync: nodeFs.openSync,
    writeSync: nodeFs.writeSync,
    fsyncSync(fd) {
      if (renamed && failurePending) {
        failurePending = false;
        throw ioError();
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
}

function ioError(): NodeJS.ErrnoException {
  const error = new Error('injected persistence failure') as NodeJS.ErrnoException;
  error.code = 'EIO';
  return error;
}
