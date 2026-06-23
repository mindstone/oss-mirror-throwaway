/**
 * Stage 2 (260612 recs-round5): universal session-store safety nets.
 *
 * Covers the Verification-Notes "Stage C2 (red-first)" bullets from
 * docs/plans/260612_recs-round5/PLAN.md:
 *  - mass-loss circuit breaker with per-path policy split (recovery-class trip
 *    vs cleanupLeakedSessions cap-and-continue vs eviction/purge exemptions)
 *  - index.json rolling backup + validated recovery (never clobber a good .bak
 *    with a corrupt primary; corrupt+corrupt → observable read-only abort)
 *  - 4-way index validation (ok | version-forward | version-backward | corrupt)
 *    — version mismatch is NEVER treated as corrupt (round-6 CLI edge)
 *  - migrateFromLegacy rename-to-backup catastrophe guard (no recursive rm)
 *  - Stage-2-owned observability (log.error + Sentry capture + guard counters
 *    on every breaker trip / protective read-only entry; persistent-trip pin)
 *
 * RED-FIRST: the `.bak`-clobber/shrunken-index repro and the migrateFromLegacy
 * fixtures were written and confirmed FAILING against dev before the fix.
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

const sentryCaptureMessage = vi.fn();
const sentryCaptureException = vi.fn();

let testDir: string;

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-default',
    title: 'Test Session',
    createdAt: 1000,
    updatedAt: 2000,
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

function indexPath(): string {
  return path.join(sessionsDirPath(), 'index.json');
}

function indexBackupPath(): string {
  return path.join(sessionsDirPath(), 'index.json.bak');
}

function writeSessionFile(session: AgentSession): void {
  fs.mkdirSync(sessionsDirPath(), { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDirPath(), `${session.id}.json`),
    JSON.stringify(session),
    'utf8',
  );
}

function buildIndexEntry(session: AgentSession): Record<string, unknown> {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    resolvedAt: session.resolvedAt ?? null,
    doneAt: session.doneAt ?? null, // drives eviction eligibility
    starredAt: session.starredAt ?? null,
    deletedAt: session.deletedAt ?? null,
    origin: session.origin ?? 'manual',
    isCorrupted: false,
    privateMode: session.privateMode ?? false,
    interruptedTurnId: null,
    preview: '',
    firstMessagePreview: '',
    messageCount: session.messages.length,
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

function buildIndexJson(version: number, sessions: AgentSession[]): string {
  return JSON.stringify({
    version,
    lastUpdated: 1000,
    sessions: sessions.map(buildIndexEntry),
  });
}

function writeIndexFile(version: number, sessions: AgentSession[]): void {
  fs.mkdirSync(sessionsDirPath(), { recursive: true });
  fs.writeFileSync(indexPath(), buildIndexJson(version, sessions), 'utf8');
}

/** Write an index whose `sessions` rows are taken verbatim (for malformed-row fixtures). */
function writeRawIndexFile(version: number, rows: unknown[]): void {
  fs.mkdirSync(sessionsDirPath(), { recursive: true });
  fs.writeFileSync(
    indexPath(),
    JSON.stringify({ version, lastUpdated: 1000, sessions: rows }),
    'utf8',
  );
}

function readIndexIds(): string[] {
  const parsed = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) as {
    sessions: Array<{ id: string }>;
  };
  return parsed.sessions.map((entry) => entry.id);
}

function findPartialMigrationBackupDirs(): string[] {
  return fs
    .readdirSync(testDir)
    .filter((name) => /^sessions\.partial-migration-\d+$/.test(name));
}

async function importStoreModule() {
  return import('../incrementalSessionStore');
}

async function createStore() {
  const mod = await importStoreModule();
  return { store: new mod.IncrementalSessionStore(), INDEX_VERSION: mod.INDEX_VERSION, mod };
}

/**
 * Simulate a process restart against the SAME on-disk state: reset the module
 * registry (clears the module-level read-only flag + counters), re-wire the
 * platform config + spy reporter, and hand back a fresh store instance.
 */
async function bootFreshStore() {
  vi.resetModules();
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => stubLogger,
    logger: stubLogger,
  }));
  await initTestPlatformConfig({ userDataPath: testDir });
  const { setErrorReporter } = await import('@core/errorReporter');
  setErrorReporter({
    captureException: sentryCaptureException,
    captureMessage: sentryCaptureMessage,
    addBreadcrumb: () => {},
  });
  return createStore();
}

function expectProtectiveReadOnlySentryCapture(reason: string): void {
  const capture = sentryCaptureMessage.mock.calls.find(
    ([message]) => message === 'Session store entered protective read-only mode',
  );
  expect(capture).toBeDefined();
  expect(capture?.[1]).toMatchObject({ level: 'error', tags: { reason } });
}

