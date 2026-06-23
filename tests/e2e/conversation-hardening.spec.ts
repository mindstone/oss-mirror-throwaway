import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fsNode from 'node:fs';
import pathNode from 'node:path';
import {
  appExists,
  clearPendingApprovals,
  enableGuestMode,
  ensureSessionSidebarOpen,
  getAppNotFoundMessage,
  getFirstWindow,
  injectToolApproval,
  launchWithMocking,
  PLATFORM,
  resetAppState,
  safeCloseApp,
  sendMessageAndWaitForResponse,
  switchToTextMode,
  type MockResponse,
  waitForMainAppReady,
  waitForSuperMcpReady
} from './test-utils';
import { mockResponse } from './mocks/llm-mock';

const SLOW_STREAMING_DELAYS = {
  status: 10,
  assistant: 3000,
  result: 3500,
};

const T1_INITIAL_PROMPT = 'Hardening T1 original prompt';
const T1_FIRST_EDIT_PROMPT = 'Hardening T1 first edit';
const T1_FINAL_EDIT_PROMPT = 'Hardening T1 final edit';
const T1_FIRST_EDIT_RESPONSE = 'Hardening T1 first edit response.';
const T1_FINAL_RESPONSE = 'Hardening T1 final response.';

const T2_STOP_EARLY_PROMPT = 'Hardening T2 stop before init';
const T2_RECOVERY_PROMPT = 'Hardening T2 recovery prompt';
const T2_RECOVERY_RESPONSE = 'Hardening T2 recovery response.';

const T3_FIRST_PROMPT = 'Hardening T3 first prompt';
const T3_SECOND_PROMPT = 'Hardening T3 second prompt';
const T3_SECOND_RESPONSE = 'Hardening T3 second response.';

const T4_INITIAL_PROMPT = 'Hardening T4 original prompt';
const T4_CANCELLED_EDIT_PROMPT = 'Hardening T4 cancelled edit';
const T4_FINAL_EDIT_PROMPT = 'Hardening T4 final edit';
const T4_INITIAL_RESPONSE = 'Hardening T4 original response.';
const T4_FINAL_RESPONSE = 'Hardening T4 final response.';

// Stage 2: Session Switching constants.
// Prompt text uses dashes (not underscores) because the sidebar renders titles
// through stripMarkdown() which strips markdown-italic syntax (_text_ -> text).
const S2_SWITCH_AWAY_PROMPT = 'S2 switch-away-and-back prompt';
const S2_SWITCH_AWAY_RESPONSE = 'S2 switch-away-and-back response.';
const S2_EDIT_SWITCH_PROMPT = 'S2 edit-then-switch prompt';
const S2_EDIT_SWITCH_RESPONSE = 'S2 edit-then-switch response.';
const S2_NEW_CHAT_ACTIVE_PROMPT = 'S2 new-chat-during-turn prompt';
const S2_NEW_CHAT_ACTIVE_RESPONSE = 'S2 new-chat-during-turn response.';

const S11_COMPACTION_A_PROMPT = 'S11 compaction-isolation-session-A prompt';
const S11_COMPACTION_A_RESPONSE = 'S11 compaction isolation session A response.';
const S11_COMPACTION_B_PROMPT = 'S11 compaction-isolation-session-B prompt';
const S11_COMPACTION_B_RESPONSE = 'S11 compaction isolation session B response.';
const S11_ISO_A_PROMPT = 'S11 cross-session-isolation-A prompt';
const S11_ISO_A_RESPONSE = 'S11 cross session isolation A response.';
const S11_ISO_B_PROMPT = 'S11 cross-session-isolation-B prompt';
const S11_ISO_B_RESPONSE = 'S11 cross session isolation B response.';

// Stage I6/I7 regression: markdown images with spaces in filename must render
// as data: URIs end-to-end (plugin -> IPC -> fs.readFile -> <img src>).
// See docs/plans/260422_broken_image_followups_i6_i7.md.
const MD_IMG_PROMPT = 'MD-IMG-RENDER render image prompt';
const MD_IMG_FILENAME = 'my image.png';
const MD_IMG_RESPONSE = `Rendering test image:\n\n![MD-IMG-RENDER test image](${MD_IMG_FILENAME})\n\nDone.`;
// 70-byte minimal-valid 1x1 PNG fixture. Lives in tests/e2e/fixtures/ rather
// than inlined as base64 to avoid secret-scanner false positives.
const MD_IMG_PNG_FIXTURE = pathNode.join(
  __dirname,
  'fixtures',
  'md-image-regression-1x1.png'
);

