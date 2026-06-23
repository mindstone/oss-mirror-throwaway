import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
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
  getFirstWindow,
  type IsolatedUserData,
  launchWithIsolatedUserData,
  safeCloseApp,
  waitForMainAppReady,
  waitForSuperMcpReady
} from './test-utils';

// Test credentials from environment variables
// Set these in your environment or .env.test file (gitignored)
const TEST_CLAUDE_API_KEY = process.env.TEST_CLAUDE_API_KEY;
const TEST_OPENAI_API_KEY = process.env.TEST_OPENAI_API_KEY;
const TEST_ELEVENLABS_API_KEY = process.env.TEST_ELEVENLABS_API_KEY;

// Use OpenAI if available, otherwise ElevenLabs
const TEST_VOICE_PROVIDER = TEST_OPENAI_API_KEY ? 'openai-whisper' : 'elevenlabs-scribe';
const TEST_VOICE_API_KEY = TEST_OPENAI_API_KEY || TEST_ELEVENLABS_API_KEY;

// Test workspace directory
const TEST_WORKSPACE_DIR = process.env.TEST_WORKSPACE_DIR || path.join(os.tmpdir(), 'mindstone-rebel-test');

// Space test folder (must be in user directory, not temp - wizard rejects temp folders)
// Uses project-local tmp/ folder (already gitignored), cleaned up in afterAll
// Unique per test file to avoid cleanup conflicts with parallel workers
const TEST_SPACE_BASE = path.resolve(__dirname, '..', '..', 'tmp', `e2e-test-spaces-onboarding-${Date.now()}-${Math.random().toString(36).slice(2)}`);

test.skip(!appExists(), getAppNotFoundMessage());

/**
 * Onboarding Flow E2E Tests
 * 
 * These tests verify the 7-step onboarding wizard:
 * 1. Welcome - Introduction screen with preflight system check ("Let's check" -> "Continue")
 * 2. Workspace - Save location selection
 * 3. Shared Drives - Google Drive integration (optional, skipped)
 * 4. API Keys - Claude and voice provider configuration
 * 5. Klavis Setup - MCP configuration (optional, skipped)
 * 6. Tool Auth - OAuth for email/calendar/chat (optional, skipped)
 * 7. Permissions - Workspace access and microphone
 * 
 * Required environment variables:
 * - TEST_CLAUDE_API_KEY: Claude API key for testing
 * - TEST_OPENAI_API_KEY or TEST_ELEVENLABS_API_KEY: Voice provider key
 * - TEST_WORKSPACE_DIR (optional): Test workspace directory (defaults to temp dir)
 * 
 * Example:
 *   TEST_CLAUDE_API_KEY=<your-anthropic-key> TEST_OPENAI_API_KEY=<your-openai-key> npm run test:e2e
 */

const hasRequiredKeys = TEST_CLAUDE_API_KEY && TEST_VOICE_API_KEY;

/**
 * Skip the login screen if it appears.
 * The app shows a login screen (AuthGate) before the onboarding wizard.
 * Uses enableGuestMode() to bypass auth and proceed to onboarding.
 */
async function skipLoginScreenIfPresent(window: Page): Promise<void> {
  // Enable guest mode to bypass auth gate
  await enableGuestMode(window);
  
  // Wait for onboarding wizard to appear after entering guest mode
  const onboardingWelcome = window.locator('[data-testid="onboarding-welcome-content"]');
  await expect(onboardingWelcome).toBeVisible({ timeout: 10000 });
}

