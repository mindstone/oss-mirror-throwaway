import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appExists,
  createIsolatedUserData,
  enableGuestMode,
  getAppNotFoundMessage,
  getEscapeHatchShortcut,
  getFirstWindow,
  type IsolatedUserData,
  launchWithIsolatedUserData,
  safeCloseApp,
  waitForMainAppReady,
} from './test-utils';

test.skip(!appExists(), getAppNotFoundMessage());

test.describe('Onboarding organisation grouping', () => {
  test.describe.configure({ timeout: 300_000 });

  let app: ElectronApplication;
  let window: Page;
  let isolated: IsolatedUserData;
  let workspacePath: string;
  let firstWorkSpacePath: string;
  let testFailed = false;

  test.beforeAll(async () => {
    isolated = createIsolatedUserData('onboarding-org-grouping');
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-e2e-onboarding-org-workspace-'));
    firstWorkSpacePath = path.join(workspacePath, 'work', 'Acme', 'General');
    fs.mkdirSync(firstWorkSpacePath, { recursive: true });
    fs.writeFileSync(
      path.join(firstWorkSpacePath, 'README.md'),
      [
        '---',
        'rebel_space_description: General work space',
        'space_type: company',
        'sharing: restricted',
        '---',
        '',
        '# General',
        '',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(isolated.path, 'app-settings.json'),
      JSON.stringify({
        onboardingCompleted: false,
        coreDirectory: workspacePath,
      }, null, 2),
    );

    app = await launchWithIsolatedUserData(isolated, {
      skipOnboarding: false,
    });
    window = await getFirstWindow(app);
    await window.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    await enableGuestMode(window);
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== 'passed') {
      testFailed = true;
    }
  });

  test.afterAll(async () => {
    if (app) {
      await safeCloseApp(app, 15_000, isolated.path);
    }

    if (!testFailed && !process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated?.cleanup();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    } else {
      console.log(`[DEBUG] Keeping test userData at: ${isolated?.path}`);
      console.log(`[DEBUG] Keeping test workspace at: ${workspacePath}`);
    }
  });

  test('seeds companyName and organisation_name for the first work space', async () => {
    await expect(window.locator('[data-testid="onboarding-welcome-content"]')).toBeVisible({ timeout: 15_000 });

    const eulaCheckbox = window.locator('input[type="checkbox"]');
    if (await eulaCheckbox.count()) {
      await eulaCheckbox.first().click({ force: true });
    }

    const preflightButton = window.locator('[data-testid="onboarding-get-started-button"]');
    await expect(preflightButton).toBeEnabled({ timeout: 10_000 });
    await preflightButton.click({ noWaitAfter: true, force: true });
    await expect(preflightButton).toHaveText(/Continue/, { timeout: 90_000 });
    await preflightButton.click({ noWaitAfter: true, force: true });

    await expect(window.locator('[data-testid="onboarding-step-googleDrive"]')).toBeVisible({ timeout: 15_000 });
    await window.locator('#onboarding-company-name').fill('Acme');

    await expect(window.getByText('General').first()).toBeVisible({ timeout: 10_000 });

    await window.locator('[data-testid="onboarding-continue-button"]').click({ noWaitAfter: true });
    await expect(window.locator('[data-testid^="onboarding-step-"]').first()).toBeVisible({ timeout: 15_000 });

    await window.keyboard.press(getEscapeHatchShortcut());
    await expect(window.locator('text=Skip setup?')).toBeVisible({ timeout: 5_000 });
    await window.locator('button:has-text("Skip anyway")').click({ noWaitAfter: true });
    await waitForMainAppReady(window);

    await expect
      .poll(
        () => {
          const settings = JSON.parse(
            fs.readFileSync(path.join(isolated.path, 'app-settings.json'), 'utf8'),
          ) as { companyName?: string };
          return settings.companyName;
        },
        { timeout: 10_000, intervals: [250, 500, 1_000] },
      )
      .toBe('Acme');

    await expect
      .poll(
        () => fs.readFileSync(path.join(firstWorkSpacePath, 'README.md'), 'utf8'),
        { timeout: 15_000 },
      )
      .toContain('organisation_name: Acme');

    await window.locator('#flow-tab-settings').click();
    await expect(window.locator('[data-testid="settings-panel"]')).toBeVisible({ timeout: 10_000 });
    await window.locator('[data-testid="settings-destination-workspace"]').click();
    await expect(window.getByText('General').first()).toBeVisible({ timeout: 10_000 });
    await expect(window.getByText('Acme').first()).toBeVisible({ timeout: 10_000 });
  });
});
