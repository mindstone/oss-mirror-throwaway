/**
 * Stage 4 (260610_gworkspace-mcp-error-disconnect-hang): leaner connect-leg
 * decoupling coverage for `slack:start-auth` and `discourse:start-auth` —
 * prompt IPC resolution while the Super-MCP restart is deferred, byte-identical
 * context strings. Full shape + rationale in
 * `googleWorkspaceHandlers.connectDeferred.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  logger: loggerMock,
  createScopedLogger: vi.fn(() => loggerMock),
}));

// Slack handlers use the typed registerHandler util; Discourse uses ipcMain.
const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn);
  },
}));
const mockIpcHandlers: Record<string, (...args: unknown[]) => unknown> = {};
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mockIpcHandlers[channel] = handler;
    },
  },
}));

vi.mock('../../services/slackAuthService', () => ({
  getSlackWorkspaces: vi.fn(async () => []),
  getSlackTokensForWorkspace: vi.fn(async () => ({ botToken: 'xoxb-test', userToken: 'xoxp-test' })),
  getSlackConfigDir: vi.fn(() => '/tmp/slack-mcp'),
  startSlackAuth: vi.fn(() => ({
    completion: Promise.resolve({ teamId: 'T123', teamName: 'mindstone' }),
  })),
  removeSlackWorkspace: vi.fn(),
  cancelSlackAuth: vi.fn(),
}));

vi.mock('../../services/discourseAuthService', () => ({
  startDiscourseAuth: vi.fn(() => ({
    completion: Promise.resolve({ username: 'greg' }),
  })),
  cancelDiscourseAuth: vi.fn(),
}));

vi.mock('../../services/oauthCredentials', () => ({
  resolveOAuthCredentials: vi.fn(() => ({ clientId: 'cid', clientSecret: 'cs' })),
  slackCredentialSource: {},
}));

vi.mock('@core/services/oauthConnectorSetup', () => ({
  describeMissingOAuthCredentials: vi.fn(() => ({ message: 'missing creds' })),
}));

vi.mock('../../services/mcpConfigManager', () => ({
  upsertMcpServerEntry: vi.fn(async () => ({ backupPath: null })),
  removeMcpServerEntry: vi.fn(async () => undefined),
}));

vi.mock('../../services/mcpServerRemovalService', () => ({
  removeMcpServerWithCleanup: vi.fn(),
}));

vi.mock('../../services/bundledMcpManager', () => ({
  buildSlackInstancePayload: vi.fn(() => ({ name: 'Slack-mindstone' })),
  buildDiscourseWritePayload: vi.fn(() => ({ name: 'DiscourseWrite' })),
}));

vi.mock('../../services/slackWorkspaceNotifier', () => ({
  notifySlackWorkspaceConnected: vi.fn(),
}));

const mockReconfigureLegacy = vi.fn();
const mockReconfigureResolvingOnDeferral = vi.fn();
vi.mock('../../services/mcpService', () => ({
  resolveMcpConfigPath: vi.fn(() => '/tmp/mcp-config.json'),
  reconfigureSuperMcpWithCacheRefreshAndAwaitExecution: (...args: unknown[]) => mockReconfigureLegacy(...args),
  reconfigureSuperMcpWithCacheRefreshDetached: vi.fn(),
  reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral: (...args: unknown[]) =>
    mockReconfigureResolvingOnDeferral(...args),
}));

vi.mock('../../settingsStore', () => ({
  getSettings: vi.fn(() => ({})),
}));

import { registerSlackHandlers } from '../slackHandlers';
import { registerDiscourseHandlers } from '../discourseHandlers';

const PENDING_SENTINEL = Symbol('ipc-still-pending');

async function raceAgainstMacrotask<T>(promise: Promise<T> | T): Promise<T | typeof PENDING_SENTINEL> {
  return Promise.race([
    Promise.resolve(promise),
    new Promise<typeof PENDING_SENTINEL>((resolve) => setTimeout(() => resolve(PENDING_SENTINEL), 0)),
  ]);
}

describe('slack/discourse connect handlers — deferred Super-MCP restart decoupling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    for (const channel of Object.keys(mockIpcHandlers)) {
      delete mockIpcHandlers[channel];
    }
    mockReconfigureLegacy.mockReturnValue(new Promise<never>(() => {}));
    mockReconfigureResolvingOnDeferral.mockResolvedValue({ queued: true });
    registerSlackHandlers();
    registerDiscourseHandlers();
  });

  it('slack:start-auth resolves promptly with success while the restart is deferred (queued)', async () => {
    const handler = handlers.get('slack:start-auth');
    expect(handler).toBeDefined();

    const winner = await raceAgainstMacrotask(handler!(null));

    expect(winner).toEqual({ success: true, teamName: 'mindstone' });
    // Byte-identical context (literal on purpose; guards constant drift).
    expect(mockReconfigureResolvingOnDeferral).toHaveBeenCalledWith(
      '/tmp/mcp-config.json',
      { context: 'slack-connect' },
    );
  });

  it('discourse:start-auth resolves promptly with success while the restart is deferred (queued)', async () => {
    const handler = mockIpcHandlers['discourse:start-auth'];
    expect(handler).toBeDefined();

    const winner = await raceAgainstMacrotask(handler());

    expect(winner).toEqual({ success: true, username: 'greg' });
    expect(mockReconfigureResolvingOnDeferral).toHaveBeenCalledWith(
      '/tmp/mcp-config.json',
      { context: 'discourse-connect' },
    );
  });
});
