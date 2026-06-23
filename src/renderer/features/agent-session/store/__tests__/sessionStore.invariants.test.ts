import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  AgentSessionSummary,
  AgentTurnMessage,
  CompactionBoundary,
  ConversationAnnotation,
  MemoryUpdateStatus,
  TimeSavedStatus,
} from '@shared/types';
import type { AgentSessionWithRuntime } from '../../types';
import {
  createSessionStore,
  appendEventToCurrentSession,
  clearCurrentSessionEvents,
  flushPendingEventsVersionNotification,
  getCurrentSessionEvents,
  getCurrentSessionEventsForTurn,
  getCurrentSessionEventsVersion,
  setCurrentSessionEvents,
  type PendingNetworkRetryTurn,
} from '../sessionStore';
import {
  __resetEventSessionValidationDiagnosticsForTest,
  getEventSessionValidationDiagnostics,
  beginValidatedSessionWrite,
} from '@shared/utils/eventSessionValidation';

const statusEventForSession = (message: string, sessionId: string): AgentEvent =>
  ({ type: 'status', message, timestamp: Date.now(), sessionId }) as AgentEvent;

/**
 * Stage 15 (CHIEF_ENGINEER2, Hotspot 5) — invariant-pinning contract tests for
 * `sessionStore.ts`. These tests pin CURRENT behaviour as a runnable regression
 * net so the later slice extractions (Stages 16–19, esp. Stage 19's
 * cross-session contamination structural fix) are provably behaviour-preserving.
 *
 * NO production code is changed by this file. Where current behaviour looks
 * buggy it is pinned AS-IS with a `// XXX defect:` marker (and called out in the
 * Stage 15 implementer report) rather than fixed here.
 *
 * Coverage map / priority order (from
 * `subagent_reports/260529_180000_researcher-sessionstore-revalidation.md`):
 *   GAP-1 (weakest) — network-retry in-memory FIFO cap-10 + cache-cleanup-on-evict.
 *   GAP-2 — compaction phase-transition SEQUENCE (8 actions + abort-on-switch).
 *   GAP-3 — event-write ingress (appendEventToCurrentSession / setCurrentSessionEvents),
 *           the cross-session surface Stage 19 will harden — pinned as-is.
 *   Plus the remaining members of the 16-invariant set not already covered by the
 *   30 existing test files (LRU cap-10, summary.updatedAt ratchet, eventsByTurn shape,
 *   boundary-flush drains, draft preservation, isBusy/LOCAL_BUSY_FRESHNESS_MS).
 *
 * Invariant numbering matches PLAN.md "Hotspot 5: sessionStore.ts (16 invariants)".
 *
 * Module-state isolation: `createSessionStore()` yields a fresh Zustand store per
 * test, but the event Map (`currentSessionEvents`), version counter, and warn-once
 * Sets are MODULE-level and shared across tests in this file and across the suite.
 * We therefore (a) `clearCurrentSessionEvents()` + drain pending notifications in
 * beforeEach/afterEach, and (b) use unique turnIds/sessionIds per test so the
 * status-setter warn-once Sets (no reset export exists) cannot bleed between cases.
 * This keeps the file safe under `vitest --isolate` and against pollution from the
 * other 30 store test files.
 */

const tick = (): Promise<void> =>
  new Promise<void>((resolve) => queueMicrotask(resolve));

const statusEvent = (message: string): AgentEvent => ({
  type: 'status',
  message,
  timestamp: Date.now(),
});

const makeRetryTurn = (
  overrides: Partial<PendingNetworkRetryTurn> = {},
): PendingNetworkRetryTurn => ({
  sessionId: 'session-x',
  turnId: 'turn-x',
  userMessageText: 'hello',
  failedAt: Date.now(),
  retryCount: 0,
  ...overrides,
});

const makeMessage = (
  id: string,
  over: Partial<AgentTurnMessage> = {},
): AgentTurnMessage => ({
  id,
  turnId: `turn-${id}`,
  role: 'user',
  text: id,
  createdAt: 1,
  ...over,
});

const makeBoundary = (afterMessageIndex: number): CompactionBoundary => ({
  afterMessageIndex,
  summary: `summary-after-${afterMessageIndex}`,
  timestamp: 1000 + afterMessageIndex,
  depth: 1,
});

const makeAnnotation = (
  messageId: string,
  over: Partial<ConversationAnnotation> = {},
): ConversationAnnotation => ({
  id: `ann-${messageId}`,
  text: 'sel',
  comment: 'note',
  createdAt: 1,
  messageId,
  startOffset: 0,
  endOffset: 3,
  ...over,
});

let deleteCachedAttachments: ReturnType<typeof vi.fn>;
let upsert: ReturnType<typeof vi.fn>;

beforeEach(() => {
  deleteCachedAttachments = vi.fn().mockResolvedValue(undefined);
  upsert = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('window', {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert,
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    agentApi: {
      stopTurn: vi.fn().mockResolvedValue(undefined),
      deleteCachedAttachments,
    },
    mcpAppsApi: {
      invalidateConversationNonces: vi.fn().mockResolvedValue(undefined),
    },
  });
  // `setPendingTurnForSession` calls `persistRetry(localStorage, …)`. The
  // node test env may have no usable `localStorage` (see vitest.setup.ts),
  // so provide a minimal working stub. We are NOT testing the localStorage
  // layer here (pendingRetryStore.test.ts covers it) — only that the
  // in-memory FIFO path runs without throwing.
  const lsData = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((k: string) => lsData.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void lsData.set(k, v)),
    removeItem: vi.fn((k: string) => void lsData.delete(k)),
    clear: vi.fn(() => lsData.clear()),
  });
  // Module-level event Map + pending notification are process-scoped; reset
  // before each case so the version-counter / boundary-flush assertions are
  // deterministic regardless of preceding tests in the suite.
  clearCurrentSessionEvents();
  flushPendingEventsVersionNotification();
  // Stage 19a: the cross-session validator's per-tuple counters are module-
  // level (shared across the suite). Reset so diagnostics assertions are
  // deterministic regardless of preceding tests.
  __resetEventSessionValidationDiagnosticsForTest();
});

