/**
 * Performance test utilities for E2E regression detection.
 *
 * Shared helpers for all perf-*.spec.ts tests. These wrap existing E2E utilities
 * with performance-specific defaults (e.g., `REBEL_E2E_PERF_MODE=1` env var,
 * CDP Performance domain enabling, PerformanceObserver injection).
 *
 * @see docs/plans/260328_perf_regression_tests.md — Full planning doc
 * @see tests/e2e/test-utils.ts — Base E2E utilities
 */

import type { Page, BrowserContext } from '@playwright/test';
import { launchIsolatedApp, type LaunchOptions } from './test-utils';

/**
 * CDP session type, inferred from the Playwright BrowserContext API to avoid
 * version mismatches between top-level `playwright-core` and the copy nested
 * inside `@playwright/test`.
 */
type CDPSession = Awaited<ReturnType<BrowserContext['newCDPSession']>>;

// =============================================================================
// Type Definitions
// =============================================================================

/** Options for launching an app in performance test mode. */
export interface PerfLaunchOptions {
  /** Additional command-line arguments (e.g., `--js-flags=--expose-gc`). */
  additionalArgs?: string[];
  /** Additional environment variables (merged with perf defaults). */
  additionalEnv?: Record<string, string>;
  /** Whether to skip onboarding. Defaults to true. */
  skipOnboarding?: boolean;
}

/** A subset of CDP `Performance.getMetrics` result relevant to perf tests. */
export interface CDPMetricsSnapshot {
  /** Total number of full or partial page layout operations. */
  LayoutCount: number;
  /** Total number of times the style engine recalculated element styles. */
  RecalcStyleCount: number;
  /** Total number of DOM node insertions into the document. */
  Nodes: number;
  /** Total number of frames rendered by the compositor. */
  FrameCount: number;
  /** Total JavaScript execution duration (seconds). */
  TaskDuration: number;
  /** Total layout duration (seconds). */
  LayoutDuration: number;
  /** Total style recalculation duration (seconds). */
  RecalcStyleDuration: number;
  /** Raw timestamp from CDP. */
  Timestamp: number;
}

/** Delta between two CDP metric snapshots (after - before). */
export interface CDPMetricsDelta {
  LayoutCount: number;
  RecalcStyleCount: number;
  Nodes: number;
  FrameCount: number;
  TaskDuration: number;
  LayoutDuration: number;
  RecalcStyleDuration: number;
}

/** A long task entry captured by the PerformanceObserver in the renderer. */
export interface LongTaskEntry {
  /** Task name (usually "self" for same-origin tasks). */
  name: string;
  /** Duration in milliseconds. */
  duration: number;
  /** Start time relative to navigation start. */
  startTime: number;
}

// =============================================================================
// App Launching
// =============================================================================

/**
 * Launch the Electron app in performance test mode.
 *
 * Wraps `launchIsolatedApp` with `REBEL_E2E_PERF_MODE=1` set in the
 * environment. This flag gates perf-only instrumentation (e.g., IPC payload
 * size tracking) so it doesn't affect regular E2E tests.
 *
 * @param testName - Test name for isolated userData directory naming
 * @param options - Additional launch options (args, env vars)
 * @returns The same shape as `launchIsolatedApp`: electronApp, cleanup, userDataPath
 */
export async function launchForPerfTest(
  testName: string,
  options: PerfLaunchOptions = {}
): Promise<ReturnType<typeof launchIsolatedApp> extends Promise<infer R> ? R : never> {
  const {
    additionalArgs = [],
    additionalEnv = {},
    skipOnboarding = true
  } = options;

  const launchOptions: LaunchOptions = {
    additionalArgs,
    additionalEnv: {
      REBEL_E2E_PERF_MODE: '1',
      ...additionalEnv
    },
    skipOnboarding
  };

  return launchIsolatedApp(testName, launchOptions);
}

// =============================================================================
// CDP (Chrome DevTools Protocol) Helpers
// =============================================================================

/**
 * Create a CDP session for the given page with `Performance.enable` called.
 *
 * The CDP Performance domain provides deterministic structural metrics
 * (LayoutCount, RecalcStyleCount) that are environment-agnostic — ideal
 * for blocking CI gates.
 *
 * @param page - Playwright Page object for the Electron renderer window
 * @returns CDP session with Performance domain enabled
 */
export async function createCDPSession(page: Page): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  return session;
}

/**
 * Get a snapshot of current CDP Performance metrics.
 *
 * Maps the raw CDP array-of-objects response into a typed record for
 * easier consumption in test assertions.
 *
 * @param session - CDP session with Performance domain enabled
 * @returns Typed metrics snapshot
 */
