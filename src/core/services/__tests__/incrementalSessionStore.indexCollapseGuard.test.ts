/**
 * Regression tests for the index-collapse bug
 * (docs/plans/260616_folders-appear-empty-index-collapse/PLAN.md).
 *
 * Root cause: `countUserMessages` did `session.messages.filter(...)` unguarded.
 * A session file whose hydrated `messages` was undefined crashed it; because the
 * per-session summary build inside `writeIndex(Sync)` had NO try/catch, ONE bad
 * session aborted the whole index rebuild → the session index collapsed from
 * 2,735 entries to 67 → folders appeared empty. Exposed by the forced
 * INDEX_VERSION 7→8 rebuild.
 *
 * Stages covered:
 *  - Stage 1: `countUserMessages` tolerates undefined/non-array `messages`.
 *  - Stage 2: a rebuild over a corpus with a malformed session indexes ALL the
 *    good ones (incl. a foldered member) and contains the bad one (degraded
 *    `isCorrupted` row or skip-with-log) rather than aborting.
 *  - Stage 4: a session file written without a `messages` key hydrates with
 *    `messages === []`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AgentSession } from '@shared/types';
import { countUserMessages, INDEX_VERSION } from '../incrementalSessionStore';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess',
    title: 'A Session',
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

describe('countUserMessages — Stage 1 guard', () => {
  it('returns 0 for a session with undefined messages (no throw)', () => {
    expect(() =>
      countUserMessages({ messages: undefined as unknown as AgentSession['messages'] }),
    ).not.toThrow();
    expect(
      countUserMessages({ messages: undefined as unknown as AgentSession['messages'] }),
    ).toBe(0);
  });

  it('returns 0 for an empty object (messages missing entirely)', () => {
    expect(countUserMessages({} as Pick<AgentSession, 'messages'>)).toBe(0);
  });

  it('returns 0 for a non-array messages value', () => {
    expect(
      countUserMessages({ messages: 'oops' as unknown as AgentSession['messages'] }),
    ).toBe(0);
  });

  it('counts user messages normally when messages is a valid array', () => {
    const session = {
      messages: [
        { role: 'user', text: 'a' },
        { role: 'assistant', text: 'b' },
        { role: 'user', text: 'c' },
      ],
    } as unknown as Pick<AgentSession, 'messages'>;
    expect(countUserMessages(session)).toBe(2);
  });
});

describe('IncrementalSessionStore — index-collapse containment + load-boundary hardening', () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-collapse-guard-'));
    sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
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

  /** Writes a raw session record to disk. `raw` is written verbatim (so we can omit keys). */
  function writeRaw(sessionId: string, raw: Record<string, unknown>): void {
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify(raw), 'utf8');
  }

  function readIndex(): { version: number; sessions: Array<Record<string, unknown>> } {
    return JSON.parse(
      fs.readFileSync(path.join(sessionsDir, 'index.json'), 'utf8'),
    ) as { version: number; sessions: Array<Record<string, unknown>> };
  }

  /** Builds a valid current-version ('ok') index entry for the given session. */
  function makeIndexEntry(session: AgentSession): Record<string, unknown> {
    return {
      id: session.id,
      title: session.title ?? null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      resolvedAt: session.resolvedAt ?? null,
      doneAt: session.doneAt ?? null,
      starredAt: session.starredAt ?? null,
      deletedAt: session.deletedAt ?? null,
      origin: session.origin ?? 'manual',
      isCorrupted: false,
      privateMode: session.privateMode ?? false,
      interruptedTurnId: null,
      preview: '',
      firstMessagePreview: '',
      messageCount: 0,
      hasDraft: false,
      draftPreview: null,
      draftUpdatedAt: null,
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      fingerprint: `${session.updatedAt}:test`,
    };
  }

  /** Writes an index.json at the given version containing exactly `sessions`. */
  function writeIndexAtVersion(sessions: AgentSession[], version: number): void {
    fs.writeFileSync(
      path.join(sessionsDir, 'index.json'),
      JSON.stringify({
        version,
        lastUpdated: 1000,
        sessions: sessions.map(makeIndexEntry),
      }),
      'utf8',
    );
  }

  /** Writes a valid current-version ('ok') index.json containing exactly `sessions`. */
  function writeCurrentIndex(sessions: AgentSession[]): void {
    writeIndexAtVersion(sessions, INDEX_VERSION);
  }

  it('Stage 4: a session file written without a `messages` key hydrates with messages === []', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    // Deliberately omit `messages` entirely (partial/malformed file shape).
    const raw = { ...makeSession({ id: 'no-messages' }) } as Record<string, unknown>;
    delete raw.messages;
    writeRaw('no-messages', raw);

    const store = new IncrementalSessionStore();
    const loaded = store.loadSync();
    const session = loaded.find((s) => s.id === 'no-messages');
    expect(session).toBeDefined();
    expect(Array.isArray(session!.messages)).toBe(true);
    expect(session!.messages).toEqual([]);
  });

  it('Stage 1+2: rebuild over a corpus with malformed sessions indexes ALL good sessions (incl. a foldered member) and does NOT abort', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');

    // 3 good sessions. `folder-member` simulates a session that belongs to a
    // folder — the bug made such members vanish from the index, so it MUST
    // reappear after the rebuild.
    writeRaw('good-1', {
      ...makeSession({
        id: 'good-1',
        messages: [{ role: 'user', text: 'hi' }] as AgentSession['messages'],
      }),
    });
    writeRaw('folder-member', {
      ...makeSession({
        id: 'folder-member',
        title: 'Community cohort coaching',
        messages: [{ role: 'user', text: 'q' }] as AgentSession['messages'],
      }),
    });
    writeRaw('good-2', {
      ...makeSession({
        id: 'good-2',
        messages: [
          { role: 'user', text: 'a' },
          { role: 'assistant', text: 'b' },
        ] as AgentSession['messages'],
      }),
    });

    // Malformed A: no `messages` key (Stage 1 + Stage 4 path) — must still index.
    const noMessages = { ...makeSession({ id: 'bad-no-messages' }) } as Record<string, unknown>;
    delete noMessages.messages;
    writeRaw('bad-no-messages', noMessages);

    // Malformed B: a `messages` array containing a NULL element — `messages` is
    // an array (so coerceMessagesArray leaves it), but countUserMessages does
    // `m.role` on the null element → throws inside createSummary. (A non-array
    // eventsByTurn no longer throws — Rec 2 coerces it — so we use a vector that
    // survives all load-boundary coercion.) This exercises the Stage 2
    // per-session try/catch directly, not just the Stage 1 guard.
    writeRaw('bad-events', {
      ...makeSession({ id: 'bad-events' }),
      messages: [null] as unknown as AgentSession['messages'],
    });

    const store = new IncrementalSessionStore();
    // No index.json on disk → missing-index path → rebuildIndexFromFilesSync.
    const loaded = store.loadSync();

    const index = readIndex();
    const indexedIds = new Set(index.sessions.map((e) => e.id as string));

    // All three good sessions (including the foldered member) are present.
    expect(indexedIds.has('good-1')).toBe(true);
    expect(indexedIds.has('good-2')).toBe(true);
    expect(indexedIds.has('folder-member')).toBe(true);

    // The no-messages file is recovered (Stage 4 coercion) as a normal row.
    expect(indexedIds.has('bad-no-messages')).toBe(true);

    // The throwing session is CONTAINED, not allowed to abort the rebuild:
    // either surfaced as a degraded isCorrupted row, or skipped-with-log.
    const badEventsEntry = index.sessions.find((e) => e.id === 'bad-events');
    if (badEventsEntry) {
      expect(badEventsEntry.isCorrupted).toBe(true);
    } else {
      // skip-with-log fallback: not present, but the rebuild still completed.
      expect(indexedIds.has('bad-events')).toBe(false);
    }

    // The rebuild produced an index with the good sessions — it did NOT collapse.
    expect(loaded.some((s) => s.id === 'good-1')).toBe(true);
    expect(loaded.some((s) => s.id === 'good-2')).toBe(true);
    expect(loaded.some((s) => s.id === 'folder-member')).toBe(true);
  });

  it('Stage 2: createSummary on a session with undefined messages does not throw and yields userMessageCount 0', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const noMessages = { ...makeSession({ id: 'summary-no-messages' }) } as Record<string, unknown>;
    delete noMessages.messages;
    writeRaw('summary-no-messages', noMessages);

    const store = new IncrementalSessionStore();
    store.loadSync();
    const index = readIndex();
    const entry = index.sessions.find((e) => e.id === 'summary-no-messages');
    expect(entry).toBeDefined();
    expect(entry!.userMessageCount).toBe(0);
    expect(entry!.isCorrupted).toBe(false); // coerced to a valid empty session, not corrupt
  });

  it('Stage 3: a collapsed-but-valid index self-heals — listSessions detects the collapse, falls through, and recovers ALL on-disk sessions (incl. a foldered member)', async () => {
    const { setErrorReporter } = await import('@core/errorReporter');
    const captureException = vi.fn();
    setErrorReporter({ captureException, captureMessage: () => {}, addBreadcrumb: () => {} });
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');

    // Many valid session files on disk (well above the 50 orphan threshold).
    const COLLAPSE_FILE_COUNT = 120;
    const allSessions: AgentSession[] = [];
    for (let i = 0; i < COLLAPSE_FILE_COUNT; i++) {
      const id = `collapse-sess-${i}`;
      const session = makeSession({
        id,
        title: i === 7 ? 'Community cohort coaching' : `Session ${i}`,
        messages: [{ role: 'user', text: 'hi' }] as AgentSession['messages'],
      });
      allSessions.push(session);
      writeRaw(id, { ...session });
    }
    const folderedId = allSessions[7].id; // the "foldered member" that vanished

    // A COLLAPSED index: only the first 3 ids are present (mirrors the 67-vs-2882 incident).
    writeCurrentIndex(allSessions.slice(0, 3));

    const store = new IncrementalSessionStore();
    const summaries = store.listSessions({ includeInternal: true });

    // Self-heal: the in-memory index now contains ALL on-disk sessions, not the truncated 3.
    const recoveredIds = new Set(summaries.map((s) => s.id));
    expect(summaries.length).toBe(COLLAPSE_FILE_COUNT);
    expect(recoveredIds.has(folderedId)).toBe(true);
    for (const session of allSessions) {
      expect(recoveredIds.has(session.id)).toBe(true);
    }

    // The collapse was OBSERVABLE (warn logged), not a silent fall-through.
    expect(stubLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orphanCount: expect.any(Number) }),
      expect.stringContaining('index appears collapsed'),
    );

    // Efficacy (Arbitrator canary, 260621): the collapse is now ALERTABLE, not
    // just a local breadcrumb — captureKnownCondition fires with the stable
    // fingerprint, warning level (it self-heals), and counts-ONLY context. This
    // is the signal that would have fired on the historical #3 shape.
    const collapseCall = captureException.mock.calls.find(
      ([, ctx]) =>
        (ctx as { fingerprint?: string[] } | undefined)?.fingerprint?.[0] ===
        'session-index-collapse-detected',
    );
    expect(collapseCall).toBeDefined();
    const collapseCtx = collapseCall![1] as { level: string; extra: Record<string, unknown> };
    expect(collapseCtx.level).toBe('warning');
    // EXACT counts + no other keys (review F1): asserts the counts-only / no-PII
    // contract — a future accidental id/path/title in `extra` fails this toEqual.
    expect(collapseCtx.extra).toEqual({ indexCount: 3, orphanCount: 117, fileCount: 120 });

    // The healed index was persisted to disk with all sessions.
    const persisted = readIndex();
    expect(persisted.sessions.length).toBe(COLLAPSE_FILE_COUNT);
  });

  it('Stage 3 (negative): a healthy index with a small handful of orphans is adopted via the fast path and does NOT fall through', async () => {
    const { setErrorReporter } = await import('@core/errorReporter');
    const captureException = vi.fn();
    setErrorReporter({ captureException, captureMessage: () => {}, addBreadcrumb: () => {} });
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');

    // 10 session files; index lists 8 of them → orphanCount = 2 (below the 50 threshold).
    const sessions: AgentSession[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `healthy-sess-${i}`;
      const session = makeSession({
        id,
        messages: [{ role: 'user', text: 'hi' }] as AgentSession['messages'],
      });
      sessions.push(session);
      writeRaw(id, { ...session });
    }
    // Index includes only the first 8 — a benign post-crash handful of 2 orphans.
    writeCurrentIndex(sessions.slice(0, 8));

    const store = new IncrementalSessionStore();
    const summaries = store.listSessions({ includeInternal: true });

    // Fast path adopted the index AS-IS (8 entries) — the 2 orphans did NOT
    // trigger the collapse fall-through (we must not defeat the fast path on a
    // benign handful).
    expect(summaries.length).toBe(8);
    expect(stubLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('index appears collapsed'),
    );

    // Alert-fatigue bound (Arbitrator canary): a benign handful of orphans must
    // NOT fire the collapse canary — otherwise it would page on routine post-crash
    // index lag rather than only on a genuine catastrophic collapse.
    expect(captureException).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fingerprint: ['session-index-collapse-detected'] }),
    );
  });

  it('F2: a messages-coerced session is marked hydration-mutated (so the malformed file is repaired on next save)', async () => {
    // NOTE: import the predicate from the SAME (post-resetModules) module
    // instance as the store — the SANITIZED_SESSIONS WeakSet is module-scoped, so
    // a statically-imported predicate would read a different instance's set.
    const { IncrementalSessionStore, isSessionSanitizedDuringHydration } = await import(
      '../incrementalSessionStore'
    );
    // Malformed file: no `messages` key → coercion fires.
    const raw = { ...makeSession({ id: 'coerced-sanitized' }) } as Record<string, unknown>;
    delete raw.messages;
    writeRaw('coerced-sanitized', raw);
    // A clean control session (messages present) must NOT be marked.
    writeRaw('clean-control', {
      ...makeSession({
        id: 'clean-control',
        messages: [{ role: 'user', text: 'hi' }] as AgentSession['messages'],
      }),
    });

    const store = new IncrementalSessionStore();
    const loaded = store.loadSync();
    const coerced = loaded.find((s) => s.id === 'coerced-sanitized');
    const clean = loaded.find((s) => s.id === 'clean-control');
    expect(coerced).toBeDefined();
    expect(clean).toBeDefined();
    expect(isSessionSanitizedDuringHydration(coerced!)).toBe(true);
    expect(isSessionSanitizedDuringHydration(clean!)).toBe(false);
  });

  it('F1: a read-only store with a collapsed index still surfaces the FULL recovered corpus in memory (not the collapsed subset)', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');

    // Many valid session files on disk (well above the 50 orphan threshold).
    const FILE_COUNT = 120;
    const allSessions: AgentSession[] = [];
    for (let i = 0; i < FILE_COUNT; i++) {
      const id = `ro-sess-${i}`;
      const session = makeSession({
        id,
        title: i === 9 ? 'Community cohort coaching' : `Session ${i}`,
        messages: [{ role: 'user', text: 'hi' }] as AgentSession['messages'],
      });
      allSessions.push(session);
      writeRaw(id, { ...session });
    }
    const folderedId = allSessions[9].id;

    // A COLLAPSED index that is also VERSION-FORWARD (version = INDEX_VERSION+1).
    // The forward version drives the store into protective READ-ONLY mode on load
    // (the test seam for read-only), while still loading + recovering orphans.
    writeIndexAtVersion(allSessions.slice(0, 3), INDEX_VERSION + 1);

    const store = new IncrementalSessionStore();
    const summaries = store.listSessions({ includeInternal: true });

    // F1: even though the store can't persist (read-only), the in-memory index
    // must reflect the FULL recovered corpus this session — not the collapsed 3.
    const recoveredIds = new Set(summaries.map((s) => s.id));
    expect(summaries.length).toBe(FILE_COUNT);
    expect(recoveredIds.has(folderedId)).toBe(true);
    for (const session of allSessions) {
      expect(recoveredIds.has(session.id)).toBe(true);
    }

    // The inability to persist the healed index was OBSERVABLE (loud warn).
    expect(stubLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ recoveredCount: expect.any(Number) }),
      expect.stringContaining('could not be persisted (read-only mode)'),
    );

    // And the on-disk index was NOT rewritten (still the collapsed 3, read-only).
    const persisted = readIndex();
    expect(persisted.sessions.length).toBe(3);
  });

  it('Rec 2: a session with a non-array `eventsByTurn` turn value summarizes cleanly (NOT isCorrupted) after coercion', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');

    // Valid messages, but a malformed eventsByTurn (a turn value that isn't an
    // array). Before Rec 2 this survived only as a degraded isCorrupted row
    // (Stage 2 containment caught the throw); coercion lets it summarize normally.
    writeRaw('bad-events-coerced', {
      ...makeSession({
        id: 'bad-events-coerced',
        messages: [{ role: 'user', text: 'hi' }] as AgentSession['messages'],
      }),
      eventsByTurn: { turn1: 42 },
    });

    const store = new IncrementalSessionStore();
    store.loadSync();
    const index = readIndex();
    const entry = index.sessions.find((e) => e.id === 'bad-events-coerced');
    expect(entry).toBeDefined();
    // Summarized NORMALLY — not a degraded corrupt row.
    expect(entry!.isCorrupted).toBe(false);
    // Valid messages preserved → userMessageCount reflects them.
    expect(entry!.userMessageCount).toBe(1);
  });

  it('Rec 2: a session with a non-object `eventsByTurn` coerces to {} and is marked hydration-mutated', async () => {
    const { IncrementalSessionStore, isSessionSanitizedDuringHydration } = await import(
      '../incrementalSessionStore'
    );
    writeRaw('bad-events-nonobject', {
      ...makeSession({
        id: 'bad-events-nonobject',
        messages: [{ role: 'user', text: 'hi' }] as AgentSession['messages'],
      }),
      eventsByTurn: 'not-an-object',
    });

    const store = new IncrementalSessionStore();
    const loaded = store.loadSync();
    const session = loaded.find((s) => s.id === 'bad-events-nonobject');
    expect(session).toBeDefined();
    expect(session!.eventsByTurn).toEqual({});
    expect(isSessionSanitizedDuringHydration(session!)).toBe(true);
  });
});

