/**
 * Stage 3 (260612 recs-round5): normal-path hard-delete tombstone — the disk
 * write-guard ledger (B-Slim core of docs/plans/260612_recs-round5/PLAN.md § Stage 3).
 *
 * Invariant under test (rev-2, ruling 1): once an id is hard-deleted with
 * delete intent, it cannot be recreated on disk by stale writes — cross-process
 * and across restarts, full stop.
 *
 * RED-FIRST evidence (required by the implementation packet): the two tests
 * marked RED-FIRST below were written and confirmed FAILING against current dev
 * (the session file gets rewritten today) before any store change landed.
 *
 * Adapted from the mined deferred commit 20911f6da (preserve branch
 * preserve/260605-session-resurrection-store), ported onto the post-Stage-2
 * store (4-way validator, writeIndexFileAtomic, mass-loss breaker).
 *
 * @see docs/plans/260605_session-resurrection-mainside/DEFERRAL.md §3/§6
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

function sessionsDirPath(): string {
  return path.join(testDir, 'sessions');
}

/** Ledger placement (rev-2, ruling 7): INSIDE sessions/ so .rebeltransfer carries it. */
function ledgerPath(): string {
  return path.join(sessionsDirPath(), 'session-delete-ledger.json');
}

function readLedger(): { hardDeletedSessions?: Record<string, { deletedAt?: number }> } {
  return JSON.parse(fs.readFileSync(ledgerPath(), 'utf8')) as {
    hardDeletedSessions?: Record<string, { deletedAt?: number }>;
  };
}

async function createStore() {
  const { IncrementalSessionStore } = await import('../incrementalSessionStore');
  return new IncrementalSessionStore();
}

/** Simulate a process restart against the SAME on-disk state. */
async function bootFreshStore() {
  vi.resetModules();
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => stubLogger,
    logger: stubLogger,
  }));
  await initTestPlatformConfig({ userDataPath: testDir });
  return createStore();
}

