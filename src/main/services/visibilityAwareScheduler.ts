/**
 * Visibility-Aware Scheduler for Main Process
 *
 * Provides interval scheduling that respects app visibility state.
 * Reduces CPU usage when the app is hidden/minimized by throttling
 * or pausing non-critical background work.
 *
 * Two interval functions:
 * - `createPausableInterval`: Pauses completely when hidden
 * - `createThrottledInterval`: Runs at a slower rate when hidden
 *
 * Both support "catch-up" behavior: when transitioning from hidden to
 * visible, the callback is invoked immediately to refresh stale data.
 *
 * Blur-Aware Scheduling (opt-in):
 * - Both `createPausableInterval` and `createThrottledInterval` accept an optional
 *   `IntervalBlurOptions` parameter to also pause/throttle when the app loses focus
 *   (e.g., user switches to Zoom). This is independent from minimize-based visibility.
 * - Staggered catch-up on focus return prevents CPU/network spikes.
 * - Keep-alive mechanism for intervals that must run despite blur (e.g., active meetings).
 *
 * Battery-Aware Scheduling:
 * - `createBatteryThrottledInterval`: Runs at a slower rate when on battery
 * - Unlike visibility throttling, no catch-up tick on battery→AC transition
 *
 * Usage:
 *   import { initVisibilityScheduler, initBlurScheduler, initBatteryScheduler, createPausableInterval, createBatteryThrottledInterval } from './visibilityAwareScheduler';
 *
 *   // In createWindow, after mainWindow is created:
 *   initVisibilityScheduler(mainWindow);
 *   initBlurScheduler(mainWindow);
 *   initBatteryScheduler();
 *
 *   // In services:
 *   const cleanup = createPausableInterval(() => checkStaleEmbeddings(), 5 * 60 * 1000);
 *   const blurAware = createPausableInterval(() => refreshData(), 5 * 60 * 1000, { pauseOnBlur: true, catchUpPriority: 2 });
 *   const batteryCleanup = createBatteryThrottledInterval(() => syncCalendar(), 15 * 60 * 1000, 30 * 60 * 1000);
 *   // Call cleanup() to stop the interval
 */

import type { BrowserWindow } from 'electron';
import { getElectronModule } from '@core/lazyElectron';
import { createScopedLogger } from '@core/logger';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { isHeadlessCli } from '../utils/testIsolation';

const logger = createScopedLogger({ service: 'visibilityAwareScheduler' });

// Module state - Visibility
let isAppHidden = false;
let isVisibilityInitialized = false;
let isHeadlessMode = false;

// Module state - Blur (independent from visibility/minimize)
let isAppBlurred = false;
let isBlurInitialized = false;
type BlurListener = (isBlurred: boolean) => void;
const blurListeners = new Set<BlurListener>();

// Stagger catch-up timeout tracking — cleared on re-blur and reset
const pendingStaggerTimeouts = new Set<ReturnType<typeof setTimeout>>();

// Debounce for OS-driven blur/focus events. Rapid blur↔focus flaps
// (e.g. clicking through stacked windows, OS spotlight popping up briefly)
// collapse to a single terminal state, preventing listener stampedes
// and reschedule thrash for blur-aware intervals. Applied ONLY at the
// OS-event boundary in initBlurScheduler; the internal setAppBlurred()
// and _setBlurredForTesting helpers apply immediately.
const DEFAULT_BLUR_DEBOUNCE_MS = 300;
let blurDebounceMs = DEFAULT_BLUR_DEBOUNCE_MS;
let pendingBlurTransition: {
  target: boolean;
  source: string;
  timeoutId: ReturnType<typeof setTimeout>;
} | null = null;

function scheduleBlurTransition(target: boolean, source: string): void {
  if (isHeadlessMode) return;

  // If a debounce is pending and the new target matches the pending one,
  // no work to do — the pending fire will settle to the same state.
  if (pendingBlurTransition?.target === target) {
    return;
  }

  // If a debounce is pending for the OPPOSITE state, cancel it —
  // this is the flap case (blur→focus→blur or focus→blur→focus).
  if (pendingBlurTransition) {
    clearTimeout(pendingBlurTransition.timeoutId);
    pendingBlurTransition = null;
  }

  // If target equals current state with nothing pending, no-op —
  // matches setAppBlurred's own "no change" early return.
  if (isAppBlurred === target) {
    return;
  }

  // Debounce window 0 means apply synchronously (test hook).
  if (blurDebounceMs <= 0) {
    setAppBlurred(target, source);
    return;
  }

  const timeoutId = setTimeout(() => {
    pendingBlurTransition = null;
    setAppBlurred(target, source);
  }, blurDebounceMs);
  pendingBlurTransition = { target, source, timeoutId };
}

// Module state - Battery
let isOnBattery = false;
let isBatteryInitialized = false;

// Active intervals registry for visibility change handling
const activeIntervals = new Set<ManagedInterval>();

// Active intervals registry for battery change handling
const activeBatteryIntervals = new Set<BatteryManagedInterval>();

/**
 * Options for blur-aware interval behavior.
 * Opt-in: intervals without blur options behave identically to before.
 */
export interface IntervalBlurOptions {
  /** If true, pause the interval when the app is blurred (default: false). */
  pauseOnBlur?: boolean;
  /** If set, throttle to this rate (ms) on blur instead of pausing. Overrides pauseOnBlur. Minimum 1000ms enforced. */
  blurThrottleMs?: number;
  /** Catch-up priority on focus return. Lower = higher priority = earlier catch-up. Default 0. */
  catchUpPriority?: number;
  /** If provided and returns true, keep running at foreground rate despite blur (e.g., active meeting). Errors are caught and treated as false (fail-open to blur behavior). */
  shouldKeepAlive?: () => boolean;
}

interface BatteryManagedInterval {
  callback: () => void | Promise<void>;
  normalMs: number;
  batteryMs: number;
  timerId: ReturnType<typeof setTimeout> | null;
  isRunning: boolean;
  isDisposed: boolean;
  scheduleNext: () => void;
}

interface ManagedInterval {
  callback: () => void | Promise<void>;
  foregroundMs: number;
  backgroundMs: number | null; // null = pause when hidden
  blurOpts?: IntervalBlurOptions;
  timerId: ReturnType<typeof setTimeout> | null;
  isRunning: boolean;
  isDisposed: boolean; // Prevents resurrection after cleanup
  isBlurAffected: boolean; // Currently paused/throttled due to blur
  scheduleNext: () => void;
}

