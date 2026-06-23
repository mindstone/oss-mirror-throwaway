import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  startLocalCloudServiceForE2E,
  type LocalCloudService,
} from './helpers/localCloudService';
import {
  appExists,
  enableGuestMode,
  getAppNotFoundMessage,
  getFirstWindow,
  launchWithMocking,
  safeCloseApp,
  startSlackMockServer,
  triggerCloudWebhook,
  waitForMainAppReady,
  type SlackMockServer,
} from './test-utils';

const CLOUD_TOKEN = 'stage6-e2e-cloud-token';
const SIGNING_SECRET = 'slack-smoke-self-test-secret-never-print';
const TEAM_ID = 'T123';
const TEAM_NAME = 'Acme Test';
const BOT_USER_ID = 'U123BOT';
const BOT_TOKEN = 'xoxb-stage6-e2e';
const CHANNEL_ID = 'C123';
const THREAD_TS = '1779854400.000100';

test.skip(!appExists(), getAppNotFoundMessage());

/**
 * CI-aware budget for the Slack mock-server `waitForCall` deterministic waits.
 *
 * The waits themselves are already event-driven (the helper resolves the moment
 * the awaited API call arrives), so this is NOT a missing-wait fix — it's a
 * tired-runner timing cliff: under CI contention the app legitimately takes
 * longer to drive the OAuth/relay flow, and a fixed 20s budget reds the whole
 * monolithic E2E job (F2 — see
 * docs/plans/260617_deflake-ci-for-blocking-gates/PLAN.md Stage 2 and
 * docs/project/WHY_E2E_TESTS_ARE_HARD_TO_FIX.md §6).
 *
 * Mirrors the `firstWindowTimeoutMs()` pattern in tests/e2e/test-utils.ts:
 * generous on CI, snappier locally, env-overridable. A larger CI budget cannot
 * make a passing test fail.
 */
function slackWaitTimeoutMs(): number {
  const override = Number(process.env.E2E_SLACK_WAIT_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return process.env.CI ? 60_000 : 20_000;
}

async function openSettingsDeepLink(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, deepLinkUrl) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    win?.webContents.send('app:navigate-deep-link', deepLinkUrl);
  }, url);
}

async function sendConversationStartFromCloud(app: ElectronApplication, args: {
  sessionId: string;
  text: string;
  switchToConversation: boolean;
}): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload) => {
    const externalContext = {
      kind: 'slack-thread',
      identity: { teamId: payload.teamId, channelId: payload.channelId, threadTs: payload.threadTs },
      metadata: { userId: 'U123USER' },
    };
    BrowserWindow.getAllWindows().forEach((win) => {
      if (win.isDestroyed()) return;
      win.webContents.send('conversations:start-requested', {
        sessionId: payload.sessionId,
        text: payload.text,
        sendMessage: true,
        switchToConversation: payload.switchToConversation,
        origin: 'plugin',
      });
      win.webContents.send('intent:external-context-arrived', {
        sessionId: payload.sessionId,
        appId: 'slack',
        externalContext,
        receivedAt: Date.now(),
      });
    });
  }, {
    ...args,
    teamId: TEAM_ID,
    channelId: CHANNEL_ID,
    threadTs: THREAD_TS,
  });
}

async function configureRendererForLocalCloud(page: Page, cloudBaseUrl: string): Promise<void> {
  await page.evaluate(async ({ cloudUrl, token }) => {
    type SettingsApi = {
      get: () => Promise<Record<string, unknown>>;
      update: (settings: Record<string, unknown>) => Promise<unknown>;
      mcpAddBundledServer: (args: { serverName: string; mode?: 'create' | 'update' }) => Promise<unknown>;
    };
    type AppApi = { openUrl?: (url: string) => Promise<void> | void };
    type SlackApi = { startAuth: () => Promise<{ success: boolean; teamName?: string; error?: string }> };
    const w = window as typeof window & {
      settingsApi: SettingsApi;
      appApi: AppApi;
      slackApi: SlackApi;
    };

    const current = await w.settingsApi.get();
    await w.settingsApi.update({
      ...current,
      cloudInstance: {
        ...((current.cloudInstance as Record<string, unknown> | undefined) ?? {}),
        mode: 'cloud',
        cloudUrl,
        cloudToken: token,
        lastKnownStatus: 'running',
        provisionMode: 'managed',
      },
      experimental: {
        ...((current.experimental as Record<string, unknown> | undefined) ?? {}),
        slackCloudWebhookEnabled: false,
        slackInboundThreadHistory: true,
      },
    });
  }, { cloudUrl: cloudBaseUrl, token: CLOUD_TOKEN });
}

