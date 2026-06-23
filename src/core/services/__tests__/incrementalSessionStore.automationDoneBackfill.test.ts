/**
 * Safety net for `migrateResolvedAutomationToDone` (260617).
 *
 * Background: automations were never part of the `pinnedAt` model, so their
 * files carry no `pinnedAt` key — `migratePinnedToDone` is a no-op for them.
 * Their Done state lived only in the session INDEX (derived at the index-level
 * migration) and was never written back to the files, so a rebuild-from-files
 * (e.g. the 260617 index-collapse recovery) reverted every resolved automation
 * to Active. This migration backfills `doneAt = resolvedAt` for resolved
 * automations, scoped tightly so it can't mis-classify anything else.
 *
 * These tests lock in:
 *   - automation + resolvedAt + no `doneAt` key → Done (doneAt = resolvedAt),
 *   - automation + no resolvedAt → stays Active (no invented done-time),
 *   - automation with an explicit reopen (`doneAt: null` key present) → stays
 *     Active (the user's choice is preserved — key-presence gate, not truthiness),
 *   - automation with `doneAt` already set → idempotent (preserved),
 *   - manual + resolvedAt → unaffected (scoped to origin==='automation'),
 *   - the v8 → v9 index rebuild restores Done for a resolved automation whose
 *     file lacks `doneAt` (the exact user-facing recovery scenario).
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
 * Builds a raw on-disk session record. We deliberately omit `doneAt` (no key) by
 * default so the migration's key-presence gate is exercised honestly; callers can
 * add `doneAt` explicitly (including `null`) to model an explicit reopen.
 */
function makeSession(
  overrides: Partial<AgentSession> & { pinnedAt?: number | null; doneAt?: number | null } = {},
): AgentSession {
  return {
    id: 'sess',
    title: 'Session',
    createdAt: 1000,
    updatedAt: 2000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    origin: 'manual',
    ...overrides,
  } as AgentSession;
}

function writeSessionFile(sessionsDir: string, session: AgentSession): void {
  fs.writeFileSync(path.join(sessionsDir, `${session.id}.json`), JSON.stringify(session), 'utf8');
}