export async function getCDPMetrics(session: CDPSession): Promise<CDPMetricsSnapshot> {
  const result = await session.send('Performance.getMetrics');
  const metrics = result.metrics;

  const getValue = (name: string): number => {
    const entry = metrics.find((m: { name: string; value: number }) => m.name === name);
    return entry?.value ?? 0;
  };

  return {
    LayoutCount: getValue('LayoutCount'),
    RecalcStyleCount: getValue('RecalcStyleCount'),
    Nodes: getValue('Nodes'),
    FrameCount: getValue('FrameCount'),
    TaskDuration: getValue('TaskDuration'),
    LayoutDuration: getValue('LayoutDuration'),
    RecalcStyleDuration: getValue('RecalcStyleDuration'),
    Timestamp: getValue('Timestamp')
  };
}

/**
 * Measure the CDP metric delta across an action.
 *
 * Takes a snapshot before the action, runs the action, waits for a brief
 * settling period (async layouts), then takes a snapshot after. Returns
 * the delta of structural metrics.
 *
 * @param session - CDP session with Performance domain enabled
 * @param action - Async function that performs the UI action to measure
 * @param settleMs - Time to wait after the action for async layout (default: 500ms)
 * @returns Delta of key metrics (after - before)
 */
export async function measureCDPDelta(
  session: CDPSession,
  action: () => Promise<void>,
  settleMs = 500
): Promise<CDPMetricsDelta> {
  const before = await getCDPMetrics(session);
  await action();
  // Allow async layouts/style recalcs to settle
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const after = await getCDPMetrics(session);

  return {
    LayoutCount: after.LayoutCount - before.LayoutCount,
    RecalcStyleCount: after.RecalcStyleCount - before.RecalcStyleCount,
    Nodes: after.Nodes - before.Nodes,
    FrameCount: after.FrameCount - before.FrameCount,
    TaskDuration: after.TaskDuration - before.TaskDuration,
    LayoutDuration: after.LayoutDuration - before.LayoutDuration,
    RecalcStyleDuration: after.RecalcStyleDuration - before.RecalcStyleDuration
  };
}

// =============================================================================
// Long Task Observer (Renderer)
// =============================================================================

/**
 * Inject a PerformanceObserver for `longtask` entries into the renderer.
 *
 * Collected entries are stored on `window.__e2e_longtasks` so they can be
 * retrieved later via `getLongTasks()`.
 *
 * Must be called BEFORE the actions you want to measure — the observer
 * only captures tasks that occur after injection.
 *
 * @param page - Playwright Page object for the Electron renderer window
 */
export async function injectLongTaskObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Reset any previous collection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__e2e_longtasks = [];

    // Guard against environments where longtask observer is unsupported
    // (matches pattern from src/renderer/hooks/useDevPerformanceMonitor.ts)
    if (typeof PerformanceObserver === 'undefined') return;

    try {
      const observer = new PerformanceObserver((list) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tasks = (window as any).__e2e_longtasks as Array<{
          name: string;
          duration: number;
          startTime: number;
        }>;
        for (const entry of list.getEntries()) {
          tasks.push({
            name: entry.name,
            duration: entry.duration,
            startTime: entry.startTime
          });
        }
      });

      observer.observe({ type: 'longtask', buffered: true });
      // Store observer ref so it can be disconnected if needed
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__e2e_longtask_observer = observer;
    } catch {
      // longtask entry type not supported in this environment
    }
  });
}

/**
 * Retrieve collected long tasks from the renderer.
 *
 * Returns the entries accumulated by the PerformanceObserver injected via
 * `injectLongTaskObserver()`. Returns an empty array if the observer was
 * never injected.
 *
 * @param page - Playwright Page object for the Electron renderer window
 * @returns Array of long task entries
 */
export async function getLongTasks(page: Page): Promise<LongTaskEntry[]> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tasks = (window as any).__e2e_longtasks;
    if (!Array.isArray(tasks)) return [];
    return tasks as Array<{ name: string; duration: number; startTime: number }>;
  });
}

// =============================================================================
// Startup Time Measurement
// =============================================================================

/**
 * Measure how long a launch function takes to execute.
 *
 * Wraps any async launch function with `Date.now()` timing. Use this to
 * measure startup time (launch → first window ready).
 *
 * @param launchFn - Async function that launches the app and waits for readiness
 * @returns Object with elapsed time in ms and the launch function's return value
 */
export async function measureStartupTime<T>(
  launchFn: () => Promise<T>
): Promise<{ elapsedMs: number; result: T }> {
  const start = Date.now();
  const result = await launchFn();
  const elapsedMs = Date.now() - start;
  return { elapsedMs, result };
}
