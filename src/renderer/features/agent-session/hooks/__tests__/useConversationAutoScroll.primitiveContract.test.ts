// @vitest-environment happy-dom
/// <reference types="vitest/globals" />

/**
 * Stage 2 behavioral-contract tests for `useConversationAutoScroll`'s
 * consumption of the `scrollToBottomUntilStable` primitive.
 *
 * Complements the Stage 3 test migration documented in
 * `docs/plans/260420_scroll_to_bottom_primitive_refactor.md`. The older
 * `sessionIdToken.test.ts` pins the FOX-3040 session-id-token guard at
 * the API boundary; this file pins two invariants that the Stage 2
 * refactor specifically introduced and that were NOT testable against
 * the old `setTimeout`-polling implementation:
 *
 *   1. **FOX-2668 latch handoff (Invariant #2).** When the primitive
 *      resolves `reason: 'user-scrolled'`, the hook's `.then()` handler
 *      engages the sticky scroll-away latch EXPLICITLY (sets
 *      `stickyScrollAwayRef.current = true` and
 *      `wasNearBottomRef.current = false`). A subsequent non-user
 *      message arrival must NOT auto-scroll. The handoff is load-bearing
 *      because the hook's scroll listener short-circuits on
 *      `isProgrammaticScrollInFlight()` for the primitive's entire life,
 *      so the wheel-during-chase path cannot engage the latch via the
 *      listener — only the primitive's resolution can.
 *
 *   2. **Surface-hide cleanup re-promotion (Invariant #4, new edge).**
 *      If `isSurfaceVisible` flips to `false` while the primitive is
 *      running, the pending session id must re-promote into
 *      `deferredScrollRef` so the deferred-scroll effect re-fires the
 *      primitive once the surface returns. Without this, a user who
 *      backgrounds the app mid-restore would land stranded at the top
 *      when they come back.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, flushAsync, renderHook } from '@renderer/test-utils';
import type { AgentTurnMessage } from '@shared/types';
import { useConversationAutoScroll } from '../useConversationAutoScroll';
import type {
  ConversationPaneHandle,
  ScrollSettleResult,
} from '../../components/ConversationPane';

type PrimitiveImpl = (signal?: AbortSignal) => Promise<ScrollSettleResult>;

const makeMessage = (
  overrides: Partial<AgentTurnMessage> & {
    id: string;
    role: AgentTurnMessage['role'];
  },
): AgentTurnMessage => ({
  turnId: 'turn-1',
  text: 'test',
  createdAt: Date.now(),
  ...overrides,
});

function createMockHandle(
  primitiveImpl: PrimitiveImpl = () =>
    Promise.resolve({ landedAtBottom: true, reason: 'stable' as const }),
) {
  const scrollElement = document.createElement('div');
  Object.defineProperties(scrollElement, {
    scrollHeight: { value: 5000, configurable: true, writable: true },
    clientHeight: { value: 600, configurable: true, writable: true },
    scrollTop: { value: 0, writable: true, configurable: true },
  });

  const scrollToBottom = vi.fn();
  const scrollToBottomUntilStable = vi.fn(
    (options?: { signal?: AbortSignal }) => primitiveImpl(options?.signal),
  );

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
    handle,
    scrollElement,
    scrollToBottom,
    scrollToBottomUntilStable,
  };
}

describe('useConversationAutoScroll — Stage 2 primitive-consumer contracts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('engages sticky scroll-away latch when primitive resolves user-scrolled (FOX-2668 handoff, Invariant #2)', async () => {
    // Primitive reports the user scrolled during the chase.
    const { ref, scrollToBottom, scrollToBottomUntilStable } = createMockHandle(
      () =>
        Promise.resolve({
          landedAtBottom: false,
          reason: 'user-scrolled' as const,
        }),
    );

    const m1 = makeMessage({ id: 'a1', role: 'user' });
    const m2 = makeMessage({ id: 'a2', role: 'assistant' });
    const initialMessages: AgentTurnMessage[] = [m1];

    // Production flow: App calls markPendingHistoryScroll(B) BEFORE the
    // store updates currentSessionId from A→B. Then openHistorySession
    // commits the store change, hook re-renders with new currentSessionId,
    // effect deps see the change, primitive fires. We emulate this by
    // mounting with sessionId=A, marking for B, then rerendering with B.
    //
    // (The previous version of this test rerendered with a fresh messages
    // array to force the effect to re-run. That worked when `visibleMessages`
    // was in the effect deps — but it's intentionally no longer a dep, since
    // a mid-primitive message arrival would otherwise abort-and-restart and
    // swallow a user-scroll we'd just observed. Trigger via currentSessionId,
    // which matches the real openHistorySession flow.)
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

    // Mount runs the message-arrival effect, which auto-scrolls for the
    // user message. Clear both mocks so subsequent assertions measure
    // only the post-primitive behavior.
    scrollToBottom.mockClear();
    scrollToBottomUntilStable.mockClear();

    act(() => {
      result.current.markPendingHistoryScroll('session-B', 'session-A');
    });

    // Session switches to B → effect re-runs → pending token matches new
    // currentSessionId → primitive fires.
    rerender({ sessionId: 'session-B', messages: initialMessages });
    expect(scrollToBottomUntilStable).toHaveBeenCalledTimes(1);

    // Flush the primitive Promise's `.then()` — this is where the hook
    // explicitly writes `stickyScrollAwayRef.current = true` and
    // `wasNearBottomRef.current = false` (the FOX-2668 handoff).
    await flushAsync();

    // Sanity: post-primitive state matches the 'user-scrolled' degraded
    // branch (pane revealed, Jump-to-Latest banner surfaced).
    expect(result.current.isSettling).toBe(false);
    expect(result.current.isScrolledAway).toBe(true);

    scrollToBottom.mockClear();
    scrollToBottomUntilStable.mockClear();

    // New assistant message arrives. Message-arrival effect evaluates
    //   isUserMessage || (wasNearBottomRef.current && !stickyScrollAwayRef.current)
    // If the handoff worked:  false || (false && !true)  === false  → no scroll.
    // If the handoff regressed (either ref wasn't written): the condition
    // would be true and `scrollToBottom` would be called.
    rerender({ sessionId: 'session-B', messages: [m1, m2] });

    expect(scrollToBottom).not.toHaveBeenCalled();

    // The pending-history effect does NOT depend on `visibleMessages` (by
    // design — see the hook's deps comment). So a message update alone
    // should not trigger a re-run, and even if it did, pendingHistoryScrollRef
    // is now null and would early-return.
    expect(scrollToBottomUntilStable).not.toHaveBeenCalled();
  });

  it('re-fires primitive after mid-primitive surface-hide → show cycle (Invariant #4)', async () => {
    // Primitive never resolves: models "still in flight" when visibility flips.
    // AbortSignal capture lets us verify the cleanup aborted the running run.
    let capturedSignal: AbortSignal | undefined;
    const { ref, scrollToBottom, scrollToBottomUntilStable } = createMockHandle(
      (signal) => {
        capturedSignal = signal;
        return new Promise<ScrollSettleResult>(() => {
          // Never resolves — abort is observable via `capturedSignal.aborted`.
        });
      },
    );

    const m1 = makeMessage({ id: 'a1', role: 'user' });
    const messages: AgentTurnMessage[] = [m1];

    // Start with the surface HIDDEN so the initial mount doesn't fire the
    // primitive before we've called markPendingHistoryScroll.
    const { result, rerender, unmount } = renderHook(
      ({ isSurfaceVisible }: { isSurfaceVisible: boolean }) =>
        useConversationAutoScroll({
          containerRef: ref,
          visibleMessages: messages,
          processingTurnId: null,
          isBusy: false,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: 'session-A',
          isSurfaceVisible,
        }),
      { initialProps: { isSurfaceVisible: false } },
    );

    scrollToBottom.mockClear();
    scrollToBottomUntilStable.mockClear();

    act(() => {
      result.current.markPendingHistoryScroll('session-A', 'session-A');
    });

    // Surface becomes visible → pending-history effect runs → primitive starts.
    rerender({ isSurfaceVisible: true });
    expect(scrollToBottomUntilStable).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);

    // Surface hides mid-primitive. Effect cleanup must fire:
    //   - `controller.abort()` → observable via the captured signal.
    //   - The pending session must survive the tear-down (via the
    //     cleanup's re-promote OR the re-run's `!isSurfaceVisible`
    //     deferred branch, both of which preserve the queued scroll).
    rerender({ isSurfaceVisible: false });
    expect(capturedSignal?.aborted).toBe(true);
    expect(scrollToBottomUntilStable).toHaveBeenCalledTimes(1);

    // Surface returns. The deferred-scroll effect (declared before the
    // pending-history effect — load-bearing ordering per the hook's
    // comment) must re-promote the session, and the pending-history
    // effect must re-fire the primitive.
    //
    // Without Invariant #4 holding, the user would land stranded: no
    // primitive is fired, the pane reveals at whatever scroll position
    // the previous (aborted) primitive last wrote.
    rerender({ isSurfaceVisible: true });
    expect(scrollToBottomUntilStable).toHaveBeenCalledTimes(2);

    // Non-optional primitive path held throughout — the dev-mode
    // `scrollToBottom` fallback must NOT have been used at any step.
    expect(scrollToBottom).not.toHaveBeenCalled();

    // Clean up: the second primitive is still pending. Unmount aborts it
    // via the effect cleanup so the test doesn't leak a never-resolving
    // promise between test files.
    unmount();
    await flushAsync();
  });
});

describe('useConversationAutoScroll — catch-up eligibility gating', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const assistantMessage = makeMessage({ id: 'assistant-1', role: 'assistant' });

  function renderWithPauseProps(initialProps: {
    pauseAutoScroll: boolean;
    pauseAutoScrollCatchUpEligible: boolean;
  }) {
    const { ref, scrollToBottom } = createMockHandle();

    const hook = renderHook(
      ({
        pauseAutoScroll,
        pauseAutoScrollCatchUpEligible,
      }: {
        pauseAutoScroll: boolean;
        pauseAutoScrollCatchUpEligible: boolean;
      }) =>
        useConversationAutoScroll({
          containerRef: ref,
          visibleMessages: [assistantMessage],
          processingTurnId: null,
          isBusy: false,
          isInsightSurface: false,
          isDiagnosticsSurface: false,
          currentSessionId: 'session-A',
          pauseAutoScroll,
          pauseAutoScrollCatchUpEligible,
          isSurfaceVisible: true,
        }),
      { initialProps },
    );

    return {
      ...hook,
      scrollToBottom,
    };
  }

  it('does NOT catch up when annotation-only pause closes (not eligible)', () => {
    const { rerender, scrollToBottom } = renderWithPauseProps({
      pauseAutoScroll: true,
      pauseAutoScrollCatchUpEligible: false,
    });

    scrollToBottom.mockClear();

    rerender({
      pauseAutoScroll: false,
      pauseAutoScrollCatchUpEligible: false,
    });

    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it('DOES catch up when selection-menu pause closes (eligible)', () => {
    const { rerender, scrollToBottom } = renderWithPauseProps({
      pauseAutoScroll: true,
      pauseAutoScrollCatchUpEligible: true,
    });

    scrollToBottom.mockClear();

    rerender({
      pauseAutoScroll: false,
      pauseAutoScrollCatchUpEligible: false,
    });

    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('does NOT catch up if eligibility closes while another pause source remains', () => {
    const { rerender, scrollToBottom } = renderWithPauseProps({
      pauseAutoScroll: true,
      pauseAutoScrollCatchUpEligible: true,
    });

    scrollToBottom.mockClear();

    // Selection menu closes, but annotation pause is still active.
    rerender({
      pauseAutoScroll: true,
      pauseAutoScrollCatchUpEligible: false,
    });
    expect(scrollToBottom).not.toHaveBeenCalled();

    // Annotation pause closes later; eligibility was already consumed.
    rerender({
      pauseAutoScroll: false,
      pauseAutoScrollCatchUpEligible: false,
    });
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  // Re-arming cycle: eligibility falls under another pause source, then a NEW
  // selection menu opens and closes (still under the popover), and finally the
  // popover also closes. Catch-up should fire on the dedicated menu close
  // because eligibility re-armed and then fell again with no remaining pause.
  it('handles re-arming cycle correctly: menu→close-under-popover→reopen→close-all', () => {
    const { rerender, scrollToBottom } = renderWithPauseProps({
      pauseAutoScroll: true,
      pauseAutoScrollCatchUpEligible: true,
    });

    scrollToBottom.mockClear();

    // First menu closes while popover stays open — eligibility consumed,
    // pauseAutoScroll still true.
    rerender({
      pauseAutoScroll: true,
      pauseAutoScrollCatchUpEligible: false,
    });
    expect(scrollToBottom).not.toHaveBeenCalled();

    // Menu reopens (popover still up) — eligibility re-arms.
    rerender({
      pauseAutoScroll: true,
      pauseAutoScrollCatchUpEligible: true,
    });
    expect(scrollToBottom).not.toHaveBeenCalled();

    // Everything closes together — catch-up fires on the eligibility falling
    // edge with no remaining pause source.
    rerender({
      pauseAutoScroll: false,
      pauseAutoScrollCatchUpEligible: false,
    });
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });
});

describe('useConversationAutoScroll — session switch routes through primitive', () => {
  // Regression guard for Apr 2026 cleanup: session-switch settling remains
  // primitive-driven and never falls back to `scrollToBottom`.

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('routes through the primitive when markPendingHistoryScroll is consumed', async () => {
    const { ref, scrollToBottomUntilStable, scrollToBottom } = createMockHandle();

    const messages: AgentTurnMessage[] = [
      makeMessage({ id: 'm1', role: 'user' }),
      makeMessage({ id: 'm2', role: 'assistant' }),
    ];

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
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
      { initialProps: { sessionId: 'session-A' } },
    );

    scrollToBottomUntilStable.mockClear();
    scrollToBottom.mockClear();

    act(() => {
      result.current.markPendingHistoryScroll('session-B', 'session-A');
    });
    rerender({ sessionId: 'session-B' });
    await flushAsync();

    expect(scrollToBottomUntilStable).toHaveBeenCalledTimes(1);
    expect(scrollToBottom).not.toHaveBeenCalled();
  });
});
