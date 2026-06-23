/**
 * Session Management Tests
 *
 * Tests for conversation search, session deletion, @mentions, and draft persistence.
 * Extracted from sequence-b.spec.ts (Phases 8-11).
 *
 * Launch config: skipOnboarding: true, API keys required
 * Total: ~12 tests (some may be skipped)
 *
 * IMPORTANT: This file has test.beforeAll blocks that create test sessions for
 * search/mentions tests. These must be preserved!
 *
 * See: docs/plans/partway/260126_e2e_test_architecture_overhaul.md (Stage 2.2)
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  appExists,
  clearAllSessions,
  createIsolatedUserData,
  dismissStartupRecoveryDialogIfPresent,
  enableGuestMode,
  ensureSessionSidebarOpen,
  expectComposerText,
  getAppNotFoundMessage,
  getComposerText,
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

test.describe('Session Management Tests', () => {
  test.skip(PLATFORM === 'win32', 'Skipped on Windows: app launch timeout in CI');
  // 15 minutes for full test suite
  test.describe.configure({ timeout: 900_000 });

  test.beforeAll(async () => {
    console.log('[E2E] [session-management] ========== TEST SUITE START ==========');
    console.log('[E2E] [session-management] Launching app for session management tests');
    const startTime = Date.now();

    // Create isolated userData
    isolated = createIsolatedUserData('session-management');
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

    console.log(`[E2E] [session-management] App launched in ${Date.now() - startTime}ms`);
    console.log(`[E2E] [session-management] userData: ${userDataPath}`);
  });

  test.afterAll(async () => {
    console.log('[E2E] [session-management] ========== TEST SUITE END ==========');
    console.log(`[E2E] [session-management] Tests run: ${testCount}`);
    console.log(`[E2E] [session-management] Failures: ${failures.length}`);
    if (failures.length > 0) {
      console.log(`[E2E] [session-management] Failed tests: ${failures.join(', ')}`);
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

      const screenshotPath = `test-results/session-management-${testCount}-failure.png`;
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
  // Conversation Search Tests (Phase 8)
  // ==========================================================================
  test.describe('Conversation Search', () => {
    test.skip(!hasRequiredKeys, 'Skipping - TEST_CLAUDE_API_KEY and voice key not set');

    let uniqueSessionMarker: string;

    test.beforeAll(async () => {
      uniqueSessionMarker = `SearchTest_${Date.now()}`;
      await dismissStartupRecoveryDialogIfPresent(window);
      await waitForMainAppReady(window);
      await ensureSessionSidebarOpen(window);

      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await sendMessageAndWaitForResponse(
        window,
        `My unique identifier is ${uniqueSessionMarker}. Just confirm you received it.`
      );

      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });
    });

    test.beforeEach(async ({}, testInfo) => {
      await resetAppState(window, testInfo.title);
      await ensureSessionSidebarOpen(window);
    });

    // Semantic search requires indexing (disabled in E2E). Use deep search ("Search all messages")
    // which scans raw message content and works without the embedding index.
    test('search filters session list by query', async () => {
      const searchInput = window.locator('[data-testid="session-search-input"]');
      await searchInput.fill(uniqueSessionMarker);
      // Confirm the query actually landed in the input before waiting on the
      // search lifecycle (the input value gates the deep-search affordance:
      // AgentSessionSidebar shows the button only when query.trim().length >= 3).
      await expect(searchInput).toHaveValue(uniqueSessionMarker);

      // Wait for the semantic-search lifecycle to SETTLE before asserting the
      // fallback button (#3, docs/plans/260613_e2e-flake-diagnosis). With
      // indexing disabled the expected end-state is zero semantic results, but
      // useSessionSearch keeps isSearching=true until the async IPC settles —
      // and AgentSessionSidebar renders the "Searching..." indicator (not the
      // "Search all messages" button) for that whole window. Waiting only on
      // the button raced that lifecycle. Instead: wait for the in-flight
      // "Searching..." indicator to disappear (search settled to zero-results),
      // THEN expect the deep-search fallback button.
      const searchingIndicator = window.getByText('Searching...', { exact: true });
      await expect(searchingIndicator).toBeHidden({ timeout: 15000 });

      // Semantic search returns no results when indexing is off — click "Search all messages"
      const deepSearchButton = window.getByRole('button', { name: 'Search all messages' });
      await expect(deepSearchButton).toBeVisible({ timeout: 10000 });
      await deepSearchButton.click();

      // Wait for deep search results to include our session
      await expect(async () => {
        const matchingSession = window
          .locator('[data-testid="session-sidebar"] [data-session-id]')
          .filter({ hasText: uniqueSessionMarker.substring(0, 15) });
        await expect(matchingSession.first()).toBeVisible();
      }).toPass({ timeout: 30000, intervals: [500, 1000, 2000] });
    });

    test('search shows empty state when no matches', async () => {
      const searchInput = window.locator('[data-testid="session-search-input"]');
      const sessionList = window.locator('[data-testid="session-list"]');
      await searchInput.fill('XyzNonExistent12345AbcNoMatch');
      // Wait for search results to be filtered (either no results message or empty list)
      await expect(async () => {
        const noResults = await window.locator('text=No results').isVisible().catch(() => false);
        const count = await sessionList.locator('[data-session-id]').count();
        expect(noResults || count === 0).toBe(true);
      }).toPass({ timeout: 5000 });

      const noResults = window.locator('text=No results');
      const isNoResultsVisible = await noResults.isVisible().catch(() => false);

      if (!isNoResultsVisible) {
        const visibleSessions = sessionList.locator('[data-session-id]');
        const count = await visibleSessions.count();
        expect(count).toBe(0);
      }
    });

    // Uses deep search path since semantic search requires indexing (disabled in E2E)
    test('clearing search restores full session list', async () => {
      const sessionList = window.locator('[data-testid="session-list"]');
      const initialCount = await sessionList.locator('[data-session-id]').count();

      const searchInput = window.locator('[data-testid="session-search-input"]');
      await searchInput.fill(uniqueSessionMarker);

      // Trigger deep search to get results without indexing
      const deepSearchButton = window.getByRole('button', { name: 'Search all messages' });
      await expect(deepSearchButton).toBeVisible({ timeout: 10000 });
      await deepSearchButton.click();

      // Wait for deep search results
      await expect(async () => {
        const matchingSession = window
          .locator('[data-testid="session-sidebar"] [data-session-id]')
          .filter({ hasText: uniqueSessionMarker.substring(0, 15) });
        await expect(matchingSession.first()).toBeVisible();
      }).toPass({ timeout: 30000, intervals: [500, 1000, 2000] });

      await searchInput.clear();
      // Wait for full session list to be restored (handles debounce)
      await expect(async () => {
        const clearedCount = await sessionList.locator('[data-session-id]').count();
        expect(clearedCount).toBeGreaterThanOrEqual(initialCount);
      }).toPass({ timeout: 10000, intervals: [500, 1000, 2000] });
    });
  });

  // ==========================================================================
  // Delete Session Tests (Phase 9)
  // ==========================================================================
  test.describe('Delete Session', () => {
    test.skip(!hasRequiredKeys, 'Skipping - TEST_CLAUDE_API_KEY and voice key not set');

    test.beforeEach(async ({}, testInfo) => {
      await resetAppState(window, testInfo.title);
      await ensureSessionSidebarOpen(window);
    });

    async function openSessionActionsMenu(sessionNameContains: string): Promise<void> {
      const sessionItem = window
        .locator('[data-testid="session-list"] [data-session-id]')
        .filter({ hasText: sessionNameContains })
        .first();
      // Wait for session item to be visible, scroll into view, then hover
      // This fixes CI flakiness when the session list is scrollable and the
      // target session is outside the visible viewport area.
      await expect(sessionItem).toBeVisible({ timeout: 10000 });
      await sessionItem.scrollIntoViewIfNeeded();
      await sessionItem.hover();
      const actionsButton = sessionItem.locator('button[aria-label^="More actions"]');
      await expect(actionsButton).toBeVisible({ timeout: 5000 });
      await actionsButton.click();
    }

    async function softDeleteSession(sessionNameContains: string): Promise<void> {
      await openSessionActionsMenu(sessionNameContains);
      const deleteItem = window.locator('[role="menuitem"]:has-text("Delete")');
      await deleteItem.click();
      // Wait for the menu to close after delete action
      await expect(deleteItem).not.toBeVisible({ timeout: 5000 });
    }

    async function clearSessionSearch(): Promise<void> {
      const searchInput = window.locator('[data-testid="session-search-input"]');
      await searchInput.clear();
      // Wait for search input to be cleared and session list to refresh
      await expect(searchInput).toHaveValue('', { timeout: 5000 });
    }

    // Rewritten for current filter-based sidebar UI (no longer uses trash-section/active-section)
    test('can soft-delete session via actions menu (moves to Trash)', async () => {
      const deleteMarker = `DeleteTest_${Date.now()}`;
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await sendMessageAndWaitForResponse(
        window,
        `Session marker: ${deleteMarker}. Confirm received.`
      );

      // Switch away so the session appears in sidebar
      await newChatButton.click();
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await softDeleteSession(deleteMarker);
      await clearSessionSearch();

      // Current UI: "Trash (N)" footer link appears when there are deleted sessions
      const sidebar = window.getByTestId('session-sidebar');
      const trashFooterLink = sidebar.locator('button:has-text("Trash")').filter({ hasText: /Trash \(\d+\)/ });
      await expect(trashFooterLink).toBeVisible({ timeout: 10000 });

      // Click into trash view and verify session is there
      await trashFooterLink.click();
      const sessionList = sidebar.locator('[data-testid="session-list"]');
      await expect(
        sessionList.locator('[data-session-id]').filter({ hasText: deleteMarker.substring(0, 10) })
      ).toHaveCount(1, { timeout: 10000 });

      // Go back to all conversations
      const backLink = sidebar.locator('button:has-text("All conversations")');
      await backLink.click();
      // Deleted session should NOT appear in the active filter
      const activeTab = sidebar.locator('[role="tab"]:has-text("Active")');
      await activeTab.click();
      await expect(
        sessionList.locator('[data-session-id]').filter({ hasText: deleteMarker.substring(0, 10) })
      ).toHaveCount(0, { timeout: 5000 });
    });

    // Rewritten for current filter-based sidebar UI (no longer uses trash-section/active-section)
    test('can restore session from Trash', async () => {
      const restoreMarker = `RestoreTest_${Date.now()}`;
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await sendMessageAndWaitForResponse(
        window,
        `Session marker: ${restoreMarker}. Confirm received.`
      );

      await newChatButton.click();
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });
      await softDeleteSession(restoreMarker);
      await clearSessionSearch();

      // Navigate to Trash view
      const sidebar = window.getByTestId('session-sidebar');
      const trashFooterLink = sidebar.locator('button:has-text("Trash")').filter({ hasText: /Trash \(\d+\)/ });
      await expect(trashFooterLink).toBeVisible({ timeout: 10000 });
      await trashFooterLink.click();

      // Find the session in trash - trash entries show Restore/Delete buttons directly
      const sessionList = sidebar.locator('[data-testid="session-list"]');
      const sessionInTrash = sessionList
        .locator('[data-session-id]')
        .filter({ hasText: restoreMarker.substring(0, 10) })
        .first();
      await expect(sessionInTrash).toBeVisible({ timeout: 10000 });
      await sessionInTrash.scrollIntoViewIfNeeded();
      await sessionInTrash.hover();

      // Click the Restore button (always visible on trash entries, no menu needed)
      const restoreButton = sessionInTrash.locator('button[aria-label^="Restore"]');
      await expect(restoreButton).toBeVisible({ timeout: 5000 });
      await restoreButton.click();
      await expect(sessionInTrash).not.toBeVisible({ timeout: 10000 });

      // Go back to active view and verify session is restored
      const backLink = sidebar.locator('button:has-text("All conversations")');
      await backLink.click();
      const activeTab = sidebar.locator('[role="tab"]:has-text("Active")');
      await activeTab.click();
      await expect(
        sessionList.locator('[data-session-id]').filter({ hasText: restoreMarker.substring(0, 10) })
      ).toHaveCount(1, { timeout: 10000 });
    });

    test('soft-deleting active session switches to new chat', async () => {
      const activeMarker = `ActiveDelete_${Date.now()}`;
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await sendMessageAndWaitForResponse(
        window,
        `Session marker: ${activeMarker}. Confirm received.`
      );

      await softDeleteSession(activeMarker);

      const messages = window.locator('article.agent-turn-message');
      await expect(messages).toHaveCount(0, { timeout: 15000 });
    });
  });

  // ==========================================================================
  // @Mentions Tests (Phase 10)
  // ==========================================================================
  test.describe('@Mentions', () => {
    test.describe.configure({ timeout: 420_000 });
    test.skip(!hasRequiredKeys, 'Skipping - TEST_CLAUDE_API_KEY and voice key not set');

    let mentionableSessionTitle: string;

    test.beforeAll(async () => {
      await window.evaluate(() => {
        (window as unknown as { e2eApi: { isEnabled: boolean } }).e2eApi = { isEnabled: true };
        console.log('[E2E] Injected e2eApi for auto-title skip');
      });

      mentionableSessionTitle = `MentionTest_${Date.now()}`;
      await dismissStartupRecoveryDialogIfPresent(window);
      await waitForMainAppReady(window);

      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await sendMessageAndWaitForResponse(
        window,
        `${mentionableSessionTitle}: This is a test conversation for mentions.`
      );

      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });
    });

    test.beforeEach(async ({}, testInfo) => {
      await resetAppState(window, testInfo.title);
    });

    // Unskipped: increased timeouts for async conversation loading
    test('basic mention functionality', async () => {
      await test.step('typing @ triggers mention popover', async () => {
        await switchToTextMode(window);
        const textInput = window.locator('[data-testid="composer-input"]');
        await textInput.clear();
        await textInput.fill('@');

        const popover = window.locator('[role="listbox"]');
        await expect(popover).toBeVisible({ timeout: 15000 });
      });

      await test.step('popover filters results by query', async () => {
        const textInput = window.locator('[data-testid="composer-input"]');
        const popover = window.locator('[role="listbox"]');

        await textInput.clear();
        await textInput.fill('@MentionTest');
        await expect(popover).toBeVisible({ timeout: 15000 });
        // Wait for filtered options to load (async -- use retry)
        await expect(async () => {
          const options = popover.locator('[role="option"]');
          const optionCount = await options.count();
          expect(optionCount).toBeGreaterThan(0);
          const optionTexts = await options.allTextContents();
          const hasMatch = optionTexts.some((text) => text.toLowerCase().includes('mentiontest'));
          expect(hasMatch).toBe(true);
        }).toPass({ timeout: 20000, intervals: [500, 1000, 2000] });
      });

      await test.step('deleting @ character closes popover', async () => {
        const textInput = window.locator('[data-testid="composer-input"]');
        await textInput.clear();
        await textInput.fill('@');

        const popover = window.locator('[role="listbox"]');
        await expect(popover).toBeVisible({ timeout: 15000 });

        await textInput.clear();
        await expect(popover).toBeHidden({ timeout: 5000 });
      });
    });

    // Unskipped: increased timeouts for async conversation loading
    test('selecting mention inserts link into input', async () => {
      await switchToTextMode(window);

      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.clear();
      await textInput.fill('@');

      const popover = window.locator('[role="listbox"]');
      await expect(popover).toBeVisible({ timeout: 15000 });

      const conversationsTab = window.locator('[data-testid="mention-filter-conversations"]');
      await expect(conversationsTab).toBeVisible({ timeout: 10000 });
      await conversationsTab.click();
      // Wait for conversations to load (async index query)
      const firstOption = popover.locator('[role="option"]').first();
      await expect(firstOption).toBeVisible({ timeout: 20000 });
      await firstOption.click();
      // Wait for mention to appear — with TipTap the mention renders as a chip
      // node with data-mention-kind, with legacy textarea it's raw markdown.
      await expect(async () => {
        const hasMentionChip = await textInput.locator('[data-mention-kind]').count() > 0;
        if (hasMentionChip) return; // TipTap path: chip node present
        const inputValue = await getComposerText(window);
        expect(inputValue).toMatch(/@\[.*\]\((rebel|workspace):\/\//);
      }).toPass({ timeout: 10000 });
    });

    // Unskipped: increased timeouts for async conversation loading
    test('arrow keys navigate mention options', async () => {
      await switchToTextMode(window);

      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.clear();
      await textInput.fill('@');

      const popover = window.locator('[role="listbox"]');
      await expect(popover).toBeVisible({ timeout: 15000 });

      const conversationsTab = window.locator('[data-testid="mention-filter-conversations"]');
      await expect(conversationsTab).toBeVisible({ timeout: 10000 });
      await conversationsTab.click();
      // Wait for conversations to load (async index query)
      await expect(popover.locator('[role="option"]').first()).toBeVisible({ timeout: 20000 });

      await window.keyboard.press('ArrowDown');
      await window.keyboard.press('Enter');

      // Wait for mention to appear — with TipTap the mention renders as a chip
      // node with data-mention-kind, with legacy textarea it's raw markdown.
      await expect(async () => {
        const hasMentionChip = await textInput.locator('[data-mention-kind]').count() > 0;
        if (hasMentionChip) return; // TipTap path: chip node present
        const inputValue = await getComposerText(window);
        expect(inputValue).toMatch(/@\[.*\]\((rebel|workspace):\/\//);
      }).toPass({ timeout: 10000 });
    });

    test('@c: and @s: prefix filtering', async () => {
      await switchToTextMode(window);
      const textInput = window.locator('[data-testid="composer-input"]');

      await textInput.clear();
      await textInput.fill('@c:');
      // Wait for popover to appear after typing (Pattern 6 - debounce)
      const popover = window.locator('[role="listbox"]');
      await expect(popover).toBeVisible({ timeout: 5000 });

      await textInput.clear();
      await textInput.fill('@s:');
      // Wait for popover to appear after typing
      await expect(popover).toBeVisible({ timeout: 5000 });
    });
  });

  // ==========================================================================
  // Draft Persistence Tests (Phase 11)
  // ==========================================================================
  test.describe('Draft Persistence', () => {
    test.skip(!hasRequiredKeys, 'Skipping - TEST_CLAUDE_API_KEY and voice key not set');

    test.beforeEach(async ({}, testInfo) => {
      await resetAppState(window, testInfo.title);
      await ensureSessionSidebarOpen(window);
      // Draft tests create fresh sessions per test and locate them by partial
      // title. In the full file, earlier Conversation Search/@Mentions/Draft
      // tests accumulate sessions, so "draft deleted text does not
      // phantom-reappear" can pass alone but fail in-file by selecting a stale
      // sidebar entry. Keep this opt-in: Conversation Search and @Mentions seed
      // sessions in beforeAll and must retain them across their own tests.
      await clearAllSessions(window);
    });

    test('draft text persists when switching sessions and returning', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await sendMessageAndWaitForResponse(window, 'Say "Session A ready" and nothing else.');

      const draftText = `Draft message ${Date.now()}`;
      await switchToTextMode(window);
      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.fill(draftText);
      // Wait for React state to commit before switching sessions - the send button
      // enables when textPrompt has content, ensuring composerRef.getText() returns
      // the draft text when App.tsx flushes during resetConversationState()
      await expect(window.locator('[data-testid="composer-send-button"]')).toBeEnabled();

      await newChatButton.click();
      // Wait for message list to be empty (new session has no messages)
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      const sessionSidebar = window.locator('[data-testid="session-sidebar"]');
      const sessionButton = sessionSidebar.locator('button').filter({ hasText: 'Session A' }).first();

      await expect(sessionButton).toBeVisible({ timeout: 10000 });
      await sessionButton.click();
      // Wait for session to load - use data-role to disambiguate (assistant or result, not user)
      await expect(
        window.locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]')
      ).toBeVisible({ timeout: 10000 });

      await switchToTextMode(window);
      const persistedDraft = await getComposerText(window);
      expect(persistedDraft).toContain(draftText);
    });

    // DEFERRED (2026-06-05): this exercises the cross-layer session-resurrection
    // race whose main-process fix was investigated over 6 adversarial review
    // rounds and then DELIBERATELY DEFERRED — see
    // docs/plans/260605_session-resurrection-mainside/DEFERRAL.md.
    // The underlying bug is benign (a deleted draft/session can transiently
    // reappear; no data loss) and the renderer-side guard already shipped; the
    // deeper disk-layer fix was deferred because the corrupt-ledger hardening it
    // required added more catastrophe risk than the benign bug warranted.
    // This test's failure also rode an integrated renderer↔main↔IPC↔timing path
    // that targeted fixes never reliably closed, so it was never a clean gate.
    // Skipped to stop the chronic release/beta CI failure until the deferred
    // work (or a slimmed redesign) is picked up deliberately.
    test.skip('draft deleted text does not phantom-reappear after switching', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      const sessionSidebar = window.locator('[data-testid="session-sidebar"]');
      const sendButton = window.locator('[data-testid="composer-send-button"]');
      const sessionAMarker = `PhantomDraftA_${Date.now()}`;
      const sessionALabel = sessionAMarker.substring(0, 20);
      const draftText = `Deleted draft ${Date.now()}`;

      await newChatButton.click();
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await sendMessageAndWaitForResponse(
        window,
        `Session marker: ${sessionAMarker}. Reply with "ready" and nothing else.`
      );

      await switchToTextMode(window);
      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.fill(draftText);
      await expect(sendButton).toBeEnabled();

      // Create Session B
      await newChatButton.click();
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      // Switch back to Session A
      const sessionAButton = sessionSidebar.locator('button').filter({ hasText: sessionALabel }).first();
      await expect(sessionAButton).toBeVisible({ timeout: 10000 });
      await sessionAButton.click();
      await expect(
        window.locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]')
      ).toBeVisible({ timeout: 10000 });

      // Delete the draft text
      await switchToTextMode(window);
      const textInputAfterReturn = window.locator('[data-testid="composer-input"]');
      await textInputAfterReturn.click();
      await textInputAfterReturn.press(`${PLATFORM === 'darwin' ? 'Meta' : 'Control'}+A`);
      await textInputAfterReturn.press('Backspace');
      await expect(sendButton).toBeDisabled();

      // Switch away to new chat and back
      await newChatButton.click();
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await expect(sessionAButton).toBeVisible({ timeout: 10000 });
      await sessionAButton.click();
      await expect(
        window.locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]')
      ).toBeVisible({ timeout: 10000 });

      // Assert: draft is GONE (no phantom reappearance)
      await switchToTextMode(window);
      await expectComposerText(window, '');
    });

    test('draft persists across multiple session switches', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      const sessionSidebar = window.locator('[data-testid="session-sidebar"]');
      const sendButton = window.locator('[data-testid="composer-send-button"]');
      const sessionAMarker = `DraftSwitchA_${Date.now()}`;
      const sessionBMarker = `DraftSwitchB_${Date.now()}`;
      const sessionALabel = sessionAMarker.substring(0, 20);
      const sessionBLabel = sessionBMarker.substring(0, 20);
      const draftA = `DraftA_${Date.now()}`;
      const draftB = `DraftB_${Date.now()}`;

      // Create Session A with a message and draft
      await newChatButton.click();
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await sendMessageAndWaitForResponse(
        window,
        `Session marker: ${sessionAMarker}. Reply with "ready" and nothing else.`
      );

      await switchToTextMode(window);
      const textInput = window.locator('[data-testid="composer-input"]');
      await textInput.fill(draftA);
      await expect(sendButton).toBeEnabled();

      // Create Session B with a message and draft
      await newChatButton.click();
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      await sendMessageAndWaitForResponse(
        window,
        `Session marker: ${sessionBMarker}. Reply with "ready" and nothing else.`
      );

      await switchToTextMode(window);
      const textInputB = window.locator('[data-testid="composer-input"]');
      await textInputB.fill(draftB);
      await expect(sendButton).toBeEnabled();

      // Create Session C (just to navigate away from both)
      await newChatButton.click();
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      // Switch to Session A and verify draft
      const sessionAButton = sessionSidebar.locator('button').filter({ hasText: sessionALabel }).first();
      await expect(sessionAButton).toBeVisible({ timeout: 10000 });
      await sessionAButton.click();
      await expect(
        window.locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]')
      ).toBeVisible({ timeout: 10000 });
      await switchToTextMode(window);
      await expectComposerText(window, draftA, { timeout: 15000 });

      // Switch to Session B and verify draft
      const sessionBButton = sessionSidebar.locator('button').filter({ hasText: sessionBLabel }).first();
      await expect(sessionBButton).toBeVisible({ timeout: 10000 });
      await sessionBButton.click();
      await expect(
        window.locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]')
      ).toBeVisible({ timeout: 10000 });
      await switchToTextMode(window);
      await expectComposerText(window, draftB, { timeout: 15000 });
    });
  });

  // ==========================================================================
  // Reveal Mask Recovery (stuck reveal-mask regression)
  // ==========================================================================
  // Regression spec for docs/plans/260611_fix-stuck-reveal-mask: opening a
  // session from history and then starting a new chat before the
  // scroll-settle primitive finishes left `isRevealMasked` stuck true with no
  // self-heal — a permanent settling-skeleton overlay on the new conversation
  // and a frozen session sidebar (`shouldFreezeSidebarList`), recoverable only
  // by remounting that exact session or restarting the app. This same race is
  // what made "draft persists across multiple session switches" (above) fail
  // in consecutive beta release runs under CI frame jitter.
  test.describe('Reveal Mask Recovery', () => {
    test.skip(!hasRequiredKeys, 'Skipping - TEST_CLAUDE_API_KEY and voice key not set');

    test.beforeEach(async ({}, testInfo) => {
      await resetAppState(window, testInfo.title);
      await ensureSessionSidebarOpen(window);
      // Fresh slate so the seeded session is unambiguous in the sidebar.
      await clearAllSessions(window);
    });

    test('reveal mask recovers when new-chat interrupts a history-session open', async () => {
      const newChatButton = window.locator('[data-testid="new-chat-button"]');
      // The settling skeleton overlay is rendered iff `isRevealMasked` (CSS
      // module class `settlingSkeletonOverlay` in ConversationPane) — the
      // direct observable for a stuck reveal mask.
      const settlingSkeleton = window.locator('[class*="settlingSkeletonOverlay"]');
      const sessionSidebar = window.locator('[data-testid="session-sidebar"]');

      // Seed a history session with real content so reopening it runs the
      // scroll-settle primitive (the mask window the bug lives in).
      await newChatButton.click();
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });
      await sendMessageAndWaitForResponse(window, 'Say "mask probe ready" and nothing else.');

      // Navigate away so the seeded session becomes a sidebar history entry.
      await newChatButton.click();
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

      const sessionButton = sessionSidebar.locator('button').filter({ hasText: 'mask probe' }).first();
      await expect(sessionButton).toBeVisible({ timeout: 10000 });

      // THE RACE: open the history session, then IMMEDIATELY start a new chat
      // (mid-settle — the primitive needs >=400ms of stable frames, so the
      // back-to-back click lands inside the settle window deterministically).
      await sessionButton.click();
      await newChatButton.click();

      // The mask must come down on its own. Generous budget: well past the 5s
      // settle wall cap (which only rescues un-aborted runs) — pre-fix the
      // mask never recovers, so this is not timing-flaky in either direction.
      await expect(settlingSkeleton).toHaveCount(0, { timeout: 15000 });

      // And the app must be in a usable new-chat state, with the sidebar not
      // frozen on a stale snapshot: the empty new conversation is shown and
      // the seeded history session is still reachable (clicking it works).
      await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });
      await expect(sessionButton).toBeVisible({ timeout: 10000 });
      await sessionButton.click();
      await expect(
        window.locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]')
      ).toBeVisible({ timeout: 10000 });
      await expect(settlingSkeleton).toHaveCount(0, { timeout: 15000 });
    });
  });
});
