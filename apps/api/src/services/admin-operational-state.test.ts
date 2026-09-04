import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminOperationalState } from './admin-operational-state.js';

const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('AdminOperationalState', () => {
  it('roundtrips safe aggregated account state and resets inFlight on hydration', async () => {
    const path = statePath();
    const identity = { accountId: 'account-1', createdAt: '2026-09-04T00:00:00.000Z' };
    const source = new AdminOperationalState({ path, debounceMs: 10 });
    source.recordRequestStarted(identity);
    source.recordRequestFinished(identity, { success: true, inputTokens: 12, outputTokens: 5, at: '2026-09-04T00:01:00.000Z' });
    source.recordRequestStarted(identity);
    source.setHealthCheck(identity, { checkedAt: '2026-09-04T00:02:00.000Z', result: 'healthy', message: null });
    source.setDiscoveredModelIds(identity, ['model-b', 'model-a', 'model-a']);
    source.setQuotaCache(identity, {
      status: 'fresh',
      fetchedAt: '2026-09-04T00:03:00.000Z',
      expiresAt: '2026-09-04T00:08:00.000Z',
      snapshots: [{ id: 'primary', used: 4, limit: 100, remaining: 96, resetAt: '2026-09-05T00:00:00.000Z' }],
    });
    await source.flush();

    const serialized = readFileSync(path, 'utf8');
    expect(serialized).toContain('"version": 1');
    expect(serialized).not.toContain('inFlight');
    for (const forbidden of ['"prompt"', '"output"', '"raw"', '"accessToken"', '"cookie"', '"stack"']) {
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
      quotaCache: expect.objectContaining({ status: 'fresh', snapshots: [expect.objectContaining({ id: 'primary', remaining: 96 })] }),
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
