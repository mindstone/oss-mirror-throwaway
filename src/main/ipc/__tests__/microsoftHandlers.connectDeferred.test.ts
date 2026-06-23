/**
 * Stage 4 (260610_gworkspace-mcp-error-disconnect-hang): `microsoft:start-auth`
 * and `microsoft:start-auth-sharepoint` must not block their IPC responses on
 * a Super-MCP restart deferred behind active agent turns. Mirrors
 * `googleWorkspaceHandlers.connectDeferred.test.ts` (full rationale there).
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

const mockIpcHandlers: Record<string, (...args: unknown[]) => unknown> = {};
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mockIpcHandlers[channel] = handler;
    },
  },
}));

vi.mock('../../services/microsoftAuthService', () => ({
  getMicrosoftAccounts: vi.fn(async () => [{ email: 'alice@example.com', status: 'active' }]),
  getMicrosoftConfigDir: vi.fn(() => '/tmp/microsoft-mcp'),
  startMicrosoftAuth: vi.fn(async () => 'alice@example.com'),
  removeMicrosoftAccount: vi.fn(),
  cancelMicrosoftAuth: vi.fn(),
  isMicrosoftConnected: vi.fn(async () => true),
  getExtraScopesForAccount: vi.fn(async () => []),
  MICROSOFT_SHAREPOINT_SCOPES: ['Sites.Read.All'],
}));

vi.mock('../../services/oauthCredentials', () => ({
  resolveMicrosoftClientId: vi.fn(() => 'ms-client-id'),
  microsoftCredentialSource: {},
}));

vi.mock('@core/services/oauthConnectorSetup', () => ({
  describeMissingOAuthCredentials: vi.fn(() => ({ message: 'missing creds' })),
}));

vi.mock('../../services/mcpConfigManager', () => ({
  getMcpServerNames: vi.fn(async () => []),
  removeMcpServerEntry: vi.fn(async () => undefined),
  upsertMcpServerEntry: vi.fn(async () => ({ backupPath: null })),
}));

vi.mock('../../services/mcpServerRemovalService', () => ({
  removeMcpServerWithCleanup: vi.fn(),
  performPostRemovalCleanup: vi.fn(),
}));

vi.mock('../../services/bundledMcpManager', () => ({
  MICROSOFT_SERVER_BASE_NAMES: [
    'Microsoft365Mail',
    'Microsoft365Calendar',
    'Microsoft365Files',
    'Microsoft365Teams',
    'Microsoft365SharePoint',
  ],
  buildMicrosoft365MailPayload: vi.fn(() => ({ name: 'Microsoft365Mail-instance' })),
  buildMicrosoft365CalendarPayload: vi.fn(() => ({ name: 'Microsoft365Calendar-instance' })),
  buildMicrosoft365FilesPayload: vi.fn(() => ({ name: 'Microsoft365Files-instance' })),
  buildMicrosoft365TeamsPayload: vi.fn(() => ({ name: 'Microsoft365Teams-instance' })),
  buildMicrosoft365SharePointPayload: vi.fn(() => ({ name: 'Microsoft365SharePoint-instance' })),
}));

vi.mock('@shared/utils/mcpInstanceUtils', () => ({
  generateInstanceId: (base: string, email: string) =>
    `${base}-${email.replace(/[^a-zA-Z0-9]/g, '-')}`,
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

import { registerMicrosoftHandlers } from '../microsoftHandlers';

const PENDING_SENTINEL = Symbol('ipc-still-pending');

async function raceAgainstMacrotask<T>(promise: Promise<T> | T): Promise<T | typeof PENDING_SENTINEL> {
  return Promise.race([
    Promise.resolve(promise),
    new Promise<typeof PENDING_SENTINEL>((resolve) => setTimeout(() => resolve(PENDING_SENTINEL), 0)),
  ]);
}

describe('microsoft connect handlers — deferred Super-MCP restart decoupling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const channel of Object.keys(mockIpcHandlers)) {
      delete mockIpcHandlers[channel];
    }
    mockReconfigureLegacy.mockReturnValue(new Promise<never>(() => {}));
    mockReconfigureResolvingOnDeferral.mockResolvedValue({ queued: true });
    registerMicrosoftHandlers();
  });

  it('microsoft:start-auth resolves promptly with success while the restart is deferred (queued)', async () => {
    const handler = mockIpcHandlers['microsoft:start-auth'];
    expect(handler).toBeDefined();

    const winner = await raceAgainstMacrotask(handler());

    expect(winner).toEqual({ success: true, email: 'alice@example.com' });
    // Byte-identical context (literal on purpose; guards constant drift).
    expect(mockReconfigureResolvingOnDeferral).toHaveBeenCalledWith(
      '/tmp/mcp-config.json',
      { context: 'microsoft-connect' },
    );
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ queued: true }),
      expect.stringContaining('reconfigure'),
    );
  });

  it('microsoft:start-auth-sharepoint resolves promptly with success while the restart is deferred (queued)', async () => {
    const handler = mockIpcHandlers['microsoft:start-auth-sharepoint'];
    expect(handler).toBeDefined();

    const winner = await raceAgainstMacrotask(handler());

    expect(winner).toEqual({ success: true, email: 'alice@example.com' });
    expect(mockReconfigureResolvingOnDeferral).toHaveBeenCalledWith(
      '/tmp/mcp-config.json',
      { context: 'microsoft-sharepoint-connect' },
    );
  });

  it('microsoft:start-auth still succeeds when the idle-path reconfigure fails (non-fatal warn-catch preserved)', async () => {
    mockReconfigureResolvingOnDeferral.mockRejectedValueOnce(new Error('idle restart failed'));

    const handler = mockIpcHandlers['microsoft:start-auth'];
    const result = await handler();

    expect(result).toEqual({ success: true, email: 'alice@example.com' });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to hot-reload Super-MCP (restart may be needed)',
    );
  });
});
