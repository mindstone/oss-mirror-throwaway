/**
 * User Questions E2E Tests
 *
 * Tests for the Ask User Questions feature (AskUserQuestion tool).
 * Verifies that injecting a user_question agent event renders the
 * inline UserQuestionCard in the conversation pane.
 *
 * Strategy: Send a real user message (creates session + turnId in the store),
 * then inject agent:event IPC events on that turnId. This avoids needing
 * to read the Zustand session ID directly (which isn't exposed to E2E).
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

/**
 * Navigate to Conversations, start a new chat, send a test message,
 * and return the turnId from the rendered user message.
 */
async function sendTestMessageAndGetTurnId(
  page: Page,
  message: string,
): Promise<string> {
  // Navigate to Conversations tab
  const conversationsTab = page.locator('a:has-text("Conversations"), button:has-text("Conversations")').first();
  await conversationsTab.click({ timeout: 5000 });

  const newChatButton = page.locator('[data-testid="new-chat-button"]');
  await expect(newChatButton).toBeVisible({ timeout: 10000 });
  await newChatButton.click();

  const textInput = page.locator('[data-testid="composer-input"]');
  await expect(textInput).toBeVisible({ timeout: 10000 });

  await textInput.fill(message);
  const sendButton = page.locator('[data-testid="composer-send-button"], [data-testid="send-now-button"]');
  await expect(sendButton).toBeEnabled({ timeout: 5000 });
  await sendButton.click();

  // Wait for user message to appear and render (turnId must be in DOM)
  const userMessageEl = page.locator('article.agent-turn-message[data-role="user"]').last();
  await expect(userMessageEl).toBeVisible({ timeout: 10000 });

  const turnId = await userMessageEl.getAttribute('data-turn-id');
  if (!turnId) throw new Error('User message has no data-turn-id');
  return turnId;
}

