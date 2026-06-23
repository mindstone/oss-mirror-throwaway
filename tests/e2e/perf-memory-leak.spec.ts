/**
 * Memory Leak Detection — E2E Performance Test
 *
 * Detects memory leaks by looping a core user journey N times with forced
 * garbage collection, then asserting heap growth is within bounds.
 *
 * This test is near-deterministic (4/5) after forced GC. Catches structural
 * leaks (detached DOM nodes, retained closures, growing caches) that
 * accumulate over time during normal navigation.
 *
 * Threshold: 10MB heap growth after 5 iterations (intentionally generous;
 * tighten after collecting baseline data over 2-4 weeks).
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
import { launchForPerfTest } from './perf-test-utils';

test.skip(!appExists(), getAppNotFoundMessage());

let electronApp: ElectronApplication;
let window: Page;
let cleanup: () => void;
let userDataPath: string;

/** Number of journey iterations for the leak test. */
const ITERATION_COUNT = 5;

/** Maximum allowed heap growth in bytes (10MB). */
const MAX_HEAP_GROWTH_BYTES = 10 * 1024 * 1024;

/**
 * Run a single core navigation journey:
 * 1. Click new chat → wait for interaction strip
 * 2. Navigate to settings → wait for settings panel
 * 3. Navigate to automations → wait for automations panel
 * 4. Navigate back home (click brand-home)
 */
async function runCoreJourney(page: Page, label: string): Promise<void> {
  // Step 1: New chat
  const newChatButton = page.locator('[data-testid="new-chat-button"]');
  await expect(newChatButton).toBeVisible({ timeout: 10000 });
  await newChatButton.click();
  const interactionStrip = page.locator('[data-testid="interaction-strip"]');
  await expect(interactionStrip).toBeVisible({ timeout: 10000 });

  // Step 2: Settings tab
  const settingsTab = page.locator('#flow-tab-settings');
  await expect(settingsTab).toBeVisible({ timeout: 5000 });
  await settingsTab.click();
  const settingsPanel = page.locator('[data-testid="settings-panel"]');
  await expect(settingsPanel).toBeVisible({ timeout: 5000 });

  // Step 3: Automations tab
  const automationsTab = page.locator('#flow-tab-automations');
  await expect(automationsTab).toBeVisible({ timeout: 5000 });
  await automationsTab.click();
  const automationsPanel = page.locator('[data-testid="automations-panel"]');
  await expect(automationsPanel).toBeVisible({ timeout: 5000 });

  // Step 4: Navigate back home
  const brandHome = page.locator('[data-testid="brand-home"]');
  await expect(brandHome).toBeVisible({ timeout: 5000 });
  await brandHome.click();

  // Brief settle time for async cleanup between iterations
  await page.waitForTimeout(500);

  console.log(`[PERF-MEMORY] Journey "${label}" complete`);
}

/**
 * Force GC in the main process and return heapUsed.
 *
 * Requires `--js-flags=--expose-gc` launch flag.
 */
async function forceGCAndMeasureHeap(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (global as any).gc === 'function') (global as any).gc();
    return process.memoryUsage().heapUsed;
  });
}

