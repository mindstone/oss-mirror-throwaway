import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  appExists,
  createIsolatedUserData,
  enableGuestMode,
  getAppNotFoundMessage,
  type IsolatedUserData,
  launchWithIsolatedUserData,
  PLATFORM,
  waitForMainAppReady,
  waitForSuperMcpReady
} from './test-utils';

test.skip(!appExists(), getAppNotFoundMessage());

// Output directory - writes directly to docs/screenshots/ with timestamped filenames
const SCREENSHOTS_DIR = path.join(process.cwd(), 'docs', 'screenshots');

// Generate timestamp prefix for this capture run (yyMMdd_HHmm format)
const now = new Date();
const TIMESTAMP = `${now.getFullYear().toString().slice(-2)}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;

// API keys from environment (loaded via `source .env.test`)
const TEST_CLAUDE_API_KEY = process.env.TEST_CLAUDE_API_KEY;
const TEST_OPENAI_API_KEY = process.env.TEST_OPENAI_API_KEY;
const TEST_ELEVENLABS_API_KEY = process.env.TEST_ELEVENLABS_API_KEY;
const TEST_VOICE_API_KEY = TEST_OPENAI_API_KEY || TEST_ELEVENLABS_API_KEY;
const TEST_VOICE_PROVIDER = TEST_OPENAI_API_KEY ? 'openai-whisper' : 'elevenlabs-scribe';
const TEST_WORKSPACE_DIR = process.env.TEST_WORKSPACE_DIR || path.join(os.tmpdir(), 'rebel-screenshots-workspace');

const hasApiKeys = !!(TEST_CLAUDE_API_KEY && TEST_VOICE_API_KEY);

/**
 * Write settings with API keys for authenticated screenshots.
 * Allows capturing conversation flows with real agent responses.
 */
function writeAuthenticatedSettings(isolatedPath: string): void {
  const settingsPath = path.join(isolatedPath, 'app-settings.json');
  const settings = {
    onboardingCompleted: true,
    onboardingFirstCompletedAt: Date.now(),
    onboardingChecklist: { step: 1 },
    claudeApiKey: TEST_CLAUDE_API_KEY,
    voiceApiKey: TEST_VOICE_API_KEY,
    voiceProvider: TEST_VOICE_PROVIDER,
    workspacePath: TEST_WORKSPACE_DIR,
    // Disable features that might interfere with screenshots
    enhanceWorkspace: false,
    toolSafetyLevel: 'permissive'
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`[Screenshots] Wrote authenticated settings to: ${settingsPath}`);
}

/**
 * Write minimal settings for guest mode (no API keys needed).
 */
function writeGuestSettings(isolatedPath: string): void {
  const settingsPath = path.join(isolatedPath, 'app-settings.json');
  const settings = {
    onboardingCompleted: true,
    onboardingFirstCompletedAt: Date.now(),
    onboardingChecklist: { step: 1 }
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`[Screenshots] Wrote guest settings to: ${settingsPath}`);
}

/**
 * Screenshot Capture Utility
 * 
 * NOT a test suite - this is a utility for capturing product screenshots.
 * Run with: npm run capture:screenshots
 * 
 * Screenshots are saved to: docs/screenshots/ with timestamped filenames
 * Format: yyMMdd_HHmm_description.png (e.g., 260106_1423_landing-spark.png)
 * 
 * For authenticated features (conversations with agent responses):
 *   source .env.test && npm run capture:screenshots
 * 
 * The .env.test file should contain:
 *   TEST_CLAUDE_API_KEY=<your-anthropic-key>
 *   TEST_OPENAI_API_KEY=<your-openai-key>  (or TEST_ELEVENLABS_API_KEY)
 * 
 * See: docs/project/SCREENSHOTS.md for full documentation
 */
test.describe('UI Screenshots (Guest Mode)', () => {
  test.skip(PLATFORM === 'win32', 'Skipped on Windows: app launch timeout in CI');

  let app: ElectronApplication;
  let window: Page;
  let isolated: IsolatedUserData;

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

    isolated = createIsolatedUserData('screenshots-guest');
    writeGuestSettings(isolated.path);
    console.log(`[Screenshots] Launching app with userData at ${isolated.path}`);

    app = await launchWithIsolatedUserData(isolated);
    window = await app.firstWindow();
    
    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);
    console.log('[Screenshots] App ready for screenshots');
  });

  test.afterAll(async () => {
    if (app) {
      try {
        await Promise.race([
          app.close(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
        ]);
      } catch {
        console.log('[Screenshots] App close timed out');
      }
    }
    isolated?.cleanup();
    console.log(`[Screenshots] Screenshots saved to: ${SCREENSHOTS_DIR}`);
  });

  async function screenshot(name: string): Promise<void> {
    // Use timestamped filename: yyMMdd_HHmm_description.png
    const filename = `${TIMESTAMP}_${name}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    await window.screenshot({ path: filepath, fullPage: false });
    console.log(`[Screenshot] Saved: ${filename}`);
  }

  test('Capture main UI screenshots', async () => {
    // Landing page with The Spark
    await screenshot('landing-spark');

    // Click new chat to get conversation view
    await window.locator('[data-testid="new-chat-button"]').click();
    await window.waitForTimeout(500);
    await screenshot('conversation-view');

    // The Spark panel (use cases)
    const sparkTab = window.locator('#flow-tab-usecases');
    if (await sparkTab.isVisible()) {
      await sparkTab.click();
      await window.waitForTimeout(500);
      await screenshot('the-spark-usecases');
    }

    // Automations tab
    const automationsTab = window.locator('#flow-tab-automations');
    if (await automationsTab.isVisible()) {
      await automationsTab.click();
      await window.waitForTimeout(500);
      await screenshot('automations-panel');
    }

    // Inbox tab
    const inboxTab = window.locator('#flow-tab-inbox');
    if (await inboxTab.isVisible()) {
      await inboxTab.click();
      await window.waitForTimeout(500);
      await screenshot('inbox-panel');
    }

    // Library panel
    const libraryTab = window.locator('#flow-tab-library');
    if (await libraryTab.isVisible()) {
      await libraryTab.click();
      await window.waitForTimeout(500);
      await screenshot('library-panel');
    }
  });

  test('Capture Settings screenshots', async () => {
    const settingsButton = window.locator('[data-testid="settings-button"]');
    await expect(settingsButton).toBeVisible({ timeout: 5000 });
    await settingsButton.click();
    await window.waitForTimeout(500);

    const settingsDialog = window.locator('[role="dialog"]').filter({ has: window.locator('text=Settings') });
    await expect(settingsDialog).toBeVisible({ timeout: 5000 });
    await screenshot('settings-general');

    const tabs = [
      { name: 'Connectors', screenshot: 'settings-connectors' },
      { name: 'Usage', screenshot: 'settings-usage' },
      { name: 'Safety', screenshot: 'settings-safety' },
      { name: 'Voice', screenshot: 'settings-voice' },
    ];

    for (const tab of tabs) {
      const tabButton = window.locator(`button:has-text("${tab.name}")`).first();
      if (await tabButton.isVisible().catch(() => false)) {
        await tabButton.click();
        await window.waitForTimeout(300);
        await screenshot(tab.screenshot);
      }
    }

    await window.keyboard.press('Escape');
    await window.waitForTimeout(300);
  });

  test('Capture sidebar and history screenshots', async () => {
    const historyButton = window.locator('[data-testid="landing-history-button"], [data-testid="conversations-button"]');
    if (await historyButton.first().isVisible().catch(() => false)) {
      await historyButton.first().click();
      await window.waitForTimeout(500);
      await screenshot('sidebar-history');
    }

    await window.keyboard.press('Escape');
    await window.waitForTimeout(300);
  });

  test('Capture Skills browser screenshots', async () => {
    const libraryTab = window.locator('#flow-tab-library');
    if (await libraryTab.isVisible()) {
      await libraryTab.click();
      await window.waitForTimeout(500);
    }

    const skillsScope = window.locator('[data-testid="library-filter-chip-skills"]');
    if (await skillsScope.isVisible().catch(() => false)) {
      await skillsScope.click();
      await window.waitForTimeout(500);
      await screenshot('skills-browser');
    }

    const memoryScope = window.locator('[data-testid="library-filter-chip-memory"]');
    if (await memoryScope.isVisible().catch(() => false)) {
      await memoryScope.click();
      await window.waitForTimeout(500);
      await screenshot('memory-tab');
    }
  });

  test('Capture What\'s New dialog', async () => {
    const versionBadge = window.locator('[data-testid="version-badge"], .version-indicator').first();
    if (await versionBadge.isVisible().catch(() => false)) {
      await versionBadge.click();
      await window.waitForTimeout(500);
      
      const whatsNewDialog = window.locator('[role="dialog"]').filter({ has: window.locator('text=What\'s New') });
      if (await whatsNewDialog.isVisible().catch(() => false)) {
        await screenshot('whats-new');
        await window.keyboard.press('Escape');
      }
    }
  });

  test('Capture Scratchpad dialog', async () => {
    const isMac = process.platform === 'darwin';
    const modifier = isMac ? 'Meta' : 'Control';
    
    await window.keyboard.press(`${modifier}+Shift+KeyN`);
    await window.waitForTimeout(500);
    
    const scratchpadDialog = window.locator('[role="dialog"]').filter({ hasText: 'Scratchpad' });
    if (await scratchpadDialog.isVisible().catch(() => false)) {
      await screenshot('scratchpad');
      await window.keyboard.press('Escape');
    }
  });
});

