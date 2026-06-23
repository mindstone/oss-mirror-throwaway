/**
 * Module-level thinking-delta batching subsystem for the renderer session store.
 *
 * Extracted from `sessionStore.ts` (behavior-preserving Stage 3). The
 * `pendingThinkingDeltas` Map and its flush scheduler live here, encapsulated
 * behind accessors so the store's action closure and the leak-diagnostics
 * helpers never touch the Map directly. `sessionStore.ts` re-exports
 * `cancelPendingThinkingDeltas` so the canonical `.../store/sessionStore`
 * import path keeps resolving.
 *
 * @see ./sessionStore.ts — the store implementation that drives this scheduler
 * @see docs/plans/260622_refactor-session-store/PLAN.md — extraction plan
 */
import type { SessionStoreState } from './sessionStoreTypes';

// ---------------------------------------------------------------------------
// Thinking delta batching (PERF: reduces Zustand writes from ~50/sec to ~4/sec)
//
// appendThinkingDelta previously called set() per token, creating a new
// immutable state object each time. Even though only ConversationPane subscribes
// (via per-turnId selector), the object churn causes GC pressure that blocks the
// main thread during extended thinking. We accumulate deltas in a module-level
// Map and flush to Zustand every 250ms. ThinkingTextDisplay uses useSmoothStream
// (RAF-based animation), so the batching is visually indistinguishable.
// ---------------------------------------------------------------------------
const pendingThinkingDeltas = new Map<string, string>();
let thinkingFlushTimer: ReturnType<typeof setTimeout> | null = null;
let thinkingFlushTarget: (() => void) | null = null;

/** Accumulate a thinking delta for a turn into the pending Map. */
export const accumulateThinkingDelta = (turnId: string, delta: string): void => {
  pendingThinkingDeltas.set(
    turnId,
    (pendingThinkingDeltas.get(turnId) ?? "") + delta,
  );
};

/** Discard any pending delta for a turn without flushing it. */
export const discardPendingThinkingDelta = (turnId: string): void => {
  pendingThinkingDeltas.delete(turnId);
};

/**
 * Read-only view of the pending-deltas Map for diagnostics. Callers must treat
 * the returned Map as read-only (size/iteration only); it is the live Map so
 * the leak diagnostics observe accurate counts/bytes without a copy.
 */
export const getPendingThinkingDeltasForDiagnostics = (): ReadonlyMap<string, string> =>
  pendingThinkingDeltas;

/** Schedule a flush of accumulated thinking deltas to Zustand. */
export const scheduleThinkingFlush = (
  getState: () => SessionStoreState,
  setState: (
    partial:
      | Partial<SessionStoreState>
      | ((state: SessionStoreState) => Partial<SessionStoreState>),
  ) => void,
): void => {
  if (thinkingFlushTimer) return;
  // Capture set/get so the timer closure uses the correct store instance
  thinkingFlushTarget = () => {
    thinkingFlushTimer = null;
    thinkingFlushTarget = null;
    const entries = [...pendingThinkingDeltas.entries()];
    pendingThinkingDeltas.clear();
    if (entries.length === 0) return;
    setState((state) => {
      const next = { ...state.thinkingTextByTurn };
      for (const [tid, accumulated] of entries) {
        next[tid] = (next[tid] ?? "") + accumulated;
      }
      return { thinkingTextByTurn: next };
    });
  };
  thinkingFlushTimer = setTimeout(thinkingFlushTarget, 250);
};

/** Cancel pending thinking deltas without flushing (used on full reset). */
export const cancelPendingThinkingDeltas = (): void => {
  if (thinkingFlushTimer) {
    clearTimeout(thinkingFlushTimer);
    thinkingFlushTimer = null;
    thinkingFlushTarget = null;
  }
  pendingThinkingDeltas.clear();
};
