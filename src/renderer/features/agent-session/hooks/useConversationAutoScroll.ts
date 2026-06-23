import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { AgentTurnMessage } from '@shared/types';
import { analytics } from '@renderer/src/analytics';
import type { ConversationPaneHandle } from '../components/ConversationPane';
import {
  abandonSwitchTimingIfMatches,
  finishSwitchTiming,
  markPaintAfterReveal,
  markPrimitiveResolved,
  markPrimitiveStart,
} from '../dev/switchTimingProbe';

export type UseConversationAutoScrollOptions = {
  /** Ref to the ConversationPane handle (virtualized) */
  containerRef: RefObject<ConversationPaneHandle | null>;
  visibleMessages: AgentTurnMessage[];
  /** Unfiltered transcript messages; defaults to visibleMessages when omitted */
  rawMessages?: AgentTurnMessage[];
  processingTurnId: string | null;
  /** Whether the agent is actively processing a turn (not just user-focused) */
  isBusy: boolean;
  isInsightSurface: boolean;
  isDiagnosticsSurface: boolean;
  /** Current session ID - used to reset state on session switch */
  currentSessionId: string;
  /** When true, all auto-scroll behavior is paused (e.g., during context menu interaction) */
  pauseAutoScroll?: boolean;
  /** When true, the active pause source is eligible to trigger a catch-up scroll
   *  the moment it closes (i.e. when `pauseAutoScrollCatchUpEligible` flips
   *  `true → false` AND `pauseAutoScroll` is also false). The catch-up exists to
   *  recover content that streamed in *during* a brief, transient pause (e.g. a
   *  right-click context menu).
   *
   *  Wire ONLY transient/short-lived pause sources where streamed content arriving
   *  during the pause should be recovered (e.g., selection menu during streaming).
   *  Do NOT wire long-lived popover/dialog pauses (annotation editing, modal
   *  dialogs, large overlay surfaces) — those should keep the user where they are
   *  on close. If unsure, leave it `false`.
   *
   *  See: docs-private/investigations/260509_annotation_save_jumps_to_bottom.md
   */
  pauseAutoScrollCatchUpEligible?: boolean;
  /** Whether the session surface is currently the active (visible) surface.
   *  When false, the scroll container may be inside content-visibility:hidden
   *  and have zero dimensions — scroll attempts are deferred until visible. */
  isSurfaceVisible?: boolean;
};

export type UseConversationAutoScrollResult = {
  scrollToLastMessage: (options?: { behavior?: 'auto' | 'smooth' }) => boolean;
  /** Mark a pending history-scroll for `sessionId`. The scroll fires only when the
   *  store's `currentSessionId` matches, so a stale navigation can't consume a newer
   *  request's flag. See docs-private/investigations/260420_scroll_to_bottom_still_broken.md.
   *
   *  `markTimeCurrentSessionId` records which session was current when the navigation
   *  was initiated. Callers must pass STORE truth (`getSessionStoreState().currentSessionId`),
   *  NOT a render-scope value — a `startTransition`-lagged render can trail the store's
   *  already-applied switch, and a render-scope mark-time would reopen a FOX-3040
   *  strand window. The orphan guard keeps the mark alive only while `currentSessionId`
   *  is the mark-time session (navigation in progress) or the pending target (landed);
   *  any third id means the navigation lost and the mask self-cancels.
   *  Deliberately REQUIRED (not optional) so future call sites can't silently skip it.
   *  See docs/plans/260611_fix-stuck-reveal-mask/PLAN.md. */
  markPendingHistoryScroll: (sessionId: string, markTimeCurrentSessionId: string) => void;
  /** Cancel a pending history scroll and reveal the pane (call when session open fails).
   *  When `sessionId` is provided, the cancel is ignored unless it matches the currently
   *  pending session — prevents a stale navigation's failure from clearing a newer
   *  navigation's pending scroll. */
  cancelPendingHistoryScroll: (sessionId?: string) => void;
  /** Whether the conversation is settling after loading history (opacity hidden during this time) */
  isSettling: boolean;
  /** Whether the transcript should remain visually masked while settling continues. */
  isRevealMasked: boolean;
  /** Whether user has scrolled away from the bottom (for showing "jump to latest" indicator) */
  isScrolledAway: boolean;
  /** Number of new messages since user scrolled away */
  newMessageCount: number;
  /** Whether there are new messages below the current scroll position (derived: isScrolledAway && newMessageCount > 0) */
  hasNewMessagesBelow: boolean;
  /** True while the viewport is intentionally pinned to the start of the latest answer. */
  isAnswerTopPinned: boolean;
};

/** Threshold in pixels - user is considered "near bottom" if within this distance */
const NEAR_BOTTOM_THRESHOLD = 150;

/**
 * Tighter threshold for clearing the sticky scroll-away latch.
 * The latch prevents auto-scroll from re-engaging after the user intentionally
 * scrolls up. To clear the latch, the user must scroll close to the bottom —
 * trackpad momentum/inertia can easily reach 150px but rarely 75px.
 * Must be comfortably above bottom chrome spacing so "visual bottom" clears the latch.
 * See: FOX-2668, FOX-2596
 */
const STICKY_CLEAR_THRESHOLD = 75;

function getOriginatingUserMessageOrigin(
  rawMessages: AgentTurnMessage[],
  turnId: string,
): AgentTurnMessage['messageOrigin'] | undefined {
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const message = rawMessages[i];
    if (message.role !== 'user') continue;
    if (message.turnId !== turnId) continue;
    return message.messageOrigin;
  }
  return undefined;
}

