import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

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
      getAccessToken: () => Promise.resolve(null),
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

const mockLoadFlyApiToken = vi.fn<() => string | null>();
 
vi.mock('../../services/flyTokenStorage', () => ({
  loadFlyApiToken: () => mockLoadFlyApiToken(),
}));

const mockGetVolumeStatus = vi.fn();
const mockResizeVolume = vi.fn();
 
vi.mock('@core/services/cloud/cloudVolumeService', () => ({
  getVolumeStatus: (...args: unknown[]) => mockGetVolumeStatus(...args),
  resizeVolume: (...args: unknown[]) => mockResizeVolume(...args),
}));

const mockActiveTurnCount = vi.fn();
 
vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getActiveTurnCount: () => mockActiveTurnCount(),
  },
}));

let settings: Partial<AppSettings>;
const getSettings = () => settings as AppSettings;
const updateSettings = vi.fn((patch: Partial<AppSettings>) => {
  Object.assign(settings, patch);
});

function byokFlyCloudInstance(): AppSettings['cloudInstance'] {
  return {
    mode: 'cloud',
    cloudUrl: 'https://byok.fly.dev',
    cloudToken: 'byok-token',
    providerId: 'fly',
    provisionMode: 'byok',
    flyAppName: 'byok-app',
    flyMachineId: 'mach-byok',
    flyVolumeId: 'vol-byok',
    flyVolumeSizeGb: 10,
  };
}

function managedCloudInstance(): AppSettings['cloudInstance'] {
  return {
    ...byokFlyCloudInstance(),
    providerId: 'mindstone',
    provisionMode: 'managed',
  } as AppSettings['cloudInstance'];
}

beforeEach(async () => {
  handlers.clear();
  settings = {};
  mockPlatformConfig.isOss = false;
  updateSettings.mockClear();
  mockGetVolumeStatus.mockReset();
  mockResizeVolume.mockReset();
  mockLoadFlyApiToken.mockReset();
  mockActiveTurnCount.mockReset();
  mockLoadFlyApiToken.mockReturnValue('fly-token-123');
  mockActiveTurnCount.mockReturnValue(0);
  mockGetVolumeStatus.mockResolvedValue({
    kind: 'ok',
    sizeGb: 15,
    totalBytes: 15 * 1024 ** 3,
    usedBytes: 5 * 1024 ** 3,
    availableBytes: 10 * 1024 ** 3,
    lastCheckedAt: 1234,
  });
  mockResizeVolume.mockResolvedValue({
    success: true,
    applied: true,
    healthVerified: true,
    sizeVerified: true,
    sizeGbBefore: 10,
    sizeGbAfter: 15,
  });

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

describe('cloud:get-volume-status', () => {
  it('returns not_applicable for non-Fly instances', async () => {
    settings = { cloudInstance: { ...byokFlyCloudInstance(), providerId: 'digitalocean' } as AppSettings['cloudInstance'] };
    await expect(invoke('cloud:get-volume-status')).resolves.toEqual({ kind: 'not_applicable', reason: 'non_fly' });
  });

  it('calls the service for managed instances without loading the Fly token', async () => {
    settings = { cloudInstance: managedCloudInstance() };

    const result = await invoke('cloud:get-volume-status') as { kind: string; sizeGb?: number };

    expect(result).toMatchObject({ kind: 'ok', sizeGb: 15 });
    expect(mockLoadFlyApiToken).not.toHaveBeenCalled();
    expect(mockGetVolumeStatus).toHaveBeenCalledWith({
      cloudInstance: expect.objectContaining({ provisionMode: 'managed' }),
      flyApiToken: null,
    });
  });

  it('returns fly_token_missing without calling the service when token is absent', async () => {
    settings = { cloudInstance: byokFlyCloudInstance() };
    mockLoadFlyApiToken.mockReturnValue(null);

    await expect(invoke('cloud:get-volume-status')).resolves.toEqual({ kind: 'fly_token_missing' });
    expect(mockGetVolumeStatus).not.toHaveBeenCalled();
  });

  it('calls the service for BYOK Fly and persists status cache', async () => {
    settings = { cloudInstance: byokFlyCloudInstance() };

    const result = await invoke('cloud:get-volume-status') as { kind: string; sizeGb?: number };

    expect(result).toMatchObject({ kind: 'ok', sizeGb: 15 });
    expect(mockGetVolumeStatus).toHaveBeenCalledWith({
      cloudInstance: expect.objectContaining({ flyVolumeId: 'vol-byok' }),
      flyApiToken: 'fly-token-123',
    });
    expect(updateSettings).toHaveBeenCalledWith({
      cloudInstance: expect.objectContaining({
        flyVolumeSizeGb: 15,
        lastVolumeUsedBytes: 5 * 1024 ** 3,
        lastVolumeAvailableBytes: 10 * 1024 ** 3,
        lastVolumeUsageCheckedAt: 1234,
      }),
    });
  });

  it('re-reads cloudInstance after async status polling before persisting the volume cache', async () => {
    settings = {
      cloudInstance: {
        ...byokFlyCloudInstance(),
        lastError: 'oldError',
        lastKnownStatus: 'error',
      } as AppSettings['cloudInstance'],
    };
    mockGetVolumeStatus.mockImplementationOnce(async () => {
      await Promise.resolve();
      updateSettings({
        cloudInstance: {
          ...settings.cloudInstance!,
          lastError: undefined,
          lastKnownStatus: 'running',
        } as AppSettings['cloudInstance'],
      });
      return {
        kind: 'ok',
        sizeGb: 15,
        totalBytes: 15 * 1024 ** 3,
        usedBytes: 5 * 1024 ** 3,
        availableBytes: 10 * 1024 ** 3,
        lastCheckedAt: 1234,
      };
    });

    const pending = invoke('cloud:get-volume-status');
    await expect(pending).resolves.toMatchObject({ kind: 'ok', sizeGb: 15 });

    expect(settings.cloudInstance).toMatchObject({
      lastKnownStatus: 'running',
      flyVolumeSizeGb: 15,
      lastVolumeUsageCheckedAt: 1234,
    });
    expect(settings.cloudInstance?.lastError).toBeUndefined();
  });
});
