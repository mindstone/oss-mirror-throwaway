/**
 * IPC Payload Size Guard — E2E Performance Test
 *
 * Asserts that no IPC channel returns payloads exceeding 256KB (fail threshold)
 * during normal app navigation flows. Payloads between 64KB-256KB are logged
 * as warnings but do not fail the test.
 *
 * This test is deterministic (5/5) — payload sizes depend on data, not CPU speed.
 * Zero CI flakiness risk.
 *
 * @see src/main/ipc/utils/ipcPayloadGuard.ts — Payload size estimation module
 * @see src/main/ipc/utils/ElectronHandlerRegistry.ts — Integration point
 * @see docs/plans/260328_perf_regression_tests.md — Full planning doc
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

test.describe('IPC Payload Size Guards', () => {
  test.describe.configure({ timeout: 180_000 }); // 3 minutes

  test.beforeAll(async () => {
    console.log('[PERF] [ipc-payload] ========== TEST SUITE START ==========');
    const startTime = Date.now();

    const result = await launchForPerfTest('perf-ipc-payload');
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

    console.log(`[PERF] [ipc-payload] App launched and ready in ${Date.now() - startTime}ms`);

    // Clear any violations accumulated during startup
    await electronApp.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clearFn = (global as any).__e2e_clearIpcSizeViolations;
      if (typeof clearFn === 'function') clearFn();
    });
    console.log('[PERF] [ipc-payload] Cleared startup violations');
  });

  test.afterAll(async () => {
    console.log('[PERF] [ipc-payload] ========== TEST SUITE END ==========');
    await safeCloseApp(electronApp, 15000, userDataPath);
    if (!process.env.REBEL_E2E_KEEP_USER_DATA) {
      cleanup?.();
    }
  });

  test('no oversized IPC payloads during app navigation', async () => {
    // Navigate through key UI flows that trigger IPC calls.
    // Each flow exercises different IPC channels (settings, automations, etc.)

    // Flow 1: New chat
    console.log('[PERF] [ipc-payload] Flow 1: New chat');
    const newChatButton = window.locator('[data-testid="new-chat-button"]');
    await expect(newChatButton).toBeVisible({ timeout: 10000 });
    await newChatButton.click();
    const interactionStrip = window.locator('[data-testid="interaction-strip"]');
    await expect(interactionStrip).toBeVisible({ timeout: 10000 });

    // Flow 2: Settings panel
    console.log('[PERF] [ipc-payload] Flow 2: Settings panel');
    const settingsTab = window.locator('#flow-tab-settings');
    await expect(settingsTab).toBeVisible({ timeout: 5000 });
    await settingsTab.click();
    const settingsPanel = window.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible({ timeout: 5000 });

    // Flow 3: Connectors tab
    console.log('[PERF] [ipc-payload] Flow 3: Connectors tab');
    const connectorsTab = window.locator('[data-testid="settings-tab-connectors"]');
    await expect(connectorsTab).toBeVisible({ timeout: 5000 });
    await connectorsTab.click();
    // Wait for connector cards to load (triggers IPC for connector catalog)
    const connectorCards = window.locator('[data-testid^="connector-card-"]');
    await expect(connectorCards.first()).toBeVisible({ timeout: 10000 });

    // Flow 4: Automations panel
    console.log('[PERF] [ipc-payload] Flow 4: Automations panel');
    const automationsTab = window.locator('#flow-tab-automations');
    await expect(automationsTab).toBeVisible({ timeout: 5000 });
    await automationsTab.click();
    const automationsPanel = window.locator('[data-testid="automations-panel"]');
    await expect(automationsPanel).toBeVisible({ timeout: 5000 });

    // Brief settle time to let any async IPC calls complete
    await window.waitForTimeout(1000);

    // Verify instrumentation is active (prevents false-pass if hookup regresses)
    const instrumentationActive = await electronApp.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return typeof (global as any).__e2e_getIpcSizeViolations === 'function';
    });
    expect(instrumentationActive).toBe(true);

    // Read violations from the main process
    const violations = await electronApp.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getFn = (global as any).__e2e_getIpcSizeViolations;
      return getFn() as Array<{ channel: string; size: number; level: string; timestamp: number }>;
    });

    // Separate fail-level and warn-level violations
    const failViolations = violations.filter((v) => v.level === 'fail');
    const warnViolations = violations.filter((v) => v.level === 'warn');

    // Log warn-level violations for awareness (do not fail)
    if (warnViolations.length > 0) {
      console.log(`[PERF] [ipc-payload] ⚠️  ${warnViolations.length} warn-level violation(s) (>64KB):`);
      for (const v of warnViolations) {
        console.log(`  - ${v.channel}: ${(v.size / 1024).toFixed(1)}KB`);
      }
    }

    // Log fail-level violations with detail
    if (failViolations.length > 0) {
      console.log(`[PERF] [ipc-payload] ❌ ${failViolations.length} fail-level violation(s) (>256KB):`);
      for (const v of failViolations) {
        console.log(`  - ${v.channel}: ${(v.size / 1024).toFixed(1)}KB`);
      }
    }

    // Log total count
    console.log(`[PERF] [ipc-payload] Total violations: ${violations.length} (${failViolations.length} fail, ${warnViolations.length} warn)`);

    // Hard fail if any payload exceeds 256KB
    expect(
      failViolations,
      `IPC channels with payloads >256KB: ${failViolations.map((v) => `${v.channel} (${(v.size / 1024).toFixed(1)}KB)`).join(', ')}`
    ).toHaveLength(0);
  });
});
