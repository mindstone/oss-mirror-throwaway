// @vitest-environment happy-dom
/// <reference types="vitest/globals" />

/**
 * Regression tests for the session-ID token guard on `pendingHistoryScrollRef`.
 *
 * Context: `useConversationAutoScroll` exposes
 * `markPendingHistoryScroll(sessionId, markTimeCurrentSessionId)` and
 * `cancelPendingHistoryScroll(sessionId?)`. The second mark argument is the
 * session that was current (store truth) when the navigation started — it feeds
 * the mark-time orphan guard (docs/plans/260611_fix-stuck-reveal-mask/PLAN.md). The hook tracks the *target*
 * session of a pending history scroll (not just a boolean), which prevents two
 * classes of bug diagnosed in
 * docs-private/investigations/260420_scroll_to_bottom_still_broken.md:
 *
 *   1. A stale navigation's failure clearing a NEWER navigation's pending scroll
 *      (the "clicked A then quickly clicked B" race). This was the FOX-3040
 *      follow-up root cause: the boolean flag meant `cancelPendingHistoryScroll()`
 *      for the losing request A would silently clear the pending scroll that
 *      the winning request B had just registered, leaving users stuck at the
 *      top of B even on the canonical navigation path.
 *   2. A deferred scroll (fired while the surface was hidden) being re-promoted
 *      into the wrong session's transcript when the surface becomes visible.
 *
 * These tests pin the contract at the API boundary. They don't attempt to
 * simulate the chase loop or virtualization (happy-dom can't); they verify
 * that the hook doesn't expose itself to being hijacked by stale calls.
 *
 * ## Observable-signal shift (Stage 2 of the scroll-to-bottom primitive refactor)
 *
 * After Stage 2 of docs/plans/260420_scroll_to_bottom_primitive_refactor.md, the
 * pending-history path in `useConversationAutoScroll` calls
 * `scrollToBottomUntilStable` (the Promise-returning settling primitive on
 * `ConversationPaneHandle`) instead of `scrollToBottom`. The FOX-3040
 * session-id-token invariant is **UNCHANGED** — the observable simply moved.
 * Assertions that test "pending-history scroll fired" therefore observe
 * `scrollToBottomUntilStable.mock.calls` now. Assertions on `scrollToBottom`
 * remain valid for the message-arrival path, which still goes through
 * `scrollToLastMessage → handle.scrollToBottom`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@renderer/test-utils';
import type { AgentTurnMessage } from '@shared/types';
import { useConversationAutoScroll } from '../useConversationAutoScroll';
import type { ConversationPaneHandle } from '../../components/ConversationPane';

const makeMessage = (
  overrides: Partial<AgentTurnMessage> & { id: string; role: AgentTurnMessage['role'] }
): AgentTurnMessage => ({
  turnId: 'turn-1',
  text: 'test',
  createdAt: Date.now(),
  ...overrides,
});

function createMockHandle() {
  const scrollElement = document.createElement('div');
  Object.defineProperties(scrollElement, {
    scrollHeight: { value: 5000, configurable: true, writable: true },
    clientHeight: { value: 600, configurable: true, writable: true },
    scrollTop: { value: 0, writable: true, configurable: true },
  });

  const scrollToBottom = vi.fn();
  // After Stage 2 of the scroll-to-bottom primitive refactor
  // (docs/plans/260420_scroll_to_bottom_primitive_refactor.md), the
  // pending-history path calls this primitive instead of `scrollToBottom`.
  // The FOX-3040 session-id-token invariant is UNCHANGED — the observable
  // just moved. Tests that previously asserted on `scrollToBottom.mock.calls`
  // for the pending-history signal now assert on `scrollToBottomUntilStable`.
  const scrollToBottomUntilStable = vi
    .fn()
    .mockResolvedValue({ landedAtBottom: true, reason: 'stable' as const });
  const handle: ConversationPaneHandle = {
    scrollToIndex: vi.fn(),
    scrollToBottom,
    scrollToBottomUntilStable,
    getScrollElement: () => scrollElement,
    getVisibleRange: () => null,
    isProgrammaticScrollInFlight: () => false,
  };

  return {
    ref: { current: handle },
    scrollElement,
    handle,
    scrollToBottom,
    scrollToBottomUntilStable,
  };
}

describe('useConversationAutoScroll — session-id-token pending-scroll guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('isSettling stays true after a stale cancel for a non-matching session', () => {
    const { ref } = createMockHandle();
    const messages: AgentTurnMessage[] = [makeMessage({ id: 'm1', role: 'user' })];

    const { result } = renderHook(() =>
      useConversationAutoScroll({
        containerRef: ref,
        visibleMessages: messages,
        processingTurnId: null,
        isBusy: false,
        isInsightSurface: false,
        isDiagnosticsSurface: false,
        currentSessionId: 'session-B',
        isSurfaceVisible: true,
      }),
    );

    // Simulate: click triggers markPendingHistoryScroll for session B (the
    // newer navigation). Settling begins.
    act(() => {
      result.current.markPendingHistoryScroll('session-B', 'session-B');
    });
    expect(result.current.isSettling).toBe(true);

    // A stale navigation for session A resolves with failure (e.g., superseded
    // by a newer request, returning `opened = false`). Its executeOpenHistory
    // calls cancel with the stale session id.
    act(() => {
      result.current.cancelPendingHistoryScroll('session-A');
    });

    // B's pending scroll must survive — cancel is scoped to its own request.
    expect(result.current.isSettling).toBe(true);
  });

  it('matching cancel clears isSettling', () => {
    const { ref } = createMockHandle();
    const messages: AgentTurnMessage[] = [makeMessage({ id: 'm1', role: 'user' })];

    const { result } = renderHook(() =>
      useConversationAutoScroll({
        containerRef: ref,
        visibleMessages: messages,
        processingTurnId: null,
        isBusy: false,
        isInsightSurface: false,
        isDiagnosticsSurface: false,
        currentSessionId: 'session-A',
        isSurfaceVisible: true,
      }),
    );

    act(() => {
      result.current.markPendingHistoryScroll('session-A', 'session-A');
    });
    expect(result.current.isSettling).toBe(true);

    // Matching cancel — the same navigation that marked is cancelling.
    act(() => {
      result.current.cancelPendingHistoryScroll('session-A');
    });

    expect(result.current.isSettling).toBe(false);
  });

  it('cancel without sessionId still cancels (unconditional escape hatch)', () => {
    const { ref } = createMockHandle();
    const messages: AgentTurnMessage[] = [makeMessage({ id: 'm1', role: 'user' })];

    const { result } = renderHook(() =>
      useConversationAutoScroll({
        containerRef: ref,
        visibleMessages: messages,
        processingTurnId: null,
        isBusy: false,
        isInsightSurface: false,
        isDiagnosticsSurface: false,
        currentSessionId: 'session-A',
        isSurfaceVisible: true,
      }),
    );

    act(() => {
      result.current.markPendingHistoryScroll('session-A', 'session-A');
    });

    // Non-sessionId cancel — always cancels (for legacy callers or when we
    // don't know which navigation is cancelling).
    act(() => {
      result.current.cancelPendingHistoryScroll();
    });

    expect(result.current.isSettling).toBe(false);
  });

  it('scroll fires only when the mounted session matches the pending target', () => {
    const { ref, scrollToBottomUntilStable } = createMockHandle();

    // Start with session A mounted. Pending scroll for B (newer nav not yet
    // applied to store). The effect should NOT scroll — wait for B to mount.
    const initialMessages: AgentTurnMessage[] = [makeMessage({ id: 'a1', role: 'user' })];

    const { result, rerender } = renderHook(
      ({ sessionId, messages }: { sessionId: string; messages: AgentTurnMessage[] }) =>
        useConversationAutoScroll({
          containerRef: ref,
          visibleMessages: messages,
          processingTurnId: null,
          isBusy: false,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: sessionId,
          isSurfaceVisible: true,
        }),
      { initialProps: { sessionId: 'session-A', messages: initialMessages } },
    );

    // Clear any initial-mount primitive invocations. The observable signal
    // for the pending-history path is the `scrollToBottomUntilStable` mock
    // (see file-header comment); we snapshot and reset its call count to
    // isolate calls caused by the pending-history effect.
    scrollToBottomUntilStable.mockClear();

    act(() => {
      result.current.markPendingHistoryScroll('session-B', 'session-A');
    });

    // Re-render with session A still mounted — the pending-history effect
    // must NOT fire for session-A because the token targets session-B.
    // (Note: a message-arrival scroll may happen for unrelated reasons on
    // this re-render if messages changed; we only re-render with the same
    // messages to isolate the pending-scroll path.)
    rerender({ sessionId: 'session-A', messages: initialMessages });
    const callsBeforeBMounts = scrollToBottomUntilStable.mock.calls.length;

    // Now the store updates with session B's data — the pending-history
    // effect fires the primitive for B.
    const bMessages: AgentTurnMessage[] = [
      makeMessage({ id: 'b1', role: 'user' }),
      makeMessage({ id: 'b2', role: 'assistant' }),
    ];
    rerender({ sessionId: 'session-B', messages: bMessages });

    // At least one additional primitive invocation should have fired (the
    // pending-history scroll for session B). The assertion is deliberately
    // loose because unrelated re-runs of the effect may also invoke the
    // primitive for the same session; all such calls are desirable.
    expect(scrollToBottomUntilStable.mock.calls.length).toBeGreaterThan(callsBeforeBMounts);
  });

  it('deferred scroll while surface is hidden survives a stale cancel for another session', () => {
    const { ref, scrollToBottom, scrollToBottomUntilStable } = createMockHandle();
    const messages: AgentTurnMessage[] = [makeMessage({ id: 'a1', role: 'user' })];

    // Start with surface hidden — simulates "fresh launch, user clicks sidebar"
    // where sessions surface is content-visibility: hidden until setActiveSurface.
    const { result, rerender } = renderHook(
      ({ sessionId, isSurfaceVisible }: { sessionId: string; isSurfaceVisible: boolean }) =>
        useConversationAutoScroll({
          containerRef: ref,
          visibleMessages: messages,
          processingTurnId: null,
          isBusy: false,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: sessionId,
          isSurfaceVisible,
        }),
      { initialProps: { sessionId: 'session-B', isSurfaceVisible: false } },
    );
    scrollToBottom.mockClear();
    scrollToBottomUntilStable.mockClear();

    // Mark pending for session B (the newer, desired navigation).
    act(() => {
      result.current.markPendingHistoryScroll('session-B', 'session-B');
    });

    // Re-render to trigger the pending-history effect — since surface is
    // hidden, it should defer, not scroll. Neither the legacy imperative
    // path nor the primitive should fire while the surface is hidden.
    rerender({ sessionId: 'session-B', isSurfaceVisible: false });
    expect(scrollToBottom).not.toHaveBeenCalled();
    expect(scrollToBottomUntilStable).not.toHaveBeenCalled();

    // Stale navigation for session A completes with failure, calls cancel(A).
    // This must NOT drop B's deferred token.
    act(() => {
      result.current.cancelPendingHistoryScroll('session-A');
    });

    // Surface becomes visible (setActiveSurface('sessions') fired) — deferred
    // promotion fires and the pending-history primitive lands.
    rerender({ sessionId: 'session-B', isSurfaceVisible: true });

    expect(scrollToBottomUntilStable).toHaveBeenCalled();
  });

  it('a new explicit mark supersedes a stale deferred mark (deferred must not promote over it)', () => {
    // Reviewer F1 (stage 2): the deferred layout effect runs BEFORE the
    // pending-history effect. If markPendingHistoryScroll() left a stale
    // deferred target in place, that stale target would self-promote on the
    // next visible render (current still == its session) and overwrite the
    // newer explicit mark — firing a scroll for the WRONG session and losing
    // the new navigation's settle token.
    const { ref, scrollToBottomUntilStable } = createMockHandle();
    const messages: AgentTurnMessage[] = [makeMessage({ id: 'a1', role: 'user' })];

    const { result, rerender } = renderHook(
      ({ sessionId, isSurfaceVisible }: { sessionId: string; isSurfaceVisible: boolean }) =>
        useConversationAutoScroll({
          containerRef: ref,
          visibleMessages: messages,
          processingTurnId: null,
          isBusy: false,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: sessionId,
          isSurfaceVisible,
        }),
      { initialProps: { sessionId: 'session-B', isSurfaceVisible: false } },
    );
    scrollToBottomUntilStable.mockClear();

    // Hidden-surface open of B → demoted into the deferred slot.
    act(() => {
      result.current.markPendingHistoryScroll('session-B', 'session-B');
    });
    rerender({ sessionId: 'session-B', isSurfaceVisible: false });
    expect(scrollToBottomUntilStable).not.toHaveBeenCalled();

    // While still on B, the user explicitly opens D — this mark must
    // supersede BOTH the pending and the stale deferred state.
    act(() => {
      result.current.markPendingHistoryScroll('session-D', 'session-B');
    });

    // Surface becomes visible with current still B: the stale deferred B must
    // NOT self-promote (that would scroll for B and clobber D's token).
    rerender({ sessionId: 'session-B', isSurfaceVisible: true });
    expect(scrollToBottomUntilStable).not.toHaveBeenCalled();

    // D mounts — its settle token is intact and the primitive fires for D.
    rerender({ sessionId: 'session-D', isSurfaceVisible: true });
    expect(scrollToBottomUntilStable).toHaveBeenCalledTimes(1);
  });

  it('matching cancel against a deferred token clears it (prevents stale deferred scroll)', () => {
    const { ref, scrollToBottom } = createMockHandle();
    const messages: AgentTurnMessage[] = [makeMessage({ id: 'a1', role: 'user' })];

    const { result, rerender } = renderHook(
      ({ sessionId, isSurfaceVisible }: { sessionId: string; isSurfaceVisible: boolean }) =>
        useConversationAutoScroll({
          containerRef: ref,
          visibleMessages: messages,
          processingTurnId: null,
          isBusy: false,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: sessionId,
          isSurfaceVisible,
        }),
      { initialProps: { sessionId: 'session-A', isSurfaceVisible: false } },
    );
    scrollToBottom.mockClear();

    act(() => {
      result.current.markPendingHistoryScroll('session-A', 'session-A');
    });
    rerender({ sessionId: 'session-A', isSurfaceVisible: false });

    // Now the navigation for A fails — cancel with matching sessionId.
    act(() => {
      result.current.cancelPendingHistoryScroll('session-A');
    });

    // Surface becomes visible — no scroll should happen because A's deferred
    // token was correctly cleared.
    rerender({ sessionId: 'session-A', isSurfaceVisible: true });

    expect(scrollToBottom).not.toHaveBeenCalled();
  });
});

/**
 * Orphaned-pending-mark guard (stuck reveal-mask regression,
 * docs/plans/260611_fix-stuck-reveal-mask/PLAN.md).
 *
 * Bug shape: `markPendingHistoryScroll(B)` is called while session A is
 * current; before B ever mounts, the current session changes to some THIRD id
 * (new chat, session deletion, clear-all, …). The pending-history effect's
 * FOX-3040 session-id gate early-returns forever (`pendingSessionId !==
 * currentSessionId`), so `isRevealMasked` stays `true` with no self-heal —
 * stuck skeleton overlay + frozen sidebar (`shouldFreezeSidebarList`) until
 * that exact session remounts.
 *
 * Contract pinned here (the Stage-2 mark-time orphan guard):
 *   - ORPHAN: when `currentSessionId` becomes neither the mark-time session
 *     nor the pending target, the pending mark is cancelled and the mask
 *     drops. (RED on pre-guard code.)
 *   - PRESERVE (FOX-3040): intermediate renders where `currentSessionId`
 *     still equals the mark-time session keep the pending mark alive, and a
 *     superseding mark + the superseded navigation's late scoped cancel
 *     leave the new pending mark untouched. (GREEN before AND after the
 *     guard — these pin what the guard must not break.)
 */