/**
 * Initialize the visibility scheduler with the main window.
 * Must be called after the BrowserWindow is created.
 *
 * Uses minimize/restore events in addition to focus/blur to accurately
 * detect when the app is truly hidden from the user.
 *
 * @param mainWindow The main Electron BrowserWindow
 */
export function initVisibilityScheduler(mainWindow: BrowserWindow): void {
  if (isVisibilityInitialized) {
    logger.warn('Visibility scheduler already initialized');
    return;
  }

  // Check headless mode - treat as always visible
  isHeadlessMode = isHeadlessCli();

  if (isHeadlessMode) {
    logger.info('Headless mode detected - visibility intervals will always run at foreground rate');
    isVisibilityInitialized = true;
    return;
  }

  // Set initial state based on window state
  // Only treat as hidden if minimized - unfocused but visible should run normally
  // (Matches the blur handler logic: blur only counts as hidden if minimized)
  isAppHidden = mainWindow.isMinimized();
  logger.debug({ isAppHidden }, 'Initial visibility state');

  // Track visibility via multiple event sources
  mainWindow.on('minimize', () => {
    setAppHidden(true, 'minimize');
  });

  mainWindow.on('restore', () => {
    setAppHidden(false, 'restore');
  });

  mainWindow.on('blur', () => {
    // On blur, only consider hidden if also minimized
    // (a focused but non-active window is still visible)
    if (mainWindow.isMinimized()) {
      setAppHidden(true, 'blur+minimized');
    }
  });

  mainWindow.on('focus', () => {
    setAppHidden(false, 'focus');
  });

  isVisibilityInitialized = true;
  logger.info('Visibility scheduler initialized');
}

/**
 * Initialize the blur scheduler with the main window.
 * Tracks app blur/focus state independently from minimize-based visibility.
 *
 * Blur pausing is opt-in per interval via `IntervalBlurOptions`.
 * Must be called after `initVisibilityScheduler` and after the BrowserWindow is created.
 *
 * Guards:
 * - Idempotent (safe to call multiple times)
 * - Headless mode: treated as never blurred
 * - Child window blur: if another Electron window has focus, blur is ignored
 *
 * @param mainWindow The main Electron BrowserWindow
 */
export function initBlurScheduler(mainWindow: BrowserWindow): void {
  if (isBlurInitialized) {
    logger.warn('Blur scheduler already initialized');
    return;
  }

  // Headless mode — treat as never blurred (same as visibility)
  if (isHeadlessMode) {
    logger.info('Headless mode detected - blur scheduler will not activate');
    isBlurInitialized = true;
    return;
  }

  mainWindow.on('blur', () => {
    // Check if another Electron window still has focus (e.g., OAuth dialog, child window).
    // If so, the user hasn't actually left the app — skip blur transition.
    const electron = getElectronModule();
    if (electron) {
      const focusedWindow = electron.BrowserWindow.getFocusedWindow();
      if (focusedWindow !== null) {
        return; // Another Electron window has focus — not a real app blur
      }
    }
    scheduleBlurTransition(true, 'blur');
  });

  mainWindow.on('focus', () => {
    scheduleBlurTransition(false, 'focus');
  });

  isBlurInitialized = true;
  logger.info({ blurDebounceMs }, 'Blur scheduler initialized');
}

/**
 * Initialize the battery scheduler.
 * Must be called after app is ready (powerMonitor requires it).
 *
 * Unlike visibility scheduler, battery throttling still applies in headless mode
 * since headless automations on a laptop should conserve battery.
 */
export function initBatteryScheduler(): void {
  if (isBatteryInitialized) {
    logger.warn('Battery scheduler already initialized');
    return;
  }

  // Initialize from current state at startup (desktop-only)
  const electron = getElectronModule();
  if (electron) {
    isOnBattery = electron.powerMonitor.isOnBatteryPower();

    electron.powerMonitor.on('on-battery', () => {
      setBatteryState(true, 'on-battery');
    });

    electron.powerMonitor.on('on-ac', () => {
      setBatteryState(false, 'on-ac');
    });
  }
  logger.info({ isOnBattery }, 'Battery scheduler initialized');

  isBatteryInitialized = true;
}

/**
 * Update the battery state and notify all active battery intervals.
 * Unlike visibility, no catch-up tick on battery→AC transition.
 */
function setBatteryState(onBattery: boolean, source: string): void {
  if (isOnBattery === onBattery) return; // No change

  isOnBattery = onBattery;
  logger.info({ onBattery, source }, 'Battery state changed');

  // Reschedule all battery-throttled intervals at the new rate
  for (const interval of activeBatteryIntervals) {
    scheduleBatteryNextTick(interval);
  }
}

/**
 * Update the app hidden state and notify all active intervals.
 */
function setAppHidden(hidden: boolean, source: string): void {
  if (isHeadlessMode) return; // Never change state in headless mode

  if (isAppHidden === hidden) return; // No change

  const wasHidden = isAppHidden;
  isAppHidden = hidden;
  logger.debug({ hidden, source }, 'App visibility changed');

  // Cancel any pending stagger catch-ups when hiding (minimize takes precedence over blur catch-up)
  if (!wasHidden && hidden) {
    clearPendingStaggerTimeouts();
  }

  // Notify all active intervals to reschedule
  for (const interval of activeIntervals) {
    if (!wasHidden && hidden) {
      // Visible → Hidden: reschedule at background rate (or pause)
      interval.scheduleNext();
    } else if (wasHidden && !hidden) {
      // Hidden → Visible: catch-up tick + reschedule at foreground rate
      // Clear blur-affected state — visibility restore handles catch-up for all intervals
      interval.isBlurAffected = false;
      runCatchUpTick(interval);
    }
  }
}

/**
 * Update the app blur state and notify blur-aware intervals.
 * Independent from visibility (minimize) state.
 */
function setAppBlurred(blurred: boolean, source: string): void {
  if (isHeadlessMode) return;
  if (isAppBlurred === blurred) return;

  const wasBlurred = isAppBlurred;
  isAppBlurred = blurred;
  logger.debug({ blurred, source }, 'App blur state changed');

  for (const listener of [...blurListeners]) {
    try {
      listener(blurred);
    } catch (error) {
      logger.error({ error }, 'Blur state listener threw an error');
    }
  }

  if (!wasBlurred && blurred) {
    // Focused → Blurred: cancel any pending stagger catch-ups from a previous focus
    clearPendingStaggerTimeouts();

    // Reschedule blur-aware intervals
    for (const interval of activeIntervals) {
      if (!interval.blurOpts) continue;
      if (isAppHidden) continue; // Already handled by minimize
      interval.scheduleNext(); // Will pick up blur rate in scheduleNextTick
    }
  } else if (wasBlurred && !blurred) {
    // Blurred → Focused: staggered catch-up for blur-affected intervals
    runStaggeredBlurCatchUp();
  }
}

