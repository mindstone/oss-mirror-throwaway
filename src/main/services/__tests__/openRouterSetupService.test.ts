/**
 * Tests for setupOpenRouterToken — the OAuth completion handler.
 *
 * Specifically guards the fresh-install vs. existing-user vs. legacy-Anthropic
 * branching introduced in 260511 (see
 * docs/plans/260511_openrouter_oauth_active_provider_fix.md).
 *
 * Previously, the OAuth handler defaulted `activeProvider` to `'anthropic'`
 * when `currentSettings.activeProvider` was undefined, which on a fresh install
 * persisted the broken state `activeProvider: 'anthropic'` + no Anthropic key.
 * The renderer-side auto-select effects were supposed to repair this, but they
 * only fire when the relevant component is mounted at the right moment.
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@shared/types';

type MockLoopbackRequest = { method?: string; url?: string };
type MockLoopbackResponse = {
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};
type MockLoopbackHandler = (
  req: MockLoopbackRequest,
  res: MockLoopbackResponse,
) => void;
type MockLoopbackServer = {
  handler: MockLoopbackHandler;
  listen: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

// ─── Mocks (must precede the SUT import) ────────────────────────────
// vi.mock() needed here for Electron APIs, settingsStore (main-process side
// effects on import), and OAuth primitives that touch shell.openExternal.

const mockGetSettings = vi.fn();
const mockUpdateSettings = vi.fn();
const mockSaveOpenRouterTokens = vi.fn();
const mockOpenExternal = vi.fn().mockResolvedValue(undefined);
const mockApplyOrProfileSourceMigration = vi.fn();
const mockElectronApp = vi.hoisted(() => ({ isPackaged: true }));
const mockGetAvailablePort = vi.hoisted(() => vi.fn(async () => 31_337));
const mockHttp = vi.hoisted(() => {
  const state = {
    latestHandler: null as null | MockLoopbackHandler,
    servers: [] as MockLoopbackServer[],
  };

  const createServer = vi.fn((handler: MockLoopbackHandler) => {
    state.latestHandler = handler;
    const server = {
      handler,
      listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
        callback?.();
        return server;
      }),
      on: vi.fn(() => server),
      close: vi.fn((callback?: (err?: Error & { code?: string }) => void) => {
        callback?.();
        return server;
      }),
    };
    state.servers.push(server);
    return server;
  });

  return { createServer, state };
});

 
vi.mock('electron', () => ({
  app: mockElectronApp,
  shell: { openExternal: (...args: unknown[]) => mockOpenExternal(...args) },
}));

vi.mock('node:http', () => ({
  default: { createServer: mockHttp.createServer },
  createServer: mockHttp.createServer,
}));

vi.mock('../../utils/systemUtils', () => ({
  getAvailablePort: mockGetAvailablePort,
}));

 
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
}));

 
vi.mock('../../settingsStore', () => ({
  updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
  applyOpenRouterProfileSourceMigration: (...args: unknown[]) =>
    mockApplyOrProfileSourceMigration(...args),
}));

 
vi.mock('../openRouterTokenStorage', () => ({
  saveOpenRouterTokens: (...args: unknown[]) => mockSaveOpenRouterTokens(...args),
  clearOpenRouterTokens: vi.fn(),
}));

 
vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: vi.fn(), sendToFocusedWindow: vi.fn() }),
}));

 
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  }),
}));

 
vi.mock('../oauthPrimitives', () => ({
  bringAppToForeground: vi.fn(),
  generateCsrfState: vi.fn(() => 'csrf-state-fixture'),
}));

 
vi.mock('../oauthTelemetry', () => ({
  trackOAuthBrowserOpened: vi.fn(),
}));

// Mock fetch for the code-exchange step.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  setupOpenRouterToken,
  handleOpenRouterDeepLinkCallback,
  cancelOpenRouterSetup,
} from '../openRouterSetupService';
import {
  OR_DEFAULT_BTS_MODEL,
  OR_DEFAULT_THINKING_MODEL,
  OR_DEFAULT_WORKING_MODEL,
} from '@shared/utils/openRouterDefaults';

/**
 * Helper: drive the full OAuth flow to completion by invoking the deep-link
 * callback after `setupOpenRouterToken()` has set up its pending-auth state.
 * Returns the promise so callers can await the final outcome.
 */
