/**
 * Approval Flows Tests
 *
 * Tests for tool safety and memory write approval via IPC injection.
 * Verifies the new approval UX: ApprovalPointerBar → NotificationDrawer → DrawerApprovalCard.
 *
 * Extracted from: sequence-a.spec.ts (Phase 7)
 * See: docs/plans/partway/260126_e2e_test_architecture_overhaul.md (Stage 2.2)
 *
 * Updated 2026-03-25: Migrated from deleted PendingReviewBar / PendingApprovalsStrip
 * to ApprovalPointerBar + NotificationDrawer (FOX-2816 refactor).
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  appExists,
  clearPendingApprovals,
  createIsolatedUserData,
  dismissStartupRecoveryDialogIfPresent,
  enableGuestMode,
  getAppNotFoundMessage,
  getFirstWindow,
  injectMemoryApproval,
  injectToolApproval,
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

/**
 * Open the NotificationDrawer by clicking the bell button (if not already open).
 */
async function openNotificationDrawer(page: Page): Promise<void> {
  const bell = page.locator('[data-testid="notification-bell-button"]');
  const isOpen = await bell.getAttribute('aria-pressed').catch(() => null);
  if (isOpen !== 'true') {
    await bell.click();
    await expect(bell).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 });
  }
}

/**
 * Close the NotificationDrawer by clicking the bell button (if open).
 *
 * State-driven + tolerant (teardown robustness, see #1 in
 * docs/plans/260613_e2e-flake-diagnosis): the close path is direct React state
 * (FlowPanelsProvider sets approvalsDrawerOpen=false, no delayed machine), so a
 * single click + a tight 2s hard assert flaked purely on actionability/render
 * timing under parallel-worker load. We instead poll the closed state with a
 * generous budget and re-issue the toggle if a click didn't register, rather
 * than failing on the first miss. This is teardown only — the real coverage
 * (inject → open → Allow → card removed) is asserted by the test body.
 */
async function closeNotificationDrawer(page: Page): Promise<void> {
  const bell = page.locator('[data-testid="notification-bell-button"]');
  await expect(async () => {
    const isOpen = await bell.getAttribute('aria-pressed').catch(() => null);
    if (isOpen === 'false') {
      return; // closed (auto-close from item removal, or a prior click landed)
    }
    // Still open (or attribute unreadable) — (re-)issue the toggle, then let the
    // next poll iteration confirm the closed state.
    await bell.click();
    await expect(bell).toHaveAttribute('aria-pressed', 'false', { timeout: 1000 });
  }).toPass({ timeout: 10000, intervals: [250, 500, 1000] });
}

/**
 * Expand the first collapsed group in the NotificationDrawer.
 * Drawer groups start collapsed; clicking the header expands them.
 */
async function expandFirstDrawerGroup(page: Page): Promise<void> {
  // The aria-expanded attribute lives on the child toggle button, not the
  // group-header div. Prefer the stable test id, falling back to the class.
  const groupToggle = page
    .locator(
      '[data-testid="notification-drawer-group-toggle"], .notification-drawer__group-toggle'
    )
    .first();
  await expect(groupToggle).toBeVisible({ timeout: 5000 });
  const isExpanded = await groupToggle.getAttribute('aria-expanded');
  if (isExpanded !== 'true') {
    await groupToggle.click();
    await expect(groupToggle).toHaveAttribute('aria-expanded', 'true', { timeout: 2000 });
  }
}