/**
 * Run staggered catch-up ticks for all blur-affected intervals on focus return.
 * Intervals are sorted by catchUpPriority (ascending = higher priority = earlier).
 * Priority 0 = immediate, priority N = delay of N × 1000ms.
 */
function runStaggeredBlurCatchUp(): void {
  const needsCatchUp = [...activeIntervals]
    .filter(i => i.isBlurAffected && !i.isDisposed)
    .sort((a, b) => (a.blurOpts?.catchUpPriority ?? 0) - (b.blurOpts?.catchUpPriority ?? 0));

  if (needsCatchUp.length > 0) {
    logger.debug({ count: needsCatchUp.length }, 'Running staggered blur catch-up');
  }

  for (const interval of needsCatchUp) {
    interval.isBlurAffected = false;
    const priority = interval.blurOpts?.catchUpPriority ?? 0;
    const delayMs = priority * 1000;

    if (delayMs === 0) {
      runCatchUpTick(interval);
    } else {
      const timeoutId = setTimeout(() => {
        pendingStaggerTimeouts.delete(timeoutId);
        if (!interval.isDisposed && !isAppBlurred && !isAppHidden) {
          runCatchUpTick(interval);
        }
      }, delayMs);
      pendingStaggerTimeouts.add(timeoutId);
    }
  }
}

function clearPendingStaggerTimeouts(): void {
  for (const id of pendingStaggerTimeouts) {
    clearTimeout(id);
  }
  pendingStaggerTimeouts.clear();
}

/**
 * Run an immediate "catch-up" tick when transitioning to visible.
 * This ensures data is refreshed immediately when the user returns.
 */
function runCatchUpTick(interval: ManagedInterval): void {
  // If currently running, skip catch-up (will pick up new rate on next tick)
  if (interval.isRunning) {
    interval.scheduleNext();
    return;
  }

  // Clear any pending timer
  if (interval.timerId !== null) {
    clearTimeout(interval.timerId);
    interval.timerId = null;
  }

  // Run catch-up tick immediately
  logger.debug('Running catch-up tick on visibility change');
  fireAndForget(runIntervalCallback(interval).then(() => {
    interval.scheduleNext();
  }), 'visibilityAwareScheduler.line436');
}

/**
 * Execute the interval callback with proper state tracking.
 */
async function runIntervalCallback(interval: ManagedInterval): Promise<void> {
  if (interval.isRunning) return; // Prevent overlapping executions

  interval.isRunning = true;
  try {
    await interval.callback();
  } catch (error) {
    logger.error({ error }, 'Interval callback threw an error');
  } finally {
    interval.isRunning = false;
  }
}

/**
 * Create a pausable interval that stops completely when the app is hidden.
 *
 * When the app becomes visible again, the callback is invoked immediately
 * (catch-up) before resuming the regular interval.
 *
 * @param callback Function to call on each tick
 * @param foregroundMs Interval in ms when app is visible
 * @param opts Optional blur-awareness options. When omitted, behavior is identical to before.
 * @returns Cleanup function to stop the interval
 *
 * @example
 * // Basic: pauses on minimize only (existing behavior)
 * const cleanup = createPausableInterval(() => { ... }, 5000);
 *
 * // Blur-aware: also pauses when app is blurred (e.g., user switches to Zoom)
 * const cleanup = createPausableInterval(() => { ... }, 5000, {
 *   pauseOnBlur: true,
 *   catchUpPriority: 2,
 * });
 */
export function createPausableInterval(
  callback: () => void | Promise<void>,
  foregroundMs: number,
  opts?: IntervalBlurOptions
): () => void {
  return createManagedInterval(callback, foregroundMs, null, opts);
}

/**
 * Create a throttled interval that runs at a slower rate when the app is hidden.
 *
 * When the app becomes visible again, the callback is invoked immediately
 * (catch-up) before resuming the regular foreground interval.
 *
 * @param callback Function to call on each tick
 * @param foregroundMs Interval in ms when app is visible
 * @param backgroundMs Interval in ms when app is hidden (minimized)
 * @param opts Optional blur-awareness options. When omitted, behavior is identical to before.
 * @returns Cleanup function to stop the interval
 *
 * @example
 * // Basic: throttles on minimize only (existing behavior)
 * const cleanup = createThrottledInterval(() => checkForUpdates(), 15 * 60_000, 60 * 60_000);
 *
 * // Blur-aware: also throttles when blurred
 * const cleanup = createThrottledInterval(() => syncCalendar(), 5 * 60_000, 15 * 60_000, {
 *   blurThrottleMs: 15 * 60_000,
 *   catchUpPriority: 2,
 * });
 */
export function createThrottledInterval(
  callback: () => void | Promise<void>,
  foregroundMs: number,
  backgroundMs: number,
  opts?: IntervalBlurOptions
): () => void {
  return createManagedInterval(callback, foregroundMs, backgroundMs, opts);
}

/**
 * Internal: Create a managed interval with the specified behavior.
 */
function createManagedInterval(
  callback: () => void | Promise<void>,
  foregroundMs: number,
  backgroundMs: number | null,
  blurOpts?: IntervalBlurOptions
): () => void {
  const interval: ManagedInterval = {
    callback,
    foregroundMs,
    backgroundMs,
    blurOpts,
    timerId: null,
    isRunning: false,
    isDisposed: false,
    isBlurAffected: false,
    scheduleNext: () => scheduleNextTick(interval),
  };

  // Register for visibility changes
  activeIntervals.add(interval);

  // Schedule first tick (don't run immediately like the renderer hook -
  // services typically initialize at startup when we don't need immediate data)
  scheduleNextTick(interval);

  // Return cleanup function
  return () => {
    interval.isDisposed = true; // Mark as disposed to prevent resurrection
    activeIntervals.delete(interval);
    if (interval.timerId !== null) {
      clearTimeout(interval.timerId);
      interval.timerId = null;
    }
  };
}

/**
 * Schedule the next tick based on current visibility and blur state.
 *
 * Priority order:
 * 1. Disposed → no-op
 * 2. Hidden (minimized) → backgroundMs (existing behavior, unchanged)
 * 3. Blurred with blur options → blur behavior (keep-alive > throttle > pause)
 * 4. Foreground → foregroundMs
 */
