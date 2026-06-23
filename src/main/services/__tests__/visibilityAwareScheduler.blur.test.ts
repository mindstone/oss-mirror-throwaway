import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSchedulerLogger } = vi.hoisted(() => ({
  mockSchedulerLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockSchedulerLogger,
}));

// Mock @core/lazyElectron — default: no focused window (real blur)
const mockGetFocusedWindow = vi.fn().mockReturnValue(null);
 
vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => ({
    BrowserWindow: {
      getFocusedWindow: mockGetFocusedWindow,
    },
  }),
}));

import {
  createPausableInterval,
  createThrottledInterval,
  initBlurScheduler,
  isAppCurrentlyBlurred,
  getBlurState,
  onBlurStateChange,
  waitForFocus,
  _resetForTesting,
  _setBlurredForTesting,
  _setHiddenForTesting,
  _setHeadlessModeForTesting,
  _scheduleBlurTransitionForTesting,
  _setBlurDebounceMsForTesting,
} from '../visibilityAwareScheduler';

describe('visibilityAwareScheduler — blur-aware scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetForTesting();
    mockGetFocusedWindow.mockReturnValue(null);
  });

  afterEach(() => {
    _resetForTesting();
    vi.useRealTimers();
  });

  // ── Blur-pause ─────────────────────────────────────────────────────

  describe('blur-pause (pauseOnBlur: true)', () => {
    it('pauses interval when blurred', async () => {
      const cb = vi.fn();
      const cleanup = createPausableInterval(cb, 1000, { pauseOnBlur: true });

      // First tick fires at t=1000
      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      // Blur the app
      _setBlurredForTesting(true);

      // Advance time — callback should NOT fire (paused)
      await vi.advanceTimersByTimeAsync(5000);
      expect(cb).toHaveBeenCalledTimes(1);

      cleanup();
    });

    it('resumes with catch-up tick on focus', async () => {
      const cb = vi.fn();
      const cleanup = createPausableInterval(cb, 1000, { pauseOnBlur: true });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      // Blur → pause
      _setBlurredForTesting(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(cb).toHaveBeenCalledTimes(1);

      // Focus → catch-up tick fires immediately (priority 0)
      _setBlurredForTesting(false);
      // Flush microtask queue for the async catch-up callback
      await vi.advanceTimersByTimeAsync(0);
      expect(cb).toHaveBeenCalledTimes(2);

      // Regular ticks resume
      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(3);

      cleanup();
    });
  });

  // ── Blur-throttle ──────────────────────────────────────────────────

  describe('blur-throttle (blurThrottleMs)', () => {
    it('throttles to blur rate when blurred', async () => {
      const cb = vi.fn();
      // Foreground: 1s, Background (minimize): 5s, Blur throttle: 3s
      const cleanup = createThrottledInterval(cb, 1000, 5000, {
        blurThrottleMs: 3000,
      });

      // First tick at foreground rate
      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      // Blur → throttle to 3s
      _setBlurredForTesting(true);

      // Should NOT fire at 1s intervals
      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      // Should fire at 3s (blur throttle)
      await vi.advanceTimersByTimeAsync(2000);
      expect(cb).toHaveBeenCalledTimes(2);

      // Another blur-throttled tick
      await vi.advanceTimersByTimeAsync(3000);
      expect(cb).toHaveBeenCalledTimes(3);

      cleanup();
    });

    it('resumes foreground rate on focus', async () => {
      const cb = vi.fn();
      const cleanup = createThrottledInterval(cb, 1000, 5000, {
        blurThrottleMs: 3000,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      _setBlurredForTesting(true);
      await vi.advanceTimersByTimeAsync(3000);
      expect(cb).toHaveBeenCalledTimes(2);

      // Focus → catch-up + resume foreground
      _setBlurredForTesting(false);
      await vi.advanceTimersByTimeAsync(0); // flush catch-up
      expect(cb).toHaveBeenCalledTimes(3); // catch-up tick

      // Back to foreground rate (1s)
      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(4);

      cleanup();
    });
  });

  // ── Catch-up stagger ───────────────────────────────────────────────

  describe('staggered catch-up on focus', () => {
    it('staggers catch-up by priority (lower = earlier)', async () => {
      const order: string[] = [];

      const cleanupA = createPausableInterval(
        () => { order.push('A-priority-0'); },
        1000,
        { pauseOnBlur: true, catchUpPriority: 0 }
      );
      const cleanupB = createPausableInterval(
        () => { order.push('B-priority-2'); },
        1000,
        { pauseOnBlur: true, catchUpPriority: 2 }
      );
      const cleanupC = createPausableInterval(
        () => { order.push('C-priority-1'); },
        1000,
        { pauseOnBlur: true, catchUpPriority: 1 }
      );

      // Let all fire once
      await vi.advanceTimersByTimeAsync(1000);
      order.length = 0; // Reset

      // Blur all
      _setBlurredForTesting(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(order).toHaveLength(0); // All paused

      // Focus → staggered catch-up
      _setBlurredForTesting(false);

      // Priority 0 runs immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toContain('A-priority-0');
      expect(order).not.toContain('C-priority-1');
      expect(order).not.toContain('B-priority-2');

      // Priority 1 runs after 1s
      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toContain('C-priority-1');
      expect(order).not.toContain('B-priority-2');

      // Priority 2 runs after 2s
      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toContain('B-priority-2');

      cleanupA();
      cleanupB();
      cleanupC();
    });

    it('waits for the configured delay before catch-up, then resumes normal cadence', async () => {
      const cb = vi.fn();
      const cleanup = createPausableInterval(cb, 1000, {
        pauseOnBlur: true,
        catchUpPriority: 2,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      _setBlurredForTesting(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(cb).toHaveBeenCalledTimes(1);

      _setBlurredForTesting(false);

      // No early catch-up before the full stagger delay elapses.
      await vi.advanceTimersByTimeAsync(1999);
      expect(cb).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(cb).toHaveBeenCalledTimes(2);

      // Foreground cadence resumes from the delayed catch-up point.
      await vi.advanceTimersByTimeAsync(999);
      expect(cb).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(cb).toHaveBeenCalledTimes(3);

      cleanup();
    });
  });

  // ── Keep-alive ─────────────────────────────────────────────────────

  describe('keep-alive mechanism', () => {
    it('keeps interval running at foreground rate when shouldKeepAlive returns true', async () => {
      const cb = vi.fn();
      const meetingActive = true;

      const cleanup = createPausableInterval(cb, 1000, {
        pauseOnBlur: true,
        shouldKeepAlive: () => meetingActive,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      // Blur — but keep-alive is active
      _setBlurredForTesting(true);

      // Should continue at foreground rate
      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(3);

      cleanup();
    });

    it('keeps throttled intervals at foreground rate during blur when shouldKeepAlive returns true', async () => {
      const cb = vi.fn();

      const cleanup = createThrottledInterval(cb, 1000, 5000, {
        blurThrottleMs: 3000,
        shouldKeepAlive: () => true,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      _setBlurredForTesting(true);

      // shouldKeepAlive should win over blurThrottleMs and preserve the 1s cadence.
      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(3);

      cleanup();
    });

    it('pauses when shouldKeepAlive returns false during blur', async () => {
      const cb = vi.fn();
      let meetingActive = true;

      const cleanup = createPausableInterval(cb, 1000, {
        pauseOnBlur: true,
        shouldKeepAlive: () => meetingActive,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      // Blur with keep-alive active — keeps running
      _setBlurredForTesting(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(2);

      // Meeting ends — shouldKeepAlive now returns false
      // The keep-alive is re-checked on each scheduleNextTick call
      // After the current tick completes, scheduleNextTick runs again and checks shouldKeepAlive
      meetingActive = false;

      // The next scheduled tick fires (was already scheduled at foreground rate),
      // then the NEXT reschedule sees shouldKeepAlive() === false → pause
      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(3);

      // Now it should be paused
      await vi.advanceTimersByTimeAsync(5000);
      expect(cb).toHaveBeenCalledTimes(3);

      cleanup();
    });
  });

  // ── Backward compatibility ─────────────────────────────────────────

  describe('backward compatibility', () => {
    it('interval without blur opts behaves identically (not affected by blur)', async () => {
      const cb = vi.fn();
      const cleanup = createPausableInterval(cb, 1000); // No opts

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      // Blur should NOT affect this interval
      _setBlurredForTesting(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(3);

      cleanup();
    });

    it('throttled interval without blur opts ignores blur', async () => {
      const cb = vi.fn();
      const cleanup = createThrottledInterval(cb, 1000, 5000); // No blur opts

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      // Blur should NOT change rate
      _setBlurredForTesting(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(2);

      cleanup();
    });

    it('minimize still pauses pausable intervals (blur-aware or not)', async () => {
      const cb = vi.fn();
      const cleanup = createPausableInterval(cb, 1000, { pauseOnBlur: true });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      // Minimize (hidden) should pause
      _setHiddenForTesting(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(cb).toHaveBeenCalledTimes(1);

      // Restore → catch-up
      _setHiddenForTesting(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(cb).toHaveBeenCalledTimes(2);

      cleanup();
    });
  });

  // ── Headless mode ──────────────────────────────────────────────────

  describe('headless mode', () => {
    it('blur events are ignored in headless mode', async () => {
      _setHeadlessModeForTesting(true);

      const cb = vi.fn();
      const cleanup = createPausableInterval(cb, 1000, { pauseOnBlur: true });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      // Blur should be ignored in headless mode
      _setBlurredForTesting(true);
      expect(isAppCurrentlyBlurred()).toBe(false); // Always false in headless

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(2); // Still running

      cleanup();
    });
  });

  // ── isAppCurrentlyBlurred ──────────────────────────────────────────

  describe('isAppCurrentlyBlurred()', () => {
    it('returns false by default', () => {
      expect(isAppCurrentlyBlurred()).toBe(false);
    });

    it('returns true when blurred', () => {
      _setBlurredForTesting(true);
      expect(isAppCurrentlyBlurred()).toBe(true);
    });

    it('returns false after focus', () => {
      _setBlurredForTesting(true);
      _setBlurredForTesting(false);
      expect(isAppCurrentlyBlurred()).toBe(false);
    });

    it('returns false in headless mode even when blurred', () => {
      _setHeadlessModeForTesting(true);
      _setBlurredForTesting(true);
      expect(isAppCurrentlyBlurred()).toBe(false);
    });
  });

  // ── getBlurState ───────────────────────────────────────────────────

  describe('getBlurState()', () => {
    it('reports initial state', () => {
      const state = getBlurState();
      expect(state.isBlurred).toBe(false);
      expect(state.isInitialized).toBe(false);
    });
  });

  // ── Blur listeners / waitForFocus ─────────────────────────────────

  describe('onBlurStateChange()', () => {
    it('fires on blur/focus transitions and stops after unsubscribe', () => {
      const listener = vi.fn();
      const unsubscribe = onBlurStateChange(listener);

      _setBlurredForTesting(true);
      _setBlurredForTesting(false);

      expect(listener).toHaveBeenNthCalledWith(1, true);
      expect(listener).toHaveBeenNthCalledWith(2, false);

      unsubscribe();
      _setBlurredForTesting(true);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('isolates listener failures so scheduler state still updates', () => {
      const healthyListener = vi.fn();
      onBlurStateChange(() => {
        throw new Error('listener boom');
      });
      onBlurStateChange(healthyListener);

      _setBlurredForTesting(true);

      expect(getBlurState().isBlurred).toBe(true);
      expect(healthyListener).toHaveBeenCalledWith(true);
      expect(mockSchedulerLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'Blur state listener threw an error'
      );
    });

    it('handles reentrant blur listeners without leaving the scheduler stuck blurred', () => {
      const healthyListener = vi.fn();
      onBlurStateChange(healthyListener);
      onBlurStateChange((isBlurred) => {
        if (isBlurred) {
          _setBlurredForTesting(false);
        }
      });

      expect(() => _setBlurredForTesting(true)).not.toThrow();
      expect(healthyListener.mock.calls).toEqual([[true], [false]]);
      expect(getBlurState().isBlurred).toBe(false);
    });
  });

  describe('waitForFocus()', () => {
    it('resolves immediately when already focused', async () => {
      await expect(waitForFocus()).resolves.toBe('focused');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('settles on a focus transition and cleans up timers', async () => {
      _setBlurredForTesting(true);

      const waitPromise = waitForFocus(undefined, 5_000);

      expect(vi.getTimerCount()).toBe(1);
      _setBlurredForTesting(false);

      await expect(waitPromise).resolves.toBe('focused');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('settles timeout when focus does not return', async () => {
      _setBlurredForTesting(true);

      const waitPromise = waitForFocus(undefined, 2_500);

      await vi.advanceTimersByTimeAsync(2_500);
      await expect(waitPromise).resolves.toBe('timeout');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('settles aborted when the signal aborts', async () => {
      _setBlurredForTesting(true);
      const controller = new AbortController();

      const waitPromise = waitForFocus(controller.signal, 5_000);
      controller.abort();

      await expect(waitPromise).resolves.toBe('aborted');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('resolves immediately for a pre-aborted signal', async () => {
      _setBlurredForTesting(true);
      const controller = new AbortController();
      controller.abort();

      await expect(waitForFocus(controller.signal, 5_000)).resolves.toBe('aborted');
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('disposed interval is not affected by blur transitions', async () => {
      const cb = vi.fn();
      const cleanup = createPausableInterval(cb, 1000, { pauseOnBlur: true });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      cleanup(); // Dispose

      // Blur/focus should not resurrect the interval
      _setBlurredForTesting(true);
      _setBlurredForTesting(false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('blur-throttle with pauseOnBlur — blurThrottleMs takes precedence', async () => {
      const cb = vi.fn();
      // Both pauseOnBlur and blurThrottleMs — throttle wins (not full pause)
      const cleanup = createPausableInterval(cb, 1000, {
        pauseOnBlur: true,
        blurThrottleMs: 2000,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      _setBlurredForTesting(true);

      // Should throttle to 2s, not pause
      await vi.advanceTimersByTimeAsync(2000);
      expect(cb).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(2000);
      expect(cb).toHaveBeenCalledTimes(3);

      cleanup();
    });

    it('staggered catch-up skips disposed intervals', async () => {
      const cbA = vi.fn();
      const cbB = vi.fn();

      const cleanupA = createPausableInterval(cbA, 1000, {
        pauseOnBlur: true,
        catchUpPriority: 0,
      });
      const cleanupB = createPausableInterval(cbB, 1000, {
        pauseOnBlur: true,
        catchUpPriority: 2,
      });

      await vi.advanceTimersByTimeAsync(1000);
      cbA.mockClear();
      cbB.mockClear();

      _setBlurredForTesting(true);
      await vi.advanceTimersByTimeAsync(1000);

      // Dispose B before focus returns
      cleanupB();

      _setBlurredForTesting(false);
      await vi.advanceTimersByTimeAsync(0); // Priority 0 catch-up
      expect(cbA).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000); // Priority 2 would fire, but B is disposed
      expect(cbB).toHaveBeenCalledTimes(0);

      cleanupA();
    });

    it('re-blur during staggered catch-up clears tracked stagger timeouts', async () => {
      const cbA = vi.fn();
      const cbB = vi.fn();

      const cleanupA = createPausableInterval(cbA, 1000, {
        pauseOnBlur: true,
        catchUpPriority: 0,
      });
      const cleanupB = createPausableInterval(cbB, 1000, {
        pauseOnBlur: true,
        catchUpPriority: 3,
      });

      await vi.advanceTimersByTimeAsync(1000);
      cbA.mockClear();
      cbB.mockClear();

      _setBlurredForTesting(true);
      await vi.advanceTimersByTimeAsync(1000);

      // Focus
      _setBlurredForTesting(false);
      await vi.advanceTimersByTimeAsync(0); // A catches up (priority 0)
      expect(cbA).toHaveBeenCalledTimes(1);

      // Re-blur before B's catch-up (priority 3 = 3s delay)
      _setBlurredForTesting(true);
      await vi.advanceTimersByTimeAsync(3000);
      // B's catch-up should be skipped (guard checks isAppBlurred)
      expect(cbB).toHaveBeenCalledTimes(0);

      cleanupA();
      cleanupB();
    });

    it('child window blur does not trigger blur state (initBlurScheduler guard)', async () => {
      const handlers: Partial<Record<'blur' | 'focus', () => void>> = {};
      const mainWindow = {
        on: vi.fn((event: 'blur' | 'focus', handler: () => void) => {
          handlers[event] = handler;
        }),
      } as unknown as Parameters<typeof initBlurScheduler>[0];

      initBlurScheduler(mainWindow);

      const cb = vi.fn();
      const cleanup = createPausableInterval(cb, 1000, { pauseOnBlur: true });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      mockGetFocusedWindow.mockReturnValue({ id: 2 });
      handlers.blur?.();
      expect(getBlurState().isBlurred).toBe(false);

      // Still runs because the app never entered blur state.
      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(2);

      // A real blur (no focused Electron window) should pause the interval.
      mockGetFocusedWindow.mockReturnValue(null);
      handlers.blur?.();
      expect(getBlurState().isBlurred).toBe(true);

      await vi.advanceTimersByTimeAsync(2000);
      expect(cb).toHaveBeenCalledTimes(2);

      handlers.focus?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(cb).toHaveBeenCalledTimes(3);

      cleanup();
    });
  });

  // ── Review refinement fixes ────────────────────────────────────────

  describe('shouldKeepAlive error handling (fail-open)', () => {
    it('treats shouldKeepAlive error as false — falls back to blur pause', async () => {
      const cb = vi.fn();
      const shouldKeepAlive = vi.fn(() => { throw new Error('boom'); });
      const cleanup = createPausableInterval(cb, 1000, {
        pauseOnBlur: true,
        shouldKeepAlive,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      _setBlurredForTesting(true);

      // shouldKeepAlive was called during blur reschedule and threw → treated as false → paused
      expect(shouldKeepAlive).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(cb).toHaveBeenCalledTimes(1);

      cleanup();
    });

    it('treats shouldKeepAlive error as false — falls back to blur throttle rate', async () => {
      const cb = vi.fn();
      const shouldKeepAlive = vi.fn(() => { throw new Error('boom'); });
      const cleanup = createThrottledInterval(cb, 1000, 5000, {
        blurThrottleMs: 3000,
        shouldKeepAlive,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      _setBlurredForTesting(true);

      // shouldKeepAlive was called and threw → falls back to blurThrottleMs (3s)
      expect(shouldKeepAlive).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3000);
      expect(cb).toHaveBeenCalledTimes(2);

      cleanup();
    });
  });

  describe('blurThrottleMs minimum enforcement', () => {
    it('enforces minimum 1000ms for blurThrottleMs across multiple ticks', async () => {
      const cb = vi.fn();
      const cleanup = createThrottledInterval(cb, 2000, 5000, {
        blurThrottleMs: 100, // Too low — should be clamped to 1000
      });

      await vi.advanceTimersByTimeAsync(2000);
      expect(cb).toHaveBeenCalledTimes(1);

      _setBlurredForTesting(true);

      // At 100ms it should NOT fire (clamped to 1000ms)
      await vi.advanceTimersByTimeAsync(100);
      expect(cb).toHaveBeenCalledTimes(1);

      // First blurred tick at 1000ms
      await vi.advanceTimersByTimeAsync(900);
      expect(cb).toHaveBeenCalledTimes(2);

      // Second blurred tick also at 1000ms (floor persists across reschedules)
      await vi.advanceTimersByTimeAsync(999);
      expect(cb).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(cb).toHaveBeenCalledTimes(3);

      cleanup();
    });

    it('enforces minimum 1000ms when blurThrottleMs is 0', async () => {
      const cb = vi.fn();
      const cleanup = createThrottledInterval(cb, 2000, 5000, {
        blurThrottleMs: 0,
      });

      await vi.advanceTimersByTimeAsync(2000);
      expect(cb).toHaveBeenCalledTimes(1);

      _setBlurredForTesting(true);

      await vi.advanceTimersByTimeAsync(999);
      expect(cb).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(cb).toHaveBeenCalledTimes(2);

      cleanup();
    });
  });

  describe('stagger timeout cleanup on re-blur', () => {
    it('re-blur actively cancels stagger timeouts (not just guard-only)', async () => {
      const cb = vi.fn();
      const cleanup = createPausableInterval(cb, 1000, {
        pauseOnBlur: true,
        catchUpPriority: 5, // 5s delay
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      // Blur -> focus: schedules stagger at 5s
      _setBlurredForTesting(true);
      await vi.advanceTimersByTimeAsync(1000);
      _setBlurredForTesting(false);

      // Re-blur at 2s (before the 5s stagger fires)
      await vi.advanceTimersByTimeAsync(2000);
      _setBlurredForTesting(true);

      // Focus again at 3s — schedules NEW stagger at 5s from now
      await vi.advanceTimersByTimeAsync(1000);
      _setBlurredForTesting(false);

      // If the first stagger was NOT actively cancelled, it would fire at the
      // original 5s mark (i.e., 2s from second focus). With active cancellation,
      // only the second stagger (5s from second focus) should fire.
      // Advance 2s — the old stagger would have fired here if not cancelled
      await vi.advanceTimersByTimeAsync(2000);
      expect(cb).toHaveBeenCalledTimes(1); // No early catch-up

      // Advance to 5s from second focus — new stagger fires
      await vi.advanceTimersByTimeAsync(3000);
      expect(cb).toHaveBeenCalledTimes(2); // Exactly one catch-up

      cleanup();
    });

    it('minimize during stagger delay cancels pending stagger catch-ups', async () => {
      const cb = vi.fn();
      const cleanup = createPausableInterval(cb, 1000, {
        pauseOnBlur: true,
        catchUpPriority: 3, // 3s delay
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(cb).toHaveBeenCalledTimes(1);

      // Blur -> focus: schedules stagger at 3s
      _setBlurredForTesting(true);
      await vi.advanceTimersByTimeAsync(1000);
      _setBlurredForTesting(false);

      // Minimize at 1s into stagger delay
      await vi.advanceTimersByTimeAsync(1000);
      _setHiddenForTesting(true);

      // Advance past the original 3s stagger — should NOT fire (hidden cancels stagger)
      await vi.advanceTimersByTimeAsync(5000);
      expect(cb).toHaveBeenCalledTimes(1);

      cleanup();
    });
  });

  // ── OS-event debounce (Stage 3, 260424 observability follow-up) ───

  describe('OS-event blur debounce (300 ms)', () => {
    beforeEach(() => {
      // Opt in — debounce is OFF by default in tests (see `_resetForTesting`
      // comment) to preserve existing blur-aware suite semantics. Stage 3
      // tests explicitly turn it on at the production default.
      _setBlurDebounceMsForTesting(300);
    });

    it('rapid flap collapses to a single state transition after debounce window', async () => {
      const listener = vi.fn();
      onBlurStateChange(listener);

      // 5 blur↔focus events within 200 ms — all under the 300 ms debounce window
      _scheduleBlurTransitionForTesting(true);   // t=0
      await vi.advanceTimersByTimeAsync(40);
      _scheduleBlurTransitionForTesting(false);  // t=40
      await vi.advanceTimersByTimeAsync(40);
      _scheduleBlurTransitionForTesting(true);   // t=80
      await vi.advanceTimersByTimeAsync(40);
      _scheduleBlurTransitionForTesting(false);  // t=120
      await vi.advanceTimersByTimeAsync(40);
      _scheduleBlurTransitionForTesting(true);   // t=160 — terminal state

      // While inside the debounce window, no listener fired
      expect(listener).not.toHaveBeenCalled();
      expect(isAppCurrentlyBlurred()).toBe(false);

      // Flush the 300 ms debounce (160 + 300 = 460)
      await vi.advanceTimersByTimeAsync(300);

      // Exactly one transition fires, to the terminal `true`
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(true);
      expect(isAppCurrentlyBlurred()).toBe(true);
    });

    it('sustained blur > debounce window propagates after 300 ms', async () => {
      const listener = vi.fn();
      onBlurStateChange(listener);

      _scheduleBlurTransitionForTesting(true);

      // Before the debounce window — no transition
      await vi.advanceTimersByTimeAsync(299);
      expect(listener).not.toHaveBeenCalled();
      expect(isAppCurrentlyBlurred()).toBe(false);

      // Crossing the window — transition fires
      await vi.advanceTimersByTimeAsync(1);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(true);
      expect(isAppCurrentlyBlurred()).toBe(true);
    });

    it('flap that returns to original state before window elapses fires NO transition', async () => {
      const listener = vi.fn();
      onBlurStateChange(listener);

      // focused → blurred → focused, all within 200 ms
      _scheduleBlurTransitionForTesting(true);
      await vi.advanceTimersByTimeAsync(100);
      _scheduleBlurTransitionForTesting(false);

      // Pending was blur→true; flap to false cancels pending because target
      // changed, then `isAppBlurred === false` already → no new pending.
      await vi.advanceTimersByTimeAsync(500);
      expect(listener).not.toHaveBeenCalled();
      expect(isAppCurrentlyBlurred()).toBe(false);
    });

    it('debounce does not delay transitions forced via _setBlurredForTesting', async () => {
      const listener = vi.fn();
      onBlurStateChange(listener);

      // Direct helper bypasses the debounce (existing test invariant)
      _setBlurredForTesting(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(isAppCurrentlyBlurred()).toBe(true);
    });

    it('debounce window of 0 ms applies synchronously (test override)', async () => {
      _setBlurDebounceMsForTesting(0);
      const listener = vi.fn();
      onBlurStateChange(listener);

      _scheduleBlurTransitionForTesting(true);
      // No timer advance needed
      expect(listener).toHaveBeenCalledTimes(1);
      expect(isAppCurrentlyBlurred()).toBe(true);
    });

    it('repeated-same-target transitions collapse (blur → blur → blur = one fire)', async () => {
      const listener = vi.fn();
      onBlurStateChange(listener);

      _scheduleBlurTransitionForTesting(true);
      await vi.advanceTimersByTimeAsync(50);
      _scheduleBlurTransitionForTesting(true);
      await vi.advanceTimersByTimeAsync(50);
      _scheduleBlurTransitionForTesting(true);

      await vi.advanceTimersByTimeAsync(300);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(true);
    });

    it('pending debounce is cleared on _resetForTesting (no leaked timer)', async () => {
      const listener = vi.fn();
      onBlurStateChange(listener);

      _scheduleBlurTransitionForTesting(true);
      // Reset before the debounce window elapses.
      _resetForTesting();

      await vi.advanceTimersByTimeAsync(5000);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
