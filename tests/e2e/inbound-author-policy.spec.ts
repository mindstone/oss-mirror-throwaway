import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  startLocalCloudServiceForE2E,
  type LocalCloudService,
} from './helpers/localCloudService';
import {
  appExists,
  createIsolatedUserData,
  enableGuestMode,
  enableLlmMocking,
  getAppNotFoundMessage,
  getFirstWindow,
  launchWithIsolatedUserData,
  safeCloseApp,
  startSlackMockServer,
  triggerCloudWebhook,
  waitForMainAppReady,
  writeMinimalSettings,
  type IsolatedUserData,
  type SlackMockServer,
} from './test-utils';

const CLOUD_TOKEN = '**********************';
const SIGNING_SECRET = 'slack-smoke-self-test-secret-never-print';
const TEAM_ID = 'T123';
const TEAM_NAME = 'Acme Test';
// Canonical Slack user id (matches [UW][A-Z0-9]+, no underscore). The renderer's
// "Allow this ID" path verifies the author via live users.info before writing the
// allowlist, so the fixture id MUST be canonical and resolvable by the mock — a
// non-canonical id (e.g. `u_stranger`) skips the id fast-path, falls to an
// unimplemented users.list scan, and the allowlist write silently no-ops.
const STRANGER_AUTHOR_RAW_ID = 'U0STRANGER1';
const STRANGER_AUTHOR_NORMALIZED_ID = 'U0STRANGER1';
const RECENT_SENDER_PRINCIPAL_KEY = `slack:${TEAM_ID}:human:${STRANGER_AUTHOR_NORMALIZED_ID}`;

test.skip(!appExists(), getAppNotFoundMessage());

interface InboundAuthorStateScenario {
  id: 'fresh' | 'upgrade' | 'corrupted';
  expectedMode: 'ownerOnly' | 'legacyPermissive';
  expectedUpgradeReviewPending: boolean;
}

interface ScenarioRuntime {
  app: ElectronApplication;
  page: Page;
  cloud: LocalCloudService;
  mockServer: SlackMockServer;
  isolated: IsolatedUserData;
}

interface RelayResult {
  status: number | null;
}

