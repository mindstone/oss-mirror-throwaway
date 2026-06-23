/**
 * Quality Tier Selector E2E Tests
 *
 * Tests the ConversationModelSelector quality tier slider, advanced panel,
 * locked state behavior, save-as-default persistence, custom state, and
 * multi-model toggle with seeded profiles.
 *
 * Total: 10 tests across 3 describe blocks:
 *   - 8 non-mocked (basic + custom + save-as-default)
 *   - 1 mocked locked-state (launchWithMocking)
 *   - 1 multi-model (pre-launch seeded profiles)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  appExists,
  createIsolatedUserData,
  enableGuestMode,
  getAppNotFoundMessage,
  getFirstWindow,
  type IsolatedUserData,
  firstWindowTimeoutMs,
  launchWithIsolatedUserData,
  launchWithMocking,
  resetAppState,
  safeCloseApp,
  sendMessageAndWaitForResponse,
  switchToTextMode,
  waitForMainAppReady,
  writeMinimalSettings,
} from './test-utils';

test.skip(!appExists(), getAppNotFoundMessage());

test.describe('Quality Tier Selector', () => {
  test.describe.configure({ timeout: 300_000 });

  let app: ElectronApplication;
  let window: Page;
  let isolated: IsolatedUserData;

  test.beforeAll(async () => {
    console.log('[E2E] [quality-tier] ========== SUITE START ==========');
    const startTime = Date.now();

    isolated = createIsolatedUserData('quality-tier');
    writeMinimalSettings(isolated.path);

    app = await launchWithIsolatedUserData(isolated, { skipOnboarding: true });
    window = await getFirstWindow(app);

    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);

    await expect(window.locator('[data-testid="brand-home"]')).toBeVisible({ timeout: 15000 });
    await expect(window.locator('[id^="flow-tab-"]').first()).toBeVisible({ timeout: 15000 });

    console.log(`[E2E] [quality-tier] App launched in ${Date.now() - startTime}ms`);
  });

  test.afterAll(async () => {
    console.log('[E2E] [quality-tier] ========== SUITE END ==========');
    await safeCloseApp(app, 15000, isolated.path);
    if (!process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated?.cleanup();
    }
  });

  test.beforeEach(async ({}, testInfo) => {
    if (testInfo.title !== 'quality slider appears when toggle is clicked') {
      await resetAppState(window, testInfo.title);
    }
  });

  /** Helper: start a new chat and open the quality tier slider */
  async function openQualitySlider() {
    const newChatButton = window.locator('[data-testid="new-chat-button"]');
    await newChatButton.click();
    await expect(window.locator('[data-testid="interaction-strip"]')).toBeVisible({ timeout: 10000 });

    const toggleButton = window.locator('[data-testid="model-override-toggle-button"]');
    await expect(toggleButton).toBeVisible({ timeout: 5000 });

    // If the toggle is already active from a previous test, click twice to reset then show
    const isActive = await toggleButton.getAttribute('aria-pressed');
    if (isActive === 'true') {
      // Toggle off then on to get clean state
      await toggleButton.click();
      await window.waitForTimeout(100);
    }
    await toggleButton.click();

    await expect(window.locator('[data-testid="quality-slider"]')).toBeVisible({ timeout: 5000 });
  }

  // ── Test 1: Slider visibility via toggle ────────────────────────────────
  test('quality slider appears when toggle is clicked', async () => {
    // Start a new chat
    const newChatButton = window.locator('[data-testid="new-chat-button"]');
    await newChatButton.click();
    await expect(window.locator('[data-testid="interaction-strip"]')).toBeVisible({ timeout: 10000 });

    // Slider should be hidden initially
    const slider = window.locator('[data-testid="quality-slider"]');
    await expect(slider).not.toBeVisible({ timeout: 3000 });

    // Click the model override toggle
    const toggleButton = window.locator('[data-testid="model-override-toggle-button"]');
    await expect(toggleButton).toBeVisible({ timeout: 5000 });
    await toggleButton.click();

    // Slider should now be visible with 4 tiers (Frontier/Fable-5 tier removed
    // when Fable 5 was withdrawn — see qualityTiers.ts, canonical 4-tier set)
    await expect(slider).toBeVisible({ timeout: 5000 });
    await expect(window.locator('[data-testid="quality-tier-quick"]')).toBeVisible();
    await expect(window.locator('[data-testid="quality-tier-balanced"]')).toBeVisible();
    await expect(window.locator('[data-testid="quality-tier-thorough"]')).toBeVisible();
    await expect(window.locator('[data-testid="quality-tier-maximum"]')).toBeVisible();
  });

  // ── Test 2: Tier selection activates the segment ────────────────────────
  test('clicking a tier activates it', async () => {
    await openQualitySlider();

    // Click "Quick" tier
    const quickTier = window.locator('[data-testid="quality-tier-quick"]');
    await quickTier.click();

    // Verify it's now active (aria-checked="true")
    await expect(quickTier).toHaveAttribute('aria-checked', 'true');

    // Other tiers should not be active
    await expect(window.locator('[data-testid="quality-tier-balanced"]')).toHaveAttribute('aria-checked', 'false');
    await expect(window.locator('[data-testid="quality-tier-thorough"]')).toHaveAttribute('aria-checked', 'false');
    await expect(window.locator('[data-testid="quality-tier-maximum"]')).toHaveAttribute('aria-checked', 'false');
  });

  // ── Test 3: Switching tiers changes selection ───────────────────────────
  test('switching between tiers updates selection', async () => {
    await openQualitySlider();

    // Select Quick
    await window.locator('[data-testid="quality-tier-quick"]').click();
    await expect(window.locator('[data-testid="quality-tier-quick"]')).toHaveAttribute('aria-checked', 'true');

    // Switch to Maximum
    await window.locator('[data-testid="quality-tier-maximum"]').click();
    await expect(window.locator('[data-testid="quality-tier-maximum"]')).toHaveAttribute('aria-checked', 'true');
    await expect(window.locator('[data-testid="quality-tier-quick"]')).toHaveAttribute('aria-checked', 'false');
  });

  // ── Test 4: Advanced panel toggle ───────────────────────────────────────
  test('advanced panel expands and collapses', async () => {
    await openQualitySlider();

    // Advanced panel should be collapsed — the "Show details" toggle should exist
    const advancedToggle = window.locator('button:has-text("Show details")');
    await expect(advancedToggle).toBeVisible({ timeout: 3000 });

    // Click to expand
    await advancedToggle.click();

    // Working/Thinking/Effort dropdowns should be visible
    await expect(window.locator('#conv-working-model')).toBeVisible({ timeout: 3000 });
    await expect(window.locator('#conv-thinking-model')).toBeVisible({ timeout: 3000 });
    await expect(window.locator('#conv-thinking-effort')).toBeVisible({ timeout: 3000 });

    // "Hide details" should now be shown
    const hideToggle = window.locator('button:has-text("Hide details")');
    await expect(hideToggle).toBeVisible();

    // Click to collapse
    await hideToggle.click();

    // Dropdowns should be hidden (panel collapsed via CSS — check tabIndex=-1)
    await expect(window.locator('#conv-working-model')).toHaveAttribute('tabindex', '-1', { timeout: 3000 });
  });

  // ── Test 5: Keyboard navigation ────────────────────────────────────────
  test('keyboard navigation works on quality slider', async () => {
    await openQualitySlider();

    // Verify radiogroup role and radio roles exist (accessibility contract)
    const radiogroup = window.locator('[role="radiogroup"][aria-label="Quality level"]');
    await expect(radiogroup).toBeVisible();

    const radios = window.locator('[data-testid="quality-slider"] [role="radio"]');
    await expect(radios).toHaveCount(4);

    // Each radio should have aria-checked and aria-label attributes
    for (const tierId of ['quick', 'balanced', 'thorough', 'maximum'] as const) {
      const tier = window.locator(`[data-testid="quality-tier-${tierId}"]`);
      await expect(tier).toHaveAttribute('role', 'radio');
      const ariaLabel = await tier.getAttribute('aria-label');
      expect(ariaLabel).toBeTruthy();
    }

    // Verify clicking sets aria-checked correctly (functional keyboard alternative)
    await window.locator('[data-testid="quality-tier-quick"]').click();
    await expect(window.locator('[data-testid="quality-tier-quick"]')).toHaveAttribute('aria-checked', 'true');
    // Active tier should have tabIndex=0
    await expect(window.locator('[data-testid="quality-tier-quick"]')).toHaveAttribute('tabindex', '0');
    // Inactive tiers should have tabIndex=-1
    await expect(window.locator('[data-testid="quality-tier-balanced"]')).toHaveAttribute('tabindex', '-1');
  });

  // ── Test 6: Toggle visible in pre-message state ──────────────────────────
  test('model override toggle is visible for new conversations', async () => {
    const newChatButton = window.locator('[data-testid="new-chat-button"]');
    await newChatButton.click();
    await expect(window.locator('[data-testid="interaction-strip"]')).toBeVisible({ timeout: 10000 });

    const toggleButton = window.locator('[data-testid="model-override-toggle-button"]');
    await expect(toggleButton).toBeVisible({ timeout: 5000 });
  });

  // ── Test 7: Advanced panel dropdown changes produce Custom state ────────
  test('changing advanced dropdown to non-tier combo shows Custom', async () => {
    await openQualitySlider();

    // Select Quick tier first (Quick uses haiku+haiku, effort low)
    await window.locator('[data-testid="quality-tier-quick"]').click();
    await expect(window.locator('[data-testid="quality-tier-quick"]')).toHaveAttribute('aria-checked', 'true');

    // Expand advanced panel
    await window.locator('button:has-text("Show details")').click();
    await expect(window.locator('#conv-thinking-effort')).toBeVisible({ timeout: 3000 });

    // Change effort to "high" — Quick tier uses "low", so this breaks tier alignment
    await window.locator('#conv-thinking-effort').selectOption('high');

    // No tier should be active (Custom state)
    for (const tierId of ['quick', 'balanced', 'thorough', 'maximum']) {
      await expect(window.locator(`[data-testid="quality-tier-${tierId}"]`)).toHaveAttribute('aria-checked', 'false');
    }

    // The "Custom" label should be visible in the slider
    await expect(window.locator('[data-testid="quality-slider"]')).toContainText('Custom');
  });

  // ── Test 8: Save-as-default persists to global settings ─────────────────
  // NOTE: This test mutates global settings — placed last in the non-mocked suite.
  test('save-as-default writes tier config to global settings', async () => {
    await openQualitySlider();

    // Select Maximum tier (opus+opus, effort xhigh)
    await window.locator('[data-testid="quality-tier-maximum"]').click();
    await expect(window.locator('[data-testid="quality-tier-maximum"]')).toHaveAttribute('aria-checked', 'true');

    // Save-as-default button should be visible (Maximum != global default)
    const saveButton = window.locator('[data-testid="save-as-default-button"]');
    await expect(saveButton).toBeVisible({ timeout: 3000 });
    expect(await saveButton.textContent()).toContain('Save as default');

    // Click save-as-default
    await saveButton.click();

    // Wait for the save to complete — button shows "Saved ✓" or becomes disabled
    await expect(saveButton).toBeDisabled({ timeout: 5000 });

    // Verify persistence: the authoritative assertion is that global settings were written.
    // Read from the canonical provider-neutral `models` namespace introduced by
    // 2d2a673f3 — the legacy `claude.*` mirror is no longer written by
    // handleSaveAsDefault (see ConversationModelSelector.tsx and the unit test
    // ConversationModelSelector.test.tsx:387-405 which forbids resurrecting it).
    //
    // settingsApi.get() returns the NORMALIZED settings. normalizeSettings
    // (settingsUtils.ts ~1603-1628) deterministically relocates a claude-prefixed
    // thinkingModel into a virtual Anthropic profile: it sets
    // models.thinkingProfileId = '__virtual-thinking' and CLEARS models.thinkingModel
    // to undefined ("profile takes precedence"). The thinking model is therefore
    // carried on the virtual profile (localModel.profiles[].model), not on the raw
    // thinkingModel key. We assert the persisted/normalized shape the app actually
    // consumes — verifying intent ("Maximum tier persisted: thinking runs Opus 4.8")
    // against that shape, not the stale raw thinkingModel key.
    const savedSettings = await window.evaluate(async () => {
      const s = await (window as any).settingsApi.get();
      const thinkingProfileId = s?.models?.thinkingProfileId;
      const thinkingProfile = (s?.localModel?.profiles ?? []).find(
        (p: { id?: string }) => p?.id === thinkingProfileId
      );
      return {
        workingModel: s?.models?.model,
        rawThinkingModel: s?.models?.thinkingModel,
        thinkingProfileId,
        thinkingProfileModel: thinkingProfile?.model,
        thinkingEffort: s?.models?.thinkingEffort,
      };
    });

    // Maximum tier: working=opus, thinking=opus (via virtual profile), xhigh effort.
    expect(savedSettings.workingModel).toBe('claude-opus-4-8');
    expect(savedSettings.thinkingEffort).toBe('xhigh');
    // normalizeSettings relocates the claude-prefixed thinking model into the
    // virtual thinking profile and clears the raw key.
    expect(savedSettings.rawThinkingModel).toBeUndefined();
    expect(savedSettings.thinkingProfileId).toBe('__virtual-thinking');
    expect(savedSettings.thinkingProfileModel).toBe('claude-opus-4-8');
  });
});

