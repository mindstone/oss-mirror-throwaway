import { useEffect, useRef } from 'react';
import type { QuestionBatchState } from './useUserQuestions';

/**
 * Detect batches that newly transitioned from unanswered to answered and return
 * the target message index to scroll to (the highest/last-anchored one), or -1
 * if no transition or no matching anchor exists.
 *
 * Pure helper. Used by `useScrollToAnswer` below. Exported for unit tests.
 * See docs-private/investigations/260416_answered_question_card_not_visible.md.
 */
export function computeScrollToAnswerIndex(
  previousAnsweredBatchIds: ReadonlySet<string>,
  currentAnsweredBatchIds: ReadonlySet<string>,
  questionCardByMessageIndex: ReadonlyMap<number, QuestionBatchState[]>,
): number {
  const newlyAnswered = new Set<string>();
  for (const batchId of currentAnsweredBatchIds) {
    if (!previousAnsweredBatchIds.has(batchId)) {
      newlyAnswered.add(batchId);
    }
  }
  if (newlyAnswered.size === 0) return -1;

  let targetIndex = -1;
  for (const [messageIndex, batches] of questionCardByMessageIndex) {
    if (batches.some((b) => newlyAnswered.has(b.batch.batchId))) {
      if (messageIndex > targetIndex) targetIndex = messageIndex;
    }
  }
  return targetIndex;
}

export type ScrollToIndexFn = (
  index: number,
  options: { align: 'start' | 'center' | 'end'; behavior: 'auto' | 'smooth' },
) => void;

export interface UseScrollToAnswerOptions {
  /** Current question batch states (built by `buildQuestionBatchStates`). */
  questionBatches: ReadonlyArray<QuestionBatchState>;
  /** Map from visible message index to the question batches anchored there. */
  questionCardByMessageIndex: ReadonlyMap<number, QuestionBatchState[]>;
  /** Current session ID — used to reset baseline on session switch. */
  currentSessionId: string;
  /**
   * Virtualizer scroll callback. Should be a stable function or mutating ref
   * access; this hook captures it in a ref so it never invalidates the effect.
   */
  scrollToIndex: ScrollToIndexFn;
  /** Called immediately before `scrollToIndex` to flag the scroll as programmatic. */
  onBeginProgrammaticScroll: () => void;
  /** Called after the smooth animation settles (~400ms) to clear the flag. */
  onEndProgrammaticScroll: () => void;
}

/** Delay before firing the scroll so the virtualizer has time to mount/measure
 *  the newly-rendered answered card. 100ms is under the human-perceptible
 *  threshold and well under the expected continuation-turn `turn_started`
 *  event latency. */
const SCROLL_SETTLE_DELAY_MS = 100;

/** Buffer over the 300ms custom scrollToFn duration in ConversationPane. The
 *  programmatic-scroll flag must stay true for the full smooth animation so
 *  `useConversationAutoScroll` doesn't treat the per-frame scrollTop writes
 *  as user scroll-up and engage the sticky latch. (FOX-2596, FOX-2668) */
const PROGRAMMATIC_SCROLL_FLAG_DURATION_MS = 400;

/**
 * Scroll-to-answer effect: when a question batch transitions from unanswered →
 * answered (user just submitted), nudge the anchored answered card into view
 * so the user sees their answer land.
 *
 * Covers two failure modes simultaneously:
 *   (A) card is mounted but above the viewport (auto-scroll pinned user to
 *       bottom of continuation turn) → smooth scroll brings it into view.
 *   (B) card is unmounted entirely (beyond virtualizer overscan=5) →
 *       scrollToIndex advances the visible range to include the target.
 *
 * Keeps the asking-turn anchor intact (plan invariants preserved).
 *
 * ## Race conditions addressed (Phase 6 review, iteration 1)
 *
 * **M1 — Timer cancel race:** If `questionBatches` identity changes during the
 * 100ms settle delay (e.g., continuation turn's `turn_started` event arrives),
 * this effect re-runs. Naive cleanup would cancel the pending scroll, and the
 * re-run would compute `prev === current` → `targetIndex = -1` → no new timer,
 * so the scroll never fires. Fix: `prev` is committed ONLY inside the timer
 * callback; re-runs with the same target reuse the pending timer instead of
 * cancelling and rescheduling.
 *
 * **M2 — Auto-scroll latch engagement:** The smooth scroll routes through
 * ConversationPane's custom `scrollToFn` which writes `scrollTop` each RAF
 * frame. Each write dispatches a scroll event that `useConversationAutoScroll`
 * observes as upward movement — during a busy turn this would engage the
 * sticky latch and leave auto-scroll broken for subsequent turns. Fix: the
 * caller brackets the scroll with `onBeginProgrammaticScroll` /
 * `onEndProgrammaticScroll` so the auto-scroll hook can short-circuit its
 * latch-engagement branch while this programmatic scroll is in flight.
 *
 * @see docs-private/investigations/260416_answered_question_card_not_visible.md
 */
