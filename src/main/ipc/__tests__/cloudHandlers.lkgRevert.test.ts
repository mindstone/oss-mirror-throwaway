// Stage D of docs/plans/260510_cloud_image_rollback_defense_in_depth.md.
//
// Tests for the two new IPC channels:
//   - cloud:fetch-lkg-image      — pulls the LKG record from the cloud admin endpoint and caches it
//   - cloud:revert-to-last-known-good — user-confirmed manual rollback via applyImageRollback
//
// We mock electron, the storeFactory, flyApiClient.applyImageRollback,
// global fetch, and the desktopLkgCache wrapper so the assertions focus on
// the IPC handler contract (auth handling, error mapping, tag resolution).

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

const mockApplyImageRollback = vi.fn();
 
vi.mock('@core/services/flyApiClient', () => ({
  applyImageRollback: (...args: unknown[]) => mockApplyImageRollback(...args),
}));

const mockReadCache = vi.fn();
const mockWriteCache = vi.fn();
 
vi.mock('../../services/cloud/desktopLkgCache', () => ({
  readDesktopLkgCache: () => mockReadCache(),
  writeDesktopLkgCache: (payload: unknown) => mockWriteCache(payload),
}));

let settings: Partial<AppSettings>;
const getSettings = () => settings as AppSettings;
const updateSettings = vi.fn((patch: Partial<AppSettings>) => {
  Object.assign(settings, patch);
});