beforeEach(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-delete-tombstones-'));
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

describe('hard-delete tombstones — core resurrection (RED-FIRST)', () => {
  it('RED-FIRST: keeps a hard-deleted session deleted when a stale upsert arrives afterward (in-process AND across restart)', async () => {
    const sessionId = 'session-hard-deleted';
    const capturedSession = makeSession({ id: sessionId, title: 'Captured before delete' });
    const store = await createStore();

    await store.upsertSession(capturedSession);
    expect(await store.sessionFileExists(sessionId)).toBe(true);

    await store.deleteSession(sessionId, { intent: 'user-delete' });
    expect(await store.sessionFileExists(sessionId)).toBe(false);

    // The durable ledger records the hard delete (inside sessions/).
    const ledger = readLedger();
    expect(typeof ledger.hardDeletedSessions?.[sessionId]?.deletedAt).toBe('number');

    // Stale in-process upsert (e.g. debounced renderer save) must be DROPPED.
    await store.upsertSession(capturedSession);
    expect(await store.sessionFileExists(sessionId)).toBe(false);
    expect(
      store.listSessions({ includeInternal: true }).map((session) => session.id),
    ).not.toContain(sessionId);

    // Across restart: a fresh process must still drop the stale write.
    fs.rmSync(path.join(testDir, 'sessions-deleted'), { recursive: true, force: true });
    const freshStore = await bootFreshStore();
    await freshStore.upsertSession(capturedSession);
    expect(freshStore.loadSync().map((session) => session.id)).not.toContain(sessionId);
    expect(
      freshStore.listSessions({ includeInternal: true }).map((session) => session.id),
    ).not.toContain(sessionId);
    expect(await freshStore.sessionFileExists(sessionId)).toBe(false);
  });

  it('RED-FIRST: cross-process staleness — a reload-upsert from a process with a STALE in-memory ledger re-reads the ledger in-lock and drops the write (full upsertSessionsSyncWithReload path)', async () => {
    const sessionId = 'session-cross-process-stale';
    const session = makeSession({ id: sessionId, title: 'Cross-process stale write' });

    // Process A creates the session.
    const storeA = await createStore();
    await storeA.upsertSession(session);

    // Process B boots and loads its (currently empty) ledger view.
    const storeB = await createStore();
    storeB.loadSync();

    // Process A hard-deletes — durable ledger updated on disk.
    await storeA.deleteSession(sessionId, { intent: 'user-delete' });
    expect(await storeA.sessionFileExists(sessionId)).toBe(false);

    // Process B (stale in-memory tombstone view) performs the cross-process
    // reload-upsert. The ledger re-read at the TOP of the reload path — inside
    // the same lock window as the index re-read — must catch the tombstone
    // BEFORE the input filter runs, and drop the write.
    const outcome = storeB.upsertSessionsSyncWithReload([session]);

    expect(outcome.outcome).toBe('all-dropped-tombstoned');
    expect(await storeB.sessionFileExists(sessionId)).toBe(false);
    const indexContent = JSON.parse(
      fs.readFileSync(path.join(sessionsDirPath(), 'index.json'), 'utf8'),
    ) as { sessions: Array<{ id: string }> };
    expect(indexContent.sessions.map((entry) => entry.id)).not.toContain(sessionId);
  });

  it('mixed batch: persisted outcome carries per-session dropped ids so hooks fire only for persisted sessions', async () => {
    const tombstonedId = 'session-mixed-tombstoned';
    const liveId = 'session-mixed-live';
    const store = await createStore();

    await store.upsertSession(makeSession({ id: tombstonedId }));
    await store.deleteSession(tombstonedId, { intent: 'user-delete' });

    const outcome = store.upsertSessionsSyncWithReload([
      makeSession({ id: tombstonedId, title: 'stale' }),
      makeSession({ id: liveId, title: 'fresh' }),
    ]);

    expect(outcome.outcome).toBe('persisted');
    if (outcome.outcome !== 'persisted') throw new Error('unreachable');
    expect(outcome.persistedSessionIds).toEqual([liveId]);
    expect(outcome.droppedTombstonedSessionIds).toEqual([tombstonedId]);
    expect(await store.sessionFileExists(liveId)).toBe(true);
    expect(await store.sessionFileExists(tombstonedId)).toBe(false);
  });
});

describe('orphan/rebuild/migration resurrection vectors', () => {
  it('does not recover a tombstoned orphan session file during index rebuild', async () => {
    const sessionId = 'session-tombstoned-orphan';
    const session = makeSession({ id: sessionId, title: 'Should not recover' });
    const store = await createStore();

    await store.upsertSession(session);
    await store.deleteSession(sessionId, { intent: 'user-delete' });

    const deletedDir = path.join(testDir, 'sessions-deleted');
    const deletedFile = fs.readdirSync(deletedDir).find((file) => file.startsWith(`${sessionId}_`));
    if (!deletedFile) {
      throw new Error(`Expected deleted session backup for ${sessionId}`);
    }

    // Re-plant the file as an active stray and force a rebuild (no index).
    const livePath = path.join(sessionsDirPath(), `${sessionId}.json`);
    fs.copyFileSync(path.join(deletedDir, deletedFile), livePath);
    fs.rmSync(path.join(sessionsDirPath(), 'index.json'), { force: true });

    const freshStore = await bootFreshStore();
    expect(freshStore.loadSync().map((loaded) => loaded.id)).not.toContain(sessionId);
    expect(
      freshStore.listSessions({ includeInternal: true }).map((summary) => summary.id),
    ).not.toContain(sessionId);
    expect(await freshStore.sessionFileExists(sessionId)).toBe(false);
  });

  // BUG B regression (read chokepoint, kill-by-construction): a stray active
  // sessions/<id>.json for a hard-deleted id — e.g. recreated by a migration
  // source before a later orphan pass quarantines it — must be un-readable via
  // getSession()/loadSessionFile(). If the chokepoint guard is removed,
  // getSession() returns the stray session.
  it('does not read a tombstoned session via getSession when a stray active file exists', async () => {
    const sessionId = 'session-stray-tombstoned';
    const session = makeSession({ id: sessionId, title: 'Stray after delete' });
    const store = await createStore();

    await store.upsertSession(session);
    await store.deleteSession(sessionId, { intent: 'user-delete' });
    expect(await store.sessionFileExists(sessionId)).toBe(false);

    fs.mkdirSync(sessionsDirPath(), { recursive: true });
    fs.writeFileSync(path.join(sessionsDirPath(), `${sessionId}.json`), JSON.stringify(session), 'utf8');

    // The read chokepoint must hide it AND quarantine the stray file.
    expect(await store.getSession(sessionId)).toBeNull();
    expect(fs.existsSync(path.join(sessionsDirPath(), `${sessionId}.json`))).toBe(false);
  });

  it('does not resurrect a hard-deleted session via agent-sessions migration', async () => {
    const sessionId = 'session-migration-tombstoned';
    const session = makeSession({ id: sessionId, title: 'Should stay deleted' });
    const store = await createStore();

    await store.upsertSession(session);
    await store.deleteSession(sessionId, { intent: 'user-delete' });

    // Plant a stale copy in the agent-sessions/ migration source dir.
    const agentSessionsDir = path.join(testDir, 'agent-sessions');
    fs.mkdirSync(agentSessionsDir, { recursive: true });
    fs.writeFileSync(path.join(agentSessionsDir, `${sessionId}.json`), JSON.stringify(session), 'utf8');

    const freshStore = await bootFreshStore();
    const loaded = await freshStore.load();

    expect(loaded.map((s) => s.id)).not.toContain(sessionId);
    expect(await freshStore.getSession(sessionId)).toBeNull();
    expect(await freshStore.sessionFileExists(sessionId)).toBe(false);
  });
});

describe('what is NEVER tombstoned', () => {
  // BUG A regression (DEFERRAL §3 #1): a LIVE session that was evicted
  // (over-cap) into sessions-deleted/ must NOT become tombstoned — eviction is
  // recoverable; only doDeleteSession with 'user-delete' intent defines a
  // hard-delete. The ledger is the SOLE source of truth (never seeded from a
  // sessions-deleted/ dir scan).
  it('does not tombstone a session that was merely evicted into sessions-deleted/', async () => {
    const sessionId = 'session-evicted-live';
    const evicted = makeSession({ id: sessionId, title: 'Evicted but live' });
    const store = await createStore();

    await store.upsertSession(evicted);
    const deletedDir = path.join(testDir, 'sessions-deleted');
    fs.mkdirSync(deletedDir, { recursive: true });
    const livePath = path.join(sessionsDirPath(), `${sessionId}.json`);
    fs.copyFileSync(livePath, path.join(deletedDir, `${sessionId}_${Date.now()}.json`));
    fs.rmSync(livePath, { force: true });
    fs.rmSync(path.join(sessionsDirPath(), 'index.json'), { force: true });

    // No ledger should exist (eviction never hard-deletes).
    expect(fs.existsSync(ledgerPath())).toBe(false);

    const freshStore = await bootFreshStore();
    await freshStore.upsertSession(evicted);

    expect(await freshStore.sessionFileExists(sessionId)).toBe(true);
    expect(freshStore.listSessions({ includeInternal: true }).map((s) => s.id)).toContain(sessionId);
    expect((await freshStore.getSession(sessionId))?.id).toBe(sessionId);
  });

  // Explicit negative (packet requirement): soft-delete/Trash NEVER tombstones.
  it('soft-delete (Trash via deletedAt) never writes the ledger and stays restorable', async () => {
    const sessionId = 'session-soft-deleted';
    const softDeleted = makeSession({ id: sessionId, title: 'In trash', deletedAt: 10_000 });
    const restored = makeSession({ id: sessionId, title: 'Restored', deletedAt: null, updatedAt: 11_000 });
    const store = await createStore();

    await store.upsertSession(softDeleted);
    // Trashing is just a field write — no deleteSession call, no ledger.
    expect(fs.existsSync(ledgerPath())).toBe(false);

    await store.upsertSession(restored);
    expect(await store.sessionFileExists(sessionId)).toBe(true);
    const loaded = await store.getSession(sessionId);
    expect(loaded?.title).toBe('Restored');
    expect(loaded?.deletedAt ?? null).toBeNull();
    expect(fs.existsSync(ledgerPath())).toBe(false);
  });

  it("hygiene deletes never tombstone: the id is resurrectable by a later legitimate write (cleanupLeakedSessions' self-healing contract)", async () => {
    const sessionId = 'session-hygiene-deleted';
    const session = makeSession({ id: sessionId, title: 'Hygiene-pruned' });
    const store = await createStore();

    await store.upsertSession(session);
    await store.deleteSession(sessionId, { intent: 'hygiene' });
    expect(await store.sessionFileExists(sessionId)).toBe(false);
    // No ledger entry for hygiene deletes.
    if (fs.existsSync(ledgerPath())) {
      expect(Object.keys(readLedger().hardDeletedSessions ?? {})).not.toContain(sessionId);
    }

    // A later legitimate write (e.g. cloud re-sync) re-creates it.
    await store.upsertSession(session);
    expect(await store.sessionFileExists(sessionId)).toBe(true);
  });
});

describe('ledger failure posture (fail-open, no degraded mode)', () => {
  it('ledger write failure: the delete still succeeds, loudly (log.error + counter)', async () => {
    const sessionId = 'session-ledger-write-fails';
    const store = await createStore();
    await store.upsertSession(makeSession({ id: sessionId }));

    // Make the ledger path unwritable by occupying it with a DIRECTORY.
    fs.mkdirSync(ledgerPath(), { recursive: true });

    await expect(store.deleteSession(sessionId, { intent: 'user-delete' })).resolves.toBeUndefined();
    // Delete took effect on disk.
    expect(await store.sessionFileExists(sessionId)).toBe(false);
    expect(store.listSessions({ includeInternal: true }).map((s) => s.id)).not.toContain(sessionId);

    // Loud: structured error log with the failure counter.
    const errCall = stubLogger.error.mock.calls.find(
      ([, msg]) => typeof msg === 'string' && msg.includes('Failed to persist hard-delete ledger entry'),
    );
    expect(errCall).toBeDefined();
    expect((errCall?.[0] as { ledgerWriteFailures: number }).ledgerWriteFailures).toBeGreaterThanOrEqual(1);

    // In-memory protection still holds for this process (UNION semantics).
    await store.upsertSession(makeSession({ id: sessionId }));
    expect(await store.sessionFileExists(sessionId)).toBe(false);
  });

  it('UNION not replace: a reload-upsert ledger re-read does not drop in-memory-only tombstones from a failed persist', async () => {
    const sessionId = 'session-union-in-memory';
    const store = await createStore();
    await store.upsertSession(makeSession({ id: sessionId }));

    fs.mkdirSync(ledgerPath(), { recursive: true }); // force ledger persist failure
    await store.deleteSession(sessionId, { intent: 'user-delete' });
    fs.rmSync(ledgerPath(), { recursive: true, force: true }); // disk ledger now ABSENT

    // The forced re-read at the top of the reload path sees an empty disk
    // ledger — it must UNION (keep the in-memory tombstone), not replace.
    const outcome = store.upsertSessionsSyncWithReload([makeSession({ id: sessionId })]);
    expect(outcome.outcome).toBe('all-dropped-tombstoned');
    expect(await store.sessionFileExists(sessionId)).toBe(false);
  });

  it('corrupt ledger: fail-open to today\'s behavior (writes proceed) with a loud log.error — and the next successful delete self-heals the file', async () => {
    const sessionId = 'session-corrupt-ledger';
    fs.mkdirSync(sessionsDirPath(), { recursive: true });
    fs.writeFileSync(ledgerPath(), '{not json', 'utf8');

    const store = await createStore();
    await store.upsertSession(makeSession({ id: sessionId }));
    // Fail-open: the write landed.
    expect(await store.sessionFileExists(sessionId)).toBe(true);
    const errCall = stubLogger.error.mock.calls.find(
      ([, msg]) => typeof msg === 'string' && msg.includes('ledger is corrupt'),
    );
    expect(errCall).toBeDefined();

    // A new user-delete rewrites a valid ledger (self-heal).
    await store.deleteSession(sessionId, { intent: 'user-delete' });
    expect(typeof readLedger().hardDeletedSessions?.[sessionId]?.deletedAt).toBe('number');
  });

  it('transient ledger read error is NOT cached: protection resumes on the next consult (RS F9)', async () => {
    const sessionId = 'session-transient-read';
    // Seed a valid on-disk ledger tombstoning the id.
    fs.mkdirSync(sessionsDirPath(), { recursive: true });
    fs.writeFileSync(
      ledgerPath(),
      JSON.stringify({ version: 1, hardDeletedSessions: { [sessionId]: { deletedAt: 123 } } }),
      'utf8',
    );

    const store = await createStore();

    // First consult: a real transient EACCES read failure (mode 000).
    fs.chmodSync(ledgerPath(), 0o000);
    try {
      // Fail-open on the transient error: the stale write goes through.
      await store.upsertSession(makeSession({ id: sessionId }));
      expect(await store.sessionFileExists(sessionId)).toBe(true);
      const errCall = stubLogger.error.mock.calls.find(
        ([, msg]) => typeof msg === 'string' && msg.includes('transient'),
      );
      expect(errCall).toBeDefined();
    } finally {
      fs.chmodSync(ledgerPath(), 0o644);
    }

    // Next consult retries the disk read and protection resumes: the read
    // chokepoint hides the id and quarantines the stray file written above.
    expect(await store.getSession(sessionId)).toBeNull();
    expect(fs.existsSync(path.join(sessionsDirPath(), `${sessionId}.json`))).toBe(false);
  });
});

describe('updateSession truth contract (consumer pin tests)', () => {
  // Consumer shape 1 — automationScheduler.persistAutomationSessionSnapshot /
  // cloudAutomationScheduler (merge-into-existing mutator): the mined code
  // returned `true` for a dropped write; consumers faithfully believe it.
  it('returns false when the target id is tombstoned (merge-shape mutator) and writes nothing', async () => {
    const sessionId = 'session-update-merge';
    const store = await createStore();
    await store.upsertSession(makeSession({ id: sessionId }));
    await store.deleteSession(sessionId, { intent: 'user-delete' });

    const result = await store.updateSession(sessionId, (existing) => ({
      ...(existing ?? makeSession({ id: sessionId })),
      title: 'merged snapshot',
    }));

    expect(result).toBe(false);
    expect(await store.sessionFileExists(sessionId)).toBe(false);
  });

  // Consumer shape 2 — seedAutomationSessionFinishLine (creates a shell when
  // the session does not exist yet): getSession returns null through the read
  // chokepoint, the mutator creates a shell, and doUpsertSession must drop it.
  it('returns false when the mutator creates a shell for a tombstoned id', async () => {
    const sessionId = 'session-update-shell';
    const store = await createStore();
    await store.upsertSession(makeSession({ id: sessionId }));
    await store.deleteSession(sessionId, { intent: 'user-delete' });

    const result = await store.updateSession(sessionId, (existing) =>
      existing ?? makeSession({ id: sessionId, title: 'shell' }),
    );

    expect(result).toBe(false);
    expect(await store.sessionFileExists(sessionId)).toBe(false);
  });

  // Consumer shape 3 — agentEventDispatcher auto-title (mutator aborts on a
  // missing session): the read chokepoint nulls the session, the mutator
  // returns null, and the result is false — so `titlePersisted` correctly
  // suppresses the renderer notify.
  it('returns false when the mutator aborts on a tombstoned (null) session — the auto-title shape', async () => {
    const sessionId = 'session-update-title';
    const store = await createStore();
    await store.upsertSession(makeSession({ id: sessionId }));
    await store.deleteSession(sessionId, { intent: 'user-delete' });

    const mutator = vi.fn((existing: AgentSession | null) => {
      if (!existing) return null;
      return { ...existing, title: 'auto title' };
    });
    const result = await store.updateSession(sessionId, mutator);

    expect(mutator).toHaveBeenCalledWith(null);
    expect(result).toBe(false);
    expect(await store.sessionFileExists(sessionId)).toBe(false);
  });
});

describe('breaker interaction (RS F14) and test reset', () => {
  it('>bound tombstoned index rows on load trip the breaker: read-only, disk untouched, ids still hidden', async () => {
    const store = await createStore();
    const total = 30; // bound = max(25, ceil(30*0.01)) = 25; 30 > 25 → trip
    const sessions = Array.from({ length: total }, (_, i) => makeSession({ id: `bulk-${i}` }));
    for (const session of sessions) {
      await store.upsertSession(session);
    }

    // Forge an on-disk ledger tombstoning ALL of them (anomalous disk state —
    // e.g. a recovered .bak index full of deleted rows).
    fs.writeFileSync(
      ledgerPath(),
      JSON.stringify({
        version: 1,
        hardDeletedSessions: Object.fromEntries(sessions.map((s) => [s.id, { deletedAt: 1 }])),
      }),
      'utf8',
    );
    const indexBefore = fs.readFileSync(path.join(sessionsDirPath(), 'index.json'), 'utf8');

    const freshStore = await bootFreshStore();
    const loaded = freshStore.loadSync();

    // Visibility: tombstoned ids never load.
    expect(loaded.map((s) => s.id)).toEqual([]);
    // Breaker: read-only, on-disk index + files untouched (no quarantine).
    expect(freshStore.isReadOnly()).toBe(true);
    expect(fs.readFileSync(path.join(sessionsDirPath(), 'index.json'), 'utf8')).toBe(indexBefore);
    for (const session of sessions) {
      expect(fs.existsSync(path.join(sessionsDirPath(), `${session.id}.json`))).toBe(true);
    }
  });

  it('under-bound tombstoned rows on load are pruned + quarantined without a trip', async () => {
    const store = await createStore();
    const keepIds = Array.from({ length: 28 }, (_, i) => `keep-${i}`);
    for (const id of keepIds) {
      await store.upsertSession(makeSession({ id }));
    }
    const tombstonedId = 'prune-me';
    await store.upsertSession(makeSession({ id: tombstonedId }));

    fs.writeFileSync(
      ledgerPath(),
      JSON.stringify({ version: 1, hardDeletedSessions: { [tombstonedId]: { deletedAt: 1 } } }),
      'utf8',
    );

    const freshStore = await bootFreshStore();
    const loaded = freshStore.loadSync();

    expect(loaded.map((s) => s.id)).not.toContain(tombstonedId);
    expect(loaded).toHaveLength(keepIds.length);
    expect(freshStore.isReadOnly()).toBe(false);
    // Stray file quarantined out of sessions/.
    expect(fs.existsSync(path.join(sessionsDirPath(), `${tombstonedId}.json`))).toBe(false);
    // Index rewritten without the tombstoned row.
    const indexIds = (
      JSON.parse(fs.readFileSync(path.join(sessionsDirPath(), 'index.json'), 'utf8')) as {
        sessions: Array<{ id: string }>;
      }
    ).sessions.map((entry) => entry.id);
    expect(indexIds).not.toContain(tombstonedId);
  });

  it('clearHardDeleteLedgerForTestReset(): clears file + in-memory set so the id is reseedable (factory-reset semantics)', async () => {
    const sessionId = 'session-reset-reseed';
    const store = await createStore();
    await store.upsertSession(makeSession({ id: sessionId }));
    await store.deleteSession(sessionId, { intent: 'user-delete' });
    expect(fs.existsSync(ledgerPath())).toBe(true);

    store.clearHardDeleteLedgerForTestReset();

    expect(fs.existsSync(ledgerPath())).toBe(false);
    await store.upsertSession(makeSession({ id: sessionId, title: 'reseeded' }));
    expect(await store.sessionFileExists(sessionId)).toBe(true);
  });
});

describe('fix round (review round 2): F1 — refreshSessionIndexSummaries is ledger-gated', () => {
  function writeRawIndex(entries: Array<Record<string, unknown>>): void {
    fs.mkdirSync(sessionsDirPath(), { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDirPath(), 'index.json'),
      // Must match the CURRENT INDEX_VERSION so the raw-parse refresh path is
      // exercised (a backward version would route to rebuild-from-files instead,
      // bypassing the ledger-gating logic under test). Bump when INDEX_VERSION bumps.
      JSON.stringify({ version: 9, lastUpdated: 1_000, sessions: entries }),
      'utf8',
    );
  }

  function rawIndexEntry(session: AgentSession): Record<string, unknown> {
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      resolvedAt: null,
      doneAt: null,
      starredAt: null,
      deletedAt: null,
      origin: 'manual',
      isCorrupted: false,
      preview: '',
      messageCount: 0,
      hasDraft: false,
      draftPreview: null,
      draftUpdatedAt: null,
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
      userMessageCount: 0,
      activeTurnId: null,
      isBusy: false,
      lastActivityAt: null,
      lastError: null,
      fingerprint: `${session.updatedAt}:test`,
    };
  }

  // RED-FIRST (review F1): when this.index is null, refreshSessionIndexSummaries
  // raw-parses index.json and (before this fix) rewrote it through
  // writeIndexFileAtomic with NO ledger gating — a tombstoned row survived the
  // refresh write.
  it('RED-FIRST: a tombstoned index row cannot survive a refresh write (raw-parse path, this.index null)', async () => {
    const tombstonedId = 'refresh-tombstoned';
    const liveId = 'refresh-live';
    const liveSession = makeSession({ id: liveId, title: 'live, refreshed' });

    // Disk state: index carries BOTH rows; ledger tombstones one of them.
    writeRawIndex([rawIndexEntry(makeSession({ id: tombstonedId })), rawIndexEntry(liveSession)]);
    fs.writeFileSync(
      ledgerPath(),
      JSON.stringify({ version: 1, hardDeletedSessions: { [tombstonedId]: { deletedAt: 1 } } }),
      'utf8',
    );

    // Fresh store, NO listSessions()/load() first — the raw-parse refresh path.
    const store = await createStore();
    const refreshed = await store.refreshSessionIndexSummaries([liveSession]);

    expect(refreshed).toBe(1);
    const writtenIds = (
      JSON.parse(fs.readFileSync(path.join(sessionsDirPath(), 'index.json'), 'utf8')) as {
        sessions: Array<{ id: string }>;
      }
    ).sessions.map((entry) => entry.id);
    expect(writtenIds).toContain(liveId);
    expect(writtenIds).not.toContain(tombstonedId);
    // And the in-memory view is delete-wins too.
    expect(store.listSessions({ includeInternal: true }).map((s) => s.id)).not.toContain(tombstonedId);
  });

  it('refreshing a tombstoned id itself is a no-op (the entriesById gate is structurally add-proof after the prune)', async () => {
    const tombstonedId = 'refresh-tombstoned-input';
    const tombstonedSession = makeSession({ id: tombstonedId, title: 'stale refresh payload' });

    writeRawIndex([rawIndexEntry(tombstonedSession)]);
    fs.writeFileSync(
      ledgerPath(),
      JSON.stringify({ version: 1, hardDeletedSessions: { [tombstonedId]: { deletedAt: 1 } } }),
      'utf8',
    );

    const store = await createStore();
    const refreshed = await store.refreshSessionIndexSummaries([tombstonedSession]);

    expect(refreshed).toBe(0);
    expect(store.listSessions({ includeInternal: true }).map((s) => s.id)).not.toContain(tombstonedId);
  });
});