beforeEach(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-safety-nets-'));
  vi.resetModules();
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => stubLogger,
    logger: stubLogger,
  }));
  await initTestPlatformConfig({ userDataPath: testDir });
  // Replace the no-op test reporter with a spy so Sentry captures are assertable.
  const { setErrorReporter } = await import('@core/errorReporter');
  setErrorReporter({
    captureException: sentryCaptureException,
    captureMessage: sentryCaptureMessage,
    addBreadcrumb: () => {},
  });
  Object.values(stubLogger).forEach((fn) => fn.mockClear());
  sentryCaptureMessage.mockClear();
  sentryCaptureException.mockClear();
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ===========================================================================
// Index backup + validated recovery (RED-FIRST: shrunken index / .bak clobber)
// ===========================================================================

describe('index.json rolling backup + validated recovery', () => {
  it('RED-FIRST eb93faddc round-5 F1 repro: reload-upsert with a corrupt primary recovers the FULL corpus from a good .bak and never writes a shrunken index', async () => {
    const { store, INDEX_VERSION } = await createStore();

    // Healthy corpus: 3 sessions with files + a good .bak snapshot of the index.
    const existing = ['sess-a', 'sess-b', 'sess-c'].map((id) => makeSession({ id }));
    for (const session of existing) writeSessionFile(session);
    const goodIndexJson = buildIndexJson(INDEX_VERSION, existing);
    fs.writeFileSync(indexBackupPath(), goodIndexJson, 'utf8');

    // The primary index is corrupt (torn write / garbage bytes).
    fs.writeFileSync(indexPath(), '{{{ definitely not json', 'utf8');

    // Cross-process style reload-upsert of ONE new session.
    store.upsertSessionsSyncWithReload([makeSession({ id: 'sess-new' })]);

    // The full corpus must survive: 3 recovered + 1 new (NOT a shrunken 1-row index).
    const ids = readIndexIds();
    expect(ids).toHaveLength(4);
    expect(ids).toEqual(expect.arrayContaining(['sess-a', 'sess-b', 'sess-c', 'sess-new']));

    // The good backup must never be clobbered by the corrupt primary.
    const bakParsed = JSON.parse(fs.readFileSync(indexBackupPath(), 'utf8')) as {
      sessions: Array<{ id: string }>;
    };
    expect(bakParsed.sessions.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['sess-a', 'sess-b', 'sess-c']),
    );
  });
});

// ===========================================================================
// migrateFromLegacy catastrophe guard (RED-FIRST: rename, never recursive rm)
// ===========================================================================

describe('migrateFromLegacy partial-migration guard', () => {
  function writeLegacyFile(sessions: AgentSession[]): void {
    fs.writeFileSync(
      path.join(testDir, 'agent-session-history.json'),
      JSON.stringify({ version: 1, sessions }),
      'utf8',
    );
  }

  it('RED-FIRST (async): partial migration renames sessions/ to a timestamped backup and folders.json survives in it (RS F12)', async () => {
    const { store } = await createStore();

    // Partial-migration state reachable via load(): sessions/ exists with
    // non-session payload (the user's folder structure) but ZERO session
    // files, and the legacy file is still present.
    fs.mkdirSync(sessionsDirPath(), { recursive: true });
    const foldersPayload = JSON.stringify({ folders: [{ id: 'f1', name: 'Important' }] });
    fs.writeFileSync(path.join(sessionsDirPath(), 'folders.json'), foldersPayload, 'utf8');
    writeLegacyFile([makeSession({ id: 'legacy-1' }), makeSession({ id: 'legacy-2' })]);

    const sessions = await store.load();

    // Migration still completes.
    expect(sessions.map((s) => s.id)).toEqual(expect.arrayContaining(['legacy-1', 'legacy-2']));
    expect(fs.existsSync(path.join(sessionsDirPath(), 'legacy-1.json'))).toBe(true);

    // The old sessions/ contents were RENAMED to a recoverable backup, not rm'd.
    const backupDirs = findPartialMigrationBackupDirs();
    expect(backupDirs).toHaveLength(1);
    const backedUpFolders = fs.readFileSync(
      path.join(testDir, backupDirs[0], 'folders.json'),
      'utf8',
    );
    expect(backedUpFolders).toBe(foldersPayload);
  });

  it('RED-FIRST (sync): partial migration renames sessions/ to a timestamped backup and folders.json survives in it (RS F12)', async () => {
    const { store } = await createStore();

    fs.mkdirSync(sessionsDirPath(), { recursive: true });
    const foldersPayload = JSON.stringify({ folders: [{ id: 'f1', name: 'Important' }] });
    fs.writeFileSync(path.join(sessionsDirPath(), 'folders.json'), foldersPayload, 'utf8');
    writeLegacyFile([makeSession({ id: 'legacy-1' })]);

    const sessions = store.loadSync();

    expect(sessions.map((s) => s.id)).toEqual(expect.arrayContaining(['legacy-1']));
    const backupDirs = findPartialMigrationBackupDirs();
    expect(backupDirs).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(testDir, backupDirs[0], 'folders.json'), 'utf8'),
    ).toBe(foldersPayload);
  });

  it('RED-FIRST (direct, sync): live session files survive in the renamed backup — the future-refactor catastrophe path', async () => {
    const { store } = await createStore();

    // Today this state is unreachable via load() (rebuild wins when session
    // files exist), but the guard must hold if a future refactor reaches it.
    const liveSession = makeSession({ id: 'live-1', title: 'Live work' });
    writeSessionFile(liveSession);
    fs.writeFileSync(path.join(sessionsDirPath(), 'folders.json'), '{"folders":[]}', 'utf8');
    writeLegacyFile([makeSession({ id: 'legacy-1' })]);

    (store as unknown as { migrateFromLegacySync: () => AgentSession[] }).migrateFromLegacySync();

    const backupDirs = findPartialMigrationBackupDirs();
    expect(backupDirs).toHaveLength(1);
    const backupDir = path.join(testDir, backupDirs[0]);
    expect(fs.existsSync(path.join(backupDir, 'live-1.json'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'folders.json'))).toBe(true);
    const recovered = JSON.parse(
      fs.readFileSync(path.join(backupDir, 'live-1.json'), 'utf8'),
    ) as AgentSession;
    expect(recovered.title).toBe('Live work');
  });

  it('RED-FIRST (direct, async): live session files survive in the renamed backup', async () => {
    const { store } = await createStore();

    const liveSession = makeSession({ id: 'live-1' });
    writeSessionFile(liveSession);
    writeLegacyFile([makeSession({ id: 'legacy-1' })]);

    await (
      store as unknown as { migrateFromLegacy: () => Promise<AgentSession[]> }
    ).migrateFromLegacy();

    const backupDirs = findPartialMigrationBackupDirs();
    expect(backupDirs).toHaveLength(1);
    expect(fs.existsSync(path.join(testDir, backupDirs[0], 'live-1.json'))).toBe(true);
  });
});

