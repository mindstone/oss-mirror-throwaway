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

const mockChangeVmTier = vi.fn();
const mockGetCurrentVmTier = vi.fn();
 
vi.mock('@core/services/cloud/vmTierService', () => ({
  changeVmTier: (...args: unknown[]) => mockChangeVmTier(...args),
  getCurrentVmTier: (...args: unknown[]) => mockGetCurrentVmTier(...args),
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

function managedCloudInstance(): AppSettings['cloudInstance'] {
  return {
    mode: 'cloud',
    cloudUrl: 'https://managed.fly.dev',
    cloudToken: 'managed-token',
    providerId: 'mindstone',
    provisionMode: 'managed',
    flyAppName: 'managed-app',
    flyMachineId: 'mach-managed',
  };
}

function byokFlyCloudInstance(): AppSettings['cloudInstance'] {
  return {
    mode: 'cloud',
    cloudUrl: 'https://byok.fly.dev',
    cloudToken: 'byok-token',
    providerId: 'fly',
    provisionMode: 'byok',
    flyAppName: 'byok-app',
    flyMachineId: 'mach-byok',
  };
}

beforeEach(async () => {
  handlers.clear();
  settings = {};
  updateSettings.mockClear();
  mockChangeVmTier.mockReset();
  mockGetCurrentVmTier.mockReset();
  mockLoadFlyApiToken.mockReset();
  mockActiveTurnCount.mockReset();
  mockCloudReconciler.reconcile.mockReset();
  mockCloudReconciler.reportSuccess.mockReset();
  mockCloudReconciler.reportFailure.mockReset();

  mockLoadFlyApiToken.mockReturnValue('fly-token-123');
  mockActiveTurnCount.mockReturnValue(0);
  mockGetCurrentVmTier.mockResolvedValue({
    success: true,
    tier: {
      id: 'standard',
      label: 'Standard',
      description: 'Standard tier',
      cpuKind: 'shared',
      cpus: 1,
      memoryMb: 2048,
      estimatedMonthlyCostUsd: 5,
    },
  });
  mockChangeVmTier.mockResolvedValue({ success: true, updated: true });

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

describe('cloud:change-vm-tier', () => {
  it('returns BYOK guard error for managed instances', async () => {
    settings = { cloudInstance: managedCloudInstance() };

    const result = await invoke('cloud:change-vm-tier', { tierId: 'faster' }) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/self-hosted Fly cloud instances/i);
  });

  it('returns BYOK guard error for non-fly providers', async () => {
    settings = {
      cloudInstance: {
        ...byokFlyCloudInstance(),
        providerId: 'digitalocean',
      } as AppSettings['cloudInstance'],
    };

    const result = await invoke('cloud:change-vm-tier', { tierId: 'faster' }) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/self-hosted Fly cloud instances/i);
  });

  it('treats legacy BYOK records (providerId undefined, flyApp+flyMachine present) as Fly', async () => {
    settings = {
      cloudInstance: {
        ...byokFlyCloudInstance(),
        providerId: undefined,
      } as AppSettings['cloudInstance'],
    };

    const result = await invoke('cloud:change-vm-tier', { tierId: 'faster' }) as { success: boolean; updated?: boolean };
    expect(result.success).toBe(true);
    expect(result.updated).toBe(true);
    expect(mockChangeVmTier).toHaveBeenCalled();
  });

  it('returns active-turn guard error when a turn is in progress', async () => {
    settings = { cloudInstance: byokFlyCloudInstance() };
    mockActiveTurnCount.mockReturnValue(1);

    const result = await invoke('cloud:change-vm-tier', { tierId: 'faster' }) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('Can\'t change tiers while a conversation is active');
    expect(mockChangeVmTier).not.toHaveBeenCalled();
  });

  it('returns error for unknown tier id', async () => {
    settings = { cloudInstance: byokFlyCloudInstance() };

    const result = await invoke('cloud:change-vm-tier', { tierId: 'unknown-tier' }) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown tier: unknown-tier');
    expect(mockChangeVmTier).not.toHaveBeenCalled();
  });

  it('persists vmTierId to settings on success', async () => {
    settings = { cloudInstance: byokFlyCloudInstance() };
    mockChangeVmTier.mockResolvedValue({
      success: true,
      updated: true,
      machineStateBefore: 'started',
    });

    const result = await invoke('cloud:change-vm-tier', { tierId: 'faster' }) as { success: boolean; updated?: boolean };

    expect(result.success).toBe(true);
    expect(result.updated).toBe(true);
    expect(mockChangeVmTier).toHaveBeenCalledWith({
      flyApiToken: 'fly-token-123',
      flyAppName: 'byok-app',
      flyMachineId: 'mach-byok',
      cloudUrl: 'https://byok.fly.dev',
      tier: expect.objectContaining({ id: 'faster' }),
      // Phase 7 fix: defence-in-depth re-check inside the per-machine lock so
      // a turn that started after the handler check can't slip past.
      getActiveTurnCount: expect.any(Function),
    });
    expect(updateSettings).toHaveBeenCalledWith({
      cloudInstance: expect.objectContaining({
        vmTierId: 'faster',
      }),
    });
  });

  it('surfaces settingsPersisted=false when persistence throws after successful tier change', async () => {
    settings = { cloudInstance: byokFlyCloudInstance() };
    mockChangeVmTier.mockResolvedValue({
      success: true,
      updated: true,
      applied: true,
      healthVerified: true,
      machineStateBefore: 'started',
    });
    updateSettings.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const result = await invoke('cloud:change-vm-tier', { tierId: 'faster' }) as {
      success: boolean;
      settingsPersisted?: boolean;
    };

    // Tier change itself succeeded — don't mask that — but caller can see the
    // settings cache failed to persist.
    expect(result.success).toBe(true);
    expect(result.settingsPersisted).toBe(false);
  });
});

describe('cloud:get-vm-tier', () => {
  it('returns BYOK guard error for managed instances', async () => {
    settings = { cloudInstance: managedCloudInstance() };

    const result = await invoke('cloud:get-vm-tier') as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/self-hosted Fly cloud instances/i);
  });

  it('treats legacy BYOK records (providerId undefined, flyApp+flyMachine present) as Fly', async () => {
    settings = {
      cloudInstance: {
        ...byokFlyCloudInstance(),
        providerId: undefined,
      } as AppSettings['cloudInstance'],
    };

    const result = await invoke('cloud:get-vm-tier') as { success: boolean; tier?: { id: string } };
    expect(result.success).toBe(true);
    expect(result.tier?.id).toBe('standard');
    expect(mockGetCurrentVmTier).toHaveBeenCalledWith({
      flyApiToken: 'fly-token-123',
      flyAppName: 'byok-app',
      flyMachineId: 'mach-byok',
    });
  });
});