afterEach(() => {
  flushPendingEventsVersionNotification();
  clearCurrentSessionEvents();
  flushPendingEventsVersionNotification();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ===========================================================================
// GAP-1 — Network-retry in-memory FIFO (Invariant #13). Weakest-covered family.
// Pins: cap-10 FIFO eviction by `failedAt`, cache-file cleanup on evict, and
// cache-file cleanup on same-session overwrite — all in the STORE layer
// (`setPendingTurnForSession`), distinct from the localStorage layer in
// core/services/pendingRetryStore (already well-tested).
// ===========================================================================
describe('Invariant #13 — network-retry in-memory FIFO (GAP-1, newly pinned)', () => {
  it('keeps all entries while at or below the cap of 10 (one per session)', () => {
    const store = createSessionStore();
    for (let i = 0; i < 10; i += 1) {
      store
        .getState()
        .setPendingTurnForSession(`s-${i}`, makeRetryTurn({ sessionId: `s-${i}`, failedAt: 1000 + i }));
    }
    expect(store.getState().getPendingTurnCount()).toBe(10);
    expect(deleteCachedAttachments).not.toHaveBeenCalled();
  });

  it('evicts the OLDEST entry (lowest failedAt) when an 11th session is added — FIFO', () => {
    const store = createSessionStore();
    // 10 sessions, ascending failedAt; s-0 is the oldest.
    for (let i = 0; i < 10; i += 1) {
      store
        .getState()
        .setPendingTurnForSession(`s-${i}`, makeRetryTurn({ sessionId: `s-${i}`, failedAt: 1000 + i }));
    }
    store
      .getState()
      .setPendingTurnForSession('s-new', makeRetryTurn({ sessionId: 's-new', failedAt: 9999 }));

    const turns = store.getState().pendingNetworkRetryTurns;
    expect(Object.keys(turns)).toHaveLength(10);
    expect(turns['s-0']).toBeUndefined(); // oldest evicted
    expect(turns['s-new']).toBeDefined();
    // getAllPendingTurns is FIFO-sorted (oldest first) — now starts at s-1.
    expect(store.getState().getAllPendingTurns()[0].sessionId).toBe('s-1');
  });

  it('deletes cache files for the evicted (oldest) entry on FIFO eviction', () => {
    const store = createSessionStore();
    for (let i = 0; i < 10; i += 1) {
      store.getState().setPendingTurnForSession(
        `s-${i}`,
        makeRetryTurn({
          sessionId: `s-${i}`,
          failedAt: 1000 + i,
          attachmentCacheIds: [`cache-${i}`],
        }),
      );
    }
    deleteCachedAttachments.mockClear();
    store.getState().setPendingTurnForSession(
      's-new',
      makeRetryTurn({ sessionId: 's-new', failedAt: 9999, attachmentCacheIds: ['cache-new'] }),
    );
    // s-0 evicted → its cache ids cleaned up.
    expect(deleteCachedAttachments).toHaveBeenCalledWith({ cacheIds: ['cache-0'] });
  });

  it('deletes the OLD cache files when overwriting an existing entry for the same session', () => {
    const store = createSessionStore();
    store.getState().setPendingTurnForSession(
      'session-overwrite',
      makeRetryTurn({ sessionId: 'session-overwrite', attachmentCacheIds: ['old-1', 'old-2'] }),
    );
    deleteCachedAttachments.mockClear();

    store.getState().setPendingTurnForSession(
      'session-overwrite',
      makeRetryTurn({ sessionId: 'session-overwrite', attachmentCacheIds: ['new-1'] }),
    );
    expect(deleteCachedAttachments).toHaveBeenCalledWith({ cacheIds: ['old-1', 'old-2'] });
    expect(store.getState().getPendingTurnCount()).toBe(1);
    expect(store.getState().pendingNetworkRetryTurns['session-overwrite'].attachmentCacheIds).toEqual(['new-1']);
  });

  it('clearPendingTurnForSession only deletes cache when deleteCache=true', () => {
    const store = createSessionStore();
    store.getState().setPendingTurnForSession(
      'session-clear',
      makeRetryTurn({ sessionId: 'session-clear', attachmentCacheIds: ['c-1'] }),
    );
    deleteCachedAttachments.mockClear();

    store.getState().clearPendingTurnForSession('session-clear', false);
    expect(deleteCachedAttachments).not.toHaveBeenCalled();
    expect(store.getState().getPendingTurnCount()).toBe(0);

    // Re-add then clear with deleteCache=true.
    store.getState().setPendingTurnForSession(
      'session-clear',
      makeRetryTurn({ sessionId: 'session-clear', attachmentCacheIds: ['c-2'] }),
    );
    deleteCachedAttachments.mockClear();
    store.getState().clearPendingTurnForSession('session-clear', true);
    expect(deleteCachedAttachments).toHaveBeenCalledWith({ cacheIds: ['c-2'] });
  });

  it('clearAllPendingTurns(true) aggregates all cache ids into a single delete call', () => {
    const store = createSessionStore();
    store.getState().setPendingTurnForSession('a', makeRetryTurn({ sessionId: 'a', attachmentCacheIds: ['a1'] }));
    store.getState().setPendingTurnForSession('b', makeRetryTurn({ sessionId: 'b', attachmentCacheIds: ['b1', 'b2'] }));
    deleteCachedAttachments.mockClear();

    store.getState().clearAllPendingTurns(true);
    expect(store.getState().getPendingTurnCount()).toBe(0);
    expect(deleteCachedAttachments).toHaveBeenCalledTimes(1);
    const call = deleteCachedAttachments.mock.calls[0][0] as { cacheIds: string[] };
    expect(new Set(call.cacheIds)).toEqual(new Set(['a1', 'b1', 'b2']));
  });

  it('getAllPendingTurns returns turns sorted oldest-first by failedAt', () => {
    const store = createSessionStore();
    store.getState().setPendingTurnForSession('late', makeRetryTurn({ sessionId: 'late', failedAt: 3000 }));
    store.getState().setPendingTurnForSession('early', makeRetryTurn({ sessionId: 'early', failedAt: 1000 }));
    store.getState().setPendingTurnForSession('mid', makeRetryTurn({ sessionId: 'mid', failedAt: 2000 }));

    expect(store.getState().getAllPendingTurns().map((t) => t.sessionId)).toEqual(['early', 'mid', 'late']);
  });
});

// ===========================================================================
// GAP-2 — Compaction phase-transition SEQUENCE (Invariant #8). Partial coverage
// existed (routing + idle-guard). Here we walk the FULL state machine and pin the
// `originalSessionId !== currentSessionId` abort-on-switch guard across actions.
// ===========================================================================
describe('Invariant #8 — compaction phase-transition sequence (GAP-2, newly pinned)', () => {
  const CUR = 'session-compact';
  const TURN = 'turn-compact';

  const freshStore = () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: CUR });
    return store;
  };

  it('startCompaction sets phase=compacting and stamps originalSessionId/turnId/depth', () => {
    const store = freshStore();
    store.getState().startCompaction(1, CUR, TURN);
    const c = store.getState().compaction;
    expect(c.phase).toBe('compacting');
    expect(c.originalSessionId).toBe(CUR);
    expect(c.turnId).toBe(TURN);
    expect(c.depth).toBe(1);
    expect(store.getState().showConversation).toBe(true);
  });

  it('startCompaction is aborted when originalSessionId !== currentSessionId (no-op)', () => {
    const store = freshStore();
    const before = store.getState().compaction;
    store.getState().startCompaction(1, 'a-different-session', TURN);
    expect(store.getState().compaction).toBe(before); // identity unchanged
    expect(store.getState().compaction.phase).toBe('idle');
  });

  it('walks the full happy-path sequence: compacting → fallback → revealing → continuing', () => {
    const store = freshStore();
    store.getState().startCompaction(1, CUR, TURN);
    expect(store.getState().compaction.phase).toBe('compacting');

    store.getState().setCompactionFallbackTarget('GPT-mini', TURN, CUR);
    expect(store.getState().compaction.phase).toBe('compacting'); // fallback keeps phase, updates target
    expect(store.getState().compaction.fallbackTarget).toBe('GPT-mini');

    store.getState().setCompactionSummary('the summary', TURN, CUR);
    expect(store.getState().compaction.phase).toBe('revealing');
    expect(store.getState().compaction.summary).toBe('the summary');

    store.getState().completeCompaction(TURN, CUR);
    expect(store.getState().compaction.phase).toBe('continuing');
  });

  it('walks the recovery sequence: compacting → skeleton → recovery_model (depth4) → unavailable', () => {
    const store = freshStore();
    store.getState().startCompaction(2, CUR, TURN);

    store.getState().setCompactionSkeleton(TURN, CUR);
    expect(store.getState().compaction.phase).toBe('skeleton');

    store.getState().setCompactionDepth4Attempt('recovery-profile', TURN, CUR);
    expect(store.getState().compaction.phase).toBe('recovery_model');
    expect(store.getState().compaction.depth4ProfileName).toBe('recovery-profile');

    store.getState().setCompactionUnavailable('Cannot compact further.', TURN, CUR);
    expect(store.getState().compaction.phase).toBe('unavailable');
    expect(store.getState().compaction.statusMessage).toBe('Cannot compact further.');
  });

  it('markCompactionRetrying moves to continuing (terminal-ish) and then phase guards block further transitions', () => {
    const store = freshStore();
    store.getState().startCompaction(1, CUR, TURN);
    store.getState().markCompactionRetrying(TURN, CUR);
    expect(store.getState().compaction.phase).toBe('continuing');

    // From "continuing", the per-action guards reject summary/skeleton/depth4/retry.
    store.getState().setCompactionSummary('late summary', TURN, CUR);
    expect(store.getState().compaction.phase).toBe('continuing');
    store.getState().setCompactionSkeleton(TURN, CUR);
    expect(store.getState().compaction.phase).toBe('continuing');
    store.getState().setCompactionDepth4Attempt('p', TURN, CUR);
    expect(store.getState().compaction.phase).toBe('continuing');
  });

  it('setCompactionError transitions to error from a live phase', () => {
    const store = freshStore();
    store.getState().startCompaction(1, CUR, TURN);
    store.getState().setCompactionError('boom', TURN, CUR);
    expect(store.getState().compaction.phase).toBe('error');
    expect(store.getState().compaction.statusMessage).toBe('boom');
  });

  it('setCompactionError persists the exhausted reason when provided (REBEL-5BM Stage 2)', () => {
    const store = freshStore();
    store.getState().startCompaction(1, CUR, TURN);
    store.getState().setCompactionError('boom', TURN, CUR, 'agent_loop_error_after_recovery');
    expect(store.getState().compaction.phase).toBe('error');
    expect(store.getState().compaction.reason).toBe('agent_loop_error_after_recovery');
  });

  it('setCompactionError defaults reason to null when omitted', () => {
    const store = freshStore();
    store.getState().startCompaction(1, CUR, TURN);
    store.getState().setCompactionError('boom', TURN, CUR);
    expect(store.getState().compaction.reason).toBeNull();
  });

  it('setCompactionError keeps the idle guard even when a reason is supplied', () => {
    const store = freshStore();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(store.getState().compaction.phase).toBe('idle');
    store.getState().setCompactionError('idle-error', TURN, CUR, 'agent_loop_error_after_recovery');
    // Idle-warn guard (Invariant #8) is unchanged: still blocks + warns, and the
    // reason is NOT recorded because no transition occurred.
    expect(store.getState().compaction.phase).toBe('idle');
    expect(store.getState().compaction.reason).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('setCompactionError is IGNORED while idle (warns) — pinned idle-guard', () => {
    const store = freshStore();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(store.getState().compaction.phase).toBe('idle');
    store.getState().setCompactionError('idle-error', TURN, CUR);
    expect(store.getState().compaction.phase).toBe('idle');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('abort-on-switch: every phase action no-ops once currentSessionId diverges from originalSessionId', () => {
    const store = freshStore();
    store.getState().startCompaction(1, CUR, TURN);
    // User switches session mid-flow.
    store.setState({ currentSessionId: 'switched-away' });

    store.getState().setCompactionFallbackTarget('x', TURN, CUR);
    store.getState().setCompactionSummary('x', TURN, CUR);
    store.getState().markCompactionRetrying(TURN, CUR);
    store.getState().setCompactionSkeleton(TURN, CUR);
    store.getState().setCompactionDepth4Attempt('x', TURN, CUR);
    store.getState().setCompactionUnavailable('x', TURN, CUR);
    store.getState().setCompactionError('x', TURN, CUR);
    store.getState().completeCompaction(TURN, CUR);

    // Phase frozen at compacting — none of the cross-session actions applied.
    expect(store.getState().compaction.phase).toBe('compacting');
    expect(store.getState().compaction.fallbackTarget).toBeNull();
  });

  it('turnId mismatch guards stale-turn transitions (a different turn cannot drive this compaction)', () => {
    const store = freshStore();
    store.getState().startCompaction(1, CUR, TURN);
    store.getState().setCompactionSummary('wrong turn', 'turn-OTHER', CUR);
    // Mismatched enhancedPromptOrTurnId (acting as turnId) is rejected.
    expect(store.getState().compaction.phase).toBe('compacting');
    expect(store.getState().compaction.summary).toBeNull();
  });

  // S3 — setCompactionUnavailable's guard is the asymmetric odd-one-out: unlike
  // setCompactionError it does NOT special-case the `idle` phase (no warn, no
  // block) and does NOT block the `error` phase — it only blocks a turnId
  // mismatch, a cross-session originalSessionId, and the `continuing` phase.
  // Pinned directly so Stage 17 cannot silently "normalise" it to match its
  // siblings. NB: Stage 17 — this guard is deliberately different from
  // setCompactionError/completeCompaction.
  it('setCompactionUnavailable: turnId mismatch is rejected (asymmetric guard, pinned)', () => {
    const store = freshStore();
    store.getState().startCompaction(1, CUR, TURN);
    // A stale/other turn cannot drive this compaction to unavailable.
    store.getState().setCompactionUnavailable('nope', 'turn-OTHER', CUR);
    expect(store.getState().compaction.phase).toBe('compacting');
    expect(store.getState().compaction.statusMessage).not.toBe('nope');
  });

  it('setCompactionUnavailable: fires from idle with NO warn (unlike setCompactionError)', () => {
    const store = freshStore();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(store.getState().compaction.phase).toBe('idle');
    // From idle, state.compaction.turnId is null so ANY incoming turnId passes the
    // mismatch guard; idle is NOT special-cased (no warn, no block) — the asymmetry
    // vs setCompactionError, which warns-and-blocks on idle.
    store.getState().setCompactionUnavailable('cannot compact', TURN, CUR);
    expect(store.getState().compaction.phase).toBe('unavailable');
    expect(store.getState().compaction.statusMessage).toBe('cannot compact');
    // Asymmetry vs setCompactionError: no idle warn is emitted here.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('setCompactionUnavailable: is rejected once phase is `continuing` (the only blocked phase)', () => {
    const store = freshStore();
    store.getState().startCompaction(1, CUR, TURN);
    store.getState().markCompactionRetrying(TURN, CUR);
    expect(store.getState().compaction.phase).toBe('continuing');
    store.getState().setCompactionUnavailable('late', TURN, CUR);
    expect(store.getState().compaction.phase).toBe('continuing');
  });

  it('resetCompaction returns the machine to idle from any phase', () => {
    const store = freshStore();
    store.getState().startCompaction(1, CUR, TURN);
    store.getState().setCompactionError('boom', TURN, CUR);
    expect(store.getState().compaction.phase).toBe('error');
    store.getState().resetCompaction();
    expect(store.getState().compaction.phase).toBe('idle');
    expect(store.getState().compaction.summary).toBeNull();
    expect(store.getState().compaction.turnId).toBeNull();
  });
});

// ===========================================================================
// Invariant #14 — compactionBoundaries filtered past the truncation point in the
// `truncateToMessage` STORE action (M1 — was the one invariant with no test home).
//
// The reducer (conversationReducer.truncateToMessage) does NOT touch
// compactionBoundaries at all; the filter lives only in the store action
// (sessionStore.ts ~L2090):
//   state.compactionBoundaries.filter((b) => b.afterMessageIndex < newMessageCount - 1)
// where `newMessageCount === targetIndex + 1` (truncate keeps messages[0..targetIndex]),
// so `newMessageCount - 1 === targetIndex`. A boundary survives iff
// `afterMessageIndex < targetIndex` — i.e. STRICTLY before the truncation target.
//
// This pins the off-by-one precisely with three boundaries relative to the
// truncation target index: one before (kept), one EXACTLY at the target index
// (dropped — the off-by-one edge), and one after (dropped). This is a Stage-17
// (compaction consolidation) refactor surface; the off-by-one must not drift.
// ===========================================================================
describe('Invariant #14 — truncateToMessage drops compactionBoundaries past the truncation point', () => {
  const CUR = 'session-truncate';
  // Five messages, indices 0..4; we truncate to the message at index 3.
  const messages: AgentTurnMessage[] = [
    makeMessage('m0'),
    makeMessage('m1'),
    makeMessage('m2'),
    makeMessage('m3'),
    makeMessage('m4'),
  ];
  const TARGET_INDEX = 3; // truncate target → newMessageCount = 4, newMessageCount - 1 = 3

  const seededStore = () => {
    const store = createSessionStore();
    store.setState({
      currentSessionId: CUR,
      messages: messages.map((m) => ({ ...m })),
      compactionBoundaries: [
        makeBoundary(TARGET_INDEX - 1), // index 2 — strictly before target → KEPT
        makeBoundary(TARGET_INDEX), //     index 3 — exactly at target     → DROPPED
        makeBoundary(TARGET_INDEX + 1), // index 4 — after target          → DROPPED
      ],
    });
    return store;
  };

  it('keeps boundaries strictly before the truncation target and drops the one AT and AFTER it', () => {
    const store = seededStore();
    // Truncate to the message at TARGET_INDEX (m3). It survives as the last message.
    store.getState().truncateToMessage('m3', 'edited text');

    const kept = store.getState().compactionBoundaries.map((b) => b.afterMessageIndex);
    // The `< newMessageCount - 1` (i.e. `< targetIndex`) filter keeps only index 2.
    expect(kept).toEqual([TARGET_INDEX - 1]);
  });

  it('off-by-one edge: a boundary EXACTLY at the truncation target index is DROPPED', () => {
    const store = seededStore();
    store.getState().truncateToMessage('m3', 'edited text');
    const survivors = store.getState().compactionBoundaries.map((b) => b.afterMessageIndex);
    // The boundary at afterMessageIndex === targetIndex (3) does NOT survive because
    // the filter is strict-less-than `newMessageCount - 1` (= 3). m3 is still the last
    // surviving message, so a boundary "after message index 3" sits right at the new
    // tail and is discarded by the `- 1`.
    // INVARIANT (verified CORRECT — independent GPT-5.5 diagnosis 260530, was briefly
    // flagged XXX): a compaction boundary survives truncation only if at least one
    // POST-boundary message also survives. `afterMessageIndex` means "compaction occurred
    // AFTER this message index" (src/shared/types/agent.ts), not "this message is
    // compacted"; the continuation message lives after the boundary. So a boundary at the
    // last surviving message has no post-boundary content and is correctly dropped —
    // keeping it would render a dangling divider AND make model-history recovery
    // (conversationHistoryService slices at lastBoundaryIndex+1) return zero messages
    // (see buildConversationHistoryContext.test.ts). NOT an off-by-one. Equivalent
    // clearer form: `afterMessageIndex + 1 < newMessageCount`.
    expect(survivors).not.toContain(TARGET_INDEX);
    expect(survivors).toContain(TARGET_INDEX - 1);
  });

  it('truncating to the FIRST message drops every boundary (newMessageCount - 1 === 0)', () => {
    const store = seededStore();
    // Truncate to m0 → newMessageCount = 1, filter is `afterMessageIndex < 0` → none.
    store.getState().truncateToMessage('m0', 'just the first');
    expect(store.getState().compactionBoundaries).toEqual([]);
  });

  it('truncating to the LAST message still drops the trailing boundary (off-by-one at the tail)', () => {
    const store = seededStore();
    // Truncate to m4 (index 4) → newMessageCount = 5, filter is `afterMessageIndex < 4`.
    // The boundary at index 4 is dropped even though m4 itself survives.
    store.getState().truncateToMessage('m4', 'edit last');
    const kept = store.getState().compactionBoundaries.map((b) => b.afterMessageIndex);
    expect(kept).toEqual([TARGET_INDEX - 1, TARGET_INDEX]); // 2 and 3 kept; 4 dropped
  });

  it('is a no-op for an unknown targetMessageId (reducer returns state, boundaries untouched)', () => {
    const store = seededStore();
    store.getState().truncateToMessage('does-not-exist', 'x');
    // The reducer returns the same state when the target is missing; the action then
    // re-derives newMessageCount from the unchanged message list (length 5 → filter
    // `< 4`), so boundaries at 2 and 3 are kept and only the index-4 boundary drops.
    const kept = store.getState().compactionBoundaries.map((b) => b.afterMessageIndex);
    expect(kept).toEqual([TARGET_INDEX - 1, TARGET_INDEX]);
  });

  // S4 — same action also drops annotations whose messageId did not survive the
  // truncation (sessionStore.ts ~L2095-2108). Lighter secondary gap; pinned here.
  it('S4: drops annotations on messages past the truncation point and keeps surviving ones', () => {
    const store = createSessionStore();
    store.setState({
      currentSessionId: CUR,
      messages: messages.map((m) => ({ ...m })),
      annotationsBySessionId: {
        [CUR]: [
          makeAnnotation('m1'), // survives (m1 <= m3)
          makeAnnotation('m3'), // survives (target message itself)
          makeAnnotation('m4'), // dropped (m4 truncated away)
        ],
      },
    });
    store.getState().truncateToMessage('m3', 'edited');
    const survivingIds = (store.getState().annotationsBySessionId[CUR] ?? []).map(
      (a) => a.messageId,
    );
    expect(survivingIds.sort()).toEqual(['m1', 'm3']);
  });

  it('S4: clears the session annotation entry entirely when no annotation survives', () => {
    const store = createSessionStore();
    store.setState({
      currentSessionId: CUR,
      messages: messages.map((m) => ({ ...m })),
      annotationsBySessionId: { [CUR]: [makeAnnotation('m4')] }, // only on a truncated msg
    });
    store.getState().truncateToMessage('m2', 'edited');
    // filteredAnnotations is empty → the action omits the session key entirely.
    expect(store.getState().annotationsBySessionId[CUR]).toBeUndefined();
  });
});

// ===========================================================================
// GAP-3 — Event-write ingress (Invariants #6 + #15). The cross-session surface
// Stage 19 will harden. Pinned AS-IS: the ingress is turnId-keyed with NO
// sessionId provenance, so a foreign turn's events land in the shared Map
// unconditionally. Stage 19's structural fix must keep these observable
// behaviours (the green/intended parts) while closing the contamination hole.
// ===========================================================================
describe('Invariants #6/#15 — event-write ingress (GAP-3, cross-session pinned as-is)', () => {
  it('appendEventToCurrentSession appends to the turn-keyed Map and bumps the version', () => {
    const before = getCurrentSessionEventsVersion();
    appendEventToCurrentSession('turn-1', statusEvent('a'));
    appendEventToCurrentSession('turn-1', statusEvent('b'));
    expect(getCurrentSessionEventsForTurn('turn-1')).toHaveLength(2);
    expect(getCurrentSessionEventsVersion()).toBe(before + 2);
  });

  it('eventsByTurn Zustand field stays {} — real event data lives in the module Map (Invariant #15)', () => {
    const store = createSessionStore();
    appendEventToCurrentSession('turn-shape', statusEvent('x'));
    // Zustand-stored eventsByTurn is the empty placeholder, NOT the live data.
    expect(store.getState().eventsByTurn).toEqual({});
    // The live data is only reachable via the module accessor.
    expect(getCurrentSessionEvents()['turn-shape']).toHaveLength(1);
  });

  // Stage 19a FLIPPED (was `// XXX defect`): the W3 ingress now carries
  // sessionId provenance. When the caller supplies provenance, a foreign-
  // session event is DROPPED + telemetered (fail-closed) instead of
  // contaminating the shared Map. This pins the validated behaviour at the
  // exact seam the Stage-15 net was built to flip. The legacy 2-arg signature
  // (no provenance) still writes unconditionally — see the green-part cases
  // above — so unrelated callers (e.g. version-coalescing tests) are
  // unaffected. See docs/plans/260526_hotspot-refactor-roadmap/subagent_reports/
  // 260529_210000_implementer-stage19a-wire-cross-session-validator.md.
  it('Stage 19a: a foreign-session event (provenance supplied) is DROPPED at the W3 ingress, not contaminated', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: 'foreground-session' });
    // An event whose provenance sessionId is a DIFFERENT (background) session.
    appendEventToCurrentSession('turn-from-background-session', statusEvent('leak'), {
      scope: beginValidatedSessionWrite('foreground-session', 'ipc-agent-event'),
      eventSessionId: 'background-session',
    });
    // Validated behaviour: the foreign event is dropped — it does NOT land in
    // the foreground Map.
    expect(getCurrentSessionEventsForTurn('turn-from-background-session')).toHaveLength(0);
    expect(store.getState().currentSessionId).toBe('foreground-session');
  });

  it('Stage 19a: a legitimate same-session event (provenance supplied) still writes — the inverse direction', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: 'foreground-session' });
    appendEventToCurrentSession('turn-foreground', statusEvent('legit'), {
      scope: beginValidatedSessionWrite('foreground-session', 'ipc-agent-event'),
      eventSessionId: 'foreground-session',
    });
    // Same-session provenance → accepted and written (no contamination, no
    // false-positive drop of a legitimate event).
    expect(getCurrentSessionEventsForTurn('turn-foreground')).toHaveLength(1);
  });

  it('Stage 19a: a legacy event with no provenance arg still writes (legacy 2-arg signature preserved)', () => {
    appendEventToCurrentSession('turn-legacy', statusEvent('legacy'));
    expect(getCurrentSessionEventsForTurn('turn-legacy')).toHaveLength(1);
  });

  // Stage 19b — COMPILE-TIME guarantee (ACCURATE scope, refined 260530).
  //
  // What this DOES guarantee: the `scope` carried by `EventIngressProvenance`
  // is a `ValidatedSessionWriteScope`, an UNFORGEABLE token whose sole
  // constructor is `beginValidatedSessionWrite` (next to the validator). So a
  // caller that *passes provenance* cannot fabricate it from a plain object,
  // and re-introducing the pre-19b plain `{ currentSessionId, source }`
  // provenance shape is a COMPILE error. The `@ts-expect-error` directives
  // below are the assertion: `npm run lint:ts` FAILS if either stops being an
  // error (i.e. if the brand is weakened so a forged/plain provenance becomes
  // assignable again).
  //
  // What this does NOT guarantee (honest scope; see DOWNSCOPE note in
  // docs/plans/260526_hotspot-refactor-roadmap/subagent_reports/
  // 260530_080000_implementer-stage19b-refinement-write-seam.md): the token is
  // OPTIONAL on the write functions (`provenance?` / `scope?`), so a NEW
  // cross-session-ingress write site could still compile without minting a
  // token — it is NOT "impossible to bypass". The optional path is retained
  // deliberately for the genuinely-local callers (same-session resync, e.g.
  // version-coalescing edit, and the ~50 local/test callers). Forcing the
  // token everywhere needs the named-API split (`*LocalUnchecked`) tracked as a
  // follow-up; it was measured as a >20-site cascade (mostly test churn) and
  // descoped here. See the legacy-no-provenance case at L666, which still
  // type-checks BY DESIGN and documents this boundary.
  describe('Stage 19b: a forged/plain-object provenance is a TYPE error', () => {
    it('appendEventToCurrentSession rejects a hand-rolled (unbranded) provenance', () => {
      // A plain provenance object cannot satisfy `EventIngressProvenance`
      // because its `scope` must be a `ValidatedSessionWriteScope`, which only
      // `beginValidatedSessionWrite` can mint.
      appendEventToCurrentSession('turn-x', statusEvent('forged'), {
        // @ts-expect-error 19b: `scope` cannot be a plain object — it must be a
        // validator-minted ValidatedSessionWriteScope.
        scope: { targetSessionId: 'foreground-session', source: 'ipc-agent-event' },
      });
      // The accepted, validated form DOES type-check (sanity anchor for the
      // negative case above — proves the failure is the brand, not the call).
      appendEventToCurrentSession('turn-ok', statusEvent('ok'), {
        scope: beginValidatedSessionWrite('foreground-session', 'ipc-agent-event'),
      });
      expect(getCurrentSessionEventsForTurn('turn-ok')).toHaveLength(1);
      // ACCURATE-SCOPE anchor (NO @ts-expect-error here, on purpose): the
      // token is OPTIONAL, so the no-provenance 2-arg call STILL type-checks.
      // This documents the delivered guarantee's boundary — the brand forbids a
      // forged token, not an absent one. Tightening this to a compile error is
      // the deferred named-API split (see the describe-block note above).
      appendEventToCurrentSession('turn-no-token', statusEvent('still-compiles'));
      expect(getCurrentSessionEventsForTurn('turn-no-token')).toHaveLength(1);
    });

    it('setCurrentSessionEvents rejects the old plain {currentSessionId, source} shape', () => {
      setCurrentSessionEvents(
        { 'turn-y': [statusEvent('forged')] },
        // @ts-expect-error 19b: the validated overload requires a minted
        // ValidatedSessionWriteScope, not the pre-19b `{ currentSessionId, source }`.
        { currentSessionId: 'foreground-session', source: 'history-hydration' },
      );
      // Validated form type-checks.
      setCurrentSessionEvents(
        { 'turn-z': [statusEvent('ok')] },
        beginValidatedSessionWrite('foreground-session', 'history-hydration'),
      );
      expect(getCurrentSessionEventsForTurn('turn-z')).toHaveLength(1);
    });
  });

  it('setCurrentSessionEvents clears + re-imports and CLONES arrays (no shared mutation with source)', () => {
    const source: Record<string, AgentEvent[]> = { 'turn-clone': [statusEvent('orig')] };
    setCurrentSessionEvents(source);
    // Mutating the source array after import must NOT affect the store Map.
    source['turn-clone'].push(statusEvent('mutated-after'));
    expect(getCurrentSessionEventsForTurn('turn-clone')).toHaveLength(1);
  });

  it('setCurrentSessionEvents replaces (not merges) the prior turn set — session-switch semantics', () => {
    appendEventToCurrentSession('turn-A', statusEvent('a'));
    setCurrentSessionEvents({ 'turn-B': [statusEvent('b')] });
    expect(getCurrentSessionEventsForTurn('turn-A')).toHaveLength(0);
    expect(getCurrentSessionEventsForTurn('turn-B')).toHaveLength(1);
  });

  it('getCurrentSessionEventsForTurn returns a shared reference (read-only contract) for present turns', () => {
    appendEventToCurrentSession('turn-ref', statusEvent('a'));
    const ref1 = getCurrentSessionEventsForTurn('turn-ref');
    appendEventToCurrentSession('turn-ref', statusEvent('b'));
    const ref2 = getCurrentSessionEventsForTurn('turn-ref');
    // Same underlying array instance (push-in-place), so length reflects both.
    expect(ref1).toBe(ref2);
    expect(ref2).toHaveLength(2);
  });

  it('warnCrossSessionStatusSetterOnce: status setter refuses a cross-session write and warns once per turn', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: 'fg-status' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const status: MemoryUpdateStatus = {
      originalTurnId: 'turn-status-ingress-unique',
      originalSessionId: 'bg-status',
      status: 'success',
      timestamp: Date.now(),
    };
    store.getState().setMemoryUpdateStatus(status);
    store.getState().setMemoryUpdateStatus(status);
    expect(store.getState().memoryUpdateStatusByTurn['turn-status-ingress-unique']).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1); // warn-once Set suppresses the second
  });
});

