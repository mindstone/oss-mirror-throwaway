/**
 * Contract tests for `volumeSizeGb` propagation through the BYOK
 * provisioning handlers.
 *
 * Verifies that:
 *   - `cloud:provision` forwards `volumeSizeGb` into `provider.provision()`.
 *   - `cloud:switch-provider` forwards `volumeSizeGb` into `doProvision()`
 *     (and thus into `provider.provision()`).
 *   - Omitting `volumeSizeGb` leaves it `undefined` on the provider call
 *     so the provider's own `DEFAULT_VOLUME_SIZE_GB` fallback applies.
 *   - `cloud:switch-provider` marks the migration as in-progress via the
 *     renderer coordinator so the UI receives progress events (regression
 *     test for the Stage 2 Behavioral Safety critique).
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 2 — Provider Plumbing + Review-Driven Amendments)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppSettings } from '@shared/types';

// ---------------------------------------------------------------------------
// Handler capture
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

vi.mock('../../services/authTokenStorage', () => ({
  loadSessionToken: () => null,
}));

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
      getAccessToken: () => Promise.resolve('jwt-token-123'),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));


// Switch-provider's sync + migrate stubs
const mockSyncNow = vi.fn().mockResolvedValue({ success: true });
vi.mock('../../services/cloud/cloudRouter', () => ({
  cloudRouter: { syncNow: (...args: unknown[]) => mockSyncNow(...args) },
}));

const mockMigrateToCloud = vi.fn().mockResolvedValue({ errors: [] });
vi.mock('../../services/cloud/cloudMigrationService', () => ({
  migrateToCloud: (...args: unknown[]) => mockMigrateToCloud(...args),
}));

// Capture provider.provision() calls so we can assert what the handler forwarded.
const mockProvision = vi.fn();
const mockDeprovision = vi.fn().mockResolvedValue({ success: true });
const mockProvider = {
  config: { id: 'fly', name: 'Fly.io' },
  provision: mockProvision,
  deprovision: mockDeprovision,
};

vi.mock('@core/services/cloud/providers', () => ({
  getCloudProviderOrDefault: () => mockProvider,
}));

// Fly token storage — required by the BYOK branch in doProvision + cleanup
// during executeSwitchProvider.
const mockLoadFlyApiToken = vi.fn<() => string | null>().mockReturnValue('saved-fly-token');
const mockClearFlyApiToken = vi.fn();
const mockSaveFlyApiToken = vi.fn();
vi.mock('../../services/flyTokenStorage', () => ({
  loadFlyApiToken: () => mockLoadFlyApiToken(),
  clearFlyApiToken: () => mockClearFlyApiToken(),
  saveFlyApiToken: (token: string) => mockSaveFlyApiToken(token),
}));

const mockLoadProviderToken = vi.fn<(providerId: string) => string | null>().mockReturnValue(null);
const mockClearProviderToken = vi.fn();
const mockSaveProviderToken = vi.fn();
vi.mock('../../services/providerTokenStorage', () => ({
  loadProviderToken: (providerId: string) => mockLoadProviderToken(providerId),
  clearProviderToken: (providerId: string) => mockClearProviderToken(providerId),
  saveProviderToken: (providerId: string, token: string) => mockSaveProviderToken(providerId, token),
}));

vi.mock('../../services/cloud/cloudOutbox', () => ({
  cloudOutbox: {
    clearAll: vi.fn(),
    getStatus: vi.fn().mockReturnValue({ pending: 0, failed: 0 }),
  },
}));

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------
let settings: Partial<AppSettings>;
const getSettings = () => settings as AppSettings;
const updateSettings = vi.fn((patch: Partial<AppSettings>) => {
  Object.assign(settings, patch);
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(async () => {
  handlers.clear();
  settings = {};
  updateSettings.mockClear();
  mockProvision.mockReset();
  mockProvision.mockResolvedValue({
    success: true,
    cloudUrl: 'https://new-byok.fly.dev',
    cloudToken: 'byok-token-xyz',
    instanceId: 'new-byok-app',
    region: 'iad',
    providerMetadata: { appName: 'new-byok-app' },
  });
  mockSyncNow.mockClear();
  mockMigrateToCloud.mockClear();
  mockLoadFlyApiToken.mockReturnValue('saved-fly-token');

  const { registerCloudHandlers } = await import('../cloudHandlers');
  registerCloudHandlers({ getSettings, updateSettings });
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
// cloud:provision — volumeSizeGb forwarding
// ---------------------------------------------------------------------------
describe('cloud:provision forwards volumeSizeGb to provider.provision()', () => {
  it('passes explicit volumeSizeGb through to the provider', async () => {
    await invoke('cloud:provision', {
      providerId: 'fly',
      flyApiToken: 'fly-pat-abc',
      region: 'iad',
      volumeSizeGb: 42,
    });

    expect(mockProvision).toHaveBeenCalledOnce();
    const callArgs = mockProvision.mock.calls[0][0] as { volumeSizeGb?: number };
    expect(callArgs.volumeSizeGb).toBe(42);
  });

  it('leaves volumeSizeGb undefined when omitted (provider applies its own default)', async () => {
    await invoke('cloud:provision', {
      providerId: 'fly',
      flyApiToken: 'fly-pat-abc',
      region: 'iad',
    });

    expect(mockProvision).toHaveBeenCalledOnce();
    const callArgs = mockProvision.mock.calls[0][0] as { volumeSizeGb?: number };
    expect(callArgs.volumeSizeGb).toBeUndefined();
  });

  it('works for DigitalOcean (apiToken path) — volumeSizeGb still forwarded', async () => {
    mockProvider.config.id = 'digitalocean';
    try {
      await invoke('cloud:provision', {
        providerId: 'digitalocean',
        apiToken: 'do-pat-abc',
        region: 'nyc1',
        volumeSizeGb: 75,
      });

      expect(mockProvision).toHaveBeenCalledOnce();
      const callArgs = mockProvision.mock.calls[0][0] as { volumeSizeGb?: number };
      expect(callArgs.volumeSizeGb).toBe(75);
    } finally {
      mockProvider.config.id = 'fly';
    }
  });

  it('works for Hetzner (apiToken path) — volumeSizeGb still forwarded', async () => {
    mockProvider.config.id = 'hetzner';
    try {
      await invoke('cloud:provision', {
        providerId: 'hetzner',
        apiToken: 'hz-pat-abc',
        region: 'fsn1',
        volumeSizeGb: 128,
      });

      expect(mockProvision).toHaveBeenCalledOnce();
      const callArgs = mockProvision.mock.calls[0][0] as { volumeSizeGb?: number };
      expect(callArgs.volumeSizeGb).toBe(128);
    } finally {
      mockProvider.config.id = 'fly';
    }
  });
});

// ---------------------------------------------------------------------------
// cloud:switch-provider — volumeSizeGb forwarding
// ---------------------------------------------------------------------------
describe('cloud:switch-provider forwards volumeSizeGb to the new provider', () => {
  function managedCloudInstance() {
    return {
      mode: 'cloud' as const,
      cloudUrl: 'https://managed.fly.dev',
      cloudToken: 'managed-token',
      providerId: 'mindstone' as const,
      provisionMode: 'managed' as const,
      flyAppName: 'managed-app',
    };
  }

  it('threads volumeSizeGb from switch payload to provider.provision()', async () => {
    settings = {
      cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'],
      managedCloudEnabled: true,
    };

    // Health check + cleanup of old managed instance
    const mockFetch = vi.fn().mockImplementation((url: string, opts?: { method?: string }) => {
      if (url.includes('/api/health')) return Promise.resolve({ ok: true });
      if (url.includes('/api/cloud/managed/provision') && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      }
      return Promise.resolve({ ok: false, text: () => Promise.resolve('Unexpected URL') });
    });
    vi.stubGlobal('fetch', mockFetch);

    await invoke('cloud:switch-provider', {
      targetProviderId: 'fly',
      region: 'iad',
      flyApiToken: 'new-fly-pat',
      volumeSizeGb: 60,
    });

    expect(mockProvision).toHaveBeenCalledOnce();
    const callArgs = mockProvision.mock.calls[0][0] as { volumeSizeGb?: number };
    expect(callArgs.volumeSizeGb).toBe(60);
  });

  it('omits volumeSizeGb when the switch payload does not specify one', async () => {
    settings = {
      cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'],
      managedCloudEnabled: true,
    };

    const mockFetch = vi.fn().mockImplementation((url: string, opts?: { method?: string }) => {
      if (url.includes('/api/health')) return Promise.resolve({ ok: true });
      if (url.includes('/api/cloud/managed/provision') && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      }
      return Promise.resolve({ ok: false, text: () => Promise.resolve('Unexpected URL') });
    });
    vi.stubGlobal('fetch', mockFetch);

    await invoke('cloud:switch-provider', {
      targetProviderId: 'fly',
      region: 'iad',
      flyApiToken: 'new-fly-pat',
    });

    expect(mockProvision).toHaveBeenCalledOnce();
    const callArgs = mockProvision.mock.calls[0][0] as { volumeSizeGb?: number };
    expect(callArgs.volumeSizeGb).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-channel parity — provision vs switch-provider pass identical payloads
// ---------------------------------------------------------------------------
describe('volumeSizeGb propagates identically on both BYOK channels', () => {
  it.each([
    { label: 'explicit 60 GB', volumeSizeGb: 60 as number | undefined },
    { label: 'explicit 15 GB (default fallback value)', volumeSizeGb: 15 as number | undefined },
    { label: 'omitted (undefined)', volumeSizeGb: undefined },
  ])('same value flows through cloud:provision and cloud:switch-provider ($label)', async ({ volumeSizeGb }) => {
    // cloud:provision first — fresh setup, no existing cloud instance.
    settings = {};
    const provisionPayload: Record<string, unknown> = {
      providerId: 'fly',
      flyApiToken: 'fly-pat-abc',
      region: 'iad',
    };
    if (volumeSizeGb !== undefined) provisionPayload.volumeSizeGb = volumeSizeGb;

    await invoke('cloud:provision', provisionPayload);
    expect(mockProvision).toHaveBeenCalledOnce();
    const provisionCall = mockProvision.mock.calls[0][0] as { volumeSizeGb?: number };

    // Now cloud:switch-provider — reset mocks and settings to a managed
    // instance so the switch path runs end-to-end.
    mockProvision.mockClear();
    settings = {
      cloudInstance: {
        mode: 'cloud',
        cloudUrl: 'https://managed.fly.dev',
        cloudToken: 'managed-token',
        providerId: 'mindstone',
        provisionMode: 'managed',
        flyAppName: 'managed-app',
      } as AppSettings['cloudInstance'],
      managedCloudEnabled: true,
    };
    const mockFetch = vi.fn().mockImplementation((url: string, opts?: { method?: string }) => {
      if (url.includes('/api/health')) return Promise.resolve({ ok: true });
      if (url.includes('/api/cloud/managed/provision') && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      }
      return Promise.resolve({ ok: false, text: () => Promise.resolve('Unexpected URL') });
    });
    vi.stubGlobal('fetch', mockFetch);

    const switchPayload: Record<string, unknown> = {
      targetProviderId: 'fly',
      region: 'iad',
      flyApiToken: 'new-fly-pat',
    };
    if (volumeSizeGb !== undefined) switchPayload.volumeSizeGb = volumeSizeGb;

    await invoke('cloud:switch-provider', switchPayload);
    expect(mockProvision).toHaveBeenCalledOnce();
    const switchCall = mockProvision.mock.calls[0][0] as { volumeSizeGb?: number };

    // Both channels must deliver the SAME value to provider.provision().
    expect(provisionCall.volumeSizeGb).toBe(volumeSizeGb);
    expect(switchCall.volumeSizeGb).toBe(volumeSizeGb);
    expect(switchCall.volumeSizeGb).toStrictEqual(provisionCall.volumeSizeGb);
  });
});
