/**
 * Stage 2 (260611_calendar-cache-attention): `google-workspace:start-auth`
 * SUCCESS must clear the persisted OAuth needs-reconnect latch for the
 * (re)connected instance immediately — instead of waiting up to 15 min for the
 * valid-token-path `recordSuccess` backstop. A FAILED start-auth must NOT
 * clear: a failed reauth attempt must not green the panel while the token is
 * still dead [RS-F10].
 *
 * Red→green: against the pre-Stage-2 handler (zero `clearForSlug` callers),
 * the success-path test fails — the latch survives a successful reconnect.
 *
 * Mock idiom mirrors googleWorkspaceHandlers.connectDeferred.test.ts, plus an
 * in-memory `@core/storeFactory` so the REAL oauthRefreshFailureStore is
 * exercised end-to-end.
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

const inMemoryStores = vi.hoisted(() => ({
  stateByName: {} as Record<string, Record<string, unknown>>,
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
      set store(value: Record<string, unknown>) { inMemoryStores.stateByName[opts.name] = value; },
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

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------
import { registerGoogleWorkspaceHandlers } from '../googleWorkspaceHandlers';
import * as oauthRefreshFailureStore from '../../services/oauthRefreshFailureStore';

const INSTANCE_SLUG = 'GoogleWorkspace-alice-example-com';

function seedLatch(slug: string): void {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const now = Date.now();
  oauthRefreshFailureStore.recordFailure(slug, 'invalid_grant', now, { provider: 'google' });
  oauthRefreshFailureStore.recordFailure(slug, 'invalid_grant', now + 1000, { provider: 'google' });
  oauthRefreshFailureStore.recordFailure(slug, 'invalid_grant', now + 2000, { provider: 'google' });
  expect(oauthRefreshFailureStore.getStateForSlug(slug)?.needsReconnect).toBe(true);
}

describe('google-workspace:start-auth — OAuth refresh latch lifecycle (Stage 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    for (const key of Object.keys(inMemoryStores.stateByName)) {
      delete inMemoryStores.stateByName[key];
    }
    startGoogleAuthMock.mockImplementation(async () => 'alice@example.com');
    registerGoogleWorkspaceHandlers();
  });

  it('clears the persisted needs-reconnect latch on connect success', async () => {
    seedLatch(INSTANCE_SLUG);

    const handler = handlers.get('google-workspace:start-auth');
    expect(handler).toBeDefined();
    const result = await handler!(null);

    expect(result).toEqual({ success: true, email: 'alice@example.com' });
    expect(oauthRefreshFailureStore.getStateForSlug(INSTANCE_SLUG)).toBeNull();
  });

  it('leaves an existing latch untouched when start-auth fails before instance creation [RS-F10]', async () => {
    seedLatch(INSTANCE_SLUG);
    startGoogleAuthMock.mockRejectedValueOnce(new Error('OAuth window dismissed'));

    const handler = handlers.get('google-workspace:start-auth');
    const result = await handler!(null);

    expect(result).toEqual({ success: false, error: 'OAuth window dismissed' });
    // A failed reauth attempt must not green the panel: latch stays.
    expect(oauthRefreshFailureStore.getStateForSlug(INSTANCE_SLUG)?.needsReconnect).toBe(true);
  });

  it('does not touch latches of other instances on connect success', async () => {
    seedLatch('GoogleWorkspace-bob-example-com');

    const handler = handlers.get('google-workspace:start-auth');
    await handler!(null);

    expect(
      oauthRefreshFailureStore.getStateForSlug('GoogleWorkspace-bob-example-com')?.needsReconnect,
    ).toBe(true);
  });
});