// ===========================================================================
// Invariant #16 — boundary-flush primitive drains pending notifications.
// (eventsVersionCoalescing.test.ts covers the action-level drain points; here we
// pin the primitive's own contract: a pending bump is delivered synchronously.)
// ===========================================================================
describe('Invariant #16 — boundary-flush drains the pending version notification', () => {
  it('flushPendingEventsVersionNotification delivers a coalesced bump synchronously (before the microtask)', async () => {
    const store = createSessionStore();
    const seen: number[] = [];
    const unsub = store.subscribe(
      (s) => s.eventsByTurnVersion,
      (v) => seen.push(v),
    );

    appendEventToCurrentSession('turn-flush', statusEvent('a'));
    appendEventToCurrentSession('turn-flush', statusEvent('b'));
    // Not yet delivered (coalesced, awaiting microtask).
    expect(seen).toHaveLength(0);

    flushPendingEventsVersionNotification();
    expect(seen).toHaveLength(1); // synchronous boundary drain

    // The scheduled microtask must NOT double-deliver after a manual flush.
    await tick();
    expect(seen).toHaveLength(1);
    unsub();
  });

  it('flush is a no-op when nothing is pending', () => {
    const store = createSessionStore();
    const seen: number[] = [];
    const unsub = store.subscribe((s) => s.eventsByTurnVersion, (v) => seen.push(v));
    flushPendingEventsVersionNotification();
    flushPendingEventsVersionNotification();
    expect(seen).toHaveLength(0);
    unsub();
  });
});