test.describe('Approval Flows', () => {
  test.describe.configure({ timeout: 300_000 }); // 5 minutes

  test.beforeAll(async () => {
    console.log('[E2E] [approval-flows] ========== TEST SUITE START ==========');
    console.log('[E2E] [approval-flows] Launching app with seeded settings');
    const startTime = Date.now();

    isolated = createIsolatedUserData('approval-flows');
    writeMinimalSettings(isolated.path);

    app = await launchWithIsolatedUserData(isolated, {
      skipOnboarding: true,
    });
    window = await getFirstWindow(app);

    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);

    await expect(window.locator('[data-testid="brand-home"]')).toBeVisible({ timeout: 15000 });

    console.log(`[E2E] [approval-flows] App launched and ready in ${Date.now() - startTime}ms`);
    console.log(`[E2E] [approval-flows] userData: ${isolated.path}`);
  });

  test.afterAll(async () => {
    console.log('[E2E] [approval-flows] ========== TEST SUITE END ==========');
    await safeCloseApp(app, 15000, isolated.path);

    if (!process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated?.cleanup();
    } else {
      console.log(`[DEBUG] Keeping test userData at: ${isolated.path}`);
    }
  });

  test.beforeEach(async ({}, testInfo) => {
    await resetAppState(window, testInfo.title);

    // Dismiss any open dialogs/overlays (preview dialog, modals) before cleanup
    const previewDialog = window.locator('[data-testid="memory-preview-dialog"]');
    if (await previewDialog.isVisible({ timeout: 500 }).catch(() => false)) {
      await window.keyboard.press('Escape');
      await expect(previewDialog).not.toBeVisible({ timeout: 3000 });
    }
    await window.keyboard.press('Escape');
    await window.waitForTimeout(200);

    // Close notification drawer if open from a previous test
    await closeNotificationDrawer(window);

    // Programmatically clear all pending approvals (tool, memory, in-memory metadata).
    // This replaces the fragile UI-based drawer cleanup that expanded groups and
    // force-clicked deny buttons in a loop.
    await clearPendingApprovals(window);

    // Now start a fresh conversation with all approvals cleared
    const newChatButton = window.locator('[data-testid="new-chat-button"]');
    await expect(newChatButton).toBeVisible({ timeout: 10000 });
    await newChatButton.click();

    await expect(window.locator('article.agent-turn-message')).toHaveCount(0, { timeout: 10000 });

    await expect(window.locator('[data-testid="interaction-strip"]')).toBeVisible({
      timeout: 10000,
    });
  });

  // ==========================================================================
  // Tool Safety Approval (3 tests)
  // Uses ApprovalPointerBar → NotificationDrawer → DrawerApprovalCard
  // ==========================================================================
  test.describe('Tool Safety Approval Bar', () => {
    test('shows approval bar when tool-safety:approval-request is received', async () => {
      const mockRequest = {
        toolUseID: 'test-tool-use-123',
        turnId: 'test-turn-456',
        toolName: 'Execute',
        input: { command: 'rm -rf /tmp/test' },
        reason: 'This command could delete files',
        timestamp: Date.now(),
      };

      await injectToolApproval(window, mockRequest);

      // ApprovalPointerBar should appear in session surface
      const pointerBar = window.locator('[data-testid="approval-pointer-bar"]');
      await expect(pointerBar).toBeVisible({ timeout: 5000 });
      await expect(pointerBar).toContainText(/needs your OK|action/i);

      // Clean up so the injected approval doesn't leak into the next test.
      await clearPendingApprovals(window);
    });

    test('dismisses approval when Allow is clicked in drawer', async () => {
      const mockRequest = {
        toolUseID: 'test-tool-use-dismiss-' + Date.now(),
        turnId: 'test-turn-dismiss',
        toolName: 'Write',
        input: { path: '/tmp/test.txt', content: 'test' },
        reason: 'File write operation',
        timestamp: Date.now(),
      };

      await injectToolApproval(window, mockRequest);

      const pointerBar = window.locator('[data-testid="approval-pointer-bar"]');
      await expect(pointerBar).toBeVisible({ timeout: 5000 });

      await dismissStartupRecoveryDialogIfPresent(window);

      // Click "View" to open the notification drawer
      await window.locator('[data-testid="approval-pointer-review"]').click();

      // Expand the group and find the approval card
      await expandFirstDrawerGroup(window);
      const approveButton = window.locator('[data-testid="drawer-card-approve"]').first();
      await expect(approveButton).toBeVisible({ timeout: 3000 });
      await approveButton.click();

      // Wait for the 800ms SUCCESS_DISPLAY_DURATION to finish so the IPC call completes
      await window.waitForTimeout(1000);

      // After allowing, the pointer bar should disappear
      await closeNotificationDrawer(window);
      await expect(pointerBar).not.toBeVisible({ timeout: 5000 });
    });

    test('dismisses approval when Deny is clicked in drawer', async () => {
      const mockRequest = {
        toolUseID: 'test-tool-use-x-' + Date.now(),
        turnId: 'test-turn-x',
        toolName: 'Execute',
        input: { command: 'echo test' },
        reason: 'Command execution',
        timestamp: Date.now(),
      };

      await injectToolApproval(window, mockRequest);

      const pointerBar = window.locator('[data-testid="approval-pointer-bar"]');
      await expect(pointerBar).toBeVisible({ timeout: 5000 });

      await dismissStartupRecoveryDialogIfPresent(window);

      // Open drawer via bell button
      await openNotificationDrawer(window);
      await expandFirstDrawerGroup(window);

      const denyButton = window.locator('[data-testid="drawer-card-dismiss"]').first();
      await expect(denyButton).toBeVisible({ timeout: 3000 });
      await denyButton.click();

      // After denying, the pointer bar should disappear
      await closeNotificationDrawer(window);
      await expect(pointerBar).not.toBeVisible({ timeout: 5000 });
    });
  });

  // ==========================================================================
  // Memory Write Approval (3 tests)
  // ==========================================================================
  test.describe('Memory Write Approval Bar', () => {
    test('shows approval bar when memory:write-approval-request is received', async () => {
      const mockRequest = {
        toolUseId: 'test-memory-123',
        originalTurnId: 'test-orig-turn',
        originalSessionId: '',
        destination: {
          path: 'Chief-of-Staff/notes/test-note.md',
          spaceName: 'Chief-of-Staff',
          memoryTrust: 'cautious',
          isNew: true,
        },
        summary: 'Adding notes from our conversation about project planning',
        contentPreview: '# Project Planning\n\nKey decisions made...',
        timestamp: Date.now(),
      };

      await injectMemoryApproval(window, mockRequest);

      // ApprovalPointerBar should appear
      const pointerBar = window.locator('[data-testid="approval-pointer-bar"]');
      await expect(pointerBar).toBeVisible({ timeout: 5000 });
      await expect(pointerBar).toContainText(/needs your OK|action/i);

      // Clean up so the injected approval doesn't leak into the next test.
      await clearPendingApprovals(window);
    });

    test('approves memory via Allow in drawer', async () => {
      const mockRequest = {
        toolUseId: 'test-memory-save-' + Date.now(),
        originalTurnId: 'test-orig-turn-save',
        originalSessionId: '',
        destination: {
          path: 'work/Acme/meetings/standup.md',
          spaceName: 'Acme',
          isNew: false,
        },
        summary: 'Updated meeting notes',
        timestamp: Date.now(),
      };

      await injectMemoryApproval(window, mockRequest);

      const pointerBar = window.locator('[data-testid="approval-pointer-bar"]');
      await expect(pointerBar).toBeVisible({ timeout: 5000 });

      await dismissStartupRecoveryDialogIfPresent(window);

      // Open drawer and approve
      await window.locator('[data-testid="approval-pointer-review"]').click();
      await expandFirstDrawerGroup(window);

      const card = window.locator('[data-testid="drawer-card-approval"]').first();
      await expect(card).toBeVisible({ timeout: 3000 });
      const approveButton = card.locator('[data-testid="drawer-card-approve"]');
      await approveButton.click();

      // Card should be removed after approval (broadcast fix ensures this works in E2E)
      await expect(card).not.toBeVisible({ timeout: 10000 });

      await closeNotificationDrawer(window);
    });

    test('discards memory via Deny in drawer', async () => {
      const mockRequest = {
        toolUseId: 'test-memory-skip-' + Date.now(),
        originalTurnId: 'test-orig-turn-skip',
        originalSessionId: '',
        destination: {
          path: 'personal/journal/entry.md',
          spaceName: 'Personal',
          isNew: true,
        },
        summary: 'Journal entry draft',
        timestamp: Date.now(),
      };

      await injectMemoryApproval(window, mockRequest);

      const pointerBar = window.locator('[data-testid="approval-pointer-bar"]');
      await expect(pointerBar).toBeVisible({ timeout: 5000 });

      await dismissStartupRecoveryDialogIfPresent(window);

      await openNotificationDrawer(window);
      await expandFirstDrawerGroup(window);

      const card = window.locator('[data-testid="drawer-card-approval"]').first();
      await expect(card).toBeVisible({ timeout: 3000 });
      const denyButton = card.locator('[data-testid="drawer-card-dismiss"]');
      await denyButton.click();

      // Verify dismissal: card should be removed from drawer
      await expect(card).not.toBeVisible({ timeout: 10000 });

      await closeNotificationDrawer(window);
    });
  });

  // ==========================================================================
  // Notification Drawer Approval Interactions (6 tests)
  // Tests the full drawer-based approval flow accessed via the bell button
  // ==========================================================================
  test.describe('Notification Drawer Approvals', () => {
    test('shows notification bell badge when memory approval arrives', async () => {
      const mockRequest = {
        toolUseId: 'inbox-memory-' + Date.now(),
        originalTurnId: 'inbox-orig-turn',
        // Blank session IDs so this surfaces as a session-agnostic background
        // approval (isApprovalSourceSessionAvailable: `if (!sessionId) return true`)
        // under the "Background tasks" group, rather than being filtered out.
        originalSessionId: '',
        turnId: 'background-turn-123',
        sessionId: '',
        destination: {
          path: 'Research/notes/test.md',
          spaceName: 'Research',
          memoryTrust: 'cautious',
          sharing: 'private',
          isNew: true,
        },
        summary: 'Test memory from Inbox',
        content: '# Test Content\n\nThis is the full content for preview.',
        contentPreview: '# Test Content',
        sensitivityReason: 'Contains notes',
        hasSpaceOverride: false,
        privateMode: false,
        timestamp: Date.now(),
      };

      await injectMemoryApproval(window, mockRequest);

      // The notification bell should indicate pending approvals
      const bell = window.locator('[data-testid="notification-bell-button"]');
      await expect(bell).toBeVisible({ timeout: 5000 });
      // Bell gets --has-pending class when approvals exist
      await expect(bell).toHaveClass(/notification-bell-button--has-pending/, { timeout: 5000 });
    });

    test('shows approval card in drawer when group is expanded', async () => {
      const mockRequest = {
        toolUseId: 'inbox-expand-' + Date.now(),
        originalTurnId: 'inbox-expand-turn',
        // Blank session IDs → surfaces under "Background tasks" (see test above).
        originalSessionId: '',
        turnId: 'bg-turn-expand',
        sessionId: '',
        destination: {
          path: 'Work/projects/meeting-notes.md',
          spaceName: 'Work',
          memoryTrust: 'cautious',
          sharing: 'private',
          isNew: true,
        },
        summary: 'Meeting notes from standup',
        content: '# Standup Notes\n\n- Item 1\n- Item 2',
        contentPreview: '# Standup Notes',
        hasSpaceOverride: false,
        privateMode: false,
        timestamp: Date.now(),
      };

      await injectMemoryApproval(window, mockRequest);

      await openNotificationDrawer(window);
      await expandFirstDrawerGroup(window);

      // Should show a DrawerApprovalCard
      const card = window.locator('[data-testid="drawer-card-approval"]').first();
      await expect(card).toBeVisible({ timeout: 3000 });
      // Drawer card shows formatted text like "Rebel wants to save X to Y"
      await expect(card).toContainText(/meeting-notes|Work/i);

      await closeNotificationDrawer(window);
    });

    test('opens preview dialog when the preview affordance is clicked', async () => {
      const mockRequest = {
        toolUseId: 'inbox-preview-' + Date.now(),
        originalTurnId: 'inbox-preview-turn',
        // Blank session IDs → surfaces under "Background tasks" (see test above).
        originalSessionId: '',
        turnId: 'bg-turn-preview',
        sessionId: '',
        destination: {
          path: 'Research/analysis.md',
          spaceName: 'Research',
          memoryTrust: 'cautious',
          sharing: 'private',
          isNew: true,
        },
        summary: 'Competitive analysis summary',
        content: '# Competitive Analysis\n\nThis is the detailed content that will show in preview.',
        contentPreview: '# Competitive Analysis',
        hasSpaceOverride: false,
        privateMode: false,
        timestamp: Date.now(),
      };

      await injectMemoryApproval(window, mockRequest);

      await openNotificationDrawer(window);
      await expandFirstDrawerGroup(window);

      // Click the decision-first preview affordance in the card.
      const previewButton = window.locator('[data-testid="drawer-card-preview-badge"]').first();
      await expect(previewButton).toBeVisible({ timeout: 3000 });
      await previewButton.click();

      // Preview dialog should appear
      const dialog = window.locator('[data-testid="memory-preview-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 3000 });
      await expect(dialog).toContainText('Competitive Analysis');

      // Close preview dialog and wait for overlay to disappear
      await window.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible({ timeout: 3000 });
      await closeNotificationDrawer(window);
    });

    test('approves memory and removes card from drawer', async () => {
      const mockRequest = {
        toolUseId: 'inbox-approve-' + Date.now(),
        originalTurnId: 'inbox-approve-turn',
        // Blank session IDs → surfaces under "Background tasks" (see test above).
        originalSessionId: '',
        turnId: 'bg-turn-approve',
        sessionId: '',
        destination: {
          path: 'Notes/quick-note.md',
          spaceName: 'Notes',
          memoryTrust: 'cautious',
          sharing: 'private',
          isNew: true,
        },
        summary: 'Quick note to save',
        content: '# Quick Note\n\nSome content to approve.',
        contentPreview: '# Quick Note',
        hasSpaceOverride: false,
        privateMode: false,
        timestamp: Date.now(),
      };

      await injectMemoryApproval(window, mockRequest);

      await openNotificationDrawer(window);
      await expandFirstDrawerGroup(window);

      const card = window.locator('[data-testid="drawer-card-approval"]').first();
      await expect(card).toBeVisible({ timeout: 3000 });

      const approveButton = card.locator('[data-testid="drawer-card-approve"]');
      await approveButton.click();

      // Card should be removed after approval (broadcast fix ensures this works in E2E)
      await expect(card).not.toBeVisible({ timeout: 10000 });

      await closeNotificationDrawer(window);
    });

    test('discards memory and removes card from drawer', async () => {
      const mockRequest = {
        toolUseId: 'inbox-discard-' + Date.now(),
        originalTurnId: 'inbox-discard-turn',
        // Blank session IDs → surfaces under "Background tasks" (see test above).
        originalSessionId: '',
        turnId: 'bg-turn-discard',
        sessionId: '',
        destination: {
          path: 'Scratch/unwanted.md',
          spaceName: 'Scratch',
          memoryTrust: 'cautious',
          sharing: 'private',
          isNew: true,
        },
        summary: 'Something I do not want',
        content: '# Unwanted\n\nContent to discard.',
        contentPreview: '# Unwanted',
        hasSpaceOverride: false,
        privateMode: false,
        timestamp: Date.now(),
      };

      await injectMemoryApproval(window, mockRequest);

      await openNotificationDrawer(window);
      await expandFirstDrawerGroup(window);

      const card = window.locator('[data-testid="drawer-card-approval"]').first();
      await expect(card).toBeVisible({ timeout: 3000 });

      const denyButton = card.locator('[data-testid="drawer-card-dismiss"]');
      await denyButton.click();

      // Card should be removed after dismissal
      await expect(card).not.toBeVisible({ timeout: 5000 });

      await closeNotificationDrawer(window);
    });

    test('shows Why explanation on memory approval card', async () => {
      // Inject memory approval with sensitivityReason to trigger whyText via getMemoryWhyText()
      const mockRequest = {
        toolUseId: 'inbox-why-' + Date.now(),
        originalTurnId: 'inbox-why-turn',
        // Blank session IDs → surfaces under "Background tasks" (see test above).
        originalSessionId: '',
        turnId: 'bg-turn-why',
        sessionId: '',
        destination: {
          path: 'Work/secrets/api-keys.md',
          spaceName: 'Work',
          memoryTrust: 'cautious',
          sharing: 'private',
          isNew: true,
        },
        summary: 'Saving API configuration notes',
        content: '# API Keys\n\nSome sensitive content.',
        contentPreview: '# API Keys',
        sensitivityReason: 'anthropic_api_key',
        hasSpaceOverride: false,
        privateMode: false,
        timestamp: Date.now(),
      };

      await injectMemoryApproval(window, mockRequest);

      await openNotificationDrawer(window);
      await expandFirstDrawerGroup(window);

      const card = window.locator('[data-testid="drawer-card-approval"]').first();
      await expect(card).toBeVisible({ timeout: 3000 });

      // Why text is visible by default so approval cards explain themselves.
      const whyText = card.locator('.drawer-card__reason-message');
      await expect(whyText).toBeVisible({ timeout: 2000 });
      await expect(whyText).toContainText('API key');

      await closeNotificationDrawer(window);
    });

    test('shows tool approval card in drawer', async () => {
      const mockToolRequest = {
        toolUseID: 'inbox-tool-' + Date.now(),
        turnId: 'tool-turn-inbox',
        // Blank session ID → surfaces under "Background tasks"
        // (isApprovalSourceSessionAvailable: `if (!sessionId) return true`).
        sessionId: '',
        toolName: 'Execute',
        input: { command: 'echo test' },
        reason: 'Command execution',
        timestamp: Date.now(),
      };

      await injectToolApproval(window, mockToolRequest);

      // Bell should show pending indicator
      const bell = window.locator('[data-testid="notification-bell-button"]');
      await expect(bell).toHaveClass(/notification-bell-button--has-pending/, { timeout: 5000 });

      await openNotificationDrawer(window);
      await expandFirstDrawerGroup(window);

      // Verify tool approval card is visible with expected content
      const card = window.locator('[data-testid="drawer-card-approval"]').first();
      await expect(card).toBeVisible({ timeout: 3000 });
      await expect(card).toContainText(/Command execution/i);

      await closeNotificationDrawer(window);
    });
  });

  // ==========================================================================
  // Redirect: Something Else... (1 test — plan §Stage 3 light E2E)
  // Retention across drawer close/reopen and auto-dismiss timing are covered
  // by the hook unit tests at
  // `src/renderer/features/inbox/hooks/__tests__/useApprovalRedirectShadow.test.ts`.
  // ==========================================================================
  test.describe('Redirect: Something Else...', () => {
    /**
     * Resolve a live, non-deleted persisted session id so the injected approval
     * passes the `canRedirectItem` gate (which requires an existing,
     * non-deleted session in `sessionSummaries`).
     *
     * If no persisted session exists (fresh userData, first test in the suite
     * where no messages have been sent yet), the test skips — verifying the
     * happy-path redirect flow needs a real session and there is no lightweight
     * e2eApi seeder for sessions in this codebase.
     */
    async function resolveActiveSessionId(): Promise<string | null> {
      return window.evaluate(async () => {
        const api = (
          window as unknown as {
            sessionsApi?: { list?: () => Promise<Array<{ id?: string; deletedAt?: number | null }>> };
          }
        ).sessionsApi;
        if (!api?.list) return null;

        const summaries = await api.list();
        const active = summaries.find((summary) => summary?.id && summary.deletedAt == null);
        return active?.id ?? null;
      });
    }

    test('posts instruction from a tool approval and shows sent state', async () => {
      const sessionId = await resolveActiveSessionId();
      test.skip(sessionId === null, 'No persisted non-deleted session available to target for redirect.');
      if (!sessionId) return;

      const now = Date.now();
      const mockToolRequest = {
        toolUseID: 'redirect-tool-' + now,
        turnId: 'redirect-turn-' + now,
        sessionId,
        toolName: 'Execute',
        input: { command: 'echo redirect test' },
        reason: 'Command execution',
        timestamp: now,
      };

      await injectToolApproval(window, mockToolRequest);

      await openNotificationDrawer(window);
      await expandFirstDrawerGroup(window);

      const card = window.locator('[data-testid="drawer-card-approval"]').first();
      await expect(card).toBeVisible({ timeout: 3000 });

      await card.locator('[data-testid="drawer-card-redirect"]').click();

      const redirectInput = card.locator('[data-testid="drawer-card-redirect-input"]');
      const redirectSubmit = card.locator('[data-testid="drawer-card-redirect-submit"]');
      const redirectCancel = card.locator('[data-testid="drawer-card-redirect-cancel"]');

      await expect(redirectInput).toBeVisible({ timeout: 3000 });
      await expect(redirectSubmit).toBeVisible({ timeout: 3000 });
      await expect(redirectCancel).toBeVisible({ timeout: 3000 });

      await redirectInput.fill('do X instead');
      await redirectSubmit.click();

      // `drawer-card-redirect-sent` only appears when BOTH the deny IPC AND
      // the sendMessageToSession IPC succeed (helper would move to error state
      // otherwise). So this assertion verifies the end-to-end redirect
      // pipeline, including that the verbatim instruction was posted to the
      // target session.
      await expect(card.locator('[data-testid="drawer-card-redirect-sent"]')).toBeVisible({
        timeout: 8000,
      });
      await expect(card).not.toContainText('View conversation');

      // Card remains in drawer (plan §2f — stay in drawer, do NOT auto-navigate).
      await expect(card).toBeVisible({ timeout: 3000 });
      await closeNotificationDrawer(window);
    });
  });
});