/**
 * Authenticated Screenshots - Conversation with Agent Response
 * 
 * Requires API keys in environment:
 *   source .env.test && npm run capture:screenshots
 * 
 * Skipped if TEST_CLAUDE_API_KEY is not set.
 */
test.describe('Conversation Screenshots (Authenticated)', () => {
  test.skip(PLATFORM === 'win32', 'Skipped on Windows: app launch timeout in CI');
  test.skip(!hasApiKeys, 'Skipping - TEST_CLAUDE_API_KEY and voice key not set. Run: source .env.test && npm run capture:screenshots');

  let app: ElectronApplication;
  let window: Page;
  let isolated: IsolatedUserData;

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    
    // Create workspace directory if needed
    fs.mkdirSync(TEST_WORKSPACE_DIR, { recursive: true });

    isolated = createIsolatedUserData('screenshots-auth');
    writeAuthenticatedSettings(isolated.path);
    console.log(`[Screenshots] Launching authenticated app with userData at ${isolated.path}`);

    app = await launchWithIsolatedUserData(isolated);
    window = await app.firstWindow();
    
    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window); // Still use guest mode for auth bypass, but with API keys in settings
    await waitForMainAppReady(window);
    
    // Wait for Super-MCP to be ready for agent turns
    await waitForSuperMcpReady(window, 60000);
    console.log('[Screenshots] Authenticated app ready');
  });

  test.afterAll(async () => {
    if (app) {
      try {
        await Promise.race([
          app.close(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
        ]);
      } catch {
        console.log('[Screenshots] App close timed out');
      }
    }
    isolated?.cleanup();
    console.log(`[Screenshots] Authenticated screenshots saved to: ${SCREENSHOTS_DIR}`);
  });

  async function screenshot(name: string): Promise<void> {
    const filename = `${TIMESTAMP}_${name}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    await window.screenshot({ path: filepath, fullPage: false });
    console.log(`[Screenshot] Saved: ${filename}`);
  }

  test('Capture conversation with agent response', async () => {
    // Start new conversation
    await window.locator('[data-testid="new-chat-button"]').click();
    await window.waitForTimeout(500);

    // Type a simple message
    const composer = window.locator('[data-testid="composer-input"], textarea[placeholder*="message"]').first();
    await expect(composer).toBeVisible({ timeout: 5000 });
    await composer.fill('What is 2 + 2? Reply in one sentence.');

    // Send message
    const sendButton = window.locator('[data-testid="send-button"]').first();
    await sendButton.click();

    // Wait for agent response (look for assistant message bubble)
    // This waits up to 60 seconds for the agent to respond
    await window.waitForSelector('[data-testid="assistant-message"], .message-bubble.assistant', { 
      timeout: 60000,
      state: 'visible'
    });
    
    // Wait a bit for any animations to settle
    await window.waitForTimeout(1000);

    // Capture the conversation with both user message and agent response
    await screenshot('conversation-with-response');
    console.log('[Screenshots] Captured conversation with agent response');
  });

  test('Capture conversation with thinking indicator', async () => {
    // Start fresh conversation
    await window.locator('[data-testid="new-chat-button"]').click();
    await window.waitForTimeout(500);

    // Type a message that will take a moment to process
    const composer = window.locator('[data-testid="composer-input"], textarea[placeholder*="message"]').first();
    await expect(composer).toBeVisible({ timeout: 5000 });
    await composer.fill('Write a haiku about programming.');

    // Send and quickly capture the thinking state
    const sendButton = window.locator('[data-testid="send-button"]').first();
    await sendButton.click();

    // Brief pause to catch thinking indicator
    await window.waitForTimeout(500);
    await screenshot('conversation-thinking');

    // Wait for response to complete before next test
    await window.waitForSelector('[data-testid="assistant-message"], .message-bubble.assistant', { 
      timeout: 60000,
      state: 'visible'
    });
  });
});
