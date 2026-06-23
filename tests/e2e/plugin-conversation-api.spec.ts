/**
 * Plugin Conversation API E2E Tests
 *
 * Verifies the plugin conversation hooks work end-to-end in a real Electron app
 * using the bridge plugin creation flow and LLM mocking.
 *
 * Planning doc: docs/plans/260408_plugin_conversation_api_e2e.md
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  appExists,
  enableGuestMode,
  getAppNotFoundMessage,
  getFirstWindow,
  launchWithMocking,
  mockResponse,
  safeCloseApp,
  sendMessageAndWaitForResponse,
  waitForMainAppReady,
} from './test-utils';
import { type BridgeState, callBridge as callBridgeHelper, waitForBridgeState } from './helpers/plugin-bridge';

test.skip(!appExists(), getAppNotFoundMessage());

const PLUGIN_ID = 'e2e-plugin-conversation-api';
const PLUGIN_NAME = 'E2E Plugin Conversation API';
const PLUGIN_SOURCE = `
import React, { useState } from 'react';
import { Card, Stack } from '@rebel/plugin-ui';
import {
  useActiveSession,
  useConversation,
  useConversations,
  useRebelEvent,
} from '@rebel/plugin-api';

export default function PluginConversationApiE2E() {
  const { data: conversations, totalCount } = useConversations();
  const activeSession = useActiveSession();
  const [capturedSessionId, setCapturedSessionId] = useState<string | null>(null);
  const [turnCompleted, setTurnCompleted] = useState(false);
  const singleConversation = useConversation(capturedSessionId ?? '');

  useRebelEvent('conversation:created', (p) => {
    const payload = p as { sessionId: string; title: string };
    if (payload.sessionId) {
      setCapturedSessionId(payload.sessionId);
    }
  });

  useRebelEvent('turn:completed', (p) => {
    const payload = p as { sessionId: string; turnId: string; assistantText: string; toolsUsed: string[] };
    if (payload.sessionId) {
      setTurnCompleted(true);
    }
  });

  return (
    <Stack gap="sm">
      <Card>
        <div data-testid="plugin-ready">ready</div>
        <div data-testid="conv-count">{String(totalCount)}</div>
        <div data-testid="conv-first-id">{conversations[0]?.id ?? 'none'}</div>
        <div data-testid="active-session-id">{activeSession?.id ?? 'none'}</div>
        <div data-testid="captured-session-id">{capturedSessionId ?? 'none'}</div>
        <div data-testid="single-conv-id">{singleConversation?.id ?? 'none'}</div>
        <div data-testid="turn-completed">{turnCompleted ? 'yes' : 'no'}</div>
      </Card>
    </Stack>
  );
}
`.trim();

let app: ElectronApplication;
let window: Page;
let cleanup: (() => void) | undefined;
let userDataPath = '';
let bridge: BridgeState;
let createdSessionId: string | null = null;

async function callBridge(endpoint: string, options: { method?: string; body?: unknown } = {}) {
  return callBridgeHelper(bridge, endpoint, options);
}

async function getTestIdText(testId: string): Promise<string> {
  return (await window.locator(`[data-testid="${testId}"]`).textContent())?.trim() ?? '';
}

// Plugin surfaces no longer render as inline `flow-tab-plugin:<id>` tabs. Since the
// FlowPanelsShell restructure (commit 09002ca8a) they live behind a single "Plugins"
// dropdown: the trigger is `button.flow-chip--plugins` and each plugin is a
// `role=menuitem` button whose text is the plugin's manifest name. The menu (role=menu)
// only mounts while open, so we click the trigger before locating the item.
async function openPluginTab(): Promise<void> {
  const trigger = window.locator('button.flow-chip--plugins');
  await expect(trigger).toBeVisible({ timeout: 10000 });
  await trigger.click();
  await expect(window.locator('.flow-overflow-menu[role="menu"]')).toBeVisible({ timeout: 10000 });
  const item = window.locator('[role="menuitem"]', { hasText: PLUGIN_NAME });
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
  await expect(window.locator('[data-testid="plugin-ready"]')).toBeVisible({ timeout: 15000 });
}

test.describe('Plugin Conversation API E2E', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    console.log('[E2E] [plugin-conv-api] ========== SUITE START ==========');

    const launched = await launchWithMocking('plugin-conv-api', {
      mockResponses: [mockResponse(/.*/, 'E2E test response')],
    });

    app = launched.electronApp;
    cleanup = launched.cleanup;
    userDataPath = launched.userDataPath;
    window = await getFirstWindow(app);

    await window.waitForLoadState('domcontentloaded', { timeout: 60000 });
    await enableGuestMode(window);
    await waitForMainAppReady(window);
    await expect(window.locator('[data-testid="brand-home"]')).toBeVisible({ timeout: 15000 });

    bridge = await waitForBridgeState(userDataPath);
    console.log(`[E2E] [plugin-conv-api] Bridge ready on port ${bridge.port}`);

    const createResult = await callBridge('/plugins/create', {
      body: {
        id: PLUGIN_ID,
        name: PLUGIN_NAME,
        source: PLUGIN_SOURCE,
        description: 'E2E plugin conversation API test plugin',
      },
    });

    console.log('[E2E] [plugin-conv-api] Create result:', JSON.stringify(createResult.data));
    expect(createResult.ok, `Bridge returned error: ${JSON.stringify(createResult.data)}`).toBe(true);
    expect(createResult.data.success).toBe(true);

    await openPluginTab();
    console.log('[E2E] [plugin-conv-api] Plugin ready');
  });

  test.afterAll(async () => {
    console.log('[E2E] [plugin-conv-api] ========== SUITE END ==========');

    if (bridge) {
      try {
        const deleteResult = await callBridge('/plugins/delete', {
          body: { id: PLUGIN_ID },
        });
        console.log('[E2E] [plugin-conv-api] Delete result:', JSON.stringify(deleteResult.data));
      } catch (error) {
        console.log('[E2E] [plugin-conv-api] Delete failed during cleanup:', error);
      }
    }

    if (app) {
      await safeCloseApp(app, 15000, userDataPath);
    }
    if (!process.env.REBEL_E2E_KEEP_USER_DATA) {
      cleanup?.();
    }
  });

  test('plugin shows zero conversations initially', async () => {
    await openPluginTab();

    await expect(window.locator('[data-testid="conv-count"]')).toHaveText('0');
    await expect(window.locator('[data-testid="active-session-id"]')).toHaveText('none');
    await expect(window.locator('[data-testid="captured-session-id"]')).toHaveText('none');
  });

  test('conversation hooks and events update after sending a message', async () => {
    console.log('[E2E] [plugin-conv-api] Starting happy-path conversation flow');

    await window.locator('[data-testid="new-chat-button"]').click();
    await sendMessageAndWaitForResponse(window, 'E2E conversation API test');
    await openPluginTab();

    await expect(async () => {
      const convCount = await getTestIdText('conv-count');
      const firstConversationId = await getTestIdText('conv-first-id');
      const capturedId = await getTestIdText('captured-session-id');
      const singleConversationId = await getTestIdText('single-conv-id');
      const turnCompleted = await getTestIdText('turn-completed');

      expect(convCount).toBe('1');
      expect(firstConversationId).not.toBe('none');
      expect(capturedId).not.toBe('none');
      expect(singleConversationId).toBe(capturedId);
      expect(turnCompleted).toBe('yes');
    }).toPass({ timeout: 30000 });

    createdSessionId = await getTestIdText('captured-session-id');
    console.log(`[E2E] [plugin-conv-api] Captured session id: ${createdSessionId}`);
  });

  test('useActiveSession detects conversation from hidden plugin', async () => {
    expect(createdSessionId).not.toBeNull();

    const sessionsTab = window.locator('#flow-tab-sessions');
    await expect(sessionsTab).toBeVisible({ timeout: 10000 });
    await sessionsTab.click();

    const sessionSidebar = window.locator('[data-testid="session-sidebar"]');
    await expect(sessionSidebar).toBeVisible({ timeout: 10000 });

    const sessionButton = window
      .locator(`[data-testid="session-list"] [data-session-id="${createdSessionId}"] button`)
      .first();
    await expect(sessionButton).toBeVisible({ timeout: 10000 });
    await sessionButton.click();
    await expect(
      window.locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]').first()
    ).toBeVisible({ timeout: 10000 });

    await openPluginTab();

    await expect(async () => {
      const activeSessionId = await getTestIdText('active-session-id');
      const capturedId = await getTestIdText('captured-session-id');
      console.log(
        `[E2E] [plugin-conv-api] useActiveSession snapshot: active=${activeSessionId}, captured=${capturedId}`,
      );
      expect(capturedId).not.toBe('none');
      expect(activeSessionId).toBe(capturedId);
    }).toPass({ timeout: 15000 });
  });
});