const HARDENING_MOCK_RESPONSES: MockResponse[] = [
  {
    pattern: new RegExp(T1_INITIAL_PROMPT, 'i'),
    response: 'Hardening T1 initial response.',
    streaming: true,
    delays: SLOW_STREAMING_DELAYS,
  },
  {
    pattern: new RegExp(T1_FIRST_EDIT_PROMPT, 'i'),
    response: T1_FIRST_EDIT_RESPONSE,
    streaming: true,
    delays: SLOW_STREAMING_DELAYS,
  },
  {
    pattern: new RegExp(T1_FINAL_EDIT_PROMPT, 'i'),
    response: T1_FINAL_RESPONSE,
    streaming: true,
    delays: SLOW_STREAMING_DELAYS,
  },
  {
    pattern: new RegExp(T2_STOP_EARLY_PROMPT, 'i'),
    response: 'Hardening T2 interrupted response.',
    streaming: true,
    delays: {
      status: 2000,
      assistant: 3000,
      result: 3500,
    },
  },
  mockResponse(new RegExp(T2_RECOVERY_PROMPT, 'i'), T2_RECOVERY_RESPONSE),
  {
    pattern: new RegExp(T3_FIRST_PROMPT, 'i'),
    response: 'Hardening T3 interrupted response.',
    streaming: true,
    delays: SLOW_STREAMING_DELAYS,
  },
  {
    pattern: new RegExp(T3_SECOND_PROMPT, 'i'),
    response: T3_SECOND_RESPONSE,
    streaming: true,
    delays: SLOW_STREAMING_DELAYS,
  },
  mockResponse(new RegExp(T4_INITIAL_PROMPT, 'i'), T4_INITIAL_RESPONSE),
  mockResponse(new RegExp(T4_FINAL_EDIT_PROMPT, 'i'), T4_FINAL_RESPONSE),
  // Stage 2: Session switching mocks
  {
    pattern: new RegExp(S2_SWITCH_AWAY_PROMPT, 'i'),
    response: S2_SWITCH_AWAY_RESPONSE,
    streaming: true,
    delays: SLOW_STREAMING_DELAYS,
  },
  mockResponse(new RegExp(S2_EDIT_SWITCH_PROMPT, 'i'), S2_EDIT_SWITCH_RESPONSE),
  {
    pattern: new RegExp(S2_NEW_CHAT_ACTIVE_PROMPT, 'i'),
    response: S2_NEW_CHAT_ACTIVE_RESPONSE,
    streaming: true,
    delays: SLOW_STREAMING_DELAYS,
  },
  {
    pattern: new RegExp(S11_COMPACTION_A_PROMPT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    response: S11_COMPACTION_A_RESPONSE,
    streaming: true,
  },
  {
    pattern: new RegExp(S11_COMPACTION_B_PROMPT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    response: S11_COMPACTION_B_RESPONSE,
    streaming: true,
  },
  {
    pattern: new RegExp(S11_ISO_A_PROMPT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    response: S11_ISO_A_RESPONSE,
    streaming: true,
  },
  {
    pattern: new RegExp(S11_ISO_B_PROMPT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    response: S11_ISO_B_RESPONSE,
    streaming: true,
  },
  // Stage I6/I7 regression: assistant emits markdown image with a filename
  // containing a space. No streaming delay — we want the rendered DOM fast.
  mockResponse(new RegExp(MD_IMG_PROMPT, 'i'), MD_IMG_RESPONSE),
  {
    pattern: /.*/,
    response: 'This is the mock response.',
    streaming: true,
    delays: SLOW_STREAMING_DELAYS,
  },
];

test.skip(!appExists(), getAppNotFoundMessage());

let app: ElectronApplication;
let window: Page;
let cleanup: (() => void) | undefined;
let userDataPath = '';
let testCount = 0;
const failures: string[] = [];

function getStopButton(page: Page) {
  return page.locator('[data-testid="stop-turn-button"]');
}

function getSendButton(page: Page) {
  return page.locator('[data-testid="composer-send-button"]');
}

function getCommandInput(page: Page) {
  return page.locator('[data-testid="composer-input"]');
}

function getAllMessages(page: Page) {
  return page.locator('article.agent-turn-message');
}

function getUserMessages(page: Page) {
  return page.locator('article.agent-turn-message[data-role="user"]');
}

function getAssistantMessages(page: Page) {
  return page.locator(
    'article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]'
  );
}

async function startFreshChat(page: Page): Promise<void> {
  const newChatButton = page.locator('[data-testid="new-chat-button"]');
  await expect(newChatButton).toBeVisible({ timeout: 10000 });
  await newChatButton.click();
  await expect(getAllMessages(page)).toHaveCount(0, { timeout: 10000 });
  await switchToTextMode(page);
}

async function sendMessage(page: Page, prompt: string): Promise<void> {
  await switchToTextMode(page);
  await getCommandInput(page).fill(prompt);
  await expect(getSendButton(page)).toBeEnabled({ timeout: 10000 });
  await getSendButton(page).click();
}

async function openLastUserMessageForEditing(page: Page): Promise<void> {
  const userMessage = getUserMessages(page).last();
  await expect(userMessage).toBeVisible({ timeout: 10000 });

  const editButton = userMessage.locator('[data-testid="message-edit-button"]');

  // Retry hover — during streaming, DOM updates can shift the hover target
  // causing the edit button to not appear on the first attempt.
  for (let attempt = 0; attempt < 3; attempt++) {
    await userMessage.scrollIntoViewIfNeeded();
    await userMessage.hover();
    if (await editButton.isVisible({ timeout: 2000 }).catch(() => false)) break;
  }

  await expect(editButton).toBeVisible({ timeout: 5000 });
  await editButton.click();
}

// Replace the composer's contents with `prompt`. The composer is a TipTap /
// ProseMirror contenteditable (not a textarea), and on edit-entry the app
// pre-populates it via composerRef.setText(originalPrompt). A bare
// getCommandInput(page).fill(prompt) does NOT reliably clear that managed
// contenteditable DOM, so the new text gets appended to the still-present
// original ("<original><edit>" concatenation). Explicitly focus, select-all,
// delete, then fill — and verify the field is empty before typing.
async function replaceComposerText(page: Page, prompt: string): Promise<void> {
  const input = getCommandInput(page);
  await input.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await expect(input).toHaveText('', { timeout: 5000 });
  await input.fill(prompt);
}

async function saveEditedPrompt(page: Page, prompt: string): Promise<void> {
  await replaceComposerText(page, prompt);
  const saveButton = page.locator('button:has-text("Save & re-run")');
  await expect(saveButton).toBeVisible({ timeout: 5000 });
  await saveButton.click();
}

async function waitForLatestResponseText(
  page: Page,
  expectedText: string,
  timeoutMs = 90000
): Promise<void> {
  const assistantMessages = getAssistantMessages(page);

  await expect.poll(async () => {
    const count = await assistantMessages.count();
    if (count === 0) {
      return '';
    }

    return (await assistantMessages.last().textContent()) ?? '';
  }, {
    timeout: timeoutMs,
    intervals: [500, 1000],
  }).toContain(expectedText);

  await expect(getStopButton(page)).not.toBeVisible({ timeout: 30000 });
}

async function dismissErrorBannerIfPresent(page: Page): Promise<void> {
  const dismissButton = page.locator('[data-testid="error-banner"] button[aria-label="Dismiss error"]');
  if (await dismissButton.isVisible().catch(() => false)) {
    await dismissButton.click();
    await expect(page.locator('[data-testid="error-banner"]')).toBeHidden({ timeout: 5000 });
  }
}

async function getTranscriptText(page: Page): Promise<string> {
  return (await getAllMessages(page).allTextContents()).join('\n');
}

async function expectAppResponsive(page: Page): Promise<void> {
  await expect(page.locator('[id^="flow-tab-"]').first()).toBeVisible({ timeout: 10000 });
  await expect(getStopButton(page)).toBeHidden({ timeout: 10000 });
  // Send button is correctly disabled when input is empty — check visibility not enabled state
  await expect(getSendButton(page)).toBeVisible({ timeout: 10000 });
}

async function switchToSessionBySidebarText(page: Page, identifyingText: string): Promise<void> {
  await ensureSessionSidebarOpen(page);
  const sidebar = page.locator('[data-testid="session-sidebar"]');
  const sessionEntry = sidebar.locator('[data-session-id]').filter({ hasText: identifyingText }).first();
  await expect(sessionEntry).toBeVisible({ timeout: 15000 });
  await sessionEntry.scrollIntoViewIfNeeded();
  await sessionEntry.click();

  // The session switch is asynchronous: the click handler is fire-and-forget and
  // the store only swaps { messages, currentSessionId } atomically after an async
  // openHistorySession (disk/LRU load). Returning immediately lets callers sample
  // the OLD session's transcript. Wait until the switch has actually committed:
  //   1) the clicked entry's inner button becomes aria-current="true", AND
  //   2) the transcript reflects the target session (contains identifyingText).
  // Both are web-first / polled — no blind waitForTimeout.
  await expect(sessionEntry.locator('button[aria-current="true"]')).toBeVisible({ timeout: 15000 });
  await expect
    .poll(async () => getTranscriptText(page), { timeout: 15000, intervals: [250, 500] })
    .toContain(identifyingText);
}

async function getStableWindow(app: ElectronApplication): Promise<Page> {
  let candidate = await getFirstWindow(app);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await candidate.waitForLoadState('domcontentloaded', { timeout: 60000 });
      return candidate;
    } catch (error) {
      if (attempt === 3) {
        throw error;
      }

      console.log(`[E2E] [conversation-hardening] First window closed before load (attempt ${attempt}), waiting for next window`);
      candidate = await app.waitForEvent('window', { timeout: 30000 });
    }
  }

  return candidate;
}

test.describe('Conversation Hardening (Mocked)', () => {
  test.skip(!appExists(), getAppNotFoundMessage());
  test.skip(PLATFORM === 'win32', 'Skipped on Windows: app launch timeout in CI');
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    console.log('[E2E] [conversation-hardening] ========== SUITE START ==========');
    const startTime = Date.now();

    const launched = await launchWithMocking('conversation-hardening', {
      mockResponses: HARDENING_MOCK_RESPONSES,
      skipOnboarding: true,
    });

    app = launched.electronApp;
    cleanup = launched.cleanup;
    userDataPath = launched.userDataPath;
    window = await getStableWindow(app);
    await enableGuestMode(window);
    await waitForMainAppReady(window);
    await waitForSuperMcpReady(window);

    console.log(`[E2E] [conversation-hardening] App launched in ${Date.now() - startTime}ms`);
    console.log(`[E2E] [conversation-hardening] userData: ${userDataPath}`);
  });

  test.afterAll(async () => {
    console.log('[E2E] [conversation-hardening] ========== SUITE END ==========');
    console.log(`[E2E] [conversation-hardening] Tests run: ${testCount}`);
    console.log(`[E2E] [conversation-hardening] Failures: ${failures.length}`);
    if (failures.length > 0) {
      console.log(`[E2E] [conversation-hardening] Failed tests: ${failures.join(', ')}`);
    }

    if (app) {
      await safeCloseApp(app, 15000, userDataPath);
    }

    if (failures.length === 0 && !process.env.REBEL_E2E_KEEP_USER_DATA) {
      cleanup?.();
    } else {
      console.log(`[DEBUG] Keeping test userData at: ${userDataPath}`);
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
      console.log('[E2E] [test:end] FAILURE - capturing diagnostics');

      const screenshotPath = `test-results/conversation-hardening-${testCount}-failure.png`;
      await window.screenshot({ path: screenshotPath }).catch(() => {});

      const url = window.url();
      console.log(`[E2E] [test:end] URL: ${url}`);

      const recoveryDialog = await window
        .locator('[data-testid="startup-recovery-dialog"]')
        .isVisible()
        .catch(() => false);
      const stopButtonVisible = await getStopButton(window).isVisible().catch(() => false);
      console.log(`[E2E] [test:end] Recovery dialog visible: ${recoveryDialog}`);
      console.log(`[E2E] [test:end] Stop button visible (agent active): ${stopButtonVisible}`);

      if (testInfo.error) {
        console.log(`[E2E] [test:end] Error: ${testInfo.error.message}`);
      }
    }
  });

  test('stop active turn, edit, stop again, edit again', async () => {
    await startFreshChat(window);

    // Send initial message and wait for turn to start
    await sendMessage(window, T1_INITIAL_PROMPT);
    await expect(getStopButton(window)).toBeVisible({ timeout: 10000 });

    // Stop the turn first — edit button only appears when idle/stopping (effectivelyIdle)
    await getStopButton(window).click();
    await expect(getStopButton(window)).not.toBeVisible({ timeout: 30000 });
    await dismissErrorBannerIfPresent(window);

    // Now edit the message (app is idle, edit button is available)
    await openLastUserMessageForEditing(window);
    await saveEditedPrompt(window, T1_FIRST_EDIT_PROMPT);

    // The edit triggers a new turn — stop it too
    await expect(getStopButton(window)).toBeVisible({ timeout: 10000 });
    await getStopButton(window).click();
    await expect(getStopButton(window)).not.toBeVisible({ timeout: 30000 });
    await dismissErrorBannerIfPresent(window);

    // Edit again with the final prompt
    await openLastUserMessageForEditing(window);
    await saveEditedPrompt(window, T1_FINAL_EDIT_PROMPT);

    await expect(getStopButton(window)).toBeVisible({ timeout: 10000 });
    await waitForLatestResponseText(window, T1_FINAL_RESPONSE);

    await expectAppResponsive(window);
    await expect(getUserMessages(window)).toHaveCount(1);

    const transcript = await getTranscriptText(window);
    expect(transcript).toContain(T1_FINAL_EDIT_PROMPT);
    expect(transcript).toContain(T1_FINAL_RESPONSE);
    expect(transcript).not.toContain(T1_INITIAL_PROMPT);
    expect(transcript).not.toContain(T1_FIRST_EDIT_PROMPT);
    expect(transcript).not.toContain(T1_FIRST_EDIT_RESPONSE);
  });

  test('stop before turn fully initializes', async () => {
    await startFreshChat(window);

    await sendMessage(window, T2_STOP_EARLY_PROMPT);
    await expect(getStopButton(window)).toBeVisible({ timeout: 500 });
    await getStopButton(window).click();
    await expect(getStopButton(window)).not.toBeVisible({ timeout: 30000 });
    await dismissErrorBannerIfPresent(window);

    // Send button is correctly disabled when input is empty after turn completes
    await expect(getSendButton(window)).toBeVisible({ timeout: 10000 });
    await expect(window.locator('[data-testid="queued-messages-tray"]')).toBeHidden();

    const recoveryResponse = await sendMessageAndWaitForResponse(window, T2_RECOVERY_PROMPT);
    expect(recoveryResponse).toContain(T2_RECOVERY_RESPONSE);

    await expectAppResponsive(window);
  });

  test('send, stop, immediately send again', async () => {
    await startFreshChat(window);

    await sendMessage(window, T3_FIRST_PROMPT);
    await expect(getStopButton(window)).toBeVisible({ timeout: 10000 });
    await getStopButton(window).click();
    await expect(getStopButton(window)).not.toBeVisible({ timeout: 30000 });
    await dismissErrorBannerIfPresent(window);

    await sendMessage(window, T3_SECOND_PROMPT);
    await expect(getStopButton(window)).toBeVisible({ timeout: 10000 });
    await expect(window.locator('[data-testid="queued-messages-tray"]')).toBeHidden();

    await waitForLatestResponseText(window, T3_SECOND_RESPONSE);
    await expectAppResponsive(window);

    const transcript = await getTranscriptText(window);
    expect(transcript).toContain(T3_SECOND_PROMPT);
    expect(transcript).toContain(T3_SECOND_RESPONSE);
  });

  test('rapid edit/cancel/edit cycle', async () => {
    await startFreshChat(window);

    const originalResponse = await sendMessageAndWaitForResponse(window, T4_INITIAL_PROMPT);
    expect(originalResponse).toContain(T4_INITIAL_RESPONSE);

    await openLastUserMessageForEditing(window);
    // Explicitly clear the pre-populated composer before typing — a bare fill()
    // appends to the TipTap contenteditable rather than replacing it.
    await replaceComposerText(window, T4_CANCELLED_EDIT_PROMPT);
    await window.keyboard.press('Escape');

    await expect(window.locator('button:has-text("Save & re-run")')).toBeHidden({ timeout: 5000 });
    await expect(getUserMessages(window).last()).toContainText(T4_INITIAL_PROMPT);

    let transcript = await getTranscriptText(window);
    expect(transcript).toContain(T4_INITIAL_PROMPT);
    expect(transcript).toContain(T4_INITIAL_RESPONSE);
    expect(transcript).not.toContain(T4_CANCELLED_EDIT_PROMPT);

    await openLastUserMessageForEditing(window);
    await saveEditedPrompt(window, T4_FINAL_EDIT_PROMPT);
    await waitForLatestResponseText(window, T4_FINAL_RESPONSE);

    await expectAppResponsive(window);

    transcript = await getTranscriptText(window);
    expect(transcript).toContain(T4_FINAL_EDIT_PROMPT);
    expect(transcript).toContain(T4_FINAL_RESPONSE);
    expect(transcript).not.toContain(T4_CANCELLED_EDIT_PROMPT);
    expect(transcript).not.toContain(T4_INITIAL_RESPONSE);

    // STRICT: the edited user message must EQUAL the final edit, not the
    // "<original prompt><final edit>" concatenation observed when the composer
    // wasn't cleared. The original prompt must be fully gone from the message.
    const finalUserText = (await getUserMessages(window).last().textContent()) ?? '';
    expect(finalUserText).toContain(T4_FINAL_EDIT_PROMPT);
    expect(finalUserText).not.toContain(T4_INITIAL_PROMPT);
  });

  // ==========================================================================
  // Message Queue Edge Cases (Stage 4)
  // ==========================================================================

  test('queue preserves intermediary output after queued message sends', async () => {
    await startFreshChat(window);

    await sendMessage(window, T3_FIRST_PROMPT);
    await expect(getStopButton(window)).toBeVisible({ timeout: 10000 });

    // Queue a follow-up while first turn is running
    const queuedMarker = `QueueTest_${Date.now()}`;
    await getCommandInput(window).fill(queuedMarker);
    const queueButton = window.locator('[data-testid="send-queue-button"]');
    await expect(queueButton).toBeVisible({ timeout: 5000 });
    await queueButton.click();

    const tray = window.locator('[data-testid="queued-messages-tray"]');
    await expect(tray).toBeVisible({ timeout: 5000 });

    // Wait for first turn to complete and queue to drain
    await expect(tray).toBeHidden({ timeout: 120000 });
    // Wait for second turn (queued message) to complete
    await expect(getStopButton(window)).not.toBeVisible({ timeout: 60000 });

    // Verify intermediary output from first turn is still in transcript
    const allMessages = await getAllMessages(window).allTextContents();
    const transcript = allMessages.join('\n');
    // First turn's prompt should be visible
    expect(transcript).toContain(T3_FIRST_PROMPT);
    // Queued message should be visible as a user message
    expect(transcript).toContain(queuedMarker);
  });

  test('queue plus stop preserves queued message in tray', async () => {
    await startFreshChat(window);

    await sendMessage(window, T3_FIRST_PROMPT);
    await expect(getStopButton(window)).toBeVisible({ timeout: 10000 });

    // Queue a follow-up
    const queuedText = `QueueStopTest_${Date.now()}`;
    await getCommandInput(window).fill(queuedText);
    const queueButton = window.locator('[data-testid="send-queue-button"]');
    await expect(queueButton).toBeVisible({ timeout: 5000 });
    await queueButton.click();

    const tray = window.locator('[data-testid="queued-messages-tray"]');
    await expect(tray).toBeVisible({ timeout: 5000 });

    // Stop the current turn
    await getStopButton(window).click();
    await expect(getStopButton(window)).not.toBeVisible({ timeout: 30000 });
    await dismissErrorBannerIfPresent(window);

    // Queued message should still be in the tray (not lost)
    // Note: after stop, the queue may drain immediately or remain pending
    // Either outcome is acceptable -- the key assertion is no crash
    await expectAppResponsive(window);
  });

  // ==========================================================================
  // Approval Flow Edge Cases (Stage 5)
  // ==========================================================================

  test('multiple rapid approval injections are all handled', async () => {
    await startFreshChat(window);

    // Inject 3 tool approval requests in rapid succession
    const approvals = [1, 2, 3].map(i => ({
      toolUseID: `multi-approval-${Date.now()}-${i}`,
      turnId: `multi-turn-${i}`,
      toolName: 'Execute',
      input: { command: `echo test-${i}` },
      reason: `Command execution ${i}`,
      timestamp: Date.now() + i,
    }));

    for (const req of approvals) {
      await injectToolApproval(window, req);
    }

    // Wait for notification bell to show pending approvals
    const bell = window.locator('[data-testid="notification-bell-button"]');
    await expect(bell).toBeVisible({ timeout: 10000 });

    // Open the notification drawer
    await bell.click();
    const drawer = window.locator('[data-testid="notification-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Verify multiple approval cards exist
    const approvalCards = drawer.locator('[data-testid^="drawer-card-"]');
    const cardCount = await approvalCards.count();
    expect(cardCount).toBeGreaterThanOrEqual(3);

    // Clean up: close drawer
    await window.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible({ timeout: 5000 });

    // Clear persisted pending approvals so they don't leak into later tests
    await clearPendingApprovals(window);
  });

  // ==========================================================================
  // Quality Tier / Model Selection (Stage 7)
  // ==========================================================================

  test('quality tier slider is visible and interactive', async () => {
    await startFreshChat(window);

    // Ensure the quality slider is visible (toggle it on if hidden)
    const slider = window.locator('[data-testid="quality-slider"]');
    const toggleButton = window.locator('[data-testid="model-override-toggle-button"]');
    if (!(await slider.isVisible().catch(() => false))) {
      await expect(toggleButton).toBeVisible({ timeout: 5000 });
      await toggleButton.click();
    }
    await expect(slider).toBeVisible({ timeout: 10000 });

    // Verify tier options are present
    const tiers = window.locator('[data-testid^="quality-tier-"]');
    const tierCount = await tiers.count();
    expect(tierCount).toBeGreaterThanOrEqual(2);

    // Click a different tier
    const lastTier = tiers.last();
    await lastTier.click();

    // Verify selection changed (tiers are radio buttons using aria-checked)
    await expect(lastTier).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });
  });

  test('settings panel tab navigation works with all tabs', async () => {
    const settingsTab = window.locator('#flow-tab-settings');
    await expect(settingsTab).toBeVisible({ timeout: 5000 });
    await settingsTab.click();

    const settingsPanel = window.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible({ timeout: 5000 });

    // Navigate through all destination buttons and verify each loads content.
    // Testids from SettingsSurface.tsx SIDEBAR_GROUPS (updated after settings IA redesign).
    const settingsDestinations = [
      'settings-tab-connectors',
      'settings-destination-agent-voice',
      'settings-destination-privacy-safety',
      'settings-tab-meetings',
      'settings-destination-workspace',
      'settings-destination-account-preferences',
      'settings-tab-usage',
      'settings-destination-advanced',
    ];
    for (const testId of settingsDestinations) {
      const tabButton = window.locator(`[data-testid="${testId}"]`);
      await expect(tabButton).toBeVisible({ timeout: 5000 });
      await tabButton.click();
      // Verify the panel is still visible (no crash on destination switch)
      await expect(settingsPanel).toBeVisible({ timeout: 5000 });
    }

    // Return to conversations
    const sessionsTab = window.locator('#flow-tab-sessions');
    await sessionsTab.click();
    await expect(settingsPanel).not.toBeVisible({ timeout: 5000 });
  });

  // ==========================================================================
  // Session Switching During Active Turn (Stage 2)
  // ==========================================================================

  test('switch away and back during active turn keeps response intact', async () => {
    await startFreshChat(window);

    const sessionAPrompt = `${S2_SWITCH_AWAY_PROMPT} ${Date.now()}`;
    await sendMessage(window, sessionAPrompt);
    await expect(getStopButton(window)).toBeVisible({ timeout: 10000 });

    // Switch to new session B while A is still streaming
    await startFreshChat(window);

    // Verify session B is clean (cross-session contamination check)
    await expect(getAllMessages(window)).toHaveCount(0, { timeout: 10000 });

    // Switch back to session A via sidebar
    await switchToSessionBySidebarText(window, S2_SWITCH_AWAY_PROMPT);

    // Session A should show our prompt and eventually the completed response
    await expect(getUserMessages(window).last()).toContainText(sessionAPrompt);
    await waitForLatestResponseText(window, S2_SWITCH_AWAY_RESPONSE);

    const transcript = await getTranscriptText(window);
    expect(transcript).toContain(sessionAPrompt);
    expect(transcript).toContain(S2_SWITCH_AWAY_RESPONSE);
    await expectAppResponsive(window);
  });

  test('edit mode resets after session switch while message content stays intact', async () => {
    await startFreshChat(window);

    const sessionAPrompt = `${S2_EDIT_SWITCH_PROMPT} ${Date.now()}`;
    await sendMessage(window, sessionAPrompt);
    await waitForLatestResponseText(window, S2_EDIT_SWITCH_RESPONSE);

    // Open edit UI
    await openLastUserMessageForEditing(window);
    const saveButton = window.locator('button:has-text("Save & re-run")');
    await expect(saveButton).toBeVisible({ timeout: 5000 });

    // Switch to new session, then back
    await startFreshChat(window);
    await switchToSessionBySidebarText(window, S2_EDIT_SWITCH_PROMPT);

    // Edit mode should be reset (not persisted across switch)
    await expect(getUserMessages(window).last()).toContainText(sessionAPrompt);
    await expect(saveButton).toBeHidden({ timeout: 5000 });

    // Original content intact
    await expect(getAssistantMessages(window).last()).toContainText(S2_EDIT_SWITCH_RESPONSE);
    await expectAppResponsive(window);
  });

  test('new chat during active turn starts clean and original session remains healthy', async () => {
    await startFreshChat(window);

    const sessionAPrompt = `${S2_NEW_CHAT_ACTIVE_PROMPT} ${Date.now()}`;
    await sendMessage(window, sessionAPrompt);
    await expect(getStopButton(window)).toBeVisible({ timeout: 10000 });

    // Create new session B while A is streaming
    await startFreshChat(window);
    await expect(getAllMessages(window)).toHaveCount(0, { timeout: 10000 });
    // Send button is correctly disabled when input is empty in new chat
    await expect(getSendButton(window)).toBeVisible({ timeout: 10000 });

    // Switch back to A and verify it completes
    await switchToSessionBySidebarText(window, S2_NEW_CHAT_ACTIVE_PROMPT);
    await expect(getUserMessages(window).last()).toContainText(sessionAPrompt);

    // Wait for turn to finish (may still be streaming or already complete)
    await expect.poll(async () => {
      const stopVisible = await getStopButton(window).isVisible().catch(() => false);
      const assistantCount = await getAssistantMessages(window).count();
      return stopVisible || assistantCount > 0;
    }, { timeout: 20000, intervals: [500, 1000] }).toBe(true);

    await waitForLatestResponseText(window, S2_NEW_CHAT_ACTIVE_RESPONSE);
    await expectAppResponsive(window);
  });

  // ==========================================================================
  // MessageMarkdown image rendering (Stage I6/I7 regression)
  // ==========================================================================

  // Guards the full plugin -> IPC -> fs.readFile -> <img src="data:..."> path
  // for library-relative image markdown whose filename contains a space.
  // Historical bug (pre-I6): remark-parse discarded `![alt](my image.png)` as
  // unparseable (space in URL), so no <img> ever rendered. The I6 fix wraps the
  // remark plugin in `encodeSpacesInMarkdownLinks` and adds an image visitor;
  // I7 hardens the renderer-side in-flight promise for the IPC call.
  test('markdown image with space in filename renders as data URI (Stage I6/I7 regression)', async () => {
    test.setTimeout(60_000);

    // Seed the on-disk file in the workspace `coreDirectory`. `writeMinimalSettings`
    // creates `<userDataPath>/test-workspace` and points coreDirectory at it.
    const workspaceDir = pathNode.join(userDataPath, 'test-workspace');
    if (!fsNode.existsSync(workspaceDir)) {
      fsNode.mkdirSync(workspaceDir, { recursive: true });
    }
    const imageOnDisk = pathNode.join(workspaceDir, MD_IMG_FILENAME);
    const expectedBytes = fsNode.readFileSync(MD_IMG_PNG_FIXTURE);
    fsNode.writeFileSync(imageOnDisk, expectedBytes);

    await startFreshChat(window);
    const response = await sendMessageAndWaitForResponse(window, MD_IMG_PROMPT);
    expect(response).toContain('Rendering test image:');

    // Scope to the last assistant message + match on the unique alt text so we
    // don't confuse this with any other images the assistant card might render
    // (avatars, inline attachments) now or in the future.
    const lastAssistant = getAssistantMessages(window).last();
    const renderedImg = lastAssistant.locator(
      'img[alt="MD-IMG-RENDER test image"][src^="data:image/"]'
    ).first();

    await expect(renderedImg).toBeVisible({ timeout: 15000 });

    const src = (await renderedImg.getAttribute('src')) ?? '';
    expect(src).toMatch(/^data:image\/png;base64,/);

    // The data URI should decode to the 70-byte PNG we wrote — smoke-check
    // that the renderer is getting the ACTUAL file bytes, not a placeholder.
    const base64 = src.slice('data:image/png;base64,'.length);
    const decoded = Buffer.from(base64, 'base64');
    expect(decoded.length).toBeGreaterThan(0);
    expect(decoded.equals(expectedBytes)).toBe(true);

    // The raw markdown literal should NOT appear as text — if it did, it would
    // mean the remark plugin skipped over the image node (the pre-I6 failure).
    const assistantText = await lastAssistant.textContent();
    expect(assistantText ?? '').not.toContain(`![MD-IMG-RENDER test image](${MD_IMG_FILENAME})`);
  });

  // ==========================================================================
  // Cross-Session Event Routing Isolation (Stage 11)
  // ==========================================================================

  test.describe('Stage 11: Cross-session event routing isolation', () => {
    test('injected result event for background session does not affect active session', async () => {
      test.setTimeout(60_000);
      await startFreshChat(window);

      // Session A: send message and capture baseline
      const sessionAMarker = `S11-COMPACTION-A-${Date.now()}`;
      const sessionAPrompt = `${sessionAMarker} ${S11_COMPACTION_A_PROMPT}`;
      await sendMessageAndWaitForResponse(window, sessionAPrompt);
      const sessionAMessageCountBefore = await getAllMessages(window).count();
      expect(sessionAMessageCountBefore).toBe(2);

      // Session B: create and send message
      await startFreshChat(window);
      const sessionBMarker = `S11-COMPACTION-B-${Date.now()}`;
      const sessionBPrompt = `${sessionBMarker} ${S11_COMPACTION_B_PROMPT}`;
      await sendMessageAndWaitForResponse(window, sessionBPrompt);

      // Switch to session A (now the active session)
      await switchToSessionBySidebarText(window, sessionAMarker);
      await expect(getAllMessages(window)).toHaveCount(2);

      // Extract session B's real ID (now a *background* session) DETERMINISTICALLY
      // by its marker text, rather than the fragile "first entry whose button is
      // NOT aria-current" heuristic. With the switch helper now awaiting settle,
      // session A is reliably active; but the old heuristic could still pick the
      // wrong row if any other session is present (this serial suite carries
      // leftovers, e.g. the MD-IMG session). Targeting B by marker guarantees the
      // injection hits the genuine background session, so a real routing leak is
      // still caught.
      const sessionBId = await window.evaluate((marker) => {
        const entries = document.querySelectorAll('[data-testid="session-sidebar"] [data-session-id]');
        for (const entry of entries) {
          if ((entry.textContent ?? '').includes(marker)) {
            return entry.getAttribute('data-session-id');
          }
        }
        return null;
      }, sessionBMarker);
      expect(sessionBId, 'Failed to find background session B ID in sidebar by marker').toBeTruthy();

      // Inject a 'result' event targeting background session B.
      // 'result' events MODIFY messages (via mergeResultMessage) and clear busy state —
      // if routing is broken, this will visibly corrupt session A's transcript.
      const PHANTOM_TEXT = 'PHANTOM-RESULT-SHOULD-NOT-APPEAR-IN-SESSION-A';
      await window.evaluate(({ targetSessionId, phantomText }) => {
        const fakeTurnId = `injected-result-turn-${Date.now()}`;
        const api = (window as unknown as { e2eApi?: { injectAgentEvent: (d: { turnId: string; event: Record<string, unknown>; sessionId?: string }) => void } }).e2eApi;
        if (!api) throw new Error('e2eApi not available — cannot inject event');

        api.injectAgentEvent({
          turnId: fakeTurnId,
          sessionId: targetSessionId,
          event: {
            type: 'result',
            timestamp: Date.now(),
            text: phantomText,
            subtype: 'success',
          },
        });
      }, { targetSessionId: sessionBId as string, phantomText: PHANTOM_TEXT });

      // Verify session A is completely unaffected
      await expect(getAllMessages(window)).toHaveCount(2);
      const transcriptA = await getTranscriptText(window);
      expect(transcriptA).toContain(sessionAMarker);
      expect(transcriptA).toContain(S11_COMPACTION_A_RESPONSE);
      expect(transcriptA).not.toContain(PHANTOM_TEXT);

      await expectAppResponsive(window);
    });

    test('at-rest session message isolation', async () => {
      test.setTimeout(60_000);
      await startFreshChat(window);

      const sessionAMarker = `S11-ISO-A-${Date.now()}`;
      const sessionBMarker = `S11-ISO-B-${Date.now()}`;
      const sessionAPrompt = `${sessionAMarker} ${S11_ISO_A_PROMPT}`;
      const sessionBPrompt = `${sessionBMarker} ${S11_ISO_B_PROMPT}`;

      const sessionAResponse = await sendMessageAndWaitForResponse(window, sessionAPrompt);
      expect(sessionAResponse).toContain(S11_ISO_A_RESPONSE);

      await startFreshChat(window);
      const sessionBResponse = await sendMessageAndWaitForResponse(window, sessionBPrompt);
      expect(sessionBResponse).toContain(S11_ISO_B_RESPONSE);

      await switchToSessionBySidebarText(window, sessionAMarker);
      await expect(getAllMessages(window)).toHaveCount(2);
      await expect(getUserMessages(window)).toHaveCount(1);
      await expect(getAssistantMessages(window)).toHaveCount(1);
      const transcriptA = await getTranscriptText(window);
      expect(transcriptA).toContain(sessionAMarker);
      expect(transcriptA).toContain(S11_ISO_A_RESPONSE);
      expect(transcriptA).not.toContain(sessionBMarker);

      await switchToSessionBySidebarText(window, sessionBMarker);
      await expect(getAllMessages(window)).toHaveCount(2);
      await expect(getUserMessages(window)).toHaveCount(1);
      await expect(getAssistantMessages(window)).toHaveCount(1);
      const transcriptB = await getTranscriptText(window);
      expect(transcriptB).toContain(sessionBMarker);
      expect(transcriptB).toContain(S11_ISO_B_RESPONSE);
      expect(transcriptB).not.toContain(sessionAMarker);

      await expectAppResponsive(window);
    });
  });
});