function writeIndexFile(sessionsDir: string, indexVersion: number, sessions: AgentSession[]): void {
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
        // Pre-fix index entries carried doneAt: null for these automations —
        // exactly the collapsed/reverted state the v8→v9 rebuild must repair.
        doneAt: (session as { doneAt?: number | null }).doneAt ?? null,
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

describe('IncrementalSessionStore — resolved-automation doneAt backfill (260617)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-done-backfill-'));
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

  async function loadFrom(
    sessions: AgentSession[],
    indexVersion: number,
  ): Promise<{ store: import('../incrementalSessionStore').IncrementalSessionStore; loaded: AgentSession[] }> {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    for (const session of sessions) writeSessionFile(sessionsDir, session);
    writeIndexFile(sessionsDir, indexVersion, sessions);
    const store = new IncrementalSessionStore();
    const loaded = store.loadSync();
    return { store, loaded };
  }

  function hasDoneAtKey(s: AgentSession): boolean {
    return Object.prototype.hasOwnProperty.call(s, 'doneAt');
  }

  it('automation + resolvedAt + no doneAt key → Done (doneAt = resolvedAt)', async () => {
    const { loaded } = await loadFrom(
      [makeSession({ id: 'automation-a--run1', origin: 'automation', resolvedAt: 1750 })],
      9,
    );
    const s = loaded.find((x) => x.id === 'automation-a--run1')!;
    expect(s.doneAt).toBe(1750);
    expect(isSessionDone(s)).toBe(true);
  });

  it('automation + NO resolvedAt → stays Active (no invented done-time)', async () => {
    const { loaded } = await loadFrom(
      [makeSession({ id: 'automation-b--run1', origin: 'automation', resolvedAt: null })],
      9,
    );
    const s = loaded.find((x) => x.id === 'automation-b--run1')!;
    expect(s.doneAt == null).toBe(true);
    expect(isSessionActive(s)).toBe(true);
  });

  it('automation explicitly reopened (doneAt: null key present) → stays Active (preserved)', async () => {
    const { loaded } = await loadFrom(
      [makeSession({ id: 'automation-c--run1', origin: 'automation', resolvedAt: 1750, doneAt: null })],
      9,
    );
    const s = loaded.find((x) => x.id === 'automation-c--run1')!;
    expect(s.doneAt).toBeNull();
    expect(isSessionActive(s)).toBe(true);
  });

  it('automation with doneAt already set → idempotent (preserved, not overwritten by resolvedAt)', async () => {
    const { loaded } = await loadFrom(
      [makeSession({ id: 'automation-d--run1', origin: 'automation', resolvedAt: 1750, doneAt: 999 })],
      9,
    );
    const s = loaded.find((x) => x.id === 'automation-d--run1')!;
    expect(s.doneAt).toBe(999);
    expect(isSessionDone(s)).toBe(true);
  });

  it('manual + resolvedAt + no doneAt key → unaffected (stays Active; scoped to automations)', async () => {
    const { loaded } = await loadFrom(
      [makeSession({ id: 'manual-x', origin: 'manual', resolvedAt: 1750 })],
      9,
    );
    const s = loaded.find((x) => x.id === 'manual-x')!;
    expect(s.doneAt == null).toBe(true);
    expect(isSessionActive(s)).toBe(true);
    expect(hasDoneAtKey(s)).toBe(false);
  });

  it('v8 → v9 rebuild repairs a reverted resolved automation (the user-facing recovery)', async () => {
    // Pre-fix state: index at v8 carries doneAt: null for the automation (reverted
    // to Active by the earlier collapse rebuild); its file has resolvedAt, no doneAt.
    const automation = makeSession({
      id: 'automation-e--run1',
      origin: 'automation',
      resolvedAt: 1750,
      updatedAt: 1750,
    });
    const { store, loaded } = await loadFrom([automation], 8);

    // After the v8→v9 version-backward rebuild, the automation is Done again.
    const s = loaded.find((x) => x.id === 'automation-e--run1')!;
    expect(s.doneAt).toBe(1750);
    expect(isSessionDone(s)).toBe(true);

    // And the rebuilt, persisted index reflects Done (not the stale v8 null).
    const rebuiltIndex = JSON.parse(
      fs.readFileSync(path.join(testDir, 'sessions', 'index.json'), 'utf8'),
    ) as { version: number; sessions: Array<{ id: string; doneAt: number | null }> };
    expect(rebuiltIndex.version).toBe(9);
    const entry = rebuiltIndex.sessions.find((e) => e.id === 'automation-e--run1')!;
    expect(entry.doneAt).toBe(1750);
    void store;
  });

  it('a single-session upsert BEFORE any load (v8 on disk) rebuilds + migrates the OTHER automations', async () => {
    // Regression for the upsert-before-load race: if a background write reaches
    // ensureIndexLoadedForUpsert() while the on-disk index is still v8, it must
    // REBUILD-from-files (applying migrateResolvedAutomationToDone to every file)
    // rather than adopt the stale v8 entries — otherwise the other resolved
    // automations would stay Active until the next restart.
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    // A pre-existing resolved automation whose file lacks doneAt (would revert to
    // Active); it is NOT the session being upserted.
    const other = makeSession({
      id: 'automation-z--run1',
      origin: 'automation',
      resolvedAt: 1750,
      updatedAt: 1750,
    });
    writeSessionFile(sessionsDir, other);
    writeIndexFile(sessionsDir, 8, [other]); // stale v8 index: other.doneAt = null

    const store = new IncrementalSessionStore();
    // Upsert a DIFFERENT, fresh session WITHOUT calling loadSync first.
    await store.upsertSession(makeSession({ id: 'manual-fresh', origin: 'manual', resolvedAt: null }));

    const index = JSON.parse(
      fs.readFileSync(path.join(sessionsDir, 'index.json'), 'utf8'),
    ) as { version: number; sessions: Array<{ id: string; doneAt: number | null }> };
    expect(index.version).toBe(9);
    const otherEntry = index.sessions.find((e) => e.id === 'automation-z--run1')!;
    expect(otherEntry.doneAt).toBe(1750); // migrated to Done by the rebuild, not left Active
  });
});
