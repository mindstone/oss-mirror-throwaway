/**
 * Regression (260610 API split): the Slack connect IPC must not block on the
 * deferred Super-MCP restart.
 *
 * The restart after a config change is drain-safe: it defers (up to 30 min)
 * while agent turns are active, and its promise resolves only when the
 * restart actually EXECUTES. Awaiting it from `slack:start-auth` pinned the
 * user-facing connect flow on that deferral — the connect leg of the 260610
 * connector-disconnect hang class (see
 * docs-private/postmortems/260610_connector_disconnect_deferred_restart_ipc_hang_postmortem.md).
 *
 * The mocked execution-awaiting reconfigure NEVER resolves, so a revert that
 * reintroduces `await reconfigureSuperMcpWithCacheRefresh...` turns the race
 * below red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
  ) => {
    registeredHandlers.set(channel, handler);
  },
}));

vi.mock('../../services/slackAuthService', () => ({
  getSlackWorkspaces: vi.fn(async () => []),
  getSlackTokensForWorkspace: vi.fn(async () => ({ botToken: 'xoxb-test-token', userToken: undefined })),
  getSlackConfigDir: vi.fn(() => '/tmp/slack'),
  startSlackAuth: vi.fn(() => ({
    completion: Promise.resolve({ teamId: 'T123', teamName: 'Mindstone' }),
  })),
  removeSlackWorkspace: vi.fn(),
  cancelSlackAuth: vi.fn(),
}));

vi.mock('../../services/oauthCredentials', () => ({
  resolveOAuthCredentials: vi.fn(() => ({ clientId: 'slack-client-id', clientSecret: 'slack-client-secret' })),
  slackCredentialSource: {},
}));

vi.mock('../../services/mcpConfigManager', () => ({
  upsertMcpServerEntry: vi.fn(),
  removeMcpServerEntry: vi.fn(),
}));

vi.mock('../../services/mcpServerRemovalService', () => ({
  removeMcpServerWithCleanup: vi.fn(),
}));

vi.mock('../../services/bundledMcpManager', () => ({
  buildSlackInstancePayload: vi.fn(() => ({ name: 'Slack-Mindstone' })),
}));

vi.mock('../../services/mcpService', () => ({
  resolveMcpConfigPath: vi.fn(() => '/tmp/slack-connect-test/mcp.json'),
  // Merge synthesis: connect sites use the resolve-on-deferral form, NOT
  // Detached — the deferred path resolves { queued: true } promptly while the
  // idle path preserves "connect succeeded => tools usable".
  reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral: vi.fn(async () => ({ queued: true })),
  // Never resolves: simulates the restart deferred behind active agent turns.
  reconfigureSuperMcpWithCacheRefreshAndAwaitExecution: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock('../../services/slackWorkspaceNotifier', () => ({
  notifySlackWorkspaceConnected: vi.fn(),
}));

vi.mock('../../settingsStore', () => ({
  getSettings: vi.fn(() => ({})),
}));

import { registerSlackHandlers } from '../slackHandlers';
import { reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral } from '../../services/mcpService';
import { notifySlackWorkspaceConnected } from '../../services/slackWorkspaceNotifier';

describe('slack:start-auth under a deferred Super-MCP restart', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    vi.clearAllMocks();
    registerSlackHandlers();
  });

  it('resolves promptly while the Super-MCP restart is deferred', async () => {
    const handler = registeredHandlers.get('slack:start-auth');
    expect(handler).toBeDefined();

    const sentinel = Symbol('connect-still-pending');
    const winner = await Promise.race([
      handler?.(null),
      // Macrotask fires only after all pending microtasks drain.
      new Promise((resolve) => setTimeout(() => resolve(sentinel), 0)),
    ]);

    expect(winner).toEqual({ success: true, teamName: 'Mindstone' });
    // The restart went through the resolve-on-deferral form with the exact
    // context string (renderer deferred-op matching + launchRebel gate).
    expect(reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral).toHaveBeenCalledWith(
      '/tmp/slack-connect-test/mcp.json',
      expect.objectContaining({ context: 'slack-connect' }),
    );
    expect(notifySlackWorkspaceConnected).toHaveBeenCalledWith('T123', 'Mindstone');
  });
});
