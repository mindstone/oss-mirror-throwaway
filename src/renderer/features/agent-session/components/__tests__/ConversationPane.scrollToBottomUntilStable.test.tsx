// @vitest-environment happy-dom
/// <reference types="vitest/globals" />

/**
 * Behavioral-contract tests for Stage 1 of the scroll-to-bottom primitive
 * refactor (docs/plans/260420_scroll_to_bottom_primitive_refactor.md).
 *
 * These exercise the actual runtime behaviour of
 * `ConversationPaneHandle.scrollToBottomUntilStable` and the paired
 * `programmaticScrollInFlightRef` counter by mounting `ConversationPane`
 * via React with heavy child components / hooks mocked out at module
 * boundaries. The primitive itself is NOT mocked — every assertion lands
 * on the real implementation under test.
 *
 * Contracts covered:
 *   1. Counter semantics (begin+begin+end → still inFlight;
 *      begin+end+end → not inFlight, no underflow).
 *   2. handleBeginProgrammaticScroll / handleEndProgrammaticScroll pair
 *      correctly via the `isProgrammaticScrollInFlight()` getter.
 *   3. Empty `visibleMessages` resolves with { reason: 'empty',
 *      landedAtBottom: true } immediately and does NOT touch the counter.
 *   4. Pre-aborted AbortSignal resolves with { reason: 'aborted',
 *      landedAtBottom: false } near-synchronously and does NOT touch the
 *      counter.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React from 'react';

// ── Module mocks ────────────────────────────────────────────────────
// CSS module — Proxy-based so any class name read works.
vi.mock('../ConversationPane.module.css', () => ({
  default: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

// Stub TanStack Virtual — avoids happy-dom's missing ResizeObserver/layout
// APIs. The stub exposes a mutable bag of virtual items so Stage 3 tests
// (long-task + late-measurement) can populate `measureCacheRef` via the
// pane's post-paint `useEffect` sync (which iterates `getVirtualItems()`).
// Tests that don't need items (empty / pre-aborted / counter-semantics)
// leave `virtualizerState.items` at its default `[]`.
//
// NOTE: We use `vi.hoisted` so the state is initialised BEFORE `vi.mock`
// factories run (vi.mock is hoisted above imports; closure over a plain
// top-level `let` would read `undefined`).
const virtualizerState = vi.hoisted(() => ({
  items: [] as Array<{ index: number; size: number; key: string | number }>,
  totalSize: 0,
  onChange: null as (() => void) | null,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options?: { onChange?: () => void }) => {
    virtualizerState.onChange = options?.onChange ?? null;
    return {
      getVirtualItems: () => virtualizerState.items,
      getTotalSize: () => virtualizerState.totalSize,
      scrollToIndex: () => {},
      measureElement: () => {},
    };
  },
  elementScroll: () => {},
}));

// Lightweight pane-dependency stubs.
vi.mock('../../hooks/useCommunityShare', () => ({ useCommunityShare: () => null }));
vi.mock('../../hooks/useMemoryUpdateStatus', () => ({
  useMemoryUpdateStatus: () => ({ statusByTurn: {}, getStatusForTurn: () => undefined }),
}));
vi.mock('../../hooks/useTimeSavedStatus', () => ({
  useTimeSavedStatus: () => ({ statusByTurn: {}, getStatusForTurn: () => undefined }),
}));

// IMPORTANT: `useScrollToAnswer` is where `handleBeginProgrammaticScroll`
// and `handleEndProgrammaticScroll` are handed out from the pane. We
// capture them here so our counter-semantics test can invoke them
// directly — there is no other handle-level surface to reach them.
// NOTE: We use a getter-bag (object) rather than top-level `let` because
// `vi.mock` factories are hoisted and must not close over uninitialized
// bindings.
interface CapturedScrollCallbacks {
  onBegin: (() => void) | null;
  onEnd: (() => void) | null;
}
const captured: CapturedScrollCallbacks = { onBegin: null, onEnd: null };
vi.mock('../../hooks/useScrollToAnswer', () => ({
  useScrollToAnswer: (opts: {
    onBeginProgrammaticScroll?: () => void;
    onEndProgrammaticScroll?: () => void;
  }) => {
    captured.onBegin = opts.onBeginProgrammaticScroll ?? null;
    captured.onEnd = opts.onEndProgrammaticScroll ?? null;
  },
  computeScrollToAnswerIndex: () => null,
}));

vi.mock('../../hooks/useUserQuestions', () => ({
  extractQuestionBatches: () => [],
  extractAnsweredBatches: () => [],
  buildQuestionBatchStates: () => [],
}));

// Minimal faithful stub: actually populate the map so the pane's
// post-paint `useEffect` sync (see ConversationPane.tsx ~line 624)
// populates `measureCacheRef` for the items returned by the virtualizer
// stub above. The `measureCacheRef.current.has(lastMessageId)` gate in
// `scrollToBottomUntilStable` depends on this to resolve `stable`.
vi.mock('../../utils/lruMeasureCache', () => ({
  setMeasureCacheEntryLru: (
    map: Map<string, number>,
    id: string,
    size: number,
  ) => {
    map.set(id, size);
  },
  getConversationMeasureCache: () => new Map<string, number>(),
  clearConversationMeasureCache: () => {},
}));

vi.mock('@rebel/shared', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, computeTaskDisplayProps: () => null };
});

vi.mock('@renderer/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Child components — render nothing so we don't pull in deeper graphs.
vi.mock('../ContextualProgressCard', () => ({ ContextualProgressCard: () => null }));
vi.mock('../EmptyConversationState', () => ({ EmptyConversationState: () => null }));
vi.mock('../FirstBigWinCard', () => ({ FirstBigWinCard: () => null }));
vi.mock('../CommunityWinCard', () => ({ CommunityWinCard: () => null }));
vi.mock('../MCPBuildCard', () => ({ MCPBuildCard: () => null }));
vi.mock('../MessageItem', () => ({ MessageItem: () => null }));
vi.mock('../UserQuestionCard', () => ({ UserQuestionCard: () => null }));
vi.mock('../OnboardingCoachIntro', () => ({ OnboardingCoachIntro: () => null }));
vi.mock('../../../focus/components/FocusContextCard', () => ({ FocusContextCard: () => null }));

// ── Imports AFTER mocks ─────────────────────────────────────────────
import type { AgentTurnMessage } from '@shared/types';
import {
  ConversationPane,
  SCROLL_SETTLE_GAP_THRESHOLD_MS,
  SCROLL_SETTLE_MAX_WALL_MS,
  SCROLL_SETTLE_QUIESCENCE_MS,
  SCROLL_SETTLE_STABLE_FRAMES,
  type ConversationPaneHandle,
  type ConversationPaneProps,
  type ScrollSettleResult,
} from '../ConversationPane';

// React act() environment for mount/rerender.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Use require() to keep parity with the existing hook test harness and
// avoid Vite import-analysis surprises in happy-dom.
const ReactDOMClient = require('react-dom/client') as typeof import('react-dom/client');
const { act: reactAct } = require('react') as typeof import('react');

// ── Test helpers ────────────────────────────────────────────────────
const makeMessage = (
  overrides: Partial<AgentTurnMessage> & { id: string; role: AgentTurnMessage['role'] },
): AgentTurnMessage => ({
  turnId: 'turn-1',
  text: 'test',
  createdAt: Date.now(),
  ...overrides,
});

function buildMinimalProps(
  overrides: Partial<ConversationPaneProps> = {},
): ConversationPaneProps {
  return {
    visibleMessages: [],
    eventsByTurn: {},
    visibleTurnId: '',
    focusedTurnId: null,
    processingTurnId: null,
    editingMessageId: null,
    isBusy: false,
    isStopping: false,
    currentSessionId: 'session-A',
    isTextMode: false,
    turnStepContextByTurn: {},
    subAgentTimelineByTurn: new Map(),
    activeStepByTurn: {},
    resolveTurnIdForMessage: () => null,
    onBeginEditMessage: () => {},
    onSelectInlineStep: () => {},
    onFocusTurn: () => {},
    onOpenFile: () => {},
    onCopyToClipboard: () => {},
    ...overrides,
  };
}

function mountPane(props: ConversationPaneProps) {
  const ref = React.createRef<ConversationPaneHandle>();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  reactAct(() => {
    root.render(
      React.createElement(ConversationPane, {
        ...props,
        ref,
      } as ConversationPaneProps & { ref: React.RefObject<ConversationPaneHandle> }),
    );
  });

  return {
    ref,
    container,
    unmount: () => {
      reactAct(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// ── Shared global stubs ─────────────────────────────────────────────
beforeAll(() => {
  // window.api is consulted by ConversationPane's first-big-win effect.
  // Provide the minimal surface so mount doesn't blow up.
  (window as unknown as { api: unknown }).api = {
    shouldShowFirstBigWin: async () => false,
    getTodayMinutes: async () => 0,
    onTimeSavedStatus: () => () => {},
    markFirstBigWinShown: async () => {},
  };
});

beforeEach(() => {
  captured.onBegin = null;
  captured.onEnd = null;
  // Reset the virtualizer-stub state so the two Stage 3 tests that
  // populate it can't leak into the earlier contract tests (which assume
  // an empty virtual list).
  virtualizerState.items = [];
  virtualizerState.totalSize = 0;
  virtualizerState.onChange = null;
  // `vi.unstubAllGlobals()` does NOT clear localStorage (happy-dom-backed),
  // so explicitly purge the anchor kill-switch the persistent-bottom-anchor
  // test sets. Prevents accidental leak into earlier contract tests if
  // ordering changes or new tests are added.
  window.localStorage.removeItem('scrollDebug.enableAnchorOnChange');
});

afterEach(() => {
  // Let any microtask-queued rAF callbacks flush before the next test.
  // (We don't use fake timers here because the primitive's rAF pump is
  // naturally interrupted by abort/settle.)
});

// ── Tests ───────────────────────────────────────────────────────────
describe('ConversationPane.scrollToBottomUntilStable — Stage 1 behavioral contracts', () => {
  it('empty visibleMessages → resolves immediately with { reason: "empty", landedAtBottom: true }, counter untouched', async () => {
    const { ref, unmount } = mountPane(buildMinimalProps({ visibleMessages: [] }));

    const handle = ref.current;
    expect(handle).not.toBeNull();
    if (!handle) throw new Error('handle missing');

    // Precondition: counter is zero before the primitive runs.
    expect(handle.isProgrammaticScrollInFlight?.()).toBe(false);

    const result = await handle.scrollToBottomUntilStable();

    expect(result).toEqual({ landedAtBottom: true, reason: 'empty' });
    // Postcondition: the empty-path must NOT increment/decrement the
    // counter (per the "No counter touch" comment in the primitive).
    expect(handle.isProgrammaticScrollInFlight?.()).toBe(false);

    unmount();
  });

  it('pre-aborted signal → resolves near-synchronously with { reason: "aborted", landedAtBottom: false }, counter untouched', async () => {
    const { ref, unmount } = mountPane(
      buildMinimalProps({
        visibleMessages: [makeMessage({ id: 'm1', role: 'user' })],
      }),
    );

    const handle = ref.current;
    expect(handle).not.toBeNull();
    if (!handle) throw new Error('handle missing');

    const ac = new AbortController();
    ac.abort(); // pre-aborted

    expect(handle.isProgrammaticScrollInFlight?.()).toBe(false);

    const result = await handle.scrollToBottomUntilStable({ signal: ac.signal });

    expect(result).toEqual({ landedAtBottom: false, reason: 'aborted' });
    // The pre-aborted early return happens BEFORE the counter increment,
    // so the getter must still read zero.
    expect(handle.isProgrammaticScrollInFlight?.()).toBe(false);

    unmount();
  });

  // ── Stage 3 regression tests ────────────────────────────────────
  // These two tests are the motivating regressions for the refactor
  // (docs/plans/260420_scroll_to_bottom_primitive_refactor.md §Stage 3
  // Verification Notes). They drive the REAL primitive via a
  // deterministic rAF pump and fake `performance.now()` so that:
  //
  //   Test A — long task   — proves `GAP_THRESHOLD_MS` resets the
  //     stability counter. Without this, a main-thread block during
  //     the chase would satisfy `STABLE_FRAMES` across frozen time and
  //     trigger the "false-stable" bug class (FOX-3040 → FOX-3093 →
  //     the present refactor).
  //
  //   Test B — late measurement — proves the primitive re-chases when
  //     `scrollHeight` grows mid-chase (virtualizer commits a real
  //     row height post-initial-pin). Without this, the user ends up
  //     N pixels above the true bottom.
  //
  // A5 decision (per plan): we picked fake rAF + fake `performance.now`
  // (option a/b in the packet). happy-dom exposes `requestAnimationFrame`
  // via `vi.stubGlobal`, and spying on `performance.now` is sufficient
  // to simulate both the long task and the late-measurement timeline.
  // No synthetic GAP_THRESHOLD injection was needed — the actual
  // `frameGap > SCROLL_SETTLE_GAP_THRESHOLD_MS` check fires naturally
  // from the manipulated frame timing, which is a stronger guard (a
  // future implementer who re-introduced `setTimeout`-based convergence
  // would still be caught here because the regression fires on
  // real-wall-clock observations, not a test-only code path).

  it('long task does not produce false stability (GAP_THRESHOLD_MS resets stability counter)', async () => {
    virtualizerState.items = [{ index: 0, size: 100, key: 'msg-a' }];
    virtualizerState.totalSize = 100;

    let fakeNow = 1000;
    const rafQueue: Array<FrameRequestCallback> = [];
    let nextRafId = 1;
    const stubbedRaf = vi.fn((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return nextRafId++;
    });
    vi.stubGlobal('requestAnimationFrame', stubbedRaf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const perfNowSpy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => fakeNow);

    try {
      const { ref, unmount } = mountPane(
        buildMinimalProps({
          visibleMessages: [makeMessage({ id: 'msg-a', role: 'user' })],
        }),
      );
      const handle = ref.current;
      if (!handle) throw new Error('handle missing');

      const scrollEl = handle.getScrollElement();
      if (!scrollEl) throw new Error('scrollEl missing');
      // Geometry pinned at bottom: scrollHeight - scrollTop - clientHeight = 0.
      Object.defineProperty(scrollEl, 'scrollHeight', {
        value: 1000,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(scrollEl, 'clientHeight', {
        value: 600,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(scrollEl, 'scrollTop', {
        value: 400,
        configurable: true,
        writable: true,
      });

      let resolvedResult: ScrollSettleResult | null = null;
      const chase = handle
        .scrollToBottomUntilStable()
        .then((r: ScrollSettleResult) => {
          resolvedResult = r;
        });

      // Counter is incremented before the first rAF is scheduled.
      expect(handle.isProgrammaticScrollInFlight?.()).toBe(true);

      const runFrame = (advanceMs = 16) => {
        fakeNow += advanceMs;
        const cb = rafQueue.shift();
        cb?.(fakeNow);
      };

      // Pump 8 normal frames @ 16ms. Quiescence window (100ms) opens
      // around frame 7, so by frame 8 the primitive has ~2 of the 3
      // required stable frames accumulated. It must NOT have resolved.
      for (let i = 0; i < 8; i++) runFrame(16);
      await Promise.resolve();
      expect(
        resolvedResult,
        'primitive must NOT resolve before STABLE_FRAMES accumulates',
      ).toBeNull();

      // Inject a simulated long task: advance fake time well past
      // GAP_THRESHOLD_MS (48ms) before running the next rAF. The
      // primitive's per-frame `frameGap > SCROLL_SETTLE_GAP_THRESHOLD_MS`
      // check should observe `resumedFromBlock = true` and reset
      // stableFrames to 0. Critically, it must NOT resolve on this frame
      // even though every other stability gate is satisfied.
      const longTaskMs = 1200;
      expect(longTaskMs).toBeGreaterThan(SCROLL_SETTLE_GAP_THRESHOLD_MS);
      runFrame(longTaskMs);
      await Promise.resolve();
      expect(
        resolvedResult,
        'primitive must NOT resolve on the first post-long-task rAF — GAP_THRESHOLD must reset the stability counter',
      ).toBeNull();

      // Pump more normal frames; stability re-accumulates from zero and
      // resolves cleanly. We pump generously (bounded by maxWallMs) to
      // avoid a brittle exact-frame-count assertion.
      for (let i = 0; i < 20; i++) {
        if (resolvedResult) break;
        runFrame(16);
      }
      await chase;
      expect(resolvedResult).toEqual({ landedAtBottom: true, reason: 'stable' });

      // Post-resolution invariants: counter was decremented (#6) and
      // wall cap was not hit (resolved via 'stable', not 'timeout').
      expect(handle.isProgrammaticScrollInFlight?.()).toBe(false);
      expect(fakeNow - 1000).toBeLessThan(SCROLL_SETTLE_MAX_WALL_MS);

      unmount();
    } finally {
      perfNowSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('late measurement after initial chase re-pins and does not resolve stable until the new bottom is stable', async () => {
    virtualizerState.items = [{ index: 0, size: 100, key: 'msg-b' }];
    virtualizerState.totalSize = 100;

    let fakeNow = 1000;
    const rafQueue: Array<FrameRequestCallback> = [];
    let nextRafId = 1;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return nextRafId++;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const perfNowSpy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => fakeNow);

    try {
      const { ref, unmount } = mountPane(
        buildMinimalProps({
          visibleMessages: [makeMessage({ id: 'msg-b', role: 'user' })],
        }),
      );
      const handle = ref.current;
      if (!handle) throw new Error('handle missing');

      const scrollEl = handle.getScrollElement();
      if (!scrollEl) throw new Error('scrollEl missing');
      Object.defineProperty(scrollEl, 'scrollHeight', {
        value: 1000,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(scrollEl, 'clientHeight', {
        value: 600,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(scrollEl, 'scrollTop', {
        value: 400,
        configurable: true,
        writable: true,
      });

      let resolvedResult: ScrollSettleResult | null = null;
      const chase = handle
        .scrollToBottomUntilStable()
        .then((r: ScrollSettleResult) => {
          resolvedResult = r;
        });

      const runFrame = (advanceMs = 16) => {
        fakeNow += advanceMs;
        const cb = rafQueue.shift();
        cb?.(fakeNow);
      };

      // Pump 5 frames of normal convergence. Quiescence doesn't fully
      // clear until frame ~7, so we're safely below `STABLE_FRAMES` at
      // this point.
      for (let i = 0; i < 5; i++) runFrame(16);
      await Promise.resolve();
      expect(resolvedResult).toBeNull();

      // Simulate a late measurement: the virtualizer commits a real
      // row height, and `scrollHeight` grows by 300px. In production
      // this is TanStack Virtual's `useFlushSync: false` resize pathway;
      // here we just mutate the DOM attribute because the primitive
      // reads it directly each frame.
      Object.defineProperty(scrollEl, 'scrollHeight', {
        value: 1300,
        configurable: true,
        writable: true,
      });

      // Next frame: geometryGap = |(1300-600) - 400| = 300 > 2px.
      // Primitive must pin `scrollTop = 700` and reset stableFrames.
      runFrame(16);
      await Promise.resolve();
      expect(
        resolvedResult,
        'primitive must NOT resolve after a late measurement grew scrollHeight — it must re-pin and re-chase',
      ).toBeNull();
      expect(
        scrollEl.scrollTop,
        'primitive must re-pin scrollTop to the new bottom (scrollHeight - clientHeight)',
      ).toBe(700);

      // Continue pumping. The new quiescence window opens ~100ms after
      // the activity pulse, and STABLE_FRAMES more frames clear the
      // gate. Bounded by maxWallMs to avoid a brittle exact-count.
      for (let i = 0; i < 30; i++) {
        if (resolvedResult) break;
        runFrame(16);
      }
      await chase;
      expect(resolvedResult).toEqual({ landedAtBottom: true, reason: 'stable' });
      // Invariant: we landed at the NEW bottom, not the pre-growth one.
      expect(scrollEl.scrollTop).toBe(700);
      // `stable` only ever resolves with STABLE_FRAMES reached, so
      // `stableFrames >= SCROLL_SETTLE_STABLE_FRAMES` must have held.
      expect(SCROLL_SETTLE_STABLE_FRAMES).toBeGreaterThanOrEqual(1);
      expect(SCROLL_SETTLE_QUIESCENCE_MS).toBeGreaterThan(0);
      expect(handle.isProgrammaticScrollInFlight?.()).toBe(false);

      unmount();
    } finally {
      perfNowSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('resolves stable when terminal row is rendered even if estimate cache never records the last message', async () => {
    // Tail row is mounted (index present in getVirtualItems) but has size=0,
    // so the post-paint cache sync intentionally skips writing to
    // `measureCacheRef` (`item.size > 0` guard). Regression target: settle
    // must still resolve via direct tail-render evidence, not cache presence.
    virtualizerState.items = [{ index: 0, size: 0, key: 'msg-tail' }];
    virtualizerState.totalSize = 100;

    let fakeNow = 1000;
    const rafQueue: Array<FrameRequestCallback> = [];
    let nextRafId = 1;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return nextRafId++;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const perfNowSpy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => fakeNow);

    try {
      const { ref, unmount } = mountPane(
        buildMinimalProps({
          visibleMessages: [makeMessage({ id: 'msg-tail', role: 'user' })],
        }),
      );
      const handle = ref.current;
      if (!handle) throw new Error('handle missing');

      const scrollEl = handle.getScrollElement();
      if (!scrollEl) throw new Error('scroll element missing');
      Object.defineProperty(scrollEl, 'scrollHeight', {
        value: 1000,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(scrollEl, 'clientHeight', {
        value: 600,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(scrollEl, 'scrollTop', {
        value: 400,
        configurable: true,
        writable: true,
      });

      let resolvedResult: ScrollSettleResult | null = null;
      const chase = handle
        .scrollToBottomUntilStable()
        .then((r: ScrollSettleResult) => {
          resolvedResult = r;
        });

      const runFrame = (advanceMs = 16) => {
        fakeNow += advanceMs;
        const cb = rafQueue.shift();
        cb?.(fakeNow);
      };

      for (let i = 0; i < 30; i++) {
        if (resolvedResult) break;
        runFrame(16);
      }
      await chase;

      expect(resolvedResult).toEqual({ landedAtBottom: true, reason: 'stable' });
      expect(fakeNow - 1000).toBeLessThan(SCROLL_SETTLE_MAX_WALL_MS);
      expect(handle.isProgrammaticScrollInFlight?.()).toBe(false);

      unmount();
    } finally {
      perfNowSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('aborting mid-primitive via AbortSignal resolves with { reason: "aborted", landedAtBottom: false } and releases the counter', async () => {
    // Plan Stage 3 test #3 — ensures `markPendingHistoryScroll`'s
    // abort-before-new-token path (hook-side) is backed by a working
    // primitive-level abort. This test drives the real primitive and
    // asserts that firing `controller.abort()` mid-flight resolves
    // cleanly: listeners removed, counter decremented, no false stable.
    virtualizerState.items = [{ index: 0, size: 100, key: 'msg-a' }];
    virtualizerState.totalSize = 100;

    let fakeNow = 1000;
    const rafQueue: Array<FrameRequestCallback> = [];
    let nextRafId = 1;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return nextRafId++;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const perfNowSpy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => fakeNow);

    try {
      const { ref, unmount } = mountPane(
        buildMinimalProps({
          visibleMessages: [makeMessage({ id: 'msg-a', role: 'user' })],
        }),
      );
      const handle = ref.current;
      if (!handle) throw new Error('handle missing');

      const scrollEl = handle.getScrollElement();
      if (!scrollEl) throw new Error('scroll element missing');
      Object.defineProperty(scrollEl, 'scrollHeight', {
        value: 1000,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(scrollEl, 'clientHeight', {
        value: 600,
        configurable: true,
        writable: true,
      });
      scrollEl.scrollTop = 0;

      const controller = new AbortController();
      let resolvedResult: ScrollSettleResult | null = null;
      const chase = handle
        .scrollToBottomUntilStable({ signal: controller.signal })
        .then((r: ScrollSettleResult) => {
          resolvedResult = r;
        });

      // Counter is now 1 (primitive in flight).
      expect(handle.isProgrammaticScrollInFlight?.()).toBe(true);

      // Pump a couple of frames so listeners/rAF loop are all attached.
      const runFrame = () => {
        fakeNow += 16;
        const cb = rafQueue.shift();
        cb?.(fakeNow);
      };
      runFrame();
      runFrame();
      await Promise.resolve();
      expect(resolvedResult).toBeNull();

      // Abort mid-primitive.
      controller.abort();
      await chase;

      expect(resolvedResult).toEqual({ landedAtBottom: false, reason: 'aborted' });
      // Critical: settle() must have run (listeners removed, counter
      // decremented). If settle's idempotency guard ever regresses, an
      // abort-then-timeout race could double-decrement → underflow.
      expect(handle.isProgrammaticScrollInFlight?.()).toBe(false);

      unmount();
    } finally {
      perfNowSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('unmount mid-primitive resolves with { reason: "unmounted", landedAtBottom: false } (no leaked listeners, no state writes)', async () => {
    // Plan Stage 3 test #5 — pane torn down while primitive is chasing.
    // The per-rAF null-check on `scrollContainerRef.current` must route
    // to `settle('unmounted', false)` without attempting any further
    // DOM work or leaving dangling listeners on the detached container.
    virtualizerState.items = [{ index: 0, size: 100, key: 'msg-a' }];
    virtualizerState.totalSize = 100;

    let fakeNow = 1000;
    const rafQueue: Array<FrameRequestCallback> = [];
    let nextRafId = 1;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return nextRafId++;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const perfNowSpy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => fakeNow);

    try {
      const { ref, unmount } = mountPane(
        buildMinimalProps({
          visibleMessages: [makeMessage({ id: 'msg-a', role: 'user' })],
        }),
      );
      const handle = ref.current;
      if (!handle) throw new Error('handle missing');

      const scrollEl = handle.getScrollElement();
      if (!scrollEl) throw new Error('scroll element missing');
      Object.defineProperty(scrollEl, 'scrollHeight', {
        value: 1000,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(scrollEl, 'clientHeight', {
        value: 600,
        configurable: true,
        writable: true,
      });

      let resolvedResult: ScrollSettleResult | null = null;
      const chase = handle
        .scrollToBottomUntilStable()
        .then((r: ScrollSettleResult) => {
          resolvedResult = r;
        });

      // One frame to ensure the rAF loop has looped at least once.
      fakeNow += 16;
      const firstFrame = rafQueue.shift();
      firstFrame?.(fakeNow);
      await Promise.resolve();
      expect(resolvedResult).toBeNull();

      // Tear the pane down mid-primitive. `scrollContainerRef.current`
      // becomes null on the next rAF.
      unmount();

      // Pump the next frame — the primitive reads a null ref, routes to
      // `settle('unmounted', false)`, Promise resolves.
      fakeNow += 16;
      const nextFrame = rafQueue.shift();
      nextFrame?.(fakeNow);
      await chase;

      expect(resolvedResult).toEqual({ landedAtBottom: false, reason: 'unmounted' });
      // The pane is unmounted, so the handle ref is released; we can't
      // re-read the counter via the handle. What we CAN assert is that
      // the Promise resolved cleanly and no further frames are scheduled
      // (raf queue would be drained by now).
      // If listeners had leaked on the detached container, they'd still
      // be reachable but harmless (the node is detached). No observable
      // way to prove non-leakage beyond "Promise resolved, no errors".
    } finally {
      perfNowSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('counter semantics: begin+begin+end keeps inFlight true; begin+end+end lands at zero with no underflow', async () => {
    // We mount a non-empty conversation so `useScrollToAnswer` is invoked
    // and the onBegin/onEnd callbacks are captured by our mock above.
    const { ref, unmount } = mountPane(
      buildMinimalProps({
        visibleMessages: [makeMessage({ id: 'm1', role: 'user' })],
      }),
    );

    const handle = ref.current;
    expect(handle).not.toBeNull();
    if (!handle) throw new Error('handle missing');
    expect(captured.onBegin).not.toBeNull();
    expect(captured.onEnd).not.toBeNull();
    const begin = captured.onBegin!;
    const end = captured.onEnd!;

    // Start: counter is zero.
    expect(handle.isProgrammaticScrollInFlight?.()).toBe(false);

    // begin → counter = 1 → inFlight true
    begin();
    expect(handle.isProgrammaticScrollInFlight?.()).toBe(true);

    // begin again → counter = 2
    begin();
    expect(handle.isProgrammaticScrollInFlight?.()).toBe(true);

    // end → counter = 1 → STILL inFlight
    //   This is the key regression-guard: the previous boolean flag
    //   would have cleared here, clobbering the second actor's pin.
    end();
    expect(handle.isProgrammaticScrollInFlight?.()).toBe(true);

    // end → counter = 0 → inFlight false
    end();
    expect(handle.isProgrammaticScrollInFlight?.()).toBe(false);

    // Extra end (unbalanced) → Math.max(0, ...) clamp must hold.
    //   No negative counter. No thrown exception. Still false.
    end();
    expect(handle.isProgrammaticScrollInFlight?.()).toBe(false);

    // And a begin after underflow-clamp still goes to 1 (not back to 0).
    begin();
    expect(handle.isProgrammaticScrollInFlight?.()).toBe(true);
    end();
    expect(handle.isProgrammaticScrollInFlight?.()).toBe(false);

    unmount();
  });
});

describe('ConversationPane persistent bottom anchor', () => {
  it('re-pins to bottom on virtualizer activity even when no resize observer fires', async () => {
    const rafQueue: Array<FrameRequestCallback> = [];
    let nextRafId = 1;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return nextRafId++;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    virtualizerState.items = [{ index: 0, size: 100, key: 'msg-anchor' }];
    virtualizerState.totalSize = 100;

    // Commit 5c1829f92 ("feat(scroll): Disable virtualizer-onChange anchor
    // re-pin by default with kill-switch") gated the legacy 71e263816
    // re-pin wiring (`anchorActivityListenerRef.current = schedulePinToBottom`)
    // behind a `localStorage.scrollDebug.enableAnchorOnChange === '1'`
    // kill-switch. The pane reads this flag once, at mount, so we set it
    // BEFORE `mountPane(...)`. This test continues to guard the
    // kill-switch-enabled path; the default (listener disabled) is an
    // intentional no-op with nothing to assert.
    window.localStorage.setItem('scrollDebug.enableAnchorOnChange', '1');

    try {
      const { ref, unmount } = mountPane(
        buildMinimalProps({
          visibleMessages: [makeMessage({ id: 'msg-anchor', role: 'assistant' })],
        }),
      );

      const handle = ref.current;
      if (!handle) throw new Error('handle missing');

      const scrollEl = handle.getScrollElement();
      if (!scrollEl) throw new Error('scroll element missing');

      Object.defineProperty(scrollEl, 'scrollHeight', {
        value: 1000,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(scrollEl, 'clientHeight', {
        value: 600,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(scrollEl, 'scrollTop', {
        value: 400,
        configurable: true,
        writable: true,
      });

      // Simulate TanStack Virtual applying an async correction that moves the
      // viewport away from the bottom without changing element size.
      scrollEl.scrollTop = 250;
      virtualizerState.onChange?.();

      // The anchor coalesces virtualizer churn onto the next frame.
      const scheduledPin = rafQueue.shift();
      expect(scheduledPin).toBeTypeOf('function');
      scheduledPin?.(16);

      expect(scrollEl.scrollTop).toBe(400);

      // Flush the pin's cleanup frame so the counter returns to zero.
      const releasePin = rafQueue.shift();
      releasePin?.(32);
      expect(handle.isProgrammaticScrollInFlight?.()).toBe(false);

      unmount();
    } finally {
      vi.unstubAllGlobals();
      window.localStorage.removeItem('scrollDebug.enableAnchorOnChange');
    }
  });
});
