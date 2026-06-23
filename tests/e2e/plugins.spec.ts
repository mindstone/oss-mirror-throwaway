/**
 * Plugin Creation E2E Tests
 *
 * Tests the full plugin creation pipeline via the bridge HTTP endpoint
 * (same path the rebel_plugins_create MCP tool uses):
 *   bridge endpoint → pluginService → renderer compile → plugin registry → UI
 *
 * Total: 5 tests
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
  safeCloseApp,
  waitForMainAppReady,
} from './test-utils';
import { type BridgeState, callBridge as callBridgeHelper, waitForBridgeState } from './helpers/plugin-bridge';

test.skip(!appExists(), getAppNotFoundMessage());

const PLUGIN_ID = 'e2e-test-hello';
const PLUGIN_NAME = 'E2E Hello';
const PLUGIN_SOURCE = `
import React, { useState } from 'react';
import { Button, Card, Stack } from '@rebel/plugin-ui';

export default function E2ETestPlugin() {
  const [count, setCount] = useState(0);
  return (
    <Stack>
      <Card>
        <div data-testid="e2e-plugin-content">Hello from E2E test plugin</div>
        <div data-testid="e2e-plugin-counter">Count: {count}</div>
        <Button onClick={() => setCount(c => c + 1)}>Increment</Button>
      </Card>
    </Stack>
  );
}
`.trim();

let app: ElectronApplication;
let window: Page;
let isolated: IsolatedUserData;
let bridge: BridgeState;

async function callBridge(endpoint: string, options: { method?: string; body?: unknown } = {}) {
  return callBridgeHelper(bridge, endpoint, options);
}

// Plugin surfaces no longer render as inline `flow-tab-plugin:<id>` tabs. Since the
// FlowPanelsShell restructure (commit 09002ca8a) they always live behind a single
// "Plugins" dropdown: the trigger is `button.flow-chip--plugins` (aria-haspopup=menu)
// and each plugin is a `role=menuitem` button whose visible text is the plugin's
// manifest name (App.tsx registers `label: p.manifest.name`). The dropdown only mounts
// (role=menu) while open, so we must click the trigger before locating menu items.

function pluginsDropdownTrigger(w: Page) {
  return w.locator('button.flow-chip--plugins');
}

function pluginMenuItem(w: Page, name: string) {
  return w.locator('[role="menuitem"]', { hasText: name });
}

async function openPluginsDropdown(w: Page): Promise<void> {
  const trigger = pluginsDropdownTrigger(w);
  await expect(trigger).toBeVisible({ timeout: 10000 });
  // Idempotent open: the trigger is wired with floating-ui useClick, which TOGGLES the
  // menu open<->closed. Tests run serially against one shared app and a prior test may
  // leave the menu open (e.g. :142 only asserts the menuitem is visible, never closes).
  // A blind re-click would toggle the open menu SHUT and the wait below would time out.
  // aria-expanded (FlowPanelsShell.tsx ~:652, bound to overflowMenuOpen) is the robust
  // idempotency key — it also tolerates useHover having already opened the menu.
  const menu = w.locator('.flow-overflow-menu[role="menu"]');
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.click();
  }
  await expect(menu).toBeVisible({ timeout: 10000 });
}

async function openPluginByName(w: Page, name: string): Promise<void> {
  await openPluginsDropdown(w);
  const item = pluginMenuItem(w, name);
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
}

test.describe('Plugin Creation Pipeline', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    console.log('[E2E] [plugins] ========== SUITE START ==========');
    const startTime = Date.now();

    isolated = createIsolatedUserData('plugins');

    app = await launchWithIsolatedUserData(isolated);
    window = await getFirstWindow(app);

    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);
    await expect(window.locator('[data-testid="brand-home"]')).toBeVisible({ timeout: 15000 });
    await expect(window.locator('[id^="flow-tab-"]').first()).toBeVisible({ timeout: 15000 });

    // Wait for bridge to be ready
    bridge = await waitForBridgeState(isolated.path);

    console.log(`[E2E] [plugins] App ready in ${Date.now() - startTime}ms, bridge on port ${bridge.port}`);

    // Create the plugin here (not in a standalone test) so that every worker lifetime —
    // including Playwright's post-failure worker restart, which re-runs beforeAll against
    // fresh isolated userData — has the plugin present. Otherwise the list/delete tests can
    // run in a fresh app where the create test never ran (the historical test-isolation bug).
    const { ok, data } = await callBridge('/plugins/create', {
      body: {
        id: PLUGIN_ID,
        name: PLUGIN_NAME,
        source: PLUGIN_SOURCE,
        description: 'E2E test plugin',
      },
    });
    console.log('[E2E] [plugins] Create result:', JSON.stringify(data));
    expect(ok, `Bridge returned error: ${JSON.stringify(data)}`).toBe(true);
    expect(data.success).toBe(true);
  });

  test.afterAll(async () => {
    console.log('[E2E] [plugins] ========== SUITE END ==========');
    await safeCloseApp(app, 15000, isolated.path);
    if (!process.env.REBEL_E2E_KEEP_USER_DATA) {
      isolated?.cleanup();
    }
  });

  test('create succeeded (plugin present in list)', async () => {
    // Creation itself happens in beforeAll (robust to worker restarts). Confirm it took.
    const { ok, data } = await callBridge('/plugins/list', { method: 'GET' });
    expect(ok).toBe(true);
    expect(data.success).toBe(true);
    const plugins = (data.plugins ?? []) as { id: string; name: string }[];
    expect(plugins.find((p) => p.id === PLUGIN_ID), `Plugin ${PLUGIN_ID} not found in list`).toBeTruthy();
  });

  test('plugin is discoverable via the Plugins dropdown', async () => {
    await openPluginsDropdown(window);
    await expect(pluginMenuItem(window, PLUGIN_NAME)).toBeVisible({ timeout: 10000 });
  });

  test('plugin renders correctly when navigated to', async () => {
    await openPluginByName(window, PLUGIN_NAME);

    const pluginContent = window.locator('[data-testid="e2e-plugin-content"]');
    await expect(pluginContent).toBeVisible({ timeout: 10000 });
    await expect(pluginContent).toHaveText('Hello from E2E test plugin');

    const counter = window.locator('[data-testid="e2e-plugin-counter"]');
    await expect(counter).toHaveText('Count: 0');
  });

  test('plugin list includes the created plugin', async () => {
    const { ok, data } = await callBridge('/plugins/list', { method: 'GET' });

    expect(ok).toBe(true);
    expect(data.success).toBe(true);
    const plugins = (data.plugins ?? []) as { id: string; name: string }[];
    const found = plugins.find((p) => p.id === PLUGIN_ID);
    expect(found, `Plugin ${PLUGIN_ID} not found in list`).toBeTruthy();
    expect(found!.name).toBe(PLUGIN_NAME);
  });

  // Keep this test last: it deletes the plugin created once-per-worker in beforeAll.
  test('plugin can be deleted and disappears from the dropdown', async () => {
    // The prior render test (:156) navigates INTO the plugin surface, so the deleted
    // plugin may be the active surface. Return to a stable, always-present surface
    // (Home) first: the chip's removal is then a pure registry-driven re-render with no
    // active-surface fallback in flight. If the menu is still open from a prior test,
    // close it so the dropdown trigger can unmount cleanly.
    await window.keyboard.press('Escape').catch(() => {});
    const homeTab = window.locator('[role="tab"]', { hasText: 'Home' }).first();
    if (await homeTab.count()) {
      await homeTab.click().catch(() => {});
    }

    const { ok } = await callBridge('/plugins/delete', {
      body: { id: PLUGIN_ID },
    });
    expect(ok).toBe(true);

    // Delete is authoritative on the bridge/main side the moment it returns ok:true
    // (the plugin is removed from store + memory). The renderer prune is driven by a
    // fire-and-forget `plugins:unregister` broadcast, so it lands ASYNCHRONOUSLY after
    // this HTTP response — the web-first waits below re-poll until it propagates.
    //
    // NOTE: we assert the DELETED plugin's menu item disappears, not that the whole
    // "Plugins" dropdown trigger unmounts. The trigger is gated on overflowTabs.length>0
    // and the app always seeds its bundled plugins (pomodoro-timer, research-hub,
    // sources-browser from rebel-system/plugins) into the isolated workspace's
    // Chief-of-Staff at boot, so the trigger legitimately stays mounted after one custom
    // plugin is removed — exactly as a real user would see it. The earlier
    // `trigger toHaveCount(0)` assertion predated bundled-plugin seeding and asserted a
    // global proxy for a per-plugin removal; it no longer reflects product behaviour.
    //
    // The dropdown menu (role=menu) only mounts while open, so open it first, then wait
    // for the item to be pruned. A 15s window comfortably covers the
    // broadcast→listener→useSyncExternalStore→re-render hop. If the item never
    // disappears here in the NORMAL lifetime (not a post-worker-restart fresh app), that
    // indicates a genuinely dropped unregister broadcast and a product-side delivery fix
    // is needed — do not mask it.
    await openPluginsDropdown(window);
    await expect(pluginMenuItem(window, PLUGIN_NAME)).toHaveCount(0, { timeout: 15000 });
    // The trigger itself remains because the bundled plugins are still registered.
    await expect(pluginsDropdownTrigger(window)).toHaveCount(1);
  });
});