const MULTI_STATE_SCENARIOS: InboundAuthorStateScenario[] = [
  {
    id: 'fresh',
    expectedMode: 'ownerOnly',
    expectedUpgradeReviewPending: false,
  },
  {
    id: 'upgrade',
    expectedMode: 'legacyPermissive',
    expectedUpgradeReviewPending: true,
  },
  {
    id: 'corrupted',
    expectedMode: 'legacyPermissive',
    expectedUpgradeReviewPending: true,
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractInboundPolicy(settings: unknown): Record<string, unknown> | null {
  const settingsRecord = asRecord(settings);
  const experimental = asRecord(settingsRecord?.experimental);
  return asRecord(experimental?.inboundAuthorPolicy);
}

function extractModeAndReview(policy: Record<string, unknown> | null): string | null {
  if (!policy) return null;
  const mode = policy.mode;
  const notices = asRecord(policy.notices);
  const upgradeReviewPending = notices?.upgradeReviewPending;
  if (typeof mode !== 'string' || typeof upgradeReviewPending !== 'boolean') {
    return null;
  }
  return `${mode}:${upgradeReviewPending ? 'pending' : 'not-pending'}`;
}

function extractSlackAllowlist(policy: Record<string, unknown> | null): string[] {
  if (!policy) return [];
  const allowlist = asRecord(policy.allowlist);
  const slackAllowlist = allowlist?.slack;
  if (!Array.isArray(slackAllowlist)) return [];
  return slackAllowlist.filter((value): value is string => typeof value === 'string');
}

async function provisionManagedSlackWorkspace(cloudBaseUrl: string): Promise<void> {
  const startResponse = await fetch(`${cloudBaseUrl}/api/integrations/slack/oauth/start/managed`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CLOUD_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  if (!startResponse.ok) {
    throw new Error(`Managed Slack OAuth start failed (${startResponse.status}): ${await startResponse.text()}`);
  }

  const startPayload = asRecord(await startResponse.json() as unknown);
  const authUrlRaw = startPayload?.authUrl;
  if (typeof authUrlRaw !== 'string') {
    throw new Error('Managed Slack OAuth start response did not include authUrl');
  }
  const state = new URL(authUrlRaw).searchParams.get('state');
  if (!state) {
    throw new Error('Managed Slack OAuth start response did not include state');
  }

  const callbackResponse = await fetch(
    `${cloudBaseUrl}/api/integrations/slack/oauth/callback?code=stage8-e2e&state=${encodeURIComponent(state)}`,
  );
  if (!callbackResponse.ok) {
    throw new Error(`Managed Slack OAuth callback failed (${callbackResponse.status}): ${await callbackResponse.text()}`);
  }
}

/**
 * Seed a DESKTOP-side Slack workspace + bot token into the isolated userData so the
 * renderer "Allow this ID" path can resolve the stranger via live `users.info`.
 *
 * `provisionManagedSlackWorkspace` only sets up the CLOUD-side workspace; the
 * `slack:resolve-author-input` handler reads DESKTOP credentials via
 * `slackAuthService.getSlackWorkspaces()` / `getSlackTokensForWorkspace()`, which load
 * from `<userData>/mcp/slack/config.json` and `<userData>/mcp/slack/workspaces/<teamId>.json`.
 * Without these, resolution returns `no_workspace` and `addToAllowlist` silently no-ops.
 * The bot token points at the existing Slack mock (via SLACK_API_BASE_URL on launch).
 */
function seedDesktopSlackWorkspace(userDataPath: string): void {
  const slackConfigDir = path.join(userDataPath, 'mcp', 'slack');
  const workspacesDir = path.join(slackConfigDir, 'workspaces');
  fs.mkdirSync(workspacesDir, { recursive: true });

  const config = {
    workspaces: [
      {
        teamId: TEAM_ID,
        teamName: TEAM_NAME,
        authedAt: new Date().toISOString(),
      },
    ],
  };
  fs.writeFileSync(path.join(slackConfigDir, 'config.json'), JSON.stringify(config, null, 2));

  const tokens = {
    botToken: 'xoxb-stage8-bot-token',
    botUserId: 'U123BOT',
    botUsername: 'rebel',
    authedUserId: 'U123USER',
  };
  fs.writeFileSync(path.join(workspacesDir, `${TEAM_ID}.json`), JSON.stringify(tokens, null, 2));
}

function seedScenarioSettings(args: {
  userDataPath: string;
  cloudBaseUrl: string;
  scenario: InboundAuthorStateScenario;
}): void {
  writeMinimalSettings(args.userDataPath);

  const settingsPath = path.join(args.userDataPath, 'app-settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  const experimental: Record<string, unknown> = {
    ...(asRecord(settings.experimental) ?? {}),
    slackCloudWebhookEnabled: true,
    slackInboundThreadHistory: true,
  };

  settings.cloudInstance = {
    mode: 'cloud',
    cloudUrl: args.cloudBaseUrl,
    cloudToken: CLOUD_TOKEN,
    lastKnownStatus: 'running',
    provisionMode: 'managed',
  };

  switch (args.scenario.id) {
    case 'fresh':
      delete experimental.inboundAuthorPolicy;
      delete experimental.cloudSlackWorkspace;
      break;
    case 'upgrade':
      delete experimental.inboundAuthorPolicy;
      experimental.cloudSlackWorkspace = {
        teamId: TEAM_ID,
        teamName: TEAM_NAME,
        status: 'connected',
        occurredAt: Date.now(),
      };
      break;
    case 'corrupted':
      experimental.cloudSlackWorkspace = {
        teamId: TEAM_ID,
        teamName: TEAM_NAME,
        status: 'connected',
        occurredAt: Date.now(),
      };
      experimental.inboundAuthorPolicy = {
        inboundAuthorPolicySchemaVersion: 1,
        mode: 'ownerOnly',
      };
      break;
    default:
      break;
  }

  settings.experimental = experimental;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

async function openSettingsDeepLink(app: ElectronApplication, url: string): Promise<void> {
  const isRetryable = (error: unknown): boolean =>
    error instanceof Error && (
      error.message.includes('Execution context was destroyed')
      || error.message.includes('Most likely the page has been closed')
    );

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await app.evaluate(({ BrowserWindow }, deepLinkUrl) => {
        const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
        win?.webContents.send('app:navigate-deep-link', deepLinkUrl);
      }, url);
      return;
    } catch (error) {
      if (!isRetryable(error) || attempt === 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

async function fetchCloudSettings(cloudBaseUrl: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${cloudBaseUrl}/api/settings`, {
    headers: {
      authorization: `Bearer ${CLOUD_TOKEN}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Cloud settings fetch failed (${response.status}): ${await response.text()}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

async function waitForPolicyModeAndNotice(args: {
  cloudBaseUrl: string;
  expectedMode: string;
  expectedUpgradePending: boolean;
}): Promise<void> {
  const expected = `${args.expectedMode}:${args.expectedUpgradePending ? 'pending' : 'not-pending'}`;
  await expect.poll(async () => {
    const policy = extractInboundPolicy(await fetchCloudSettings(args.cloudBaseUrl));
    return extractModeAndReview(policy);
  }, { timeout: 45_000 }).toBe(expected);
}

/**
 * Poll the cloud recent-senders API until the given principal key is persisted.
 *
 * CONTRACT-TIMING fix (#2, docs/plans/260613_e2e-flake-diagnosis): the Slack
 * webhook acks HTTP 200 (slackWebhook.ts:1250) BEFORE async processing records
 * the denied attempt (slackWebhook.ts:1658 / recordAttempt :499). The renderer's
 * RecentMessageAttemptsPanel fetches recent senders ONCE on mount
 * (RecentMessageAttemptsPanel.tsx:107) with no polling loop — so a send → 200 →
 * reload → open-panel sequence races that async write and the panel can mount
 * before the row exists. We close the race at the harness level: after the relay
 * returns 200, poll the cloud's recent-senders endpoint (the same data source the
 * panel reads, GET /api/slack/recent-senders, response.senders[].principalKey)
 * until the denied sender is present, THEN reload + open the panel. This makes the
 * one-shot panel fetch deterministically observe the row. Coverage is preserved:
 * the test still asserts the denied-sender row is visible in the product UI.
 *
 * PRODUCT FOLLOW-UP (Greg): should RecentMessageAttemptsPanel live-refresh while
 * open (e.g. poll / subscribe) rather than a single fetch on mount? Today a row
 * that lands after the panel opens stays invisible until the panel is reopened.
 * Open product-design question — NOT changed here (test-harness fix only).
 */
async function waitForRecentSenderPersisted(args: {
  cloudBaseUrl: string;
  principalKey: string;
}): Promise<void> {
  await expect.poll(async () => {
    const response = await fetch(`${args.cloudBaseUrl}/api/slack/recent-senders`, {
      headers: { authorization: `Bearer ${CLOUD_TOKEN}` },
    });
    if (!response.ok) {
      return false;
    }
    const body = asRecord(await response.json());
    const senders = Array.isArray(body?.senders) ? body.senders : [];
    return senders.some(
      (sender) => asRecord(sender)?.principalKey === args.principalKey,
    );
    // Budget headroom: the deny-record async write settles in ~9s on an idle
    // machine, but the local cloud service can be event-loop-starved under heavy
    // whole-suite / cross-worktree contention (the diagnosed FLAKE(infra) regime).
    // 90s tolerates that transient without masking a real never-recorded case
    // (a genuine miss still fails the poll, just later).
  }, { timeout: 90_000, intervals: [250, 500, 1000, 2000, 4000] }).toBe(true);
}

async function sendInboundStrangerMessage(args: {
  mockServer: SlackMockServer;
  cloudBaseUrl: string;
  ts: string;
  text: string;
}): Promise<RelayResult> {
  const relayed = await triggerCloudWebhook({
    mockServer: args.mockServer,
    webhookUrl: `${args.cloudBaseUrl}/api/integrations/slack/events`,
    signingSecret: SIGNING_SECRET,
    event: {
      type: 'message',
      team_id: TEAM_ID,
      user: STRANGER_AUTHOR_RAW_ID,
      channel: 'D_STAGE8_STRANGER',
      channel_type: 'im',
      ts: args.ts,
      text: args.text,
      user_profile: {
        display_name: 'Scenario Stranger',
        name: 'scenario-stranger',
      },
    },
  });

  const relayRoot = asRecord(relayed);
  const relayPayload = asRecord(relayRoot?.relayed);
  const status = typeof relayPayload?.status === 'number' ? relayPayload.status : null;

  return { status };
}

async function setupScenario(scenario: InboundAuthorStateScenario): Promise<ScenarioRuntime> {
  const mockServer = await startSlackMockServer();
  const cloud = await startLocalCloudServiceForE2E({
    token: CLOUD_TOKEN,
    userDataPrefix: 'tmp/stage8-cloud-e2e',
    env: {
      SLACK_API_BASE_URL: mockServer.baseUrl,
      SLACK_SIGNING_SECRET: SIGNING_SECRET,
      SLACK_CLIENT_ID: '111.222',
      SLACK_CLIENT_SECRET: '****************************',
    },
  });
  await provisionManagedSlackWorkspace(cloud.baseUrl);

  const isolated = createIsolatedUserData(`inbound-author-policy-${scenario.id}`);
  seedScenarioSettings({
    userDataPath: isolated.path,
    cloudBaseUrl: cloud.baseUrl,
    scenario,
  });
  // Desktop Slack credentials so the renderer "Allow this ID" path can resolve the
  // stranger via users.info against the mock (only exercised by the deny -> allow test).
  seedDesktopSlackWorkspace(isolated.path);

  const app = await launchWithIsolatedUserData(isolated, {
    additionalEnv: {
      SLACK_API_BASE_URL: mockServer.baseUrl,
    },
  });
  const page = await getFirstWindow(app);
  await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
  await enableLlmMocking(app, {
    responses: [],
    defaultResponse: 'Inbound author policy E2E mock response.',
  });
  await enableGuestMode(page);
  await waitForMainAppReady(page);

  return {
    app,
    page,
    cloud,
    mockServer,
    isolated,
  };
}

async function teardownScenario(runtime: ScenarioRuntime): Promise<void> {
  await safeCloseApp(runtime.app, 15_000, runtime.isolated.path).catch(() => undefined);
  runtime.isolated.cleanup();
  await runtime.cloud.stop().catch(() => undefined);
  await runtime.mockServer.stop().catch(() => undefined);
}

test.describe('inbound-author-policy e2e', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  for (const scenario of MULTI_STATE_SCENARIOS) {
    test(`inbound-author-policy multi-state ${scenario.id} normalizes + syncs + denied sender appears`, async () => {
      const runtime = await setupScenario(scenario);
      try {
        await openSettingsDeepLink(runtime.app, 'rebel://settings/?tab=cloud&section=messagingChannels');
        await expect(runtime.page.getByTestId('messaging-channels-section')).toBeVisible({ timeout: 20_000 });

        const modeSelect = runtime.page.getByTestId('who-can-message-rebel-mode');
        await expect(modeSelect).toHaveValue(scenario.expectedMode);
        if (scenario.expectedUpgradeReviewPending) {
          await expect(runtime.page.getByTestId('upgrade-review-notice')).toBeVisible();
        } else {
          await expect(runtime.page.getByTestId('upgrade-review-notice')).toHaveCount(0);
        }

        if (scenario.expectedMode === 'ownerOnly') {
          await modeSelect.selectOption('allowlist');
          await waitForPolicyModeAndNotice({
            cloudBaseUrl: runtime.cloud.baseUrl,
            expectedMode: 'allowlist',
            expectedUpgradePending: false,
          });
          await modeSelect.selectOption('ownerOnly');
          await waitForPolicyModeAndNotice({
            cloudBaseUrl: runtime.cloud.baseUrl,
            expectedMode: 'ownerOnly',
            expectedUpgradePending: false,
          });
        } else {
          await modeSelect.selectOption('ownerOnly');
          await waitForPolicyModeAndNotice({
            cloudBaseUrl: runtime.cloud.baseUrl,
            expectedMode: 'ownerOnly',
            expectedUpgradePending: false,
          });
        }

        const firstRelay = await sendInboundStrangerMessage({
          mockServer: runtime.mockServer,
          cloudBaseUrl: runtime.cloud.baseUrl,
          ts: '1779857400.000100',
          text: 'first inbound attempt should be denied under ownerOnly',
        });
        expect(firstRelay.status).toBe(200);

        // HTTP 200 only acks receipt — the denied attempt is recorded async.
        // Wait for the row to be persisted before the one-shot panel fetch (#2).
        await waitForRecentSenderPersisted({
          cloudBaseUrl: runtime.cloud.baseUrl,
          principalKey: RECENT_SENDER_PRINCIPAL_KEY,
        });

        await runtime.page.reload({ waitUntil: 'domcontentloaded' });
        await enableGuestMode(runtime.page);
        await waitForMainAppReady(runtime.page);
        await openSettingsDeepLink(runtime.app, 'rebel://settings/?tab=cloud&section=recent-message-attempts');
        await expect(runtime.page.getByTestId('recent-message-attempts-panel')).toBeVisible({ timeout: 20_000 });
        await expect(
          runtime.page.getByTestId(`recent-message-attempt-${RECENT_SENDER_PRINCIPAL_KEY}`),
        ).toBeVisible({ timeout: 45_000 });
      } finally {
        await teardownScenario(runtime);
      }
    });
  }

  test('inbound-author-policy deny -> allow recovery loop lets next message through', async () => {
    const runtime = await setupScenario({
      id: 'fresh',
      expectedMode: 'ownerOnly',
      expectedUpgradeReviewPending: false,
    });
    try {
      await openSettingsDeepLink(runtime.app, 'rebel://settings/?tab=cloud&section=messagingChannels');
      await expect(runtime.page.getByTestId('messaging-channels-section')).toBeVisible({ timeout: 20_000 });
      const modeSelect = runtime.page.getByTestId('who-can-message-rebel-mode');
      await expect(modeSelect).toHaveValue('ownerOnly');
      await modeSelect.selectOption('allowlist');
      await waitForPolicyModeAndNotice({
        cloudBaseUrl: runtime.cloud.baseUrl,
        expectedMode: 'allowlist',
        expectedUpgradePending: false,
      });

      const deniedRelay = await sendInboundStrangerMessage({
        mockServer: runtime.mockServer,
        cloudBaseUrl: runtime.cloud.baseUrl,
        ts: '1779857500.000100',
        text: 'deny path before allowlist recovery',
      });
      expect(deniedRelay.status).toBe(200);

      // HTTP 200 only acks receipt — the denied attempt is recorded async.
      // Wait for the row to be persisted before the one-shot panel fetch (#2).
      await waitForRecentSenderPersisted({
        cloudBaseUrl: runtime.cloud.baseUrl,
        principalKey: RECENT_SENDER_PRINCIPAL_KEY,
      });

      await runtime.page.reload({ waitUntil: 'domcontentloaded' });
      await enableGuestMode(runtime.page);
      await waitForMainAppReady(runtime.page);
      await openSettingsDeepLink(runtime.app, 'rebel://settings/?tab=cloud&section=recent-message-attempts');

      const senderRow = runtime.page.getByTestId(`recent-message-attempt-${RECENT_SENDER_PRINCIPAL_KEY}`);
      await expect(senderRow).toBeVisible({ timeout: 45_000 });
      await senderRow.getByRole('button', { name: 'Allow this ID' }).click();
      await expect(senderRow).toHaveCount(0);

      await expect.poll(async () => {
        const policy = extractInboundPolicy(await fetchCloudSettings(runtime.cloud.baseUrl));
        return extractSlackAllowlist(policy).includes(STRANGER_AUTHOR_NORMALIZED_ID);
      }, { timeout: 30_000 }).toBe(true);

      const allowedRelay = await sendInboundStrangerMessage({
        mockServer: runtime.mockServer,
        cloudBaseUrl: runtime.cloud.baseUrl,
        ts: '1779857501.000200',
        text: 'allow path after policy recovery',
      });
      expect(allowedRelay.status).toBe(200);

      await runtime.page.reload({ waitUntil: 'domcontentloaded' });
      await enableGuestMode(runtime.page);
      await waitForMainAppReady(runtime.page);
      await openSettingsDeepLink(runtime.app, 'rebel://settings/?tab=cloud&section=recent-message-attempts');
      await expect(
        runtime.page.getByTestId(`recent-message-attempt-${RECENT_SENDER_PRINCIPAL_KEY}`),
      ).toHaveCount(0);
    } finally {
      await teardownScenario(runtime);
    }
  });
});