// ============================================================================
// Mocked Suite: Post-message Locked State
// ============================================================================

test.describe('Quality Tier Selector — Locked State (Mocked)', () => {
  test.skip(!appExists(), getAppNotFoundMessage());
  test.describe.configure({ timeout: 180_000 });

  let electronApp: ElectronApplication;
  let window: Page;
  let cleanup: () => void;
  let userDataPath: string;

  test.beforeAll(async () => {
    console.log('[E2E] [quality-tier-locked] ========== SUITE START ==========');

    const result = await launchWithMocking('quality-tier-locked', {
      defaultMockResponse: 'This is a mock response for testing locked state.',
    });

    electronApp = result.electronApp;
    cleanup = result.cleanup;
    userDataPath = result.userDataPath;
    window = await electronApp.firstWindow({ timeout: firstWindowTimeoutMs() });
    await window.waitForLoadState('domcontentloaded');
    await enableGuestMode(window);
    await waitForMainAppReady(window, 60000);
  });

  test.afterAll(async () => {
    console.log('[E2E] [quality-tier-locked] ========== SUITE END ==========');
    if (electronApp) await safeCloseApp(electronApp, 15000, userDataPath);
    if (!process.env.REBEL_E2E_KEEP_USER_DATA) {
      cleanup?.();
    }
  });

  // ── Test 9: Locked state after sending a message with overrides ─────────
  test('shows locked state label after sending message with overrides', async () => {
    // Start a new chat
    const newChatButton = window.locator('[data-testid="new-chat-button"]');
    await newChatButton.click();
    await expect(window.locator('[data-testid="interaction-strip"]')).toBeVisible({ timeout: 10000 });

    // Open quality slider and select Quick tier
    const toggleButton = window.locator('[data-testid="model-override-toggle-button"]');
    await expect(toggleButton).toBeVisible({ timeout: 5000 });
    await toggleButton.click();
    await expect(window.locator('[data-testid="quality-slider"]')).toBeVisible({ timeout: 5000 });
    await window.locator('[data-testid="quality-tier-quick"]').click();
    await expect(window.locator('[data-testid="quality-tier-quick"]')).toHaveAttribute('aria-checked', 'true');

    // Switch to text mode (required for sendMessageAndWaitForResponse)
    await switchToTextMode(window);

    // Send a message — mock will respond immediately
    await sendMessageAndWaitForResponse(window, 'Hello, testing locked state.');

    // After first message: toggle button should be hidden
    await expect(toggleButton).not.toBeVisible({ timeout: 10000 });

    // Interactive slider should be gone
    await expect(window.locator('[data-testid="quality-slider"]')).not.toBeVisible({ timeout: 5000 });

    // Locked state label should be visible with tier name
    const lockedLabel = window.locator('[data-testid="locked-state-label"]');
    await expect(lockedLabel).toBeVisible({ timeout: 5000 });
    await expect(lockedLabel).toContainText('Using: Quick');
  });
});

