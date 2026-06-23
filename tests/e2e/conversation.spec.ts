/**
 * Conversation Tests (Multi-turn, Editing, Stop/Interrupt, Copy, Extended Features)
 *
 * Extracted from:
 * - sequence-b.spec.ts Phase 3: Multi-turn Conversations
 * - sequence-b.spec.ts Phase 4: Message Editing
 * - sequence-b.spec.ts Phase 5: Stop/Interrupt
 * - sequence-b.spec.ts Phase 6: Copy Message
 * - sequence-b.spec.ts Phase 7: Extended Conversation Features
 *
 * See: docs/plans/partway/260126_e2e_test_architecture_overhaul.md (Stage 2.2)
 *
 * Total: 11 tests
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  appExists,
  createIsolatedUserData,
  enableGuestMode,
  getAppNotFoundMessage,
  type IsolatedUserData,
  launchWithIsolatedUserData,
  PLATFORM,
  resetAppState,
  safeCloseApp,
  sendMessageAndWaitForResponse,
  switchToTextMode,
  waitForMainAppReady,
  waitForSuperMcpReady,
  writeMinimalSettings
} from './test-utils';

// Test credentials from environment variables
const TEST_CLAUDE_API_KEY = process.env.TEST_CLAUDE_API_KEY;
const TEST_OPENAI_API_KEY = process.env.TEST_OPENAI_API_KEY;
const TEST_ELEVENLABS_API_KEY = process.env.TEST_ELEVENLABS_API_KEY;
const TEST_VOICE_API_KEY = TEST_OPENAI_API_KEY || TEST_ELEVENLABS_API_KEY;
const hasRequiredKeys = TEST_CLAUDE_API_KEY && TEST_VOICE_API_KEY;

test.skip(!appExists(), getAppNotFoundMessage());

// ============================================================================
// Suite State & Lifecycle
// ============================================================================

let app: ElectronApplication;
let window: Page;
let isolated: IsolatedUserData;
let testCount = 0;
let failures: string[] = [];

test.describe('Conversation Tests', () => {
  test.skip(PLATFORM === 'win32', 'Skipped on Windows: app launch timeout in CI');
  test.describe.configure({ timeout: 660_000 }); // 11 minutes for multi-turn tests

  test.beforeAll(async () => {
    console.log('[E2E] [conversation] ========== SUITE START ==========');
    const startTime = Date.now();

    isolated = createIsolatedUserData('conversation');
    writeMinimalSettings(isolated.path, {
      claudeApiKey: TEST_CLAUDE_API_KEY,
      openaiApiKey: TEST_OPENAI_API_KEY,
      elevenlabsApiKey: TEST_ELEVENLABS_API_KEY,
    });

    app = await launchWithIsolatedUserData(isolated, {
      skipOnboarding: true
    });
    window = await app.firstWindow();

    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);
    await waitForSuperMcpReady(window);

    console.log(`[E2E] [conversation] App launched in ${Date.now() - startTime}ms`);
    console.log(`[E2E] [conversation] userData: ${isolated.path}`);
  });

  test.afterAll(async () => {
    console.log('[E2E] [conversation] ========== SUITE END ==========');
    console.log(`[E2E] [conversation] Tests run: ${testCount}`);
    console.log(`[E2E] [conversation] Failures: ${failures.length}`);
    if (failures.length > 0) {
      console.log(`[E2E] [conversation] Failed tests: ${failures.join(', ')}`);
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
    console.log(`[E2E] [test:start] File: ${testInfo.file}`);
    await resetAppState(window, testInfo.title);
  });

  test.afterEach(async ({}, testInfo) => {
    const status = testInfo.status || 'unknown';
    const duration = testInfo.duration || 0;
    console.log(`[E2E] [test:end] [${testCount}/${testInfo.title}] Status: ${status}, Duration: ${duration}ms`);

    if (status === 'failed' || status === 'timedOut') {
      failures.push(testInfo.title);
      console.log(`[E2E] [test:end] FAILURE - capturing diagnostics`);

      const screenshotPath = `test-results/conversation-${testCount}-failure.png`;
      await window.screenshot({ path: screenshotPath }).catch(() => {});

      const url = window.url();
      console.log(`[E2E] [test:end] URL: ${url}`);

      const recoveryDialog = await window.locator('[data-testid="startup-recovery-dialog"]').isVisible().catch(() => false);
      const stopButton = await window.locator('[data-testid="stop-turn-button"]').isVisible().catch(() => false);
      console.log(`[E2E] [test:end] Recovery dialog visible: ${recoveryDialog}`);
      console.log(`[E2E] [test:end] Stop button visible (agent active): ${stopButton}`);

      if (testInfo.error) {
        console.log(`[E2E] [test:end] Error: ${testInfo.error.message}`);
      }
    }
  });

  // ==========================================================================
  // Multi-turn Conversations (from sequence-b Phase 3)
  // ==========================================================================
  test.describe('Multi-turn Conversations', () => {
    test.skip(!hasRequiredKeys, 'Skipping - TEST_CLAUDE_API_KEY and voice key not set');

    test('maintains context across multiple turns', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await expect(newChatButton).toBeVisible({ timeout: 10000 });
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      const uniqueNumber = Date.now() % 10000;
      const firstResponse = await sendMessageAndWaitForResponse(
        window,
        `The magic number for this conversation is ${uniqueNumber}. Just say "Got it, the number is ${uniqueNumber}" - nothing else, no need to store it.`
      );

      expect(firstResponse).toContain(String(uniqueNumber));

      // Diagnostic: capture message state between turns to debug context loss
      // TODO(e2e-diag): Remove after confirming SESSION_NOT_FOUND theory
      const messageCountAfterTurn1 = await window.locator('article.agent-turn-message').count();
      const assistantCountAfterTurn1 = await window.locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]').count();
      console.log(`[E2E] [diag] Multi-turn context: after turn 1 — messages=${messageCountAfterTurn1}, assistantMessages=${assistantCountAfterTurn1}`);

      const secondResponse = await sendMessageAndWaitForResponse(
        window,
        `What was the magic number I mentioned? Just say the number.`
      );

      // Diagnostic: log both responses for post-mortem analysis
      // TODO(e2e-diag): Remove after confirming SESSION_NOT_FOUND theory
      const messageCountAfterTurn2 = await window.locator('article.agent-turn-message').count();
      console.log(`[E2E] [diag] Multi-turn context: after turn 2 — messages=${messageCountAfterTurn2}`);
      console.log(`[E2E] [diag] Multi-turn context: turn 1 response (first 200 chars): ${firstResponse.substring(0, 200)}`);
      console.log(`[E2E] [diag] Multi-turn context: turn 2 response (first 200 chars): ${secondResponse.substring(0, 200)}`);

      expect(secondResponse).toContain(String(uniqueNumber));
    });
  });

  // ==========================================================================
  // Message Editing (from sequence-b Phase 4)
  // ==========================================================================
  test.describe('Message Editing', () => {
    test.skip(!hasRequiredKeys, 'Skipping - TEST_CLAUDE_API_KEY and voice key not set');

    test('shows edit button on user message hover', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await sendMessageAndWaitForResponse(window, 'Say "Hello" and nothing else.');

      const userMessage = window.locator('article.agent-turn-message').filter({ hasText: 'You' }).last();
      await userMessage.scrollIntoViewIfNeeded();
      await userMessage.hover();
      // Wait for edit button to become visible after hover
      const editButton = userMessage.locator('[data-testid="message-edit-button"]');
      await expect(editButton).toBeVisible({ timeout: 5000 });
    });
  });

  // ==========================================================================
  // Stop/Interrupt (from sequence-b Phase 5)
  // ==========================================================================
  test.describe('Stop/Interrupt', () => {
    test.skip(!hasRequiredKeys, 'Skipping - TEST_CLAUDE_API_KEY and voice key not set');

    test('stop button appears when agent is working', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await switchToTextMode(window);
      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.fill('Write a 500 word essay about the history of computing.');

      const sendButton = window.locator('[data-testid="composer-send-button"], [data-testid="send-now-button"]');
      await sendButton.click();

      const stopButton = window.locator('[data-testid="stop-turn-button"]');
      await expect(stopButton).toBeVisible({ timeout: 10000 });

      await expect(stopButton).toBeHidden({ timeout: 120000 });
    });

    test('stop button not visible when agent is idle', async () => {
      const stopButton = window.locator('[data-testid="stop-turn-button"]');
      await expect(stopButton).toBeHidden({ timeout: 5000 });
    });
  });

  // ==========================================================================
  // Copy Message (from sequence-b Phase 6)
  // ==========================================================================
  test.describe('Copy Message', () => {
    test.skip(!hasRequiredKeys, 'Skipping - TEST_CLAUDE_API_KEY and voice key not set');

    test('copy button appears on message hover', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await sendMessageAndWaitForResponse(window, 'Say "Hello World" and nothing else.');

      const assistantMessage = window
        .locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]')
        .last();
      await assistantMessage.scrollIntoViewIfNeeded();
      await assistantMessage.hover();
      // Wait for copy button to become visible after hover
      const copyButton = assistantMessage.locator('[data-testid="message-copy-button"]');
      await expect(copyButton).toBeVisible({ timeout: 5000 });
    });

    test('copy button copies message content to clipboard', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await sendMessageAndWaitForResponse(
        window,
        'What is 2 + 2? Give me just the number.'
      );

      const assistantMessage = window
        .locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]')
        .last();
      await assistantMessage.scrollIntoViewIfNeeded();
      await assistantMessage.hover();
      // Wait for copy button to become visible after hover
      const copyButton = assistantMessage.locator('[data-testid="message-copy-button"]');
      await expect(copyButton).toBeVisible({ timeout: 5000 });
      await copyButton.click();
      // Wait for clipboard to be updated
      await expect(async () => {
        const clipboardContent = await app.evaluate(({ clipboard }) => clipboard.readText());
        expect(clipboardContent).toContain('4');
      }).toPass({ timeout: 5000 });

      const clipboardContent = await app.evaluate(({ clipboard }) => clipboard.readText());
      expect(clipboardContent).toContain('4');
    });
  });

  // ==========================================================================
  // Extended Conversation Features (from sequence-b Phase 7)
  // ==========================================================================
  test.describe('Extended Conversation Features', () => {
    test.skip(!hasRequiredKeys, 'Skipping - TEST_CLAUDE_API_KEY and voice key not set');

    test('handles three consecutive turns with context', async () => {
      test.setTimeout(660_000);

      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      const resp1 = await sendMessageAndWaitForResponse(
        window,
        'I will give you 3 numbers. First: 42. Just say "Got 42" - nothing else.'
      );

      // Diagnostic: log message state between turns
      // TODO(e2e-diag): Remove after confirming SESSION_NOT_FOUND theory
      const count1 = await window.locator('article.agent-turn-message').count();
      console.log(`[E2E] [diag] 3-turn context: after turn 1 — messages=${count1}, resp="${resp1.substring(0, 100)}"`);

      const resp2 = await sendMessageAndWaitForResponse(window, 'Second: 73. Just say "Got 73"');
      const count2 = await window.locator('article.agent-turn-message').count();
      console.log(`[E2E] [diag] 3-turn context: after turn 2 — messages=${count2}, resp="${resp2.substring(0, 100)}"`);

      const resp3 = await sendMessageAndWaitForResponse(window, 'Third: 99. Just say "Got 99"');
      const count3 = await window.locator('article.agent-turn-message').count();
      console.log(`[E2E] [diag] 3-turn context: after turn 3 — messages=${count3}, resp="${resp3.substring(0, 100)}"`);

      const finalResponse = await sendMessageAndWaitForResponse(
        window,
        'List all 3 numbers I gave you, in order, separated by commas.'
      );
      console.log(`[E2E] [diag] 3-turn context: final response (first 200 chars): ${finalResponse.substring(0, 200)}`);

      expect(finalResponse).toContain('42');
      expect(finalResponse).toContain('73');
      expect(finalResponse).toContain('99');
    });

    test('editing message truncates and regenerates response', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      const originalMarker = `Original_${Date.now()}`;
      await sendMessageAndWaitForResponse(
        window,
        `Say "Received: ${originalMarker}" and nothing else.`
      );

      const originalResponse = window
        .locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]')
        .last();
      await expect(originalResponse).toContainText(originalMarker);

      const userMessage = window.locator('article.agent-turn-message').filter({ hasText: 'You' }).last();
      await userMessage.scrollIntoViewIfNeeded();
      await userMessage.hover();
      // Wait for edit button to become visible after hover
      const editButton = userMessage.locator('[data-testid="message-edit-button"]');
      await expect(editButton).toBeVisible({ timeout: 5000 });
      await editButton.click();

      const editedMarker = `Edited_${Date.now()}`;
      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.clear();
      await textInput.fill(`Say "Received: ${editedMarker}" and nothing else.`);

      const saveButton = window.locator('button:has-text("Save & re-run")');
      await saveButton.click();

      // Legitimate: Wait for edit/re-run flow to complete (no stop button during edit regeneration)
      await window.waitForTimeout(2000);
      const newResponse = window
        .locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]')
        .last();
      await expect(newResponse).toBeVisible({ timeout: 60000 });
      await expect(newResponse).toContainText(editedMarker);

      const allMessages = await window.locator('article.agent-turn-message').all();
      let foundOriginal = false;
      for (const msg of allMessages) {
        const text = await msg.textContent();
        if (text?.includes(originalMarker)) {
          foundOriginal = true;
          break;
        }
      }
      expect(foundOriginal).toBe(false);
    });

    test('cancelling edit with Escape restores original state', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      const marker = `CancelTest_${Date.now()}`;
      await sendMessageAndWaitForResponse(window, `Say "Got: ${marker}" and nothing else.`);

      const userMessage = window.locator('article.agent-turn-message').filter({ hasText: 'You' }).last();
      await userMessage.scrollIntoViewIfNeeded();
      await userMessage.hover();
      // Wait for edit button to become visible after hover
      const editButton = userMessage.locator('[data-testid="message-edit-button"]');
      await expect(editButton).toBeVisible({ timeout: 5000 });
      await editButton.click();

      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.clear();
      await textInput.fill('This should be cancelled');

      await window.keyboard.press('Escape');
      // Wait for edit mode to be cancelled (verify original message is restored)
      const userMessageAfter = window.locator('article.agent-turn-message').filter({ hasText: 'You' }).last();
      await expect(userMessageAfter).toContainText(marker);

      const response = window
        .locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]')
        .last();
      await expect(response).toContainText(marker);
    });

    test('clicking stop cancels the current turn', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await switchToTextMode(window);
      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.fill(
        'Write a detailed 1000 word analysis of artificial intelligence trends in 2024.'
      );

      const sendButton = window.locator('[data-testid="composer-send-button"], [data-testid="send-now-button"]');
      await sendButton.click();

      const stopButton = window.locator('[data-testid="stop-turn-button"]');
      await expect(stopButton).toBeVisible({ timeout: 30000 });
      await stopButton.click();
      // Wait for stop button to disappear (turn cancelled)
      await expect(window.locator('[data-testid="stop-turn-button"]')).not.toBeVisible({ timeout: 30000 });

      await switchToTextMode(window);
      const textInputAfter = window.locator('[data-testid="composer-input"]');
      await expect(textInputAfter).toBeEnabled({ timeout: 10000 });

      const response = await sendMessageAndWaitForResponse(
        window,
        'Say "confirmed" and nothing else.'
      );
      expect(response.toLowerCase()).toContain('confirmed');
    });
  });
});