// ===========================================================================
// Invariant #7 — summary.updatedAt monotonic ratchet + preserveLocalBusy under
// LOCAL_BUSY_FRESHNESS_MS (60_000). setSessionSummaries.merge.test.ts covers
// parts; here we pin the ratchet + freshness boundary explicitly as a Stage-18
// regression net.
// ===========================================================================
describe('Invariant #7 — summary.updatedAt monotonic ratchet & local-busy freshness', () => {
  const makeSummary = (over: Partial<AgentSessionSummary> & { id: string }): AgentSessionSummary =>
    ({
      title: 'T',
      createdAt: 1000,
      updatedAt: 1000,
      isBusy: false,
      activeTurnId: null,
      lastActivityAt: null,
      ...over,
    }) as AgentSessionSummary;

  it('updatedAt never regresses: incoming older value is ratcheted up to the prior value', () => {
    const store = createSessionStore();
    store.setState({ sessionSummaries: [makeSummary({ id: 's1', updatedAt: 5000 })] });
    store.getState().setSessionSummaries([makeSummary({ id: 's1', updatedAt: 3000 })]);
    expect(store.getState().sessionSummaries[0].updatedAt).toBe(5000);
  });

  it('updatedAt advances when incoming is newer (cloud bump wins the sort key)', () => {
    const store = createSessionStore();
    store.setState({ sessionSummaries: [makeSummary({ id: 's1', updatedAt: 5000 })] });
    store.getState().setSessionSummaries([makeSummary({ id: 's1', updatedAt: 9000 })]);
    expect(store.getState().sessionSummaries[0].updatedAt).toBe(9000);
  });

  it('does not preserve local busy when incoming advisory summary says not-busy', () => {
    const store = createSessionStore();
    const now = Date.now();
    store.setState({
      sessionSummaries: [makeSummary({ id: 's1', updatedAt: now, isBusy: true, activeTurnId: 'turn-live', lastActivityAt: now })],
    });
    store.getState().setSessionSummaries([
      makeSummary({ id: 's1', updatedAt: now - 1000, isBusy: false, activeTurnId: null }),
    ]);
    const s = store.getState().sessionSummaries[0];
    expect(s.isBusy).toBe(false);
    expect(s.activeTurnId).toBeNull();
    expect(s.updatedAt).toBe(now); // ratcheted to the newer local value
  });

  it('clears stale busy summaries via lastActivityAt staleness check', () => {
    const store = createSessionStore();
    const now = Date.now();
    const stale = now - (5 * 60_000) - 1;
    store.setState({
      sessionSummaries: [makeSummary({ id: 's1', updatedAt: stale, isBusy: true, activeTurnId: 'turn-stuck', lastActivityAt: stale })],
    });
    store.getState().setSessionSummaries([
      makeSummary({ id: 's1', updatedAt: stale - 1000, isBusy: true, activeTurnId: 'turn-stuck', lastActivityAt: stale }),
    ]);
    expect(store.getState().sessionSummaries[0].isBusy).toBe(false);
  });

  it('equal timestamps mean cloud wins the tie (no local-busy preservation)', () => {
    const store = createSessionStore();
    const now = Date.now();
    store.setState({
      sessionSummaries: [makeSummary({ id: 's1', updatedAt: now, isBusy: true, activeTurnId: 'turn-tie' })],
    });
    store.getState().setSessionSummaries([
      makeSummary({ id: 's1', updatedAt: now, isBusy: false, activeTurnId: null }),
    ]);
    // localStrictlyNewer is false at equal timestamps → cloud's not-busy wins.
    expect(store.getState().sessionSummaries[0].isBusy).toBe(false);
  });

  it('a brand-new session id is taken from cloud wholesale (no merge)', () => {
    const store = createSessionStore();
    store.setState({ sessionSummaries: [] });
    const now = Date.now();
    const incoming = makeSummary({
      id: 'fresh',
      updatedAt: now,
      isBusy: true,
      activeTurnId: 'turn-fresh',
      lastActivityAt: now,
    });
    store.getState().setSessionSummaries([incoming]);
    expect(store.getState().sessionSummaries[0]).toMatchObject(incoming);
  });
});

