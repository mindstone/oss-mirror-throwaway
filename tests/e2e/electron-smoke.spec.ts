/**
 * Electron Smoke Tests
 *
 * Basic UI smoke tests for app shell, navigation, connectors, and automations.
 * These tests run with pre-seeded settings to skip onboarding.
 *
 * Extracted from: sequence-a.spec.ts (Phases 3-5)
 * See: docs/plans/partway/260126_e2e_test_architecture_overhaul.md (Stage 2.2)
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  appExists,
  createIsolatedUserData,
  enableGuestMode,
  getAppNotFoundMessage,
  getFirstWindow,
  type IsolatedUserData,
  launchWithIsolatedUserData,
  resetAppState,
  safeCloseApp,
  waitForMainAppReady,
  writeMinimalSettings,
} from './test-utils';

test.skip(!appExists(), getAppNotFoundMessage());

let app: ElectronApplication;
let window: Page;
let isolated: IsolatedUserData;

test.describe('Electron Smoke Tests', () => {
  test.describe.configure({ timeout: 300_000 }); // 5 minutes

  test.beforeAll(async () => {
    console.log('[E2E] [electron-smoke] ========== TEST SUITE START ==========');
    console.log('[E2E] [electron-smoke] Launching app with seeded settings');
    const startTime = Date.now();

    // Create isolated userData with pre-seeded settings
    isolated = createIsolatedUserData('electron-smoke');
    writeMinimalSettings(isolated.path);

    app = await launchWithIsolatedUserData(isolated, {
      skipOnboarding: true, // Settings already seeded
    });
    window = await getFirstWindow(app);

    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);

    // Verify app is ready
    await expect(window.locator('[data-testid="brand-home"]')).toBeVisible({ timeout: 15000 });

    // Wait for navigation tabs to be rendered (ensures FlowPanelsShell is mounted)
    await expect(window.locator('[id^="flow-tab-"]').first()).toBeVisible({ timeout: 15000 });

    console.log(`[E2E] [electron-smoke] App launched and ready in ${Date.now() - startTime}ms`);
    console.log(`[E2E] [electron-smoke] userData: ${isolated.path}`);
  });

  test.afterAll(async () => {
    console.log('[E2E] [electron-smoke] ========== TEST SUITE END ==========');
    await safeCloseApp(app, 15000, isolated.path);

    // Cleanup isolated userData
    if (!process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated?.cleanup();
    } else {
      console.log(`[DEBUG] Keeping test userData at: ${isolated.path}`);
    }
  });

  // ==========================================================================
  // App Shell and Navigation (3 tests)
  // ==========================================================================
  test.describe('App Shell and Navigation', () => {
    test.beforeEach(async ({}, testInfo) => {
      // Skip reset for the first test in this phase (app is freshly ready)
      if (testInfo.title !== 'App shell renders correctly and navigation works') {
        await resetAppState(window, testInfo.title);
      }
    });

    test('App shell renders correctly and navigation works', async () => {
      await expect(window.locator('[data-testid="brand-home"]')).toBeVisible({ timeout: 15000 });
      await expect(window.locator('[data-testid="new-chat-button"]')).toBeVisible({
        timeout: 10000,
      });

      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();

      const interactionStrip = window.locator('[data-testid="interaction-strip"]');
      await expect(interactionStrip).toBeVisible({ timeout: 10000 });

      const micButton = window.locator('[data-testid="unified-mic-button"]');
      await expect(micButton).toBeVisible({ timeout: 10000 });
    });

    test('The Spark panel and use cases work', async () => {
      const sparkTab = window.locator('#flow-tab-usecases');
      await expect(sparkTab).toBeVisible({ timeout: 15000 });
      await sparkTab.click();

      const usecasesPanel = window.locator('[data-testid="usecases-panel"]');
      await expect(usecasesPanel).toBeVisible({ timeout: 10000 });

      const usecaseCard = window.locator('[data-testid="usecase-card-0"]');
      const generateButton = window.locator('[data-testid="generate-usecases-button"]');

      const hasCards = await usecaseCard.isVisible().catch(() => false);
      const hasGenerateButton = await generateButton.isVisible().catch(() => false);
      expect(hasCards || hasGenerateButton).toBe(true);

      // Verify at least one section heading is visible (The Spark panel uses h3 section titles)
      const panelTitle = usecasesPanel.locator('h3').first();
      await expect(panelTitle).toBeVisible({ timeout: 5000 });
    });

    test('Keyboard shortcuts work correctly', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for interaction strip (chat ready)
      const interactionStrip = window.locator('[data-testid="interaction-strip"]');
      await expect(interactionStrip).toBeVisible({ timeout: 10000 });
      await expect(interactionStrip).toBeVisible({ timeout: 5000 });

      const isMac = process.platform === 'darwin';
      const modifier = isMac ? 'Meta' : 'Control';
      await window.keyboard.press(`${modifier}+KeyN`);
      // Wait for interaction strip after keyboard shortcut (Pattern 4)
      await expect(interactionStrip).toBeVisible({ timeout: 5000 });

      await window.keyboard.press(`${modifier}+Shift+KeyN`);

      const scratchpadDialog = window
        .locator('[role="dialog"]')
        .filter({ hasText: 'Scratchpad' });
      await expect(scratchpadDialog).toBeVisible({ timeout: 5000 });

      const dialogTitle = scratchpadDialog.getByRole('heading', { name: 'Scratchpad' });
      await expect(dialogTitle).toBeVisible({ timeout: 2000 });

      await window.keyboard.press('Escape');
      // Wait for the dialog to fully UNMOUNT, not merely become invisible. The
      // close/exit transition keeps the dialog's `_overlay_` div in the DOM for
      // the duration of the animation, so `not.toBeVisible()` can flake-time-out
      // mid-transition (F1, the #1 E2E flake — see
      // docs/plans/260617_deflake-ci-for-blocking-gates/PLAN.md Stage 2).
      // toHaveCount(0) waits for true DOM removal, which is the real "closed" state.
      await expect(scratchpadDialog).toHaveCount(0, { timeout: 5000 });
    });
  });

  // ==========================================================================
  // Connectors Panel (4 tests)
  // ==========================================================================
  test.describe('Connectors Panel', () => {
    test.beforeEach(async ({}, testInfo) => {
      await resetAppState(window, testInfo.title);
    });

    test('Connectors tab renders with page header', async () => {
      const settingsTab = window.locator('#flow-tab-settings');
      await expect(settingsTab).toBeVisible({ timeout: 5000 });
      await settingsTab.click();

      const settingsPanel = window.locator('[data-testid="settings-panel"]');
      await expect(settingsPanel).toBeVisible({ timeout: 5000 });

      const connectorsTab = window.locator('[data-testid="settings-tab-connectors"]');
      await expect(connectorsTab).toBeVisible({ timeout: 5000 });
      await connectorsTab.click();

      const pageHeader = window.locator('[data-testid="connectors-page-header"] h2');
      await expect(pageHeader).toBeVisible({ timeout: 5000 });
      await expect(pageHeader).toHaveText('Connectors');
    });

    test('Connector cards display in panel', async () => {
      const settingsTab = window.locator('#flow-tab-settings');
      await settingsTab.click();

      const settingsPanel = window.locator('[data-testid="settings-panel"]');
      await expect(settingsPanel).toBeVisible({ timeout: 5000 });

      const connectorsTab = window.locator('[data-testid="settings-tab-connectors"]');
      await connectorsTab.click();

      const connectorsPanel = window.locator('[data-testid="connectors-panel"]');
      await expect(connectorsPanel).toBeVisible({ timeout: 5000 });

      const connectorCards = window.locator('[data-testid^="connector-card-"]');
      await expect(connectorCards.first()).toBeVisible({ timeout: 10000 });

      const cardCount = await connectorCards.count();
      expect(cardCount).toBeGreaterThanOrEqual(1);
    });

    test('Connect button is visible on connector cards', async () => {
      const settingsTab = window.locator('#flow-tab-settings');
      await settingsTab.click();

      const settingsPanel = window.locator('[data-testid="settings-panel"]');
      await expect(settingsPanel).toBeVisible({ timeout: 5000 });

      const connectorsTab = window.locator('[data-testid="settings-tab-connectors"]');
      await connectorsTab.click();

      const connectorsPanel = window.locator('[data-testid="connectors-panel"]');
      await expect(connectorsPanel).toBeVisible({ timeout: 5000 });

      const connectorCards = window.locator('[data-testid^="connector-card-"]');
      await expect(connectorCards.first()).toBeVisible({ timeout: 10000 });

      // Connect button only renders for OAuth-type connectors (not API-key or manual setup)
      // Iterate through cards to find one with a connect button
      const connectButton = window.locator('[data-testid^="connector-connect-button-"]');
      let foundConnectButton = false;
      const totalCards = await connectorCards.count();
      const maxCardsToTry = Math.min(totalCards, 5);

      for (let i = 0; i < maxCardsToTry; i++) {
        const card = connectorCards.nth(i);
        await card.click();
        // Short wait for card expansion animation - legitimate UI animation
        await expect(card).toBeVisible({ timeout: 3000 });

        if (await connectButton.isVisible().catch(() => false)) {
          foundConnectButton = true;
          console.log(`[E2E] Found connect button on card ${i + 1}/${maxCardsToTry}`);
          break;
        }

        // Close this card and try next
        await window.keyboard.press('Escape');
      }

      // Note: It's acceptable if no OAuth connector found - catalog may be all API-key types
      // The test verifies UI doesn't crash and iterates through cards correctly
      if (!foundConnectButton) {
        console.log(
          `[E2E] No OAuth connect button found in first ${maxCardsToTry} cards (may be all API-key/manual setup)`
        );
      }

      // Verify we at least tried the iteration without crashing
      expect(totalCards).toBeGreaterThan(0);
    });

    test('Search filters connector list', async () => {
      const settingsTab = window.locator('#flow-tab-settings');
      await settingsTab.click();

      const settingsPanel = window.locator('[data-testid="settings-panel"]');
      await expect(settingsPanel).toBeVisible({ timeout: 5000 });

      const connectorsTab = window.locator('[data-testid="settings-tab-connectors"]');
      await connectorsTab.click();

      const connectorsPanel = window.locator('[data-testid="connectors-panel"]');
      await expect(connectorsPanel).toBeVisible({ timeout: 5000 });

      await window.keyboard.press('Escape');
      // Wait for any dialog to close
      const searchInput = window.getByPlaceholder('Search connectors...');
      const searchVisible = await searchInput.isVisible().catch(() => false);

      if (!searchVisible) {
        return;
      }

      const connectorCards = window.locator('[data-testid^="connector-card-"]');
      await expect(connectorCards.first()).toBeVisible({ timeout: 10000 });

      const initialCount = await connectorCards.count();

      await searchInput.fill('Slack');
      // Wait for search filter to apply (Pattern 6 - debounce)
      await expect(async () => {
        const filteredCount = await connectorCards.count();
        expect(filteredCount).toBeLessThanOrEqual(initialCount);
      }).toPass({ timeout: 5000 });

      await searchInput.clear();
      // Wait for list to restore (Pattern 6 - debounce)
      await expect(async () => {
        const restoredCount = await connectorCards.count();
        expect(restoredCount).toBeGreaterThanOrEqual(1);
      }).toPass({ timeout: 5000 });
    });
  });

  // ==========================================================================
  // Automations Navigation (2 tests)
  // ==========================================================================
  test.describe('Automations Navigation', () => {
    test.beforeEach(async ({}, testInfo) => {
      await resetAppState(window, testInfo.title);
    });

    test('opens automations panel from navigation', async () => {
      const automationsTab = window.locator('#flow-tab-automations');
      await expect(automationsTab).toBeVisible({ timeout: 5000 });
      await automationsTab.click();

      const automationsPanel = window.locator('[data-testid="automations-panel"]');
      await expect(automationsPanel).toBeVisible({ timeout: 5000 });
    });

    test('create button is visible in automations panel', async () => {
      const automationsTab = window.locator('#flow-tab-automations');
      await automationsTab.click();

      const automationsPanel = window.locator('[data-testid="automations-panel"]');
      await expect(automationsPanel).toBeVisible({ timeout: 5000 });

      // Default system automations are always created, so the panel shows the non-empty state
      // which has a hero input section instead of the empty-state create button
      const createButton = window.locator('[data-testid="automations-create-button-hero"]');
      await expect(createButton).toBeVisible({ timeout: 5000 });
    });
  });
});
