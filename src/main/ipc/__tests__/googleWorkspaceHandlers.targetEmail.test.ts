/**
 * Stage 3 [GPT-F2] (260611_calendar-cache-attention): account-targeted
 * reconnect — `google-workspace:start-auth` accepts an optional
 * `{ targetEmail }` request and passes it through to `startGoogleAuth`,
 * whose target-scoping (incl. mismatched-callback rejection) pre-exists in
 * `googleWorkspaceAuthService`.
 *
 * Red→green: the pre-Stage-3 handler ignores the request payload entirely, so
 * the pass-through test fails.
 *
 * Mock idiom mirrors googleWorkspaceHandlers.latchClear.test.ts.
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

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-userdata-gw-target-email') },
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

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn((opts: { name: string; defaults: Record<string, unknown> }) => {
    const state: Record<string, unknown> = JSON.parse(JSON.stringify(opts.defaults ?? {}));
    return {
      get: (key: string) => state[key],
      set: (key: string, value: unknown) => {
        state[key] = value;
      },
      has: (key: string) => Object.prototype.hasOwnProperty.call(state, key),
      delete: (key: string) => {
        delete state[key];
      },
      clear: () => undefined,
      get store() {
        return state;
      },
      set store(_value: Record<string, unknown>) {
        /* noop */
      },
      path: `/tmp/${opts.name}.json`,
    };
  }),
}));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn);
  },
}));

const startGoogleAuthMock = vi.hoisted(() => vi.fn(async () => 'alice@example.com'));
vi.mock('../../services/googleWorkspaceAuthService', () => ({
  startGoogleAuth: startGoogleAuthMock,
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

vi.mock('../../services/mcpService', () => ({
  resolveMcpConfigPath: vi.fn(() => '/tmp/mcp-config.json'),
  reconfigureSuperMcpWithCacheRefreshAndAwaitExecution: vi.fn(),
  reconfigureSuperMcpWithCacheRefreshDetached: vi.fn(),
  reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral: vi.fn(async () => ({ queued: false })),
}));

import { registerGoogleWorkspaceHandlers } from '../googleWorkspaceHandlers';

describe('google-workspace:start-auth — targetEmail pass-through (Stage 3 [GPT-F2])', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    startGoogleAuthMock.mockImplementation(async () => 'alice@example.com');
    registerGoogleWorkspaceHandlers();
  });

  it('passes targetEmail through to startGoogleAuth for account-scoped reconnect', async () => {
    const handler = handlers.get('google-workspace:start-auth');
    expect(handler).toBeDefined();

    const result = await handler!(null, { targetEmail: 'alice@example.com' });

    expect(result).toEqual({ success: true, email: 'alice@example.com' });
    expect(startGoogleAuthMock).toHaveBeenCalledWith(
      'cid',
      'cs',
      expect.objectContaining({ targetEmail: 'alice@example.com' }),
    );
  });

  it('no-arg invocation keeps working (back-compat for existing startAuth() callers)', async () => {
    const handler = handlers.get('google-workspace:start-auth');

    const result = await handler!(null);

    expect(result).toEqual({ success: true, email: 'alice@example.com' });
    expect(startGoogleAuthMock).toHaveBeenCalledTimes(1);
    const optionsArg = (startGoogleAuthMock.mock.calls[0] as unknown[])[2] as
      | { targetEmail?: string }
      | undefined;
    expect(optionsArg?.targetEmail).toBeUndefined();
  });

  it('propagates a target-mismatch rejection from the auth service as a failed result', async () => {
    startGoogleAuthMock.mockRejectedValueOnce(
      new Error('Authenticated Google account did not match the requested account'),
    );
    const handler = handlers.get('google-workspace:start-auth');

    const result = await handler!(null, { targetEmail: 'alice@example.com' });

    expect(result).toEqual({
      success: false,
      error: 'Authenticated Google account did not match the requested account',
    });
  });
});
