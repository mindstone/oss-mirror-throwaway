/**
 * Agent-driven flow is exercised via unit + integration tests; E2E scope here
 * is the handoff from Settings → conversation → back to Settings.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  appExists,
  getAppNotFoundMessage,
  getFirstWindow,
  launchWithMocking,
  safeCloseApp,
  waitForMainAppReady,
} from '../test-utils';
import { mockResponse } from '../mocks/llm-mock';

test.skip(!appExists(), getAppNotFoundMessage());

async function injectAgentEvent(
  electronApp: ElectronApplication,
  payload: { turnId: string; event: Record<string, unknown>; sessionId: string | null },
): Promise<void> {
  await electronApp.evaluate(async ({ BrowserWindow }, data) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('agent:event', data);
      }
    }
  }, payload);
}

async function openRebelBrowserConnector(page: Page): Promise<void> {
  await page.locator('#flow-tab-settings').click();
  await expect(page.locator('button:has-text("Connectors")')).toBeVisible();
  await page.locator('button:has-text("Connectors")').click();
  await expect(page.locator('[data-testid="connector-card-bundled-app-bridge"]')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-testid="connector-card-bundled-app-bridge"]').click();
}

async function readBridgePort(userDataPath: string): Promise<number> {
  const statePath = path.join(userDataPath, 'mcp', 'rebel-app-bridge', 'state.json');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const raw = await fs.readFile(statePath, 'utf8');
      const parsed = JSON.parse(raw) as { port?: number };
      if (typeof parsed.port === 'number') {
        return parsed.port;
      }
    } catch {
      // Retry until startup finishes writing the state file.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for App Bridge state at ${statePath}`);
}

async function claimPairCode(
  userDataPath: string,
  code: string,
  clientId = 'e2e-install-flow-client',
): Promise<void> {
  const port = await readBridgePort(userDataPath);
  const response = await fetch(`http://127.0.0.1:${port}/pair/claim`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      host: `127.0.0.1:${port}`,
    },
    body: JSON.stringify({
      code,
      clientId,
    }),
  });

  const text = await response.text();
  expect(response.status, text).toBe(200);
}

test.describe('App Bridge Install Flow', () => {
  let electronApp: ElectronApplication;
  let window: Page;
  let userDataPath: string;
  let cleanup: (() => void) | null = null;

  test.beforeAll(async () => {
    const launched = await launchWithMocking('app-bridge-install-flow', {
      mockResponses: [
        mockResponse(/Let's install Rebel Browser\./i, 'Install flow ready.'),
      ],
      skipOnboarding: true,
    });

    electronApp = launched.electronApp;
    userDataPath = launched.userDataPath;
    cleanup = launched.cleanup;
    window = await getFirstWindow(electronApp);
    await window.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    await waitForMainAppReady(window);
  });

  test.afterAll(async () => {
    await safeCloseApp(electronApp, 15_000, userDataPath);
    cleanup?.();
  });

  test('opens a fresh install conversation, renders the browser picker handoff, and shows the paired client back in Settings', async () => {
    await openRebelBrowserConnector(window);

    const installButton = window.locator('button:has-text("Install Rebel Browser")').last();
    await expect(installButton).toBeVisible();
    await installButton.click();

    const composer = window.locator('[data-testid="composer-input"]');
    await expect(composer).toBeVisible({ timeout: 15_000 });

    const userMessage = window.locator('article.agent-turn-message[data-role="user"]').last();
    await expect(userMessage).toContainText("Let's install Rebel Browser.", { timeout: 15_000 });
    await expect(userMessage).toContainText('rebel_bridge_start_pairing');

    const assistantOrResult = window.locator(
      'article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]'
    ).first();
    await expect(assistantOrResult).toBeVisible({ timeout: 15_000 });

    const turnId = await userMessage.getAttribute('data-turn-id');
    expect(turnId).toBeTruthy();

    await injectAgentEvent(electronApp, {
      turnId: turnId!,
      sessionId: null,
      event: {
        type: 'user_question',
        batchId: `app-bridge-install-${Date.now()}`,
        toolUseId: `app-bridge-install-tool-${Date.now()}`,
        timestamp: Date.now(),
        questions: [
          {
            id: 'choose-browser',
            header: 'Choose a browser',
            question: 'Which browser should I install Rebel Browser into?',
            multiSelect: false,
            options: [
              { id: 'chrome', label: 'Google Chrome', description: 'Detected on this device' },
              { id: 'brave', label: 'Brave', description: 'Also detected on this device' },
            ],
          },
        ],
      },
    });

    const questionCard = window.locator('[role="form"][aria-label="Rebel has a question"]');
    await expect(questionCard).toContainText('Which browser should I install Rebel Browser into?');
    await expect(questionCard).toContainText('Google Chrome');
    await expect(questionCard).toContainText('Brave');

    const pairing = await window.evaluate(async () => {
      const appBridgeApi = (window as typeof window & {
        appBridgeApi: {
          pairStart: (req: { appId?: string }) => Promise<{ code: string }>
        }
      }).appBridgeApi;
      return appBridgeApi.pairStart({ appId: 'browser-extension' });
    });
    await claimPairCode(userDataPath, pairing.code);

    await openRebelBrowserConnector(window);
    await expect(window.locator('text=Paired browsers')).toBeVisible();
    await expect(window.locator('text=browser-extension')).toBeVisible({ timeout: 15_000 });
  });

  test('shows both paired browsers after back-to-back pair claims', async () => {
    const pairings = await window.evaluate(async () => {
      const appBridgeApi = (window as typeof window & {
        appBridgeApi: {
          pairStart: (req: { appId?: string }) => Promise<{ code: string }>;
        };
      }).appBridgeApi;

      const first = await appBridgeApi.pairStart({ appId: 'browser-extension' });
      const second = await appBridgeApi.pairStart({ appId: 'browser-extension' });
      return { first, second };
    });

    await claimPairCode(userDataPath, pairings.first.code, 'chrome-one-client');
    await claimPairCode(userDataPath, pairings.second.code, 'brave-two-client');

    await openRebelBrowserConnector(window);
    await expect(window.locator('text=Paired browsers')).toBeVisible();
    await expect(window.locator('button[aria-label="Unpair chrome-one-client"]')).toBeVisible();
    await expect(window.locator('button[aria-label="Unpair brave-two-client"]')).toBeVisible();
  });

  // TODO(Chunk C): enable once pair completion auto-registers NMH manifests.
  test.skip('records NMH manifests after pairing', async () => {});

  // TODO(Chunk D): drive this with fake time in E2E if we need full-browser coverage.
  // Unit coverage lives in src/main/services/__tests__/appBridgeManager.test.ts.
  test.skip('expires stalled pairing approvals after the TTL', async () => {});
});
