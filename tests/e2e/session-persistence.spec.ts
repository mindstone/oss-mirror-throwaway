/**
 * Session Persistence Tests
 *
 * Tests for session history persistence across app restarts.
 * Extracted from sequence-c.spec.ts.
 *
 * Launch config: Custom restart cycle, API keys required
 * Total: 1 test
 *
 * IMPORTANT: This test manages its own launch/restart cycle (launches, creates session,
 * closes, relaunches, verifies). Includes completeOnboardingIfPresent() and
 * skipLoginScreenIfPresent() helper functions copied from sequence-c.spec.ts.
 *
 * See: docs/plans/partway/260126_e2e_test_architecture_overhaul.md (Stage 2.2)
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import {
  appExists,
  createIsolatedUserData,
  createVerifiedTestSpaceFolder,
  dismissStartupRecoveryDialogIfPresent,
  enableGuestMode,
  getAppNotFoundMessage,
  getEscapeHatchShortcut,
  type IsolatedUserData,
  launchWithIsolatedUserData,
  PLATFORM,
  safeCloseApp,
  sendMessageAndWaitForResponse,
  waitForMainAppReady,
  waitForSuperMcpReady
} from './test-utils';

// Test credentials from environment variables
const TEST_CLAUDE_API_KEY = process.env.TEST_CLAUDE_API_KEY;
const TEST_OPENAI_API_KEY = process.env.TEST_OPENAI_API_KEY;
const TEST_ELEVENLABS_API_KEY = process.env.TEST_ELEVENLABS_API_KEY;
const TEST_VOICE_PROVIDER = TEST_OPENAI_API_KEY ? 'openai-whisper' : 'elevenlabs-scribe';
const TEST_VOICE_API_KEY = TEST_OPENAI_API_KEY || TEST_ELEVENLABS_API_KEY;
const TEST_WORKSPACE_DIR =
  process.env.TEST_WORKSPACE_DIR || path.join(os.tmpdir(), 'mindstone-rebel-test');
// Unique per test file to avoid cleanup conflicts with parallel workers
const TEST_SPACE_BASE = path.resolve(__dirname, '..', '..', 'tmp', `e2e-test-spaces-persistence-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const hasRequiredKeys = TEST_CLAUDE_API_KEY && TEST_VOICE_API_KEY;

test.skip(!appExists(), getAppNotFoundMessage());

async function completeOnboardingIfPresent(
  window: Page,
  app: ElectronApplication
): Promise<void> {
  const onboardingWizard = window.locator('[data-testid="onboarding-wizard"]');
  const isOnboarding = await onboardingWizard.isVisible({ timeout: 2000 }).catch(() => false);

  if (!isOnboarding) return;

  // Step 1: Welcome
  const letsCheckButton = window.locator('button:has-text("Let\'s check")');
  await expect(letsCheckButton).toBeVisible({ timeout: 5000 });
  await letsCheckButton.click({ noWaitAfter: true, force: true });
  const continueButton = window.locator('button:has-text("Continue")');
  await expect(continueButton).toBeVisible({ timeout: 90000 });
  await continueButton.click({ noWaitAfter: true, force: true });
  await expect(window.locator('[data-testid="onboarding-step-workspace"]')).toBeVisible({
    timeout: 15000
  });

  // Step 2: Workspace
  const workspaceInput = window.locator('#onboarding-core-dir');
  await expect(workspaceInput).toBeVisible({ timeout: 10000 });
  await workspaceInput.fill(TEST_WORKSPACE_DIR);
  const eulaCheckbox = window.locator('input[type="checkbox"]');
  await eulaCheckbox.click({ force: true });
  await expect(eulaCheckbox).toBeChecked({ timeout: 5000 });
  const checkingText = window.locator('text=Checking folder...');
  await checkingText.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  await expect(checkingText).toHaveCount(0, { timeout: 30000 });
  const continueBtn = window.locator('[data-testid="onboarding-continue-button"]');
  await continueBtn.click({ noWaitAfter: true });

  // Step 3: Shared Drives
  const driveHeading = window.locator('h2:has-text("Spaces & Shared Folders")');
  await expect(driveHeading).toBeVisible({ timeout: 15000 });

  const spaceFolder = await createVerifiedTestSpaceFolder(app, TEST_SPACE_BASE);
  await app.evaluate(async ({ dialog }, testPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [testPath]
    });
  }, spaceFolder);

  const addSpaceButton = window.locator('button:has-text("Add space")');
  await expect(addSpaceButton).toBeVisible({ timeout: 5000 });
  await addSpaceButton.click({ noWaitAfter: true });

  const chooseFolderButton = window.locator('button:has-text("Choose Folder")');
  await expect(chooseFolderButton).toBeVisible({ timeout: 5000 });
  await chooseFolderButton.click({ noWaitAfter: true });

  const nextButton = window.locator('button:has-text("Next")');
  await expect(nextButton).toBeEnabled({ timeout: 15000 });
  await nextButton.click({ noWaitAfter: true });
  const primaryButton = window
    .locator('button:has-text("Create Space"), button:has-text("Add Space")')
    .last();
  await expect(primaryButton).toBeEnabled({ timeout: 5000 });
  await primaryButton.click({ noWaitAfter: true });

  await expect(primaryButton).toBeHidden({ timeout: 10000 });
  const addSpaceDialog = window.locator('[role="dialog"][aria-modal="true"]').filter({
    hasText: /Create Space|Add Space|Choose Folder/
  });
  await expect(addSpaceDialog).toHaveCount(0, { timeout: 5000 });
  await window.locator('[data-testid="onboarding-continue-button"]').click({ noWaitAfter: true });
  // Wait for API keys step
  await expect(window.locator('#onboarding-claude-key')).toBeVisible({ timeout: 10000 });

  // Step 4: API Keys
  const claudeInput = window.locator('#onboarding-claude-key');
  await expect(claudeInput).toBeVisible({ timeout: 10000 });
  await claudeInput.fill(TEST_CLAUDE_API_KEY!);
  if (TEST_VOICE_PROVIDER === 'elevenlabs-scribe') {
    const voiceSelect = window.locator('#onboarding-voice-provider');
    await voiceSelect.selectOption('elevenlabs-scribe');
  }
  const voiceKeyInput =
    TEST_VOICE_PROVIDER === 'openai-whisper'
      ? window.locator('#onboarding-openai-key')
      : window.locator('#onboarding-elevenlabs-key');
  await voiceKeyInput.fill(TEST_VOICE_API_KEY!);

  // Wait for validation to complete (button becomes enabled)
  const apiKeyContinue = window.locator('[data-testid="onboarding-continue-button"]');
  await expect(apiKeyContinue).toBeEnabled({ timeout: 90000 });
  await apiKeyContinue.click({ noWaitAfter: true });
  // Wait for next step to be visible
  await expect(window.locator('[data-testid="onboarding-step-toolAuth"]')).toBeVisible({
    timeout: 15000
  });

  // Skip remaining steps
  await window.keyboard.press(getEscapeHatchShortcut());
  const dialogTitle = window.locator('text=Skip setup?');
  await expect(dialogTitle).toBeVisible({ timeout: 5000 });
  await window.locator('button:has-text("Skip anyway")').click({ noWaitAfter: true });
  // Wait for onboarding to close and main app to be ready
  await waitForMainAppReady(window);
  await waitForSuperMcpReady(window);
}

async function skipLoginScreenIfPresent(window: Page): Promise<void> {
  await enableGuestMode(window);
}

async function ensureConversationPaneVisible(window: Page): Promise<void> {
  await dismissStartupRecoveryDialogIfPresent(window);
  await waitForMainAppReady(window);
}

// ============================================================================
// Session History Persistence Test
// ============================================================================
test.describe('Session History Persistence', () => {
  test.skip(PLATFORM === 'win32', 'Skipped on Windows: app launch timeout in CI');
  test.skip(!hasRequiredKeys, 'Skipping - TEST_CLAUDE_API_KEY and voice key not set');

  let uniqueSessionMarker: string;
  let isolated: IsolatedUserData;
  let testFailed = false;

  test.beforeAll(async () => {
    isolated = createIsolatedUserData('session-persistence');
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== 'passed') {
      testFailed = true;
    }
  });

  test.afterAll(async () => {
    if (!testFailed && !process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated?.cleanup();
    } else {
      console.log(`[DEBUG] Keeping test userData at: ${isolated?.path}`);
    }
  });

  // SKIPPED: Two blockers — (1) strict mode violation from ambiguous selectors,
  // (2) app restart timing issues (needs I.7 restart helper from 260404 plan).
  // See: docs/plans/260404_test_infrastructure_investments.md (Phase B, I.7)
  test.skip('persists session and restores from history after app restart', async () => {
    test.setTimeout(300_000);

    uniqueSessionMarker = `HistoryTest_${Date.now()}`;

    // --- PHASE 1: Create a session with unique content ---
    let app = await launchWithIsolatedUserData(isolated, {
      additionalArgs: []
    });
    let window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    // Wait for app to fully initialize (legitimate app startup wait)
    await expect(window.locator('body')).toBeVisible({ timeout: 30000 });

    await skipLoginScreenIfPresent(window);
    await completeOnboardingIfPresent(window, app);

    await ensureConversationPaneVisible(window);

    const newChatButton = window.locator('[data-testid="new-chat-button"]');
    await expect(newChatButton).toBeVisible({ timeout: 10000 });
    await newChatButton.click();
    // Wait for message list to be empty (new session has no messages)
    await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

    const firstResponse = await sendMessageAndWaitForResponse(
      window,
      `My unique session marker is: ${uniqueSessionMarker}. Please confirm by saying "Confirmed: ${uniqueSessionMarker}"`
    );

    expect(firstResponse).toContain(uniqueSessionMarker);

    const sidebarSession = window.locator('[data-testid="session-sidebar"] button').filter({
      hasText: 'HistoryTest'
    });
    await expect(sidebarSession).toBeVisible({ timeout: 10000 });

    const newChatAfter = window.locator('[data-testid="new-chat-button"]');
    await newChatAfter.click();
    // Wait for message list to be empty (new session has no messages)
    await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });
    // Allow time for session to persist to disk (legitimate disk I/O wait)
    await new Promise((resolve) => setTimeout(resolve, 5000));

    await safeCloseApp(app, 15000, isolated.path);
    // Allow time for app to fully close before relaunching (legitimate process cleanup)
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // --- PHASE 2: Reopen app and find session in history ---
    const app2 = await launchWithIsolatedUserData(isolated, {
      additionalArgs: []
    });
    const window2 = await app2.firstWindow();
    await window2.waitForLoadState('domcontentloaded');
    // Wait for app to fully initialize (legitimate app startup wait)
    await expect(window2.locator('body')).toBeVisible({ timeout: 30000 });

    await skipLoginScreenIfPresent(window2);
    await completeOnboardingIfPresent(window2, app2);

    await ensureConversationPaneVisible(window2);

    const sessionSidebar = window2.locator('[data-testid="session-sidebar"]');
    await expect(sessionSidebar).toBeVisible({ timeout: 15000 });

    const sessionButton = sessionSidebar.locator('button').filter({ hasText: 'HistoryTest' }).first();
    await expect(sessionButton).toBeVisible({ timeout: 60000 });
    await sessionButton.click();
    // Wait for session messages to load
    await expect(window2.locator('article.agent-turn-message')).toBeVisible({ timeout: 15000 });

    // --- PHASE 3: Verify messages are restored ---
    const userMessage = window2
      .locator('article.agent-turn-message')
      .filter({
        hasText: 'You'
      })
      .filter({
        hasText: uniqueSessionMarker
      })
      .first();
    await expect(userMessage).toBeVisible({ timeout: 10000 });

    const assistantMessage = window2
      .locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]')
      .filter({ hasText: 'Confirmed' })
      .first();
    await expect(assistantMessage).toBeVisible({ timeout: 10000 });

    // --- PHASE 4: Send follow-up to verify context is preserved ---
    const followUpResponse = await sendMessageAndWaitForResponse(
      window2,
      'What was my unique session marker? Just repeat it.'
    );

    expect(followUpResponse).toContain(uniqueSessionMarker);

    await safeCloseApp(app2, 15000, isolated.path);
  });
});