test.describe('User Questions (AskUserQuestion)', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    console.log('[E2E] [user-questions] ========== TEST SUITE START ==========');
    isolated = createIsolatedUserData('user-questions');
    writeMinimalSettings(isolated.path);

    app = await launchWithIsolatedUserData(isolated, { skipOnboarding: true });
    window = await getFirstWindow(app);

    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);
    console.log('[E2E] [user-questions] App ready');
  });

  test.beforeEach(async ({}, testInfo) => {
    await resetAppState(window, testInfo.title);
  });

  test.afterAll(async () => {
    await safeCloseApp(app, 15000, isolated.path);
    isolated?.cleanup();
  });

  test('renders UserQuestionCard when user_question event is injected', async () => {
    const batchId = 'e2e-uq-batch-' + Date.now();
    const now = Date.now();

    // Send a real message to create a session and get a valid turnId
    const turnId = await sendTestMessageAndGetTurnId(window, 'test for user questions');
    console.log('[E2E] [user-questions] turnId:', turnId);

    // Inject assistant message on this turn
    await injectAgentEvent(app, {
      turnId,
      event: { type: 'assistant', text: 'Let me ask you a question.', timestamp: now },
      sessionId: null,
    });

    const assistantMsg = window.locator('article.agent-turn-message[data-role="assistant"]').last();
    await expect(assistantMsg).toBeVisible({ timeout: 10000 });
    console.log('[E2E] [user-questions] Assistant message rendered');

    // Inject user_question event
    await injectAgentEvent(app, {
      turnId,
      event: {
        type: 'user_question',
        batchId,
        toolUseId: 'e2e-tool-' + now,
        questions: [{
          id: 'q1',
          question: 'What format would you prefer for the report?',
          header: 'Report Format',
          options: [
            { id: 'opt-pdf', label: 'PDF', description: 'Portable document format' },
            { id: 'opt-docx', label: 'Word', description: 'Microsoft Word document' },
            { id: 'opt-md', label: 'Markdown', description: 'Plain text with formatting' },
          ],
          multiSelect: false,
        }],
        timestamp: now + 100,
      },
      sessionId: null,
    });

    // Verify the card appears
    const card = window.locator('[role="form"][aria-label="Rebel has a question"]');
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toContainText('What format would you prefer for the report?');
    await expect(card).toContainText('PDF');
    await expect(card).toContainText('Word');
    await expect(card).toContainText('Markdown');

    console.log('[E2E] [user-questions] UserQuestionCard rendered successfully');
  });

  test('card survives turn completion (result event)', async () => {
    const batchId = 'e2e-uq-result-batch-' + Date.now();
    const now = Date.now();

    const turnId = await sendTestMessageAndGetTurnId(window, 'test result survival');
    console.log('[E2E] [user-questions] turnId:', turnId);

    // Inject assistant + user_question
    await injectAgentEvent(app, {
      turnId,
      event: { type: 'assistant', text: 'Questions for you.', timestamp: now },
      sessionId: null,
    });
    await window.waitForTimeout(300);

    await injectAgentEvent(app, {
      turnId,
      event: {
        type: 'user_question',
        batchId,
        toolUseId: 'e2e-result-tool-' + now,
        questions: [{
          id: 'q-color',
          question: 'What color scheme do you prefer?',
          header: 'Color Scheme',
          options: [
            { id: 'opt-dark', label: 'Dark', description: 'Dark theme' },
            { id: 'opt-light', label: 'Light', description: 'Light theme' },
          ],
          multiSelect: false,
        }],
        timestamp: now + 100,
      },
      sessionId: null,
    });
    await window.waitForTimeout(300);

    // Now inject result event (turn completes)
    await injectAgentEvent(app, {
      turnId,
      event: { type: 'result', text: 'Questions presented.', timestamp: now + 200 },
      sessionId: null,
    });
    await window.waitForTimeout(500);

    // Card should still be visible after turn completion
    const cards = window.locator('[role="form"][aria-label="Rebel has a question"]');
    await expect(cards).toHaveCount(1, { timeout: 5000 });
    await expect(cards.first()).toContainText('What color scheme do you prefer?');
    await expect(cards.first()).toContainText('Dark');
    await expect(cards.first()).toContainText('Light');

    console.log('[E2E] [user-questions] Card survives turn completion');
  });

  test('card survives session switch-back after turn completion (compaction scenario)', async () => {
    // This is the EXACT bug scenario: user_question card must survive
    // switching away from the session and back. When the turn completes,
    // compactCompletedTurns runs on the LRU cache. The fix preserves
    // user_question events through compaction.
    const batchId = 'e2e-uq-switch-batch-' + Date.now();
    const now = Date.now();

    // 1. Send message in session A
    const turnId = await sendTestMessageAndGetTurnId(window, 'test session switch compaction');
    console.log('[E2E] [user-questions] Session A turnId:', turnId);

    // 2. Inject assistant + user_question + result (complete the turn)
    await injectAgentEvent(app, {
      turnId,
      event: { type: 'assistant', text: 'I have a question for you.', timestamp: now },
      sessionId: null,
    });
    await window.waitForTimeout(300);

    await injectAgentEvent(app, {
      turnId,
      event: {
        type: 'user_question',
        batchId,
        toolUseId: 'e2e-switch-tool-' + now,
        questions: [{
          id: 'q-switch',
          question: 'Which database do you prefer?',
          header: 'Database',
          options: [
            { id: 'opt-pg', label: 'PostgreSQL', description: 'Relational database' },
            { id: 'opt-mongo', label: 'MongoDB', description: 'Document database' },
          ],
          multiSelect: false,
        }],
        timestamp: now + 100,
      },
      sessionId: null,
    });
    await window.waitForTimeout(300);

    await injectAgentEvent(app, {
      turnId,
      event: { type: 'result', text: 'Question presented.', timestamp: now + 200 },
      sessionId: null,
    });

    // 3. Verify card is visible before switching
    const card = window.locator('[role="form"][aria-label="Rebel has a question"]');
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toContainText('Which database do you prefer?');
    console.log('[E2E] [user-questions] Card visible in session A');

    // 4. Switch to a new session (session B)
    const newChatButton = window.locator('[data-testid="new-chat-button"]');
    await newChatButton.click();
    await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });
    console.log('[E2E] [user-questions] Switched to session B');

    // 5. Wait for compaction to settle
    await window.waitForTimeout(2000);

    // 6. Switch back to session A via sidebar
    const sessionSidebar = window.locator('[data-testid="session-sidebar"]');
    const sessionAButton = sessionSidebar.locator('button').filter({ hasText: 'test session switch compaction' }).first();
    // Fall back to finding by the assistant message if title differs
    const sessionButton = await sessionAButton.isVisible().then(
      visible => visible ? sessionAButton : sessionSidebar.locator('button').filter({ hasText: 'question' }).first()
    );
    await expect(sessionButton).toBeVisible({ timeout: 10000 });
    await sessionButton.click();
    console.log('[E2E] [user-questions] Switching back to session A');

    // 7. Wait for session to load
    await expect(
      window.locator('article.agent-turn-message[data-role="user"]')
    ).toBeVisible({ timeout: 15000 });

    // 8. Verify the question card is STILL visible after session switch-back
    // This is the critical assertion — before the fix, compaction dropped
    // the user_question event and the card would not render.
    const cardAfterSwitch = window.locator('[role="form"][aria-label="Rebel has a question"]');
    await expect(cardAfterSwitch).toBeVisible({ timeout: 10000 });
    await expect(cardAfterSwitch).toContainText('Which database do you prefer?');
    await expect(cardAfterSwitch).toContainText('PostgreSQL');
    await expect(cardAfterSwitch).toContainText('MongoDB');

    console.log('[E2E] [user-questions] Card survived session switch-back + compaction!');
  });
});