// ===========================================================================
// Mass-loss circuit breaker — per-path policy split
// ===========================================================================

describe('mass-loss circuit breaker (recovery-class paths)', () => {
  function seedIndexWithMissingFiles(totalEntries: number, filesOnDisk: number, indexVersion: number): string {
    const sessions = Array.from({ length: totalEntries }, (_, i) =>
      makeSession({ id: `sess-${String(i).padStart(3, '0')}` }),
    );
    for (const session of sessions.slice(0, filesOnDisk)) writeSessionFile(session);
    writeIndexFile(indexVersion, sessions);
    return fs.readFileSync(indexPath(), 'utf8');
  }

  it('F2-shape repro: pruning more-than-bound missing index entries on load ABORTS to read-only and preserves the on-disk index (sync)', async () => {
    const { store, INDEX_VERSION } = await createStore();
    // 60 entries, only 10 files → 50 missing > bound max(25, ceil(0.6)) = 25.
    const originalIndexBytes = seedIndexWithMissingFiles(60, 10, INDEX_VERSION);

    const sessions = store.loadSync();

    expect(sessions).toHaveLength(10); // What loaded is still returned…
    expect(store.isReadOnly()).toBe(true); // …but the store is frozen.
    // The on-disk index is untouched (no pruned/shrunken write).
    expect(fs.readFileSync(indexPath(), 'utf8')).toBe(originalIndexBytes);
    // Loud: structured error + Sentry capture with the breaker reason.
    const breakerLog = stubLogger.error.mock.calls.find(([, msg]) =>
      typeof msg === 'string' && msg.includes('MASS-LOSS CIRCUIT BREAKER TRIPPED'),
    );
    expect(breakerLog).toBeDefined();
    expect(breakerLog?.[0]).toMatchObject({
      reason: 'bulk-removal-breaker',
      source: 'loadFromNewFormatSync',
      removeCount: 50,
      totalCount: 60,
      safetyCounters: expect.objectContaining({ bulkRemovalBreakerTrips: 1 }),
    });
    expectProtectiveReadOnlySentryCapture('bulk-removal-breaker');
  });

  it('F2-shape repro (async): the same trip protects the async load path', async () => {
    const { store, INDEX_VERSION } = await createStore();
    const originalIndexBytes = seedIndexWithMissingFiles(60, 10, INDEX_VERSION);

    const sessions = await store.load();

    expect(sessions).toHaveLength(10);
    expect(store.isReadOnly()).toBe(true);
    expect(fs.readFileSync(indexPath(), 'utf8')).toBe(originalIndexBytes);
    expectProtectiveReadOnlySentryCapture('bulk-removal-breaker');
  });

  it('under-bound prune proceeds: a small missing-file prune still rewrites the index and stays writable', async () => {
    const { store, INDEX_VERSION } = await createStore();
    // 30 entries, 25 files → 5 missing ≤ bound 25.
    seedIndexWithMissingFiles(30, 25, INDEX_VERSION);

    const sessions = store.loadSync();

    expect(sessions).toHaveLength(25);
    expect(store.isReadOnly()).toBe(false);
    expect(readIndexIds()).toHaveLength(25);
  });

  it('rebuild-from-files trip: more-than-bound unreadable session files abort the rebuild to read-only instead of writing a shrunken index', async () => {
    const { store } = await createStore();
    // No index at all → rebuild path. 26 garbage files + 5 valid ones:
    // failed 26 > bound max(25, ceil(0.31)) = 25.
    fs.mkdirSync(sessionsDirPath(), { recursive: true });
    for (let i = 0; i < 26; i++) {
      fs.writeFileSync(path.join(sessionsDirPath(), `garbage-${i}.json`), '{{{ nope', 'utf8');
    }
    for (let i = 0; i < 5; i++) writeSessionFile(makeSession({ id: `good-${i}` }));

    const sessions = store.loadSync();

    expect(sessions).toHaveLength(5);
    expect(store.isReadOnly()).toBe(true);
    expect(fs.existsSync(indexPath())).toBe(false); // No shrunken index written.
    expectProtectiveReadOnlySentryCapture('bulk-removal-breaker');
  });

  it('persistent-trip pin (C-19): a persistent trigger re-trips at EVERY boot — loud and Sentry-captured each time, disk untouched', async () => {
    const { INDEX_VERSION } = await createStore();
    const originalIndexBytes = seedIndexWithMissingFiles(60, 10, INDEX_VERSION);

    for (let boot = 1; boot <= 2; boot++) {
      const { store } = await bootFreshStore();
      Object.values(stubLogger).forEach((fn) => fn.mockClear());
      sentryCaptureMessage.mockClear();

      store.loadSync();

      expect(store.isReadOnly()).toBe(true);
      expect(fs.readFileSync(indexPath(), 'utf8')).toBe(originalIndexBytes);
      expectProtectiveReadOnlySentryCapture('bulk-removal-breaker');
    }
  });
});