// Windows CI: preflight blocker fails - needs separate investigation
// The onboarding is already tested on macOS, so we skip on Windows until
// the preflight checker works reliably in Windows CI environments.
// See: docs/plans/finished/260125_e2e_ci_failures_fix.md
//
// TODO: Investigate Windows preflight blocker root cause:
// - Likely candidates: Git Bash detection, Node bundle paths, or PowerShell execution policy
// - Check systemHealthService.ts runPreflightCheck() for which check returns a blocker
// - Once fixed, remove this skip and verify onboarding works on Windows CI
test.describe('Onboarding Flow', { annotation: { type: 'skip', description: 'Windows CI preflight blocker' } }, () => {
  test.skip(process.platform === 'win32', 'Skipped on Windows: preflight blocker fails in CI');

  let app: ElectronApplication;
  let window: Page;
  let isolated: IsolatedUserData;
  let testFailed = false;

  test.beforeAll(async () => {
    // Create test workspace directory if it doesn't exist
    if (!fs.existsSync(TEST_WORKSPACE_DIR)) {
      fs.mkdirSync(TEST_WORKSPACE_DIR, { recursive: true });
    }

    // Create isolated userData - starts with no settings, forcing onboarding
    isolated = createIsolatedUserData('onboarding');
    
    app = await launchWithIsolatedUserData(isolated, {
      additionalArgs: [],
      skipOnboarding: false
    });
    window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    
    // Skip the login screen if it appears (enters guest mode)
    await skipLoginScreenIfPresent(window);
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== 'passed') {
      testFailed = true;
    }
  });

  test.afterAll(async () => {
    if (app) {
      await safeCloseApp(app, 15000, isolated.path);
    }
    
    // Keep on failure for debugging, clean on success
    if (!testFailed && !process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated?.cleanup();
      // Clean up space test folders created during Step 3
      if (fs.existsSync(TEST_SPACE_BASE)) {
        fs.rmSync(TEST_SPACE_BASE, { recursive: true });
      }
    } else {
      console.log(`[DEBUG] Keeping test userData at: ${isolated?.path}`);
      console.log(`[DEBUG] Keeping test spaces at: ${TEST_SPACE_BASE}`);
    }
  });

  test('Step 1: Welcome - shows introduction screen', async () => {
    // Wait for the welcome dialog to appear (already on onboarding after skipping login)
    // The welcome screen shows "Welcome to Rebel" heading and a "Let's check" button
    const welcomeHeading = window.locator('h1:has-text("Welcome to Rebel")');
    await expect(welcomeHeading).toBeVisible({ timeout: 15000 });
    
    // Find and click the "Let's check" button to start preflight checks
    // Use data-testid selector for reliability - the button text changes during preflight
    const letsCheckButton = window.locator('[data-testid="onboarding-get-started-button"]');
    await expect(letsCheckButton).toBeVisible({ timeout: 5000 });
    await expect(letsCheckButton).toBeEnabled();
    // Use force:true because WelcomeStep has complex CSS animations that can
    // interfere with Playwright's hit-testing. noWaitAfter prevents navigation wait.
    await letsCheckButton.click({ noWaitAfter: true, force: true });
    
    // Wait for preflight checks to complete - the button changes to "Continue" when clear
    // or "Continue anyway" if there are non-blocking issues.
    // Preflight runs multiple checks (disk space, git, node bundle) and may start Super-MCP,
    // which can take 60+ seconds on Windows CI due to slower I/O and firewall warmup.
    // Use data-testid selector (same button, different text state) for reliability
    const continueButton = window.locator('[data-testid="onboarding-get-started-button"]');
    await expect(continueButton).toBeVisible({ timeout: 90000 });
    await expect(continueButton).toBeEnabled();
    // Verify button text changed from "Let's check" to indicate preflight completed
    // Accept "Continue" (clear) or "Continue anyway" (non-blocking issues)
    const buttonText = await continueButton.textContent();
    expect(buttonText).toMatch(/Continue/);
    
    // Click the button to advance to the next step
    // Use force:true because WelcomeStep has complex CSS animations (aurora, particles,
    // shooting stars) that can cause Playwright's hit-testing to falsely detect overlays.
    // The button is confirmed visible/enabled above, so force is safe here.
    // Add explicit timeout for slow CI environments
    await continueButton.click({ noWaitAfter: true, force: true, timeout: 30000 });
    
    // Wait for navigation to the workspace step - use explicit wait for heading
    // instead of fixed timeout for more reliable cross-platform behavior
    const workspaceHeading = window.locator('h2:has-text("Where does your work live?")');
    await expect(workspaceHeading).toBeVisible({ timeout: 15000 });
    console.log('[E2E] Step 1: Successfully navigated to workspace step');
  });

  test('Step 2: Workspace - enter save location', async () => {
    // Verify we're on workspace step - heading should already be visible from Step 1
    const workspaceHeading = window.locator('h2:has-text("Where does your work live?")');
    await expect(workspaceHeading).toBeVisible({ timeout: 10000 });
    
    // Find the workspace input field and enter the test directory
    const workspaceInput = window.locator('#onboarding-core-dir');
    await expect(workspaceInput).toBeVisible({ timeout: 5000 });
    await workspaceInput.fill(TEST_WORKSPACE_DIR);
    
    // Accept the EULA checkbox (required to proceed)
    // Use click() instead of check() - the custom CSS checkbox with appearance:none
    // confuses Playwright's check() method, but click() triggers React's onChange correctly
    const eulaCheckbox = window.locator('input[type="checkbox"]');
    await eulaCheckbox.click({ force: true });
    // Verify checkbox was checked (catches click failures)
    await expect(eulaCheckbox).toBeChecked({ timeout: 5000 });
    
    // Wait for workspace validation to complete
    // The Continue button is always enabled, but goNext() only advances when canProceed=true.
    // canProceed requires workspaceValidation.checking=false, so we must wait for validation
    // to finish. On Windows CI, filesystem validation takes longer than on macOS.
    const checkingText = window.locator('text=Checking folder...');
    // Wait for validation to start (may not appear on very fast systems)
    await checkingText.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    // Wait for validation to complete (text disappears)
    await expect(checkingText).toHaveCount(0, { timeout: 30000 });
    
    // Now click Continue - validation is complete so goNext() will advance
    const continueButton = window.locator('[data-testid="onboarding-continue-button"]');
    await continueButton.click({ noWaitAfter: true });
    
    // Verify navigation to the next step (Spaces & Shared Folders)
    const driveHeading = window.locator('h2:has-text("Spaces & Shared Folders")');
    await expect(driveHeading).toBeVisible({ timeout: 15000 });
  });

  // Un-skipped (April 2026): enableGuestMode race fixed. This test involves a dialog-in-dialog
  // flow (AddSpaceWizard inside OnboardingWizard) which can be timing-sensitive in CI.
  // Gate: requires previous steps to have completed (Step 2 navigated to this step).
  test('Step 3: Shared Drives - add a space via wizard', async () => {
    // Step 2 already verified we're on this step, but confirm the heading is still visible
    const driveHeading = window.locator('h2:has-text("Spaces & Shared Folders")');
    await expect(driveHeading).toBeVisible({ timeout: 10000 });
    
    // Create and verify space folder is accessible from main process
    // This is critical for Windows CI where filesystem sync can be delayed
    const spaceFolder = await createVerifiedTestSpaceFolder(app, TEST_SPACE_BASE);
    
    await app.evaluate(async ({ dialog }, testPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [testPath]
      });
    }, spaceFolder);
    
    // Click "Add space" to open the Add Space Wizard
    const addSpaceButton = window.locator('button:has-text("Add space")');
    await expect(addSpaceButton).toBeVisible({ timeout: 5000 });
    await addSpaceButton.click({ noWaitAfter: true });
    
    // Wait for the AddSpaceWizard dialog (nested inside onboarding wizard)
    // Target the dialog containing "Choose Folder" button (unique to AddSpaceWizard)
    const chooseFolderButton = window.locator('button:has-text("Choose Folder")');
    await expect(chooseFolderButton).toBeVisible({ timeout: 5000 });
    await chooseFolderButton.click({ noWaitAfter: true });
    
    // Wait for path analysis to complete (Next button becomes enabled)
    const nextButton = window.locator('button:has-text("Next")');
    await expect(nextButton).toBeEnabled({ timeout: 15000 });
    await nextButton.click({ noWaitAfter: true });
    
    // Now on the About step - wait for primary action button
    // Button text is "Create Space" for new spaces, "Add Space" for existing frontmatter
    // Use .last() to get the button in the innermost (AddSpaceWizard) dialog
    const primaryButton = window.locator('button:has-text("Create Space"), button:has-text("Add Space")').last();
    await expect(primaryButton).toBeVisible({ timeout: 5000 });
    await expect(primaryButton).toBeEnabled({ timeout: 5000 });
    await primaryButton.click({ noWaitAfter: true });
    
    // Wait for AddSpaceWizard to fully close
    // 1. Wait for primary button to be hidden (wizard closed)
    await expect(primaryButton).toBeHidden({ timeout: 10000 });
    // 2. Wait for AddSpaceWizard modal to be gone (rendered via portal to body, not inside step)
    // Look for dialogs containing wizard-specific text to avoid matching the onboarding wizard itself
    const addSpaceDialog = window.locator('[role="dialog"][aria-modal="true"]').filter({ 
      hasText: /Create Space|Add Space|Choose Folder/ 
    });
    await expect(addSpaceDialog).toHaveCount(0, { timeout: 5000 });
    
    // Verify space appears in connected list (proves creation succeeded)
    // The connected spaces show with a checkmark
    const connectedSpaceBadge = window.locator('text=/✓/').last();
    await expect(connectedSpaceBadge).toBeVisible({ timeout: 5000 });
    
    // Now we should be able to click Continue
    const continueButton = window.locator('[data-testid="onboarding-continue-button"]');
    await continueButton.click({ noWaitAfter: true });
    // Wait for next step to load
    await expect(window.locator('[data-testid="onboarding-step-toolAuth"]')).toBeVisible({ timeout: 15000 });
  });

  // Un-skipped (April 2026): enableGuestMode race fixed. API key validation can be slow on CI.
  test('Step 4: API Keys - enter credentials', async () => {
    test.skip(!hasRequiredKeys, 'Skipping API keys step - TEST_CLAUDE_API_KEY and voice key not set');
    // Validation can be slow on CI (OpenAI deep validation; cold start/network variance).
    test.setTimeout(180_000);
    
    // Wait for API step - look for the heading
    const apiHeading = window.locator('h2:has-text("Connect your AI")');
    await expect(apiHeading).toBeVisible({ timeout: 10000 });
    
    // Enter Claude API key
    const claudeInput = window.locator('#onboarding-claude-key');
    await expect(claudeInput).toBeVisible({ timeout: 5000 });
    await claudeInput.fill(TEST_CLAUDE_API_KEY!);
    
    // Select voice provider if needed
    if (TEST_VOICE_PROVIDER === 'elevenlabs-scribe') {
      const voiceSelect = window.locator('#onboarding-voice-provider');
      await voiceSelect.selectOption('elevenlabs-scribe');
    }
    
    // Enter voice API key
    const voiceKeyInput = TEST_VOICE_PROVIDER === 'openai-whisper'
      ? window.locator('#onboarding-openai-key')
      : window.locator('#onboarding-elevenlabs-key');
    await expect(voiceKeyInput).toBeVisible({ timeout: 5000 });
    await expect(voiceKeyInput).toBeEnabled({ timeout: 5000 });
    await voiceKeyInput.scrollIntoViewIfNeeded();
    await voiceKeyInput.fill(TEST_VOICE_API_KEY!);

    // Continue is disabled while keys are validating; wait deterministically.
    const continueButton = window.locator('[data-testid="onboarding-continue-button"]');
    await expect(continueButton).toBeEnabled({ timeout: 90000 });
    await continueButton.click({ noWaitAfter: true });

    await expect(window.locator('[data-testid="onboarding-step-toolAuth"]')).toBeVisible({ timeout: 15000 });
  });

  test('Step 5: Skip remaining steps via escape hatch', async () => {
    test.skip(!hasRequiredKeys, 'Skipping - requires previous steps');
    
    // Use escape hatch to skip remaining optional steps (Tool Auth)
    await window.keyboard.press(getEscapeHatchShortcut());
    
    const dialogTitle = window.locator('text=Skip setup?');
    await expect(dialogTitle).toBeVisible({ timeout: 5000 });
    
    const skipButton = window.locator('button:has-text("Skip anyway")');
    await skipButton.click({ noWaitAfter: true });
    
    // Wait for main app to be ready
    await waitForMainAppReady(window);
  });

  // SKIPPED: Depends on Steps 3-5 completing successfully with API keys.
  // Blocker: Onboarding completion transition not reliably detected by waitForMainAppReady() —
  // app reports onboardingWelcome=true after Step 5's escape hatch fires.
  // Potential fix: Add explicit wait for onboarding dismissal signal or readiness phase change.
  // Un-skip candidate when Steps 3-5 are verified passing in CI with keys.
  test.skip('Onboarding completes - chat interface visible', async () => {
    test.skip(!hasRequiredKeys, 'Skipping - requires previous steps');
    
    // After onboarding, wait for main app shell to be fully ready
    // This follows the proven pattern from electron-smoke.spec.ts
    await waitForMainAppReady(window);
    
    // Verify chat interface is available - look for interaction strip or brand home
    const chatInterface = window.locator('[data-testid="interaction-strip"], [data-testid="brand-home"]');
    await expect(chatInterface.first()).toBeVisible({ timeout: 15000 });

    // Wait for Super-MCP to be ready before proceeding with subsequent tests.
    // Super-MCP startup is deferred during first-run onboarding. Without this wait,
    // a StartupRecoveryDialog may appear after 30s, blocking test interactions.
    await waitForSuperMcpReady(window);
  });

  // SKIPPED: Requires real LLM call (150s timeout) + depends on Step 6 completing.
  // Even when Steps 3-5 pass, this test times out waiting for multi-subprocess agent response.
  // Un-skip candidate after Step 6 is verified working and LLM response time is acceptable in CI.
  test.skip('Conversation - send message with subprocesses', async () => {
    test.skip(!hasRequiredKeys, 'Skipping - requires previous steps');
    
    // Dismiss StartupRecoveryDialog if it appeared due to timing
    await dismissStartupRecoveryDialogIfPresent(window);
    
    // Ensure main app shell is ready before looking for input
    await waitForMainAppReady(window);
    
    // Wait for the interaction strip to be visible first (contains the command input)
    const interactionStrip = window.locator('[data-testid="interaction-strip"]');
    await expect(interactionStrip).toBeVisible({ timeout: 15000 });
    
    // After onboarding, we're already in the chat interface
    // Wait for text input to appear (use aria-label for command input textarea)
    const textInput = window.locator('[data-testid="composer-input"]');
    await expect(textInput).toBeVisible({ timeout: 10000 });
    
    // Type the message asking for 2 subprocesses with simpler questions
    const message = `Please spin up 2 subprocesses:
1. In the first subprocess, ask: "Explain what kanban is"
2. In the second subprocess, ask: "What are the top 5 most populous cities in France?"`;
    
    await textInput.fill(message);
    
    // Submit the message by clicking the send button
    const sendButton = window.locator('[data-testid="composer-send-button"], [data-testid="send-now-button"]');
    await sendButton.click();

    // Wait for the assistant's response to appear
    // The response is in an article.agent-turn-message.assistant element
    const assistantMessage = window.locator('article.agent-turn-message.assistant');
    await expect(assistantMessage).toBeVisible({ timeout: 150000 });
    
    // Wait for the specific completion text within the assistant's message
    const completionMessage = assistantMessage.locator('text=/Both subprocesses have completed/i');
    await expect(completionMessage).toBeVisible({ timeout: 150000 });
    
    // Verify kanban content in the response (heading)
    const kanbanHeading = assistantMessage.locator('h2:has-text("Kanban")');
    await expect(kanbanHeading).toBeVisible({ timeout: 5000 });
    
    // Verify France cities content (heading)  
    const franceHeading = assistantMessage.locator('h2:has-text("French Cities"), h2:has-text("France")');
    await expect(franceHeading).toBeVisible({ timeout: 5000 });
  });

  // SKIPPED: Cascade from Step 6 — depends on onboarding completion transition.
  // Same blocker: waitForMainAppReady() doesn't reliably detect post-onboarding state.
  // Note: Tab navigation is already covered by tests/e2e/surfaces.spec.ts, so this
  // is only valuable as an onboarding-to-main-shell transition verification.
  test.skip('Navigation - all surface tabs load correctly', async () => {
    test.skip(!hasRequiredKeys, 'Skipping - requires previous steps');
    
    // Dismiss StartupRecoveryDialog if it appeared due to timing
    await dismissStartupRecoveryDialogIfPresent(window);
    
    // Ensure main app shell is ready before interacting with tabs
    await waitForMainAppReady(window);
    
    // Wait for the navigation tabs to be rendered (any tab visible means tabs are ready)
    const anyNavTab = window.locator('[id^="flow-tab-"]').first();
    await expect(anyNavTab).toBeVisible({ timeout: 15000 });
    
    // Test each navigation tab loads its corresponding surface
    
    // 1. The Spark tab (id remains "usecases" for backward compatibility)
    const useCasesTab = window.locator('#flow-tab-usecases');
    await expect(useCasesTab).toBeVisible({ timeout: 10000 });
    await useCasesTab.click();
    // Verify The Spark panel content loads (either with cards or empty state)
    const useCasesContent = window.locator('[data-testid="usecases-panel"], [data-testid="usecases-panel-empty"]').first();
    await expect(useCasesContent).toBeVisible({ timeout: 5000 });
    
    // 2. Inbox tab (id remains "tasks")
    const inboxTab = window.locator('#flow-tab-tasks');
    await expect(inboxTab).toBeVisible({ timeout: 5000 });
    await inboxTab.click();
    // Verify Inbox panel content loads (InboxPanel has stable aria labels)
    await expect(window.locator('section[aria-label="Pending items"]')).toBeVisible({ timeout: 5000 });
    
    // 3. Automations tab
    const automationsTab = window.locator('#flow-tab-automations');
    await expect(automationsTab).toBeVisible({ timeout: 5000 });
    await automationsTab.click();
    // Verify Automations panel content loads
    const automationsContent = window.locator('text=/Automations|No automations|Create automation/i').first();
    await expect(automationsContent).toBeVisible({ timeout: 5000 });
    
    // 4. Library tab (workspace panel)
    const workspaceTab = window.locator('#flow-tab-library');
    await expect(workspaceTab).toBeVisible({ timeout: 5000 });
    await workspaceTab.click();
    // Verify Library panel content loads
    const workspaceContent = window.locator('text=/Library|Browse|Files|folders/i').first();
    await expect(workspaceContent).toBeVisible({ timeout: 5000 });
    
    // 5. Settings tab
    const settingsTab = window.locator('#flow-tab-settings');
    await expect(settingsTab).toBeVisible({ timeout: 5000 });
    await settingsTab.click();
    // Verify Settings panel content loads
    const settingsContent = window.locator('text=/Settings|Claude|Voice|MCP/i').first();
    await expect(settingsContent).toBeVisible({ timeout: 5000 });
    
    // 6. Return to Sessions tab
    const sessionsTab = window.locator('#flow-tab-sessions');
    await expect(sessionsTab).toBeVisible({ timeout: 5000 });
    await sessionsTab.click();
    // Wait for sessions panel to load
    await expect(window.locator('[data-testid="session-sidebar"]')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Onboarding Flow (without keys)', () => {
  test.skip(!!hasRequiredKeys, 'Skipping no-keys tests when keys are available');
  
  let app: ElectronApplication;
  let window: Page;
  let isolated: IsolatedUserData;
  let testFailed = false;

  test.beforeAll(async () => {
    // Create isolated userData - starts with no settings, forcing onboarding
    isolated = createIsolatedUserData('onboarding-no-keys');

    app = await launchWithIsolatedUserData(isolated, {
      additionalArgs: [],
      skipOnboarding: false
    });
    window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    
    // Skip the login screen if it appears (enters guest mode)
    await skipLoginScreenIfPresent(window);
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== 'passed') {
      testFailed = true;
    }
  });

  test.afterAll(async () => {
    if (app) {
      await safeCloseApp(app, 15000, isolated.path);
    }
    
    // Keep on failure for debugging, clean on success
    if (!testFailed && !process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated?.cleanup();
    } else {
      console.log(`[DEBUG] Keeping test userData at: ${isolated?.path}`);
    }
  });

  test('Welcome screen appears and escape hatch works', async () => {
    // Welcome step should be visible (already on onboarding after skipping login)
    const welcomeHeading = window.locator('h1:has-text("Welcome to Rebel")');
    await expect(welcomeHeading).toBeVisible({ timeout: 15000 });
    
    // Verify the "Let's check" button is present (preflight check flow)
    const letsCheckButton = window.locator('button:has-text("Let\'s check")');
    await expect(letsCheckButton).toBeVisible({ timeout: 5000 });
    
    // Use escape hatch to skip entire onboarding
    await window.keyboard.press(getEscapeHatchShortcut());
    
    // Confirmation dialog should appear
    const dialogTitle = window.locator('text=Skip setup?');
    await expect(dialogTitle).toBeVisible({ timeout: 5000 });
    
    // Click "Skip anyway" to confirm
    // Use noWaitAfter since closing wizard doesn't involve page navigation
    await window.locator('button:has-text("Skip anyway")').click({ noWaitAfter: true });
    
    // Wait for wizard to close and main UI to load
    // Should land on main UI - look for chat interface
    const chatInterface = window.locator('[data-testid="interaction-strip"], [data-testid="brand-home"]');
    await expect(chatInterface.first()).toBeVisible({ timeout: 20000 });
  });
});