function runOAuthHappyPath(returnedApiKey = 'fake-or-fresh-key'): Promise<ReturnType<typeof setupOpenRouterToken>> {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ key: returnedApiKey }),
  });

  const setupPromise = setupOpenRouterToken();

  // Allow the synchronous setup to register pending auth before we fire the callback.
  return new Promise((resolve) => {
    setImmediate(() => {
      void handleOpenRouterDeepLinkCallback(
        'mindstone://openrouter/callback?code=auth-code-fixture&state=csrf-state-fixture',
      ).then(() => resolve(setupPromise));
    });
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

async function readOpenedOpenRouterAuthUrl(): Promise<{
  workerUrl: URL;
  authUrl: URL;
  callbackUrl: URL;
  callbackUrlRaw: string;
}> {
  await vi.waitFor(() => {
    expect(mockOpenExternal).toHaveBeenCalledTimes(1);
  });

  const workerUrl = new URL(mockOpenExternal.mock.calls[0][0] as string);
  const redirectRaw = workerUrl.searchParams.get('redirect');
  if (!redirectRaw) {
    throw new Error('Expected worker start URL to contain redirect param');
  }

  const authUrl = new URL(redirectRaw);
  const callbackUrlRaw = authUrl.searchParams.get('callback_url');
  if (!callbackUrlRaw) {
    throw new Error('Expected OpenRouter auth URL to contain callback_url param');
  }

  return {
    workerUrl,
    authUrl,
    callbackUrl: new URL(callbackUrlRaw),
    callbackUrlRaw,
  };
}

function invokeLoopbackCallback(
  callbackUrl: URL,
  server = mockHttp.state.servers.at(-1),
): number {
  if (!server) {
    throw new Error('Expected loopback callback handler to be registered');
  }

  let status = 0;
  const res: MockLoopbackResponse = {
    writeHead: vi.fn((nextStatus: number) => {
      status = nextStatus;
      return res;
    }),
    end: vi.fn(),
  };

  server.handler(
    { method: 'GET', url: `${callbackUrl.pathname}${callbackUrl.search}` },
    res,
  );
  return status;
}

function existingCodexSettings(): Partial<AppSettings> {
  return {
    activeProvider: 'codex',
    claude: { apiKey: null } as unknown as AppSettings['claude'],
    models: { apiKey: null } as unknown as AppSettings['models'],
    openRouter: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mockElectronApp.isPackaged = true;
  mockGetAvailablePort.mockResolvedValue(31_337);
  mockHttp.state.latestHandler = null;
  mockHttp.state.servers.length = 0;
  // Default: migration is a no-op (version already stamped). Tests that exercise
  // the legacy-profile backfill path override this with a stamp-producing return.
  mockApplyOrProfileSourceMigration.mockImplementation((settings: AppSettings) => ({
    migrated: settings,
    stamped: 0,
  }));
});

afterEach(() => {
  cancelOpenRouterSetup();
  vi.unstubAllEnvs();
});

describe('setupOpenRouterToken — redirect URI resolution', () => {
  async function startSetupAndReadWorkerUrl(): Promise<URL> {
    const setupPromise = setupOpenRouterToken();
    setupPromise.catch(() => undefined);

    const { workerUrl } = await readOpenedOpenRouterAuthUrl();
    cancelOpenRouterSetup();
    await expect(setupPromise).resolves.toEqual({ outcome: 'cancelled' });
    return workerUrl;
  }

  it('uses the Rebel-hosted redirect and start URLs by default', async () => {
    const workerUrl = await startSetupAndReadWorkerUrl();
    const redirectUrl = new URL(workerUrl.searchParams.get('redirect') ?? '');

    expect(workerUrl.origin + workerUrl.pathname).toBe(
      'https://rebel-auth.mindstone.com/openrouter/start',
    );
    expect(redirectUrl.searchParams.get('callback_url')).toBe(
      'https://rebel-auth.mindstone.com/openrouter/callback?state=csrf-state-fixture',
    );
  });

  it('uses OPENROUTER_REDIRECT_URI and OPENROUTER_AUTH_START_URL when configured', async () => {
    vi.stubEnv('OPENROUTER_REDIRECT_URI', 'https://example.test/openrouter/callback');
    vi.stubEnv('OPENROUTER_AUTH_START_URL', 'https://example.test/openrouter/start');

    const workerUrl = await startSetupAndReadWorkerUrl();
    const redirectUrl = new URL(workerUrl.searchParams.get('redirect') ?? '');

    expect(workerUrl.origin + workerUrl.pathname).toBe('https://example.test/openrouter/start');
    expect(redirectUrl.searchParams.get('callback_url')).toBe(
      'https://example.test/openrouter/callback?state=csrf-state-fixture',
    );
  });
});

describe('setupOpenRouterToken — callback transport', () => {
  it('uses a loopback callback in dev mode and saves the exchanged token', async () => {
    mockElectronApp.isPackaged = false;
    mockGetSettings.mockReturnValue(existingCodexSettings());
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ key: 'fake-or-loopback-key' }),
    });

    const setupPromise = setupOpenRouterToken();
    const { workerUrl, authUrl, callbackUrl, callbackUrlRaw } =
      await readOpenedOpenRouterAuthUrl();

    expect(workerUrl.origin + workerUrl.pathname).toBe(
      'https://rebel-auth.mindstone.com/openrouter/start',
    );
    expect(authUrl.origin + authUrl.pathname).toBe('https://openrouter.ai/auth');
    expect(callbackUrl.protocol).toBe('http:');
    expect(callbackUrl.hostname).toBe('127.0.0.1');
    expect(callbackUrl.pathname).toBe('/callback');
    expect(callbackUrl.port).toMatch(/^\d+$/);
    expect(callbackUrl.searchParams.get('state')).toBe('csrf-state-fixture');
    expect(callbackUrlRaw).not.toContain('mindstone://');
    expect(callbackUrlRaw).not.toContain('rebel-auth.mindstone.com/openrouter/callback');

    callbackUrl.searchParams.set('code', 'auth-code-fixture');
    expect(invokeLoopbackCallback(callbackUrl)).toBe(200);

    await expect(setupPromise).resolves.toEqual({
      outcome: 'success',
      maskedKey: 'fake-or-****-key',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/auth/keys');
    const exchangeInit = mockFetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(exchangeInit.body))).toMatchObject({
      code: 'auth-code-fixture',
      code_challenge_method: 'S256',
    });
    expect(mockSaveOpenRouterTokens).toHaveBeenCalledWith({
      apiKey: 'fake-or-loopback-key',
    });
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
    expect((mockUpdateSettings.mock.calls[0][0] as Partial<AppSettings>).openRouter?.oauthToken)
      .toBe('fake-or-loopback-key');
  });

  it('keeps packaged builds on the worker deep-link callback and completes via deep link', async () => {
    mockElectronApp.isPackaged = true;
    mockGetSettings.mockReturnValue(existingCodexSettings());
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ key: 'fake-or-packaged-key' }),
    });

    const setupPromise = setupOpenRouterToken();
    const { callbackUrlRaw } = await readOpenedOpenRouterAuthUrl();

    expect(callbackUrlRaw).toBe(
      'https://rebel-auth.mindstone.com/openrouter/callback?state=csrf-state-fixture',
    );
    expect(mockGetAvailablePort).not.toHaveBeenCalled();
    expect(mockHttp.createServer).not.toHaveBeenCalled();

    await handleOpenRouterDeepLinkCallback(
      'mindstone://openrouter/callback?code=auth-code-fixture&state=csrf-state-fixture',
    );

    await expect(setupPromise).resolves.toEqual({
      outcome: 'success',
      maskedKey: 'fake-or-****-key',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockSaveOpenRouterTokens).toHaveBeenCalledWith({
      apiKey: 'fake-or-packaged-key',
    });
  });

  it('rejects loopback callbacks with mismatched CSRF state before exchanging', async () => {
    mockElectronApp.isPackaged = false;
    mockGetSettings.mockReturnValue(existingCodexSettings());

    const setupPromise = setupOpenRouterToken();
    const { callbackUrl } = await readOpenedOpenRouterAuthUrl();

    callbackUrl.searchParams.set('state', 'wrong-state');
    callbackUrl.searchParams.set('code', 'auth-code-fixture');
    expect(invokeLoopbackCallback(callbackUrl)).toBe(400);

    await expect(setupPromise).resolves.toEqual({
      outcome: 'error',
      error: 'OAuth state mismatch - possible CSRF attack',
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSaveOpenRouterTokens).not.toHaveBeenCalled();
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it('closes the loopback server when setup is cancelled', async () => {
    mockElectronApp.isPackaged = false;

    const setupPromise = setupOpenRouterToken();
    await readOpenedOpenRouterAuthUrl();

    const server = mockHttp.state.servers[0];
    expect(server).toBeDefined();

    cancelOpenRouterSetup();

    await expect(setupPromise).resolves.toEqual({ outcome: 'cancelled' });
    expect(server.close).toHaveBeenCalled();
  });

  it('cancels a loopback setup during the port probe without creating a server', async () => {
    mockElectronApp.isPackaged = false;
    const portProbe = deferred<number>();
    mockGetAvailablePort.mockReturnValueOnce(portProbe.promise);

    const setupPromise = setupOpenRouterToken();
    await vi.waitFor(() => {
      expect(mockGetAvailablePort).toHaveBeenCalledTimes(1);
    });

    cancelOpenRouterSetup();
    portProbe.resolve(31_337);

    await expect(setupPromise).resolves.toEqual({ outcome: 'cancelled' });
    expect(mockHttp.createServer).not.toHaveBeenCalled();
    expect(mockHttp.state.servers).toHaveLength(0);
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('lets only the newest overlapping loopback setup complete after deferred port probes resolve', async () => {
    mockElectronApp.isPackaged = false;
    mockGetSettings.mockReturnValue(existingCodexSettings());
    const firstPortProbe = deferred<number>();
    const secondPortProbe = deferred<number>();
    mockGetAvailablePort
      .mockReturnValueOnce(firstPortProbe.promise)
      .mockReturnValueOnce(secondPortProbe.promise);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ key: 'fake-or-second-key' }),
    });

    const firstSetupPromise = setupOpenRouterToken();
    await vi.waitFor(() => {
      expect(mockGetAvailablePort).toHaveBeenCalledTimes(1);
    });

    const secondSetupPromise = setupOpenRouterToken();
    await vi.waitFor(() => {
      expect(mockGetAvailablePort).toHaveBeenCalledTimes(2);
    });

    firstPortProbe.resolve(31_337);
    await expect(firstSetupPromise).resolves.toEqual({ outcome: 'cancelled' });
    expect(mockHttp.createServer).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSaveOpenRouterTokens).not.toHaveBeenCalled();

    secondPortProbe.resolve(31_338);
    const { callbackUrl } = await readOpenedOpenRouterAuthUrl();
    expect(callbackUrl.port).toBe('31338');
    callbackUrl.searchParams.set('code', 'auth-code-second');
    expect(invokeLoopbackCallback(callbackUrl)).toBe(200);

    await expect(secondSetupPromise).resolves.toEqual({
      outcome: 'success',
      maskedKey: 'fake-or-****-key',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const exchangeInit = mockFetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(exchangeInit.body))).toMatchObject({
      code: 'auth-code-second',
    });
    expect(mockSaveOpenRouterTokens).toHaveBeenCalledTimes(1);
    expect(mockSaveOpenRouterTokens).toHaveBeenCalledWith({
      apiKey: 'fake-or-second-key',
    });
  });

  it('uses loopback in packaged mode when OPENROUTER_CALLBACK_MODE=loopback', async () => {
    mockElectronApp.isPackaged = true;
    vi.stubEnv('OPENROUTER_CALLBACK_MODE', 'loopback');

    const setupPromise = setupOpenRouterToken();
    const { callbackUrl, callbackUrlRaw } = await readOpenedOpenRouterAuthUrl();

    expect(callbackUrl.protocol).toBe('http:');
    expect(callbackUrl.hostname).toBe('127.0.0.1');
    expect(callbackUrlRaw).not.toContain('mindstone://');
    expect(mockGetAvailablePort).toHaveBeenCalledTimes(1);
    expect(mockHttp.createServer).toHaveBeenCalledTimes(1);

    cancelOpenRouterSetup();
    await expect(setupPromise).resolves.toEqual({ outcome: 'cancelled' });
  });

  it('uses deep link in dev mode when OPENROUTER_CALLBACK_MODE=deeplink', async () => {
    mockElectronApp.isPackaged = false;
    vi.stubEnv('OPENROUTER_CALLBACK_MODE', 'deeplink');

    const setupPromise = setupOpenRouterToken();
    const { callbackUrlRaw } = await readOpenedOpenRouterAuthUrl();

    expect(callbackUrlRaw).toBe(
      'https://rebel-auth.mindstone.com/openrouter/callback?state=csrf-state-fixture',
    );
    expect(mockGetAvailablePort).not.toHaveBeenCalled();
    expect(mockHttp.createServer).not.toHaveBeenCalled();

    cancelOpenRouterSetup();
    await expect(setupPromise).resolves.toEqual({ outcome: 'cancelled' });
  });
});

