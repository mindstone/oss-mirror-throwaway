/**
 * Migration safety net for the CONTRACT step of the `pinnedAt` → `doneAt` rename
 * (docs/plans/260614_done-state-rename/PLAN.md, Stage 7).
 *
 * Stage 7 REMOVES `pinnedAt`: `migratePinnedToDone()` ensures the canonical
 * `doneAt` is set (deriving it from legacy `pinnedAt` polarity for never-migrated
 * files; preserving an already-set `doneAt` for EXPAND-stage dual-written files)
 * and then DELETES `pinnedAt` so it no longer persists. These tests lock in:
 *   - the state-matrix mapping (each pre-migration state → resulting `doneAt`),
 *     asserting `pinnedAt` is GONE from the migrated session,
 *   - round-trip tab-membership set-equality (Active/Done predicates),
 *   - idempotency (running twice is a no-op),
 *   - CONTRACT persistence (legacy file → load → save → file has `doneAt`, NO
 *     `pinnedAt`) — for both never-migrated and dual-written on-disk shapes,
 *   - v7 → v8 index rebuild producing summaries carrying `doneAt` and no
 *     `pinnedAt`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import { isSessionActive, isSessionDone } from '@rebel/shared';
import type { AgentSession } from '@shared/types';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

/**
 * Builds a raw on-disk session record. `pinnedAt` is the legacy field (cast
 * because the migration's whole point is to read pre-rename data), and we
 * deliberately do NOT include `doneAt` so the migration fires.
 */
function makeLegacySession(
  overrides: Partial<AgentSession> & { pinnedAt?: number | null } = {},
): AgentSession {
  return {
    id: 'sess-legacy',
    title: 'Legacy Session',
    createdAt: 1000,
    updatedAt: 2000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  } as AgentSession;
}

function writeSessionFile(sessionsDir: string, session: AgentSession): void {
  fs.writeFileSync(path.join(sessionsDir, `${session.id}.json`), JSON.stringify(session), 'utf8');
}

function writeLegacyIndexFile(
  sessionsDir: string,
  indexVersion: number,
  sessions: AgentSession[],
): void {
  fs.writeFileSync(
    path.join(sessionsDir, 'index.json'),
    JSON.stringify({
      version: indexVersion,
      lastUpdated: 1000,
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        resolvedAt: session.resolvedAt ?? null,
        pinnedAt: (session as { pinnedAt?: number | null }).pinnedAt ?? null,
        starredAt: session.starredAt ?? null,
        deletedAt: session.deletedAt ?? null,
        origin: session.origin ?? 'manual',
        isCorrupted: false,
        privateMode: session.privateMode ?? false,
        interruptedTurnId: session.interruptedTurnId ?? null,
        preview: '',
        firstMessagePreview: '',
        messageCount: session.messages.length,
        hasDraft: false,
        draftPreview: null,
        draftUpdatedAt: null,
        usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
        activeTurnId: session.activeTurnId ?? null,
        isBusy: session.isBusy,
        lastError: session.lastError ?? null,
        fingerprint: `${session.updatedAt}:test`,
      })),
    }),
    'utf8',
  );
}