describe('IncrementalSessionStore — catastrophic load failure is observable (Pathologist Rec 1)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-observability-'));
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doMock('@core/logger', () => ({
      createScopedLogger: () => stubLogger,
      logger: stubLogger,
    }));
    await initTestPlatformConfig({ userDataPath: testDir });
    Object.values(stubLogger).forEach((fn) => fn.mockClear());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('reports a catastrophic loadSync() failure to the error reporter (genuine-error catch path)', async () => {
    // Force a catastrophic failure inside the outer try (NOT the fresh-install
    // happy path): make the store's `fs.existsSync` (its very first try
    // statement) throw. `vi.spyOn` can't redefine an ESM namespace export, so we
    // mock the `fs` module the store imports, delegating every method to real fs
    // except `existsSync` which throws.
    const boom = new Error('disk exploded');
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    vi.doMock('fs', () => ({
      ...realFs,
      default: realFs,
      existsSync: () => {
        throw boom;
      },
    }));

    const { setErrorReporter } = await import('@core/errorReporter');
    const captureException = vi.fn();
    setErrorReporter({
      captureException,
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');

    const store = new IncrementalSessionStore();
    const result = store.loadSync();

    // Recovery behavior unchanged: still returns [].
    expect(result).toEqual([]);
    // But the catastrophe is now OBSERVABLE.
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ operation: 'incrementalSessionStore.loadSync' }),
      }),
    );
    vi.doUnmock('fs');
  });

  it('does NOT report on the benign fresh-install empty path (no catch)', async () => {
    const { setErrorReporter } = await import('@core/errorReporter');
    const captureException = vi.fn();
    setErrorReporter({
      captureException,
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    // Fresh testDir: no agent-sessions, no index, no sessions dir, no legacy →
    // returns [] WITHOUT going through the catch.
    const store = new IncrementalSessionStore();
    const result = store.loadSync();

    expect(result).toEqual([]);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('F1: a THROWING error reporter does not alter loadSync() recovery — still returns [] and does not propagate', async () => {
    // Catastrophic load failure (existsSync throws) AND a reporter that throws.
    // The local guard must absorb the reporter throw so recovery still returns [].
    const boom = new Error('disk exploded');
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    vi.doMock('fs', () => ({
      ...realFs,
      default: realFs,
      existsSync: () => {
        throw boom;
      },
    }));

    const { setErrorReporter } = await import('@core/errorReporter');
    const reporterError = new Error('sentry exploded');
    const captureException = vi.fn(() => {
      throw reporterError;
    });
    setErrorReporter({
      captureException,
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();

    // Must NOT propagate the reporter error; recovery still yields [].
    let result: unknown;
    expect(() => {
      result = store.loadSync();
    }).not.toThrow();
    expect(result).toEqual([]);
    expect(captureException).toHaveBeenCalledTimes(1);

    vi.doUnmock('fs');
  });

  it('reports a catastrophic async load() failure to the error reporter (genuine-error catch path)', async () => {
    const boom = new Error('disk exploded (async)');
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    vi.doMock('fs', () => ({
      ...realFs,
      default: realFs,
      existsSync: () => {
        throw boom;
      },
    }));

    const { setErrorReporter } = await import('@core/errorReporter');
    const captureException = vi.fn();
    setErrorReporter({
      captureException,
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();
    const result = await store.load();

    expect(result).toEqual([]);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ operation: 'incrementalSessionStore.load' }),
      }),
    );

    vi.doUnmock('fs');
  });

  it('async load(): does NOT report on the benign fresh-install empty path (no catch)', async () => {
    const { setErrorReporter } = await import('@core/errorReporter');
    const captureException = vi.fn();
    setErrorReporter({
      captureException,
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();
    const result = await store.load();

    expect(result).toEqual([]);
    expect(captureException).not.toHaveBeenCalled();
  });
});

/**
 * 260617 crash repro — a non-session `*.json` (not in NON_SESSION_FILES) whose
 * loaded content carries no `id` was treated as a session by `isSessionFile()`,
 * hydrated into a session with `id === undefined`, and let into the index via
 * `createSummary({ id: undefined })`. `listSessions()` then called
 * `isSidebarHiddenSession(undefined)` → `classifySessionKind(undefined)` →
 * TypeError on `.startsWith`, aborting the whole list (empty sidebar/folders).
 *
 * Stage 1 closes the filename-vs-content id gap by construction (Fix 2): a
 * loaded session whose `id` is not a non-empty string OR does not match the
 * filename-derived id is treated as NON-session (skip-with-observable-log), and
 * `buildContainedIndexEntry`/`createSummary` refuse to admit a non-string id.
 */
describe('IncrementalSessionStore — non-session sidecar id-gap (260617 crash repro)', () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-id-gap-'));
    sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
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

  function writeFile(name: string, raw: Record<string, unknown>): void {
    fs.writeFileSync(path.join(sessionsDir, name), JSON.stringify(raw), 'utf8');
  }

  it('listSessions() does NOT throw when a no-id sidecar JSON sits in sessions/, and the sidecar is NOT listed as a session', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');

    // A real session that MUST survive.
    writeFile('good-1.json', { ...makeSession({ id: 'good-1' }) });

    // A future/foreign non-session JSON the allow-list doesn't know about; its
    // payload has NO `id`. (e.g. a new cloud sidecar from a newer app build.)
    writeFile('cloud-future-thing.json', {
      version: 9,
      lastSyncedAt: 1234,
      payload: { whatever: true },
    });

    // No index.json on disk → listSessions() falls back to loadSync(), which
    // rebuilds from files. Default options ⇒ includeInternal:false ⇒ the
    // crashing isSidebarHiddenSession(summary.id) path runs.
    const store = new IncrementalSessionStore();
    let summaries!: ReturnType<typeof store.listSessions>;
    expect(() => {
      summaries = store.listSessions();
    }).not.toThrow();

    const ids = summaries.map((s) => s.id);
    expect(ids).toContain('good-1');
    // The sidecar must NOT have entered the index — neither under its
    // filename-derived id nor as an undefined id.
    expect(ids).not.toContain('cloud-future-thing');
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('a session file whose content id MISMATCHES the filename is treated as non-session (not listed)', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');

    writeFile('good-1.json', { ...makeSession({ id: 'good-1' }) });
    // Filename says `mismatch`, content claims a different id.
    writeFile('mismatch.json', { ...makeSession({ id: 'some-other-id' }) });

    const store = new IncrementalSessionStore();
    const summaries = store.listSessions();
    const ids = summaries.map((s) => s.id);
    expect(ids).toContain('good-1');
    expect(ids).not.toContain('mismatch');
    expect(ids).not.toContain('some-other-id');
  });

  it('F5 (260617): refreshSessionIndexSummaries rejects an index.json with an undefined-id row (validator, not raw-parse)', async () => {
    const { IncrementalSessionStore, INDEX_VERSION } = await import('../incrementalSessionStore');

    // Write a current-version index whose only row has NO id — the previous
    // raw `JSON.parse(...) as SessionIndex` would have accepted it into
    // `this.index`. parseAndValidateIndex must classify it 'corrupt' so the
    // malformed row never lands in memory.
    fs.writeFileSync(
      path.join(sessionsDir, 'index.json'),
      JSON.stringify({
        version: INDEX_VERSION,
        lastUpdated: 1000,
        sessions: [{ title: 'no id here', createdAt: 1, updatedAt: 2 }],
      }),
      'utf8',
    );

    const store = new IncrementalSessionStore();
    // refreshSessionIndexSummaries loads index lazily when this.index is null.
    const refreshed = await store.refreshSessionIndexSummaries([
      makeSession({ id: 'good-1' }),
    ]);
    // Malformed index ⇒ skip the refresh entirely (0), and no malformed row
    // entered the in-memory index → listSessions must not throw or surface a
    // bad id.
    expect(refreshed).toBe(0);
    expect(() => store.listSessions()).not.toThrow();
    const ids = store.listSessions().map((s) => s.id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });
});

/**
 * Stage 2 (260617, REBEL-1C8 class) — a TRANSIENT EMFILE/ENFILE on the
 * SYNCHRONOUS `readFileSync(index.json)` must be (a) retried, (b) NOT classified
 * 'corrupt', (c) NEVER trigger `.bak` recovery / rebuild-from-files, and (d) be
 * observable. graceful-fs cannot reach `*Sync`, so under fd pressure (the
 * always-on startup time-saved repair) a transient EMFILE used to throw → be
 * caught as "index corrupted" → recover from `.bak` / rebuild — a transient,
 * byte-identical "corruption" loop. GENUINE corruption (file reads fine but JSON
 * is unparseable) must STILL route to `.bak` recovery.
 */
describe('IncrementalSessionStore — transient EMFILE index read is not corruption (260617)', () => {
  let testDir: string;
  let sessionsDir: string;

  function emfile(): NodeJS.ErrnoException {
    const err = new Error('EMFILE: too many open files') as NodeJS.ErrnoException;
    err.code = 'EMFILE';
    return err;
  }

  /**
   * Writes a valid current-version index.json + matching session files using
   * RAW fs (NOT the store), so the store module registry stays clean for the
   * per-test fs mock and we control exactly which files exist (no incidental
   * `.bak`). `version` is read from a throwaway store import that is then
   * dropped via resetModules().
   */
  async function seedHealthyIndex(indexVersion: number): Promise<void> {
    const sessions = [
      makeSession({ id: 'sess-a', title: 'A' }),
      makeSession({ id: 'sess-b', title: 'B' }),
    ];
    for (const s of sessions) {
      fs.writeFileSync(path.join(sessionsDir, `${s.id}.json`), JSON.stringify(s), 'utf8');
    }
    fs.writeFileSync(
      path.join(sessionsDir, 'index.json'),
      JSON.stringify({
        version: indexVersion,
        lastUpdated: 1000,
        sessions: sessions.map((s) => ({
          id: s.id,
          title: s.title ?? null,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          resolvedAt: s.resolvedAt ?? null,
          doneAt: (s as { doneAt?: number | null }).doneAt ?? null,
          starredAt: (s as { starredAt?: number | null }).starredAt ?? null,
          deletedAt: (s as { deletedAt?: number | null }).deletedAt ?? null,
          origin: 'manual',
          isCorrupted: false,
          privateMode: false,
          interruptedTurnId: null,
          preview: '',
          firstMessagePreview: '',
          messageCount: 0,
          hasDraft: false,
          draftPreview: null,
          draftUpdatedAt: null,
          usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
          activeTurnId: null,
          isBusy: false,
          lastError: null,
          fingerprint: `${s.updatedAt}:test`,
        })),
      }),
      'utf8',
    );
    expect(fs.existsSync(path.join(sessionsDir, 'index.json'))).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, 'index.json.bak'))).toBe(false);
  }

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transient-emfile-'));
    sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doMock('@core/logger', () => ({
      createScopedLogger: () => stubLogger,
      logger: stubLogger,
    }));
    await initTestPlatformConfig({ userDataPath: testDir });
    Object.values(stubLogger).forEach((fn) => fn.mockClear());
  });

  afterEach(() => {
    vi.doUnmock('fs');
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('loadSync(): EMFILE on index.json is RETRIED, not classified corrupt, and does NOT recover from .bak or rebuild', async () => {
    await seedHealthyIndex(INDEX_VERSION);
    const indexPath = path.join(sessionsDir, 'index.json');
    const backupPath = path.join(sessionsDir, 'index.json.bak');

    const realFs = await vi.importActual<typeof import('fs')>('fs');
    // EMFILE on the FIRST read attempt of index.json; the single sync retry must
    // succeed (proves it is retried, not immediately treated as corrupt).
    let indexReadAttempts = 0;
    vi.doMock('fs', () => ({
      ...realFs,
      default: realFs,
      readFileSync: (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (typeof p === 'string' && p === indexPath) {
          indexReadAttempts += 1;
          if (indexReadAttempts === 1) throw emfile();
        }
        return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
      },
    }));

    const { setErrorReporter } = await import('@core/errorReporter');
    const captureException = vi.fn();
    setErrorReporter({ captureException, captureMessage: () => {}, addBreadcrumb: () => {} });

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();

    // No .bak exists; if the code had recovered-from-.bak or rebuilt, the
    // disk would have been mutated. We assert it was NOT.
    const indexBefore = realFs.readFileSync(indexPath, 'utf8');
    expect(fs.existsSync(backupPath)).toBe(false);

    let loaded!: AgentSession[];
    expect(() => {
      loaded = store.loadSync();
    }).not.toThrow();

    // Retried (2 attempts) and SUCCEEDED — full healthy corpus loaded.
    expect(indexReadAttempts).toBe(2);
    expect(loaded.map((s) => s.id).sort()).toEqual(['sess-a', 'sess-b']);
    // index.json untouched; no rebuild/recovery occurred.
    expect(realFs.readFileSync(indexPath, 'utf8')).toBe(indexBefore);
  });

  it('listSessions(): persistent EMFILE degrades (empty this call) WITHOUT rebuild/.bak recovery, and is observable', async () => {
    await seedHealthyIndex(INDEX_VERSION);
    const indexPath = path.join(sessionsDir, 'index.json');
    const backupPath = path.join(sessionsDir, 'index.json.bak');

    const realFs = await vi.importActual<typeof import('fs')>('fs');
    // EMFILE on EVERY read of index.json (retry also fails) → transient degrade.
    vi.doMock('fs', () => ({
      ...realFs,
      default: realFs,
      readFileSync: (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (typeof p === 'string' && (p === indexPath || p === backupPath)) {
          throw emfile();
        }
        return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
      },
    }));

    const { setErrorReporter } = await import('@core/errorReporter');
    const captureException = vi.fn();
    setErrorReporter({ captureException, captureMessage: () => {}, addBreadcrumb: () => {} });

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();

    const indexBefore = realFs.readFileSync(indexPath, 'utf8');

    let summaries!: ReturnType<typeof store.listSessions>;
    expect(() => {
      summaries = store.listSessions();
    }).not.toThrow();

    // Degrade: empty for THIS call (no in-memory index yet), NOT a rebuild.
    expect(summaries).toEqual([]);
    // CRITICAL: disk untouched — no .bak written, index.json byte-identical, and
    // the session files still on disk (a rebuild would have rewritten the index).
    expect(fs.existsSync(backupPath)).toBe(false);
    expect(realFs.readFileSync(indexPath, 'utf8')).toBe(indexBefore);
    expect(fs.existsSync(path.join(sessionsDir, 'sess-a.json'))).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, 'sess-b.json'))).toBe(true);
    // Observable: a transient-read capture fired (warning level).
    expect(captureException).toHaveBeenCalled();
    const fired = captureException.mock.calls.some(
      ([, ctx]) =>
        (ctx as { fingerprint?: string[] })?.fingerprint?.[0] === 'session-index-transient-read',
    );
    expect(fired).toBe(true);
  });

  it('GENUINE corruption (readable but unparseable index.json) STILL routes to .bak recovery (no regression)', async () => {
    await seedHealthyIndex(INDEX_VERSION);
    const indexPath = path.join(sessionsDir, 'index.json');
    const backupPath = path.join(sessionsDir, 'index.json.bak');

    // Capture the healthy index, then plant a good .bak and corrupt the primary.
    const good = fs.readFileSync(indexPath, 'utf8');
    fs.writeFileSync(backupPath, good, 'utf8');
    fs.writeFileSync(indexPath, '{ this is not valid json ', 'utf8');

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();
    const loaded = store.loadSync();

    // .bak recovery healed the corpus (both sessions present) — corruption path
    // is unchanged by the transient handling.
    expect(loaded.map((s) => s.id).sort()).toEqual(['sess-a', 'sess-b']);
    // Primary was restored from the good backup (no longer the garbage bytes).
    expect(() => JSON.parse(fs.readFileSync(indexPath, 'utf8'))).not.toThrow();
  });

  // F2a: a good .bak is SERVED IN MEMORY on transient degrade (not empty), and
  // the primary index.json is NOT overwritten from it.
  it('listSessions(): transient EMFILE serves index.json.bak IN MEMORY (no primary write) when a good .bak exists', async () => {
    await seedHealthyIndex(INDEX_VERSION);
    const indexPath = path.join(sessionsDir, 'index.json');
    const backupPath = path.join(sessionsDir, 'index.json.bak');
    // Plant a good .bak (same content as the healthy primary).
    fs.writeFileSync(backupPath, fs.readFileSync(indexPath, 'utf8'), 'utf8');

    const realFs = await vi.importActual<typeof import('fs')>('fs');
    // EMFILE on the PRIMARY index.json (every read), but the .bak reads fine.
    vi.doMock('fs', () => ({
      ...realFs,
      default: realFs,
      readFileSync: (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (typeof p === 'string' && p === indexPath) throw emfile();
        return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
      },
    }));

    const { setErrorReporter } = await import('@core/errorReporter');
    setErrorReporter({ captureException: vi.fn(), captureMessage: () => {}, addBreadcrumb: () => {} });

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();
    const backupBefore = realFs.readFileSync(backupPath, 'utf8');
    const indexBefore = realFs.readFileSync(indexPath, 'utf8');

    const summaries = store.listSessions();
    // Served from .bak (populated), NOT empty.
    expect(summaries.map((s) => s.id).sort()).toEqual(['sess-a', 'sess-b']);
    // Primary NOT overwritten from .bak (it's probably healthy, just unreadable),
    // and .bak untouched.
    expect(realFs.readFileSync(indexPath, 'utf8')).toBe(indexBefore);
    expect(realFs.readFileSync(backupPath, 'utf8')).toBe(backupBefore);
  });
});