describe('setupOpenRouterToken — provider selection on OAuth success', () => {
  it('genuine fresh user (no activeProvider, no Anthropic key) → applies OR model defaults atomically', async () => {
    const freshSettings: Partial<AppSettings> = {
      activeProvider: undefined,
      claude: { apiKey: null } as unknown as AppSettings['claude'],
      models: { apiKey: null } as unknown as AppSettings['models'],
      openRouter: undefined,
    };
    mockGetSettings.mockReturnValue(freshSettings);

    const result = await runOAuthHappyPath();

    expect(result.outcome).toBe('success');
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
    const written = mockUpdateSettings.mock.calls[0][0] as Partial<AppSettings>;

    expect(written.activeProvider).toBe('openrouter');
    expect(written.models?.model).toBe(OR_DEFAULT_WORKING_MODEL);
    expect(written.models?.thinkingModel).toBe(OR_DEFAULT_THINKING_MODEL);
    expect(written.behindTheScenesModel).toBe(OR_DEFAULT_BTS_MODEL);
    expect(written.openRouter?.enabled).toBe(true);
    expect(written.openRouter?.oauthToken).toBe('fake-or-fresh-key');
  });

  it('legacy Anthropic-only user (no activeProvider, but claude.apiKey present) → preserves Anthropic, does NOT clobber models', async () => {
    const legacySettings: Partial<AppSettings> = {
      activeProvider: undefined,
      claude: {
        apiKey: 'fake-ant-real-key',
        model: 'claude-sonnet-4-6',
      } as unknown as AppSettings['claude'],
      models: {
        apiKey: 'fake-ant-real-key',
        model: 'claude-sonnet-4-6',
      } as unknown as AppSettings['models'],
      openRouter: undefined,
    };
    mockGetSettings.mockReturnValue(legacySettings);

    const result = await runOAuthHappyPath();

    expect(result.outcome).toBe('success');
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
    const written = mockUpdateSettings.mock.calls[0][0] as Partial<AppSettings>;

    // Legacy preserve: activeProvider falls back to 'anthropic' (the prior
    // behavior). Model fields must NOT be touched — the user keeps their setup.
    expect(written.activeProvider).toBe('anthropic');
    expect(written.models).toBeUndefined();
    expect(written.behindTheScenesModel).toBeUndefined();
    expect(written.openRouter?.oauthToken).toBe('fake-or-fresh-key');
    expect(written.openRouter?.enabled).toBe(true);
  });

  it('existing Codex user → preserves Codex, only stores OR token', async () => {
    const codexSettings: Partial<AppSettings> = {
      activeProvider: 'codex',
      claude: { apiKey: null } as unknown as AppSettings['claude'],
      models: { apiKey: null } as unknown as AppSettings['models'],
      openRouter: undefined,
    };
    mockGetSettings.mockReturnValue(codexSettings);

    const result = await runOAuthHappyPath();

    expect(result.outcome).toBe('success');
    const written = mockUpdateSettings.mock.calls[0][0] as Partial<AppSettings>;

    expect(written.activeProvider).toBe('codex');
    expect(written.models).toBeUndefined();
    expect(written.openRouter?.oauthToken).toBe('fake-or-fresh-key');
  });

  it('existing OpenRouter user reconnecting → preserves OpenRouter selection', async () => {
    const orSettings: Partial<AppSettings> = {
      activeProvider: 'openrouter',
      claude: { apiKey: null } as unknown as AppSettings['claude'],
      models: { apiKey: null } as unknown as AppSettings['models'],
      openRouter: {
        enabled: true,
        oauthToken: 'fake-or-old-key',
        selectedModel: 'openai/gpt-5.5',
      },
    };
    mockGetSettings.mockReturnValue(orSettings);

    const result = await runOAuthHappyPath('fake-or-new-key');

    expect(result.outcome).toBe('success');
    const written = mockUpdateSettings.mock.calls[0][0] as Partial<AppSettings>;

    expect(written.activeProvider).toBe('openrouter');
    expect(written.openRouter?.oauthToken).toBe('fake-or-new-key');
  });
});

