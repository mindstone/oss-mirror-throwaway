/**
 * Settings Tests (Settings Panel + Theme Persistence)
 *
 * Extracted from:
 * - sequence-a.spec.ts Phase 6: Settings Panel
 * - sequence-c.spec.ts: Theme setting persists across app restart
 *
 * See: docs/plans/partway/260126_e2e_test_architecture_overhaul.md (Stage 2.2)
 *
 * Total: 3 tests
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
  PLATFORM,
  resetAppState,
  safeCloseApp,
  waitForMainAppReady,
  writeMinimalSettings
} from './test-utils';

test.skip(!appExists(), getAppNotFoundMessage());

async function sendDeepLink(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, deepLinkUrl) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    win?.webContents.send('app:navigate-deep-link', deepLinkUrl);
  }, url);
}

// ============================================================================
// Settings Panel Tests (from sequence-a Phase 6)
// ============================================================================
test.describe('Settings Panel', () => {
  test.describe.configure({ timeout: 300_000 }); // 5 minutes

  let app: ElectronApplication;
  let window: Page;
  let isolated: IsolatedUserData;
  let testCount = 0;
  let failures: string[] = [];

  test.beforeAll(async () => {
    console.log('[E2E] [settings] ========== SUITE START ==========');
    const startTime = Date.now();

    isolated = createIsolatedUserData('settings');
    writeMinimalSettings(isolated.path);

    app = await launchWithIsolatedUserData(isolated);
    window = await getFirstWindow(app);

    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);

    // Verify app is ready
    await expect(window.locator('[data-testid="brand-home"]')).toBeVisible({ timeout: 15000 });
    await expect(window.locator('[id^="flow-tab-"]').first()).toBeVisible({ timeout: 15000 });

    console.log(`[E2E] [settings] App launched in ${Date.now() - startTime}ms`);
  });

  test.afterAll(async () => {
    console.log('[E2E] [settings] ========== SUITE END ==========');
    console.log(`[E2E] [settings] Tests run: ${testCount}`);
    console.log(`[E2E] [settings] Failures: ${failures.length}`);
    if (failures.length > 0) {
      console.log(`[E2E] [settings] Failed tests: ${failures.join(', ')}`);
    }
    await safeCloseApp(app, 15000, isolated.path);

    if (failures.length === 0 && !process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated?.cleanup();
    } else {
      console.log(`[DEBUG] Keeping test userData at: ${isolated.path}`);
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
      const screenshotPath = `test-results/settings-${testCount}-failure.png`;
      await window.screenshot({ path: screenshotPath }).catch(() => {});
    }
  });

  test('Settings navigation and tab switching works correctly', async () => {
    const settingsTab = window.locator('#flow-tab-settings');
    await expect(settingsTab).toBeVisible({ timeout: 5000 });
    await settingsTab.click();

    const settingsPanel = window.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible({ timeout: 5000 });

    const destinations = [
      'agent-voice',
      'connectors',
      'privacy-safety',
      'meetings',
      'workspace',
      'account-preferences',
      'usage',
      'advanced',
    ];
    for (const destination of destinations) {
      const destinationButton = window.locator(`[data-testid="settings-destination-${destination}"], [data-testid="settings-tab-${destination}"]`);
      await expect(destinationButton).toBeVisible({ timeout: 5000 });
    }

    // Explicitly click Workspace since Settings may have remembered last destination
    const workspaceTab = window.locator('[data-testid="settings-destination-workspace"]');
    await workspaceTab.click();
    const coreDirectoryInput = window.locator('[data-testid="settings-core-directory-input"]');
    await expect(coreDirectoryInput).toBeVisible({ timeout: 5000 });

    await sendDeepLink(app, 'rebel://settings/?tab=cloud&section=messagingChannels');
    const messagingSection = window.locator('[data-testid="messaging-channels-section"]');
    await expect(messagingSection).toBeVisible({ timeout: 5000 });

    const agentVoiceTab = window.locator('[data-testid="settings-destination-agent-voice"]');
    await agentVoiceTab.click();
    await expect(window.getByRole('heading', { name: 'AI provider' })).toBeVisible({ timeout: 5000 });
    await expect(coreDirectoryInput).not.toBeVisible();

    const settingsSearch = window.getByLabel('Search settings');
    await settingsSearch.fill('Privacy Mode');
    await window.getByRole('button', { name: /Privacy Mode/i }).click();
    const privacySection = window.locator('[data-testid="settings-section-privacy-safety"]');
    await expect(privacySection).toBeVisible({ timeout: 5000 });

    // Privacy & data now lives under its own top-level Privacy & Safety destination
    const privacySafetyTab = window.locator('[data-testid="settings-destination-privacy-safety"]');
    await privacySafetyTab.click();
    await expect(privacySection).toBeVisible({ timeout: 5000 });

    // Click back to Workspace
    await workspaceTab.click();
    await expect(coreDirectoryInput).toBeVisible({ timeout: 5000 });

    const sessionsTab = window.locator('#flow-tab-sessions');
    await expect(sessionsTab).toBeVisible({ timeout: 5000 });
    await sessionsTab.click();
    await expect(settingsPanel).not.toBeVisible({ timeout: 5000 });
  });

  test('Prevent-sleep toggle can be enabled and disabled in Advanced settings', async () => {
    await window.locator('#flow-tab-settings').click();
    const settingsPanel = window.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible({ timeout: 5000 });

    const advancedTab = window.locator('[data-testid="settings-destination-advanced"]');
    await expect(advancedTab).toBeVisible({ timeout: 5000 });
    await advancedTab.click();

    const preventSleepSection = window.locator('[data-testid="settings-section-prevent-sleep"]');
    await expect(preventSleepSection).toBeVisible({ timeout: 5000 });

    const toggle = window.locator('[data-testid="settings-prevent-sleep-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 5000 });

    const initiallyChecked = await toggle.isChecked();

    // Toggle on (or off if already on)
    await toggle.click();
    if (initiallyChecked) {
      await expect(toggle).not.toBeChecked({ timeout: 3000 });
    } else {
      await expect(toggle).toBeChecked({ timeout: 3000 });
    }

    // Toggle back to original state
    await toggle.click();
    if (initiallyChecked) {
      await expect(toggle).toBeChecked({ timeout: 3000 });
    } else {
      await expect(toggle).not.toBeChecked({ timeout: 3000 });
    }
  });

  test('Theme toggle changes app appearance', async () => {
    await window.locator('#flow-tab-settings').click();
    const settingsPanel = window.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible({ timeout: 5000 });

    const accountPreferencesTab = window.locator('[data-testid="settings-destination-account-preferences"]');
    await accountPreferencesTab.click();
    await expect(window.locator('[data-testid="settings-theme-select"]')).toBeVisible({ timeout: 5000 });

    const initialIsDark = await window.evaluate(() =>
      document.body.classList.contains('dark')
    );

    const themeSelect = window.locator('[data-testid="settings-theme-select"]');
    await expect(themeSelect).toBeVisible({ timeout: 5000 });

    await themeSelect.focus();
    const targetTheme = initialIsDark ? 'light' : 'dark';
    await themeSelect.selectOption({ value: targetTheme });

    await expect.poll(
      async () => {
        const isDark = await window.evaluate(() => document.body.classList.contains('dark'));
        return targetTheme === 'dark' ? isDark : !isDark;
      },
      { timeout: 5000, message: `Expected theme to change to ${targetTheme}` }
    ).toBe(true);

    const newIsDark = await window.evaluate(() =>
      document.body.classList.contains('dark')
    );
    expect(newIsDark).not.toBe(initialIsDark);

    const colorScheme = await window.evaluate(() =>
      document.documentElement.style.colorScheme
    );
    expect(colorScheme).toBe(targetTheme);
  });
});

// ============================================================================
// Theme Persistence Test (from sequence-c)
// ============================================================================
test.describe('Settings Persistence', () => {
  test.skip(PLATFORM === 'win32', 'Skipped on Windows: app launch timeout in CI');
  test.describe.configure({ timeout: 300_000 }); // 5 minutes

  let isolated: IsolatedUserData;
  let testFailed = false;

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== 'passed') {
      testFailed = true;
    }
  });

  test.afterAll(async () => {
    if (!testFailed && !process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated?.cleanup();
    } else if (isolated) {
      console.log(`[DEBUG] Keeping test userData at: ${isolated?.path}`);
    }
  });

  test('Theme setting persists across app restart', async () => {
    test.setTimeout(240_000); // 4 minutes

    isolated = createIsolatedUserData('settings-persistence');
    writeMinimalSettings(isolated.path);

    // --- PHASE 1: Launch app, change theme, close ---
    console.log('[Theme Persistence] Phase 1: Launching app...');
    let app = await launchWithIsolatedUserData(isolated);
    let window = await getFirstWindow(app);
    await window.waitForLoadState('domcontentloaded');

    await enableGuestMode(window);
    await waitForMainAppReady(window);

    await window.locator('#flow-tab-settings').click();
    const settingsPanel = window.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible({ timeout: 5000 });

    const accountPreferencesTab = window.locator('[data-testid="settings-destination-account-preferences"]');
    await accountPreferencesTab.click();
    await expect(window.locator('[data-testid="settings-theme-select"]')).toBeVisible({ timeout: 5000 });

    console.log('[Theme Persistence] Setting theme to light...');
    const themeSelect = window.locator('[data-testid="settings-theme-select"]');
    await themeSelect.selectOption('light');

    console.log('[Theme Persistence] Waiting for save confirmation...');
    const saveToast = window.locator('[data-testid="settings-save-toast"]');
    await expect(saveToast).toContainText('Saved', { timeout: 10000 });
    console.log('[Theme Persistence] Save confirmed');

    await expect.poll(
      () => window.evaluate(() => document.body.classList.contains('light')),
      { timeout: 5000 }
    ).toBe(true);
    console.log('[Theme Persistence] Theme applied before close: light');

    console.log('[Theme Persistence] Closing app...');
    await safeCloseApp(app, 15000, isolated.path);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // --- PHASE 2: Relaunch and verify theme persisted ---
    console.log('[Theme Persistence] Phase 2: Relaunching app...');
    app = await launchWithIsolatedUserData(isolated);
    window = await getFirstWindow(app);
    await window.waitForLoadState('domcontentloaded');

    await enableGuestMode(window);
    await waitForMainAppReady(window);

    console.log('[Theme Persistence] Waiting for theme to apply...');
    await expect.poll(
      () => window.evaluate(() => document.body.classList.contains('light')),
      {
        message: 'Expected body to have "light" class after settings load',
        timeout: 15000,
        intervals: [500, 1000, 1000, 2000, 2000]
      }
    ).toBe(true);

    console.log('[Theme Persistence] Verifying stored theme preference...');
    await window.locator('#flow-tab-settings').click();
    await expect(window.locator('[data-testid="settings-panel"]')).toBeVisible({ timeout: 5000 });
    await window.locator('[data-testid="settings-destination-account-preferences"]').click();
    const themeSelectAfter = window.locator('[data-testid="settings-theme-select"]');
    await expect(themeSelectAfter).toBeVisible({ timeout: 5000 });
    await expect(themeSelectAfter).toHaveValue('light', { timeout: 5000 });
    console.log('[Theme Persistence] Theme persisted successfully: select value is "light"');

    await safeCloseApp(app, 15000, isolated.path);
  });
});