/**
 * Stage 2 round-2 (260617, F1 data-HIDING regression) — after a transient
 * EMFILE startup degrade left `this.index === null`, a later normal async
 * `upsertSessionWithOutcome` must NOT init a one-row index and overwrite the
 * intact multi-entry index.json on disk. It must reload the on-disk index first
 * (same safe path as the sync reload-upsert) and MERGE, or DEFER the index write
 * if the reload is itself transient.
 */
describe('IncrementalSessionStore — async upsert reload-safety after transient degrade (260617 F1)', () => {
  let testDir: string;
  let sessionsDir: string;

  function emfile(): NodeJS.ErrnoException {
    const err = new Error('EMFILE: too many open files') as NodeJS.ErrnoException;
    err.code = 'EMFILE';
    return err;
  }

  function writeRealIndex(version: number, ids: string[]): void {
    for (const id of ids) {
      fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(makeSession({ id })), 'utf8');
    }
    fs.writeFileSync(
      path.join(sessionsDir, 'index.json'),
      JSON.stringify({
        version,
        lastUpdated: 1000,
        sessions: ids.map((id) => ({
          id,
          title: id,
          createdAt: 1000,
          updatedAt: 2000,
          resolvedAt: null,
          doneAt: null,
          starredAt: null,
          deletedAt: null,
          origin: 'manual',
          isCorrupted: false,
          privateMode: false,
          interruptedTurnId: null,
          preview: '',
          firstMessagePreview: '',
          messageCount: 0,
          hasDraft: false,
          draftPreview: null,
          draftUpdatedAt: null,
          usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
          activeTurnId: null,
          isBusy: false,
          lastError: null,
          fingerprint: `2000:${id}`,
        })),
      }),
      'utf8',
    );
  }

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'async-upsert-reload-'));
    sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doMock('@core/logger', () => ({
      createScopedLogger: () => stubLogger,
      logger: stubLogger,
    }));
    await initTestPlatformConfig({ userDataPath: testDir });
    Object.values(stubLogger).forEach((fn) => fn.mockClear());
  });

  afterEach(() => {
    vi.doUnmock('fs');
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('degrade-to-null THEN upsert (FD pressure eased) MERGES into the real index — does NOT shrink it to one row', async () => {
    // A real 3-entry index on disk, no .bak.
    writeRealIndex(INDEX_VERSION, ['keep-1', 'keep-2', 'keep-3']);
    const indexPath = path.join(sessionsDir, 'index.json');

    const realFs = await vi.importActual<typeof import('fs')>('fs');
    // Toggle: EMFILE on index.json ONLY while `pressure` is true.
    let pressure = true;
    vi.doMock('fs', () => ({
      ...realFs,
      default: realFs,
      readFileSync: (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (pressure && typeof p === 'string' && p === indexPath) throw emfile();
        return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
      },
    }));

    const { setErrorReporter } = await import('@core/errorReporter');
    setErrorReporter({ captureException: vi.fn(), captureMessage: () => {}, addBreadcrumb: () => {} });

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();

    // Startup load hits EMFILE → degrades to empty, this.index stays null
    // (no .bak to serve).
    expect(store.listSessions()).toEqual([]);

    // FD pressure eases.
    pressure = false;

    // A normal async upsert of a NEW session. Pre-fix this would init a one-row
    // index and overwrite the real 3-entry index.json.
    const outcome = await store.upsertSessionWithOutcome(makeSession({ id: 'new-1', title: 'New' }));
    expect(outcome).toBe('persisted');

    // The on-disk index is the MERGED 4 entries, NOT shrunk to one row.
    const onDisk = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      sessions: Array<{ id: string }>;
    };
    const ids = onDisk.sessions.map((s) => s.id).sort();
    expect(ids).toEqual(['keep-1', 'keep-2', 'keep-3', 'new-1']);
  });

  it('degrade-to-null THEN upsert while reload ALSO transient DEFERS the index write (session file written, index untouched)', async () => {
    writeRealIndex(INDEX_VERSION, ['keep-1', 'keep-2', 'keep-3']);
    const indexPath = path.join(sessionsDir, 'index.json');

    const realFs = await vi.importActual<typeof import('fs')>('fs');
    // EMFILE on index.json for the WHOLE test (degrade + reload both transient).
    vi.doMock('fs', () => ({
      ...realFs,
      default: realFs,
      readFileSync: (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (typeof p === 'string' && p === indexPath) throw emfile();
        return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
      },
    }));

    const { setErrorReporter } = await import('@core/errorReporter');
    setErrorReporter({ captureException: vi.fn(), captureMessage: () => {}, addBreadcrumb: () => {} });

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();

    const indexBefore = realFs.readFileSync(indexPath, 'utf8');
    expect(store.listSessions()).toEqual([]); // degrade to null

    const outcome = await store.upsertSessionWithOutcome(makeSession({ id: 'new-1', title: 'New' }));
    // Index write DEFERRED — never shrank the corpus.
    expect(outcome).toBe('dropped-transient-index');
    // The on-disk index is byte-identical (NOT overwritten with a one-row index).
    expect(realFs.readFileSync(indexPath, 'utf8')).toBe(indexBefore);
    // The session FILE was still written (data not lost; orphan-recovery picks it up).
    expect(fs.existsSync(path.join(sessionsDir, 'new-1.json'))).toBe(true);
  });

  // Round-3 (GPT re-verify): a STALE .bak served EPHEMERALLY on transient degrade
  // must NEVER become the authoritative index that a writer persists over the
  // healthy primary. The .bak is read-only-served; the write reloads the real
  // primary (FD pressure eased) and merges into IT, preserving primary-only ids.
  it('STALE .bak served on degrade is NOT persisted over the primary — upsert merges into the AUTHORITATIVE primary', async () => {
    // Real primary has 3 sessions; the .bak is STALE (only 1, older).
    writeRealIndex(INDEX_VERSION, ['keep-1', 'keep-2', 'keep-3']);
    const indexPath = path.join(sessionsDir, 'index.json');
    const backupPath = path.join(sessionsDir, 'index.json.bak');
    // Build a stale .bak containing ONLY keep-1 (primary-only ids keep-2/keep-3
    // would be HIDDEN if the stale .bak were ever persisted as authoritative).
    fs.writeFileSync(
      backupPath,
      JSON.stringify({
        version: INDEX_VERSION,
        lastUpdated: 500,
        sessions: [JSON.parse(fs.readFileSync(indexPath, 'utf8')).sessions[0]],
      }),
      'utf8',
    );

    const realFs = await vi.importActual<typeof import('fs')>('fs');
    let pressure = true; // EMFILE on primary only while true; .bak always readable.
    vi.doMock('fs', () => ({
      ...realFs,
      default: realFs,
      readFileSync: (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (pressure && typeof p === 'string' && p === indexPath) throw emfile();
        return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
      },
    }));

    const { setErrorReporter } = await import('@core/errorReporter');
    setErrorReporter({ captureException: vi.fn(), captureMessage: () => {}, addBreadcrumb: () => {} });

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();

    // During the transient window, listSessions serves the STALE .bak (1 entry) —
    // the ephemeral-read benefit. (It is NOT adopted as authoritative.)
    expect(store.listSessions().map((s) => s.id).sort()).toEqual(['keep-1']);

    // FD pressure eases; a normal upsert lands.
    pressure = false;
    const outcome = await store.upsertSessionWithOutcome(makeSession({ id: 'new-1', title: 'New' }));
    expect(outcome).toBe('persisted');

    // CRITICAL: the on-disk index was merged into the AUTHORITATIVE primary
    // (keep-1/2/3 + new-1), NOT the stale .bak (which would have hidden
    // keep-2/keep-3). The stale .bak never became the persisted index.
    const onDisk = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      sessions: Array<{ id: string }>;
    };
    expect(onDisk.sessions.map((s) => s.id).sort()).toEqual([
      'keep-1',
      'keep-2',
      'keep-3',
      'new-1',
    ]);
  });
});