// ===========================================================================
// Invariant #9 + #12 — LRU eviction (cap 10) never evicts active/current/loading;
// tool-archive bounded across evict. backgroundSessions/openHistory touch this
// tangentially; here we pin the protection invariants explicitly.
// ===========================================================================
describe('Invariant #9/#12 — LRU eviction protections (cap 10)', () => {
  const makeLoaded = (id: string, over: Partial<AgentSessionWithRuntime> = {}): AgentSessionWithRuntime =>
    ({
      id,
      title: id,
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      compactionBoundaries: [],
      toolDetailArchive: {},
      ...over,
    }) as AgentSessionWithRuntime;

  it('evicts the oldest UNPROTECTED session when the 11th is cached', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: 'kept-current', loadingSessionId: null });
    // Fill with 10 plain sessions (none current/loading/active).
    for (let i = 0; i < 10; i += 1) {
      store.getState().cacheSession(makeLoaded(`lru-${i}`));
    }
    expect(store.getState().loadedSessions.size).toBe(10);
    // Cache an 11th → oldest (lru-0) evicted.
    store.getState().cacheSession(makeLoaded('lru-10'));
    expect(store.getState().loadedSessions.size).toBe(10);
    expect(store.getState().loadedSessions.has('lru-0')).toBe(false);
    expect(store.getState().loadedSessions.has('lru-10')).toBe(true);
  });

  it('never evicts the current session even when it is the oldest', () => {
    const store = createSessionStore();
    store.getState().cacheSession(makeLoaded('the-current'));
    store.setState({ currentSessionId: 'the-current' });
    for (let i = 0; i < 10; i += 1) {
      store.getState().cacheSession(makeLoaded(`other-${i}`));
    }
    expect(store.getState().loadedSessions.has('the-current')).toBe(true);
  });

  it('never evicts the loading session', () => {
    const store = createSessionStore();
    store.getState().cacheSession(makeLoaded('the-loading'));
    store.setState({ currentSessionId: 'unrelated', loadingSessionId: 'the-loading' });
    for (let i = 0; i < 10; i += 1) {
      store.getState().cacheSession(makeLoaded(`other-${i}`));
    }
    expect(store.getState().loadedSessions.has('the-loading')).toBe(true);
  });

  it('never evicts a session with an active turn (busy)', () => {
    const store = createSessionStore();
    store.getState().cacheSession(makeLoaded('the-busy', { activeTurnId: 'turn-busy' }));
    store.setState({ currentSessionId: 'unrelated' });
    for (let i = 0; i < 10; i += 1) {
      store.getState().cacheSession(makeLoaded(`other-${i}`));
    }
    expect(store.getState().loadedSessions.has('the-busy')).toBe(true);
  });

  it('allows temporary oversize when every entry is protected (does not crash)', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: 'unrelated' });
    // 11 busy sessions — all protected → temporary growth tolerated.
    for (let i = 0; i < 11; i += 1) {
      store.getState().cacheSession(makeLoaded(`busy-${i}`, { activeTurnId: `t-${i}` }));
    }
    expect(store.getState().loadedSessions.size).toBe(11);
  });

  it('bounds tool-detail archive to MAX entries per session across cacheSession compaction', () => {
    const store = createSessionStore();
    // Build a completed turn with > 50 distinct tool start/end pairs so compaction
    // archives them, then the per-session cap (50) trims to the most recent.
    const events: AgentEvent[] = [];
    for (let i = 0; i < 60; i += 1) {
      events.push({ type: 'tool', stage: 'start', toolUseId: `tu-${i}`, toolName: 't', detail: `in-${i}`, timestamp: i } as AgentEvent);
      events.push({ type: 'tool', stage: 'end', toolUseId: `tu-${i}`, toolName: 't', detail: `out-${i}`, timestamp: i } as AgentEvent);
    }
    events.push({ type: 'result', text: 'done', timestamp: 1000 } as AgentEvent);
    const session = makeLoaded('archive-cap', {
      eventsByTurn: { 'turn-archive': events },
      activeTurnId: null,
    });
    store.getState().cacheSession(session);
    const cached = store.getState().loadedSessions.get('archive-cap');
    expect(cached).toBeDefined();
    expect(Object.keys(cached!.toolDetailArchive ?? {}).length).toBeLessThanOrEqual(50);
  });
});

