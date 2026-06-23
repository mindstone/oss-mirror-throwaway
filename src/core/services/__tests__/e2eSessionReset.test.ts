/**
 * Stage 3 (260612 recs-round5): desktop E2E factory-reset poisoning tests.
 *
 * `e2e:clear-all-sessions` deletes with 'user-delete' intent (tombstoning),
 * so it MUST clear the hard-delete ledger afterwards — on the success path
 * AND on the mid-loop partial-failure early-return path — or reseeding a
 * previously-used fixture id is silently dropped and the whole E2E run is
 * poisoned (the exact cross-run flake the reset exists to prevent).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AgentSession } from '@shared/types';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

let testDir = '';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-default',
    title: 'Test Session',
    createdAt: 1_000,
    updatedAt: 2_000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

function ledgerPath(): string {
  return path.join(testDir, 'sessions', 'session-delete-ledger.json');
}

async function createStore() {
  const { IncrementalSessionStore } = await import('../incrementalSessionStore');
  return new IncrementalSessionStore();
}

async function importHelper() {
  const { clearAllSessionsForE2eReset } = await import('../e2eSessionReset');
  return clearAllSessionsForE2eReset;
}

beforeEach(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-session-reset-'));
  vi.resetModules();
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => stubLogger,
    logger: stubLogger,
  }));
  await initTestPlatformConfig({ userDataPath: testDir });
  Object.values(stubLogger).forEach((fn) => fn.mockClear());
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('clearAllSessionsForE2eReset (desktop e2e:clear-all-sessions)', () => {
  it('clears all sessions, clears the ledger, and a previously-deleted fixture id is reseedable (no poisoning)', async () => {
    const store = await createStore();
    const clearAll = await importHelper();
    const fixtureId = 'e2e-fixture-conversation';

    await store.upsertSession(makeSession({ id: fixtureId }));
    await store.upsertSession(makeSession({ id: 'other-session' }));

    const result = await clearAll(store);
    expect(result.success).toBe(true);
    expect(result.deletedCount).toBe(2);
    expect(fs.existsSync(ledgerPath())).toBe(false);

    // Reseed the SAME id — without the ledger clear this write is silently
    // dropped (the poisoned-E2E shape).
    await store.upsertSession(makeSession({ id: fixtureId, title: 'reseeded' }));
    expect(await store.sessionFileExists(fixtureId)).toBe(true);
    expect(store.listSessions({ includeInternal: true }).map((s) => s.id)).toContain(fixtureId);
  });

  it('PARTIAL-FAILURE path: the early return still clears the ledger (no leftover partial tombstones)', async () => {
    const store = await createStore();
    const clearAll = await importHelper();

    await store.upsertSession(makeSession({ id: 'aaa-first' }));
    await store.upsertSession(makeSession({ id: 'bbb-fails' }));
    await store.upsertSession(makeSession({ id: 'ccc-never-reached' }));

    // Wrap the real store: the SECOND delete throws mid-loop.
    const failingStore = {
      listSessions: store.listSessions.bind(store),
      clearHardDeleteLedgerForTestReset: store.clearHardDeleteLedgerForTestReset.bind(store),
      deleteSession: async (id: string, options: { intent: 'user-delete' | 'hygiene' }) => {
        if (id === 'bbb-fails') {
          throw new Error('simulated mid-loop delete failure');
        }
        return store.deleteSession(id, options);
      },
    };

    const result = await clearAll(failingStore);
    expect(result.success).toBe(false);
    expect(result.deletedCount).toBe(1);

    // The first id WAS tombstoned mid-loop — the finally-clear must have
    // removed it so a reseed is not dropped.
    expect(fs.existsSync(ledgerPath())).toBe(false);
    await store.upsertSession(makeSession({ id: 'aaa-first', title: 'reseeded after partial failure' }));
    expect(await store.sessionFileExists('aaa-first')).toBe(true);
  });

  it('clearHardDeleteLedgerForTestReset refuses to run outside test contexts (env guard)', async () => {
    const store = await createStore();
    const savedVitest = process.env.VITEST;
    const savedE2e = process.env.REBEL_E2E_TEST_MODE;
    delete process.env.VITEST;
    delete process.env.REBEL_E2E_TEST_MODE;
    try {
      expect(() => store.clearHardDeleteLedgerForTestReset()).toThrow(/test-reset-only/);
    } finally {
      if (savedVitest !== undefined) process.env.VITEST = savedVitest;
      if (savedE2e !== undefined) process.env.REBEL_E2E_TEST_MODE = savedE2e;
    }
  });
});
