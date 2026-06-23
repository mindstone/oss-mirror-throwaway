/**
 * Tests for managed cloud (Mindstone Cloud) handler logic in cloudHandlers.ts.
 *
 * Verifies:
 * - Managed lifecycle guards reject self-service operations
 * - Managed provision requires session token
 * - Managed deprovision requires session token
 * - BYOK flows are unaffected by managed guards
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppSettings } from '@shared/types';
import { logger } from '@core/logger';

// ---------------------------------------------------------------------------
// Capture registered handlers so we can invoke them directly
// ---------------------------------------------------------------------------
const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('@core/handlerRegistry', () => ({
  getHandlerRegistry: () => ({
    register: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  }),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

const mockPlatformConfig = vi.hoisted(() => ({
  isOss: false,
}));
vi.mock('@core/platform', () => ({
  getPlatformConfig: () => mockPlatformConfig,
}));

vi.mock('../../services/authTokenStorage', () => ({
  loadSessionToken: () => null,
}));

const mockGetAccessToken = vi.fn<() => Promise<string | null>>();
vi.mock('@core/services/mindstoneApiUrl', () => ({
  MINDSTONE_API_URL: 'https://test.rebel.mindstone.com',
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
      getAuthState: vi.fn(() => ({ isAuthenticated: false, user: null, isLoading: false })),
      onAuthStateChange: vi.fn(() => () => {}),
      invalidateAccessToken: vi.fn(),
      initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
      setPostLoginCallback: vi.fn(),
      getCachedAuthConfig: vi.fn(() => null),
      requestAuthConfigRefresh: vi.fn(async () => {}),
      refreshLicenseTier: vi.fn(async () => 'free'),
      clearCachedProviderKey: vi.fn(),
      getSharedDriveConfig: vi.fn(() => null),
      getSubscriptionState: vi.fn(() => null),
      getManagedAllowanceResetsAt: vi.fn(() => undefined),
      getAccessToken: () => mockGetAccessToken(),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));


const mockCloudReconciler = vi.hoisted(() => ({
  reconcile: vi.fn(),
  reportSuccess: vi.fn(),
  reportFailure: vi.fn(),
}));
vi.mock('../../services/cloud/cloudConnectionReconcilerSingleton', () => ({
  cloudConnectionReconciler: mockCloudReconciler,
}));

const mockBroadcastService = vi.hoisted(() => ({
  sendToAllWindows: vi.fn(),
  sendToFocusedWindow: vi.fn(),
}));
vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ getBroadcastService: () => mockBroadcastService });
});

const mockFlyApiClient = vi.hoisted(() => ({
  allocateSharedIpv4: vi.fn(),
  getMachineState: vi.fn(),
  destroyMachine: vi.fn(),
  createMachine: vi.fn(),
  waitForMachineState: vi.fn(),
}));
vi.mock('@core/services/flyApiClient', () => mockFlyApiClient);

// Mock Fly provisioning to prevent network I/O in BYOK tests
vi.mock('@core/services/flyProvisioningService', () => ({
  lookupFlyInstance: vi.fn().mockResolvedValue({ success: false, error: 'mocked' }),
}));

// ---------------------------------------------------------------------------
// Mocks for cloud:switch-provider tests
// ---------------------------------------------------------------------------
const mockSyncNow = vi.fn();
vi.mock('../../services/cloud/cloudRouter', () => ({
  cloudRouter: { syncNow: (...args: unknown[]) => mockSyncNow(...args) },
}));

const mockMigrateToCloud = vi.fn();
vi.mock('../../services/cloud/cloudMigrationService', () => ({
  migrateToCloud: (...args: unknown[]) => mockMigrateToCloud(...args),
}));

const mockProviderDeprovision = vi.fn();
const mockGetCloudProviderOrDefault = vi.fn();
vi.mock('@core/services/cloud/providers', () => ({
  getCloudProviderOrDefault: (...args: unknown[]) => mockGetCloudProviderOrDefault(...args),
}));

const mockLoadFlyApiToken = vi.fn<() => string | null>();
const mockClearFlyApiToken = vi.fn();
const mockSaveFlyApiToken = vi.fn();
vi.mock('../../services/flyTokenStorage', () => ({
  loadFlyApiToken: () => mockLoadFlyApiToken(),
  clearFlyApiToken: () => mockClearFlyApiToken(),
  saveFlyApiToken: (token: string) => mockSaveFlyApiToken(token),
}));

const mockLoadProviderToken = vi.fn<(providerId: string) => string | null>();
const mockClearProviderToken = vi.fn();
const mockSaveProviderToken = vi.fn();
vi.mock('../../services/providerTokenStorage', () => ({
  loadProviderToken: (providerId: string) => mockLoadProviderToken(providerId),
  clearProviderToken: (providerId: string) => mockClearProviderToken(providerId),
  saveProviderToken: (providerId: string, token: string) => mockSaveProviderToken(providerId, token),
}));

vi.mock('../../services/digitalOceanAuthService', () => ({
  getValidDigitalOceanToken: vi.fn().mockResolvedValue(null),
  startDigitalOceanOAuth: vi.fn(),
  getDigitalOceanOAuthStatus: vi.fn().mockResolvedValue({ connected: false }),
  disconnectDigitalOceanOAuth: vi.fn(),
}));

vi.mock('../../services/cloud/cloudOutbox', () => ({
  cloudOutbox: {
    clearAll: vi.fn(),
    getStatus: vi.fn().mockReturnValue({ pending: 0, failed: 0 }),
  },
}));

// Spy on cloud instance discovery so the reattach↔destroy race test can supply
// a controllable promise, while every other test (e.g. cloud:discover-instances)
// keeps the REAL discovery behavior via the actual-module default.
const mockDiscoverCloudInstances = vi.fn();
vi.mock('@core/services/cloud/cloudInstanceDiscovery', async (importActual) => {
  const actual = await importActual<typeof import('@core/services/cloud/cloudInstanceDiscovery')>();
  return {
    ...actual,
    discoverCloudInstances: (...args: unknown[]) => mockDiscoverCloudInstances(...args),
  };
});

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------
let settings: Partial<AppSettings>;
const getSettings = () => settings as AppSettings;
const updateSettings = vi.fn((patch: Partial<AppSettings>) => {
  Object.assign(settings, patch);
});

function managedCloudInstance(): Partial<AppSettings['cloudInstance']> {
  return {
    mode: 'cloud',
    cloudUrl: 'https://test-app.fly.dev',
    cloudToken: 'test-token',
    providerId: 'mindstone',
    provisionMode: 'managed',
    flyAppName: 'test-app',
  };
}

function byokCloudInstance(): Partial<AppSettings['cloudInstance']> {
  return {
    mode: 'cloud',
    cloudUrl: 'https://byok-app.fly.dev',
    cloudToken: 'byok-token',
    providerId: 'fly',
    provisionMode: 'byok',
    flyAppName: 'byok-app',
    flyMachineId: 'mach-123',
  };
}

// ---------------------------------------------------------------------------
// Register handlers once
// ---------------------------------------------------------------------------
beforeEach(async () => {
  handlers.clear();
  settings = {};
  mockPlatformConfig.isOss = false;
  updateSettings.mockClear();
  mockGetAccessToken.mockReset();
  mockCloudReconciler.reconcile.mockReset();
  mockCloudReconciler.reportSuccess.mockReset().mockResolvedValue(undefined);
  mockCloudReconciler.reportFailure.mockReset().mockResolvedValue(undefined);
  mockBroadcastService.sendToAllWindows.mockReset();
  // Default: delegate to the REAL discovery (race test overrides per-case).
  const { discoverCloudInstances: realDiscover } = await vi.importActual<
    typeof import('@core/services/cloud/cloudInstanceDiscovery')
  >('@core/services/cloud/cloudInstanceDiscovery');
  mockDiscoverCloudInstances.mockReset().mockImplementation((...args: unknown[]) =>
    (realDiscover as (...a: unknown[]) => unknown)(...args),
  );
  Object.values(mockFlyApiClient).forEach((mock) => mock.mockReset());

  const cloudHandlersModule = await import('../cloudHandlers');
  cloudHandlersModule.registerCloudHandlers({ getSettings, updateSettings });
  // Collapse the real 3s managed-update poll interval to 0 for the suite. The
  // apply-update + pollManagedUpdateCompletion tests otherwise real-wait 3s per
  // inter-poll gap (~27s of this file's runtime). Only the wall-clock delay is
  // shortened — every assertion, poll count, and terminal-state branch is
  // unchanged. The deadline-driven timeout tests still terminate via timeoutMs,
  // not the interval, so they remain correct.
  cloudHandlersModule._setManagedPollIntervalMsForTests(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function invoke(channel: string, ...args: unknown[]) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(null, ...args);
}

// ---------------------------------------------------------------------------
// Managed lifecycle guards
// ---------------------------------------------------------------------------
describe('managed lifecycle guards', () => {
  // Each channel paired with a contract-valid request payload (or `undefined`
  // for `void`-request channels) so the suite-wide contract-parse seam admits
  // the request before the managed guard short-circuits.
  const guardedChannels: Array<{ channel: string; request: unknown[] }> = [
    { channel: 'cloud:link-fly-token', request: [{ flyApiToken: 'test', appName: 'app' }] },
    { channel: 'cloud:repair-ingress', request: [] },
    { channel: 'cloud:repair-token', request: [{}] },
    { channel: 'cloud:repair-machine', request: [] },
  ];

  for (const { channel, request } of guardedChannels) {
    it(`${channel} rejects managed instances`, async () => {
      settings = { cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'] };

      const result = await invoke(channel, ...request) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/managed/i);
    });
  }

  it('cloud:check-update returns health-only response for managed', async () => {
    // Mock fetch for health endpoint
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '1.2.3', buildCommit: 'abc', uptime: 3600 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    settings = { cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'] };
    const result = await invoke('cloud:check-update', {}) as { success: boolean; updateAvailable: boolean; runningVersion?: string };

    expect(result.success).toBe(true);
    expect(result.updateAvailable).toBe(false);
    expect(result.runningVersion).toBe('1.2.3');

  });
});

// ---------------------------------------------------------------------------
// Managed provision
// ---------------------------------------------------------------------------
describe('cloud:provision (managed)', () => {
  it('rejects when not signed in', async () => {
    mockGetAccessToken.mockResolvedValue(null);

    const result = await invoke('cloud:provision', { providerId: 'mindstone' }) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sign/i);
  });

  it('provisions successfully and stores managed config', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');

    const mockFetch = vi.fn()
      // Provision POST — returns only flyAppName (no cloudUrl/cloudToken per eb741af contract)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          flyAppName: 'managed-app',
        }),
      })
      // Status poll — returns active with credentials
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          exists: true,
          status: 'active',
          phase: 'complete',
          progress: 100,
          cloudUrl: 'https://managed-app.fly.dev',
          cloudToken: 'cloud-token-abc',
        }),
      });
    vi.stubGlobal('fetch', mockFetch);

    settings = { cloudUpdateChannel: 'beta' };
    const result = await invoke('cloud:provision', { providerId: 'mindstone' }) as { success: boolean; cloudUrl?: string; appName?: string };

    expect(result.success).toBe(true);
    expect(result.cloudUrl).toBe('https://managed-app.fly.dev');
    expect(result.appName).toBe('managed-app');
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      cloudInstance: expect.objectContaining({
        provisionMode: 'managed',
        providerId: 'mindstone',
        cloudUrl: 'https://managed-app.fly.dev',
        cloudToken: 'cloud-token-abc',
      }),
    }));

    // Verify channel is forwarded in the provision request body
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.rebel.mindstone.com/api/cloud/managed/provision',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"channel":"beta"'),
      }),
    );

  });

  it('times out when status poll never reaches terminal state', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');

    // Use fake timers to avoid waiting 180s
    vi.useFakeTimers();

    const mockFetch = vi.fn().mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            flyAppName: 'managed-app',
          }),
        });
      }
      // Status poll always returns non-terminal state — simulates laggy server
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ exists: true, phase: 'waiting', progress: 50, status: 'provisioning' }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    settings = {};
    const provisionPromise = invoke('cloud:provision', { providerId: 'mindstone' });

    // Advance past the 180s deadline
    await vi.advanceTimersByTimeAsync(200_000);

    const result = await provisionPromise as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);

    vi.useRealTimers();
  });

  it('handles server error gracefully with JSON error body', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');

    // extractErrorMessage reads .text() first, then JSON.parse
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      text: () => Promise.resolve(JSON.stringify({ success: false, error: 'Instance already exists or is being provisioned' })),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await invoke('cloud:provision', { providerId: 'mindstone' }) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Instance already exists or is being provisioned');
  });

  it('handles server error with plain text fallback', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');

    // Simulate a real Response where body is plain text (not JSON).
    // extractErrorMessage reads .text() first, then tries JSON.parse.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      text: () => Promise.resolve('Service temporarily unavailable'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await invoke('cloud:provision', { providerId: 'mindstone' }) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('temporarily unavailable');
  });

  it('treats active status without credentials as error', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, flyAppName: 'managed-app' }),
      })
      // Status returns active but missing cloudUrl/cloudToken
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'active', phase: 'complete', progress: 100 }),
      });
    vi.stubGlobal('fetch', mockFetch);

    settings = {};
    const result = await invoke('cloud:provision', { providerId: 'mindstone' }) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/credentials.*missing/i);
  });

  it('treats deprovisioning status during provision as immediate failure', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, flyAppName: 'managed-app' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'deprovisioning' }),
      });
    vi.stubGlobal('fetch', mockFetch);

    settings = {};
    const result = await invoke('cloud:provision', { providerId: 'mindstone' }) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/deprovisioning/i);
  });

  it('treats destroyed status during provision as immediate failure', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, flyAppName: 'managed-app' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'destroyed' }),
      });
    vi.stubGlobal('fetch', mockFetch);

    settings = {};
    const result = await invoke('cloud:provision', { providerId: 'mindstone' }) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/destroyed/i);
  });

  it('handles error status from poll with error message', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, flyAppName: 'managed-app' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          exists: true,
          status: 'error',
          phase: 'failed',
          progress: 0,
          error: 'Health check failed — instance did not become healthy within timeout',
        }),
      });
    vi.stubGlobal('fetch', mockFetch);

    settings = {};
    const result = await invoke('cloud:provision', { providerId: 'mindstone' }) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('Health check failed');
  });
});

// ---------------------------------------------------------------------------
// OSS managed-cloud cut
// ---------------------------------------------------------------------------
describe('OSS managed-cloud cut', () => {
  function expectLoggedOssRefusal(warnSpy: ReturnType<typeof vi.spyOn>, operation: string) {
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        operation,
        code: 'managed_cloud_unavailable_in_oss',
      }),
      'Managed cloud operation refused in OSS build',
    );
  }

  it('refuses managed provisioning with a logged structured error and no managed fetch', async () => {
    mockPlatformConfig.isOss = true;
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await invoke('cloud:provision', { providerId: 'mindstone' }) as { success: boolean; error?: string };

    expect(result).toEqual({
      success: false,
      error: 'Mindstone Cloud is not available in the open-source build. Use your own cloud provider instead.',
    });
    expectLoggedOssRefusal(warnSpy, 'cloud:provision');
    expect(mockGetAccessToken).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses managed status with a logged structured error and no managed fetch', async () => {
    mockPlatformConfig.isOss = true;
    settings = { cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'] };
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await invoke('cloud:status') as { status: string; error?: string };

    expect(result).toEqual({
      status: 'error',
      error: 'Mindstone Cloud is not available in the open-source build. Use your own cloud provider instead.',
    });
    expectLoggedOssRefusal(warnSpy, 'cloud:status');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCloudReconciler.reportFailure).toHaveBeenCalledWith({
      writer: 'managed-status',
      rawError: expect.any(Error),
      legacyLastError: 'Mindstone Cloud is not available in the open-source build. Use your own cloud provider instead.',
    });
  });

  it('refuses switching to managed before sync or provisioning can start', async () => {
    mockPlatformConfig.isOss = true;
    settings = {
      cloudInstance: byokCloudInstance() as AppSettings['cloudInstance'],
      managedCloudEnabled: true,
    };
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await invoke('cloud:switch-provider', { targetProviderId: 'mindstone' }) as {
      success: boolean;
      error?: string;
      failedStep?: string;
    };

    expect(result).toEqual({
      success: false,
      error: 'Mindstone Cloud is not available in the open-source build. Use your own cloud provider instead.',
      failedStep: 'preflight',
    });
    expectLoggedOssRefusal(warnSpy, 'cloud:switch-provider');
    expect(mockSyncNow).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips the managed discovery probe while keeping BYOK discovery under OSS', async () => {
    mockPlatformConfig.isOss = true;
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    settings = { cloudInstance: byokCloudInstance() as AppSettings['cloudInstance'] };
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const result = await invoke('cloud:discover-instances') as {
      managed: { exists: boolean };
      byok: { exists: boolean; healthy: boolean };
      conflict: boolean;
      activeInSettings: string;
    };

    expect(result).toMatchObject({
      managed: { exists: false },
      byok: { exists: true, healthy: true },
      conflict: false,
      activeInSettings: 'byok',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://byok-app.fly.dev/api/health',
      expect.any(Object),
    );
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/api/cloud/managed/'))).toBe(false);
  });

  it('refuses conflict resolution that would keep managed in OSS', async () => {
    mockPlatformConfig.isOss = true;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await invoke('cloud:resolve-conflict', { keep: 'managed' }) as { success: boolean; error?: string };

    expect(result).toEqual({
      success: false,
      error: 'Mindstone Cloud is not available in the open-source build. Use your own cloud provider instead.',
    });
    expectLoggedOssRefusal(warnSpy, 'cloud:resolve-conflict');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Managed deprovision
// ---------------------------------------------------------------------------
describe('cloud:deprovision (managed)', () => {
  it('rejects when not signed in', async () => {
    mockGetAccessToken.mockResolvedValue(null);
    settings = { cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:deprovision') as { kind: string; error: string };
    expect(result.kind).toBe('precondition-failed');
    expect(result.error).toMatch(/sign/i);
  });

  it('deprovisions and clears cloud config', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    settings = { cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'] };
    const result = await invoke('cloud:deprovision') as { kind: string };

    expect(result.kind).toBe('remote-removed');
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      cloudInstance: expect.objectContaining({ mode: 'local' }),
    }));

    // Verify DELETE was called with correct URL and auth
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.rebel.mindstone.com/api/cloud/managed/provision',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token-123',
        }),
      }),
    );

  });
});

// ---------------------------------------------------------------------------
// Managed reattach ↔ destroy race (C-F2): generation re-check
// ---------------------------------------------------------------------------
describe('cloud:reattach-managed vs deprovision race (C-F2)', () => {
  /**
   * Deterministic interleave: start cloud:reattach-managed and hold its
   * discovery promise open; while it awaits discovery, run a managed destroy
   * (which clears local config AND bumps the teardown generation); THEN resolve
   * discovery. The reattach must detect the generation moved and decline to
   * write `mode:'cloud'` creds at the just-destroyed instance.
   */
  it('does NOT write stale cloud creds when a destroy interleaves between discovery and write', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');

    // Manually-resolvable discovery promise to control the interleave.
    // `discoveryReached` resolves the instant the handler enters discovery —
    // proving the generation was captured BEFORE the destroy bumps it — so the
    // interleave is deterministic without microtask polling.
    let resolveDiscovery!: (value: unknown) => void;
    const discoveryGate = new Promise((resolve) => {
      resolveDiscovery = resolve;
    });
    let signalReached!: () => void;
    const discoveryReached = new Promise<void>((resolve) => {
      signalReached = resolve;
    });
    mockDiscoverCloudInstances.mockImplementation(() => {
      signalReached();
      return discoveryGate;
    });

    // DELETE for the destroy resolves success:true (so the destroy fully clears).
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    settings = { cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'] };

    // 1. Kick off reattach — it awaits getAccessToken then discovery (gated).
    const reattachPromise = invoke('cloud:reattach-managed') as Promise<{
      success: boolean;
      superseded?: boolean;
      error?: string;
    }>;

    // Wait until the reattach has progressed through the dynamic import + auth
    // and actually REACHED the gated discovery call (generation already captured).
    await discoveryReached;
    expect(mockDiscoverCloudInstances).toHaveBeenCalledTimes(1);

    // 2. Concurrent managed destroy runs to completion — clears local config and
    //    bumps the teardown generation captured by the in-flight reattach.
    const destroyResult = await invoke('cloud:deprovision', { managed: true }) as { kind: string };
    expect(destroyResult.kind).toBe('remote-removed');
    expect(settings.cloudInstance).toMatchObject({ mode: 'local' });

    // 3. Now the discovery resolves with a still-running instance + creds.
    resolveDiscovery({
      managed: {
        exists: true,
        cloudUrl: 'https://stale-instance.fly.dev',
        cloudToken: 'stale-token',
      },
      byok: { exists: false, healthy: false },
      conflict: false,
      activeInSettings: 'none',
    });

    const reattachResult = await reattachPromise;

    // The reattach must abort — no resurrection of mode:'cloud'.
    expect(reattachResult.success).toBe(false);
    expect(reattachResult.superseded).toBe(true);
    expect(reattachResult.error).toMatch(/removed while reconnecting/i);

    // Settings stay torn down — NO write of the stale cloud creds.
    expect(settings.cloudInstance).toMatchObject({ mode: 'local' });
    expect(updateSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({
        cloudInstance: expect.objectContaining({
          mode: 'cloud',
          cloudUrl: 'https://stale-instance.fly.dev',
        }),
      }),
    );
  });

  /**
   * C-F2 follow-up: `cloud:resolve-conflict { keep:'byok' }` deletes the managed
   * instance and clears settings DIRECTLY (it does not call doDeprovision's
   * managed branch). If that clear bypassed the teardown-generation bump, an
   * in-flight reattach whose discovery returns stale managed creds could write
   * `mode:'cloud'` back at the just-destroyed instance — the same TOCTOU class.
   * This proves the resolve-conflict clear ALSO bumps the generation, so the
   * interleaved reattach is superseded.
   */
  it('resolve-conflict {keep:byok} supersedes an in-flight reattach (no stale cloud write)', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');

    // Gate ONLY the reattach's discovery (the first call). The later
    // resolve-conflict discovery returns a conflict synchronously so it can
    // proceed to DELETE the managed instance + bump the generation.
    let resolveReattachDiscovery!: (value: unknown) => void;
    const reattachDiscoveryGate = new Promise((resolve) => {
      resolveReattachDiscovery = resolve;
    });
    let signalReattachReached!: () => void;
    const reattachDiscoveryReached = new Promise<void>((resolve) => {
      signalReattachReached = resolve;
    });
    let discoveryCall = 0;
    mockDiscoverCloudInstances.mockImplementation(() => {
      discoveryCall += 1;
      if (discoveryCall === 1) {
        // Reattach's discovery — held open until we trigger the conflict resolve.
        signalReattachReached();
        return reattachDiscoveryGate;
      }
      // resolve-conflict's discovery — a live managed+BYOK conflict.
      return Promise.resolve({
        managed: { exists: true, cloudUrl: 'https://managed.fly.dev', cloudToken: 'managed-token' },
        byok: { exists: true, healthy: true, cloudUrl: 'https://byok-app.fly.dev', providerId: 'fly', provisionMode: 'byok' },
        conflict: true,
        activeInSettings: 'managed',
      });
    });

    // DELETE for the managed destroy in resolve-conflict resolves success.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    settings = { cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'] };

    // 1. Kick off reattach — captures the generation, then awaits gated discovery.
    const reattachPromise = invoke('cloud:reattach-managed') as Promise<{
      success: boolean;
      superseded?: boolean;
      error?: string;
    }>;
    await reattachDiscoveryReached;
    expect(discoveryCall).toBe(1);

    // 2. Concurrent resolve-conflict {keep:'byok'} runs to completion — DELETEs
    //    the managed instance and clears settings, which MUST bump the generation.
    const resolveResult = await invoke('cloud:resolve-conflict', { keep: 'byok' }) as { success: boolean };
    expect(resolveResult.success).toBe(true);

    // 3. Now the reattach's discovery resolves with the (now-destroyed) instance.
    resolveReattachDiscovery({
      managed: { exists: true, cloudUrl: 'https://managed.fly.dev', cloudToken: 'managed-token' },
      byok: { exists: false, healthy: false },
      conflict: false,
      activeInSettings: 'none',
    });

    const reattachResult = await reattachPromise;

    // The reattach must abort — the resolve-conflict teardown bumped the generation.
    expect(reattachResult.success).toBe(false);
    expect(reattachResult.superseded).toBe(true);
    expect(reattachResult.error).toMatch(/removed while reconnecting/i);

    // No resurrection of mode:'cloud' creds at the destroyed managed instance.
    expect(updateSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({
        cloudInstance: expect.objectContaining({
          mode: 'cloud',
          cloudUrl: 'https://managed.fly.dev',
        }),
      }),
    );
  });

  it('writes creds normally when no teardown interleaves (uncontested reattach)', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');

    mockDiscoverCloudInstances.mockResolvedValue({
      managed: {
        exists: true,
        cloudUrl: 'https://recovered-instance.fly.dev',
        cloudToken: 'recovered-token',
      },
      byok: { exists: false, healthy: false },
      conflict: false,
      activeInSettings: 'none',
    });

    settings = {};
    const result = await invoke('cloud:reattach-managed') as { success: boolean; superseded?: boolean };

    expect(result.success).toBe(true);
    expect(result.superseded).toBeUndefined();
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudInstance: expect.objectContaining({
          mode: 'cloud',
          cloudUrl: 'https://recovered-instance.fly.dev',
          cloudToken: 'recovered-token',
          provisionMode: 'managed',
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// BYOK flows unaffected
// ---------------------------------------------------------------------------
describe('BYOK flows are not blocked by managed guards', () => {
  it('cloud:link-fly-token proceeds for BYOK instances', async () => {
    settings = { cloudInstance: byokCloudInstance() as AppSettings['cloudInstance'] };

    // Will fail later due to missing Fly API validation, but should NOT hit the managed guard
    const result = await invoke('cloud:link-fly-token', { flyApiToken: 'test', appName: 'byok-app' }) as { success: boolean; error?: string };
    // The error should be about Fly validation, not about managed instances
    expect(result.error).not.toMatch(/managed/i);
  });

  it('cloud:repair-ingress proceeds for BYOK instances', async () => {
    settings = { cloudInstance: byokCloudInstance() as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:repair-ingress') as { success: boolean; error?: string };
    // Should fail on Fly token loading, not managed guard
    expect(result.error).not.toMatch(/managed/i);
  });

  it.each([
    { providerId: 'fly' as const, tokenField: 'flyApiToken' as const, instanceId: 'byok-app' },
    { providerId: 'digitalocean' as const, tokenField: 'apiToken' as const, instanceId: 'droplet-123' },
    { providerId: 'hetzner' as const, tokenField: 'apiToken' as const, instanceId: 'server-123' },
  ])('keeps $providerId provision/status/deprovision working under OSS', async ({ providerId, tokenField, instanceId }) => {
    mockPlatformConfig.isOss = true;
    const provision = vi.fn().mockResolvedValue({
      success: true,
      cloudUrl: `https://${providerId}.example.test`,
      cloudToken: `${providerId}-cloud-token`,
      instanceId,
      region: 'iad',
      providerMetadata: providerId === 'fly'
        ? { appName: instanceId, machineId: 'mach-123' }
        : providerId === 'digitalocean'
          ? { dropletId: instanceId }
          : { serverId: instanceId },
    });
    const deprovision = vi.fn().mockResolvedValue({ success: true });
    mockGetCloudProviderOrDefault.mockReturnValue({
      config: { id: providerId, name: providerId },
      provision,
      deprovision,
    });
    mockLoadFlyApiToken.mockReturnValue('fly-token-123');
    mockLoadProviderToken.mockReturnValue(`${providerId}-token`);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const provisionPayload = {
      providerId,
      [tokenField]: `${providerId}-token`,
      volumeSizeGb: 10,
    };
    const provisionResult = await invoke('cloud:provision', provisionPayload) as { success: boolean; cloudUrl?: string };
    expect(provisionResult.success).toBe(true);
    expect(provisionResult.cloudUrl).toBe(`https://${providerId}.example.test`);
    expect(settings.cloudInstance).toMatchObject({
      providerId,
      provisionMode: 'byok',
      cloudUrl: `https://${providerId}.example.test`,
    });

    const statusResult = await invoke('cloud:status') as { status: string; url?: string };
    expect(statusResult).toMatchObject({
      status: 'running',
      url: `https://${providerId}.example.test`,
    });

    const deprovisionResult = await invoke('cloud:deprovision') as { kind: string };
    expect(deprovisionResult.kind).toBe('remote-removed');
    expect(deprovision).toHaveBeenCalledWith(
      providerId === 'fly' ? 'fly-token-123' : `${providerId}-token`,
      instanceId,
      expect.objectContaining({ cloudToken: `${providerId}-cloud-token` }),
    );
    expect(settings.cloudInstance).toMatchObject({ mode: 'local' });
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/api/cloud/managed/'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cloud:provision sentryDsn OSS gate (no-phone-home invariant)
//
// The DSN threaded into provisioning options feeds ALL downstream delivery
// paths: Fly machine-create config.env (flyProvider -> flyProvisioningService)
// and DO/Hetzner cloud-init docker-compose env (cloudInitTemplate). An OSS
// build — or any runtime with SENTRY_DSN exported — must never inject a DSN
// into a cloud instance; only commercial builds may.
// ---------------------------------------------------------------------------
describe('cloud:provision sentryDsn OSS gate', () => {
  const ENV_DSN = 'https://[external-email]/42';

  function mockProvisionProvider(providerId: 'fly' | 'digitalocean') {
    const provision = vi.fn().mockResolvedValue({
      success: true,
      cloudUrl: `https://${providerId}.example.test`,
      cloudToken: `${providerId}-cloud-token`,
      instanceId: 'inst-1',
      region: 'iad',
      providerMetadata: providerId === 'fly'
        ? { appName: 'inst-1', machineId: 'mach-1' }
        : { dropletId: 'inst-1' },
    });
    mockGetCloudProviderOrDefault.mockReturnValue({
      config: { id: providerId, name: providerId },
      provision,
      deprovision: vi.fn().mockResolvedValue({ success: true }),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok' }),
    }));
    return provision;
  }

  function provisionOptions(provision: ReturnType<typeof vi.fn>): { sentryDsn?: string } {
    expect(provision).toHaveBeenCalledTimes(1);
    return provision.mock.calls[0]![0] as { sentryDsn?: string };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Covers Fly machine-create env threading AND DO cloud-init threading: the
  // same handler-built options object is the single source for both.
  it.each(['fly', 'digitalocean'] as const)(
    'OSS build with SENTRY_DSN in env never threads a DSN into %s provisioning options',
    async (providerId) => {
      mockPlatformConfig.isOss = true;
      vi.stubEnv('SENTRY_DSN', ENV_DSN);
      const provision = mockProvisionProvider(providerId);

      const result = await invoke('cloud:provision', {
        providerId,
        apiToken: `${providerId}-token`,
        volumeSizeGb: 10,
      }) as { success: boolean };

      expect(result.success).toBe(true);
      expect(provisionOptions(provision).sentryDsn).toBeUndefined();
    },
  );

  it('commercial build threads the resolved env DSN into provisioning options', async () => {
    mockPlatformConfig.isOss = false;
    vi.stubEnv('SENTRY_DSN', ENV_DSN);
    const provision = mockProvisionProvider('fly');

    const result = await invoke('cloud:provision', {
      providerId: 'fly',
      apiToken: 'fly-token',
      volumeSizeGb: 10,
    }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(provisionOptions(provision).sentryDsn).toBe(ENV_DSN);
  });
});

// ---------------------------------------------------------------------------
// BYOK repair-machine flow
// ---------------------------------------------------------------------------
describe('cloud:repair-machine', () => {
  it('replaces a stuck machine and reports repair success through the reconciler', async () => {
    settings = { cloudInstance: byokCloudInstance() as AppSettings['cloudInstance'] };
    mockLoadFlyApiToken.mockReturnValue('fly-token-123');
    mockFlyApiClient.getMachineState.mockResolvedValue({
      success: true,
      machine: {
        state: 'stopped',
        region: 'iad',
        config: { image: 'registry.example/rebel:old' },
      },
    });
    mockFlyApiClient.destroyMachine.mockResolvedValue({ success: true });
    mockFlyApiClient.createMachine.mockResolvedValue({ success: true, machineId: 'mach-new' });
    mockFlyApiClient.waitForMachineState.mockResolvedValue({ success: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const result = await invoke('cloud:repair-machine') as { success: boolean; oldMachineId?: string; newMachineId?: string };

    expect(result).toEqual({ success: true, oldMachineId: 'mach-123', newMachineId: 'mach-new' });
    expect(updateSettings).toHaveBeenCalledWith({
      cloudInstance: expect.objectContaining({
        flyMachineId: 'mach-new',
      }),
    });
    expect(mockCloudReconciler.reportSuccess).toHaveBeenCalledWith({
      writer: 'repair',
      cloudUrl: 'https://byok-app.fly.dev',
    });
  });

  it('preserves repair failure text while routing failure through the reconciler', async () => {
    settings = { cloudInstance: byokCloudInstance() as AppSettings['cloudInstance'] };
    mockLoadFlyApiToken.mockReturnValue('fly-token-123');
    mockFlyApiClient.getMachineState.mockResolvedValue({
      success: true,
      machine: {
        state: 'stopped',
        region: 'iad',
        config: { image: 'registry.example/rebel:old' },
      },
    });
    mockFlyApiClient.destroyMachine.mockResolvedValue({ success: true });
    mockFlyApiClient.createMachine.mockResolvedValue({ success: false, error: 'quota exceeded' });

    const result = await invoke('cloud:repair-machine') as { success: boolean; error?: string; oldMachineId?: string };

    expect(result).toEqual({
      success: false,
      oldMachineId: 'mach-123',
      error: 'Failed to create replacement machine: quota exceeded',
    });
    expect(updateSettings).toHaveBeenCalledWith({
      cloudInstance: expect.objectContaining({
        flyMachineId: undefined,
      }),
    });
    expect(mockCloudReconciler.reportFailure).toHaveBeenCalledWith({
      writer: 'repair',
      rawError: expect.any(Error),
      legacyLastError: 'Machine destroyed but replacement failed: quota exceeded',
    });
  });
});

// ---------------------------------------------------------------------------
// Provider switch (cloud:switch-provider)
// ---------------------------------------------------------------------------
describe('cloud:switch-provider', () => {
  /**
   * URL-matching fetch stub for switch tests. Handles health check,
   * managed provision POST + status poll, and managed deprovision DELETE.
   */
  function stubSwitchFetch(opts?: {
    healthOk?: boolean;
    provisionOk?: boolean;
    provisionData?: Record<string, unknown>;
    statusData?: Record<string, unknown>;
  }) {
    const healthOk = opts?.healthOk ?? true;
    const provisionOk = opts?.provisionOk ?? true;
    // POST only returns flyAppName per eb741af contract
    const provisionData = opts?.provisionData ?? {
      success: true,
      flyAppName: 'new-managed',
    };
    // Status endpoint returns credentials when active
    const statusData = opts?.statusData ?? (provisionOk
      ? {
        exists: true,
        status: 'active',
        phase: 'complete',
        progress: 100,
        cloudUrl: 'https://new-managed.fly.dev',
        cloudToken: 'new-managed-token',
      }
      : {
        exists: true,
        status: 'error',
        phase: 'failed',
        progress: 0,
      });

    const mockFetch = vi.fn().mockImplementation((url: string, fetchOpts?: { method?: string }) => {
      if (url.includes('/api/health')) {
        return Promise.resolve({ ok: healthOk });
      }
      if (url.includes('/api/cloud/managed/provision') && fetchOpts?.method === 'POST') {
        if (!provisionOk) {
          return Promise.resolve({
            ok: false,
            text: () => Promise.resolve(JSON.stringify({ success: false, error: 'Server error' })),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(provisionData) });
      }
      if (url.includes('/api/cloud/managed/status')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(statusData),
        });
      }
      if (url.includes('/api/cloud/managed/provision') && fetchOpts?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      }
      return Promise.resolve({ ok: false, text: () => Promise.resolve('Unexpected fetch URL') });
    });
    vi.stubGlobal('fetch', mockFetch);
    return mockFetch;
  }

  /** Set up Fly provider mock for BYOK cleanup in deprovisionOldInstance. */
  function stubFlyProviderForCleanup(deprovisionSuccess = true) {
    mockGetCloudProviderOrDefault.mockReturnValue({
      config: { id: 'fly', name: 'Fly.io' },
      deprovision: mockProviderDeprovision,
    });
    if (deprovisionSuccess) {
      mockProviderDeprovision.mockResolvedValue({ success: true });
    } else {
      mockProviderDeprovision.mockRejectedValue(new Error('Deprovision network error'));
    }
  }

  beforeEach(() => {
    mockSyncNow.mockReset();
    mockMigrateToCloud.mockReset();
    mockGetCloudProviderOrDefault.mockReset();
    mockProviderDeprovision.mockReset();
    mockLoadFlyApiToken.mockReset();
    mockClearFlyApiToken.mockReset();
    mockSaveFlyApiToken.mockReset();
    mockLoadProviderToken.mockReset();
    mockClearProviderToken.mockReset();
    mockSaveProviderToken.mockReset();
  });

  // -- Preflight checks -------------------------------------------------------

  it('rejects same-provider switch', async () => {
    settings = { cloudInstance: byokCloudInstance() as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:switch-provider', { targetProviderId: 'fly' }) as {
      success: boolean; error: string; failedStep: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already using fly/i);
    expect(result.failedStep).toBe('preflight');
  });

  it('rejects BYOK target without API token', async () => {
    settings = { cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:switch-provider', { targetProviderId: 'hetzner' }) as {
      success: boolean; error: string; failedStep: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/api token required/i);
    expect(result.failedStep).toBe('preflight');
  });

  it('rejects managed target when not entitled', async () => {
    settings = {
      cloudInstance: byokCloudInstance() as AppSettings['cloudInstance'],
      managedCloudEnabled: false,
    };

    const result = await invoke('cloud:switch-provider', { targetProviderId: 'mindstone' }) as {
      success: boolean; error: string; failedStep: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not enabled/i);
    expect(result.failedStep).toBe('preflight');
  });

  // -- Step failures -----------------------------------------------------------

  it('sync failure stops the flow — old instance intact, no provision attempted', async () => {
    settings = {
      cloudInstance: byokCloudInstance() as AppSettings['cloudInstance'],
      managedCloudEnabled: true,
    };
    updateSettings.mockClear();

    // Health check passes
    stubSwitchFetch();
    // Sync fails
    mockSyncNow.mockRejectedValueOnce(new Error('Network timeout'));

    const result = await invoke('cloud:switch-provider', { targetProviderId: 'mindstone' }) as {
      success: boolean; error: string; failedStep: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network timeout');
    expect(result.failedStep).toBe('sync');
    // Old settings untouched — no updateSettings calls
    expect(updateSettings).not.toHaveBeenCalled();
    expect(settings.cloudInstance).toEqual(byokCloudInstance());
  });

  it('provision failure returns error with failedStep and restores old settings', async () => {
    settings = {
      cloudInstance: byokCloudInstance() as AppSettings['cloudInstance'],
      managedCloudEnabled: true,
    };
    updateSettings.mockClear();

    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    mockSyncNow.mockResolvedValueOnce({ success: true });

    // Health ok, provision POST fails
    stubSwitchFetch({ provisionOk: false });

    const result = await invoke('cloud:switch-provider', { targetProviderId: 'mindstone' }) as {
      success: boolean; error: string; failedStep: string;
    };

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('provision');
    // Old settings restored
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudInstance: expect.objectContaining({ providerId: 'fly', provisionMode: 'byok' }),
      }),
    );
  });

  // -- Happy path --------------------------------------------------------------

  it('completes full BYOK→managed switch (all 5 steps)', async () => {
    settings = {
      cloudInstance: byokCloudInstance() as AppSettings['cloudInstance'],
      managedCloudEnabled: true,
    };

    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    mockSyncNow.mockResolvedValueOnce({ success: true });
    mockMigrateToCloud.mockResolvedValueOnce({ errors: [] });
    stubFlyProviderForCleanup(true);
    mockLoadFlyApiToken.mockReturnValue('fly-api-token');
    stubSwitchFetch();

    const result = await invoke('cloud:switch-provider', { targetProviderId: 'mindstone' }) as {
      success: boolean; cloudUrl?: string; cloudToken?: string; warning?: string;
    };

    expect(result.success).toBe(true);
    expect(result.cloudUrl).toBe('https://new-managed.fly.dev');
    expect(result.cloudToken).toBe('new-managed-token');
    expect(result.warning).toBeUndefined();

    // Verify all 5 steps were executed
    expect(mockSyncNow).toHaveBeenCalledOnce();                     // step 2: sync down
    expect(mockMigrateToCloud).toHaveBeenCalledOnce();               // step 4: migrate up
    expect(mockProviderDeprovision).toHaveBeenCalledOnce();          // step 5: cleanup old BYOK
    expect(mockClearFlyApiToken).toHaveBeenCalledOnce();             // step 5: clear old token
  });

  // -- Non-critical cleanup failure --------------------------------------------

  it('returns success with warning when cleanup fails', async () => {
    settings = {
      cloudInstance: byokCloudInstance() as AppSettings['cloudInstance'],
      managedCloudEnabled: true,
    };

    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    mockSyncNow.mockResolvedValueOnce({ success: true });
    mockMigrateToCloud.mockResolvedValueOnce({ errors: [] });

    // Cleanup will fail — no Fly API token for old instance
    stubFlyProviderForCleanup(true);
    mockLoadFlyApiToken.mockReturnValue(null);
    stubSwitchFetch();

    const result = await invoke('cloud:switch-provider', { targetProviderId: 'mindstone' }) as {
      success: boolean; cloudUrl?: string; cloudToken?: string; warning?: string;
    };

    expect(result.success).toBe(true);
    expect(result.cloudUrl).toBe('https://new-managed.fly.dev');
    expect(result.warning).toMatch(/still be running/i);
  });

  // -- Migrate failure ---------------------------------------------------------

  it('migration failure returns error with new instance details and rolls back settings', async () => {
    const originalByokConfig = byokCloudInstance();
    settings = {
      cloudInstance: originalByokConfig as AppSettings['cloudInstance'],
      managedCloudEnabled: true,
    };

    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    mockSyncNow.mockResolvedValueOnce({ success: true });
    mockMigrateToCloud.mockRejectedValueOnce(new Error('Connection reset during upload'));
    stubSwitchFetch();

    const result = await invoke('cloud:switch-provider', { targetProviderId: 'mindstone' }) as {
      success: boolean; error: string; failedStep: string; cloudUrl?: string; cloudToken?: string;
    };

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('migrate');
    expect(result.error).toContain('Connection reset during upload');
    // New instance details returned for potential manual recovery
    expect(result.cloudUrl).toBe('https://new-managed.fly.dev');
    expect(result.cloudToken).toBe('new-managed-token');
    // Old instance NOT deprovisioned
    expect(mockProviderDeprovision).not.toHaveBeenCalled();
    // Settings rolled back to old instance
    expect(settings.cloudInstance?.cloudUrl).toBe(originalByokConfig?.cloudUrl);
    expect(settings.cloudInstance?.providerId).toBe('fly');
  });

  // -- Managed→BYOK direction --------------------------------------------------

  it('completes full managed→BYOK switch', async () => {
    settings = {
      cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'],
      managedCloudEnabled: true,
    };

    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    mockSyncNow.mockResolvedValueOnce({ success: true });
    mockMigrateToCloud.mockResolvedValueOnce({ errors: [] });

    // BYOK provision mock — provider registry returns a mock provider
    const mockByokProvider = {
      config: { id: 'fly', name: 'Fly.io' },
      provision: vi.fn().mockResolvedValue({
        success: true,
        cloudUrl: 'https://my-byok.fly.dev',
        cloudToken: 'byok-token-abc',
        instanceId: 'my-byok-app',
        region: 'lax',
      }),
      deprovision: vi.fn().mockResolvedValue(undefined),
    };
    mockGetCloudProviderOrDefault.mockReturnValue(mockByokProvider);

    // Health check + cleanup of old managed instance (DELETE to rebel-platform)
    stubSwitchFetch();

    const result = await invoke('cloud:switch-provider', {
      targetProviderId: 'fly',
      region: 'lax',
      flyApiToken: 'my-fly-pat',
    }) as { success: boolean; cloudUrl?: string; warning?: string };

    expect(result.success).toBe(true);
    expect(result.cloudUrl).toBe('https://my-byok.fly.dev');
    expect(result.warning).toBeUndefined();
    // Verify BYOK provider was called
    expect(mockByokProvider.provision).toHaveBeenCalledOnce();
  });

  // -- Sync returns failure (non-throw) ----------------------------------------

  it('sync returning success:false stops the flow', async () => {
    settings = {
      cloudInstance: byokCloudInstance() as AppSettings['cloudInstance'],
      managedCloudEnabled: true,
    };
    updateSettings.mockClear();

    stubSwitchFetch();
    mockSyncNow.mockResolvedValueOnce({ success: false, error: 'Partial sync failure' });

    const result = await invoke('cloud:switch-provider', { targetProviderId: 'mindstone' }) as {
      success: boolean; error: string; failedStep: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain('Partial sync failure');
    expect(result.failedStep).toBe('sync');
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// normalizePlatformError
// ---------------------------------------------------------------------------
describe('normalizePlatformError', () => {
  let normalizePlatformError: (error: unknown) => string;

  beforeEach(async () => {
    const mod = await import('../cloudHandlers');
    normalizePlatformError = mod.normalizePlatformError;
  });

  it('returns plain string as-is', () => {
    expect(normalizePlatformError('Something went wrong')).toBe('Something went wrong');
  });

  it('extracts message from Zod-style { name, message } object', () => {
    expect(normalizePlatformError({ name: 'ZodError', message: 'Invalid input' })).toBe('Invalid input');
  });

  it('extracts error from API-style { error: string } object', () => {
    expect(normalizePlatformError({ error: 'No active instance to update' })).toBe('No active instance to update');
  });

  it('returns fallback for unknown shapes', () => {
    expect(normalizePlatformError(42)).toBe('An unknown error occurred');
    expect(normalizePlatformError(null)).toBe('An unknown error occurred');
    expect(normalizePlatformError(undefined)).toBe('An unknown error occurred');
  });
});

// ---------------------------------------------------------------------------
// Managed cloud:apply-update
// ---------------------------------------------------------------------------
describe('cloud:apply-update (managed)', () => {
  it('calls POST /managed/update for pure update (no channel)', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    settings = {
      cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'],
      cloudUpdateChannel: 'stable',
    };

    const mockFetch = vi.fn()
      // POST /managed/update
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })
      // Poll: updating
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'updating' }),
      })
      // Poll: active
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'active' }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const result = await invoke('cloud:apply-update', {}) as { success: boolean; updated: boolean };

    expect(result.success).toBe(true);
    expect(result.updated).toBe(true);

    // Verify POST was to /managed/update
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.rebel.mindstone.com/api/cloud/managed/update',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-token-123' }),
        body: JSON.stringify({}),
      }),
    );
  });

  it('calls POST /managed/channel with channel for channel switch', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    settings = {
      cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'],
      cloudUpdateChannel: 'stable',
    };

    const mockFetch = vi.fn()
      // POST /managed/channel
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, channel: 'beta' }),
      })
      // Poll: updating
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'updating' }),
      })
      // Poll: active
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'active' }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const result = await invoke('cloud:apply-update', { channel: 'beta' }) as { success: boolean; updated: boolean };

    expect(result.success).toBe(true);
    expect(result.updated).toBe(true);

    // Verify POST was to /managed/channel
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.rebel.mindstone.com/api/cloud/managed/channel',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ channel: 'beta' }),
      }),
    );
  });

  it('returns failure without polling when POST returns success:false', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    settings = {
      cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'],
      cloudUpdateChannel: 'stable',
    };

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: false, error: 'No active instance to update' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await invoke('cloud:apply-update', {}) as { success: boolean; updated: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.updated).toBe(false);
    expect(result.error).toBe('No active instance to update');

    // Only 1 fetch call — no polling
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('persists channel only on success (not on failure)', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    settings = {
      cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'],
      cloudUpdateChannel: 'stable',
    };
    updateSettings.mockClear();

    // POST succeeds, but poll returns error
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })
      // Poll: updating
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'updating' }),
      })
      // Poll: error
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'error', error: 'Health check failed' }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const result = await invoke('cloud:apply-update', { channel: 'beta' }) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    // Channel should NOT have been persisted
    expect(updateSettings).not.toHaveBeenCalledWith(expect.objectContaining({ cloudUpdateChannel: 'beta' }));
  });

  it('persists channel on successful channel switch', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    settings = {
      cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'],
      cloudUpdateChannel: 'stable',
    };
    updateSettings.mockClear();

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, channel: 'beta' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'updating' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'active' }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const result = await invoke('cloud:apply-update', { channel: 'beta' }) as { success: boolean; updated: boolean };

    expect(result.success).toBe(true);
    expect(updateSettings).toHaveBeenCalledWith({ cloudUpdateChannel: 'beta' });
  });

  it('requires authentication for managed update', async () => {
    mockGetAccessToken.mockResolvedValue(null);
    settings = {
      cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'],
    };

    const result = await invoke('cloud:apply-update', {}) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sign/i);
  });

  it('does NOT treat same channel as channel switch', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    settings = {
      cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'],
      cloudUpdateChannel: 'stable',
    };

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'updating' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'active' }),
      });
    vi.stubGlobal('fetch', mockFetch);

    await invoke('cloud:apply-update', { channel: 'stable' });

    // Should call /managed/update, not /managed/channel (same channel = pure update)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.rebel.mindstone.com/api/cloud/managed/update',
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// pollManagedUpdateCompletion
// ---------------------------------------------------------------------------
describe('pollManagedUpdateCompletion', () => {
  let pollManagedUpdateCompletion: (accessToken: string, timeoutMs?: number) => Promise<{ success: boolean; error?: string }>;

  beforeEach(async () => {
    const mod = await import('../cloudHandlers');
    pollManagedUpdateCompletion = mod.pollManagedUpdateCompletion;
  });

  it('returns success after observing updating -> active', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'updating' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'active' }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const result = await pollManagedUpdateCompletion('jwt-token', 30_000);
    expect(result.success).toBe(true);
  });

  it('returns failure when status transitions to error', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'updating' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'error', error: 'Health check failed' }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const result = await pollManagedUpdateCompletion('jwt-token', 30_000);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Health check failed');
  });

  it('race-condition guard: does not accept active on first poll without seeing updating', async () => {
    // First poll returns active (transition hasn't started), second returns updating, third returns active
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ exists: true, status: 'active' }),
        });
      }
      if (callCount === 2) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ exists: true, status: 'updating' }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ exists: true, status: 'active' }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await pollManagedUpdateCompletion('jwt-token', 30_000);
    expect(result.success).toBe(true);
    // Should have taken 3 calls (active -> updating -> active), not stopped on first active
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('fails fast on 401 during poll', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await pollManagedUpdateCompletion('expired-token', 30_000);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/authentication failed/i);
    // Should stop after first call — no retries
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails fast on 403 during poll', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await pollManagedUpdateCompletion('wrong-token', 30_000);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/authentication failed/i);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('times out when status never reaches terminal state', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ exists: true, status: 'updating' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    // Use a very short timeout to avoid waiting in tests
    const result = await pollManagedUpdateCompletion('jwt-token', 100);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });
});
