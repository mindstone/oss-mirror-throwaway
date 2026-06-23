// @vitest-environment happy-dom
/// <reference types="vitest/globals" />

/**
 * Regression tests for M2 from the Phase 6 triple-review of
 * docs-private/investigations/260416_answered_question_card_not_visible.md.
 *
 * Without the fix, ConversationPane's programmatic smooth scroll (used by the
 * scroll-to-answer effect) would dispatch scroll events with upward deltas
 * during a busy turn, causing `useConversationAutoScroll` to engage the
 * sticky scroll-away latch and leave auto-scroll broken for subsequent
 * turns. The fix adds `isProgrammaticScrollInFlight` to the pane handle and
 * short-circuits the scroll listener when it's true.
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

function createMockContainerRef(options?: { isProgrammaticScrollInFlight?: boolean }) {
  const scrollElement = document.createElement('div');
  Object.defineProperties(scrollElement, {
    scrollHeight: { value: 2000, configurable: true, writable: true },
    clientHeight: { value: 600, configurable: true, writable: true },
    scrollTop: { value: 1400, writable: true, configurable: true },
  });

  const isProgrammaticScrollInFlightFn = vi.fn(
    () => options?.isProgrammaticScrollInFlight ?? false,
  );

  const handle: ConversationPaneHandle = {
    scrollToIndex: vi.fn(),
    scrollToBottom: vi.fn(),
    // Added in Stage 1 of the scroll-to-bottom primitive refactor
    // (docs/plans/260420_scroll_to_bottom_primitive_refactor.md).
    // Non-optional on the handle; TS requires a stub.
    scrollToBottomUntilStable: vi
      .fn()
      .mockResolvedValue({ landedAtBottom: true, reason: 'stable' as const }),
    getScrollElement: () => scrollElement,
    getVisibleRange: () => null,
    isProgrammaticScrollInFlight: isProgrammaticScrollInFlightFn,
  };

  return { ref: { current: handle }, scrollElement, handle, isProgrammaticScrollInFlightFn };
}

describe('useConversationAutoScroll — programmatic scroll coordination (M2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT engage the sticky scroll-away latch when a programmatic scroll is in flight', () => {
    const { ref, scrollElement, isProgrammaticScrollInFlightFn } = createMockContainerRef();

    const messages: AgentTurnMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user' }),
      makeMessage({ id: 'msg-2', role: 'assistant', turnId: 'turn-1' }),
    ];

    const { result } = renderHook(() =>
      useConversationAutoScroll({
        containerRef: ref,
        visibleMessages: messages,
        processingTurnId: 'turn-1',
        isBusy: true,
        isInsightSurface: false,
        isDiagnosticsSurface: false,
        currentSessionId: 'session-1',
      }),
    );

    // Programmatic scroll in flight — ConversationPane's scrollToFn will now
    // dispatch a series of scroll events that look like upward movement.
    isProgrammaticScrollInFlightFn.mockReturnValue(true);

    // Simulate upward scroll (smooth-scroll animation walks scrollTop backwards).
    act(() => {
      scrollElement.scrollTop = 200; // was 1400
      scrollElement.dispatchEvent(new Event('scroll'));
    });

    expect(result.current.isScrolledAway).toBe(false);

    // Multiple frames of animation — still should not engage latch.
    act(() => {
      scrollElement.scrollTop = 100;
      scrollElement.dispatchEvent(new Event('scroll'));
      scrollElement.scrollTop = 50;
      scrollElement.dispatchEvent(new Event('scroll'));
    });

    expect(result.current.isScrolledAway).toBe(false);
    expect(isProgrammaticScrollInFlightFn).toHaveBeenCalled();
  });

  it('DOES engage the sticky latch for user-initiated upward scrolls during busy (regression guard)', () => {
    const { ref, scrollElement } = createMockContainerRef();

    const messages: AgentTurnMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user' }),
      makeMessage({ id: 'msg-2', role: 'assistant', turnId: 'turn-1' }),
    ];

    const { result } = renderHook(() =>
      useConversationAutoScroll({
        containerRef: ref,
        visibleMessages: messages,
        processingTurnId: 'turn-1',
        isBusy: true,
        isInsightSurface: false,
        isDiagnosticsSurface: false,
        currentSessionId: 'session-1',
      }),
    );

    // No programmatic scroll in flight — user scrolls up.
    act(() => {
      scrollElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
      scrollElement.scrollTop = 200;
      scrollElement.dispatchEvent(new Event('scroll'));
    });

    // Latch engaged → isScrolledAway true.
    expect(result.current.isScrolledAway).toBe(true);
  });

  it('re-engages normal behaviour after the programmatic scroll flag clears', () => {
    const { ref, scrollElement, isProgrammaticScrollInFlightFn } = createMockContainerRef();

    const messages: AgentTurnMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user' }),
      makeMessage({ id: 'msg-2', role: 'assistant', turnId: 'turn-1' }),
    ];

    const { result } = renderHook(() =>
      useConversationAutoScroll({
        containerRef: ref,
        visibleMessages: messages,
        processingTurnId: 'turn-1',
        isBusy: true,
        isInsightSurface: false,
        isDiagnosticsSurface: false,
        currentSessionId: 'session-1',
      }),
    );

    // Programmatic scroll completes — upward frames ignored.
    isProgrammaticScrollInFlightFn.mockReturnValue(true);
    act(() => {
      scrollElement.scrollTop = 100;
      scrollElement.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.isScrolledAway).toBe(false);

    // Flag clears — subsequent genuine user scroll up should latch.
    isProgrammaticScrollInFlightFn.mockReturnValue(false);
    act(() => {
      scrollElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
      scrollElement.scrollTop = 50;
      scrollElement.dispatchEvent(new Event('scroll'));
    });

    expect(result.current.isScrolledAway).toBe(true);
  });

  it('works when containerRef.current lacks isProgrammaticScrollInFlight (defensive back-compat)', () => {
    // Older handle shape (no isProgrammaticScrollInFlight) — hook must not throw
    // and must preserve existing latch behaviour for user scrolls.
    const scrollElement = document.createElement('div');
    Object.defineProperties(scrollElement, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 600, configurable: true },
      scrollTop: { value: 1400, writable: true, configurable: true },
    });
    const handle = {
      scrollToIndex: vi.fn(),
      scrollToBottom: vi.fn(),
      getScrollElement: () => scrollElement,
      getVisibleRange: () => null,
      // Intentionally omit isProgrammaticScrollInFlight.
    } as unknown as ConversationPaneHandle;
    const ref = { current: handle };

    const messages: AgentTurnMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user' }),
      makeMessage({ id: 'msg-2', role: 'assistant', turnId: 'turn-1' }),
    ];

    const { result } = renderHook(() =>
      useConversationAutoScroll({
        containerRef: ref,
        visibleMessages: messages,
        processingTurnId: 'turn-1',
        isBusy: true,
        isInsightSurface: false,
        isDiagnosticsSurface: false,
        currentSessionId: 'session-1',
      }),
    );

    act(() => {
      scrollElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
      scrollElement.scrollTop = 200;
      scrollElement.dispatchEvent(new Event('scroll'));
    });

    expect(result.current.isScrolledAway).toBe(true);
  });
});