describe('mass-loss circuit breaker — exempt removers', () => {
  it('cleanupLeakedSessions caps at the per-pass bound, NEVER sets read-only, and converges across passes', async () => {
    const { store } = await createStore();
    // 30 leaked delete-eligible sessions (total files 30 → bound = 25).
    const leaked = Array.from({ length: 30 }, (_, i) =>
      makeSession({ id: `memory-update-${String(i).padStart(2, '0')}` }),
    );
    store.saveSync(leaked);

    const firstPass = await store.cleanupLeakedSessions();

    expect(firstPass.deleted).toBe(25);
    expect(firstPass.deferredBeyondCap).toBe(5);
    // EXPLICIT pin of the mode flag (an assert-that-throws impl would fake a
    // cap): the store must remain fully writable after a capped pass.
    expect(store.isReadOnly()).toBe(false);
    const capWarn = stubLogger.warn.mock.calls.find(([, msg]) =>
      typeof msg === 'string' && msg.includes('per-pass safety cap'),
    );
    expect(capWarn).toBeDefined();
    expect(capWarn?.[0]).toMatchObject({ eligibleCount: 30, perPassCap: 25, deferredBeyondCap: 5 });
    const capCapture = sentryCaptureMessage.mock.calls.find(
      ([message]) => message === 'cleanupLeakedSessions capped at bulk-removal bound',
    );
    expect(capCapture).toBeDefined();
    expect(capCapture?.[1]).toMatchObject({ level: 'warning' });

    // Convergence: the next pass (next startup) drains the remainder.
    const secondPass = await store.cleanupLeakedSessions();
    expect(secondPass.deleted).toBe(5);
    expect(secondPass.deferredBeyondCap).toBe(0);
    expect(store.isReadOnly()).toBe(false);
    const remaining = fs
      .readdirSync(sessionsDirPath())
      .filter((f) => f.startsWith('memory-update-'));
    expect(remaining).toHaveLength(0);
  });

  it('eviction exemption: evicting more-than-bound over-cap sessions still works and never trips the breaker', async () => {
    const { store, INDEX_VERSION, mod } = await createStore();
    const { MAX_PERSISTED_SESSIONS } = await import('@core/constants');
    void mod;
    // Index already 150 over the persisted cap: overflow 150 exceeds the
    // breaker bound (≈max(25, 1% of corpus) ≈ 102) — eviction must proceed.
    // Sessions are Done (doneAt set) so they are eviction-eligible (Active is never evicted).
    const total = MAX_PERSISTED_SESSIONS + 150;
    const sessions = Array.from({ length: total }, (_, i) =>
      makeSession({ id: `sess-${String(i).padStart(5, '0')}`, updatedAt: 1000 + i, doneAt: 1000 + i }),
    );
    writeIndexFile(INDEX_VERSION, sessions);
    expect(store.listSessions({ includeInternal: true })).toHaveLength(total);

    // Any save triggers evictIfNeeded() before the index write.
    store.saveSync([makeSession({ id: 'sess-trigger', updatedAt: 10_000_000 })]);

    expect(store.isReadOnly()).toBe(false);
    expect(readIndexIds()).toHaveLength(MAX_PERSISTED_SESSIONS);
  });

  it('purgeDeletedSessions exemption: the sessions-deleted/ TTL loop is unaffected by the breaker', async () => {
    const { store } = await createStore();
    const { purgeDeletedSessions } = await import('../cloudDataHygieneService');
    const deletedDir = path.join(testDir, 'sessions-deleted');
    fs.mkdirSync(deletedDir, { recursive: true });
    const ancient = Date.now() - 365 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(deletedDir, `old-${i}_${ancient}.json`), '{}', 'utf8');
    }

    const result = await purgeDeletedSessions(deletedDir);

    expect(result.deleted).toBe(30); // Well above the breaker bound — exempt.
    expect(store.isReadOnly()).toBe(false);
  });
});