/**
 * REBEL-5D4 closing-the-window guard: customers whose boot migration deferred
 * (no `openRouterProfileSourceMigrationVersion` stamp) get unstuck the moment
 * they re-authenticate, without waiting for the next app restart. See
 * `docs-private/postmortems/260513_openrouter_oauth_profile_resolver_missing_credentials_postmortem.md`.
 */
describe('setupOpenRouterToken — post-save profileSource backfill', () => {
  const angusShapeSettings: Partial<AppSettings> = {
    activeProvider: 'openrouter',
    claude: { apiKey: null } as unknown as AppSettings['claude'],
    models: { apiKey: null } as unknown as AppSettings['models'],
    openRouter: {
      enabled: true,
      oauthToken: 'fake-or-old-key',
      selectedModel: 'openai/gpt-5.5',
    },
    localModel: {
      activeProfileId: null,
      profiles: [
        {
          id: 'profile-legacy-or',
          name: 'OpenRouter / GPT-5.5',
          providerType: 'openrouter',
          routeSurface: 'pool',
          serverUrl: 'https://openrouter.ai/api/v1',
          model: 'openai/gpt-5.5',
          createdAt: 1_700_000_000_000,
        },
      ],
    },
  };

  it('re-runs the migration after OAuth save and persists stamped profiles', async () => {
    mockGetSettings.mockReturnValue(angusShapeSettings);

    // Migration stamps the one legacy profile.
    mockApplyOrProfileSourceMigration.mockReturnValueOnce({
      migrated: {
        ...angusShapeSettings,
        openRouterProfileSourceMigrationVersion: 1,
        localModel: {
          activeProfileId: null,
          profiles: [
            {
              ...angusShapeSettings.localModel!.profiles![0],
              profileSource: 'connection',
            },
          ],
        },
      },
      stamped: 1,
    });

    const result = await runOAuthHappyPath('fake-or-new-key');

    expect(result.outcome).toBe('success');
    expect(mockApplyOrProfileSourceMigration).toHaveBeenCalledTimes(1);
    expect(mockUpdateSettings).toHaveBeenCalledTimes(2);

    const backfillCall = mockUpdateSettings.mock.calls[1][0] as Partial<AppSettings>;
    expect(backfillCall.openRouterProfileSourceMigrationVersion).toBe(1);
    expect(backfillCall.localModel?.profiles?.[0]?.profileSource).toBe('connection');
  });

  it('no-ops when migration version is already stamped (idempotent)', async () => {
    mockGetSettings.mockReturnValue({
      ...angusShapeSettings,
      openRouterProfileSourceMigrationVersion: 1,
    });

    // Migration returns no changes — version already stamped, profiles already migrated.
    mockApplyOrProfileSourceMigration.mockReturnValueOnce({
      migrated: { ...angusShapeSettings, openRouterProfileSourceMigrationVersion: 1 },
      stamped: 0,
    });

    const result = await runOAuthHappyPath('fake-or-new-key');

    expect(result.outcome).toBe('success');
    expect(mockApplyOrProfileSourceMigration).toHaveBeenCalledTimes(1);
    // Only the OAuth-save write — no backfill follow-up.
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
  });

  it('persists version bump even when no profiles needed stamping (e.g. zero eligible profiles after first OAuth)', async () => {
    mockGetSettings.mockReturnValue(angusShapeSettings);

    // Migration stamps version but finds no eligible profiles to update.
    mockApplyOrProfileSourceMigration.mockReturnValueOnce({
      migrated: {
        ...angusShapeSettings,
        openRouterProfileSourceMigrationVersion: 1,
      },
      stamped: 0,
    });

    const result = await runOAuthHappyPath('fake-or-new-key');

    expect(result.outcome).toBe('success');
    expect(mockUpdateSettings).toHaveBeenCalledTimes(2);
    const backfillCall = mockUpdateSettings.mock.calls[1][0] as Partial<AppSettings>;
    expect(backfillCall.openRouterProfileSourceMigrationVersion).toBe(1);
    expect(backfillCall.localModel).toBeUndefined();
  });

  it('swallows migration errors and still reports OAuth success', async () => {
    mockGetSettings.mockReturnValue(angusShapeSettings);
    mockApplyOrProfileSourceMigration.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const result = await runOAuthHappyPath('fake-or-new-key');

    // OAuth save itself succeeds — the boot migration retry remains as a safety
    // net so a backfill failure must not regress the primary OAuth flow.
    expect(result.outcome).toBe('success');
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
  });
});