function scheduleNextTick(interval: ManagedInterval): void {
  // Guard: don't schedule if already disposed (prevents resurrection after cleanup)
  if (interval.isDisposed) {
    return;
  }

  // Clear any existing timer
  if (interval.timerId !== null) {
    clearTimeout(interval.timerId);
    interval.timerId = null;
  }

  // Determine the appropriate interval
  const effectiveHidden = isAppHidden && !isHeadlessMode;
  const effectiveBlurred = isAppBlurred && !isHeadlessMode;
  let ms: number | null;

  if (effectiveHidden) {
    // Minimized — use existing background behavior (unchanged)
    ms = interval.backgroundMs;
  } else if (effectiveBlurred && interval.blurOpts) {
    // Blurred (not minimized) with blur options
    const opts = interval.blurOpts;

    // shouldKeepAlive: errors are caught and treated as false (fail-open to blur behavior)
    let keepAlive = false;
    if (opts.shouldKeepAlive) {
      try {
        keepAlive = opts.shouldKeepAlive();
      } catch (error) {
        logger.warn({ error }, 'shouldKeepAlive threw — treating as false (fail-open to blur behavior)');
      }
    }

    if (keepAlive) {
      ms = interval.foregroundMs;
    } else if (opts.blurThrottleMs !== undefined) {
      ms = Math.max(1000, opts.blurThrottleMs);
      interval.isBlurAffected = true;
    } else if (opts.pauseOnBlur) {
      // Pause completely on blur
      ms = null;
      interval.isBlurAffected = true;
    } else {
      // Blur opts present but no pause/throttle configured
      ms = interval.foregroundMs;
    }
  } else {
    // Foreground (focused, or no blur opts)
    ms = interval.foregroundMs;
  }

  // If ms is null, we're in pause mode (hidden or blur-paused)
  if (ms === null) {
    logger.debug('Interval paused (app hidden or blur-paused)');
    return;
  }

  interval.timerId = setTimeout(() => {
    fireAndForget((async () => {
    await runIntervalCallback(interval);
    scheduleNextTick(interval);
    })(), 'visibilityScheduler.intervalTick');
  }, ms);
}

/**
 * Get current visibility state (for testing/debugging).
 */
export function getVisibilityState(): { isHidden: boolean; isHeadless: boolean } {
  return { isHidden: isAppHidden, isHeadless: isHeadlessMode };
}

/**
 * Returns whether the app is currently blurred (user switched to another app).
 * Independent from minimize state — an app can be blurred but not minimized.
 * Always returns false in headless mode.
 *
 * Intended for use by other services (e.g., GPU disposal in Stage 1).
 */
export function isAppCurrentlyBlurred(): boolean {
  return isAppBlurred && !isHeadlessMode;
}

/**
 * Subscribe to blur-state transitions.
 * Listener fires only on actual blur/focus state changes.
 */
export function onBlurStateChange(cb: BlurListener): () => void {
  blurListeners.add(cb);
  return () => {
    blurListeners.delete(cb);
  };
}

/**
 * Wait until the app regains focus, a timeout elapses, or the provided signal aborts.
 */
export function waitForFocus(
  signal?: AbortSignal,
  timeoutMs = 30 * 60 * 1000
): Promise<'focused' | 'timeout' | 'aborted'> {
  if (!isAppCurrentlyBlurred()) {
    return Promise.resolve('focused');
  }

  if (signal?.aborted) {
    return Promise.resolve('aborted');
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let onAbort: (() => void) | null = null;

    const cleanup = () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (onAbort) {
        signal?.removeEventListener('abort', onAbort);
      }
    };

    const settle = (result: 'focused' | 'timeout' | 'aborted') => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    onAbort = () => {
      settle('aborted');
    };

    unsubscribe = onBlurStateChange((isBlurred) => {
      if (!isBlurred) {
        settle('focused');
      }
    });

    timeoutId = setTimeout(() => {
      settle('timeout');
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });

    if (!isAppCurrentlyBlurred()) {
      settle('focused');
      return;
    }

    if (signal?.aborted) {
      settle('aborted');
    }
  });
}

/**
 * Get current blur state (for testing/debugging).
 */
export function getBlurState(): { isBlurred: boolean; isInitialized: boolean } {
  return { isBlurred: isAppBlurred, isInitialized: isBlurInitialized };
}

/**
 * Returns true when ANY agent turn (any category) is currently in flight in
 * the main process. Mirrors `agentTurnRegistry.hasAnyActiveTurn()`.
 *
 * Counterpart to `isAppCurrentlyBlurred()` for background-work scheduling
 * (e.g. Stage 6 indexer/embedder pause): the right primitive for "don't run
 * heavy background jobs while ANY turn anywhere is active" is the active-turn
 * count crossing zero, not blur state. The registry's `hasInteractiveTurn()`
 * variant — which excludes automation turns — may be the correct backing call
 * for some Stage 6 consumers; Stage 1 ships `hasAnyActiveTurn()` as the
 * conservative default and Stage 6 may revisit per-consumer.
 *
 * Plan reference: docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md Stage 1 (F4 + R2-2).
 */
export function isAnyTurnActive(): boolean {
  return agentTurnRegistry.hasAnyActiveTurn();
}

/**
 * Subscribe to turn-idle-state transitions. Listener fires when the active
 * turn count crosses zero in either direction (idle → busy or busy → idle).
 * Mirrors `onBlurStateChange` semantics — listeners persist across
 * transitions and must be removed via the returned unsubscribe function.
 *
 * Errors thrown by individual listeners are caught and logged inside the
 * registry so one bad listener cannot break the turn lifecycle.
 *
 * Plan reference: docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md Stage 1.
 */
export function onTurnIdleStateChange(listener: () => void): () => void {
  return agentTurnRegistry.subscribeTurnIdleStateChange(listener);
}

/**
 * Wait until all agent turns become idle, a timeout elapses, or the provided
 * signal aborts. Mirrors `waitForFocus` semantics — same watchdog/abort/cleanup
 * pattern, just keyed on the turn-idle signal instead of focus.
 *
 * Resolves immediately when no turn is active. Otherwise resolves on the next
 * idle transition, the configured timeout (default 30 minutes — same as
 * `waitForFocus` and the existing indexer max-pause watchdog), or signal
 * abort.
 *
 * Plan reference: docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md Stage 1.
 */
