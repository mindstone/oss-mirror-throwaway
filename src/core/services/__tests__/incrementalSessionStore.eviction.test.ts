import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AgentSession } from '@shared/types';

/**
 * Eviction polarity test (Stage 2, pinnedAt -> doneAt rename).
 *
 * HIGHEST-STAKES invariant: `evictIfNeeded()` must EVICT ONLY DONE sessions and
 * KEEP ACTIVE ones. A wrong polarity here permanently soft-deletes ACTIVE
 * sessions from disk. These tests partition by lifecycle (Active vs Done) and
 * assert by IDENTITY (which files survive / which are evicted), so they FAIL if
 * the keep/evict sense is inverted — not just on counts.
 *
 * Cap is mocked tiny (`MAX_PERSISTED_SESSIONS = 3`) so eviction triggers with a
 * handful of fixtures; all other constants pass through.
 */

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

const MOCK_CAP = 3;

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess',
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

/** Active: doneAt null. */
function activeSession(id: string, updatedAt: number): AgentSession {
  return makeSession({ id, updatedAt, doneAt: null });
}

/** Done: doneAt non-null. */
function doneSession(id: string, updatedAt: number): AgentSession {
  return makeSession({ id, updatedAt, doneAt: updatedAt });
}

describe('IncrementalSessionStore eviction polarity (Active kept, Done evicted)', () => {
  let testDir: string;
  let sessionsDir: string;
  let deletedDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eviction-polarity-'));
    sessionsDir = path.join(testDir, 'sessions');
    deletedDir = path.join(testDir, 'sessions-deleted');
    vi.resetModules();

    vi.doMock('@core/logger', () => ({
      createScopedLogger: () => stubLogger,
      logger: stubLogger,
    }));
    // Shrink the cap; pass every other constant through unchanged.
    // NB: the store imports '../constants' (= src/core/constants). From this test
    // file (src/core/services/__tests__/) the same module is '../../constants'.
    vi.doMock('../../constants', async () => {
      const actual = await vi.importActual<typeof import('../../constants')>('../../constants');
      return { ...actual, MAX_PERSISTED_SESSIONS: MOCK_CAP };
    });

    await initTestPlatformConfig({ userDataPath: testDir });
    Object.values(stubLogger).forEach((fn) => fn.mockClear());
  });

  afterEach(() => {
    vi.doUnmock('../../constants');
    vi.doUnmock('@core/logger');
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function indexIds(): string[] {
    const index = JSON.parse(
      fs.readFileSync(path.join(sessionsDir, 'index.json'), 'utf8'),
    ) as { sessions: Array<{ id: string }> };
    return index.sessions.map((s) => s.id).sort();
  }

  function sessionFileExists(id: string): boolean {
    return fs.existsSync(path.join(sessionsDir, `${id}.json`));
  }

  function deletedFileExists(id: string): boolean {
    if (!fs.existsSync(deletedDir)) return false;
    return fs.readdirSync(deletedDir).some((f) => f.startsWith(`${id}_`));
  }

  it('evicts only DONE sessions and keeps ALL Active sessions when over cap', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();

    // 3 Active (cap=3) + 2 Done over cap. Overflow = 2; the 2 oldest DONE must be evicted.
    const sessions: AgentSession[] = [
      activeSession('active-a', 5000),
      activeSession('active-b', 4000),
      activeSession('active-c', 3000),
      doneSession('done-old', 1000),
      doneSession('done-newer', 2000),
    ];

    store.saveSync(sessions);

    // Active sessions: files + index rows ALL remain.
    for (const id of ['active-a', 'active-b', 'active-c']) {
      expect(sessionFileExists(id)).toBe(true);
      expect(deletedFileExists(id)).toBe(false);
    }
    // Done sessions: the ONLY eviction candidates — files gone from sessions/, moved to sessions-deleted/.
    for (const id of ['done-old', 'done-newer']) {
      expect(sessionFileExists(id)).toBe(false);
      expect(deletedFileExists(id)).toBe(true);
    }
    expect(indexIds()).toEqual(['active-a', 'active-b', 'active-c']);
  });

  it('keeps a Done session under cap and evicts only the surplus Done by oldest-first', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();

    // 1 Active + 4 Done, cap=3, overflow=2 → evict the 2 OLDEST Done; the newest Done survives.
    const sessions: AgentSession[] = [
      activeSession('active-keep', 9000),
      doneSession('done-1-oldest', 1000),
      doneSession('done-2', 2000),
      doneSession('done-3', 3000),
      doneSession('done-4-newest', 8000),
    ];

    store.saveSync(sessions);

    expect(sessionFileExists('active-keep')).toBe(true);
    expect(sessionFileExists('done-4-newest')).toBe(true);
    expect(sessionFileExists('done-3')).toBe(true);
    expect(sessionFileExists('done-1-oldest')).toBe(false);
    expect(sessionFileExists('done-2')).toBe(false);
    expect(deletedFileExists('done-1-oldest')).toBe(true);
    expect(deletedFileExists('done-2')).toBe(true);
    expect(indexIds()).toEqual(['active-keep', 'done-3', 'done-4-newest']);
  });

  it('NEVER evicts when all over-cap sessions are Active (cap may be exceeded)', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();

    // 5 Active, cap=3, zero Done → nothing is eligible; all 5 survive (cap deliberately exceeded).
    const sessions: AgentSession[] = [
      activeSession('active-1', 1000),
      activeSession('active-2', 2000),
      activeSession('active-3', 3000),
      activeSession('active-4', 4000),
      activeSession('active-5', 5000),
    ];

    store.saveSync(sessions);

    for (const id of ['active-1', 'active-2', 'active-3', 'active-4', 'active-5']) {
      expect(sessionFileExists(id)).toBe(true);
      expect(deletedFileExists(id)).toBe(false);
    }
    expect(indexIds()).toEqual(['active-1', 'active-2', 'active-3', 'active-4', 'active-5']);
  });
});