// ===========================================================================
// Index backup chokepoint + corrupt/corrupt abort + EMFILE precedence
// ===========================================================================

describe('writeIndexFileAtomic chokepoint behavior', () => {
  it('every index write lands the PREVIOUS primary in .bak first (rolling backup)', async () => {
    const { store } = await createStore();

    await store.upsertSession(makeSession({ id: 'sess-1' }));
    await store.upsertSession(makeSession({ id: 'sess-2' }));

    const bak = JSON.parse(fs.readFileSync(indexBackupPath(), 'utf8')) as {
      sessions: Array<{ id: string }>;
    };
    expect(bak.sessions.map((e) => e.id)).toEqual(['sess-1']); // Previous primary.
    expect(readIndexIds()).toEqual(expect.arrayContaining(['sess-1', 'sess-2']));
  });

  it('a corrupt primary NEVER overwrites a good .bak (validate-first backup gate)', async () => {
    const { store } = await createStore();
    await store.upsertSession(makeSession({ id: 'sess-1' }));
    await store.upsertSession(makeSession({ id: 'sess-2' }));
    const goodBakBytes = fs.readFileSync(indexBackupPath(), 'utf8');

    // Corrupt the primary behind the store's back, then write again.
    fs.writeFileSync(indexPath(), 'tot@lly broken {', 'utf8');
    await store.upsertSession(makeSession({ id: 'sess-3' }));

    // The gate skipped the backup: .bak still holds the last GOOD snapshot.
    expect(fs.readFileSync(indexBackupPath(), 'utf8')).toBe(goodBakBytes);
    const skipWarn = stubLogger.warn.mock.calls.find(([, msg]) =>
      typeof msg === 'string' && msg.includes('SKIPPING backup-on-write'),
    );
    expect(skipWarn).toBeDefined();
    // The primary itself was rewritten from the healthy in-memory index.
    expect(readIndexIds()).toEqual(expect.arrayContaining(['sess-1', 'sess-2', 'sess-3']));
  });

  it('corrupt primary + good .bak at load → full corpus recovered without rebuild', async () => {
    const { store, INDEX_VERSION } = await createStore();
    const existing = ['sess-a', 'sess-b', 'sess-c'].map((id) => makeSession({ id }));
    for (const session of existing) writeSessionFile(session);
    fs.writeFileSync(indexBackupPath(), buildIndexJson(INDEX_VERSION, existing), 'utf8');
    fs.writeFileSync(indexPath(), '%%% corrupt', 'utf8');

    const sessions = store.loadSync();

    expect(sessions.map((s) => s.id)).toEqual(
      expect.arrayContaining(['sess-a', 'sess-b', 'sess-c']),
    );
    expect(store.isReadOnly()).toBe(false);
    // Primary was healed from the backup.
    expect(readIndexIds()).toEqual(expect.arrayContaining(['sess-a', 'sess-b', 'sess-c']));
    const recoveredLog = stubLogger.error.mock.calls.find(([, msg]) =>
      typeof msg === 'string' && msg.includes('Recovered index.json from index.json.bak'),
    );
    expect(recoveredLog).toBeDefined();
  });

  it('corrupt primary + corrupt .bak → reload-upsert aborts read-only with an observable dropped outcome and writes NOTHING', async () => {
    const { store } = await createStore();
    writeSessionFile(makeSession({ id: 'sess-existing' }));
    const corruptPrimary = '{{{ primary gone';
    fs.writeFileSync(indexPath(), corruptPrimary, 'utf8');
    fs.writeFileSync(indexBackupPath(), 'also garbage )))', 'utf8');

    const outcome = store.upsertSessionsSyncWithReload([makeSession({ id: 'sess-new' })]);

    expect(outcome).toEqual({ outcome: 'dropped', reason: 'corrupt-index-unrecoverable' });
    expect(store.isReadOnly()).toBe(true);
    // No shrunken index, no session file for the dropped write, corpus intact.
    expect(fs.readFileSync(indexPath(), 'utf8')).toBe(corruptPrimary);
    expect(fs.existsSync(path.join(sessionsDirPath(), 'sess-new.json'))).toBe(false);
    expect(fs.existsSync(path.join(sessionsDirPath(), 'sess-existing.json'))).toBe(true);
    const abortLog = stubLogger.error.mock.calls.find(([, msg]) =>
      typeof msg === 'string' && msg.includes('CORRUPT-INDEX UPSERT ABORT'),
    );
    expect(abortLog).toBeDefined();
    expect(abortLog?.[0]).toMatchObject({
      reason: 'reload-upsert-corrupt-index',
      safetyCounters: expect.objectContaining({ reloadUpsertAbortedCorruptIndexCount: 1 }),
    });
    expectProtectiveReadOnlySentryCapture('reload-upsert-corrupt-index');
  });

  it('EMFILE/IO precedence: a failing backup write never blocks the primary index write', async () => {
    const { store } = await createStore();
    await store.upsertSession(makeSession({ id: 'sess-1' }));
    // Make the .bak path unwritable: a DIRECTORY squats on it.
    fs.rmSync(indexBackupPath(), { force: true });
    fs.mkdirSync(indexBackupPath());

    await store.upsertSession(makeSession({ id: 'sess-2' }));

    // Primary write landed despite the failed backup; degrade is observable.
    expect(readIndexIds()).toEqual(expect.arrayContaining(['sess-1', 'sess-2']));
    const backupWarn = stubLogger.warn.mock.calls.find(([, msg]) =>
      typeof msg === 'string' && msg.includes('Failed to back up index.json'),
    );
    expect(backupWarn).toBeDefined();
  });
});

