/**
 * Tests for MCP Server Removal Service credential cleanup.
 * 
 * Verifies that:
 * 1. Config is read BEFORE deletion to get catalogId/email/workspace
 * 2. Correct cleanup handler is called based on catalogId
 * 3. Cleanup failures don't break the removal flow
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// Mock all the dependencies before importing the module under test
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
}));

vi.mock('@core/logger', () => ({
  logger: loggerMock,
  createLogger: () => loggerMock,
  createScopedLogger: () => loggerMock,
  createTurnSessionLogger: () => loggerMock,
}));

vi.mock('../mcpConfigManager', () => ({
  getMcpServerEntry: vi.fn(),
  removeMcpServerEntry: vi.fn(),
}));

// In-memory store backing so the REAL oauthRefreshFailureStore participates in
// these tests (Stage 2, 260611_calendar-cache-attention: the removal chokepoint
// must clear the persisted needs-reconnect latch). `failWrites` simulates the
// store's swallowed-write failure mode.
const inMemoryStores = vi.hoisted(() => ({
  stateByName: {} as Record<string, Record<string, unknown>>,
  failWrites: false,
}));

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn((opts: { name: string; defaults: Record<string, unknown> }) => {
    const ensure = () => {
      if (!inMemoryStores.stateByName[opts.name]) {
        inMemoryStores.stateByName[opts.name] = JSON.parse(JSON.stringify(opts.defaults ?? {}));
      }
      return inMemoryStores.stateByName[opts.name];
    };
    ensure();
    return {
      get: (key: string) => ensure()[key],
      set: (key: string, value: unknown) => { ensure()[key] = value; },
      has: (key: string) => Object.prototype.hasOwnProperty.call(ensure(), key),
      delete: (key: string) => { delete ensure()[key]; },
      clear: () => { inMemoryStores.stateByName[opts.name] = {}; },
      get store() { return ensure(); },
      set store(value: Record<string, unknown>) {
        if (inMemoryStores.failWrites) throw new Error('disk full');
        inMemoryStores.stateByName[opts.name] = value;
      },
      path: `/tmp/${opts.name}.json`,
    };
  }),
}));

vi.mock('@rebel/cloud-client/cloudClient', () => ({
  configure: vi.fn(),
  request: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../settingsStore', () => ({
  getSettings: vi.fn(() => ({})),
  updateSettings: vi.fn(),
}));

vi.mock('../toolUsageStore', () => ({
  removeToolsForServer: vi.fn().mockReturnValue(0),
}));

vi.mock('../mcpService', () => ({
  invalidateConnectedPackagesCache: vi.fn(),
  reconfigureSuperMcpWithCacheRefreshAndAwaitExecution: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../toolIndexService', () => ({
  markToolIndexInvalidated: vi.fn().mockReturnValue(1),
  markToolIndexRefreshComplete: vi.fn(),
  rollbackToolIndexInvalidation: vi.fn(),
  refreshToolIndex: vi.fn().mockResolvedValue({ success: true, added: 0, updated: 0, removed: 0, total: 0 }),
}));

// Mock auth services
vi.mock('../googleWorkspaceAuthService', () => ({
  removeGoogleAccount: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../slackAuthService', () => ({
  removeSlackWorkspace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../hubspotAuthService', () => ({
  removeHubSpotAccount: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../salesforceAuthService', () => ({
  removeSalesforceAccount: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../microsoftAuthService', () => ({
  removeMicrosoftAccount: vi.fn().mockResolvedValue(undefined),
}));

// Now import the module under test and the mocked dependencies
import { removeMcpServerWithCleanup, performPostRemovalCleanup, __setSlackListenerCleanupDepsForTesting } from '../mcpServerRemovalService';
import { getMcpServerEntry, removeMcpServerEntry } from '../mcpConfigManager';
import { removeGoogleAccount } from '../googleWorkspaceAuthService';
import { removeSlackWorkspace } from '../slackAuthService';
import { removeHubSpotAccount } from '../hubspotAuthService';
import { removeSalesforceAccount } from '../salesforceAuthService';
import { removeMicrosoftAccount } from '../microsoftAuthService';
import {
  reconfigureSuperMcpWithCacheRefreshAndAwaitExecution,
} from '../mcpService';
import { configure, request } from '@rebel/cloud-client/cloudClient';
import { getSettings, updateSettings } from '../../settingsStore';
import * as oauthRefreshFailureStore from '../oauthRefreshFailureStore';

describe('mcpServerRemovalService credential cleanup', () => {
  const TEST_CONFIG_PATH = '/test/mcp-config.json';

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the in-memory persisted stores (oauthRefreshFailureStore backing)
    for (const key of Object.keys(inMemoryStores.stateByName)) {
      delete inMemoryStores.stateByName[key];
    }
    inMemoryStores.failWrites = false;
    // Set up default mock behavior for removeMcpServerEntry
    (removeMcpServerEntry as Mock).mockResolvedValue({ backupPath: null });
    (reconfigureSuperMcpWithCacheRefreshAndAwaitExecution as Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    __setSlackListenerCleanupDepsForTesting(null);
    vi.clearAllMocks();
  });

  it('reads config BEFORE deletion to get catalogId and email', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    const mockRemoveEntry = removeMcpServerEntry as Mock;
    
    // Setup: server has catalogId and email
    mockGetEntry.mockResolvedValueOnce({
      catalogId: 'bundled-google',
      email: 'test@example.com',
    });

    await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'GoogleWorkspace-test');

    // Verify getMcpServerEntry was called BEFORE removeMcpServerEntry
    const getEntryOrder = mockGetEntry.mock.invocationCallOrder[0];
    const removeEntryOrder = mockRemoveEntry.mock.invocationCallOrder[0];
    expect(getEntryOrder).toBeLessThan(removeEntryOrder);
  });

  it('calls Google cleanup handler for bundled-google catalogId', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    const mockRemoveGoogle = removeGoogleAccount as Mock;

    mockGetEntry.mockResolvedValueOnce({
      catalogId: 'bundled-google',
      email: '[external-email]',
    });

    await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'GoogleWorkspace-user');

    expect(mockRemoveGoogle).toHaveBeenCalledWith('[external-email]');
  });

  it('calls Slack cleanup handler with slackTeamId (from env.SLACK_TEAM_ID) not email', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    const mockRemoveSlack = removeSlackWorkspace as Mock;

    mockGetEntry.mockResolvedValueOnce({
      catalogId: 'bundled-slack',
      email: 'user@example.com', // Should be ignored for Slack
      workspace: 'Mindstone', // This is the display name, not the teamId
      slackTeamId: 'T123ABC', // This is what removeSlackWorkspace expects
    });

    await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'Slack-myworkspace');

    expect(mockRemoveSlack).toHaveBeenCalledWith('T123ABC');
    expect(mockRemoveSlack).not.toHaveBeenCalledWith('user@example.com');
    expect(mockRemoveSlack).not.toHaveBeenCalledWith('Mindstone');
  });

  it('auto-stops the cloud Slack listener when a matching Slack connector is removed', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    mockGetEntry.mockResolvedValueOnce({
      catalogId: 'bundled-slack',
      slackTeamId: 'T123ABC',
    });
    (getSettings as Mock).mockReturnValueOnce({
      cloudInstance: {
        mode: 'cloud',
        cloudUrl: 'https://cloud.example',
        cloudToken: 'token',
      },
      experimental: {
        slackCloudWebhookEnabled: true,
        cloudSlackWorkspace: {
          teamId: 'T123ABC',
          teamName: 'Acme',
          status: 'connected',
          occurredAt: 1,
        },
      },
    });

    await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'Slack-myworkspace');

    expect(configure).toHaveBeenCalledWith({ cloudUrl: 'https://cloud.example', token: 'token' });
    expect(request).toHaveBeenCalledWith('DELETE', '/api/integrations/slack/workspace');
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      experimental: expect.objectContaining({
        slackCloudWebhookEnabled: false,
        cloudSlackWorkspace: expect.objectContaining({
          teamId: 'T123ABC',
          status: 'disconnected',
        }),
      }),
    }));
  });

  it('does not auto-stop the cloud listener when the removed Slack workspace does not match', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    mockGetEntry.mockResolvedValueOnce({
      catalogId: 'bundled-slack',
      slackTeamId: 'T-other',
    });
    (getSettings as Mock).mockReturnValueOnce({
      cloudInstance: {
        mode: 'cloud',
        cloudUrl: 'https://cloud.example',
        cloudToken: 'token',
      },
      experimental: {
        slackCloudWebhookEnabled: true,
        cloudSlackWorkspace: {
          teamId: 'T123ABC',
          teamName: 'Acme',
          status: 'connected',
          occurredAt: 1,
        },
      },
    });

    await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'Slack-other');

    expect(request).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('calls HubSpot cleanup handler for bundled-hubspot catalogId', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    const mockRemoveHubSpot = removeHubSpotAccount as Mock;

    mockGetEntry.mockResolvedValueOnce({
      catalogId: 'bundled-hubspot',
      email: '[external-email]',
    });

    await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'HubSpot-sales');

    expect(mockRemoveHubSpot).toHaveBeenCalledWith('[external-email]');
  });

  it('calls Salesforce cleanup handler for bundled-salesforce catalogId', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    const mockRemoveSalesforce = removeSalesforceAccount as Mock;

    mockGetEntry.mockResolvedValueOnce({
      catalogId: 'bundled-salesforce',
      email: '[external-email]',
    });

    await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'Salesforce-rep');

    expect(mockRemoveSalesforce).toHaveBeenCalledWith('[external-email]');
  });

  it('calls Microsoft cleanup handler for Microsoft Mail catalogId', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    const mockRemoveMicrosoft = removeMicrosoftAccount as Mock;

    mockGetEntry.mockResolvedValueOnce({
      catalogId: 'bundled-microsoft-mail',
      email: '[external-email]',
    });

    await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'Microsoft365Mail-user');

    expect(mockRemoveMicrosoft).toHaveBeenCalledWith('[external-email]');
  });

  it('calls Microsoft cleanup handler for Microsoft SharePoint catalogId', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    const mockRemoveMicrosoft = removeMicrosoftAccount as Mock;

    mockGetEntry.mockResolvedValueOnce({
      catalogId: 'bundled-microsoft-sharepoint',
      email: '[external-email]',
    });

    await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'Microsoft365SharePoint-admin');

    expect(mockRemoveMicrosoft).toHaveBeenCalledWith('[external-email]');
  });

  it('calls Microsoft cleanup handler for all 5 Microsoft catalogIds', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    const mockRemoveMicrosoft = removeMicrosoftAccount as Mock;

    const microsoftCatalogIds = [
      'bundled-microsoft-mail',
      'bundled-microsoft-calendar',
      'bundled-microsoft-files',
      'bundled-microsoft-teams',
      'bundled-microsoft-sharepoint',
    ];

    for (const catalogId of microsoftCatalogIds) {
      mockRemoveMicrosoft.mockClear();
      mockGetEntry.mockResolvedValueOnce({
        catalogId,
        email: '[external-email]',
      });

      await removeMcpServerWithCleanup(TEST_CONFIG_PATH, `SomeServer-${catalogId}`);

      expect(mockRemoveMicrosoft).toHaveBeenCalledWith('[external-email]');
    }
  });

  it('does not call cleanup when no catalogId is present', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    const mockRemoveGoogle = removeGoogleAccount as Mock;
    const mockRemoveSlack = removeSlackWorkspace as Mock;

    mockGetEntry.mockResolvedValueOnce({
      // No catalogId
      email: 'test@example.com',
    });

    await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'SomeServer');

    expect(mockRemoveGoogle).not.toHaveBeenCalled();
    expect(mockRemoveSlack).not.toHaveBeenCalled();
  });

  it('does not call cleanup for unknown catalogId', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    const mockRemoveGoogle = removeGoogleAccount as Mock;

    mockGetEntry.mockResolvedValueOnce({
      catalogId: 'some-unknown-catalog',
      email: 'test@example.com',
    });

    await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'UnknownServer');

    expect(mockRemoveGoogle).not.toHaveBeenCalled();
  });

  it('continues removal even if cleanup handler throws', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    const mockRemoveGoogle = removeGoogleAccount as Mock;
    const mockRemoveEntry = removeMcpServerEntry as Mock;

    mockGetEntry.mockResolvedValueOnce({
      catalogId: 'bundled-google',
      email: 'test@example.com',
    });

    // Simulate cleanup failure
    mockRemoveGoogle.mockRejectedValueOnce(new Error('Network error during revocation'));

    // Should not throw - cleanup is best-effort
    const result = await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'GoogleWorkspace-test');

    // Removal should have completed successfully
    expect(result.serverName).toBe('GoogleWorkspace-test');
    expect(mockRemoveEntry).toHaveBeenCalled();
  });

  it('handles null server entry (server already removed)', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    const mockRemoveGoogle = removeGoogleAccount as Mock;

    // Server doesn't exist
    mockGetEntry.mockResolvedValueOnce(null);

    // Should not throw
    const result = await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'NonExistentServer');

    expect(result.serverName).toBe('NonExistentServer');
    expect(mockRemoveGoogle).not.toHaveBeenCalled();
  });

  it('requests drain-safe Super-MCP reconfigure after removal cleanup', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    mockGetEntry.mockResolvedValueOnce(null);

    await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'Slack-test');

    expect(reconfigureSuperMcpWithCacheRefreshAndAwaitExecution).toHaveBeenCalledWith(TEST_CONFIG_PATH, {
      context: 'mcp-server-removal:Slack-test',
    });
    expect((removeMcpServerEntry as Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (reconfigureSuperMcpWithCacheRefreshAndAwaitExecution as Mock).mock.invocationCallOrder[0],
    );
  });

  it('does not request Super-MCP reconfigure when post-cleanup is skipped', async () => {
    const mockGetEntry = getMcpServerEntry as Mock;
    mockGetEntry.mockResolvedValueOnce(null);

    await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'Slack-skip', { skipPostCleanup: true });

    expect(reconfigureSuperMcpWithCacheRefreshAndAwaitExecution).not.toHaveBeenCalled();
    expect((getMcpServerEntry as Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (removeMcpServerEntry as Mock).mock.invocationCallOrder[0],
    );
  });

  it('post-removal cleanup requests drain-safe Super-MCP reconfigure', async () => {
    await performPostRemovalCleanup(TEST_CONFIG_PATH);

    expect(reconfigureSuperMcpWithCacheRefreshAndAwaitExecution).toHaveBeenCalledWith(TEST_CONFIG_PATH, {
      context: 'mcp-post-removal-cleanup',
    });
  });

  // ---------------------------------------------------------------------------
  // Regression: connector disconnect must not block on the deferred Super-MCP
  // restart (requestRestartForConfigChangeAndAwaitExecution defers up to 30 min while agent turns
  // are active — the "Disconnecting…" spinner hang, see
  // docs/plans/260610_gworkspace-mcp-error-disconnect-hang/PLAN.md).
  // A never-resolving reconfigure promise IS the deferral simulation: the
  // agentTurnRegistry/deferral-ceiling machinery lives below this mocked seam.
  // ---------------------------------------------------------------------------
  describe('decoupling from deferred Super-MCP restart', () => {
    /** Resolves after one macrotask, i.e. after all pending microtasks drain. */
    const macrotaskSentinel = <T>(value: T): Promise<T> =>
      new Promise((resolve) => setTimeout(() => resolve(value), 0));

    it('resolves promptly while Super-MCP restart is deferred', async () => {
      (getMcpServerEntry as Mock).mockResolvedValueOnce(null);
      // Simulate restart deferred behind active agent turns: never resolves.
      (reconfigureSuperMcpWithCacheRefreshAndAwaitExecution as Mock).mockReturnValueOnce(
        new Promise<never>(() => {})
      );

      const sentinel = Symbol('removal-still-pending');
      const winner = await Promise.race([
        removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'GoogleWorkspace-deferred'),
        macrotaskSentinel(sentinel),
      ]);

      // Removal must resolve before the macrotask sentinel fires...
      expect(winner).toEqual(
        expect.objectContaining({ serverName: 'GoogleWorkspace-deferred' })
      );
      // ...and the restart must already have been requested (with the exact
      // context string the renderer's deferred-op matching exact-matches on).
      expect(reconfigureSuperMcpWithCacheRefreshAndAwaitExecution).toHaveBeenCalledWith(TEST_CONFIG_PATH, {
        context: 'mcp-server-removal:GoogleWorkspace-deferred',
      });
    });

    it('background restart failure is observed, not propagated', async () => {
      (getMcpServerEntry as Mock).mockResolvedValueOnce(null);
      (reconfigureSuperMcpWithCacheRefreshAndAwaitExecution as Mock).mockRejectedValueOnce(
        new Error('restart failed in background')
      );

      // Removal still resolves successfully — local cleanup already succeeded.
      const result = await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'Slack-bg-fail');
      expect(result.serverName).toBe('Slack-bg-fail');

      // Flush microtasks/macrotasks so the background .catch runs; vitest's
      // unhandled-rejection detection fails the run if the rejection is dropped.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          serverName: 'Slack-bg-fail',
        }),
        expect.stringContaining('reconfigure after removal failed')
      );
    });

    // F2 sync-throw guard: a future synchronous throw from the fire-and-forget
    // reconfigure must be downgraded to a warn, NOT reject the removal — local
    // cleanup already succeeded.
    it('synchronous reconfigure throw is observed, not propagated', async () => {
      (getMcpServerEntry as Mock).mockResolvedValueOnce(null);
      (reconfigureSuperMcpWithCacheRefreshAndAwaitExecution as Mock).mockImplementationOnce(() => {
        throw new Error('sync throw before promise');
      });

      const result = await removeMcpServerWithCleanup(TEST_CONFIG_PATH, 'Slack-sync-fail');
      expect(result.serverName).toBe('Slack-sync-fail');

      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          serverName: 'Slack-sync-fail',
        }),
        expect.stringContaining('reconfigure after removal failed')
      );
    });

    it('performPostRemovalCleanup resolves promptly while Super-MCP restart is deferred', async () => {
      (reconfigureSuperMcpWithCacheRefreshAndAwaitExecution as Mock).mockReturnValueOnce(
        new Promise<never>(() => {})
      );

      const sentinel = Symbol('cleanup-still-pending');
      const done = Symbol('cleanup-resolved');
      const winner = await Promise.race([
        performPostRemovalCleanup(TEST_CONFIG_PATH).then(() => done),
        macrotaskSentinel(sentinel),
      ]);

      expect(winner).toBe(done);
      expect(reconfigureSuperMcpWithCacheRefreshAndAwaitExecution).toHaveBeenCalledWith(TEST_CONFIG_PATH, {
        context: 'mcp-post-removal-cleanup',
      });
    });

    // F3: mirrors "background restart failure is observed, not propagated" for
    // the batch path's post-cleanup chokepoint.
    it('removal clears the latch even while the Super-MCP restart is deferred (clear is not gated behind it)', async () => {
      const slug = 'GoogleWorkspace-deferred-latch';
      (getMcpServerEntry as Mock).mockResolvedValueOnce(null);
      // Restart deferred behind active agent turns: never settles.
      (reconfigureSuperMcpWithCacheRefreshAndAwaitExecution as Mock).mockReturnValueOnce(
        new Promise<never>(() => {})
      );
      oauthRefreshFailureStore.recordFailure(slug, 'invalid_grant', Date.now(), { provider: 'google' });

      await removeMcpServerWithCleanup(TEST_CONFIG_PATH, slug);

      expect(oauthRefreshFailureStore.getStateForSlug(slug)).toBeNull();
    });

    it('performPostRemovalCleanup background restart failure is observed, not propagated', async () => {
      (reconfigureSuperMcpWithCacheRefreshAndAwaitExecution as Mock).mockRejectedValueOnce(
        new Error('restart failed in background')
      );

      // Post-cleanup still resolves — the restart stays best-effort.
      await expect(performPostRemovalCleanup(TEST_CONFIG_PATH)).resolves.toBeUndefined();

      // Flush so the background .catch runs; vitest's unhandled-rejection
      // detection fails the run if the rejection is dropped.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          configPath: TEST_CONFIG_PATH,
        }),
        expect.stringContaining('reconfigure after post-removal cleanup failed')
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Stage 2 (260611_calendar-cache-attention): the removal chokepoint must clear
  // the persisted OAuth needs-reconnect latch for the removed server, so the
  // latch structurally cannot outlive its account ([RS-F8]; clearForSlug had
  // zero production callers — Greg's-machine bug).
  // ---------------------------------------------------------------------------
  describe('OAuth refresh latch clearing on removal', () => {
    const LATCHED_SLUG = 'GoogleWorkspace-gone-account';

    function seedLatch(slug: string): void {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const now = Date.now();
      oauthRefreshFailureStore.recordFailure(slug, 'invalid_grant', now, { provider: 'google' });
      oauthRefreshFailureStore.recordFailure(slug, 'invalid_grant', now + 1000, { provider: 'google' });
      oauthRefreshFailureStore.recordFailure(slug, 'invalid_grant', now + 2000, { provider: 'google' });
      expect(oauthRefreshFailureStore.getStateForSlug(slug)?.needsReconnect).toBe(true);
    }

    it('clears the persisted needs-reconnect latch for the removed server', async () => {
      seedLatch(LATCHED_SLUG);
      (getMcpServerEntry as Mock).mockResolvedValueOnce({
        catalogId: 'bundled-google',
        email: 'gone@example.com',
      });

      await removeMcpServerWithCleanup(TEST_CONFIG_PATH, LATCHED_SLUG);

      expect(oauthRefreshFailureStore.getStateForSlug(LATCHED_SLUG)).toBeNull();
    });

    it('clears the latch even when the server entry is already gone (idempotent removal)', async () => {
      seedLatch(LATCHED_SLUG);
      (getMcpServerEntry as Mock).mockResolvedValueOnce(null);

      await removeMcpServerWithCleanup(TEST_CONFIG_PATH, LATCHED_SLUG);

      expect(oauthRefreshFailureStore.getStateForSlug(LATCHED_SLUG)).toBeNull();
    });

    it('does not touch latches of other servers', async () => {
      seedLatch('GoogleWorkspace-other-account');
      (getMcpServerEntry as Mock).mockResolvedValueOnce(null);

      await removeMcpServerWithCleanup(TEST_CONFIG_PATH, LATCHED_SLUG);

      expect(oauthRefreshFailureStore.getStateForSlug('GoogleWorkspace-other-account')).not.toBeNull();
    });

    it('warns (count/provider only — never the slug) when the latch clear write is swallowed', async () => {
      seedLatch(LATCHED_SLUG);
      (getMcpServerEntry as Mock).mockResolvedValueOnce(null);
      inMemoryStores.failWrites = true;

      await removeMcpServerWithCleanup(TEST_CONFIG_PATH, LATCHED_SLUG);

      const latchWarnCalls = loggerMock.warn.mock.calls.filter(
        ([, msg]) => typeof msg === 'string' && msg.includes('latch'),
      );
      expect(latchWarnCalls).toHaveLength(1);
      // Privacy: the slug (slugified email) must not appear anywhere in the warn.
      expect(JSON.stringify(latchWarnCalls[0])).not.toContain(LATCHED_SLUG);
      expect(JSON.stringify(latchWarnCalls[0])).not.toContain('gone-account');
    });
  });
});
