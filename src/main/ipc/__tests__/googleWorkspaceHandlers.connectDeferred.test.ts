/**
 * Stage 4 (260610_gworkspace-mcp-error-disconnect-hang): the
 * `google-workspace:start-auth` connect IPC must not block its response on a
 * Super-MCP restart that the scheduler defers while agent turns are active
 * (up to 30 min) — the connect leg of the disconnect-hang class. The handler
 * now calls `reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral`, which
 * resolves `{ queued: true }` promptly on deferral while keeping the idle
 * path's await-until-executed semantics.
 *
 * Red→green: against the pre-Stage-4 handler (which awaits the plain
 * `reconfigureSuperMcpWithCacheRefresh`), the never-settling legacy mock below
 * pins the IPC and the race sentinel wins.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test.
// ---------------------------------------------------------------------------

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

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-userdata-gw') },
}));

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn(async () => undefined),
    lstat: vi.fn(async () => ({ isSymbolicLink: () => false })),
    chmod: vi.fn(async () => undefined),
    readFile: vi.fn(async () => '{"refresh_token":"r"}'),
  },
}));

vi.mock('@core/utils/atomicCredentialWrite', () => ({
  atomicCredentialWrite: vi.fn(async () => undefined),
}));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn);
  },
}));

vi.mock('../../services/googleWorkspaceAuthService', () => ({
  startGoogleAuth: vi.fn(async () => 'alice@example.com'),
  removeGoogleAccount: vi.fn(),
  cancelGoogleAuth: vi.fn(),
  revokeGoogleToken: vi.fn(),
}));

vi.mock('../../services/oauthCredentials', () => ({
  resolveOAuthCredentials: vi.fn(() => ({ clientId: 'cid', clientSecret: 'cs' })),
  googleCredentialSource: {},
}));

vi.mock('@core/services/oauthConnectorSetup', () => ({
  describeMissingOAuthCredentials: vi.fn(() => ({ message: 'missing creds' })),
}));

vi.mock('../../settingsStore', () => ({
  getSettings: vi.fn(() => ({})),
}));

vi.mock('../../services/mcpConfigManager', () => ({
  upsertMcpServerEntry: vi.fn(async () => ({ backupPath: null })),
  removeMcpServerEntry: vi.fn(async () => undefined),
  getMcpServerNames: vi.fn(async () => []),
}));

vi.mock('../../services/mcpServerRemovalService', () => ({
  removeMcpServerWithCleanup: vi.fn(),
}));

vi.mock('../../services/bundledMcpManager', () => ({
  generateInstanceId: (base: string, email: string) =>
    `${base}-${email.replace(/[^a-zA-Z0-9]/g, '-')}`,
  buildGoogleWorkspaceInstancePayload: vi.fn(() => ({ name: 'GoogleWorkspace-alice-example-com' })),
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

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------
import { registerGoogleWorkspaceHandlers } from '../googleWorkspaceHandlers';

const PENDING_SENTINEL = Symbol('ipc-still-pending');

async function raceAgainstMacrotask<T>(promise: Promise<T> | T): Promise<T | typeof PENDING_SENTINEL> {
  return Promise.race([
    Promise.resolve(promise),
    new Promise<typeof PENDING_SENTINEL>((resolve) => setTimeout(() => resolve(PENDING_SENTINEL), 0)),
  ]);
}

describe('google-workspace:start-auth — deferred Super-MCP restart decoupling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    // The production hang shape: a restart deferred behind active turns never
    // settles within the IPC's lifetime. If the handler regresses to awaiting
    // the execution form, the race sentinel wins (red).
    mockReconfigureLegacy.mockReturnValue(new Promise<never>(() => {}));
    mockReconfigureResolvingOnDeferral.mockResolvedValue({ queued: true });
    registerGoogleWorkspaceHandlers();
  });

  it('resolves promptly with success while the restart is deferred (queued)', async () => {
    const handler = handlers.get('google-workspace:start-auth');
    expect(handler).toBeDefined();

    const winner = await raceAgainstMacrotask(handler!(null));

    expect(winner).toEqual({ success: true, email: 'alice@example.com' });
    // Context string must stay byte-identical — the renderer's deferred-op
    // matching exact-matches on it (literal on purpose; guards constant drift).
    expect(mockReconfigureResolvingOnDeferral).toHaveBeenCalledWith(
      '/tmp/mcp-config.json',
      { context: 'google-workspace-connect' },
    );
    // Diagnosability: the queued flag is logged (the marker that cracked the
    // original bug's log timeline).
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ queued: true }),
      expect.stringContaining('reconfigure'),
    );
  });

  it('still succeeds when the idle-path reconfigure fails (existing non-fatal warn-catch preserved)', async () => {
    mockReconfigureResolvingOnDeferral.mockRejectedValueOnce(new Error('idle restart failed'));

    const handler = handlers.get('google-workspace:start-auth');
    const result = await handler!(null);

    expect(result).toEqual({ success: true, email: 'alice@example.com' });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to hot-reload Super-MCP (restart may be needed)',
    );
  });
});