async function installMainIpcStubs(app: ElectronApplication, cloudBaseUrl: string): Promise<void> {
  await app.evaluate(({ ipcMain }, cloudUrl) => {
    ipcMain.removeHandler('slack:start-auth');
    ipcMain.handle('slack:start-auth', async () => ({ success: true, teamName: 'Acme Test' }));

    ipcMain.removeHandler('app:open-url');
    ipcMain.handle('app:open-url', async (_event, url: string) => {
      if (url.includes('slack.com/oauth/v2/authorize')) {
        const parsed = new URL(url);
        const state = parsed.searchParams.get('state');
        if (!state) throw new Error('Slack OAuth URL was missing state');
        const response = await fetch(`${cloudUrl}/api/integrations/slack/oauth/callback?code=stage6-e2e&state=${encodeURIComponent(state)}`);
        if (!response.ok) {
          throw new Error(`Slack OAuth callback failed with ${response.status}`);
        }
      }
    });
  }, cloudBaseUrl);
}

async function patchCloudSettings(cloudBaseUrl: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${cloudBaseUrl}/api/settings`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${CLOUD_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Cloud settings patch failed: ${response.status} ${await response.text()}`);
  }
}

async function postSlackReplyToMockServer(mockServer: SlackMockServer, text: string): Promise<void> {
  const response = await fetch(`${mockServer.baseUrl}/api/chat.postMessage`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${BOT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      channel: CHANNEL_ID,
      thread_ts: THREAD_TS,
      text,
    }),
  });
  if (!response.ok) {
    throw new Error(`Slack mock postMessage failed: ${response.status} ${await response.text()}`);
  }
}