describe('IncrementalSessionStore — pinnedAt → doneAt migration (Stage 7 CONTRACT)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-migration-'));
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

  async function loadFromLegacy(
    sessions: AgentSession[],
    indexVersion: number,
  ): Promise<{ store: import('../incrementalSessionStore').IncrementalSessionStore; loaded: AgentSession[] }> {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    for (const session of sessions) writeSessionFile(sessionsDir, session);
    writeLegacyIndexFile(sessionsDir, indexVersion, sessions);
    const store = new IncrementalSessionStore();
    const loaded = store.loadSync();
    return { store, loaded };
  }

  function readPersistedSession(sessionId: string): Record<string, unknown> {
    return JSON.parse(
      fs.readFileSync(path.join(testDir, 'sessions', `${sessionId}.json`), 'utf8'),
    ) as Record<string, unknown>;
  }

  function readIndex(): { version: number; sessions: Array<Record<string, unknown>> } {
    return JSON.parse(
      fs.readFileSync(path.join(testDir, 'sessions', 'index.json'), 'utf8'),
    ) as { version: number; sessions: Array<Record<string, unknown>> };
  }

  /** Reads the now-removed `pinnedAt` key off a loaded session for absence checks. */
  function hasPinnedAt(s: AgentSession): boolean {
    return Object.prototype.hasOwnProperty.call(s, 'pinnedAt');
  }

  describe('state matrix (each pre-state → doneAt; pinnedAt DELETED)', () => {
    it('pinnedAt=<ts> (Active) → doneAt=null, pinnedAt deleted', async () => {
      const { loaded } = await loadFromLegacy(
        [makeLegacySession({ id: 's-active', pinnedAt: 1500 })],
        8,
      );
      const s = loaded.find((x) => x.id === 's-active')!;
      expect(s.doneAt).toBeNull();
      expect(hasPinnedAt(s)).toBe(false); // CONTRACT: pinnedAt removed
      expect(isSessionActive(s)).toBe(true);
      expect(isSessionDone(s)).toBe(false);
    });

    it('pinnedAt=null (Done) → doneAt=resolvedAt ?? updatedAt ?? createdAt, pinnedAt deleted', async () => {
      const { loaded } = await loadFromLegacy(
        [makeLegacySession({ id: 's-done', pinnedAt: null, resolvedAt: 1750, updatedAt: 2000 })],
        8,
      );
      const s = loaded.find((x) => x.id === 's-done')!;
      expect(s.doneAt).toBe(1750); // resolvedAt wins
      expect(hasPinnedAt(s)).toBe(false); // CONTRACT: pinnedAt removed
      expect(isSessionDone(s)).toBe(true);
    });

    it('pinnedAt=null (Done) with no resolvedAt → falls back to updatedAt', async () => {
      const { loaded } = await loadFromLegacy(
        [makeLegacySession({ id: 's-done-2', pinnedAt: null, resolvedAt: null, updatedAt: 2222 })],
        8,
      );
      const s = loaded.find((x) => x.id === 's-done-2')!;
      expect(s.doneAt).toBe(2222);
      expect(isSessionDone(s)).toBe(true);
    });

    it('pinnedAt absent → defensive Active (doneAt stays absent)', async () => {
      const { loaded } = await loadFromLegacy([makeLegacySession({ id: 's-absent' })], 8);
      const s = loaded.find((x) => x.id === 's-absent')!;
      expect(s.doneAt == null).toBe(true);
      expect(isSessionActive(s)).toBe(true);
    });

    it('already-doneAt → idempotent no-op (existing doneAt preserved)', async () => {
      const { loaded } = await loadFromLegacy(
        [
          makeLegacySession({
            id: 's-premigrated',
            pinnedAt: 1500, // Active in legacy terms…
            doneAt: 999, // …but doneAt already set → must NOT be overwritten
          }),
        ],
        8,
      );
      const s = loaded.find((x) => x.id === 's-premigrated')!;
      expect(s.doneAt).toBe(999);
    });

    it('Starred + Active → doneAt=null, starredAt kept, pinnedAt deleted', async () => {
      const { loaded } = await loadFromLegacy(
        [makeLegacySession({ id: 's-star-active', pinnedAt: 1500, starredAt: 1600 })],
        8,
      );
      const s = loaded.find((x) => x.id === 's-star-active')!;
      expect(s.doneAt).toBeNull();
      expect(s.starredAt).toBe(1600);
      expect(hasPinnedAt(s)).toBe(false);
    });

    it('Starred + Done → doneAt set, starredAt kept', async () => {
      const { loaded } = await loadFromLegacy(
        [makeLegacySession({ id: 's-star-done', pinnedAt: null, starredAt: 1600, updatedAt: 2100 })],
        8,
      );
      const s = loaded.find((x) => x.id === 's-star-done')!;
      expect(isSessionDone(s)).toBe(true);
      expect(s.doneAt).toBe(2100);
      expect(s.starredAt).toBe(1600);
    });

    it('Trashed (Active before deletion) → doneAt=null, deletedAt kept, pinnedAt deleted', async () => {
      const { loaded } = await loadFromLegacy(
        [makeLegacySession({ id: 's-trash', pinnedAt: 1500, deletedAt: 1900 })],
        8,
      );
      const s = loaded.find((x) => x.id === 's-trash')!;
      expect(s.doneAt).toBeNull();
      expect(s.deletedAt).toBe(1900);
      expect(hasPinnedAt(s)).toBe(false);
    });
  });

  it('round-trip tab membership set-equality (Active/Done) is preserved', async () => {
    const fixtures: AgentSession[] = [
      makeLegacySession({ id: 'm-active-1', pinnedAt: 1500 }),
      makeLegacySession({ id: 'm-active-2', pinnedAt: 1600, starredAt: 1700 }),
      makeLegacySession({ id: 'm-done-1', pinnedAt: null, updatedAt: 1800 }),
      makeLegacySession({ id: 'm-done-2', pinnedAt: null, resolvedAt: 1850 }),
      makeLegacySession({ id: 'm-done-3', pinnedAt: null, starredAt: 1900, updatedAt: 1950 }),
    ];
    // Pre-migration partition (legacy polarity: pinnedAt != null = Active).
    const preActive = new Set(
      fixtures.filter((s) => (s as { pinnedAt?: number | null }).pinnedAt != null).map((s) => s.id),
    );
    const preDone = new Set(
      fixtures.filter((s) => (s as { pinnedAt?: number | null }).pinnedAt == null).map((s) => s.id),
    );

    const { loaded } = await loadFromLegacy(fixtures, 8);

    const postActive = new Set(loaded.filter((s) => isSessionActive(s)).map((s) => s.id));
    const postDone = new Set(loaded.filter((s) => isSessionDone(s)).map((s) => s.id));

    expect(postActive).toEqual(preActive);
    expect(postDone).toEqual(preDone);
    // Negative: no overlap, full coverage.
    expect([...postActive].some((id) => postDone.has(id))).toBe(false);
    expect(postActive.size + postDone.size).toBe(fixtures.length);
  });

  it('migration is idempotent (running on already-migrated data is a no-op)', async () => {
    // First load migrates.
    const { loaded } = await loadFromLegacy(
      [makeLegacySession({ id: 's-idem', pinnedAt: null, resolvedAt: 1750 })],
      8,
    );
    const first = loaded.find((x) => x.id === 's-idem')!;
    expect(first.doneAt).toBe(1750);

    // Re-import + re-load the same on-disk state; doneAt must be untouched.
    vi.resetModules();
    vi.doMock('@core/logger', () => ({
      createScopedLogger: () => stubLogger,
      logger: stubLogger,
    }));
    await initTestPlatformConfig({ userDataPath: testDir });
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store2 = new IncrementalSessionStore();
    const reloaded = store2.loadSync().find((x) => x.id === 's-idem')!;
    expect(reloaded.doneAt).toBe(1750);
  });

  it('CONTRACT persistence (never-migrated legacy file): load → save → on-disk has doneAt, NO pinnedAt', async () => {
    const { store, loaded } = await loadFromLegacy(
      [makeLegacySession({ id: 's-persist', pinnedAt: null, resolvedAt: 1750 })],
      7, // legacy index version forces rebuild + marks the migrated session dirty
    );
    const migrated = loaded.find((x) => x.id === 's-persist')!;
    expect(migrated.doneAt).toBe(1750);

    // Saving the migrated (SANITIZED) session must persist the repair WITHOUT pinnedAt.
    store.upsertSessionsSyncWithReload([migrated]);

    const onDisk = readPersistedSession('s-persist');
    expect(onDisk.doneAt).toBe(1750);
    expect('pinnedAt' in onDisk).toBe(false); // CONTRACT: pinnedAt deleted, does NOT persist
    // Consistency: doneAt non-null ⇔ legacy pinnedAt == null.
    expect(isSessionDone(onDisk as { doneAt?: number | null })).toBe(true);
  });

  it('CONTRACT persistence (EXPAND-stage dual-written file with BOTH fields): doneAt preserved, pinnedAt stripped', async () => {
    // A file written during the EXPAND stage carries BOTH pinnedAt and doneAt on
    // disk. doneAt is authoritative; the stale pinnedAt must be removed.
    const sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const dualWritten = makeLegacySession({
      id: 's-dual',
      pinnedAt: null, // legacy Done marker (stale)
      doneAt: 1750, // canonical (authoritative)
      resolvedAt: 1750,
    });
    writeSessionFile(sessionsDir, dualWritten);
    writeLegacyIndexFile(sessionsDir, 7, [dualWritten]);

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();
    const loaded = store.loadSync();
    const migrated = loaded.find((x) => x.id === 's-dual')!;
    expect(migrated.doneAt).toBe(1750); // authoritative doneAt untouched
    expect(hasPinnedAt(migrated)).toBe(false); // stale pinnedAt removed

    store.upsertSessionsSyncWithReload([migrated]);
    const onDisk = readPersistedSession('s-dual');
    expect(onDisk.doneAt).toBe(1750);
    expect('pinnedAt' in onDisk).toBe(false); // CONTRACT: stripped on save
  });

  /**
   * Legacy SINGLE-FILE migration path (`migrateFromLegacy` / `migrateFromLegacySync`):
   * `agent-session-history.json` exists, no `sessions/` dir, no index. This path
   * parses the legacy file and writes per-session `sessions/<id>.json` files.
   * Final-review F1: that write must run `normalizeSessionTurnState` first so the
   * on-disk file carries `doneAt` and NOT raw `pinnedAt` (and the seeded
   * fingerprint matches the sanitized shape) — immediately after migration, not
   * after a second load.
   */
  describe('legacy single-file migration (migrateFromLegacy*) — F1 sanitized persistence', () => {
    function writeLegacySingleFile(sessions: AgentSession[]): void {
      fs.writeFileSync(
        path.join(testDir, 'agent-session-history.json'),
        JSON.stringify({ version: 1, sessions }),
        'utf8',
      );
    }

    async function freshStore(): Promise<import('../incrementalSessionStore').IncrementalSessionStore> {
      const { IncrementalSessionStore } = await import('../incrementalSessionStore');
      return new IncrementalSessionStore();
    }

    it('sync: persists doneAt (correct polarity) and NO pinnedAt to per-session files', async () => {
      writeLegacySingleFile([
        makeLegacySession({ id: 'leg-active', pinnedAt: 1500 }), // Active
        makeLegacySession({ id: 'leg-done', pinnedAt: null, resolvedAt: 1750, updatedAt: 2000 }), // Done
      ]);
      const store = await freshStore();
      const loaded = store.loadSync();
      expect(loaded.map((s) => s.id).sort()).toEqual(['leg-active', 'leg-done']);

      // Assert the on-disk per-session files immediately after migration.
      const activeOnDisk = readPersistedSession('leg-active');
      expect('doneAt' in activeOnDisk).toBe(true);
      expect(activeOnDisk.doneAt).toBeNull(); // Active → doneAt present-but-null
      expect('pinnedAt' in activeOnDisk).toBe(false);

      const doneOnDisk = readPersistedSession('leg-done');
      expect(doneOnDisk.doneAt).toBe(1750); // Done → doneAt non-null (resolvedAt wins)
      expect('pinnedAt' in doneOnDisk).toBe(false);
    });

    it('async: persists doneAt (correct polarity) and NO pinnedAt to per-session files', async () => {
      writeLegacySingleFile([
        makeLegacySession({ id: 'leg-active-a', pinnedAt: 1500 }), // Active
        makeLegacySession({ id: 'leg-done-a', pinnedAt: null, resolvedAt: 1750, updatedAt: 2000 }), // Done
      ]);
      const store = await freshStore();
      const loaded = await store.load();
      expect(loaded.map((s) => s.id).sort()).toEqual(['leg-active-a', 'leg-done-a']);

      const activeOnDisk = readPersistedSession('leg-active-a');
      expect('doneAt' in activeOnDisk).toBe(true);
      expect(activeOnDisk.doneAt).toBeNull();
      expect('pinnedAt' in activeOnDisk).toBe(false);

      const doneOnDisk = readPersistedSession('leg-done-a');
      expect(doneOnDisk.doneAt).toBe(1750);
      expect('pinnedAt' in doneOnDisk).toBe(false);
    });
  });

  /**
   * Orphan agent-sessions/ migration path (`migrateFromAgentSessions` /
   * `migrateFromAgentSessionsSync`): an orphaned `agent-sessions/<id>.json`
   * directory exists (real beta-user data per
   * docs/plans/finished/260103_extend_incremental_store_lazy_loading.md:86/:402).
   * This path parses each orphan file and writes per-session
   * `sessions/<id>.json` files.
   * Final-review F1 (agent-sessions sibling): that write must run
   * `normalizeSessionTurnState` first so the canonical on-disk file carries
   * `doneAt` and NOT raw `pinnedAt` — immediately after migration, not after a
   * second load (the prior F1 fix covered only the legacy single-file path; the
   * adjacent orphan-directory path was missed).
   */
  describe('orphan agent-sessions/ migration (migrateFromAgentSessions*) — F1 sanitized persistence', () => {
    function writeAgentSessionsDir(sessions: AgentSession[]): void {
      const agentSessionsDir = path.join(testDir, 'agent-sessions');
      fs.mkdirSync(agentSessionsDir, { recursive: true });
      for (const session of sessions) {
        fs.writeFileSync(
          path.join(agentSessionsDir, `${session.id}.json`),
          JSON.stringify(session),
          'utf8',
        );
      }
    }

    async function freshStore(): Promise<import('../incrementalSessionStore').IncrementalSessionStore> {
      const { IncrementalSessionStore } = await import('../incrementalSessionStore');
      return new IncrementalSessionStore();
    }

    it('sync: persists doneAt (correct polarity) and NO pinnedAt to canonical files', async () => {
      writeAgentSessionsDir([
        makeLegacySession({ id: 'as-active', pinnedAt: 1500 }), // Active
        makeLegacySession({ id: 'as-done', pinnedAt: null, resolvedAt: 1750, updatedAt: 2000 }), // Done
      ]);
      const store = await freshStore();
      const loaded = store.loadSync();
      expect(loaded.map((s) => s.id).sort()).toEqual(['as-active', 'as-done']);

      // Assert the canonical sessions/<id>.json files immediately after migration.
      const activeOnDisk = readPersistedSession('as-active');
      expect('doneAt' in activeOnDisk).toBe(true);
      expect(activeOnDisk.doneAt).toBeNull(); // Active → doneAt present-but-null
      expect('pinnedAt' in activeOnDisk).toBe(false);

      const doneOnDisk = readPersistedSession('as-done');
      expect(doneOnDisk.doneAt).toBe(1750); // Done → doneAt non-null (resolvedAt wins)
      expect('pinnedAt' in doneOnDisk).toBe(false);
    });

    it('async: persists doneAt (correct polarity) and NO pinnedAt to canonical files', async () => {
      writeAgentSessionsDir([
        makeLegacySession({ id: 'as-active-a', pinnedAt: 1500 }), // Active
        makeLegacySession({ id: 'as-done-a', pinnedAt: null, resolvedAt: 1750, updatedAt: 2000 }), // Done
      ]);
      const store = await freshStore();
      const loaded = await store.load();
      expect(loaded.map((s) => s.id).sort()).toEqual(['as-active-a', 'as-done-a']);

      const activeOnDisk = readPersistedSession('as-active-a');
      expect('doneAt' in activeOnDisk).toBe(true);
      expect(activeOnDisk.doneAt).toBeNull();
      expect('pinnedAt' in activeOnDisk).toBe(false);

      const doneOnDisk = readPersistedSession('as-done-a');
      expect(doneOnDisk.doneAt).toBe(1750);
      expect('pinnedAt' in doneOnDisk).toBe(false);
    });
  });

  it('legacy → current index rebuild produces summaries carrying doneAt and NO pinnedAt', async () => {
    await loadFromLegacy(
      [
        makeLegacySession({ id: 'idx-active', pinnedAt: 1500 }),
        makeLegacySession({ id: 'idx-done', pinnedAt: null, resolvedAt: 1750 }),
      ],
      7, // backward version → triggers rebuild from per-session files
    );
    const index = readIndex();
    // Rebuilds to the current INDEX_VERSION (9 since the 260617 automation
    // doneAt backfill bump; was 8 for the pinnedAt → doneAt rename).
    expect(index.version).toBe(9);
    const active = index.sessions.find((s) => s.id === 'idx-active')!;
    const done = index.sessions.find((s) => s.id === 'idx-done')!;
    expect('doneAt' in active).toBe(true);
    expect(active.doneAt).toBeNull();
    expect(done.doneAt).toBe(1750);
    // CONTRACT: pinnedAt no longer emitted in rebuilt summaries.
    expect('pinnedAt' in active).toBe(false);
    expect('pinnedAt' in done).toBe(false);
  });
});