describe('useConversationAutoScroll — orphaned pending mark cancels (stuck reveal-mask guard)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderScrollHook(initial: {
    sessionId: string;
    isSurfaceVisible?: boolean;
    /** Override the transcript. Pass `[]` to quiesce the message-arrival effect
     *  when a test needs to isolate the pending-history machinery (the arrival
     *  effect legitimately re-arms a deferred scroll for the NEW current session
     *  after a hidden session switch — unrelated to the orphan guard). */
    messages?: AgentTurnMessage[];
  }) {
    const mock = createMockHandle();
    const messages: AgentTurnMessage[] =
      initial.messages ?? [makeMessage({ id: 'm1', role: 'user' })];
    const rendered = renderHook(
      ({ sessionId, isSurfaceVisible }: { sessionId: string; isSurfaceVisible: boolean }) =>
        useConversationAutoScroll({
          containerRef: mock.ref,
          visibleMessages: messages,
          processingTurnId: null,
          isBusy: false,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: sessionId,
          isSurfaceVisible,
        }),
      {
        initialProps: {
          sessionId: initial.sessionId,
          isSurfaceVisible: initial.isSurfaceVisible ?? true,
        },
      },
    );
    return { ...rendered, ...mock };
  }

  it('cancels the pending mark and drops the mask when current session becomes neither the mark-time session nor the pending target', () => {
    // Mark a pending history scroll for session B while session A is current
    // (mark-time session = A). This is the moment a user clicks B in the
    // sidebar: the mask goes up before B's data is applied to the store.
    const { result, rerender, scrollToBottomUntilStable } = renderScrollHook({
      sessionId: 'session-A',
    });

    act(() => {
      result.current.markPendingHistoryScroll('session-B', 'session-A');
    });
    expect(result.current.isRevealMasked).toBe(true);
    expect(result.current.isSettling).toBe(true);
    scrollToBottomUntilStable.mockClear();

    // The current session becomes C — NEITHER the mark-time session (A) NOR
    // the pending target (B). Every such transition (new chat, delete-current,
    // clear-all, …) means B's navigation has lost: B can no longer consume the
    // mark, and nothing else will. The hook must cancel the orphaned mark and
    // drop the mask instead of leaving it stuck forever.
    rerender({ sessionId: 'session-C', isSurfaceVisible: true });

    expect(result.current.isRevealMasked).toBe(false);
    expect(result.current.isSettling).toBe(false);
    expect(scrollToBottomUntilStable).not.toHaveBeenCalled();

    // The cancelled mark must be GONE, not dormant: if session B mounts later
    // WITHOUT a fresh mark (e.g. unrelated background navigation), the stale
    // primitive must not fire.
    rerender({ sessionId: 'session-B', isSurfaceVisible: true });
    expect(scrollToBottomUntilStable).not.toHaveBeenCalled();
  });

  it('cancels an orphaned DEFERRED mark (surface hidden) and drops the mask when a third session becomes current', () => {
    // Mark for the CURRENT session while visible (the startup-restore shape:
    // mark-time session == pending target == current).
    //
    // Empty transcript: with messages present, the message-arrival effect
    // legitimately re-arms `deferredScrollRef` for the NEW current session
    // after the hidden session switch below (post-switch `wasNearBottomRef`
    // reset), and the surface-show rerender would fire the primitive for
    // session-F — a designed, mask-independent scroll that this test's
    // "stale primitive must not fire" assertion would misread. Quiescing the
    // arrival effect isolates the deferred HISTORY mark under test.
    const { result, rerender, scrollToBottomUntilStable } = renderScrollHook({
      sessionId: 'session-B',
      isSurfaceVisible: true,
      messages: [],
    });

    act(() => {
      result.current.markPendingHistoryScroll('session-B', 'session-B');
    });
    expect(result.current.isRevealMasked).toBe(true);

    // Surface hides before the primitive can run → the pending mark is
    // demoted into the deferred ref, waiting for the surface to return.
    rerender({ sessionId: 'session-B', isSurfaceVisible: false });
    scrollToBottomUntilStable.mockClear();

    // A third session becomes current while still hidden (e.g. a bypass
    // new-chat). The deferred mark targets a session that is no longer
    // current and no longer mark-time-current — it is orphaned and must be
    // cancelled, mask down. Pre-guard code leaves the mask stuck: the
    // deferred-promotion effect waits forever for session-B to remount.
    rerender({ sessionId: 'session-F', isSurfaceVisible: false });

    expect(result.current.isRevealMasked).toBe(false);
    expect(result.current.isSettling).toBe(false);

    // Surface returning with the third session still current must not fire
    // the stale primitive either.
    rerender({ sessionId: 'session-F', isSurfaceVisible: true });
    expect(scrollToBottomUntilStable).not.toHaveBeenCalled();
  });

  // ── FOX-3040 preservation pair ─────────────────────────────────────────────
  // These two pass on PRE-guard code and must STILL pass after the Stage-2
  // orphan guard lands. They pin the load-bearing semantics of the session-id
  // token (docs-private/investigations/260420_scroll_to_bottom_still_broken.md)
  // that a naive "cancel whenever current ≠ pending" derivation would break.

  it('FOX-3040 preservation: intermediate renders where current == mark-time session keep the pending mark alive', () => {
    const { result, rerender, scrollToBottomUntilStable } = renderScrollHook({
      sessionId: 'session-A',
    });

    act(() => {
      result.current.markPendingHistoryScroll('session-B', 'session-A');
    });
    scrollToBottomUntilStable.mockClear();

    // While B's load is in flight the store still has A current — re-renders
    // in this window (state updates, unrelated props) must NOT cancel the
    // mark: current == mark-time session means the navigation is simply still
    // in progress. The mask stays up (that's the point of the mask).
    rerender({ sessionId: 'session-A', isSurfaceVisible: true });
    expect(result.current.isRevealMasked).toBe(true);
    expect(result.current.isSettling).toBe(true);
    expect(scrollToBottomUntilStable).not.toHaveBeenCalled();

    // Force genuine pending-history effect re-runs (its deps include
    // isSurfaceVisible) while current is STILL the mark-time session. The
    // effect body executes with pending(B) ≠ current(A); the orphan guard
    // must classify this as "navigation in progress", NOT as an orphan.
    rerender({ sessionId: 'session-A', isSurfaceVisible: false });
    rerender({ sessionId: 'session-A', isSurfaceVisible: true });
    expect(result.current.isRevealMasked).toBe(true);
    expect(result.current.isSettling).toBe(true);
    expect(scrollToBottomUntilStable).not.toHaveBeenCalled();

    // B's data lands (store applies the switch) → the preserved token is
    // consumed: the settle primitive fires for B.
    rerender({ sessionId: 'session-B', isSurfaceVisible: true });
    expect(scrollToBottomUntilStable).toHaveBeenCalled();
  });

  it('FOX-3040 preservation: a superseding mark replaces the target, and the superseded navigation\'s late scoped cancel does NOT clear it', () => {
    const { result, rerender, scrollToBottomUntilStable } = renderScrollHook({
      sessionId: 'session-A',
    });

    // User clicks B, then quickly clicks C. The second mark cleanly replaces
    // the pending target (supersede semantics in markPendingHistoryScroll).
    act(() => {
      result.current.markPendingHistoryScroll('session-B', 'session-A');
    });
    act(() => {
      result.current.markPendingHistoryScroll('session-C', 'session-A');
    });
    scrollToBottomUntilStable.mockClear();

    // B's navigation resolves late as a failure (superseded request) and
    // issues its sessionId-scoped cancel. This is the original FOX-3040
    // follow-up race: the stale cancel must NOT clear C's pending mark.
    act(() => {
      result.current.cancelPendingHistoryScroll('session-B');
    });
    expect(result.current.isRevealMasked).toBe(true);
    expect(result.current.isSettling).toBe(true);

    // C mounts → the surviving mark is consumed for C.
    rerender({ sessionId: 'session-C', isSurfaceVisible: true });
    expect(scrollToBottomUntilStable).toHaveBeenCalled();
  });

  it('transition-lag preservation: store-truth mark-time ahead of the rendered prop must NOT cancel (arbitrator F1)', () => {
    // The one real FOX-3040 re-strand hazard of a render-scope mark-time:
    // a cache-hit open for session B applies the store switch SYNCHRONOUSLY,
    // but the RENDERED `currentSessionId` prop can lag behind the store under
    // `startTransition`. If the user then clicks D, the mark call site passes
    // STORE truth (B) as mark-time while the rendered prop still says A.
    // When the lagged render finally commits current=B, the guard must treat
    // it as "navigation in progress" (current == mark-time), NOT as an orphan.
    const { result, rerender, scrollToBottomUntilStable } = renderScrollHook({
      sessionId: 'session-A', // rendered prop lags: store has already applied B
    });

    act(() => {
      result.current.markPendingHistoryScroll('session-D', 'session-B');
    });
    expect(result.current.isRevealMasked).toBe(true);
    scrollToBottomUntilStable.mockClear();

    // The lagged transition commits: rendered current catches up to the
    // store-truth mark-time session (B). The pending mark for D must survive.
    rerender({ sessionId: 'session-B', isSurfaceVisible: true });
    expect(result.current.isRevealMasked).toBe(true);
    expect(result.current.isSettling).toBe(true);
    expect(scrollToBottomUntilStable).not.toHaveBeenCalled();

    // D's data lands → the preserved mark is consumed: primitive fires for D.
    rerender({ sessionId: 'session-D', isSurfaceVisible: true });
    expect(scrollToBottomUntilStable).toHaveBeenCalled();
    expect(result.current.isSettling).toBe(true); // primitive in flight, not cancelled
  });
});
