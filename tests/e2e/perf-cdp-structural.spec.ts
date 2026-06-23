/**
 * CDP Structural Metrics — E2E Performance Test (OBSERVATION-ONLY)
 *
 * Measures LayoutCount and RecalcStyleCount deltas per UI action using the
 * Chrome DevTools Protocol (CDP) Performance domain. These are deterministic
 * structural metrics (5/5) — they depend on code, not CPU speed.
 *
 * **OBSERVATION-ONLY on first merge.** CDP LayoutCount/RecalcStyleCount have
 * not been verified to work in this Electron + Playwright setup. This test:
 * 1. Logs actual counts per action (no assertions)
 * 2. Verifies CDP `Performance.getMetrics` returns non-zero LayoutCount
 * 3. If verified: set budgets at 2x observed values in a follow-up PR
 * 4. If unavailable: document and remove Stage 4
 *
 * @see docs/plans/260328_perf_regression_tests.md — Full planning doc
 * @see tests/e2e/perf-test-utils.ts — Shared perf helpers (createCDPSession, measureCDPDelta)
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
  createCDPSession,
  launchForPerfTest,
  measureCDPDelta,
  type CDPMetricsDelta,
} from './perf-test-utils';

test.skip(!appExists(), getAppNotFoundMessage());

let electronApp: ElectronApplication;
let window: Page;
let cleanup: () => void;
let userDataPath: string;

test.describe('CDP Structural Metrics (Observation-Only)', () => {
  test.describe.configure({ timeout: 300_000 }); // 5 minutes

  test.beforeAll(async () => {
    console.log('[PERF-CDP] ========== TEST SUITE START ==========');
    const startTime = Date.now();

    const result = await launchForPerfTest('perf-cdp-structural');
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

    console.log(`[PERF-CDP] App launched and ready in ${Date.now() - startTime}ms`);
  });

  test.afterAll(async () => {
    console.log('[PERF-CDP] ========== TEST SUITE END ==========');
    await safeCloseApp(electronApp, 15000, userDataPath);
    if (!process.env.REBEL_E2E_KEEP_USER_DATA) {
      cleanup?.();
    }
  });

  test('observe LayoutCount and RecalcStyleCount deltas per action', async () => {
    const cdpSession = await createCDPSession(window);

    // Collect deltas for summary logging at the end
    const results: Array<{ action: string; delta: CDPMetricsDelta }> = [];

    // ========================================================================
    // Action 1: Open new chat
    // ========================================================================
    const newChatDelta = await measureCDPDelta(cdpSession, async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await expect(newChatButton).toBeVisible({ timeout: 10000 });
      await newChatButton.click();
      const interactionStrip = window.locator('[data-testid="interaction-strip"]');
      await expect(interactionStrip).toBeVisible({ timeout: 10000 });
    });
    results.push({ action: 'Open new chat', delta: newChatDelta });
    console.log(`[PERF-CDP] Open new chat: LayoutCount=${newChatDelta.LayoutCount}, RecalcStyleCount=${newChatDelta.RecalcStyleCount}`);

    // ========================================================================
    // Action 2: Open settings panel
    // ========================================================================
    const settingsDelta = await measureCDPDelta(cdpSession, async () => {
      const settingsTab = window.locator('#flow-tab-settings');
      await expect(settingsTab).toBeVisible({ timeout: 5000 });
      await settingsTab.click();
      const settingsPanel = window.locator('[data-testid="settings-panel"]');
      await expect(settingsPanel).toBeVisible({ timeout: 5000 });
    });
    results.push({ action: 'Open settings', delta: settingsDelta });
    console.log(`[PERF-CDP] Open settings: LayoutCount=${settingsDelta.LayoutCount}, RecalcStyleCount=${settingsDelta.RecalcStyleCount}`);

    // ========================================================================
    // Action 3: Open connectors panel
    // ========================================================================
    const connectorsDelta = await measureCDPDelta(cdpSession, async () => {
      const connectorsTab = window.locator('[data-testid="settings-tab-connectors"]');
      await expect(connectorsTab).toBeVisible({ timeout: 5000 });
      await connectorsTab.click();
      const connectorsPanel = window.locator('[data-testid="connectors-panel"]');
      await expect(connectorsPanel).toBeVisible({ timeout: 10000 });
    });
    results.push({ action: 'Open connectors', delta: connectorsDelta });
    console.log(`[PERF-CDP] Open connectors: LayoutCount=${connectorsDelta.LayoutCount}, RecalcStyleCount=${connectorsDelta.RecalcStyleCount}`);

    // ========================================================================
    // Action 4: Open automations panel
    // ========================================================================
    const automationsDelta = await measureCDPDelta(cdpSession, async () => {
      const automationsTab = window.locator('#flow-tab-automations');
      await expect(automationsTab).toBeVisible({ timeout: 5000 });
      await automationsTab.click();
      const automationsPanel = window.locator('[data-testid="automations-panel"]');
      await expect(automationsPanel).toBeVisible({ timeout: 5000 });
    });
    results.push({ action: 'Open automations', delta: automationsDelta });
    console.log(`[PERF-CDP] Open automations: LayoutCount=${automationsDelta.LayoutCount}, RecalcStyleCount=${automationsDelta.RecalcStyleCount}`);

    // ========================================================================
    // Summary and CDP availability check
    // ========================================================================
    console.log('[PERF-CDP] ---- Summary ----');
    let totalLayoutCount = 0;
    for (const { action, delta } of results) {
      totalLayoutCount += delta.LayoutCount;
      console.log(`[PERF-CDP]   ${action}: Layout=${delta.LayoutCount}, RecalcStyle=${delta.RecalcStyleCount}`);
    }
    console.log(`[PERF-CDP] Total LayoutCount across all actions: ${totalLayoutCount}`);

    // Warn if CDP Performance domain doesn't report structural metrics in Electron
    if (totalLayoutCount === 0) {
      console.log('[PERF-CDP-WARN] LayoutCount is zero — CDP Performance domain may not report structural metrics in Electron');
    }

    // NO expect() assertions — this is observation-only to establish baselines.
    // Once we have verified that CDP reports non-zero structural metrics,
    // a follow-up PR will add budgets at 2x observed values.
  });
});
