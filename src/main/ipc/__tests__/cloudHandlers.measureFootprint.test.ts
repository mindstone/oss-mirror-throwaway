/**
 * Contract tests for the `cloud:measure-footprint` IPC handler.
 *
 * Verifies that:
 *   - The handler resolves `coreDirectory` from settings and `userDataPath`
 *     from the platform config, then forwards them to
 *     `getCloudMigrationFootprint()`.
 *   - Each outcome kind (`measured_zero`, `measured_nonzero`,
 *     `unknown_partial`) is returned verbatim with `durationMs` attached.
 *   - When the footprint util throws (shouldn't happen — it's fail-closed —
 *     but defensively), the handler surfaces the failure rather than
 *     swallowing it silently.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 3 — UI Footprint Measurement + IPC)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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


// ---------------------------------------------------------------------------
// Platform + footprint mocks
// ---------------------------------------------------------------------------
const mockUserDataPath = '/test/userData';

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({ userDataPath: mockUserDataPath }),
}));

const mockGetCloudMigrationFootprint = vi.fn();

vi.mock('@core/services/cloud/cloudMigrationFootprint', () => ({
  getCloudMigrationFootprint: (opts: unknown) => mockGetCloudMigrationFootprint(opts),
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
  mockGetCloudMigrationFootprint.mockReset();

  const { registerCloudHandlers } = await import('../cloudHandlers');
  registerCloudHandlers({ getSettings, updateSettings });
});

function invoke(channel: string, ...args: unknown[]) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(null, ...args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('cloud:measure-footprint handler', () => {
  it('registers under the cloud:measure-footprint channel', () => {
    expect(handlers.has('cloud:measure-footprint')).toBe(true);
  });

  it('forwards userDataPath + coreDirectory to the footprint util', async () => {
    settings = { coreDirectory: '/Users/alice/rebel-workspace' };
    mockGetCloudMigrationFootprint.mockResolvedValue({
      kind: 'measured_zero',
      totalBytes: 0,
      workspaceBytes: 0,
      appDataBytes: 0,
      durationMs: 5,
    });

    await invoke('cloud:measure-footprint');

    expect(mockGetCloudMigrationFootprint).toHaveBeenCalledOnce();
    expect(mockGetCloudMigrationFootprint).toHaveBeenCalledWith({
      coreDirectory: '/Users/alice/rebel-workspace',
      userDataPath: mockUserDataPath,
    });
  });

  it('passes null coreDirectory when the user has not set one', async () => {
    settings = {};
    mockGetCloudMigrationFootprint.mockResolvedValue({
      kind: 'measured_zero',
      totalBytes: 0,
      workspaceBytes: 0,
      appDataBytes: 0,
      durationMs: 1,
    });

    await invoke('cloud:measure-footprint');

    expect(mockGetCloudMigrationFootprint).toHaveBeenCalledWith({
      coreDirectory: null,
      userDataPath: mockUserDataPath,
    });
  });

  it('returns measured_zero outcome verbatim', async () => {
    settings = {};
    const outcome = {
      kind: 'measured_zero' as const,
      totalBytes: 0 as const,
      workspaceBytes: 0 as const,
      appDataBytes: 0,
      durationMs: 12,
    };
    mockGetCloudMigrationFootprint.mockResolvedValue(outcome);

    const result = await invoke('cloud:measure-footprint');

    expect(result).toEqual(outcome);
  });

  it('returns measured_nonzero outcome verbatim with workspaceBytes', async () => {
    settings = { coreDirectory: '/workspace' };
    const outcome = {
      kind: 'measured_nonzero' as const,
      totalBytes: 4_500_000_000,
      workspaceBytes: 3_900_000_000,
      appDataBytes: 600_000_000,
      durationMs: 430,
    };
    mockGetCloudMigrationFootprint.mockResolvedValue(outcome);

    const result = await invoke('cloud:measure-footprint');

    expect(result).toEqual(outcome);
  });

  it('returns unknown_partial outcome verbatim (propagates reason)', async () => {
    settings = { coreDirectory: '/workspace' };
    const outcome = {
      kind: 'unknown_partial' as const,
      partialBytes: 120_000_000,
      reason: 'permission' as const,
      durationMs: 87,
    };
    mockGetCloudMigrationFootprint.mockResolvedValue(outcome);

    const result = await invoke('cloud:measure-footprint');

    expect(result).toEqual(outcome);
  });

  it('propagates unexpected errors from the footprint util (fail-closed)', async () => {
    // The footprint util is supposed to be fail-closed and never throw,
    // but if an upstream change regresses that contract we want the
    // handler to surface the failure rather than swallow it.
    settings = {};
    mockGetCloudMigrationFootprint.mockRejectedValue(new Error('platform not initialized'));

    await expect(invoke('cloud:measure-footprint')).rejects.toThrow(
      'platform not initialized',
    );
  });
});
