import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  appExists,
  createIsolatedUserData,
  enableGuestMode,
  getAppNotFoundMessage,
  getFirstWindow,
  type IsolatedUserData,
  launchWithIsolatedUserData,
  safeCloseApp,
  waitForMainAppReady,
  writeMinimalSettings,
} from './test-utils';

test.skip(!appExists(), getAppNotFoundMessage());

// The runtime entry name uses generateInstanceId('GammaMcp', email). The
// catalog display name is "Gamma" but `bundledConfig.serverName` is
// "GammaMcp", so this fixture also covers Class A name divergence (display
// vs. serverName) on top of Class B email-instancing. This is the shape
// that triggered the 2026-05-04 "Unknown bundled server" report.
const SEEDED_GAMMA_INSTANCE_NAME = 'GammaMcp-rebel-e2e-example-com';

function seedGammaConnector(userDataPath: string): void {
  writeMinimalSettings(userDataPath);

  const mcpDir = path.join(userDataPath, 'mcp');
  const routerPath = path.join(mcpDir, 'super-mcp-router.json');
  fs.mkdirSync(mcpDir, { recursive: true });
  fs.writeFileSync(
    routerPath,
    JSON.stringify({
      configPaths: [],
      mcpServers: {
        [SEEDED_GAMMA_INSTANCE_NAME]: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@mindstone-engineering/mcp-server-gamma@0.3.1'],
          env: { GAMMA_API_KEY: 'fake-gamma-old-e2e-key' },
          catalogId: 'bundled-gamma',
          email: 'rebel.e2e@example.com',
          lastConnectedAt: Date.now() - 60_000,
        },
      },
    }, null, 2),
  );

  const settingsPath = path.join(userDataPath, 'app-settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, mcpConfigFile: routerPath }, null, 2));
}

test('updates a connected Gamma API key in place', async () => {
  test.setTimeout(300_000);
  const isolated: IsolatedUserData = createIsolatedUserData('connector-update-credentials');
  let app: ElectronApplication | undefined;

  try {
    seedGammaConnector(isolated.path);
    app = await launchWithIsolatedUserData(isolated);
    const window = await getFirstWindow(app);
    await window.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);
    await window.locator('#flow-tab-settings').click();
    await expect(window.locator('[data-testid="settings-panel"]')).toBeVisible({ timeout: 5_000 });

    const connectorsTab = window.locator('[data-testid="settings-tab-connectors"]');
    await expect(connectorsTab).toBeVisible({ timeout: 5_000 });
    await connectorsTab.click();
    await expect(window.locator('[data-testid="connectors-panel"]')).toBeVisible({ timeout: 10_000 });

    const searchInput = window.getByPlaceholder('Search connectors...');
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill('Gamma');
    }

    const gammaCard = window.locator('[data-testid^="connector-card-"]').filter({ hasText: 'Gamma' }).first();
    await expect(gammaCard).toBeVisible({ timeout: 15_000 });
    await gammaCard.click();

    const updateButton = window.locator('[data-testid="connector-update-credentials-button"]');
    await expect(updateButton).toBeVisible({ timeout: 10_000 });
    await expect(updateButton).toHaveText(/Update key/);
    await updateButton.click();

    const emailInput = window.locator('#setup-email-expanded');
    await expect(emailInput).toHaveValue('rebel.e2e@example.com');
    await expect(emailInput).toHaveJSProperty('readOnly', true);

    const keyInput = window.locator('#setup-apiKey-expanded');
    await expect(keyInput).toHaveValue('');
    await keyInput.fill('fake-gamma-updated-e2e-key');

    await window.locator('[data-testid="connector-setup-save-button"]').click();
    await expect(window.locator('[data-testid="connector-post-save-validation-notice"]'))
      .toContainText('Updated. Tested the new key — all good.', { timeout: 10_000 });

    // The renderer correctly forwards the email-instanced runtime entry name verbatim.
    // We assert this by verifying the actual configuration file was updated. If the
    // renderer had forwarded the generic 'GammaMcp' name instead, the IPC handler
    // would have rejected the update with 'Cannot update — connector entry not found',
    // the file would not be written, and the UI validation above would have failed.
    const mcpDir = path.join(isolated.path, 'mcp');
    const routerPath = path.join(mcpDir, 'super-mcp-router.json');
    const routerConfig = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
    expect(routerConfig.mcpServers[SEEDED_GAMMA_INSTANCE_NAME].env.GAMMA_API_KEY).toBe('fake-gamma-updated-e2e-key');
  } finally {
    if (app) {
      await safeCloseApp(app, 15_000, isolated.path);
    }
    if (!process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated.cleanup();
    }
  }
});