describe('fix round (review round 2): F2 — tombstoned-orphan quarantine is breaker-guarded', () => {
  /**
   * Disk fixture: a VALID current-version index with `liveCount` live sessions
   * (files present) plus `tombstonedOrphanCount` tombstoned ORPHAN files (on
   * disk, NOT in the index) whose ids are all in the ledger.
   */
  async function seedOrphanFixture(liveCount: number, tombstonedOrphanCount: number) {
    const store = await createStore();
    const liveIds: string[] = [];
    for (let i = 0; i < liveCount; i++) {
      const id = `live-${i}`;
      liveIds.push(id);
      await store.upsertSession(makeSession({ id }));
    }
    const orphanIds: string[] = [];
    const ledgerEntries: Record<string, { deletedAt: number }> = {};
    for (let i = 0; i < tombstonedOrphanCount; i++) {
      const id = `tombstoned-orphan-${i}`;
      orphanIds.push(id);
      ledgerEntries[id] = { deletedAt: 1 };
      fs.writeFileSync(
        path.join(sessionsDirPath(), `${id}.json`),
        JSON.stringify(makeSession({ id })),
        'utf8',
      );
    }
    fs.writeFileSync(
      ledgerPath(),
      JSON.stringify({ version: 1, hardDeletedSessions: ledgerEntries }),
      'utf8',
    );
    return { liveIds, orphanIds };
  }

  function orphanFilesStillPresent(orphanIds: string[]): boolean {
    return orphanIds.every((id) => fs.existsSync(path.join(sessionsDirPath(), `${id}.json`)));
  }

  // RED-FIRST (review F2): before this fix the orphan branch quarantined
  // per-file with no aggregate guard — an over-bound mass quarantine
  // proceeded silently (DEFERRAL §3's orphan-recovery shape).
  it('RED-FIRST (sync): over-bound tombstoned-orphan quarantine trips the breaker — read-only, files untouched, ids still hidden', async () => {
    // 30 tombstoned orphans of a 32-file corpus: bound = max(25, ceil(0.32)) = 25 → trip.
    const { liveIds, orphanIds } = await seedOrphanFixture(2, 30);
    const indexBefore = fs.readFileSync(path.join(sessionsDirPath(), 'index.json'), 'utf8');

    const freshStore = await bootFreshStore();
    const loaded = freshStore.loadSync();

    expect(loaded.map((s) => s.id).sort()).toEqual([...liveIds].sort()); // tombstoned never load
    expect(freshStore.isReadOnly()).toBe(true);
    expect(orphanFilesStillPresent(orphanIds)).toBe(true); // NO quarantine on trip
    expect(fs.readFileSync(path.join(sessionsDirPath(), 'index.json'), 'utf8')).toBe(indexBefore);
  });

  it('RED-FIRST (async): over-bound tombstoned-orphan quarantine trips the breaker — read-only, files untouched, ids still hidden', async () => {
    const { liveIds, orphanIds } = await seedOrphanFixture(2, 30);
    const indexBefore = fs.readFileSync(path.join(sessionsDirPath(), 'index.json'), 'utf8');

    const freshStore = await bootFreshStore();
    const loaded = await freshStore.load();

    expect(loaded.map((s) => s.id).sort()).toEqual([...liveIds].sort());
    expect(freshStore.isReadOnly()).toBe(true);
    expect(orphanFilesStillPresent(orphanIds)).toBe(true);
    expect(fs.readFileSync(path.join(sessionsDirPath(), 'index.json'), 'utf8')).toBe(indexBefore);
  });

  it('under-bound (sync): tombstoned orphan is quarantined, live orphan recovered, no trip', async () => {
    const { orphanIds } = await seedOrphanFixture(2, 1);
    // Plus one LIVE orphan (not in index, not tombstoned) — must still recover.
    fs.writeFileSync(
      path.join(sessionsDirPath(), 'live-orphan.json'),
      JSON.stringify(makeSession({ id: 'live-orphan' })),
      'utf8',
    );

    const freshStore = await bootFreshStore();
    const loaded = freshStore.loadSync();

    expect(freshStore.isReadOnly()).toBe(false);
    expect(loaded.map((s) => s.id)).toContain('live-orphan');
    expect(loaded.map((s) => s.id)).not.toContain(orphanIds[0]);
    expect(fs.existsSync(path.join(sessionsDirPath(), `${orphanIds[0]}.json`))).toBe(false); // quarantined
    const writtenIds = (
      JSON.parse(fs.readFileSync(path.join(sessionsDirPath(), 'index.json'), 'utf8')) as {
        sessions: Array<{ id: string }>;
      }
    ).sessions.map((entry) => entry.id);
    expect(writtenIds).toContain('live-orphan');
    expect(writtenIds).not.toContain(orphanIds[0]);
  });

  it('under-bound (async): tombstoned orphan is quarantined, live orphan recovered, no trip', async () => {
    const { orphanIds } = await seedOrphanFixture(2, 1);
    fs.writeFileSync(
      path.join(sessionsDirPath(), 'live-orphan.json'),
      JSON.stringify(makeSession({ id: 'live-orphan' })),
      'utf8',
    );

    const freshStore = await bootFreshStore();
    const loaded = await freshStore.load();

    expect(freshStore.isReadOnly()).toBe(false);
    expect(loaded.map((s) => s.id)).toContain('live-orphan');
    expect(loaded.map((s) => s.id)).not.toContain(orphanIds[0]);
    expect(fs.existsSync(path.join(sessionsDirPath(), `${orphanIds[0]}.json`))).toBe(false);
  });
});