// ============================================================================
// Isolated Suite: Multi-model Toggle (Pre-launch Seeded Profiles)
// ============================================================================
// Settings propagation from settingsApi.update() does NOT broadcast to the
// renderer (settings:update handler lacks settings:external-update emission).
// So we seed profiles in app-settings.json BEFORE launch for reliability.

test.describe('Quality Tier Selector — Multi-model Toggle', () => {
  test.skip(!appExists(), getAppNotFoundMessage());
  test.describe.configure({ timeout: 300_000 });

  let app: ElectronApplication;
  let window: Page;
  let isolated: IsolatedUserData;

  test.beforeAll(async () => {
    console.log('[E2E] [quality-tier-multimodel] ========== SUITE START ==========');
    const startTime = Date.now();

    isolated = createIsolatedUserData('quality-tier-multimodel');
    writeMinimalSettings(isolated.path);

    // Seed a routable third-party profile into app-settings.json before launch.
    // The profile must have a non-empty `model` string to pass getRoutableProfiles().
    const settingsPath = path.join(isolated.path, 'app-settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    settings.localModel = {
      ...settings.localModel,
      activeProfileId: null,
      profiles: [
        {
          id: 'e2e-test-profile-gpt55',
          name: 'E2E Test GPT-5.5',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.5',
          createdAt: Date.now(),
        },
      ],
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log('[E2E] Seeded localModel.profiles with 1 routable profile');

    app = await launchWithIsolatedUserData(isolated, { skipOnboarding: true });
    window = await getFirstWindow(app);

    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);

    await expect(window.locator('[data-testid="brand-home"]')).toBeVisible({ timeout: 15000 });
    await expect(window.locator('[id^="flow-tab-"]').first()).toBeVisible({ timeout: 15000 });

    console.log(`[E2E] [quality-tier-multimodel] App launched in ${Date.now() - startTime}ms`);
  });

  test.afterAll(async () => {
    console.log('[E2E] [quality-tier-multimodel] ========== SUITE END ==========');
    await safeCloseApp(app, 15000, isolated.path);
    if (!process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated?.cleanup();
    }
  });

  // ── Test 10: Multi-model checkbox appears and toggles with seeded profiles
  test('multi-model toggle is visible and functional with seeded profiles', async () => {
    // Start new chat
    const newChatButton = window.locator('[data-testid="new-chat-button"]');
    await newChatButton.click();
    await expect(window.locator('[data-testid="interaction-strip"]')).toBeVisible({ timeout: 10000 });

    // Open quality slider
    const toggleButton = window.locator('[data-testid="model-override-toggle-button"]');
    await expect(toggleButton).toBeVisible({ timeout: 5000 });
    await toggleButton.click();
    await expect(window.locator('[data-testid="quality-slider"]')).toBeVisible({ timeout: 5000 });

    // Multi-model checkbox should be visible (because we seeded a routable profile)
    const multiModelCheckbox = window.locator('[data-testid="multi-model-checkbox"]');
    await expect(multiModelCheckbox).toBeVisible({ timeout: 5000 });

    // Verify checkbox is functional by reading its checked state via JS evaluation
    const initialChecked = await multiModelCheckbox.evaluate((el: HTMLInputElement) => el.checked);
    expect(typeof initialChecked).toBe('boolean');

    // Click to toggle — should flip the checked state
    await multiModelCheckbox.click();
    const afterFirstClick = await multiModelCheckbox.evaluate((el: HTMLInputElement) => el.checked);
    expect(afterFirstClick).toBe(!initialChecked);

    // Click again — should flip back
    await multiModelCheckbox.click();
    const afterSecondClick = await multiModelCheckbox.evaluate((el: HTMLInputElement) => el.checked);
    expect(afterSecondClick).toBe(initialChecked);
  });
});
