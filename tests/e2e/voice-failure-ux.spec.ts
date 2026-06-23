/**
 * Voice Failure UX — Pending Audio Popover E2E Tests
 *
 * Tests the user experience when voice transcription fails:
 * - Pending audio trigger appears after failure
 * - Popover shows "Recording saved" header (not technical error)
 * - Category-specific subtext appears (billing, auth, etc.)
 * - Action buttons: reveal file, retry, dismiss, Open Settings
 *
 * Uses fake microphone (Chromium flags) + voice mock with error simulation.
 * No real API calls or audio hardware needed.
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  appExists,
  createIsolatedUserData,
  getAppNotFoundMessage,
  enableGuestMode,
  enableVoiceMocking,
  enableLlmMocking,
  launchWithIsolatedUserData,
  writeMinimalSettings,
  waitForMainAppReady,
  safeCloseApp,
  dismissStartupRecoveryDialogIfPresent,
  firstWindowTimeoutMs,
  PLATFORM,
  type IsolatedUserData,
} from './test-utils';

test.describe('Voice Failure UX — Pending Audio Popover', () => {
  test.skip(!appExists(), getAppNotFoundMessage());
  test.skip(PLATFORM === 'win32', 'Skipped on Windows: fake microphone setup unreliable in CI');
  test.describe.configure({ timeout: 180_000 });

  let electronApp: ElectronApplication;
  let window: Page;
  let isolated: IsolatedUserData;
  let testFailed = false;

  test.beforeAll(async () => {
    isolated = createIsolatedUserData('voice-failure-ux');

    // Seed settings with a fake voice API key so the mic button is enabled.
    // The mock replaces the actual API call, so the key doesn't need to be valid.
    writeMinimalSettings(isolated.path, {
      openaiApiKey: 'YOUR_OPENAI_KEY_HERE',
    });

    // Pass skipOnboarding: false so launchWithIsolatedUserData doesn't overwrite
    // our settings (which include the fake voice API key).
    electronApp = await launchWithIsolatedUserData(isolated, {
      skipOnboarding: false,
      additionalArgs: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    });

    // Install LLM mock early to prevent accidental real API calls during startup
    await enableLlmMocking(electronApp, {
      responses: [],
      defaultResponse: 'Mock response from E2E test.',
    });

    window = await electronApp.firstWindow({ timeout: firstWindowTimeoutMs() });
    await window.waitForLoadState('domcontentloaded');
    await enableGuestMode(window);
    await dismissStartupRecoveryDialogIfPresent(window);
    await waitForMainAppReady(window, 60000);

    // Install voice mock AFTER app is fully ready. The app's registerVoiceHandlers()
    // runs during startup inside app.whenReady() — installing the mock before that
    // completes causes the real handler to overwrite the mock. waitForMainAppReady
    // guarantees startup is finished so the mock sticks.
    await enableVoiceMocking(electronApp, {
      errorResponse: {
        message: 'Your voice provider account has run out of credits. Check your billing to continue.',
        category: 'billing',
      },
      debug: true,
    });
  }, { timeout: 180_000 });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== 'passed') {
      testFailed = true;
    }
  });

  test.afterAll(async () => {
    if (electronApp) await safeCloseApp(electronApp, 15000, isolated.path);
    if (!testFailed && !process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated?.cleanup();
    } else {
      console.log(`[E2E] Keeping test userData at: ${isolated?.path}`);
    }
  });

  test('shows pending audio popover with recovery UI after transcription failure', async () => {
    // Navigate to a conversation view where the mic button is available.
    // Brand Home shows a different input — need to start a new chat first.
    await test.step('Navigate to conversation', async () => {
      const newChatBtn = window.locator('[data-testid="new-chat-button"]');
      if (await newChatBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await newChatBtn.click();
        await window.waitForTimeout(500);
      }
      // Make sure we're in a session (interaction strip visible)
      await expect(window.locator('[data-testid="interaction-strip"]')).toBeVisible({ timeout: 10000 });
      console.log('[E2E] In conversation view');
    });

    // Step 1: Start inline mic recording
    await test.step('Start recording', async () => {
      const micButton = window.locator('[data-testid="unified-mic-button"]');
      await expect(micButton).toBeVisible({ timeout: 10000 });
      await micButton.click();
      // Wait for recording state (aria-label changes to include "Stop")
      await expect(micButton).toHaveAttribute('aria-label', /Stop/i, { timeout: 5000 });
      console.log('[E2E] Recording started');
    });

    // Step 2: Record briefly, then stop (triggers mock transcription error)
    await test.step('Stop recording (triggers failure)', async () => {
      // Record for 1.5s to ensure minimum blob size is met
      await window.waitForTimeout(1500);
      const micButton = window.locator('[data-testid="unified-mic-button"]');
      await micButton.click();
      console.log('[E2E] Recording stopped, transcription will fail via mock');
    });

    // Step 3: Wait for pending audio trigger to appear
    await test.step('Pending audio trigger appears', async () => {
      const trigger = window.locator('[data-testid="pending-audio-trigger"]');
      await expect(trigger).toBeVisible({ timeout: 15000 });
      console.log('[E2E] Pending audio trigger visible');
    });

    // Step 4: Open the popover
    await test.step('Open pending audio popover', async () => {
      const trigger = window.locator('[data-testid="pending-audio-trigger"]');
      await trigger.click();
      const popover = window.locator('[data-testid="pending-audio-popover"]');
      await expect(popover).toBeVisible({ timeout: 5000 });
      console.log('[E2E] Popover opened');
    });

    // Step 5: Verify "Recording saved" header (not "Transcription failed")
    await test.step('Header says "Recording saved"', async () => {
      const popover = window.locator('[data-testid="pending-audio-popover"]');
      await expect(popover.getByText('Recording saved')).toBeVisible();
    });

    // Step 6: Verify billing-specific subtext (mock sends [billing] category)
    await test.step('Shows billing category subtext', async () => {
      const popover = window.locator('[data-testid="pending-audio-popover"]');
      await expect(popover.getByText(/voice provider account needs attention/)).toBeVisible();
    });

    // Step 7: Verify file row with action buttons
    await test.step('File row has retry, reveal, and dismiss buttons', async () => {
      const row = window.locator('[data-testid="pending-audio-row"]').first();
      await expect(row).toBeVisible();
      await expect(row.locator('[data-testid="pending-audio-retry"]')).toBeVisible();
      await expect(row.locator('[data-testid="pending-audio-reveal"]')).toBeVisible();
      await expect(row.locator('[data-testid="pending-audio-dismiss"]')).toBeVisible();
    });

    // Step 8: Verify "Open Settings" button appears for auth/billing category
    await test.step('Open Settings button visible for auth/billing errors', async () => {
      const popover = window.locator('[data-testid="pending-audio-popover"]');
      await expect(popover.locator('[data-testid="pending-audio-open-settings"]')).toBeVisible();
    });

    // Step 9: Dismiss the recording and verify popover closes
    await test.step('Dismiss clears the recording', async () => {
      const dismissBtn = window.locator('[data-testid="pending-audio-dismiss"]').first();
      await dismissBtn.click();
      // Trigger should disappear since the only pending file was dismissed
      const trigger = window.locator('[data-testid="pending-audio-trigger"]');
      await expect(trigger).not.toBeVisible({ timeout: 5000 });
      console.log('[E2E] Recording dismissed, trigger gone');
    });
  });
});