describe('partial-migration ledger carry (RS F18) — extends the Stage 2 F12 fixture', () => {
  function writeLegacyFile(sessions: AgentSession[]): void {
    fs.writeFileSync(
      path.join(testDir, 'agent-session-history.json'),
      JSON.stringify({ version: 1, sessions }),
      'utf8',
    );
  }

  it('the partial-migration retry RE-PLACES session-delete-ledger.json into the fresh sessions/ (not just the backup) and tombstones still hold', async () => {
    const tombstonedId = 'legacy-tombstoned';
    fs.mkdirSync(sessionsDirPath(), { recursive: true });
    const ledgerPayload = JSON.stringify({
      version: 1,
      hardDeletedSessions: { [tombstonedId]: { deletedAt: 123 } },
    });
    fs.writeFileSync(ledgerPath(), ledgerPayload, 'utf8');
    // Partial-migration state: sessions/ exists (no session files), legacy present —
    // and the legacy source still contains the tombstoned session.
    writeLegacyFile([makeSession({ id: 'legacy-live' }), makeSession({ id: tombstonedId })]);

    const store = await createStore();
    const sessions = await store.load();

    // Ledger re-placed into the fresh sessions/ AND present in the backup.
    expect(fs.readFileSync(ledgerPath(), 'utf8')).toBe(ledgerPayload);
    const backupDirs = fs
      .readdirSync(testDir)
      .filter((name) => /^sessions\.partial-migration-\d+$/.test(name));
    expect(backupDirs).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(testDir, backupDirs[0], 'session-delete-ledger.json'), 'utf8'),
    ).toBe(ledgerPayload);

    // The migration write-skip honored the carried ledger: no resurrection.
    expect(sessions.map((s) => s.id)).toContain('legacy-live');
    expect(sessions.map((s) => s.id)).not.toContain(tombstonedId);
    expect(fs.existsSync(path.join(sessionsDirPath(), `${tombstonedId}.json`))).toBe(false);
  });
});