// ===========================================================================
// 4-way validator: version mismatch is NEVER corrupt (FMM C-7)
// ===========================================================================

describe('4-way index validation (version-mismatch ≠ corrupt)', () => {
  it('version-backward index routes to rebuild-from-files migration — NOT backup recovery (stale .bak ignored)', async () => {
    const { store, INDEX_VERSION } = await createStore();
    const live = ['sess-1', 'sess-2'].map((id) => makeSession({ id }));
    for (const session of live) writeSessionFile(session);
    writeIndexFile(INDEX_VERSION - 1, live);
    // A stale-but-valid .bak with an entry that has NO file: if version-backward
    // wrongly entered backup recovery, this ghost would appear in the index.
    fs.writeFileSync(
      indexBackupPath(),
      buildIndexJson(INDEX_VERSION, [makeSession({ id: 'sess-bak-ghost' })]),
      'utf8',
    );

    const sessions = store.loadSync();

    expect(sessions.map((s) => s.id).sort()).toEqual(['sess-1', 'sess-2']);
    expect(store.isReadOnly()).toBe(false);
    const rebuilt = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) as {
      version: number;
      sessions: Array<{ id: string }>;
    };
    expect(rebuilt.version).toBe(INDEX_VERSION); // Migrated.
    expect(rebuilt.sessions.map((e) => e.id)).not.toContain('sess-bak-ghost');
  });

  it('version-forward index routes to the existing read-only protection — loudly (log.error + Sentry), not backup recovery', async () => {
    const { store, INDEX_VERSION } = await createStore();
    const session = makeSession({ id: 'sess-future' });
    writeSessionFile(session);
    writeIndexFile(INDEX_VERSION + 1, [session]);
    const forwardIndexBytes = fs.readFileSync(indexPath(), 'utf8');

    const sessions = store.loadSync();

    expect(sessions).toHaveLength(1); // Still loads (read-only, not broken).
    expect(store.isReadOnly()).toBe(true);
    expect(fs.readFileSync(indexPath(), 'utf8')).toBe(forwardIndexBytes);
    expectProtectiveReadOnlySentryCapture('index-version-forward');
  });

  it('round-6 CLI edge pin: reload-upsert against an OLD-version index writes through (no silent drop, no read-only)', async () => {
    const { store, INDEX_VERSION } = await createStore();
    const existing = makeSession({ id: 'sess-old' });
    writeSessionFile(existing);
    writeIndexFile(INDEX_VERSION - 1, [existing]);

    // The persistSessionFromCli path: upsertSessionsSyncWithReload under locks.
    const outcome = store.upsertSessionsSyncWithReload([makeSession({ id: 'sess-cli' })]);

    // (Stage 3 extended 'persisted' with per-session id reporting.)
    expect(outcome).toEqual({
      outcome: 'persisted',
      persistedSessionIds: ['sess-cli'],
      droppedTombstonedSessionIds: [],
    });
    expect(store.isReadOnly()).toBe(false);
    expect(fs.existsSync(path.join(sessionsDirPath(), 'sess-cli.json'))).toBe(true);
    const written = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) as {
      version: number;
      sessions: Array<{ id: string }>;
    };
    expect(written.sessions.map((e) => e.id)).toEqual(
      expect.arrayContaining(['sess-old', 'sess-cli']),
    );
    // Write-through preserves the old version: migration belongs to the next
    // full load(), exactly as before Stage 2.
    expect(written.version).toBe(INDEX_VERSION - 1);
  });

  it('reload-upsert against a NEWER-version index drops the write observably and enters read-only', async () => {
    const { store, INDEX_VERSION } = await createStore();
    const existing = makeSession({ id: 'sess-future' });
    writeSessionFile(existing);
    writeIndexFile(INDEX_VERSION + 1, [existing]);
    const forwardIndexBytes = fs.readFileSync(indexPath(), 'utf8');

    const outcome = store.upsertSessionsSyncWithReload([makeSession({ id: 'sess-new' })]);

    expect(outcome).toEqual({ outcome: 'dropped', reason: 'version-forward-index' });
    expect(store.isReadOnly()).toBe(true);
    expect(fs.readFileSync(indexPath(), 'utf8')).toBe(forwardIndexBytes);
    expect(fs.existsSync(path.join(sessionsDirPath(), 'sess-new.json'))).toBe(false);
    expectProtectiveReadOnlySentryCapture('reload-upsert-version-forward');
  });
});

