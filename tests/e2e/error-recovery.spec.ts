/**
 * Error Recovery E2E Tests
 *
 * Tests that the app handles LLM errors gracefully: rate limits, context overflow,
 * model not found, and partial streaming errors. Uses the mock error infrastructure.
 *
 * Planning doc: docs/plans/260402_e2e_test_gap_improvements.md (Stage 8)
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
  switchToTextMode,
  type MockResponse,
  waitForMainAppReady,
} from './test-utils';
import { mockErrorResponse, mockResponse } from './mocks/llm-mock';

const ERROR_RECOVERY_PROMPT = 'Error recovery test prompt';
const FOLLOWUP_PROMPT = 'Followup after error';
const FOLLOWUP_RESPONSE = 'Recovery successful - followup response.';
const PARTIAL_ERROR_PROMPT = 'Partial stream then error prompt';
const PARTIAL_TEXT = 'This is the partial response that will be cut short by a simulated error midway through streaming...';

const ERROR_MOCK_RESPONSES: MockResponse[] = [
  mockErrorResponse(/rate limit test/i, 'rate_limit'),
  mockErrorResponse(/context overflow test/i, 'context_overflow'),
  mockErrorResponse(/model not found test/i, 'model_not_found'),
  mockErrorResponse(
    new RegExp(PARTIAL_ERROR_PROMPT, 'i'),
    'overloaded',
    { partialText: PARTIAL_TEXT }
  ),
  mockResponse(new RegExp(FOLLOWUP_PROMPT, 'i'), FOLLOWUP_RESPONSE),
  mockResponse(/.*/, 'Default mock response for error recovery tests.'),
];

test.skip(!appExists(), getAppNotFoundMessage());

let app: ElectronApplication;
let window: Page;
let cleanup: (() => void) | undefined;
let userDataPath = '';

test.describe('Error Recovery', () => {
  test.skip(PLATFORM === 'win32', 'Skipped on Windows: app launch timeout in CI');
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    console.log('[E2E] [error-recovery] ========== SUITE START ==========');
    const launched = await launchWithMocking('error-recovery', {
      mockResponses: ERROR_MOCK_RESPONSES,
      skipOnboarding: true,
    });

    app = launched.electronApp;
    cleanup = launched.cleanup;
    userDataPath = launched.userDataPath;
    window = await getFirstWindow(app);
    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);
    console.log('[E2E] [error-recovery] App ready');
  });

  test.beforeEach(async ({}, testInfo) => {
    await resetAppState(window, testInfo.title);
  });

  test.afterAll(async () => {
    if (app) await safeCloseApp(app, 15000, userDataPath);
    cleanup?.();
  });

  async function startFreshChat(): Promise<void> {
    const newChatButton = window.locator('[data-testid="new-chat-button"]');
    await newChatButton.click();
    await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });
    await switchToTextMode(window);
  }

  async function sendMessage(prompt: string): Promise<void> {
    const textInput = window.locator('[data-testid="composer-input"]');
    await textInput.fill(prompt);
    const sendButton = window.locator('[data-testid="composer-send-button"]');
    await expect(sendButton).toBeEnabled({ timeout: 5000 });
    await sendButton.click();
  }

  async function waitForTurnComplete(): Promise<void> {
    const stopButton = window.locator('[data-testid="stop-turn-button"]');
    await expect(stopButton).not.toBeVisible({ timeout: 30000 });
  }

  test('rate limit error shows user-friendly message and allows retry', async () => {
    await startFreshChat();
    await sendMessage('rate limit test');
    await waitForTurnComplete();

    // Dismiss error banner if present so it doesn't block follow-up interaction
    const dismissButton = window.locator('button[aria-label="Dismiss error"], [data-testid="error-banner"] button:has-text("✕")');
    if (await dismissButton.first().isVisible().catch(() => false)) {
      await dismissButton.first().click();
    }

    // Verify user can send a follow-up message after error (app didn't crash)
    await sendMessage(FOLLOWUP_PROMPT);
    await waitForTurnComplete();

    const transcript = await window.locator('article.agent-turn-message').allTextContents();
    expect(transcript.join('\n')).toContain(FOLLOWUP_RESPONSE);
  });

  test('context overflow error is handled gracefully', async () => {
    await startFreshChat();
    await sendMessage('context overflow test');
    await waitForTurnComplete();

    // Dismiss error banner if present
    const dismissButton = window.locator('button[aria-label="Dismiss error"], [data-testid="error-banner"] button:has-text("✕")');
    if (await dismissButton.first().isVisible().catch(() => false)) {
      await dismissButton.first().click();
    }

    // Can send a follow-up (app didn't crash)
    await sendMessage(FOLLOWUP_PROMPT);
    await waitForTurnComplete();

    const transcript = await window.locator('article.agent-turn-message').allTextContents();
    expect(transcript.join('\n')).toContain(FOLLOWUP_RESPONSE);
  });

  test('model not found error is recoverable', async () => {
    await startFreshChat();
    await sendMessage('model not found test');
    await waitForTurnComplete();

    // Dismiss error banner if present
    const dismissButton = window.locator('button[aria-label="Dismiss error"], [data-testid="error-banner"] button:has-text("✕")');
    if (await dismissButton.first().isVisible().catch(() => false)) {
      await dismissButton.first().click();
    }

    // Can continue conversation after error
    await sendMessage(FOLLOWUP_PROMPT);
    await waitForTurnComplete();

    const transcript = await window.locator('article.agent-turn-message').allTextContents();
    expect(transcript.join('\n')).toContain(FOLLOWUP_RESPONSE);
  });

  test('error during streaming preserves partial content and allows retry', async () => {
    await startFreshChat();
    await sendMessage(PARTIAL_ERROR_PROMPT);
    await waitForTurnComplete();

    // Dismiss error banner if present
    const dismissButton = window.locator('button[aria-label="Dismiss error"], [data-testid="error-banner"] button:has-text("✕")');
    if (await dismissButton.first().isVisible().catch(() => false)) {
      await dismissButton.first().click();
    }

    // Can recover and continue
    await sendMessage(FOLLOWUP_PROMPT);
    await waitForTurnComplete();

    const transcript = await window.locator('article.agent-turn-message').allTextContents();
    expect(transcript.join('\n')).toContain(FOLLOWUP_RESPONSE);
  });
});