// ===========================================================================
// Invariant #2 — draft preservation: empty draft removes the entry; cleared
// drafts don't resurrect; getCurrentDraft reads the current session.
// (upsertDraftDurable/annotations cover the durable CAS path; here we pin the
// in-memory set/clear/read contract directly.)
// ===========================================================================
describe('Invariant #2 — draft set/clear/read contract', () => {
  it('setDraftForSession stores non-empty text and getCurrentDraft reads the current session', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: 'draft-cur' });
    store.getState().setDraftForSession('draft-cur', 'hello draft');
    const d = store.getState().getCurrentDraft();
    expect(d?.text).toBe('hello draft');
    expect(typeof d?.updatedAt).toBe('number');
  });

  it('writing empty text removes the draft entry (does not store an empty draft)', () => {
    const store = createSessionStore();
    store.getState().setDraftForSession('draft-empty', 'something');
    expect(store.getState().draftsBySessionId['draft-empty']).toBeDefined();
    store.getState().setDraftForSession('draft-empty', '   '); // whitespace-only = empty
    expect(store.getState().draftsBySessionId['draft-empty']).toBeUndefined();
  });

  it('a cleared draft does not resurrect on a subsequent empty write', () => {
    const store = createSessionStore();
    store.getState().setDraftForSession('draft-x', 'typed');
    store.getState().setDraftForSession('draft-x', '');
    store.getState().setDraftForSession('draft-x', '');
    expect(store.getState().draftsBySessionId['draft-x']).toBeUndefined();
  });

  it('does not write a draft to a soft-deleted session (no-op)', () => {
    const store = createSessionStore();
    store.setState({
      sessionSummaries: [
        { id: 'deleted-s', title: 'd', createdAt: 1, updatedAt: 1, deletedAt: 2 } as AgentSessionSummary,
      ],
    });
    store.getState().setDraftForSession('deleted-s', 'should not land');
    expect(store.getState().draftsBySessionId['deleted-s']).toBeUndefined();
  });
});