export function waitForTurnIdle(
  signal?: AbortSignal,
  timeoutMs = 30 * 60 * 1000,
): Promise<'idle' | 'timeout' | 'aborted'> {
  if (signal?.aborted) {
    return Promise.resolve('aborted');
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let onAbort: (() => void) | null = null;
    let observedBusyTransition = false;

    const cleanup = () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (onAbort) {
        signal?.removeEventListener('abort', onAbort);
      }
    };

    const settle = (result: 'idle' | 'timeout' | 'aborted') => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    onAbort = () => {
      settle('aborted');
    };

    unsubscribe = onTurnIdleStateChange(() => {
      if (isAnyTurnActive()) {
        observedBusyTransition = true;
      } else {
        settle('idle');
      }
    });

    timeoutId = setTimeout(() => {
      settle('timeout');
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });

    if (!isAnyTurnActive() && !observedBusyTransition) {
      settle('idle');
      return;
    }

    if (signal?.aborted) {
      settle('aborted');
    }
  });
}

// ============================================================================
// Stage 6 — `hasActiveTurn`-gated background-work latch with degraded mode
// ============================================================================
//
// Per-consumer state machine: `armed → paused → degraded → armed-after-clear`.
//
// - `armed`         — initial state. If the active-turn signal is true, the
//                     state listener transitions us to `paused`.
// - `paused`        — active-turn signal is true; consumer should defer work.
//                     Watchdog timer running; on fire we transition to
//                     `degraded`.
// - `degraded`      — watchdog fired while still paused. Consumer runs at full
//                     speed despite the active-turn signal still being set —
//                     fail-open behaviour to avoid permanent starvation from a
//                     leaked signal.
// - `armed-after-clear` — degraded mode cleared (the active-turn signal
//                     genuinely went false). Consumer is unlocked. The latch
//                     is sticky for the very next active-turn engagement: when
//                     the signal next goes true we transition straight to
//                     `armed` *without* pausing this engagement, so a
//                     transiently-leaked signal can't immediately reroute
//                     consumers back into pause-then-degraded oscillation. Any
//                     other transition also exits this state.
//
// Plan reference: docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md Stage 6 (F10, F15, R2-7).

export type BackgroundConsumerState =
  | 'armed'
  | 'paused'
  | 'degraded'
  | 'armed-after-clear';

export interface BackgroundConsumerLatchOptions {
  /**
   * Legacy max-pause watchdog setting (ms). The progress-based stuckness
   * threshold is clamped to `min(watchdogTimeoutMs, 5 minutes)`.
   */
  watchdogTimeoutMs?: number;
}

export type BackgroundConsumerDegradedReason = 'leaked_active_turn_signal' | 'stuck_active_turn_signal';
export type LatchWaitOutcome =
  | { outcome: 'resumed' }
  | { outcome: 'aborted' }
  | { outcome: 'degraded'; reason: BackgroundConsumerDegradedReason };
export type BackgroundConsumerWatchdogReason =
  | BackgroundConsumerDegradedReason
  | 'long_running_active_turn_signal';

export interface BackgroundConsumerWatchdogSignal {
  consumerId: string;
  reason: BackgroundConsumerWatchdogReason;
  observedAtMs: number;
  pauseDurationMs: number;
  turnIds: string[];
  stuckTurnId: string | null;
}

type BackgroundConsumerWatchdogSignalListener = (signal: BackgroundConsumerWatchdogSignal) => void;

const backgroundConsumerWatchdogSignalListeners = new Set<BackgroundConsumerWatchdogSignalListener>();

export function registerBackgroundConsumerWatchdogSignalListener(
  listener: BackgroundConsumerWatchdogSignalListener,
): () => void {
  backgroundConsumerWatchdogSignalListeners.add(listener);
  return () => {
    backgroundConsumerWatchdogSignalListeners.delete(listener);
  };
}

function emitBackgroundConsumerWatchdogSignal(signal: BackgroundConsumerWatchdogSignal): void {
  if (backgroundConsumerWatchdogSignalListeners.size === 0) {
    return;
  }
  for (const listener of [...backgroundConsumerWatchdogSignalListeners]) {
    try {
      listener(signal);
    } catch (error) {
      logger.error(
        { error, consumerId: signal.consumerId, reason: signal.reason },
        'Background consumer watchdog signal listener threw',
      );
    }
  }
}

export interface BackgroundConsumerLatch {
  readonly consumerId: string;
  /**
   * Returns true iff the consumer should defer work right now because of the
   * active-turn signal. False during `armed`, `degraded`, and
   * `armed-after-clear` — the gate is one-of-many: blur, etc., are checked
   * separately by the consumer.
   */
  shouldDeferForTurnActive(): boolean;
  /** Current state. Exposed for tests and structured logging. */
  getState(): BackgroundConsumerState;
  /** Snapshot of paused-since timestamp; null when not paused. */
  getPausedSinceMs(): number | null;
  /** Whether the latch is currently in degraded mode (watchdog fired). */
  isInDegradedMode(): boolean;
  /**
   * Resolve when state transitions out of `paused` or the abort signal fires.
   * Resolves with `{ outcome: 'resumed' }` on paused → armed (signal cleared),
   * `{ outcome: 'degraded', reason }` on paused → degraded (watchdog fired),
   * or `{ outcome: 'aborted' }` if the abort signal fires first. Resolves
   * immediately with `{ outcome: 'resumed' }` when called outside the `paused`
   * state — same fall-through semantics as `waitForFocus` when not blurred.
   */
  waitUntilResumeOrDegraded(signal?: AbortSignal): Promise<LatchWaitOutcome>;
  /** Cleanup. Idempotent. Cancels any pending watchdog and unsubscribes. */
  dispose(): void;
}

interface BackgroundConsumerLatchInternal extends BackgroundConsumerLatch {
  __test_simulateWatchdogFire(): void;
}

const DEFAULT_WATCHDOG_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_STUCK_PROGRESS_THRESHOLD_MS = 5 * 60 * 1000;

const activeBackgroundLatches = new Set<BackgroundConsumerLatchInternal>();

/**
 * Create a per-consumer background-work latch keyed off the active-turn
 * signal. Use one per long-running background loop (e.g. file indexer queue,
 * embedding batch worker). The latch automatically subscribes to
 * `agentTurnRegistry` turn-idle transitions for the duration of its life and
 * runs the state machine internally.
 *
 * The watchdog is progress-aware while paused: each check either
 * (a) enters degraded mode for real stuckness/leak signals, or
 * (b) logs long-running-with-progress activity and re-arms itself.
 *
 * Plan reference: docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md Stage 6.
 */