function flyCloudInstance(): AppSettings['cloudInstance'] {
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

beforeEach(async () => {
  handlers.clear();
  settings = {};
  updateSettings.mockClear();
  mockLoadFlyApiToken.mockReset();
  mockApplyImageRollback.mockReset();
  mockReadCache.mockReset();
  mockWriteCache.mockReset();
  mockLoadFlyApiToken.mockReturnValue('fly-token-secret');

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

describe('cloud:fetch-lkg-image', () => {
  it('returns error when no cloud is configured', async () => {
    settings = {};
    const result = (await invoke('cloud:fetch-lkg-image')) as {
      success: boolean;
      record: unknown;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.record).toBeNull();
    expect(result.error).toContain('No cloud');
  });

  it('hits /api/admin/lkg-image with bearer auth and caches the record', async () => {
    settings = { cloudInstance: flyCloudInstance() };
    const goodRecord = {
      imageTag: 'ghcr.io/mindstone/rebel-cloud:prod-good',
      buildCommit: 'abc1234',
      schemaFingerprint: 'a'.repeat(64),
      recordedAt: 1700000000000,
      previousLastKnownGood: null,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ record: goodRecord }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = (await invoke('cloud:fetch-lkg-image')) as {
      success: boolean;
      record: unknown;
    };

    expect(result.success).toBe(true);
    expect(result.record).toEqual(goodRecord);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://byok.fly.dev/api/admin/lkg-image',
      expect.objectContaining({
        headers: { Authorization: 'Bearer byok-token' },
      }),
    );
    expect(mockWriteCache).toHaveBeenCalledWith(
      expect.objectContaining({
        record: goodRecord,
        fetchedFromCloudUrl: 'https://byok.fly.dev',
      }),
    );
  });

  it('surfaces non-2xx as a structured error and does NOT cache', async () => {
    settings = { cloudInstance: flyCloudInstance() };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = (await invoke('cloud:fetch-lkg-image')) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    expect(mockWriteCache).not.toHaveBeenCalled();
  });

  it('treats malformed bodies as record=null and still caches the result', async () => {
    settings = { cloudInstance: flyCloudInstance() };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ record: { garbage: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = (await invoke('cloud:fetch-lkg-image')) as {
      success: boolean;
      record: unknown;
    };
    expect(result.success).toBe(true);
    expect(result.record).toBeNull();
    expect(mockWriteCache).toHaveBeenCalledWith(
      expect.objectContaining({ record: null }),
    );
  });

  it('surfaces network errors without caching', async () => {
    settings = { cloudInstance: flyCloudInstance() };
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = (await invoke('cloud:fetch-lkg-image')) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('network down');
    expect(mockWriteCache).not.toHaveBeenCalled();
  });
});

describe('cloud:revert-to-last-known-good', () => {
  it('refuses when no Fly cloud is configured', async () => {
    settings = {};
    const result = (await invoke('cloud:revert-to-last-known-good', {
      confirmedByUser: true,
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('No Fly cloud');
  });

  it('refuses for non-Fly providers', async () => {
    settings = {
      cloudInstance: {
        ...flyCloudInstance(),
        providerId: 'digitalocean',
      } as AppSettings['cloudInstance'],
    };
    const result = (await invoke('cloud:revert-to-last-known-good', {
      confirmedByUser: true,
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('Fly');
  });

  it('refuses without a stored Fly token', async () => {
    settings = { cloudInstance: flyCloudInstance() };
    mockLoadFlyApiToken.mockReturnValue(null);
    const result = (await invoke('cloud:revert-to-last-known-good', {
      confirmedByUser: true,
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('Fly API token');
  });

  it('uses the cached LKG when no targetImageTag is provided', async () => {
    settings = { cloudInstance: flyCloudInstance() };
    mockReadCache.mockReturnValue({
      record: {
        imageTag: 'ghcr.io/mindstone/rebel-cloud:prod-cached-lkg',
        buildCommit: 'cached-commit',
        schemaFingerprint: 'a'.repeat(64),
        recordedAt: 1700000000000,
        previousLastKnownGood: null,
      },
      refreshedAt: 1700000123456,
      fetchedFromCloudUrl: 'https://byok.fly.dev',
    });
    mockApplyImageRollback.mockResolvedValue({
      outcome: 'rolled-back',
      previousImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-bad',
      targetImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-cached-lkg',
    });

    const result = (await invoke('cloud:revert-to-last-known-good', {
      confirmedByUser: true,
    })) as {
      success: boolean;
      outcome?: string;
      targetImageTag?: string;
    };

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('rolled-back');
    expect(result.targetImageTag).toBe(
      'ghcr.io/mindstone/rebel-cloud:prod-cached-lkg',
    );
    expect(mockApplyImageRollback).toHaveBeenCalledWith(
      'fly-token-secret',
      'byok-app',
      'mach-byok',
      'ghcr.io/mindstone/rebel-cloud:prod-cached-lkg',
      expect.objectContaining({ writerTag: 'desktop-revert' }),
    );
  });

  it('uses the explicit targetImageTag when provided', async () => {
    settings = { cloudInstance: flyCloudInstance() };
    mockApplyImageRollback.mockResolvedValue({
      outcome: 'rolled-back',
      previousImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-bad',
      targetImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-explicit',
    });

    const result = (await invoke('cloud:revert-to-last-known-good', {
      confirmedByUser: true,
      targetImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-explicit',
    })) as { success: boolean; outcome?: string };

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('rolled-back');
    expect(mockReadCache).not.toHaveBeenCalled();
    expect(mockApplyImageRollback).toHaveBeenCalledWith(
      'fly-token-secret',
      'byok-app',
      'mach-byok',
      'ghcr.io/mindstone/rebel-cloud:prod-explicit',
      expect.objectContaining({ writerTag: 'desktop-revert' }),
    );
  });

  it('returns no-op outcome unchanged from applyImageRollback', async () => {
    settings = { cloudInstance: flyCloudInstance() };
    mockApplyImageRollback.mockResolvedValue({
      outcome: 'no-op-same-image',
    });

    const result = (await invoke('cloud:revert-to-last-known-good', {
      confirmedByUser: true,
      targetImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-same',
    })) as { success: boolean; outcome?: string };

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('no-op-same-image');
  });

  it('surfaces fly-error outcomes from applyImageRollback', async () => {
    settings = { cloudInstance: flyCloudInstance() };
    mockApplyImageRollback.mockResolvedValue({
      outcome: 'fly-error',
      error: 'machine API returned 502',
    });

    const result = (await invoke('cloud:revert-to-last-known-good', {
      confirmedByUser: true,
      targetImageTag: 'ghcr.io/mindstone/rebel-cloud:prod-target',
    })) as { success: boolean; outcome?: string; error?: string };

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('fly-error');
    expect(result.error).toContain('502');
  });

  it('returns a friendly error when cache is empty AND no targetImageTag was provided', async () => {
    settings = { cloudInstance: flyCloudInstance() };
    mockReadCache.mockReturnValue({
      record: null,
      refreshedAt: 0,
      fetchedFromCloudUrl: null,
    });

    const result = (await invoke('cloud:revert-to-last-known-good', {
      confirmedByUser: true,
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('No last-known-good');
    expect(mockApplyImageRollback).not.toHaveBeenCalled();
  });
});