/**
 * Manages auto-scroll behavior for the conversation pane.
 *
 * ## Architecture: Three Scroll Trigger Mechanisms
 *
 * This hook uses THREE separate effects to handle scroll, each for a distinct scenario:
 *
 * 1. **Pending-History (Session Switch) Effect**
 *    - Triggered by: `markPendingHistoryScroll()` called before opening a history session.
 *    - Behavior: Sets `isSettling=true` and `isRevealMasked=true`, awaits the
 *      pane's Promise-returning `scrollToBottomUntilStable` primitive, then
 *      clears `isSettling` and reveals the pane on final resolution based on the structured result
 *      reason (`stable` / `timeout` / `user-scrolled` / `empty` / `unmounted` /
 *      `aborted`). Degraded outcomes surface "Jump to Latest"; `user-scrolled` engages
 *      the sticky latch; `aborted` is a no-op (upstream cancellation).
 *    - Why separate: Needs coordination with settling state, CSS transitions, and
 *      cross-component Promise plumbing. Owns the `abortRef` so concurrent
 *      `markPendingHistoryScroll` calls cleanly supersede prior primitives.
 *
 * 2. **Message Arrival Effect**
 *    - Triggered by: `visibleMessages` array changes (new message added).
 *    - Behavior: If user was near bottom (`wasNearBottomRef`), scroll to the new message
 *      via `scrollToLastMessage` → `handle.scrollToBottom` (single-shot chase on the
 *      pane handle; NOT the settling primitive).
 *    - Why separate: Reactive to data changes, doesn't need settling state.
 *
 * 3. **Content Growth RAF Loop**
 *    - Triggered by: `requestAnimationFrame` loop while `isBusy` (runs even before
 *      `processingTurnId` is set).
 *    - Behavior: Reads `scrollHeight` each frame; if grown and user was near bottom,
 *      scrolls to bottom. Handles streaming text that grows without a new message
 *      arriving.
 *    - Why RAF: Synchronises with the browser paint cycle (~60fps) and piggybacks on
 *      layout reads the paint cycle already performs.
 *
 * ## The Scroll-Settle Primitive (pending-history path)
 *
 * Owned by `ConversationPane`: `scrollToBottomUntilStable(options?) =>
 * Promise<ScrollSettleResult>`. Pins `scrollTop` per rAF while the virtualizer's
 * measurement pipeline converges, then resolves with a structured outcome once the
 * geometry, quiescence, measurement-commit, and GAP_THRESHOLD gates all clear
 * (see `ConversationPane.tsx` — `scrollToBottomUntilStable`). Replaces the previous
 * `setTimeout`-polling `checkAndReveal` / post-reveal monitor pair that was fooled by
 * main-thread long tasks (false-stable bug class documented in
 * `docs-private/investigations/260420_long_restored_conversation_scroll_short.md`).
 *
 * Design docs: `docs/plans/260420_scroll_to_bottom_primitive_refactor.md` (v3) —
 * Stage 2 migrated this hook from the timer-polling design to the primitive consumer.
 *
 * ## The Pane's Single-Shot `scrollToBottom` Chase
 *
 * The `scrollToBottom` method in `ConversationPane` still uses a fixed-iteration RAF
 * chase because TanStack Virtual estimates item heights (default 150px) before
 * ResizeObserver commits real sizes. A single scroll lands at the *estimated* bottom,
 * items then measure, `scrollHeight` changes, and we're not at the real bottom anymore.
 * The primitive exists precisely because "chase for N frames" is not sufficient when the
 * measurement pipeline itself may lag behind a main-thread block. See:
 * https://github.com/TanStack/virtual/issues/1001
 *
 * ## Why Not Consolidate Into One Effect?
 *
 * Triple-review (2026-01-10) warned against consolidating these effects:
 * - "One effect per scenario" is clearer and easier to reason about.
 * - Merging would create a complex conditional tree prone to race conditions.
 * - Each effect has distinct dependencies and timing requirements.
 * See: `docs/plans/finished/260110_scroll_render_architecture_analysis.md`.
 *
 * ## Key Behaviors
 *
 * - Scrolling to last message when history session is opened (primitive-driven).
 * - Auto-scrolling when new messages arrive (if user was already near bottom).
 * - Auto-scrolling when a new turn starts (to show the thinking placeholder).
 * - Tracking scroll-away state for the "Jump to Latest" indicator.
 * - Respecting intentional scroll-up to read history (sticky latch; no forced scroll).
 */