export function createBackgroundConsumerLatch(
  consumerId: string,
  options: BackgroundConsumerLatchOptions = {},
): BackgroundConsumerLatch {
  const watchdogTimeoutMs = options.watchdogTimeoutMs && options.watchdogTimeoutMs > 0
    ? options.watchdogTimeoutMs
    : DEFAULT_WATCHDOG_TIMEOUT_MS;
  const stuckThresholdMs = Math.min(watchdogTimeoutMs, DEFAULT_STUCK_PROGRESS_THRESHOLD_MS);

  const consumerLogger = createScopedLogger({ service: `visibilityAwareScheduler.${consumerId}` });

  let state: BackgroundConsumerState = 'armed';
  let pausedSinceMs: number | null = null;
  let watchdogTimerId: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeTurnIdle: (() => void) | null = null;
  let unsubscribePowerResume: (() => void) | null = null;
  let disposed = false;

  type TransitionWaitOutcome = Exclude<LatchWaitOutcome, { outcome: 'aborted' }>;
  type TransitionWaiter = (result: TransitionWaitOutcome) => void;
  const transitionWaiters = new Set<TransitionWaiter>();

  const cancelWatchdog = (): void => {
    if (watchdogTimerId !== null) {
      clearTimeout(watchdogTimerId);
      watchdogTimerId = null;
    }
  };

  const fireTransitionWaiters = (result: TransitionWaitOutcome): void => {
    if (transitionWaiters.size === 0) return;
    const snapshot = Array.from(transitionWaiters);
    transitionWaiters.clear();
    for (const waiter of snapshot) {
      try {
        waiter(result);
      } catch (error) {
        consumerLogger.error({ error }, 'Background consumer waiter threw');
      }
    }
  };

  const scheduleWatchdogCheck = (delayMs = stuckThresholdMs): void => {
    const safeDelayMs = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 1;
    cancelWatchdog();
    watchdogTimerId = setTimeout(onWatchdogFire, safeDelayMs);
  };

  const enterDegradedMode = (
    reason: BackgroundConsumerDegradedReason,
    message: string,
    context: Record<string, unknown>,
  ): void => {
    state = 'degraded';
    watchdogTimerId = null;
    consumerLogger.warn(
      {
        ...context,
        watchdogTimeoutMs,
        stuckThresholdMs,
        reason,
      },
      message,
    );
    fireTransitionWaiters({ outcome: 'degraded', reason });
  };

  function onWatchdogFire(): void {
    if (disposed) return;
    if (state !== 'paused') return;
    watchdogTimerId = null;
    const now = Date.now();
    const pauseDurationMs = pausedSinceMs !== null ? now - pausedSinceMs : 0;
    const turnIds = agentTurnRegistry.getActiveTurnIds();
    const turnSignalStillActive = agentTurnRegistry.hasAnyActiveTurn();

    if (!turnSignalStillActive) {
      emitBackgroundConsumerWatchdogSignal({
        consumerId,
        reason: 'leaked_active_turn_signal',
        observedAtMs: now,
        pauseDurationMs,
        turnIds,
        stuckTurnId: null,
      });
      enterDegradedMode(
        'leaked_active_turn_signal',
        'Indexer/embedder degraded mode entered: MEMORY LEAK DETECTED in active-turn pause latch',
        {
          turnIds,
          pauseDurationMs,
        },
      );
      return;
    }

    const activeTurnProgressSnapshot = agentTurnRegistry.getActiveTurnProgressSnapshot();
    const activeTurnProgressState = activeTurnProgressSnapshot.map(({ turnId, lastProgressAt }) => ({
      turnId,
      lastProgressAt,
      stalledMs: lastProgressAt === null ? null : now - lastProgressAt,
    }));

    if (activeTurnProgressState.length === 0) {
      emitBackgroundConsumerWatchdogSignal({
        consumerId,
        reason: 'stuck_active_turn_signal',
        observedAtMs: now,
        pauseDurationMs,
        turnIds,
        stuckTurnId: null,
      });
      enterDegradedMode(
        'stuck_active_turn_signal',
        'Indexer/embedder degraded mode entered: active-turn signal stuck with no recent progress',
        {
          turnIds,
          pauseDurationMs,
          activeTurnProgressSnapshot,
          stuckTurnId: null,
          stuckTurnIds: [],
          stuckTurnLastProgressAt: null,
          stuckTurnStalledMs: null,
          stuckTurnMissingProgress: true,
        },
      );
      return;
    }

    const stuckTurnCandidates = activeTurnProgressState.filter((entry) =>
      entry.lastProgressAt === null ||
      (entry.stalledMs !== null && entry.stalledMs >= stuckThresholdMs),
    );

    if (stuckTurnCandidates.length > 0) {
      const stuckTurn = stuckTurnCandidates.reduce((selected, current) => {
        if (selected.lastProgressAt === null && current.lastProgressAt !== null) return selected;
        if (selected.lastProgressAt !== null && current.lastProgressAt === null) return current;
        if (selected.stalledMs === null) return selected;
        if (current.stalledMs === null) return current;
        return current.stalledMs > selected.stalledMs ? current : selected;
      });

      emitBackgroundConsumerWatchdogSignal({
        consumerId,
        reason: 'stuck_active_turn_signal',
        observedAtMs: now,
        pauseDurationMs,
        turnIds,
        stuckTurnId: stuckTurn.turnId,
      });
      enterDegradedMode(
        'stuck_active_turn_signal',
        'Indexer/embedder degraded mode entered: active-turn signal stuck with no recent progress',
        {
          turnIds,
          pauseDurationMs,
          activeTurnProgressSnapshot,
          stuckTurnId: stuckTurn.turnId,
          stuckTurnIds: stuckTurnCandidates.map((entry) => entry.turnId),
          stuckTurnLastProgressAt: stuckTurn.lastProgressAt,
          stuckTurnStalledMs: stuckTurn.stalledMs,
          stuckTurnMissingProgress: stuckTurn.lastProgressAt === null,
        },
      );
      return;
    }

    const mostStalledTurn = activeTurnProgressState.reduce((selected, current) => {
      if (selected.stalledMs === null) return current;
      if (current.stalledMs === null) return selected;
      return current.stalledMs > selected.stalledMs ? current : selected;
    });
    const mostStalledTurnStalledMs = mostStalledTurn.stalledMs ?? 0;
    const nextCheckInMs = Math.max(1, (stuckThresholdMs - mostStalledTurnStalledMs) + 1);
    emitBackgroundConsumerWatchdogSignal({
      consumerId,
      reason: 'long_running_active_turn_signal',
      observedAtMs: now,
      pauseDurationMs,
      turnIds,
      stuckTurnId: mostStalledTurn.turnId,
    });
    consumerLogger.info(
      {
        turnIds,
        pauseDurationMs,
        activeTurnProgressSnapshot,
        mostStalledTurnId: mostStalledTurn.turnId,
        mostStalledTurnLastProgressAt: mostStalledTurn.lastProgressAt,
        mostStalledTurnStalledMs,
        nextCheckInMs,
        reason: 'long_running_active_turn_signal',
      },
      'Indexer/embedder active-turn signal remains active with recent progress; staying paused',
    );
    scheduleWatchdogCheck(nextCheckInMs);
  }

  const handleTurnIdleStateChange = (): void => {
    if (disposed) return;
    const turnActive = agentTurnRegistry.hasAnyActiveTurn();

    if (turnActive) {
      // Signal went false → true (engagement).
      switch (state) {
        case 'armed':
          state = 'paused';
          pausedSinceMs = Date.now();
          scheduleWatchdogCheck();
          break;
        case 'armed-after-clear':
          // Latch suppresses the pause for this engagement; transition to
          // armed without pausing. Subsequent engagements pause normally.
          state = 'armed';
          break;
        case 'paused':
        case 'degraded':
          // No-op — already handling this engagement.
          break;
      }
    } else {
      // Signal went true → false (clear).
      switch (state) {
        case 'paused': {
          const pauseDurationMs = pausedSinceMs !== null ? Date.now() - pausedSinceMs : 0;
          state = 'armed';
          pausedSinceMs = null;
          cancelWatchdog();
          consumerLogger.debug({ pauseDurationMs }, 'Background consumer resumed: active-turn signal cleared');
          fireTransitionWaiters({ outcome: 'resumed' });
          break;
        }
        case 'degraded': {
          const pauseDurationMs = pausedSinceMs !== null ? Date.now() - pausedSinceMs : 0;
          state = 'armed-after-clear';
          pausedSinceMs = null;
          consumerLogger.info(
            {
              pauseDurationMs,
              recoveryReason: 'signal_cleared_and_reengaged',
            },
            'Indexer/embedder degraded mode exited',
          );
          break;
        }
        case 'armed':
        case 'armed-after-clear':
          // No-op — already idle.
          break;
      }
    }
  };

  unsubscribeTurnIdle = onTurnIdleStateChange(handleTurnIdleStateChange);

  // Sleep/wake resilience: the watchdog computes `stalledMs = now - lastProgressAt`
  // with both sides on wall-clock `Date.now()`. After a laptop sleep/wake the wall
  // clock jumps forward by the entire sleep duration while `lastProgressAt` stays
  // frozen, so a healthy long-running turn would be spuriously classified
  // `stuck_active_turn_signal` on the first watchdog fire after wake. We cannot know
  // whether a turn actually stalled while the machine slept, so the safe default for
  // legitimate long activity is to re-baseline progress to "now" and grant a fresh
  // grace window rather than degrade. Mirrors the `powerMonitor` access pattern used
  // by the battery scheduler above; idempotent across multiple latches.
  //
  // Edge: a `resume` event arriving more often than `stuckThresholdMs` would keep
  // postponing stuck detection. That is not a realistic OS power-event cadence (wakes
  // are human-paced), and a genuine stall with no intervening resume still degrades,
  // so we accept it rather than rate-limit the grace window.
  const handlePowerResume = (): void => {
    if (disposed) return;
    if (state !== 'paused') return;
    const turnIds = agentTurnRegistry.getActiveTurnIds();
    // Re-baseline every active turn's progress timestamp so the sleep interval does
    // not count as stall time. `markTurnProgress` is wall-clock `Date.now()`; calling
    // it from each live latch is idempotent (they all rebaseline to the same "now").
    for (const turnId of turnIds) {
      agentTurnRegistry.markTurnProgress(turnId);
    }
    // Reset the pause anchor and reschedule a full grace window out so we don't fire
    // immediately on the stale timer with the inflated wall-clock delta.
    pausedSinceMs = Date.now();
    scheduleWatchdogCheck();
    consumerLogger.info(
      { turnIds, stuckThresholdMs },
      'Background consumer re-baselined active-turn progress after power resume; watchdog grace window reset',
    );
  };

  const electron = getElectronModule();
  if (electron?.powerMonitor) {
    const { powerMonitor } = electron;
    powerMonitor.on('resume', handlePowerResume);
    unsubscribePowerResume = (): void => {
      powerMonitor.removeListener('resume', handlePowerResume);
    };
  }

  // Initial probe — if the active-turn signal is already true at construction
  // time we want to start in `paused` so the consumer's first hot-loop check
  // observes it.
  if (agentTurnRegistry.hasAnyActiveTurn()) {
    state = 'paused';
    pausedSinceMs = Date.now();
    scheduleWatchdogCheck();
  }

  const latch: BackgroundConsumerLatchInternal = {
    consumerId,
    shouldDeferForTurnActive(): boolean {
      return state === 'paused';
    },
    getState(): BackgroundConsumerState {
      return state;
    },
    getPausedSinceMs(): number | null {
      return pausedSinceMs;
    },
    isInDegradedMode(): boolean {
      return state === 'degraded';
    },
    waitUntilResumeOrDegraded(signal?: AbortSignal): Promise<LatchWaitOutcome> {
      if (signal?.aborted) return Promise.resolve({ outcome: 'aborted' });
      if (state !== 'paused') return Promise.resolve({ outcome: 'resumed' });

      return new Promise((resolve) => {
        let settled = false;
        let onAbort: (() => void) | null = null;
        const waiter: TransitionWaiter = (result) => {
          if (settled) return;
          settled = true;
          if (onAbort) signal?.removeEventListener('abort', onAbort);
          transitionWaiters.delete(waiter);
          resolve(result);
        };
        transitionWaiters.add(waiter);

        if (signal) {
          onAbort = (): void => {
            if (settled) return;
            settled = true;
            transitionWaiters.delete(waiter);
            resolve({ outcome: 'aborted' });
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelWatchdog();
      if (unsubscribeTurnIdle) {
        unsubscribeTurnIdle();
        unsubscribeTurnIdle = null;
      }
      if (unsubscribePowerResume) {
        unsubscribePowerResume();
        unsubscribePowerResume = null;
      }
      // Settle any pending waiters so callers don't hang.
      fireTransitionWaiters({ outcome: 'resumed' });
      activeBackgroundLatches.delete(latch);
    },
    __test_simulateWatchdogFire(): void {
      onWatchdogFire();
    },
  };

  activeBackgroundLatches.add(latch);
  return latch;
}

/**
 * Reset all active background-consumer latches (for testing only).
 * @internal
 */
export function _resetBackgroundConsumerLatchesForTesting(): void {
  for (const latch of [...activeBackgroundLatches]) {
    latch.dispose();
  }
  activeBackgroundLatches.clear();
}

/**
 * Diagnostic snapshot of all live background-consumer latches. Stage 6 Phase 6
 * incident-triage observability — exposes per-consumer state, paused-since
 * timestamp, and degraded-mode flag without reaching into private state.
 *
 * Returned by copy; cheap (one entry per long-running background consumer
 * — currently 2: file-watcher indexer and embedding service).
 */
export interface BackgroundConsumerSnapshot {
  consumerId: string;
  state: BackgroundConsumerState;
  pausedSinceMs: number | null;
  isDegraded: boolean;
}

export function getBackgroundConsumerSnapshot(): BackgroundConsumerSnapshot[] {
  return [...activeBackgroundLatches].map((latch) => ({
    consumerId: latch.consumerId,
    state: latch.getState(),
    pausedSinceMs: latch.getPausedSinceMs(),
    isDegraded: latch.isInDegradedMode(),
  }));
}

/**
 * Force-fire the watchdog for a given latch (for testing only). Asserts the
 * latch is currently `paused`; callers should `expect(latch.getState()).toBe('paused')`
 * before invoking. The cast is internal-only and lives in this module.
 * @internal
 */
export function _simulateWatchdogFireForTesting(latch: BackgroundConsumerLatch): void {
  (latch as BackgroundConsumerLatchInternal).__test_simulateWatchdogFire();
}

/**
 * Create a battery-throttled interval that runs at a slower rate when on battery power.
 *
 * Unlike visibility throttling, there is NO catch-up tick when transitioning from
 * battery to AC power. The next scheduled tick is soon enough.
 *
 * Battery throttling applies in both normal and headless mode, since headless
 * automations on a laptop should still conserve battery.
 *
 * @param callback Function to call on each tick
 * @param normalMs Interval in ms when on AC power
 * @param batteryMs Interval in ms when on battery power
 * @returns Cleanup function to stop the interval
 *
 * @example
 * const cleanup = createBatteryThrottledInterval(
 *   () => syncCalendar(),
 *   15 * 60 * 1000, // 15 min on AC
 *   30 * 60 * 1000  // 30 min on battery
 * );
 */
export function createBatteryThrottledInterval(
  callback: () => void | Promise<void>,
  normalMs: number,
  batteryMs: number
): () => void {
  // Defensive guard: warn if battery scheduler not initialized (intervals will still work, just won't throttle)
  if (!isBatteryInitialized) {
    logger.warn('createBatteryThrottledInterval called before initBatteryScheduler() - interval will use AC rate until initialized');
  }

  const interval: BatteryManagedInterval = {
    callback,
    normalMs,
    batteryMs,
    timerId: null,
    isRunning: false,
    isDisposed: false,
    scheduleNext: () => scheduleBatteryNextTick(interval),
  };

  // Register for battery state changes
  activeBatteryIntervals.add(interval);

  // Schedule first tick (don't run immediately - matches visibility scheduler pattern)
  scheduleBatteryNextTick(interval);

  // Return cleanup function
  return () => {
    interval.isDisposed = true;
    activeBatteryIntervals.delete(interval);
    if (interval.timerId !== null) {
      clearTimeout(interval.timerId);
      interval.timerId = null;
    }
  };
}

/**
 * Schedule the next tick for a battery-throttled interval based on current battery state.
 */
function scheduleBatteryNextTick(interval: BatteryManagedInterval): void {
  // Guard: don't schedule if already disposed
  if (interval.isDisposed) {
    return;
  }

  // Clear any existing timer
  if (interval.timerId !== null) {
    clearTimeout(interval.timerId);
    interval.timerId = null;
  }

  // Determine the appropriate interval based on battery state
  const ms = isOnBattery ? interval.batteryMs : interval.normalMs;

  interval.timerId = setTimeout(() => {
    fireAndForget((async () => {
    await runBatteryIntervalCallback(interval);
    scheduleBatteryNextTick(interval);
    })(), 'visibilityScheduler.batteryIntervalTick');
  }, ms);
}

/**
 * Execute the battery interval callback with proper state tracking.
 */
async function runBatteryIntervalCallback(interval: BatteryManagedInterval): Promise<void> {
  if (interval.isRunning) return; // Prevent overlapping executions

  interval.isRunning = true;
  try {
    await interval.callback();
  } catch (error) {
    logger.error({ error }, 'Battery interval callback threw an error');
  } finally {
    interval.isRunning = false;
  }
}

/**
 * Reset visibility and blur scheduler state (for testing only).
 * @internal
 */
export function _resetForTesting(): void {
  isAppHidden = false;
  isVisibilityInitialized = false;
  isHeadlessMode = false;
  isAppBlurred = false;
  isBlurInitialized = false;
  blurListeners.clear();
  clearPendingStaggerTimeouts();
  if (pendingBlurTransition) {
    clearTimeout(pendingBlurTransition.timeoutId);
    pendingBlurTransition = null;
  }
  // Debounce is off-by-default in tests so existing suites that synthesize
  // OS blur/focus events via `initBlurScheduler`'s window handlers observe
  // immediate transitions. Stage 3 debounce tests opt in via
  // `_setBlurDebounceMsForTesting(300)` explicitly.
  blurDebounceMs = 0;
  for (const interval of activeIntervals) {
    if (interval.timerId !== null) {
      clearTimeout(interval.timerId);
    }
  }
  activeIntervals.clear();
  for (const latch of [...activeBackgroundLatches]) {
    latch.dispose();
  }
  activeBackgroundLatches.clear();
}

/**
 * Simulate blur/focus state changes for testing.
 * @internal
 */
export function _setBlurredForTesting(blurred: boolean): void {
  setAppBlurred(blurred, 'test');
}

/**
 * Simulate an OS-driven blur/focus transition for testing the debounce path.
 * This is the path the real OS event listeners use; subject to the 300 ms
 * debounce. Use `_setBlurredForTesting` for immediate (non-debounced) effect.
 * @internal
 */
export function _scheduleBlurTransitionForTesting(target: boolean, source = 'test-os'): void {
  scheduleBlurTransition(target, source);
}

/**
 * Override the blur debounce window for testing. Passing 0 applies blur
 * transitions synchronously (useful when a test wants the OS-event path
 * without the timer wait). Reset on `_resetForTesting`.
 * @internal
 */
export function _setBlurDebounceMsForTesting(ms: number): void {
  blurDebounceMs = ms;
}

/**
 * Simulate visibility state changes for testing.
 * @internal
 */
export function _setHiddenForTesting(hidden: boolean): void {
  setAppHidden(hidden, 'test');
}

/**
 * Set headless mode for testing.
 * @internal
 */
export function _setHeadlessModeForTesting(headless: boolean): void {
  isHeadlessMode = headless;
}