test.describe('Memory Leak Detection', () => {
  test.describe.configure({ timeout: 300_000 }); // 5 minutes

  test.beforeAll(async () => {
    console.log('[PERF-MEMORY] ========== TEST SUITE START ==========');
    const startTime = Date.now();

    const result = await launchForPerfTest('perf-memory-leak', {
      additionalArgs: ['--js-flags=--expose-gc'],
    });
    electronApp = result.electronApp;
    cleanup = result.cleanup;
    userDataPath = result.userDataPath;

    window = await getFirstWindow(electronApp);
    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);

    // Verify app is ready
    await expect(window.locator('[data-testid="brand-home"]')).toBeVisible({ timeout: 15000 });
    await expect(window.locator('[id^="flow-tab-"]').first()).toBeVisible({ timeout: 15000 });

    console.log(`[PERF-MEMORY] App launched and ready in ${Date.now() - startTime}ms`);
  });

  test.afterAll(async () => {
    console.log('[PERF-MEMORY] ========== TEST SUITE END ==========');
    await safeCloseApp(electronApp, 15000, userDataPath);
    if (!process.env.REBEL_E2E_KEEP_USER_DATA) {
      cleanup?.();
    }
  });

  test('main process heap growth stays within bounds after repeated navigation', async () => {
    // ========================================================================
    // Step 0: Verify global.gc is available (hard-fail if not)
    // ========================================================================
    const hasGC = await electronApp.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => typeof (global as any).gc === 'function'
    );
    expect(hasGC, '--js-flags=--expose-gc must make global.gc available').toBe(true);
    console.log('[PERF-MEMORY] global.gc is available ✓');

    // ========================================================================
    // Step 1: Warm-up iteration (JIT compilation artifacts, lazy init)
    // ========================================================================
    console.log('[PERF-MEMORY] Running warm-up iteration...');
    await runCoreJourney(window, 'warm-up');

    // ========================================================================
    // Step 2: Force GC and measure baseline heap
    // ========================================================================
    const baselineHeap = await forceGCAndMeasureHeap(electronApp);
    console.log(`[PERF-MEMORY] Baseline heap (post-GC): ${(baselineHeap / 1024 / 1024).toFixed(2)}MB`);

    // Also capture renderer baseline if available
    const rendererBaseline = await window.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (performance as any).memory?.usedJSHeapSize as number | undefined;
    });
    if (rendererBaseline != null) {
      console.log(`[PERF-MEMORY] Renderer baseline heap: ${(rendererBaseline / 1024 / 1024).toFixed(2)}MB`);
    }

    // ========================================================================
    // Step 3: Run N iterations of the core journey
    // ========================================================================
    for (let i = 1; i <= ITERATION_COUNT; i++) {
      console.log(`[PERF-MEMORY] Iteration ${i}/${ITERATION_COUNT}...`);
      await runCoreJourney(window, `iteration-${i}`);
    }

    // ========================================================================
    // Step 4: Force GC and measure final heap
    // ========================================================================
    const finalHeap = await forceGCAndMeasureHeap(electronApp);
    const heapGrowth = finalHeap - baselineHeap;
    const heapGrowthMB = heapGrowth / 1024 / 1024;

    console.log(`[PERF-MEMORY] Final heap (post-GC): ${(finalHeap / 1024 / 1024).toFixed(2)}MB`);
    console.log(`[PERF-MEMORY] Heap growth: ${heapGrowthMB.toFixed(2)}MB after ${ITERATION_COUNT} iterations`);

    // Also capture renderer final heap if available
    const rendererFinal = await window.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (performance as any).memory?.usedJSHeapSize as number | undefined;
    });
    if (rendererFinal != null && rendererBaseline != null) {
      const rendererGrowthMB = (rendererFinal - rendererBaseline) / 1024 / 1024;
      console.log(`[PERF-MEMORY] Renderer heap final: ${(rendererFinal / 1024 / 1024).toFixed(2)}MB`);
      console.log(`[PERF-MEMORY] Renderer heap growth: ${rendererGrowthMB.toFixed(2)}MB after ${ITERATION_COUNT} iterations`);
    } else {
      console.log('[PERF-MEMORY] Renderer performance.memory not available (Chromium-only API)');
    }

    // ========================================================================
    // Step 5: Assert heap growth is within bounds
    // ========================================================================
    expect(
      heapGrowth,
      `Main process heap grew ${heapGrowthMB.toFixed(2)}MB after ${ITERATION_COUNT} iterations (limit: ${MAX_HEAP_GROWTH_BYTES / 1024 / 1024}MB)`
    ).toBeLessThan(MAX_HEAP_GROWTH_BYTES);

    console.log(`[PERF-MEMORY] ✓ Heap growth ${heapGrowthMB.toFixed(2)}MB is within ${MAX_HEAP_GROWTH_BYTES / 1024 / 1024}MB limit`);
  });
});