export function useConversationAutoScroll({
  containerRef,
  visibleMessages,
  rawMessages,
  processingTurnId,
  isBusy,
  isInsightSurface,
  isDiagnosticsSurface,
  currentSessionId,
  pauseAutoScroll = false,
  pauseAutoScrollCatchUpEligible = false,
  isSurfaceVisible = true,
}: UseConversationAutoScrollOptions): UseConversationAutoScrollResult {
  const isNonSessionSurface = isInsightSurface || isDiagnosticsSurface;
  const originLookupMessages = rawMessages ?? visibleMessages;

  /** Session ID of the currently pending history scroll, or null if none.
   *  Storing the sessionId (rather than a boolean) prevents a stale navigation's
   *  cancel or premature consumption from clearing a newer request's flag — the
   *  pending effect only fires when this matches `currentSessionId`.
   *  See docs-private/investigations/260420_scroll_to_bottom_still_broken.md. */
  const pendingHistoryScrollRef = useRef<string | null>(null);
  /** Session ID of a scroll deferred because the surface was hidden, or null. */
  const deferredScrollRef = useRef<string | null>(null);
  /** Session that was current (STORE truth) when the pending mark was made, or null.
   *  The mark-time orphan guard in the pending-history effect treats
   *  `currentSessionId === markTime` as "navigation still in progress" (FOX-3040:
   *  intermediate renders must NOT cancel the mark) and a `currentSessionId` that is
   *  neither mark-time nor the pending target as an orphaned navigation → cancel +
   *  drop the mask. See docs/plans/260611_fix-stuck-reveal-mask/PLAN.md. */
  const markTimeSessionIdRef = useRef<string | null>(null);
  const lastAutoScrolledMessageIdRef = useRef<string | null>(null);
  const answerTopPinnedTurnIdRef = useRef<string | null>(null);
  const suppressScrollHandlerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressScrollHandlerRef = useRef(false);
  /** Track if user was near bottom before the last update (for deciding whether to auto-scroll) */
  const wasNearBottomRef = useRef(true);
  /** Settling state - conversation is hidden while loading history to prevent layout jumps */
  const [isSettling, setIsSettling] = useState(false);
  /** UI-only mask state. This can drop earlier than `isSettling` so the pane
   *  becomes visible while the primitive continues stabilizing in the background. */
  const [isRevealMasked, setIsRevealMasked] = useState(false);
  /** AbortController for the current pending-history primitive run, or null.
   *  Aborting causes the primitive to resolve with reason='aborted', and the
   *  `.then()` handler short-circuits on `controller.signal.aborted`.
   *  See docs/plans/260420_scroll_to_bottom_primitive_refactor.md (Stage 2). */
  const abortRef = useRef<AbortController | null>(null);
  /** Track if user has scrolled away from bottom (for "jump to latest" indicator) */
  const [isScrolledAway, setIsScrolledAway] = useState(false);
  const [isAnswerTopPinned, setIsAnswerTopPinned] = useState(false);
  /** Count of messages that arrived while scrolled away */
  const [newMessageCount, setNewMessageCount] = useState(0);
  /** Track message count when user scrolled away to calculate new messages */
  const messageCountWhenScrolledAwayRef = useRef(0);
  /** Track previous session ID to detect session switches */
  const prevSessionIdRef = useRef<string>(currentSessionId);
  /** Track previous processingTurnId for turn-start scroll guard (FOX-2505) */
  const prevProcessingTurnIdForScrollRef = useRef<string | null>(processingTurnId);
  /** Tracks whether user is actively scrolling (wheel/touchmove) to suppress auto-scroll forcing */
  const userScrollingRef = useRef(false);
  const userScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Tracks previous scrollTop to detect scroll direction in the scroll handler */
  const prevScrollTopRef = useRef(0);
  /** Tracks previous visibleMessages length to detect message removal (thinking prune).
   *  When visibleMessages shrinks, the "latest" message may revert to a user message,
   *  which would bypass the stickyScrollAwayRef check via the isUserMessage path. (FOX-2596) */
  const prevVisibleMessagesLengthRef = useRef(visibleMessages.length);
  /** Ref mirror of isBusy for stable event handler references (avoids re-registering listeners) */
  const isBusyRef = useRef(isBusy);
  isBusyRef.current = isBusy;
  /**
   * "Sticky" latch: once the user intentionally scrolls up during streaming,
   * this stays true until cleared by an explicit user action:
   *   - User scrolls back to bottom (within STICKY_CLEAR_THRESHOLD)
   *   - User sends a new message
   *   - User clicks "Jump to latest" (calls scrollToLastMessage)
   *   - Session switch
   * The latch persists across turn boundaries (isBusy toggles) so auto-scroll
   * doesn't re-engage on auto-continue turns. (FOX-2596, FOX-2668)
   */
  const stickyScrollAwayRef = useRef(false);

  const clearAnswerTopPin = useCallback((reason = 'unspecified') => {
    void reason;
    answerTopPinnedTurnIdRef.current = null;
    setIsAnswerTopPinned(false);
  }, []);

  const suppressScrollHandlerForProgrammaticJump = useCallback(() => {
    suppressScrollHandlerRef.current = true;
    if (suppressScrollHandlerTimerRef.current) {
      clearTimeout(suppressScrollHandlerTimerRef.current);
    }
    suppressScrollHandlerTimerRef.current = setTimeout(() => {
      suppressScrollHandlerRef.current = false;
      suppressScrollHandlerTimerRef.current = null;
    }, 120);
  }, []);

  // Reset scroll tracking state on session switch
  // NOTE: We intentionally do NOT reset pendingHistoryScrollRef or isSettling here.
  // Those are controlled by markPendingHistoryScroll() which is called before session switch.
  // Resetting them here caused a race condition where the pending scroll was cancelled
  // before it could execute. See: docs/plans/finished/260104_scroll_to_bottom_simplification.md
  useEffect(() => {
    if (currentSessionId !== prevSessionIdRef.current) {
      prevSessionIdRef.current = currentSessionId;
      // Reset UI state to avoid stale indicators from previous session
      setIsScrolledAway(false);
      setNewMessageCount(0);
      messageCountWhenScrolledAwayRef.current = 0;
      wasNearBottomRef.current = true;
      lastAutoScrolledMessageIdRef.current = null;
      // Reset turn-start scroll guard so new turns in the new session can trigger
      // auto-scroll (prevents stale values from previous session). (FOX-2505)
      prevProcessingTurnIdForScrollRef.current = null;
      prevScrollTopRef.current = 0;
      prevVisibleMessagesLengthRef.current = 0;
      stickyScrollAwayRef.current = false;
      deferredScrollRef.current = null;
      clearAnswerTopPin('session-switch');
      suppressScrollHandlerRef.current = false;
      if (suppressScrollHandlerTimerRef.current) {
        clearTimeout(suppressScrollHandlerTimerRef.current);
        suppressScrollHandlerTimerRef.current = null;
      }
    }
  }, [clearAnswerTopPin, currentSessionId]);

  /** Get the underlying scroll element from the virtualized pane handle */
  const getScrollElement = useCallback(() => {
    return containerRef.current?.getScrollElement() ?? null;
  }, [containerRef]);

  const scrollToLastMessage = useCallback((options?: { behavior?: 'auto' | 'smooth' }) => {
    const handle = containerRef.current;
    if (!handle) {
      return false;
    }
    clearAnswerTopPin('jump-to-latest');
    // Clear the sticky latch so auto-scroll re-engages (e.g., "Jump to latest" click)
    stickyScrollAwayRef.current = false;
    wasNearBottomRef.current = true;
    handle.scrollToBottom(options);
    return true;
  }, [clearAnswerTopPin, containerRef]);

  // Retry scroll when surface becomes visible after a deferred attempt.
  // Many code paths load a session while the sessions surface is still hidden
  // (content-visibility: hidden), which prevents accurate scroll dimensions.
  // When the surface transitions to visible, re-arm the pending-history effect
  // (rather than firing a one-shot unverified scroll) so the deferred path gets
  // the same verified settling + retry loop as the primary path.
  // See docs-private/investigations/260420_scroll_to_bottom_still_broken.md.
  //
  // ⚠️ EFFECT ORDERING (load-bearing): this effect MUST be declared BEFORE the
  // pending-history effect below. When `isSurfaceVisible` flips false→true,
  // both effects re-run in the same commit (they share `isSurfaceVisible` in
  // their deps). React flushes effects in declaration order, so this one
  // writes `pendingHistoryScrollRef.current = deferredSessionId` FIRST, and
  // the pending-history effect then reads the freshly-written value. Swapping
  // the order silently breaks the fresh-launch scroll-to-bottom path.
  //
  // Both this effect and the pending-history effect below are `useLayoutEffect`
  // (not `useEffect`) so re-promotion of a deferred scroll and primitive start
  // happen in the same pre-paint commit. That avoids one-frame mask flicker and
  // ensures effect ordering remains deterministic for the deferred path.
  useLayoutEffect(() => {
    if (!isSurfaceVisible) return;
    const deferredSessionId = deferredScrollRef.current;
    if (!deferredSessionId) return;
    // Only consume the deferred scroll if the target session is the one now mounted —
    // otherwise wait for the right session to arrive.
    if (deferredSessionId !== currentSessionId) return;

    deferredScrollRef.current = null;
    // Re-promote to pendingHistoryScrollRef so the primary effect re-runs the
    // pane's `scrollToBottomUntilStable` primitive (Promise-returning, rAF-cadence
    // settle gate; see docs/plans/260420_scroll_to_bottom_primitive_refactor.md).
    // The primary effect re-runs because `isSurfaceVisible` is in its deps.
    pendingHistoryScrollRef.current = deferredSessionId;
  }, [isSurfaceVisible, currentSessionId]);

  /**
   * Check if the user is scrolled near the bottom of the container.
   * This is used to decide whether to auto-scroll when new content arrives.
   *
   * Returns false when the container has no layout (e.g., inside a
   * content-visibility:hidden ancestor) to prevent falsely reporting
   * "at bottom" when scroll dimensions are all zero.
   */
  const isNearBottom = useCallback(() => {
    const container = getScrollElement();
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    if (scrollHeight === 0 && clientHeight === 0) return false;
    return scrollHeight - scrollTop - clientHeight < NEAR_BOTTOM_THRESHOLD;
  }, [getScrollElement]);

  // Keep refs for values accessed by the scroll handler to avoid re-registering the
  // listener when they change. Re-registration during streaming created gaps where
  // wasNearBottomRef was re-initialized to a stale value. (FOX-2505)
  const isScrolledAwayRef = useRef(isScrolledAway);
  isScrolledAwayRef.current = isScrolledAway;
  const visibleMessagesLengthRef = useRef(visibleMessages.length);
  visibleMessagesLengthRef.current = visibleMessages.length;

  // Track scroll position to know if user was near bottom before new messages arrive.
  // Re-registers when isBusy changes to ensure handlers are on the correct container
  // element — the container may not be available on the initial effect run (FOX-2668).
  useEffect(() => {
    const container = getScrollElement();
    if (!container) return;

    const handleScroll = () => {
      const currentScrollTop = container.scrollTop;
      const rawUpwardDelta = prevScrollTopRef.current - currentScrollTop;
      // When the user is actively performing a scroll gesture (wheel/touch/pointer
      // within the debounce window), even 1px of upward movement is intentional.
      // The stricter >2px threshold only applies to non-user-initiated scroll events
      // (TanStack Virtual measurement corrections, programmatic scrolls) to avoid
      // false-positive latch engagement from sub-pixel rounding.
      const scrolledUpward = userScrollingRef.current
        ? rawUpwardDelta > 0
        : rawUpwardDelta > 2;
      prevScrollTopRef.current = currentScrollTop;

      // Short-circuit for programmatic scrolls initiated by ConversationPane
      // (e.g., scroll-to-answer after user submits an AskUserQuestion). The
      // custom smooth-scroll function writes scrollTop each RAF frame; without
      // this guard, each write is observed as upward movement during a busy
      // turn and engages the sticky latch, breaking auto-scroll for
      // subsequent turns. We still update prevScrollTopRef (above) so the
      // next natural scroll event compares against the correct baseline.
      // See docs-private/investigations/260416_answered_question_card_not_visible.md (M2).
      const paneProgrammaticScrollInFlight = containerRef.current?.isProgrammaticScrollInFlight?.() ?? false;
      if (suppressScrollHandlerRef.current || paneProgrammaticScrollInFlight) {
        return;
      }

      if (answerTopPinnedTurnIdRef.current && rawUpwardDelta !== 0) {
        clearAnswerTopPin('user-scroll');
      }

      const nearBottom = isNearBottom();

      // When user scrolls upward during an active turn, force wasNearBottomRef false
      // and latch the sticky scroll-away. This prevents virtualizer measurement
      // corrections (non-upward scroll events) from flipping wasNearBottomRef back
      // to true and re-engaging the content growth interval.
      if (scrolledUpward && isBusyRef.current) {
        wasNearBottomRef.current = false;
        stickyScrollAwayRef.current = true;
        if (!isScrolledAwayRef.current) {
          setIsScrolledAway(true);
          messageCountWhenScrolledAwayRef.current = visibleMessagesLengthRef.current;
        }
        return;
      }

      // While the sticky latch is active (user scrolled away during streaming),
      // only re-engage auto-scroll if the user is actively scrolling BACK
      // toward the bottom. Require both downward movement (>2px) AND proximity
      // to the bottom. This prevents stale scroll events from programmatic
      // scrolls (chase loops, content growth interval) from clearing the latch
      // when the user has just started scrolling away — those events land at
      // distanceFromBottom≈0 with userScrollingRef=true but no downward movement.
      if (stickyScrollAwayRef.current && isBusyRef.current) {
        const scrolledDownward = rawUpwardDelta < -2;
        if (userScrollingRef.current && scrolledDownward) {
          const { scrollHeight, clientHeight } = container;
          const distanceFromBottom = scrollHeight - currentScrollTop - clientHeight;
          if (distanceFromBottom <= STICKY_CLEAR_THRESHOLD) {
            wasNearBottomRef.current = true;
            stickyScrollAwayRef.current = false;
            setIsScrolledAway(false);
            setNewMessageCount(0);
          }
        }
        return;
      }

      // When latch is active and not busy, only clear if user explicitly scrolled
      // back to the bottom. Use STICKY_CLEAR_THRESHOLD (not NEAR_BOTTOM_THRESHOLD)
      // so measurement corrections and small scroll movements don't clear it.
      // The latch persists across turn boundaries to prevent auto-scroll from
      // re-engaging on auto-continue turns. (FOX-2596)
      if (stickyScrollAwayRef.current && !isBusyRef.current) {
        if (userScrollingRef.current) {
          const { scrollHeight, clientHeight } = container;
          const distanceFromBottom = scrollHeight - currentScrollTop - clientHeight;
          if (distanceFromBottom <= STICKY_CLEAR_THRESHOLD) {
            stickyScrollAwayRef.current = false;
            wasNearBottomRef.current = true;
            setIsScrolledAway(false);
            setNewMessageCount(0);
          }
        }
        return;
      }

      // During busy: if the user is making a scroll gesture (wheel/touch/key
      // within the debounce window) and they're NOT at the bottom, engage the
      // latch immediately. This catches the race where a programmatic scroll
      // (chase loop or content growth interval) outraces the user's gesture
      // and resets wasNearBottomRef to true before the upward-scroll branch
      // can trigger.
      if (isBusyRef.current && userScrollingRef.current && !nearBottom) {
        wasNearBottomRef.current = false;
        stickyScrollAwayRef.current = true;
        if (!isScrolledAwayRef.current) {
          setIsScrolledAway(true);
          messageCountWhenScrolledAwayRef.current = visibleMessagesLengthRef.current;
        }
        return;
      }

      // During busy: only let wasNearBottomRef go from true→false, never
      // from false→true. Programmatic scrolls (chase loops, content growth
      // interval) fire scroll events that land at the bottom (nearBottom=true).
      // Without this guard, those events reset wasNearBottomRef=true and the
      // interval re-engages auto-scroll before the user's next wheel event
      // can trigger the sticky latch — the "gravity well" race condition.
      // Re-enabling auto-scroll during busy requires an explicit action:
      // scrollToLastMessage(), user message arrival, or latch re-engagement.
      if (isBusyRef.current) {
        if (!nearBottom) {
          wasNearBottomRef.current = false;
        }
        // When nearBottom is true, leave wasNearBottomRef at its current
        // value — if it was true (user at bottom, no scroll-away), it stays
        // true and auto-scroll continues; if it was false (user scrolled
        // away earlier), it stays false and auto-scroll stays disabled.
      } else {
        wasNearBottomRef.current = nearBottom;
      }
      
      // Update "scrolled away" state for jump-to-latest indicator
      // Only update React state when the value actually changes to prevent re-render thrash
      // during rapid scroll events (e.g., trackpad/mousewheel scrolling)
      const shouldBeScrolledAway = !nearBottom;
      if (shouldBeScrolledAway !== isScrolledAwayRef.current) {
        if (nearBottom) {
          // User scrolled back to bottom - reset state
          setIsScrolledAway(false);
          setNewMessageCount(0);
        } else {
          // User just scrolled away - record current message count
          setIsScrolledAway(true);
          messageCountWhenScrolledAwayRef.current = visibleMessagesLengthRef.current;
        }
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    // Initialize the ref — do NOT call isNearBottom() here to avoid overwriting
    // a user-driven scroll-away during listener re-attachment.

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [clearAnswerTopPin, getScrollElement, isNearBottom, isBusy, containerRef]);

  // Detect active user scroll gestures to suppress the content growth RAF loop's
  // scrollTop forcing. Without this, the RAF loop yanks users back to the
  // bottom before they can escape the NEAR_BOTTOM_THRESHOLD (150px).
  // Covers: trackpad/mouse wheel, touch, keyboard (PageUp/Down, arrows), scrollbar drag.
  // Re-registers when isBusy changes (same rationale as scroll handler above).
  useEffect(() => {
    const container = getScrollElement();
    if (!container) return;

    const markUserScrolling = () => {
      userScrollingRef.current = true;
      if (userScrollTimeoutRef.current) {
        clearTimeout(userScrollTimeoutRef.current);
      }
      userScrollTimeoutRef.current = setTimeout(() => {
        userScrollingRef.current = false;
      }, 300);
    };

    // Wheel handler: detect upward scroll during streaming and set the sticky latch
    // SYNCHRONOUSLY (before the browser applies the scroll). This is critical because
    // the scroll handler's upward-scroll detection (Path A) fires asynchronously —
    // Chromium's compositor dispatches scroll events after the 100ms content growth
    // interval has already overridden scrollTop. Wheel events fire on the main thread
    // before the browser moves the scroll position. (FOX-2668)
    const handleWheel = (e: WheelEvent) => {
      markUserScrolling();
      // deltaY < 0 = user wants to see content above (logical direction, not physical
      // gesture — macOS natural scrolling is inverted at the system level before the
      // browser receives the event).
      // Guards: skip zoom gestures (ctrl/meta+wheel) and non-scrollable state (scrollTop=0).
      if (e.deltaY < 0 && isBusyRef.current && !e.ctrlKey && !e.metaKey && container.scrollTop > 0) {
        wasNearBottomRef.current = false;
        stickyScrollAwayRef.current = true;
        if (!isScrolledAwayRef.current) {
          setIsScrolledAway(true);
          messageCountWhenScrolledAwayRef.current = visibleMessagesLengthRef.current;
        }
      }
    };

    const UPWARD_SCROLL_KEYS = new Set(['PageUp', 'ArrowUp', 'Home']);
    const ALL_SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Space']);
    const handleKeyScroll = (e: KeyboardEvent) => {
      if (ALL_SCROLL_KEYS.has(e.key)) {
        markUserScrolling();
      }
      // Set sticky latch synchronously for upward scroll keys during streaming
      if (UPWARD_SCROLL_KEYS.has(e.key) && isBusyRef.current && container.scrollTop > 0) {
        wasNearBottomRef.current = false;
        stickyScrollAwayRef.current = true;
        if (!isScrolledAwayRef.current) {
          setIsScrolledAway(true);
          messageCountWhenScrolledAwayRef.current = visibleMessagesLengthRef.current;
        }
      }
    };

    // Touch handler: detect touch movement during streaming.
    // Touch scroll events are delivered more reliably than wheel events because the
    // compositor holds the scroll under the finger, so Path A in handleScroll catches
    // touch-initiated upward scrolls. No synchronous latch needed here.
    const handleTouchMove = () => {
      markUserScrolling();
    };

    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('keydown', handleKeyScroll, { passive: true });
    container.addEventListener('pointerdown', markUserScrolling, { passive: true });

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('keydown', handleKeyScroll);
      container.removeEventListener('pointerdown', markUserScrolling);
      if (userScrollTimeoutRef.current) {
        clearTimeout(userScrollTimeoutRef.current);
      }
    };
  }, [getScrollElement, isBusy]);

  const markPendingHistoryScroll = useCallback((sessionId: string, markTimeCurrentSessionId: string) => {
    // Abort any in-flight primitive from a prior mark. Its `.then()` handler
    // will observe `controller.signal.aborted` and become a no-op, so state
    // mutations from the stale run can't contaminate the new session.
    // See docs/plans/260420_scroll_to_bottom_primitive_refactor.md (Stage 2).
    abortRef.current?.abort();
    abortRef.current = null;
    // A new explicit mark supersedes any stale deferred mark too. The deferred
    // layout effect runs before the pending-history effect, so a leftover
    // deferred target from a hidden-surface open would otherwise promote itself
    // on the next visible render and overwrite this mark (reviewer F1, stage 2).
    deferredScrollRef.current = null;
    pendingHistoryScrollRef.current = sessionId;
    // Store-truth session that was current when this navigation started — see
    // the result-type doc and the mark-time orphan guard in the pending-history
    // effect below. A superseding mark replaces this cleanly along with the target.
    markTimeSessionIdRef.current = markTimeCurrentSessionId;
    // Raise the mask optimistically. The pending-history effect consumes this
    // token and clears `isSettling` when the primitive resolves.
    setIsSettling(true);
    setIsRevealMasked(true);
    clearAnswerTopPin('history-open');
    // Clear scroll-away state since we're loading fresh history
    setIsScrolledAway(false);
    setNewMessageCount(0);
  }, [clearAnswerTopPin]);

  const cancelPendingHistoryScroll = useCallback((sessionId?: string) => {
    // Called when session open fails after markPendingHistoryScroll was called.
    // Clears the pending state and reveals the pane to avoid stuck hidden state.
    //
    // When `sessionId` is provided, only cancel if it matches the currently-pending
    // target. This prevents a stale navigation's failure from clearing a NEWER
    // navigation's pending scroll — the classic "everywhere" race from FOX-3040's
    // follow-up (see docs-private/investigations/260420_scroll_to_bottom_still_broken.md).
    if (sessionId !== undefined) {
      if (pendingHistoryScrollRef.current !== sessionId && deferredScrollRef.current !== sessionId) {
        return;
      }
    }
    pendingHistoryScrollRef.current = null;
    deferredScrollRef.current = null;
    markTimeSessionIdRef.current = null;
    setIsSettling(false);
    setIsRevealMasked(false);
  }, []);

  // Handle pending history scroll (when opening a history session).
  //
  // SESSION-ID GATE (FOX-3040 follow-up, Apr 2026):
  // The pending ref stores the *target* sessionId. This effect only fires when
  // that target matches the currently-mounted `currentSessionId` — otherwise the
  // flag would be consumed prematurely by an intermediate render (while the
  // previous session is still mounted), leaving the new session stranded at the
  // top. See docs-private/investigations/260420_scroll_to_bottom_still_broken.md.
  //
  // `useLayoutEffect` (not `useEffect`) keeps pending-history scroll setup
  // pre-paint and ordered with the deferred-scroll effect above. This prevents
  // transient mask flicker and ensures the primitive starts against the correct
  // session/surface state.
  useLayoutEffect(() => {
    // MARK-TIME ORPHAN GUARD (stuck reveal-mask class kill —
    // docs/plans/260611_fix-stuck-reveal-mask/PLAN.md):
    // A pending (or deferred) mark stays alive only while `currentSessionId` is
    // the mark-time session (navigation still in progress — FOX-3040 intermediate
    // renders must not cancel) or the pending target (navigation landed; consumed
    // below). Any THIRD id means the marked navigation has lost (new chat,
    // delete-of-current, clear-all, a navigation race, …): nothing can ever
    // consume the mark, so without this cancel `isRevealMasked` stays up forever
    // (stuck skeleton overlay + frozen sidebar via `shouldFreezeSidebarList`).
    // Placed BEFORE the non-session-surface early-return: a stuck mask freezes
    // the sidebar even while a non-session surface is active.
    const orphanCandidateSessionId = pendingHistoryScrollRef.current ?? deferredScrollRef.current;
    if (
      orphanCandidateSessionId !== null &&
      currentSessionId !== orphanCandidateSessionId &&
      currentSessionId !== markTimeSessionIdRef.current
    ) {
      const markTimeSessionId = markTimeSessionIdRef.current;
      pendingHistoryScrollRef.current = null;
      deferredScrollRef.current = null;
      markTimeSessionIdRef.current = null;
      // Defensive: the effect cleanup has normally already aborted an in-flight
      // primitive; an orphaned DEFERRED mark has none in flight.
      abortRef.current?.abort();
      abortRef.current = null;
      setIsSettling(false);
      setIsRevealMasked(false);
      abandonSwitchTimingIfMatches(orphanCandidateSessionId, 'cancelled');
      // No silent self-heal: orphan cancels must stay countable so residual
      // navigation races (e.g. the cache-hit stale-apply race in
      // useAgentSessionEngine.openHistorySession) remain visible in telemetry.
      // Same seam as 'Scroll Settle Outcome' below.
      analytics.track('Reveal Mask Orphan Cancelled', {
        pendingSessionId: orphanCandidateSessionId,
        markTimeSessionId,
        currentSessionId,
      });
      if (import.meta.env.DEV) {
        console.warn('[scroll-settle] orphaned pending history mark cancelled', {
          pendingSessionId: orphanCandidateSessionId,
          markTimeSessionId,
          currentSessionId,
        });
      }
      return;
    }

    const pendingSessionId = pendingHistoryScrollRef.current;
    if (!pendingSessionId) {
      return;
    }
    if (isNonSessionSurface) {
      return;
    }
    // Wait for the target session's data to be the one mounted before attempting
    // the scroll. The store's `currentSessionId` updates synchronously inside
    // `openHistorySession`, and `visibleMessages` updates in the same render, so
    // matching on sessionId ensures we don't scroll the wrong transcript and
    // clear the flag prematurely.
    if (pendingSessionId !== currentSessionId) {
      return;
    }

    // Defer scroll if the surface is hidden (content-visibility: hidden).
    // The scroll container has zero dimensions in this state, so scrolling
    // would be a no-op. The deferred-scroll effect re-promotes it when visible.
    if (!isSurfaceVisible) {
      deferredScrollRef.current = pendingSessionId;
      pendingHistoryScrollRef.current = null;
      return;
    }

    // AbortController for this effect run. Aborted if:
    //   - the effect re-runs (visibility / session change);
    //   - the hook unmounts;
    //   - a new markPendingHistoryScroll() targets a different session.
    // See docs/plans/260420_scroll_to_bottom_primitive_refactor.md (Stage 2).
    const controller = new AbortController();
    abortRef.current = controller;

    // Keep pendingHistoryScrollRef SET until the primitive resolves. If the
    // effect cleans up while the surface is hidden (mid-primitive surface-hide),
    // the cleanup re-promotes into deferredScrollRef so the deferred-scroll
    // effect re-triggers the primitive when the surface returns.
    wasNearBottomRef.current = true;
    stickyScrollAwayRef.current = false;

    const handle = containerRef.current;
    // Pane not mounted yet (genuinely absent — e.g., SessionSurfaceContent is
    // rendering the trashed-session prompt branch instead of ConversationPane,
    // or first mount hasn't committed the ref yet). Abandon this effect run
    // cleanly; the next one will re-evaluate when the pane mounts. `isSettling`
    // stays `true`, pending ref stays set, the mask stays up until a mount
    // happens.
    if (!handle) {
      return () => controller.abort();
    }
    // Handle is present but missing the new primitive method — only happens
    // for old test mocks in practice (the handle type made it non-optional).
    // Dev-mode warn loudly so drift can't hide; fall back to the legacy
    // single-shot scroll so the test's observable semantics still hold.
    if (!handle.scrollToBottomUntilStable) {
      if (import.meta.env.DEV) {
        console.warn('[scroll-settle] scrollToBottomUntilStable missing — using fallback');
      }
      handle.scrollToBottom();
      pendingHistoryScrollRef.current = null;
      setIsSettling(false);
      abandonSwitchTimingIfMatches(pendingSessionId, 'failed');
      return () => controller.abort();
    }

    // Route every session switch through the primitive. Previous warm-cache
    // fast paths were removed because they could finish before async tail
    // content (e.g., feedback prompt) rendered, leaving reopen landings short.
    const primitive = handle.scrollToBottomUntilStable;
    markPrimitiveStart(pendingSessionId);
    primitive({
      signal: controller.signal,
    }).then((result) => {
      markPrimitiveResolved(
        pendingSessionId,
        result.reason,
        result.landedAtBottom,
        result.diagnostics,
      );
      // Session may have changed between primitive start and resolution.
      // `controller.signal.aborted` implies either unmount or a new session —
      // don't mutate state (the new effect run owns `pendingHistoryScrollRef`
      // and `isSettling` now).
      if (controller.signal.aborted) {
        abandonSwitchTimingIfMatches(pendingSessionId, 'aborted');
        return;
      }

      pendingHistoryScrollRef.current = null;
      setIsSettling(false);
      setIsRevealMasked(false);
      finishSwitchTiming(pendingSessionId);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          markPaintAfterReveal(pendingSessionId);
        });
      });

      // Telemetry: reason distribution is the load-bearing signal that the
      // race class is actually eliminated in production. `aborted` resolutions
      // are not telemetered (short-circuited above) because aborts reflect
      // upstream navigation, not a user-perceived settle outcome.
      analytics.track('Scroll Settle Outcome', {
        reason: result.reason,
        landedAtBottom: result.landedAtBottom,
        messageCount: visibleMessagesLengthRef.current,
      });

      // `stable` is the happy path.
      // `unmounted` means the pane disappeared mid-primitive (pane unmount
      // while the hook is still alive — possible with conditional render
      // flips). No further state mutation is safe or useful; do NOT show
      // the Jump-to-Latest banner for this case.
      if (result.reason === 'stable' || result.reason === 'unmounted') return;

      // Degraded outcomes:
      //   timeout       → ran out of budget; scroll may be close but not
      //                   stable. Expose "Jump to Latest" as recovery.
      //   user-scrolled → user chose to be elsewhere. CRITICAL: engage the
      //                   sticky latch EXPLICITLY, because the hook's scroll
      //                   handler short-circuits on isProgrammaticScrollInFlight()
      //                   for the entire primitive life and cannot engage the
      //                   latch itself. This is the FOX-2668 handoff
      //                   (Invariant #2, load-bearing).
      //   empty         → nothing to scroll to; hook reveals pane with no
      //                   scroll-away banner.
      if (result.reason === 'user-scrolled') {
        stickyScrollAwayRef.current = true;
        wasNearBottomRef.current = false;
      }

      if (!result.landedAtBottom && result.reason !== 'empty') {
        setIsScrolledAway(true);
        messageCountWhenScrolledAwayRef.current = visibleMessagesLengthRef.current;
      }
    }).catch((_err: unknown) => {
      // Defence-in-depth: the primitive's executor is written to resolve-
      // never-reject (every exit goes through `settle()`). If a future
      // refactor accidentally throws inside the executor, the Promise
      // would reject and the .then() above would never run — leaving
      // `isSettling=true` and the mask stuck up. Catch here so we at
      // least reveal the pane and log loudly in dev. Aborted runs don't
      // reach this (we short-circuit above on `controller.signal.aborted`).
      if (controller.signal.aborted) return;
      pendingHistoryScrollRef.current = null;
      setIsSettling(false);
      setIsRevealMasked(false);
      abandonSwitchTimingIfMatches(pendingSessionId, 'failed');
    });

    return () => {
      controller.abort();
      // Note: mid-primitive surface-hide re-promotion is handled by the
      // NEXT effect-body run's `!isSurfaceVisible` early-defer branch above,
      // NOT here. This cleanup's closure captures `isSurfaceVisible` at the
      // moment we committed the primitive, which must have been `true` (the
      // early-defer branch would otherwise have exited before registering a
      // cleanup). When `isSurfaceVisible` flips `true → false`, the effect
      // re-runs: this cleanup fires the abort, then the new effect body
      // runs and its own early-defer branch promotes `pendingSessionId`
      // into `deferredScrollRef` — which survives because `.then()`
      // short-circuits on `controller.signal.aborted` and never clears the
      // pending ref for the superseded primitive.
    };
    // NOTE: `visibleMessages` intentionally NOT in deps. If it were, a new
    // message arriving mid-settle would abort the in-flight primitive and
    // restart it — swallowing any user-scroll that the first primitive had
    // already observed (the abort would race the `.then()` latch-engagement
    // path). Instead we read length via `visibleMessagesLengthRef.current`
    // inside the `.then()` handler, so we see the CURRENT length at
    // resolution time without restarting.
  }, [isNonSessionSurface, isSurfaceVisible, currentSessionId, containerRef]);

  // Cleanup user scroll timeout on unmount. The pending-history primitive's
  // AbortController is cleaned up by the effect above's own cleanup — no
  // separate unmount hook is needed for it.
  useEffect(() => {
    return () => {
      if (userScrollTimeoutRef.current) {
        clearTimeout(userScrollTimeoutRef.current);
      }
      if (suppressScrollHandlerTimerRef.current) {
        clearTimeout(suppressScrollHandlerTimerRef.current);
      }
    };
  }, []);

  // Auto-scroll when new messages arrive (if user was already near bottom)
  useEffect(() => {
    const prevLength = prevVisibleMessagesLengthRef.current;
    prevVisibleMessagesLengthRef.current = visibleMessages.length;

    if (visibleMessages.length === 0) {
      lastAutoScrolledMessageIdRef.current = null;
      clearAnswerTopPin('empty-transcript');
      return;
    }
    if (pendingHistoryScrollRef.current || isNonSessionSurface) {
      lastAutoScrolledMessageIdRef.current = visibleMessages[visibleMessages.length - 1]?.id ?? null;
      return;
    }

    const latestMessage = visibleMessages[visibleMessages.length - 1];
    if (!latestMessage || lastAutoScrolledMessageIdRef.current === latestMessage.id) {
      return;
    }

    lastAutoScrolledMessageIdRef.current = latestMessage.id;
    
    // Skip if auto-scroll is paused (e.g., context menu is open)
    if (pauseAutoScroll) {
      return;
    }

    // Detect message removal (thinking prune): when tool calls start, short
    // "thinking-style" assistant text is pruned from visibleMessages, causing
    // the user's original message to become the latest. Without this guard,
    // the isUserMessage check below would bypass the sticky latch and yank
    // the user to the bottom. (FOX-2596)
    const messagesDecreased = visibleMessages.length < prevLength;
    
    // ALWAYS scroll when user sends a GENUINELY NEW message - they should see their
    // own message and the response. But NOT when a message removal (thinking prune)
    // exposes a stale user message as the latest.
    // See: docs/plans/finished/260120_jump_to_latest_scroll_fix.md
    const isUserMessage = latestMessage.role === 'user' && !messagesDecreased;
    const isAssistantAnswer = latestMessage.role === 'assistant' || latestMessage.role === 'result';

    // Queue-drained messages should NOT force scroll to bottom — the user may be reading
    // the previous response. Let the RAF content-growth loop handle it naturally.
    const isQueueDrainedMessage = isUserMessage && latestMessage.messageOrigin === 'queue-drain';

    if (isQueueDrainedMessage) {
      // Don't scroll or clear latch — preserve user's scroll position.
      // The RAF content-growth loop will scroll if user was already near bottom.
    } else if (
      isAssistantAnswer &&
      isBusy &&
      isSurfaceVisible &&
      latestMessage.turnId &&
      answerTopPinnedTurnIdRef.current !== latestMessage.turnId &&
      wasNearBottomRef.current &&
      !stickyScrollAwayRef.current
    ) {
      const originatingOrigin = getOriginatingUserMessageOrigin(
        originLookupMessages,
        latestMessage.turnId,
      );
      if (originatingOrigin === 'queue-drain') {
        // Don't yank queue-drain turns to top (or fall through to bottom chase).
        return;
      }

      const handle = containerRef.current;
      const targetIndex = visibleMessages.length - 1;
      if (!handle || targetIndex < 0) {
        return;
      }
      answerTopPinnedTurnIdRef.current = latestMessage.turnId;
      setIsAnswerTopPinned(true);
      wasNearBottomRef.current = false;
      setIsScrolledAway(false);
      setNewMessageCount(0);
      suppressScrollHandlerForProgrammaticJump();
      handle.scrollToIndex(targetIndex, { align: 'start', behavior: 'auto' });
    } else if (isUserMessage || (wasNearBottomRef.current && !stickyScrollAwayRef.current)) {
      // Defer scroll if the surface is hidden (content-visibility: hidden).
      // The deferred-scroll effect retries when the surface becomes visible.
      // Tag the deferred scroll with the current session id so a later session
      // switch doesn't consume it for the wrong transcript.
      if (!isSurfaceVisible) {
        deferredScrollRef.current = currentSessionId;
      } else {
        scrollToLastMessage();
      }
      // Reset scroll state when user sends a message so streaming auto-scroll works
      if (isUserMessage) {
        clearAnswerTopPin('new-user-message');
        wasNearBottomRef.current = true;
        stickyScrollAwayRef.current = false;
        setIsScrolledAway(false);
        setNewMessageCount(0);
      }
    }
  }, [
    clearAnswerTopPin,
    containerRef,
    currentSessionId,
    isBusy,
    isNonSessionSurface,
    isSurfaceVisible,
    pauseAutoScroll,
    originLookupMessages,
    scrollToLastMessage,
    suppressScrollHandlerForProgrammaticJump,
    visibleMessages,
  ]);

  // Track new message count when user is scrolled away
  useEffect(() => {
    if (!isScrolledAway) return;
    const newCount = Math.max(0, visibleMessages.length - messageCountWhenScrolledAwayRef.current);
    setNewMessageCount(newCount);
  }, [isScrolledAway, visibleMessages.length]);

  // Catch-up scroll fires only when the catch-up-eligible pause source (selection menu)
  // closes AND no other pause source is keeping the conversation paused.
  //
  // Why: docs-private/investigations/260509_annotation_save_jumps_to_bottom.md
  // `pauseAutoScroll` now includes long-lived annotation popover pauses; only the brief
  // selection-menu pause should trigger catch-up to recover streamed content.
  const prevPauseAutoScrollCatchUpEligibleRef = useRef(pauseAutoScrollCatchUpEligible);
  useEffect(() => {
    const wasEligibleBefore = prevPauseAutoScrollCatchUpEligibleRef.current;
    prevPauseAutoScrollCatchUpEligibleRef.current = pauseAutoScrollCatchUpEligible;
    
    // If catch-up eligibility just ended and no other pause source remains, catch up.
    if (
      wasEligibleBefore &&
      !pauseAutoScrollCatchUpEligible &&
      !pauseAutoScroll &&
      !isAnswerTopPinned &&
      wasNearBottomRef.current &&
      !stickyScrollAwayRef.current &&
      !isNonSessionSurface
    ) {
      scrollToLastMessage();
    }
  }, [
    isAnswerTopPinned,
    pauseAutoScrollCatchUpEligible,
    pauseAutoScroll,
    isNonSessionSurface,
    scrollToLastMessage,
  ]);

  // Auto-scroll when a NEW turn starts (to show the thinking placeholder).
  // Only fires on null→value transitions of processingTurnId (genuine new turn),
  // NOT on focus changes (focusTurn updates focusedTurnId only).
  // Without this guard, clicking previous messages during streaming would yank the
  // user back to the bottom. (FOX-2505)
  useEffect(() => {
    const prevTurnId = prevProcessingTurnIdForScrollRef.current;
    prevProcessingTurnIdForScrollRef.current = processingTurnId;

    // Only scroll when a turn genuinely starts (null → value), not on focus changes
    if (!processingTurnId || prevTurnId !== null) {
      return;
    }
    if (!isBusy || isNonSessionSurface || pauseAutoScroll) {
      return;
    }
    // Only auto-scroll if user was near the bottom and hasn't scrolled away.
    // The latch check is belt-and-suspenders: it persists across turn boundaries
    // (FOX-2596), so if the user scrolled up during the previous turn and a new
    // auto-continue turn starts, this prevents the yank.
    if (!wasNearBottomRef.current || stickyScrollAwayRef.current) {
      return;
    }

    // Don't force scroll on queue-drained turn starts — the RAF loop handles it.
    // Must inspect raw (unfiltered) messages so hidden system-continuation users
    // don't cause stale-origin inheritance.
    const originatingOrigin = getOriginatingUserMessageOrigin(originLookupMessages, processingTurnId);
    if (originatingOrigin === 'queue-drain') {
      return;
    }

    // Small delay to let the thinking placeholder render
    const timeoutId = setTimeout(() => {
      scrollToLastMessage();
    }, 50);
    return () => clearTimeout(timeoutId);
  }, [processingTurnId, isBusy, isNonSessionSurface, pauseAutoScroll, scrollToLastMessage, originLookupMessages]);

  // NOTE: The sticky latch is NOT cleared when isBusy goes false (FOX-2596).
  // It persists across turn boundaries so auto-scroll doesn't re-engage on
  // auto-continue turns. The latch is cleared only by explicit user actions:
  // scrollToLastMessage(), user message send, session switch, or scrolling
  // back to bottom (via the scroll handler's STICKY_CLEAR_THRESHOLD check).

  // Continuously scroll as content grows during an active turn (streaming).
  // Uses requestAnimationFrame instead of setInterval to synchronize scroll
  // adjustments with the browser's paint cycle. The previous 100ms interval
  // caused visible jiggle: content grew between ticks (useSmoothStream updates
  // at ~50ms), so the bottom drifted away then snapped back each tick.
  // RAF checks scrollHeight once per frame (~16ms) which is cheap (the value
  // is already computed by layout) and eliminates the drift-snap saw-tooth.
  // Only runs when agent is busy to avoid idle CPU overhead.
  // Note: We run this when isBusy is true, even if processingTurnId is not yet set.
  // This handles the "starting indicator" phase where isBusy=true but processingTurnId=null
  // (the brief gap between user message send and IPC response with turnId).
  const lastScrollHeightRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  
  useEffect(() => {
    if (!isBusy || isNonSessionSurface || pauseAutoScroll || isAnswerTopPinned) {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      return;
    }
    const container = getScrollElement();
    if (!container) {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      return;
    }

    lastScrollHeightRef.current = container.scrollHeight;

    const tick = () => {
      const scrollEl = getScrollElement();
      if (!scrollEl) return;
      
      // Don't auto-scroll if user has text selected - prevents "jumping" selection
      // that makes text highlighting feel broken (FOX-2159)
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        rafIdRef.current = requestAnimationFrame(tick);
        return;
      }
      
      // Use wasNearBottomRef (set by scroll listener) instead of calling isNearBottom() live.
      // This respects the user's scroll intent: if they scrolled away to read, we won't
      // force them back to the bottom. The ref is only set to true when user is genuinely
      // near bottom, preventing the janky "fighting the scroll" effect during streaming.
      const currentScrollHeight = scrollEl.scrollHeight;
      if (currentScrollHeight !== lastScrollHeightRef.current) {
        if (wasNearBottomRef.current && !userScrollingRef.current && !stickyScrollAwayRef.current) {
          // Scroll to the actual bottom (scrollHeight - clientHeight), not the full
          // scrollHeight. Using the full value relied on browser clamping, which triggers
          // an extra scroll event that can flip wasNearBottomRef back to true. (FOX-2505)
          scrollEl.scrollTop = currentScrollHeight - scrollEl.clientHeight;
          lastScrollHeightRef.current = currentScrollHeight;
        } else {
          lastScrollHeightRef.current = currentScrollHeight;
        }
      }

      rafIdRef.current = requestAnimationFrame(tick);
    };

    rafIdRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [isAnswerTopPinned, isBusy, getScrollElement, isNonSessionSurface, pauseAutoScroll]);

  // Derived convenience value
  const hasNewMessagesBelow = isScrolledAway && newMessageCount > 0;

  return {
    scrollToLastMessage,
    markPendingHistoryScroll,
    cancelPendingHistoryScroll,
    isSettling,
    isRevealMasked,
    isScrolledAway,
    newMessageCount,
    hasNewMessagesBelow,
    isAnswerTopPinned,
  };
}
