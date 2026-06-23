/**
 * Message Queue Tests
 *
 * Tests for the message queue UI and queued message handling.
 * Extracted from sequence-b.spec.ts (Phases 2, 12).
 *
 * Launch config: skipOnboarding: true, API keys required
 * Total: 7 tests
 *
 * See: docs/plans/partway/260126_e2e_test_architecture_overhaul.md (Stage 2.2)
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  appExists,
  createIsolatedUserData,
  dismissStartupRecoveryDialogIfPresent,
  enableGuestMode,
  expectComposerText,
  getAppNotFoundMessage,
  type IsolatedUserData,
  launchWithIsolatedUserData,
  PLATFORM,
  resetAppState,
  safeCloseApp,
  sendMessageAndWaitForResponse,
  switchToTextMode,
  waitForMainAppReady,
  waitForSuperMcpReady
} from './test-utils';

// Test credentials from environment variables
const TEST_CLAUDE_API_KEY = process.env.TEST_CLAUDE_API_KEY;
const TEST_OPENAI_API_KEY = process.env.TEST_OPENAI_API_KEY;
const TEST_ELEVENLABS_API_KEY = process.env.TEST_ELEVENLABS_API_KEY;
const TEST_VOICE_API_KEY = TEST_OPENAI_API_KEY || TEST_ELEVENLABS_API_KEY;

const hasRequiredKeys = TEST_CLAUDE_API_KEY && TEST_VOICE_API_KEY;

test.skip(!appExists(), getAppNotFoundMessage());

// ============================================================================
// Test State & Lifecycle
// ============================================================================

let app: ElectronApplication;
let window: Page;
let userDataPath: string;
let isolated: IsolatedUserData;
let testCount = 0;
let failures: string[] = [];

// Note: writeMinimalSettings is handled by launchWithIsolatedUserData when skipOnboarding: true
// API keys are automatically seeded from environment variables (TEST_CLAUDE_API_KEY, etc.)

test.describe('Message Queue Tests', () => {
  test.skip(PLATFORM === 'win32', 'Skipped on Windows: app launch timeout in CI');
  // 15 minutes for full test suite
  test.describe.configure({ timeout: 900_000 });

  test.beforeAll(async () => {
    console.log('[E2E] [message-queue] ========== TEST SUITE START ==========');
    console.log('[E2E] [message-queue] Launching app for message queue tests');
    const startTime = Date.now();

    // Create isolated userData
    isolated = createIsolatedUserData('message-queue');
    userDataPath = isolated.path;
    // Settings are automatically seeded by launchWithIsolatedUserData when skipOnboarding: true

    app = await launchWithIsolatedUserData(isolated, {
      skipOnboarding: true
    });
    window = await app.firstWindow();

    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);
    await waitForSuperMcpReady(window);

    console.log(`[E2E] [message-queue] App launched in ${Date.now() - startTime}ms`);
    console.log(`[E2E] [message-queue] userData: ${userDataPath}`);
  });

  test.afterAll(async () => {
    console.log('[E2E] [message-queue] ========== TEST SUITE END ==========');
    console.log(`[E2E] [message-queue] Tests run: ${testCount}`);
    console.log(`[E2E] [message-queue] Failures: ${failures.length}`);
    if (failures.length > 0) {
      console.log(`[E2E] [message-queue] Failed tests: ${failures.join(', ')}`);
    }
    await safeCloseApp(app, 15000, userDataPath);

    if (failures.length === 0 && !process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated?.cleanup();
    } else {
      console.log(`[DEBUG] Keeping test userData at: ${userDataPath}`);
    }
  });

  test.beforeEach(async ({}, testInfo) => {
    testCount++;
    const testId = `${testCount}/${testInfo.title}`;
    console.log(`[E2E] [test:start] [${testId}] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
    console.log(`[E2E] [test:start] [${testId}] File: ${testInfo.file}`);
    console.log(`[E2E] [test:start] [${testId}] Previous failures: ${failures.length}`);
  });

  test.afterEach(async ({}, testInfo) => {
    const testId = `${testCount}/${testInfo.title}`;
    const status = testInfo.status || 'unknown';
    const duration = testInfo.duration || 0;

    console.log(`[E2E] [test:end] [${testId}] Status: ${status}, Duration: ${duration}ms`);

    if (status === 'failed' || status === 'timedOut') {
      failures.push(testInfo.title);
      console.log(`[E2E] [test:end] [${testId}] FAILURE - capturing diagnostics`);

      const screenshotPath = `test-results/message-queue-${testCount}-failure.png`;
      await window.screenshot({ path: screenshotPath }).catch(() => {});
      console.log(`[E2E] [test:end] [${testId}] Screenshot: ${screenshotPath}`);

      const url = window.url();
      console.log(`[E2E] [test:end] [${testId}] URL: ${url}`);

      const recoveryDialog = await window
        .locator('[data-testid="startup-recovery-dialog"]')
        .isVisible()
        .catch(() => false);
      const stopButton = await window
        .locator('[data-testid="stop-turn-button"]')
        .isVisible()
        .catch(() => false);
      console.log(`[E2E] [test:end] [${testId}] Recovery dialog visible: ${recoveryDialog}`);
      console.log(`[E2E] [test:end] [${testId}] Stop button visible (agent active): ${stopButton}`);

      if (testInfo.error) {
        console.log(`[E2E] [test:end] [${testId}] Error: ${testInfo.error.message}`);
      }
    }

    console.log(`[E2E] [test:end] [${testId}] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<`);
  });

  // ==========================================================================
  // Message Queue UI Tests (Phase 2)
  // ==========================================================================
  test.describe('Message Queue UI', () => {
    test.skip(!hasRequiredKeys, 'Skipping - TEST_CLAUDE_API_KEY and voice key not set');

    test.beforeEach(async ({}, testInfo) => {
      await resetAppState(window, testInfo.title);
    });

    test('shows Queue button when agent is busy with text typed', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await switchToTextMode(window);
      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.fill('Write a detailed 500 word essay about the history of computing.');

      const sendButton = window.locator(
        '[data-testid="composer-send-button"], [data-testid="send-now-button"]'
      );
      await sendButton.click();

      const stopButton = window.locator('[data-testid="stop-turn-button"]');
      await expect(stopButton).toBeVisible({ timeout: 10000 });

      await textInput.fill('Follow-up question');

      const sendNowButton = window.locator('[data-testid="send-now-button"]');
      const queueButton = window.locator('[data-testid="send-queue-button"]');

      await expect(sendNowButton).toBeVisible({ timeout: 5000 });
      await expect(queueButton).toBeVisible({ timeout: 5000 });

      // Cleanup: stop the running turn. Don't fail the test if cancellation is slow —
      // the actual assertions (Queue/SendNow visible) already passed. resetAppState()
      // in beforeEach of the next test handles any lingering turns.
      await textInput.clear();
      await stopButton.click().catch(() => {});
    });

    // Unskipped: cleanup stop is now non-blocking (resetAppState handles lingering turns)
    test('clicking Queue adds message to tray', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await switchToTextMode(window);
      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.fill('Write a 300 word analysis of AI trends. Take your time.');

      const sendButton = window.locator(
        '[data-testid="composer-send-button"], [data-testid="send-now-button"]'
      );
      await sendButton.click();

      const stopButton = window.locator('[data-testid="stop-turn-button"]');
      await expect(stopButton).toBeVisible({ timeout: 10000 });

      const queuedText = `Queued message ${Date.now()}`;
      await textInput.fill(queuedText);

      const queueButton = window.locator('[data-testid="send-queue-button"]');
      await expect(queueButton).toBeVisible({ timeout: 5000 });
      await queueButton.click();

      const tray = window.locator('[data-testid="queued-messages-tray"]');
      await expect(tray).toBeVisible({ timeout: 5000 });
      await expect(tray).toContainText(queuedText);

      // Cleanup: stop the running turn. Don't fail the test if cancellation is slow —
      // the actual assertions (tray visible + queued text) already passed.
      // resetAppState() in beforeEach of the next test handles any lingering turns.
      await textInput.clear();
      await stopButton.click().catch(() => {});
    });

    test('can remove message from queue via tray', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await switchToTextMode(window);
      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.fill('Explain quantum computing in detail. Take your time.');

      const sendButton = window.locator(
        '[data-testid="composer-send-button"], [data-testid="send-now-button"]'
      );
      await sendButton.click();

      const stopButton = window.locator('[data-testid="stop-turn-button"]');
      await expect(stopButton).toBeVisible({ timeout: 10000 });

      await textInput.fill('Message to remove');
      const queueButton = window.locator('[data-testid="send-queue-button"]');
      await queueButton.click();

      const tray = window.locator('[data-testid="queued-messages-tray"]');
      await expect(tray).toBeVisible({ timeout: 5000 });

      const removeButton = tray.locator('button[aria-label^="Remove queued message"]').first();
      await expect(removeButton).toBeVisible({ timeout: 5000 });
      await removeButton.click();

      await expect(tray).toBeHidden({ timeout: 5000 });

      await stopButton.click();
      // Wait for stop button to disappear (turn cancelled)
      await expect(window.locator('[data-testid="stop-turn-button"]')).not.toBeVisible({ timeout: 30000 });
    });

    test('Removing queued messages one by one hides the tray', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await switchToTextMode(window);
      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.fill('Explain the history of the internet in detail.');

      const sendButton = window.locator(
        '[data-testid="composer-send-button"], [data-testid="send-now-button"]'
      );
      await sendButton.click();

      const stopButton = window.locator('[data-testid="stop-turn-button"]');
      await expect(stopButton).toBeVisible({ timeout: 10000 });

      const queueButton = window.locator('[data-testid="send-queue-button"]');

      const tray = window.locator('[data-testid="queued-messages-tray"]');

      await textInput.fill('First queued message');
      await queueButton.click();
      await expect(tray).toContainText('First queued message', { timeout: 5000 });

      await textInput.fill('Second queued message');
      await queueButton.click();
      await expect(tray).toContainText('Second queued message', { timeout: 5000 });

      const removeButtons = tray.locator('[data-testid^="queued-message-remove-"]');
      await expect(removeButtons).toHaveCount(2, { timeout: 5000 });
      await removeButtons.nth(0).click();
      await expect(removeButtons).toHaveCount(1, { timeout: 5000 });
      await removeButtons.nth(0).click();

      await expect(tray).toBeHidden({ timeout: 5000 });

      await stopButton.click();
      // Wait for stop button to disappear (turn cancelled)
      await expect(window.locator('[data-testid="stop-turn-button"]')).not.toBeVisible({ timeout: 30000 });
    });
  });

  // ==========================================================================
  // Extended Message Queue Tests (Phase 12)
  // ==========================================================================
  test.describe('Extended Message Queue', () => {
    test.skip(!hasRequiredKeys, 'Skipping - TEST_CLAUDE_API_KEY and voice key not set');

    test.beforeEach(async ({}, testInfo) => {
      await resetAppState(window, testInfo.title);
    });

    test('queued message is sent after current turn completes', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await switchToTextMode(window);
      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.fill('Say "First response" and nothing else.');

      const sendButton = window.locator(
        '[data-testid="composer-send-button"], [data-testid="send-now-button"]'
      );
      await sendButton.click();

      const stopButton = window.locator('[data-testid="stop-turn-button"]');
      await expect(stopButton).toBeVisible({ timeout: 10000 });

      const queuedMarker = `QueuedMarker_${Date.now()}`;
      await textInput.fill(`Say "${queuedMarker}" and nothing else.`);

      const queueButton = window.locator('[data-testid="send-queue-button"]');
      await expect(queueButton).toBeVisible({ timeout: 5000 });
      await queueButton.click();

      const tray = window.locator('[data-testid="queued-messages-tray"]');
      await expect(tray).toBeVisible({ timeout: 5000 });

      await expect(tray).toBeHidden({ timeout: 120000 });

      // Verify the queued message was sent as a user message
      const userMessages = window.locator('article.agent-turn-message[data-role="user"]');
      await expect(userMessages).toHaveCount(2, { timeout: 30000 });
      await expect(userMessages.nth(1)).toContainText(queuedMarker);

      // Verify an assistant response was generated for the queued message
      // Use assistant+result union selector: completed turns promote messages to data-role="result"
      const responseMessages = window.locator(
        'article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]'
      );
      const lastResponse = responseMessages.last();
      await expect(lastResponse).toContainText(queuedMarker, { timeout: 120000 });
    });

    // Unskipped: cleanup stop is now non-blocking (resetAppState handles lingering turns)
    test('keyboard shortcut Alt+Enter queues message', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await switchToTextMode(window);
      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.fill('Write about machine learning basics. Take your time.');

      const sendButton = window.locator(
        '[data-testid="composer-send-button"], [data-testid="send-now-button"]'
      );
      await sendButton.click();

      const stopButton = window.locator('[data-testid="stop-turn-button"]');
      await expect(stopButton).toBeVisible({ timeout: 10000 });

      await textInput.fill('Keyboard shortcut test');
      await expectComposerText(window, 'Keyboard shortcut test', { timeout: 5000 });

      await textInput.focus();
      await window.keyboard.press('Alt+Enter');
      const tray = window.locator('[data-testid="queued-messages-tray"]');
      await expect(tray).toBeVisible({ timeout: 10000 });

      // Cleanup: non-blocking stop. resetAppState() in next test handles lingering turns.
      await textInput.clear();
      await stopButton.click().catch(() => {});
    });

    test('Send Now button in tray sends queued message immediately', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await switchToTextMode(window);
      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.fill('Write a brief explanation of photosynthesis.');

      const sendButton = window.locator(
        '[data-testid="composer-send-button"], [data-testid="send-now-button"]'
      );
      await sendButton.click();

      const stopButton = window.locator('[data-testid="stop-turn-button"]');
      await expect(stopButton).toBeVisible({ timeout: 10000 });

      const queueMarker = `SendNowTest_${Date.now()}`;
      await textInput.fill(`${queueMarker}: follow-up question`);

      const queueButton = window.locator('[data-testid="send-queue-button"]');
      await expect(queueButton).toBeVisible({ timeout: 5000 });
      await queueButton.click();

      const tray = window.locator('[data-testid="queued-messages-tray"]');
      await expect(tray).toBeVisible({ timeout: 10000 });
      await expect(tray).toContainText(queueMarker, { timeout: 5000 });

      const sendNowInTray = tray
        .locator('button[data-testid^="queued-message-send-now-"]')
        .first();
      await expect(sendNowInTray).toBeVisible({ timeout: 10000 });
      await sendNowInTray.click();

      // Two-step confirmation (added in 02cdd917f, 2026-05-25): the per-message
      // Send Now icon ARMS a confirmation; the explicit "Interrupt & send" button
      // performs the send. Clicking the icon alone no longer hides the tray.
      const confirmSendInTray = tray
        .locator('button[data-testid^="queued-message-confirm-send-"]')
        .first();
      await expect(confirmSendInTray).toBeVisible({ timeout: 10000 });
      await confirmSendInTray.click();

      await expect(tray).toBeHidden({ timeout: 10000 });

      // Wait for the agent turn to start (stop button appears) - prevents false positive if click was ignored
      await expect(window.locator('[data-testid="stop-turn-button"]')).toBeVisible({
        timeout: 30000
      });

      // Wait for streaming to complete (stop button disappears)
      await expect(window.locator('[data-testid="stop-turn-button"]')).not.toBeVisible({
        timeout: 60000
      });

      // Now assert user message - use role-based selector instead of text-based 'You'
      // See: docs/plans/finished/260129_fix_mac_e2e_ci_failures.md, WHY_E2E_TESTS_ARE_HARD_TO_FIX.md Entry #18
      const userMessageWithMarker = window
        .locator('article.agent-turn-message[data-role="user"]')
        .filter({ hasText: queueMarker });
      await expect(userMessageWithMarker).toBeVisible({ timeout: 10000 });
    });
  });
});