/**
 * Round-4 (260617) — CLASS closure: "a transient/unreadable primary index read
 * leaves the in-memory base null/empty, then a writer persists a SMALLER index
 * over the healthy primary, hiding sessions." Two siblings exercised here:
 *   - migrateFromAgentSessions[Sync] (raw-read-under-broad-catch sibling)
 *   - the writeIndex/writeIndexSync chokepoint backstop
 * plus confirmation the legitimate paths (genuine absent → fresh build) work.
 */
describe('IncrementalSessionStore — index-write CLASS closure (round-4 260617)', () => {
  let testDir: string;
  let sessionsDir: string;
  let agentSessionsDir: string;

  function emfile(): NodeJS.ErrnoException {
    const err = new Error('EMFILE: too many open files') as NodeJS.ErrnoException;
    err.code = 'EMFILE';
    return err;
  }

  function writeRealIndex(version: number, ids: string[]): void {
    for (const id of ids) {
      fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(makeSession({ id })), 'utf8');
    }
    fs.writeFileSync(
      path.join(sessionsDir, 'index.json'),
      JSON.stringify({
        version,
        lastUpdated: 1000,
        sessions: ids.map((id) => ({
          id, title: id, createdAt: 1000, updatedAt: 2000, resolvedAt: null,
          doneAt: null, starredAt: null, deletedAt: null, origin: 'manual',
          isCorrupted: false, privateMode: false, interruptedTurnId: null,
          preview: '', firstMessagePreview: '', messageCount: 0, hasDraft: false,
          draftPreview: null, draftUpdatedAt: null,
          usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
          activeTurnId: null, isBusy: false, lastError: null, fingerprint: `2000:${id}`,
        })),
      }),
      'utf8',
    );
  }

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-write-class-'));
    sessionsDir = path.join(testDir, 'sessions');
    agentSessionsDir = path.join(testDir, 'agent-sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doMock('@core/logger', () => ({
      createScopedLogger: () => stubLogger,
      logger: stubLogger,
    }));
    await initTestPlatformConfig({ userDataPath: testDir });
    Object.values(stubLogger).forEach((fn) => fn.mockClear());
  });

  afterEach(() => {
    vi.doUnmock('fs');
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // Sibling 1: migrateFromAgentSessionsSync. A transient primary read used to be
  // swallowed by a broad catch → existingSessions empty → writeIndexSync shrinks
  // the healthy primary. Now it DEFERS the migration; primary not overwritten.
  it('migrateFromAgentSessions: transient primary read DEFERS migration — healthy primary NOT shrunk', async () => {
    // Healthy 3-entry primary.
    writeRealIndex(INDEX_VERSION, ['keep-1', 'keep-2', 'keep-3']);
    const indexPath = path.join(sessionsDir, 'index.json');
    // An orphan agent-sessions/ source to migrate (triggers migrateFromAgentSessions).
    fs.mkdirSync(agentSessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentSessionsDir, 'migrate-me.json'),
      JSON.stringify(makeSession({ id: 'migrate-me' })),
      'utf8',
    );

    const realFs = await vi.importActual<typeof import('fs')>('fs');
    // EMFILE on the PRIMARY index only (the agent-sessions files read fine).
    vi.doMock('fs', () => ({
      ...realFs,
      default: realFs,
      readFileSync: (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (typeof p === 'string' && p === indexPath) throw emfile();
        return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
      },
    }));

    const { setErrorReporter } = await import('@core/errorReporter');
    setErrorReporter({ captureException: vi.fn(), captureMessage: () => {}, addBreadcrumb: () => {} });

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();

    const indexBefore = realFs.readFileSync(indexPath, 'utf8');
    // loadSync runs migrateFromAgentSessionsSync first. The migration must DEFER
    // (transient primary) rather than overwrite the index with a 1-entry one.
    // The subsequent loadFromNewFormatSync ALSO hits the transient primary and
    // degrades (no rebuild). Either way the primary must be byte-identical.
    store.loadSync();

    // CRITICAL: the healthy 3-entry primary is NOT shrunk to the migrated set.
    expect(realFs.readFileSync(indexPath, 'utf8')).toBe(indexBefore);
    // The agent-sessions/ dir was NOT renamed to .migrated (migration deferred).
    expect(fs.existsSync(agentSessionsDir)).toBe(true);
    expect(fs.existsSync(`${agentSessionsDir}.migrated`)).toBe(false);
  });

  // Backstop: writeIndex chokepoint. With this.index null and a transient primary,
  // a write must DEFER rather than persist a base-less (shrunken) index. We drive
  // it via doUpsertSession's reload path which routes the deferred write here.
  it('writeIndex chokepoint: null in-memory base + transient primary DEFERS the index write (primary untouched)', async () => {
    writeRealIndex(INDEX_VERSION, ['keep-1', 'keep-2', 'keep-3']);
    const indexPath = path.join(sessionsDir, 'index.json');

    const realFs = await vi.importActual<typeof import('fs')>('fs');
    vi.doMock('fs', () => ({
      ...realFs,
      default: realFs,
      readFileSync: (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (typeof p === 'string' && p === indexPath) throw emfile();
        return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
      },
    }));

    const { setErrorReporter } = await import('@core/errorReporter');
    setErrorReporter({ captureException: vi.fn(), captureMessage: () => {}, addBreadcrumb: () => {} });

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();
    const indexBefore = realFs.readFileSync(indexPath, 'utf8');

    // this.index is null; an upsert while the primary is transiently unreadable
    // must defer (reload-or-defer) — never persist a one-row index.
    const outcome = await store.upsertSessionWithOutcome(makeSession({ id: 'new-1' }));
    expect(outcome).toBe('dropped-transient-index');
    expect(realFs.readFileSync(indexPath, 'utf8')).toBe(indexBefore);
  });

  // Legitimate path 1: genuinely ABSENT primary → fresh migration writes normally.
  it('legitimate: genuinely-absent primary → agent-sessions migration writes a fresh index (not deferred)', async () => {
    // No primary index. Orphan agent-sessions/ source.
    fs.mkdirSync(agentSessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentSessionsDir, 'fresh-1.json'),
      JSON.stringify(makeSession({ id: 'fresh-1' })),
      'utf8',
    );

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();
    const loaded = store.loadSync();

    // Migration ran (absent primary is authoritative-empty): fresh-1 is indexed.
    expect(loaded.map((s) => s.id)).toContain('fresh-1');
    const onDisk = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'index.json'), 'utf8')) as {
      sessions: Array<{ id: string }>;
    };
    expect(onDisk.sessions.map((s) => s.id)).toContain('fresh-1');
    expect(fs.existsSync(`${agentSessionsDir}.migrated`)).toBe(true);
  });

  // Legitimate path 2: a normal delete still SHRINKS the index with authority
  // (the guard must not block authoritative shrinks).
  it('legitimate: a normal delete still shrinks the on-disk index (guard does not block authoritative shrink)', async () => {
    writeRealIndex(INDEX_VERSION, ['keep-1', 'keep-2', 'keep-3']);
    const indexPath = path.join(sessionsDir, 'index.json');

    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();
    // Load authoritatively (no fs mock → primary reads fine), then delete one.
    store.loadSync();
    await store.deleteSession('keep-2', { intent: 'hygiene' });

    const onDisk = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { sessions: Array<{ id: string }> };
    expect(onDisk.sessions.map((s) => s.id).sort()).toEqual(['keep-1', 'keep-3']);
  });
});
