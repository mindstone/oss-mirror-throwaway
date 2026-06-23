/**
 * Warn-Only Timing Signals — E2E Performance Test
 *
 * Measures startup time and long task count during core UI flows.
 * Both metrics are **informational only** — they NEVER fail the test.
 *
 * Timing metrics have 30-50% variance on CI shared runners. Blocking on
 * them causes severe alert fatigue and will be disabled within weeks.
 * These signals catch dramatic regressions via structured log output
 * that can be parsed for trend tracking.
 *
 * Structured log output:
 * - `[PERF-STARTUP] <ms>ms` — startup time
 * - `[PERF-LONGTASKS] <count> tasks > 150ms, max=<ms>ms` — long task summary
 *
 * @see docs/plans/260328_perf_regression_tests.md — Full planning doc
 * @see tests/e2e/perf-test-utils.ts — Shared perf helpers
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  appExists,
  enableGuestMode,
  getAppNotFoundMessage,
  getFirstWindow,
  safeCloseApp,
  waitForMainAppReady,
} from './test-utils';
import {
  getLongTasks,
  injectLongTaskObserver,
  launchForPerfTest,
  measureStartupTime,
} from './perf-test-utils';

test.skip(!appExists(), getAppNotFoundMessage());

let electronApp: ElectronApplication;
let window: Page;
let cleanup: () => void;
let userDataPath: string;

test.describe('Warn-Only Timing Signals', () => {
  test.describe.configure({ timeout: 300_000 }); // 5 minutes

  test.beforeAll(async () => {
    console.log('[PERF-TIMING] ========== TEST SUITE START ==========');
  });

  test.afterAll(async () => {
    console.log('[PERF-TIMING] ========== TEST SUITE END ==========');
    await safeCloseApp(electronApp, 15000, userDataPath);
    if (!process.env.REBEL_E2E_KEEP_USER_DATA) {
      cleanup?.();
    }
  });

  test('measure startup time (warn-only)', async () => {
    // ========================================================================
    // Measure startup time: launch → guest mode → app ready
    // ========================================================================
    const { elapsedMs, result } = await measureStartupTime(async () => {
      const launchResult = await launchForPerfTest('perf-timing-signals');
      electronApp = launchResult.electronApp;
      cleanup = launchResult.cleanup;
      userDataPath = launchResult.userDataPath;

      window = await getFirstWindow(electronApp);
      await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
      await enableGuestMode(window);
      await waitForMainAppReady(window);

      // Verify app is ready
      await expect(window.locator('[data-testid="brand-home"]')).toBeVisible({ timeout: 15000 });
      await expect(window.locator('[id^="flow-tab-"]').first()).toBeVisible({ timeout: 15000 });

      return launchResult;
    });

    // Log startup time in structured format for CI parsing
    console.log(`[PERF-STARTUP] ${elapsedMs}ms`);

    // Warn thresholds (NEVER assert — informational only)
    const isCI = !!process.env.CI;
    // CONTRACT: the E2E startup safety-abort timeout (STARTUP_PROBE_TIMEOUT_MS
    // in test-utils.ts) must stay STRICTLY ABOVE this CI budget — enforced by
    // scripts/check-e2e-startup-safety-budget.ts (validate:fast).
    const warnThreshold = isCI ? 6000 : 3000;
    if (elapsedMs > warnThreshold) {
      console.log(`[PERF-STARTUP-WARN] Startup took ${elapsedMs}ms (threshold: ${warnThreshold}ms, env: ${isCI ? 'CI' : 'local'})`);
    } else {
      console.log(`[PERF-STARTUP] ✓ Within threshold (${elapsedMs}ms < ${warnThreshold}ms, env: ${isCI ? 'CI' : 'local'})`);
    }

    // Stash result to suppress unused variable
    void result;

    // NO expect() on timing — this is warn-only
  });

  test('count long tasks during core flows (warn-only)', async () => {
    // Inject the PerformanceObserver BEFORE running flows
    await injectLongTaskObserver(window);
    console.log('[PERF-LONGTASKS] Long task observer injected');

    // ========================================================================
    // Run through key UI flows (same actions as CDP structural test)
    // ========================================================================

    // Flow 1: Open new chat
    console.log('[PERF-LONGTASKS] Flow 1: New chat');
    const newChatButton = window.locator('[data-testid="new-chat-button"]');
    await expect(newChatButton).toBeVisible({ timeout: 10000 });
    await newChatButton.click();
    const interactionStrip = window.locator('[data-testid="interaction-strip"]');
    await expect(interactionStrip).toBeVisible({ timeout: 10000 });

    // Flow 2: Open settings panel
    console.log('[PERF-LONGTASKS] Flow 2: Settings panel');
    const settingsTab = window.locator('#flow-tab-settings');
    await expect(settingsTab).toBeVisible({ timeout: 5000 });
    await settingsTab.click();
    const settingsPanel = window.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible({ timeout: 5000 });

    // Flow 3: Open connectors panel
    console.log('[PERF-LONGTASKS] Flow 3: Connectors panel');
    const connectorsTab = window.locator('[data-testid="settings-tab-connectors"]');
    await expect(connectorsTab).toBeVisible({ timeout: 5000 });
    await connectorsTab.click();
    const connectorsPanel = window.locator('[data-testid="connectors-panel"]');
    await expect(connectorsPanel).toBeVisible({ timeout: 10000 });

    // Flow 4: Open automations panel
    console.log('[PERF-LONGTASKS] Flow 4: Automations panel');
    const automationsTab = window.locator('#flow-tab-automations');
    await expect(automationsTab).toBeVisible({ timeout: 5000 });
    await automationsTab.click();
    const automationsPanel = window.locator('[data-testid="automations-panel"]');
    await expect(automationsPanel).toBeVisible({ timeout: 5000 });

    // Brief settle time for any remaining async tasks
    await window.waitForTimeout(1000);

    // ========================================================================
    // Collect and analyze long tasks
    // ========================================================================
    const allTasks = await getLongTasks(window);

    // Filter to tasks >150ms (ignore Playwright-induced noise below this)
    const significantTasks = allTasks.filter((t) => t.duration > 150);
    const maxDuration = significantTasks.length > 0
      ? Math.max(...significantTasks.map((t) => t.duration))
      : 0;

    // Log in structured format for CI parsing
    console.log(`[PERF-LONGTASKS] ${significantTasks.length} tasks > 150ms, max=${Math.round(maxDuration)}ms`);

    // Log individual significant tasks for debugging
    if (significantTasks.length > 0) {
      console.log('[PERF-LONGTASKS] Significant tasks:');
      for (const task of significantTasks) {
        console.log(`[PERF-LONGTASKS]   ${task.name}: ${Math.round(task.duration)}ms at ${Math.round(task.startTime)}ms`);
      }
    }

    // Also log total long task count (including <150ms)
    console.log(`[PERF-LONGTASKS] Total long tasks observed (all durations): ${allTasks.length}`);

    // Warn threshold (NEVER assert — informational only)
    if (significantTasks.length > 5) {
      console.log(`[PERF-LONGTASKS-WARN] ${significantTasks.length} tasks > 150ms exceeds advisory threshold of 5`);
    } else {
      console.log(`[PERF-LONGTASKS] ✓ ${significantTasks.length} tasks > 150ms (advisory threshold: 5)`);
    }

    // NO expect() on count or duration — this is warn-only
  });
});