// =============================================================================
// Post-onboarding Home activation card (seeded state — no wizard, no LLM)
// =============================================================================
// Guards the May 2026 behavioural contract (docs/plans/260505_home_onboarding_activation.md):
// the coach intro no longer auto-launches after the setup wizard — Home's Today
// section MUST show the activation card whose CTA is the only discoverable path
// to the onboarding coach. A silent regression here strands users with "setup
// complete but no coach" — exactly the bug class diagnosed in
// docs/plans/260611_coach-chat-missing-after-onboarding/PLAN.md. The card's
// gating predicate is hasCoachCompletionSignal()
// (src/renderer/features/onboarding/utils/coachCompletionState.ts), consumed by
// the onboardingActivationIncomplete memo in App.tsx.
//
// Deterministic by construction: state is seeded BEFORE launch (the standard
// skipOnboarding seed is exactly "wizard complete, coach intro NOT complete":
// onboardingCompleted true, onboardingFirstCompletedAt set, onboardingChecklist
// { step: 1 }, and crucially NO onboardingCompletedAt / completedSteps[0] /
// onboardingDay). No wizard interaction, no completion transition, no
// LLM/network wait. Runs with or without API keys.
//
// NOTE: settingsApi.update() does NOT broadcast back to the renderer (see
// quality-tier-selector.spec.ts), so each mid-test settings change is followed
// by window.reload() + waitForMainAppReady() so the fresh renderer re-fetches.
test.describe('Post-onboarding Home activation card (seeded)', () => {
  // Same skip + rationale as surfaces.spec.ts (closest seeded-homepage analogue).
  test.skip(process.platform === 'win32', 'Skipped on Windows: app launch timeout in CI');
  // Covers the beforeAll app launch + two mid-test reload→ready cycles on slow CI.
  test.describe.configure({ timeout: 180_000 });

  let app: ElectronApplication;
  let window: Page;
  let isolated: IsolatedUserData;
  let testFailed = false;

  test.beforeAll(async () => {
    isolated = createIsolatedUserData('onboarding-activation-card');

    // Default skipOnboarding seed (writeMinimalSettings) = the target state:
    // wizard complete, coach intro not complete. See header comment.
    app = await launchWithIsolatedUserData(isolated);
    window = await getFirstWindow(app);
    await window.waitForLoadState('domcontentloaded');
    await enableGuestMode(window);
    await waitForMainAppReady(window);
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== 'passed') {
      testFailed = true;
    }
  });

  test.afterAll(async () => {
    if (app) {
      await safeCloseApp(app, 15000, isolated.path);
    }

    // Keep on failure for debugging, clean on success
    if (!testFailed && !process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated?.cleanup();
    } else {
      console.log(`[DEBUG] Keeping test userData at: ${isolated?.path}`);
    }
  });

  /** Navigate to the Home surface and wait for the homepage panel. */
  async function openHomepage(page: Page): Promise<void> {
    await dismissStartupRecoveryDialogIfPresent(page);
    const homeTab = page.locator('#flow-tab-home');
    await expect(homeTab).toBeVisible({ timeout: 10000 });
    await homeTab.click();
    await expect(page.locator('[data-testid="homepage-panel"]')).toBeVisible({ timeout: 10000 });
  }

  /**
   * Update settings through the real settings IPC, then reload so the fresh
   * renderer re-fetches them (update does not broadcast — see header comment).
   */
  async function updateSettingsAndReload(page: Page, patch: Record<string, unknown>): Promise<void> {
    await page.evaluate(async (settingsPatch) => {
      type SettingsApi = {
        get: () => Promise<Record<string, unknown>>;
        update: (settings: Record<string, unknown>) => Promise<unknown>;
      };
      const w = globalThis as typeof globalThis & { settingsApi: SettingsApi };
      const current = await w.settingsApi.get();
      await w.settingsApi.update({ ...current, ...settingsPatch });
    }, patch);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await waitForMainAppReady(page);
  }

  const activationCta = () => window.locator('[data-testid="onboarding-activation-cta"]');

  test('activation card shows when setup is complete but the coach intro is not', async () => {
    await test.step('fresh wizard-complete state shows the card with its CTA', async () => {
      await openHomepage(window);

      // The CTA is the load-bearing assertion: it is the user's only path to
      // the onboarding coach since the May 2026 redesign.
      await expect(activationCta()).toBeVisible({ timeout: 10000 });
      await expect(activationCta()).toHaveText('Start');

      // The CTA lives inside exactly one Today card, with the activation title
      // per the TodaySection state matrix ("Tell Rebel what matters" when no
      // connectors are added / "Start here" otherwise — numbering may prefix it
      // when the connector nudge co-shows).
      const card = window
        .locator('[data-testid="today-card"]')
        .filter({ has: window.locator('[data-testid="onboarding-activation-cta"]') });
      await expect(card).toHaveCount(1);
      await expect(card).toContainText(
        /Tell Rebel what matters|Start here|Continue your intro with Rebel/
      );
      await expect(card).toContainText(
        'Chat with Rebel for a few minutes so it can prioritise what matters.'
      );
    });

    await test.step('card persists for the post-relaunch state (non-coach checklist progress, no coach signals)', async () => {
      // Seeds the EXPECTED post-relaunch state (PLAN.md Stage 1): tutorial-
      // checklist progress survives, every coach completion signal clear — the
      // card must still show. Note this seeds the state directly; it does not
      // execute the Settings→relaunch flow itself. The Stage 2 unit tests on
      // clearCoachCompletionState are what guard reset-field drift (the
      // pre-fix bug: a stale completedSteps[0] silently suppressed the card).
      await updateSettingsAndReload(window, {
        onboardingChecklist: { step: 3, completedSteps: { 1: true, 2: true }, isExpanded: false },
      });
      await openHomepage(window);
      await expect(activationCta()).toBeVisible({ timeout: 10000 });
    });

    await test.step('negative control: a coach completion signal suppresses the card', async () => {
      // Proves the assertion is not vacuous: the card tracks the completion
      // predicate in both directions.
      await updateSettingsAndReload(window, { onboardingCompletedAt: Date.now() });
      await openHomepage(window);
      await expect(activationCta()).toHaveCount(0);
    });
  });
});