// ===========================================================================
// COMBINED MULTI-SESSION SCENARIO (unit-level) — the spike found NO combined
// test exists. Switch A→B mid-drain + a draft + a compaction in flight + a
// pending network-retry, asserting no cross-contamination at the store layer.
// (The full E2E version is Stage 19's cross-surface DoD.)
// ===========================================================================
describe('Combined multi-session scenario — no cross-contamination (unit-level, newly pinned)', () => {
  it('switch A→B mid-drain preserves A\'s draft, B\'s retry, and aborts A\'s in-flight compaction without leaking into B', () => {
    const store = createSessionStore();
    const A = 'session-A';
    const B = 'session-B';
    const turnA = 'turn-A';

    // --- Session A is foreground; start a compaction and stage some events. ---
    store.setState({ currentSessionId: A });
    store.getState().setDraftForSession(A, 'draft typed in A');
    store.getState().startCompaction(1, A, turnA);
    expect(store.getState().compaction.phase).toBe('compacting');

    // A has in-flight events mid-drain.
    appendEventToCurrentSession(turnA, statusEvent('A streaming 1'));
    appendEventToCurrentSession(turnA, statusEvent('A streaming 2'));

    // A pending network-retry exists for A.
    store.getState().setPendingTurnForSession(A, makeRetryTurn({ sessionId: A, turnId: turnA, failedAt: 100 }));

    // --- User switches to B mid-drain. (Session-switch replaces the event Map.) ---
    store.setState({ currentSessionId: B });
    setCurrentSessionEvents({}); // B has no events yet
    store.getState().setDraftForSession(B, 'draft typed in B');

    // A late compaction action for A arrives AFTER the switch → must abort (no leak into B).
    store.getState().setCompactionSummary('A late summary', turnA, A);

    // --- Assertions: nothing from A bled into B, and vice versa. ---
    // 1. Drafts isolated per session.
    expect(store.getState().draftsBySessionId[A]?.text).toBe('draft typed in A');
    expect(store.getState().draftsBySessionId[B]?.text).toBe('draft typed in B');

    // 2. Compaction aborted cleanly: the late summary did NOT apply while B is current,
    //    so B sees no spurious "revealing" compaction state.
    expect(store.getState().compaction.phase).toBe('compacting'); // frozen, not advanced
    expect(store.getState().compaction.summary).toBeNull();
    expect(store.getState().compaction.originalSessionId).toBe(A); // still tagged to A

    // 3. The pending network-retry for A survives the switch and is not duplicated for B.
    expect(store.getState().getPendingTurnCount()).toBe(1);
    expect(store.getState().pendingNetworkRetryTurns[A]).toBeDefined();
    expect(store.getState().pendingNetworkRetryTurns[B]).toBeUndefined();

    // 4. The event Map reflects B's (empty) set after the switch — A's streamed
    //    events were cleared by setCurrentSessionEvents, not merged into B.
    expect(getCurrentSessionEventsForTurn(turnA)).toHaveLength(0);

    // 5. currentSessionId is B.
    expect(store.getState().currentSessionId).toBe(B);
  });

  it('a foreign-session status setter during the combined flow is dropped (warn-once), not applied to B', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: 'session-B-combined' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const aStatus: TimeSavedStatus = {
      turnId: 'turn-A-combined-unique',
      originalSessionId: 'session-A-combined',
      status: 'success',
      timestamp: Date.now(),
    };
    store.getState().setTimeSavedStatus(aStatus);
    store.getState().setTimeSavedStatus(aStatus);

    expect(store.getState().timeSavedStatusByTurn['turn-A-combined-unique']).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Stage 19a — cross-session event validator wired at the renderer ingress.
// Drives the REAL live-ingress action (`processEvent`, which calls
// `appendEventToCurrentSession` internally) — not the low-level Map function
// directly — to prove BOTH directions through the production seam:
//   (a) a foreign-session event is dropped + telemetered (no contamination);
//   (b) a legitimate same-session event passes unaffected (no false drop).
// This is the strong renderer-integration stand-in for the cross-surface
// multi-session E2E (noted as a follow-up in the implementer report).
// ===========================================================================
describe('Stage 19a — processEvent foreground ingress validates session provenance', () => {
  const A = 'session-A-ingress';
  const B = 'session-B-ingress';

  it('drops a foreign-session live event mid-stream and increments the reject counter', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: A });

    // Legitimate A event arrives first (provenance === current) → written.
    store.getState().processEvent('turn-A1', statusEventForSession('A streaming', A), A);
    expect(getCurrentSessionEventsForTurn('turn-A1')).toHaveLength(1);

    // A foreign B event is mis-routed to the foreground (the resolveSessionId
    // ambient-fallback leak). Its provenance (B) != current (A) → dropped.
    store.getState().processEvent('turn-B1', statusEventForSession('B leak', B), B);
    expect(getCurrentSessionEventsForTurn('turn-B1')).toHaveLength(0);

    // Telemetry fired for the drop; the legitimate write did NOT count as a reject.
    const diag = getEventSessionValidationDiagnostics();
    expect(diag.rejectsByKey['ipc-agent-event:rejected-foreign:status']).toBe(1);
  });

  it('keeps a legitimate same-session live event (no false-positive drop)', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: A });

    // Provenance matches the current session → accepted.
    store.getState().processEvent('turn-A2', statusEventForSession('A legit 1', A), A);
    store.getState().processEvent('turn-A2', statusEventForSession('A legit 2', A), A);
    expect(getCurrentSessionEventsForTurn('turn-A2')).toHaveLength(2);

    // No rejects recorded for a clean same-session stream.
    const diag = getEventSessionValidationDiagnostics();
    expect(diag.rejectsByKey).toEqual({});
  });

  it('a legacy event with no provenance still flows (accepted-legacy, counted)', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: A });

    // No eventSessionId arg and the event carries no sessionId → legacy accept.
    store.getState().processEvent('turn-A3', statusEvent('no provenance'));
    expect(getCurrentSessionEventsForTurn('turn-A3')).toHaveLength(1);

    const diag = getEventSessionValidationDiagnostics();
    expect(diag.legacyByKey['ipc-agent-event:accepted-legacy:status']).toBe(1);
    expect(diag.rejectsByKey).toEqual({});
  });

  it('setCurrentSessionEvents bulk-import drops foreign-stamped events and keeps same-session ones', () => {
    const store = createSessionStore();
    store.setState({ currentSessionId: A });

    setCurrentSessionEvents(
      {
        'turn-keep': [statusEventForSession('mine', A)],
        'turn-foreign': [statusEventForSession('theirs', B)],
        'turn-mixed': [
          statusEventForSession('mine-2', A),
          statusEventForSession('theirs-2', B),
        ],
      },
      beginValidatedSessionWrite(A, 'history-hydration'),
    );

    expect(getCurrentSessionEventsForTurn('turn-keep')).toHaveLength(1);
    expect(getCurrentSessionEventsForTurn('turn-foreign')).toHaveLength(0);
    // Mixed turn keeps only the same-session event.
    expect(getCurrentSessionEventsForTurn('turn-mixed')).toHaveLength(1);

    const diag = getEventSessionValidationDiagnostics();
    expect(diag.rejectsByKey['history-hydration:rejected-foreign:status']).toBe(2);
  });
});