// ===========================================================================
// Round-2 fix (GPT review F1): malformed CURRENT-version rows are 'corrupt'
// on the load/index-only consumers too — same validated-recovery routing as
// reload-upsert; never the missing-file prune (and never a breaker trip for
// what is really index corruption).
// ===========================================================================

describe('malformed current-version index rows on load/index-only paths (review F1)', () => {
  const MALFORMED_ROWS: unknown[] = [
    {}, // no id at all
    { id: 123 }, // non-string id
    { id: '../escape' }, // filename-unsafe id
  ];

  function seedValidSessions(ids: string[]): AgentSession[] {
    const sessions = ids.map((id) => makeSession({ id }));
    for (const session of sessions) writeSessionFile(session);
    return sessions;
  }

  it('RED-FIRST (sync full load): over-bound malformed rows route to corrupt→rebuild, NOT a breaker trip', async () => {
    const { store, INDEX_VERSION } = await createStore();
    const valid = seedValidSessions(['sess-a', 'sess-b', 'sess-c']);
    // 35 malformed rows (> bound 25): the unfixed path counted them as
    // missing-file prunes and TRIPPED the breaker into read-only. The 4-way
    // contract says this index is CORRUPT → .bak recovery → rebuild fallback.
    const malformed = Array.from({ length: 35 }, () => ({ title: 'no id row' }));
    writeRawIndexFile(INDEX_VERSION, [...valid.map(buildIndexEntry), ...malformed]);

    const sessions = store.loadSync();

    expect(sessions.map((s) => s.id).sort()).toEqual(['sess-a', 'sess-b', 'sess-c']);
    expect(store.isReadOnly()).toBe(false); // NOT a breaker trip.
    const breakerLog = stubLogger.error.mock.calls.find(([, msg]) =>
      typeof msg === 'string' && msg.includes('MASS-LOSS CIRCUIT BREAKER TRIPPED'),
    );
    expect(breakerLog).toBeUndefined();
    // Rebuilt to a clean, current-version index containing only the real files.
    const rebuilt = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) as {
      version: number;
      sessions: Array<{ id: string }>;
    };
    expect(rebuilt.version).toBe(INDEX_VERSION);
    expect(rebuilt.sessions.map((e) => e.id).sort()).toEqual(['sess-a', 'sess-b', 'sess-c']);
  });

  it('RED-FIRST (async full load): over-bound malformed rows route to corrupt→rebuild, NOT a breaker trip', async () => {
    const { store, INDEX_VERSION } = await createStore();
    const valid = seedValidSessions(['sess-a', 'sess-b', 'sess-c']);
    const malformed = Array.from({ length: 35 }, () => ({ title: 'no id row' }));
    writeRawIndexFile(INDEX_VERSION, [...valid.map(buildIndexEntry), ...malformed]);

    const sessions = await store.load();

    expect(sessions.map((s) => s.id).sort()).toEqual(['sess-a', 'sess-b', 'sess-c']);
    expect(store.isReadOnly()).toBe(false);
    expect(readIndexIds().sort()).toEqual(['sess-a', 'sess-b', 'sess-c']);
  });

  it('RED-FIRST (sync full load): UNDER-bound malformed rows take validated .bak recovery, never the silent prune+rewrite', async () => {
    const { store, INDEX_VERSION } = await createStore();
    const valid = seedValidSessions(['sess-a', 'sess-b', 'sess-c']);
    fs.writeFileSync(indexBackupPath(), buildIndexJson(INDEX_VERSION, valid), 'utf8');
    // Only 3 malformed rows — well under the breaker bound. The unfixed path
    // silently treated them as missing files and prune+rewrote the index.
    writeRawIndexFile(INDEX_VERSION, [...valid.map(buildIndexEntry), ...MALFORMED_ROWS]);

    const sessions = store.loadSync();

    expect(sessions.map((s) => s.id).sort()).toEqual(['sess-a', 'sess-b', 'sess-c']);
    expect(store.isReadOnly()).toBe(false);
    // ROUTE pin: recovery from .bak, not the missing-file prune.
    const recoveredLog = stubLogger.error.mock.calls.find(([, msg]) =>
      typeof msg === 'string' && msg.includes('Recovered index.json from index.json.bak'),
    );
    expect(recoveredLog).toBeDefined();
    const pruneLog = stubLogger.warn.mock.calls.find(([, msg]) =>
      typeof msg === 'string' && msg.includes('Pruning index entries'),
    );
    expect(pruneLog).toBeUndefined();
    // Primary healed from the validated backup (clean rows only).
    expect(readIndexIds().sort()).toEqual(['sess-a', 'sess-b', 'sess-c']);
  });

  it('RED-FIRST (async full load): UNDER-bound malformed rows take validated .bak recovery, never the silent prune+rewrite', async () => {
    const { store, INDEX_VERSION } = await createStore();
    const valid = seedValidSessions(['sess-a', 'sess-b', 'sess-c']);
    fs.writeFileSync(indexBackupPath(), buildIndexJson(INDEX_VERSION, valid), 'utf8');
    writeRawIndexFile(INDEX_VERSION, [...valid.map(buildIndexEntry), ...MALFORMED_ROWS]);

    const sessions = await store.load();

    expect(sessions.map((s) => s.id).sort()).toEqual(['sess-a', 'sess-b', 'sess-c']);
    expect(store.isReadOnly()).toBe(false);
    const recoveredLog = stubLogger.error.mock.calls.find(([, msg]) =>
      typeof msg === 'string' && msg.includes('Recovered index.json from index.json.bak'),
    );
    expect(recoveredLog).toBeDefined();
    const pruneLog = stubLogger.warn.mock.calls.find(([, msg]) =>
      typeof msg === 'string' && msg.includes('Pruning index entries'),
    );
    expect(pruneLog).toBeUndefined();
    expect(readIndexIds().sort()).toEqual(['sess-a', 'sess-b', 'sess-c']);
  });

  it('RED-FIRST (index-only): malformed rows are NOT accepted into the in-memory index — falls back to full load + validated recovery', async () => {
    const { store, INDEX_VERSION } = await createStore();
    seedValidSessions(['sess-a', 'sess-b']);
    writeRawIndexFile(INDEX_VERSION, [
      ...['sess-a', 'sess-b'].map((id) => buildIndexEntry(makeSession({ id }))),
      {}, // malformed row the unfixed loadIndexOnlySync accepted verbatim
    ]);

    // listSessions() drives loadIndexOnlySync first, full loadSync on fallback.
    const summaries = store.listSessions({ includeInternal: true });

    expect(summaries).toHaveLength(2); // Unfixed path returned 3 (incl. the garbage row).
    expect(summaries.map((s) => s.id).sort()).toEqual(['sess-a', 'sess-b']);
    expect(store.getSessionIds().sort()).toEqual(['sess-a', 'sess-b']);
    expect(store.isReadOnly()).toBe(false);
  });

  it('healthy current-version index stays byte-identical through the index-only path (no behavior change)', async () => {
    const { store, INDEX_VERSION } = await createStore();
    const valid = seedValidSessions(['sess-a', 'sess-b']);
    writeIndexFile(INDEX_VERSION, valid);
    const healthyBytes = fs.readFileSync(indexPath(), 'utf8');

    const summaries = store.listSessions({ includeInternal: true });

    expect(summaries.map((s) => s.id).sort()).toEqual(['sess-a', 'sess-b']);
    expect(fs.readFileSync(indexPath(), 'utf8')).toBe(healthyBytes);
    expect(store.isReadOnly()).toBe(false);
  });
});
