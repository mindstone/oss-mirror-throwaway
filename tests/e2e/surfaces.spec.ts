/**
 * Surface Navigation E2E Tests — Homepage and Inbox (Actions)
 *
 * Stage 10 of the E2E test gap improvements plan.
 * These surfaces previously had zero dedicated E2E coverage.
 * Tests focus on render verification and navigation round-trips.
 * Automations coverage lives in electron-smoke.spec.ts.
 *
 * See: docs/plans/260402_e2e_test_gap_improvements.md (Stage 10)
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  appExists,
  enableGuestMode,
  getAppNotFoundMessage,
  getFirstWindow,
  launchWithMocking,
  PLATFORM,
  resetAppState,
  safeCloseApp,
  seedInboxItem,
  waitForMainAppReady,
} from './test-utils';

test.skip(!appExists(), getAppNotFoundMessage());

let app: ElectronApplication;
let window: Page;
let cleanup: (() => void) | undefined;
let userDataPath = '';
let testCount = 0;
const failures: string[] = [];

// =============================================================================
// Shared Setup — Single app launch, mocked LLM, guest mode
// =============================================================================

test.describe('Surface Navigation (Mocked)', () => {
  test.skip(PLATFORM === 'win32', 'Skipped on Windows: app launch timeout in CI');
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    console.log('[E2E] [surfaces] ========== SUITE START ==========');
    const startTime = Date.now();

    const launched = await launchWithMocking('surfaces', {
      skipOnboarding: true,
    });

    app = launched.electronApp;
    cleanup = launched.cleanup;
    userDataPath = launched.userDataPath;
    window = await getFirstWindow(app);
    await enableGuestMode(window);
    await waitForMainAppReady(window);

    await expect(window.locator('[id^="flow-tab-"]').first()).toBeVisible({ timeout: 15000 });

    console.log(`[E2E] [surfaces] App launched and ready in ${Date.now() - startTime}ms`);
    console.log(`[E2E] [surfaces] userData: ${userDataPath}`);
  });

  test.afterAll(async () => {
    console.log('[E2E] [surfaces] ========== SUITE END ==========');
    console.log(`[E2E] [surfaces] Tests run: ${testCount}, Failures: ${failures.length}`);
    if (failures.length > 0) {
      console.log(`[E2E] [surfaces] Failed tests: ${failures.join(', ')}`);
    }

    if (app) {
      await safeCloseApp(app, 15000, userDataPath);
    }

    if (failures.length === 0 && !process.env.REBEL_E2E_KEEP_USER_DATA) {
      cleanup?.();
    } else {
      console.log(`[DEBUG] Keeping test userData at: ${userDataPath}`);
    }
  });

  test.beforeEach(async ({}, testInfo) => {
    testCount++;
    console.log(`[E2E] [test:start] [${testCount}/${testInfo.title}] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
    await resetAppState(window, testInfo.title);
  });

  test.afterEach(async ({}, testInfo) => {
    const status = testInfo.status || 'unknown';
    console.log(`[E2E] [test:end] [${testCount}/${testInfo.title}] Status: ${status}`);

    if (status === 'failed' || status === 'timedOut') {
      failures.push(testInfo.title);
      const screenshotPath = `test-results/surfaces-${testCount}-failure.png`;
      await window.screenshot({ path: screenshotPath }).catch(() => {});
    }
  });

  // ===========================================================================
  // 1. Homepage Tests
  // ===========================================================================
  test.describe('Homepage', () => {
    test('homepage renders with core elements', async () => {
      const homeTab = window.locator('#flow-tab-home');
      await expect(homeTab).toBeVisible({ timeout: 5000 });
      await homeTab.click();

      const homepagePanel = window.locator('[data-testid="homepage-panel"]');
      await expect(homepagePanel).toBeVisible({ timeout: 10000 });

      // Greeting title
      await expect(homepagePanel.locator('h1').first()).toBeVisible({ timeout: 5000 });

      // Hero chat input (textarea, contentEditable TipTap div, or textbox role)
      await expect(
        homepagePanel.locator('textarea, [contenteditable="true"], [role="textbox"]').first()
      ).toBeVisible({ timeout: 5000 });
    });

    test('can navigate to Conversations and back to Homepage', async () => {
      const homeTab = window.locator('#flow-tab-home');
      await homeTab.click();
      await expect(window.locator('[data-testid="homepage-panel"]')).toBeVisible({ timeout: 10000 });

      // Navigate to Conversations
      await window.locator('#flow-tab-sessions').click();
      await expect(window.locator('[data-testid="session-sidebar"]')).toBeVisible({ timeout: 10000 });
      await expect(window.locator('[data-testid="homepage-panel"]')).not.toBeVisible({ timeout: 5000 });

      // Navigate back to Home
      await homeTab.click();
      await expect(window.locator('[data-testid="homepage-panel"]')).toBeVisible({ timeout: 10000 });
    });
  });

  // ===========================================================================
  // 2. Inbox / Actions Tests
  // ===========================================================================
  test.describe('Inbox (Actions)', () => {
    test('inbox panel renders with item list', async () => {
      const actionsTab = window.locator('#flow-tab-tasks');
      await expect(actionsTab).toBeVisible({ timeout: 5000 });
      await actionsTab.click();

      await expect(window.locator('[data-testid="inbox-panel"]')).toBeVisible({ timeout: 10000 });
      // Scroll area always renders (wraps TemporalGroupView which handles empty state)
      await expect(window.locator('[data-testid="inbox-item-list"]')).toBeVisible({ timeout: 5000 });
    });

    test('can navigate between Inbox and Conversations', async () => {
      const actionsTab = window.locator('#flow-tab-tasks');
      await actionsTab.click();
      await expect(window.locator('[data-testid="inbox-panel"]')).toBeVisible({ timeout: 10000 });

      // Navigate to Conversations
      await window.locator('#flow-tab-sessions').click();
      await expect(window.locator('[data-testid="session-sidebar"]')).toBeVisible({ timeout: 10000 });
      await expect(window.locator('[data-testid="inbox-panel"]')).not.toBeVisible({ timeout: 5000 });

      // Navigate back to Actions
      await actionsTab.click();
      await expect(window.locator('[data-testid="inbox-panel"]')).toBeVisible({ timeout: 10000 });
    });

    test('inbox data pipeline: seed, render, mark done, and live update', async () => {
      // --- Phase 1: Seeded item renders after navigation ---
      // Validates: inbox:add IPC -> store -> emitInboxState -> loadIndex/loadItems -> render
      const uniqueTitle = `E2E Test: Review quarterly report ${Date.now()}`;
      await seedInboxItem(window, { title: uniqueTitle });

      const actionsTab = window.locator('#flow-tab-tasks');
      await actionsTab.click();
      await expect(window.locator('[data-testid="inbox-panel"]')).toBeVisible({ timeout: 10000 });

      const seededCard = window.locator('[data-testid="inbox-item-card"]', {
        hasText: uniqueTitle,
      });
      await expect(seededCard).toBeVisible({ timeout: 10000 });
      await expect(seededCard).toHaveCount(1);

      // --- Phase 2: Mark item done (optimistic removal) ---
      // Validates: Done button wiring -> handleItemStatusChange -> optimistic state update
      const doneButton = seededCard.getByRole('button', { name: 'Done', exact: true });
      await seededCard.hover();
      await doneButton.click();
      await expect(seededCard).not.toBeVisible({ timeout: 10000 });

      // --- Phase 3: Live update while Actions tab is open ---
      // Validates: inbox:state broadcast -> preload onInboxUpdate -> useInbox subscription -> re-render
      const liveTitle = `E2E Test: Live update item ${Date.now()}`;
      await seedInboxItem(window, { title: liveTitle });

      const liveCard = window.locator('[data-testid="inbox-item-card"]', {
        hasText: liveTitle,
      });
      await expect(liveCard).toBeVisible({ timeout: 10000 });
    });
  });
});