async function fetchThreadHistoryFromMockServer(mockServer: SlackMockServer): Promise<void> {
  const url = new URL('/api/conversations.replies', mockServer.baseUrl);
  url.searchParams.set('channel', CHANNEL_ID);
  url.searchParams.set('ts', THREAD_TS);
  url.searchParams.set('limit', '4');
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${BOT_TOKEN}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Slack mock thread history failed: ${response.status} ${await response.text()}`);
  }
}

test.describe('Messaging Slack mock-server harness', () => {
  test.describe.configure({ timeout: 180_000 });

  let mockServer: SlackMockServer;
  let cloud: LocalCloudService;
  let app: ElectronApplication;
  let page: Page;
  let cleanupUserData: (() => void) | null = null;
  let userDataPath: string | null = null;

  test.beforeEach(async ({}, testInfo) => {
    mockServer = await startSlackMockServer();
    cloud = await startLocalCloudServiceForE2E({
      token: CLOUD_TOKEN,
      userDataPrefix: 'tmp/stage6-cloud-e2e',
      env: {
        SLACK_API_BASE_URL: mockServer.baseUrl,
        SLACK_SIGNING_SECRET: SIGNING_SECRET,
        SLACK_CLIENT_ID: '111.222',
        SLACK_CLIENT_SECRET: '****************************',
      },
    });

    const launched = await launchWithMocking(`messaging-${testInfo.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, {
      defaultMockResponse: 'Mock Slack reply from Rebel.',
      additionalEnv: {
        SLACK_API_BASE_URL: mockServer.baseUrl,
      },
    });
    app = launched.electronApp;
    cleanupUserData = launched.cleanup;
    userDataPath = launched.userDataPath;
    page = await getFirstWindow(app);
    await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    await enableGuestMode(page);
    await waitForMainAppReady(page);
    await configureRendererForLocalCloud(page, cloud.baseUrl);
    await installMainIpcStubs(app, cloud.baseUrl);
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === 'failed' || testInfo.status === 'timedOut') {
      await page?.screenshot({ path: `test-results/messaging-${Date.now()}-failure.png` }).catch(() => undefined);
    }
    // Pass userDataPath so safeCloseApp's orphan detection + cleanup actually run
    if (app) await safeCloseApp(app, 15_000, userDataPath ?? undefined).catch(() => undefined);
    cleanupUserData?.();
    if (cloud) await cloud.stop().catch(() => undefined);
    if (mockServer) await mockServer.stop().catch(() => undefined);
  });

  test('connects Slack listener and keeps mentions in one thread-bound conversation', async () => {
    await openSettingsDeepLink(app, 'rebel://settings/?tab=cloud&section=messagingChannels');
    const settingsPanel = page.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible({ timeout: 10_000 });
    const messagingSection = page.locator('[data-testid="messaging-channels-section"]');
    await expect(messagingSection).toBeVisible({ timeout: 10_000 });

    const cta = messagingSection.locator('[data-testid="messaging-connect-slack-cta"]');
    await expect(cta).toBeVisible({ timeout: 10_000 });
    await cta.getByRole('button', { name: 'Connect Slack' }).click();
    await page.evaluate(async () => {
      const w = window as typeof window & {
        settingsApi: { mcpAddBundledServer: (args: { serverName: string; mode?: 'create' | 'update' }) => Promise<unknown> };
      };
      await w.settingsApi.mcpAddBundledServer({ serverName: 'Slack', mode: 'create' });
    });

    await page.reload();
    await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    await waitForMainAppReady(page);
    await installMainIpcStubs(app, cloud.baseUrl);
    await openSettingsDeepLink(app, 'rebel://settings/?tab=cloud&section=messagingChannels');
    await expect(cta).not.toBeVisible({ timeout: 10_000 });

    const slackConnectionCard = messagingSection.locator('section[aria-label="Slack connection"]');
    await expect(slackConnectionCard).toBeVisible({ timeout: 10_000 });
    await slackConnectionCard.getByRole('button', { name: 'Connect Slack' }).click();

    await mockServer.waitForCall('oauth.v2.access', undefined, { timeout: slackWaitTimeoutMs() });
    await page.evaluate(async ({ teamId, teamName }) => {
      const w = window as typeof window & {
        settingsApi: {
          get: () => Promise<Record<string, unknown>>;
          update: (settings: Record<string, unknown>) => Promise<unknown>;
        };
      };
      const current = await w.settingsApi.get();
      await w.settingsApi.update({
        ...current,
        experimental: {
          ...((current.experimental as Record<string, unknown> | undefined) ?? {}),
          slackCloudWebhookEnabled: true,
          slackInboundThreadHistory: true,
          cloudSlackWorkspace: {
            teamId,
            teamName,
            status: 'connected',
            occurredAt: Date.now(),
          },
        },
      });
    }, { teamId: TEAM_ID, teamName: TEAM_NAME });
    await page.reload();
    await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    await waitForMainAppReady(page);
    await openSettingsDeepLink(app, 'rebel://settings/?tab=cloud&section=messagingChannels');
    await expect(slackConnectionCard.getByText('Slack connected')).toBeVisible({ timeout: 30_000 });
    await patchCloudSettings(cloud.baseUrl, {
      experimental: {
        slackCloudWebhookEnabled: true,
        slackInboundThreadHistory: true,
      },
    });

    const webhookUrl = `${cloud.baseUrl}/api/integrations/slack/events`;
    const firstRelay = await triggerCloudWebhook({
      mockServer,
      webhookUrl,
      signingSecret: SIGNING_SECRET,
      event: {
        type: 'app_mention',
        team_id: TEAM_ID,
        user: 'U123USER',
        text: `<@${BOT_USER_ID}> stage 6 first mention`,
        channel: CHANNEL_ID,
        channel_type: 'channel',
        ts: THREAD_TS,
        thread_ts: THREAD_TS,
      },
    });
    expect(firstRelay).toMatchObject({ ok: true });
    await page.reload();
    await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    await waitForMainAppReady(page);
    await expect(page.locator('[data-testid="brand-home"]')).toBeVisible({ timeout: 15_000 });
    await sendConversationStartFromCloud(app, {
      sessionId: 'stage6-slack-thread',
      text: 'stage 6 first mention',
      switchToConversation: true,
    });

    // The mock returns the same canned reply for every turn, so once the thread has
    // >1 mention there are multiple turns matching this text. Scope to the latest turn
    // (.last()) to assert the most recent reply without a strict-mode multi-match.
    await expect(page.locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]').filter({ hasText: 'Mock Slack reply from Rebel.' }).last()).toBeVisible({ timeout: 45_000 });
    await postSlackReplyToMockServer(mockServer, 'Mock Slack reply from Rebel.');
    await mockServer.waitForCall('chat.postMessage', (call) => {
      const body = call.body as Record<string, unknown>;
      return typeof body.text === 'string' && body.text.includes('Mock Slack reply from Rebel.');
    }, { timeout: slackWaitTimeoutMs() });

    const secondRelay = await triggerCloudWebhook({
      mockServer,
      webhookUrl,
      signingSecret: SIGNING_SECRET,
      event: {
        type: 'app_mention',
        team_id: TEAM_ID,
        user: 'U123USER',
        text: `<@${BOT_USER_ID}> stage 6 follow-up`,
        channel: CHANNEL_ID,
        channel_type: 'channel',
        ts: '1779854403.000400',
        thread_ts: THREAD_TS,
      },
    });
    expect(secondRelay).toMatchObject({ ok: true });
    await page.reload();
    await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    await waitForMainAppReady(page);
    await expect(page.locator('[data-testid="brand-home"]')).toBeVisible({ timeout: 15_000 });
    await fetchThreadHistoryFromMockServer(mockServer);
    await sendConversationStartFromCloud(app, {
      sessionId: 'stage6-slack-thread',
      text: 'stage 6 follow-up',
      switchToConversation: true,
    });

    await mockServer.waitForCall('conversations.replies', undefined, { timeout: slackWaitTimeoutMs() });
    await expect(page.locator('article.agent-turn-message[data-role="user"]').filter({ hasText: 'stage 6 follow-up' })).toBeVisible({ timeout: 45_000 });
    // Two mentions → two turns, both carrying the identical canned reply; scope to the
    // latest (.last()) so this asserts the follow-up's reply, not a strict-mode 2-match.
    await expect(page.locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]').filter({ hasText: 'Mock Slack reply from Rebel.' }).last()).toBeVisible({ timeout: 10_000 });

    await postSlackReplyToMockServer(mockServer, 'Mock Slack reply from Rebel. Follow-up acknowledged.');
    await mockServer.waitForCall('chat.postMessage', (call) => {
      const body = call.body as Record<string, unknown>;
      return typeof body.text === 'string' && body.text.includes('Follow-up acknowledged');
    }, { timeout: slackWaitTimeoutMs() });

    const revoked = await fetch(`${mockServer.baseUrl}/__test/tokens-revoked`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl, signingSecret: SIGNING_SECRET, teamId: TEAM_ID }),
    });
    expect(revoked.ok).toBe(true);
    await page.evaluate(async ({ teamId, teamName }) => {
      const w = window as typeof window & {
        settingsApi: {
          get: () => Promise<Record<string, unknown>>;
          update: (settings: Record<string, unknown>) => Promise<unknown>;
        };
      };
      const current = await w.settingsApi.get();
      await w.settingsApi.update({
        ...current,
        experimental: {
          ...((current.experimental as Record<string, unknown> | undefined) ?? {}),
          cloudSlackWorkspace: {
            teamId,
            teamName,
            status: 'needs_reconnect',
            occurredAt: Date.now(),
          },
        },
      });
    }, { teamId: TEAM_ID, teamName: TEAM_NAME });
    await openSettingsDeepLink(app, 'rebel://settings/?tab=cloud&section=messagingChannels');
    await expect(messagingSection).toBeVisible({ timeout: 15_000 });
    await expect(slackConnectionCard.getByText('Slack needs reconnecting')).toBeVisible({ timeout: 30_000 });
  });
});
