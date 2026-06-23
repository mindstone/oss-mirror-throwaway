/**
 * Workspace Tests (Workspace Panel + File Operations)
 *
 * Extracted from:
 * - sequence-b.spec.ts Phase 1: Workspace Panel
 * - sequence-b.spec.ts Phase 13: Workspace Search and File Operations
 *
 * See: docs/plans/partway/260126_e2e_test_architecture_overhaul.md (Stage 2.2)
 *
 * Total: 3 tests
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import {
  appExists,
  cleanupTestWorkspace,
  createIsolatedUserData,
  createTestWorkspace,
  enableGuestMode,
  expandFirstFolderGroup,
  getAppNotFoundMessage,
  type IsolatedUserData,
  launchWithIsolatedUserData,
  navigateToWorkspace,
  PLATFORM,
  resetAppState,
  safeCloseApp,
  setLibraryLens,
  waitForMainAppReady,
  waitForSuperMcpReady,
  writeWorkspaceSettings
} from './test-utils';

// Note: PLATFORM is already imported above and used for individual test skips

test.skip(!appExists(), getAppNotFoundMessage());

// ============================================================================
// Suite State & Lifecycle
// ============================================================================

let app: ElectronApplication;
let window: Page;
let isolated: IsolatedUserData;
let testWorkspace: string | null = null;
let testCount = 0;
let failures: string[] = [];

test.describe('Workspace Tests', () => {
  test.skip(PLATFORM === 'win32', 'Skipped on Windows: app launch timeout in CI');
  test.describe.configure({ timeout: 300_000 }); // 5 minutes

  test.beforeAll(async () => {
    console.log('[E2E] [workspace] ========== SUITE START ==========');
    const startTime = Date.now();

    // Create test workspace
    testWorkspace = await createTestWorkspace();

    // Create isolated userData with workspace configured
    isolated = createIsolatedUserData('workspace');
    writeWorkspaceSettings(isolated.path, testWorkspace);

    app = await launchWithIsolatedUserData(isolated, {
      skipOnboarding: true
    });
    window = await app.firstWindow();

    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);
    await waitForSuperMcpReady(window);

    console.log(`[E2E] [workspace] App launched in ${Date.now() - startTime}ms`);
    console.log(`[E2E] [workspace] userData: ${isolated.path}`);
    console.log(`[E2E] [workspace] testWorkspace: ${testWorkspace}`);
  });

  test.afterAll(async () => {
    console.log('[E2E] [workspace] ========== SUITE END ==========');
    console.log(`[E2E] [workspace] Tests run: ${testCount}`);
    console.log(`[E2E] [workspace] Failures: ${failures.length}`);
    if (failures.length > 0) {
      console.log(`[E2E] [workspace] Failed tests: ${failures.join(', ')}`);
    }
    await safeCloseApp(app, 15000, isolated.path);

    // Cleanup
    if (testWorkspace) await cleanupTestWorkspace(testWorkspace);

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

      const screenshotPath = `test-results/workspace-${testCount}-failure.png`;
      await window.screenshot({ path: screenshotPath }).catch(() => {});

      if (testInfo.error) {
        console.log(`[E2E] [test:end] Error: ${testInfo.error.message}`);
      }
    }
  });

  // ==========================================================================
  // Workspace Panel Tests (from sequence-b Phase 1)
  // ==========================================================================
  test.describe('Workspace Panel', () => {
    test('Workspace drawer navigation and UI elements render correctly', async () => {
      const workspaceTab = window.locator('#flow-tab-library');
      await expect(workspaceTab).toBeVisible({ timeout: 5000 });
      await workspaceTab.click();

      const workspaceDrawer = window.locator('[data-testid="library-drawer"]');
      await expect(workspaceDrawer).toBeVisible({ timeout: 5000 });

      const workspaceSurface = window.locator('[data-testid="library-surface"]');
      await expect(workspaceSurface).toBeVisible({ timeout: 5000 });

      const lensBar = window.locator('[data-testid="library-lens-bar"]');
      await expect(lensBar).toBeVisible({ timeout: 5000 });

      const searchInput = window.locator('[data-testid="library-lens-search-input"]');
      await expect(searchInput).toBeVisible({ timeout: 5000 });

      const createButton = window.locator('[data-testid="library-create-menu-button"]');
      await expect(createButton).toBeVisible({ timeout: 5000 });
    });

    test.skip(PLATFORM === 'win32', 'Windows: workspace tree not loading in E2E context');
    test('Scope switching, file tree, and tree items work correctly', async () => {
      const workspaceDrawer = window.locator('[data-testid="library-drawer"]');
      if (!await workspaceDrawer.isVisible({ timeout: 1000 }).catch(() => false)) {
        await navigateToWorkspace(window);
      }

      await setLibraryLens(window, { filter: 'everything', view: 'folders' });

      await expandFirstFolderGroup(window);

      const tree = window.locator('[data-testid="library-tree"]');
      await expect(tree).toBeVisible({ timeout: 10000 });

      const treeItems = window.locator('[data-testid="library-tree-item"]');
      const itemCount = await treeItems.count();
      expect(itemCount).toBeGreaterThan(0);

      const firstItem = window.locator('[data-testid="library-tree-item"]').first();
      await expect(firstItem).toBeVisible({ timeout: 5000 });

      const relpath = await firstItem.getAttribute('data-relpath');
      expect(relpath).toBeTruthy();
      expect(relpath).not.toContain('mindstone-test-');
    });
  });

  // ==========================================================================
  // Workspace Search and File Operations (from sequence-b Phase 13)
  // ==========================================================================
  test.describe('Workspace Search and File Operations', () => {
    test.skip(PLATFORM === 'win32', 'Windows: workspace settings not propagating in E2E context');

    test('Search and file operations work correctly', async () => {
      const workspaceDrawer = window.locator('[data-testid="library-drawer"]');
      if (!await workspaceDrawer.isVisible({ timeout: 1000 }).catch(() => false)) {
        await navigateToWorkspace(window);
      }

      await setLibraryLens(window, { filter: 'skills', view: 'cards' });

      const searchInput = window.locator('[data-testid="library-lens-search-input"]');
      await expect(searchInput).toBeVisible({ timeout: 5000 });
      await searchInput.fill('SKILL');

      await setLibraryLens(window, { filter: 'everything', view: 'folders' });
      await expandFirstFolderGroup(window);

      await searchInput.fill('');
      await searchInput.fill('editable-file');

      const resultItem = window.locator('[data-testid="library-tree-item"]').filter({ hasText: 'editable-file.txt' }).first();
      await expect(resultItem).toBeVisible({ timeout: 10000 });
      await resultItem.click();

      const editorPanel = window.locator('[data-testid="library-editor-panel"]');
      await expect(editorPanel).toBeVisible({ timeout: 5000 });

      // Dismiss any Sonner toast notifications that might block editor interactions
      const closeToastButton = window.locator('[data-close-button]');
      if (await closeToastButton.first().isVisible({ timeout: 1000 }).catch(() => false)) {
        await closeToastButton.first().click();
        await closeToastButton.first().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
      }

      // Editor defaults to edit mode — textarea should be immediately available
      const textarea = window.locator('[data-testid="library-editor-textarea"]');
      await expect(textarea).toBeVisible({ timeout: 10000 });

      const content = await textarea.inputValue();
      expect(content).toContain('Original content for editing test');

      const originalContent = await textarea.inputValue();
      const newContent = originalContent + '\n\n--- E2E Test Edit ---\nThis line was added by E2E test.';
      await textarea.fill(newContent);

      const updatedContent = await textarea.inputValue();
      expect(updatedContent).toContain('E2E Test Edit');

      // Editor auto-saves after changes — trigger explicit save with keyboard shortcut
      // and wait for the save status in the editor footer to confirm completion
      const saveKey = PLATFORM === 'darwin' ? 'Meta+s' : 'Control+s';
      await window.keyboard.press(saveKey);
      // Wait for save to complete (status changes from "Unsaved changes" → "Saved just now")
      await expect(editorPanel.locator('text=/Saved /')).toBeVisible({ timeout: 10000 });

      const closeButton = window.locator('[data-testid="library-editor-close"]');
      await expect(closeButton).toBeVisible({ timeout: 5000 });
      await closeButton.click();
      await expect(editorPanel).not.toBeVisible({ timeout: 5000 });

      await searchInput.fill('');
      await searchInput.fill('editable-file');
      await expect(resultItem).toBeVisible({ timeout: 10000 });
      await resultItem.click();
      await expect(editorPanel).toBeVisible({ timeout: 5000 });

      // Editor defaults to edit mode — textarea should be immediately available
      await expect(textarea).toBeVisible({ timeout: 10000 });

      const persistedContent = await textarea.inputValue();
      expect(persistedContent).toContain('E2E Test Edit');

      // Also verify on disk
      if (testWorkspace) {
        const diskContent = fs.readFileSync(`${testWorkspace}/editable-file.txt`, 'utf-8');
        expect(diskContent).toContain('E2E Test Edit');
      }
    });
  });
});