export function useScrollToAnswer({
  questionBatches,
  questionCardByMessageIndex,
  currentSessionId,
  scrollToIndex,
  onBeginProgrammaticScroll,
  onEndProgrammaticScroll,
}: UseScrollToAnswerOptions): void {
  // Mirror callbacks in refs so they don't invalidate the effect; the effect's
  // dependency array is intentionally narrow (questionBatches/map/session).
  const scrollToIndexRef = useRef(scrollToIndex);
  scrollToIndexRef.current = scrollToIndex;
  const onBeginRef = useRef(onBeginProgrammaticScroll);
  onBeginRef.current = onBeginProgrammaticScroll;
  const onEndRef = useRef(onEndProgrammaticScroll);
  onEndRef.current = onEndProgrammaticScroll;

  const prevAnsweredBatchIdsRef = useRef<Set<string>>(new Set());
  const prevScrollSessionIdRef = useRef<string | null>(null);
  /** Pending programmatic-scroll state. Survives re-renders within the delay
   *  window so we don't cancel our own in-flight scroll. */
  const pendingScrollRef = useRef<{ timerId: ReturnType<typeof setTimeout>; targetIndex: number } | null>(null);
  /** Pending flag-clear timer so we can cancel it on unmount / session switch
   *  and avoid invoking onEnd on a torn-down handle (hygiene; benign otherwise). */
  const pendingFlagClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const currentAnswered = new Set<string>();
    for (const qb of questionBatches) {
      if (qb.isAnswered) currentAnswered.add(qb.batch.batchId);
    }

    // Session switch / first mount: establish baseline without scrolling so
    // pre-existing answered batches from history don't trigger a jump.
    const isNewSession = prevScrollSessionIdRef.current !== currentSessionId;
    if (isNewSession) {
      prevScrollSessionIdRef.current = currentSessionId;
      prevAnsweredBatchIdsRef.current = currentAnswered;
      if (pendingScrollRef.current) {
        clearTimeout(pendingScrollRef.current.timerId);
        pendingScrollRef.current = null;
      }
      if (pendingFlagClearTimerRef.current) {
        clearTimeout(pendingFlagClearTimerRef.current);
        pendingFlagClearTimerRef.current = null;
        onEndRef.current();
      }
      return;
    }

    const targetIndex = computeScrollToAnswerIndex(
      prevAnsweredBatchIdsRef.current,
      currentAnswered,
      questionCardByMessageIndex,
    );

    if (targetIndex < 0) {
      // No new transition right now. DO NOT commit prev — we may have an
      // in-flight timer whose target was computed against the stable prev;
      // committing here would make re-runs see prev === current.
      return;
    }

    // If a timer is already pending for the same target, keep it. This is the
    // critical M1 invariant: re-runs within the 100ms window (triggered by
    // unrelated state changes like `turn_started`) must not cancel the scroll.
    if (pendingScrollRef.current && pendingScrollRef.current.targetIndex === targetIndex) {
      return;
    }

    // Different target (e.g., another batch answered mid-window) — replace
    // the stale timer.
    if (pendingScrollRef.current) {
      clearTimeout(pendingScrollRef.current.timerId);
      pendingScrollRef.current = null;
    }

    // Capture the answered set at the moment we schedule so the timer commits
    // the correct snapshot even if `questionBatches` identity changes again
    // before the timer fires.
    const scheduledAnswered = currentAnswered;

    const timerId = setTimeout(() => {
      pendingScrollRef.current = null;
      prevAnsweredBatchIdsRef.current = scheduledAnswered;
      onBeginRef.current();
      try {
        scrollToIndexRef.current(targetIndex, {
          align: 'start',
          behavior: 'smooth',
        });
      } finally {
        // Keep the flag set for the full smooth-animation window so per-frame
        // scrollTop writes from the custom scrollToFn aren't treated as user
        // scroll-up. See M2 notes above. Track the timer so unmount / session
        // switch can cancel it and clear the flag eagerly.
        pendingFlagClearTimerRef.current = setTimeout(() => {
          pendingFlagClearTimerRef.current = null;
          onEndRef.current();
        }, PROGRAMMATIC_SCROLL_FLAG_DURATION_MS);
      }
    }, SCROLL_SETTLE_DELAY_MS);

    pendingScrollRef.current = { timerId, targetIndex };

    // Intentionally no cleanup here: we want the pending timer to survive
    // effect re-runs. The timer self-clears `pendingScrollRef.current` when
    // it fires; different-target re-runs clear it via the branch above.
  }, [questionBatches, questionCardByMessageIndex, currentSessionId]);

  // On unmount: cancel any pending timers to avoid leaks and invoking the
  // flag-clear on a torn-down pane handle. Clear the flag eagerly so any
  // caller that's still around sees a consistent end-of-scroll state.
  useEffect(() => {
    return () => {
      if (pendingScrollRef.current) {
        clearTimeout(pendingScrollRef.current.timerId);
        pendingScrollRef.current = null;
      }
      if (pendingFlagClearTimerRef.current) {
        clearTimeout(pendingFlagClearTimerRef.current);
        pendingFlagClearTimerRef.current = null;
        onEndRef.current();
      }
    };
  }, []);
}
