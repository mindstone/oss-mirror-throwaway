/**
 * Bug Mode (red→green) tests for cloud teardown reliability.
 *
 * Covers the two entangled bugs this change fixes:
 *   1. Local disconnect (`cloud:destroy`) leaves a drift state — it persists
 *      `mode:'local'` while KEEPING a live `cloudUrl`/`cloudToken` (the
 *      "Offline (queued)" / "Never" stranded-status root cause).
 *   2. Remote teardown (`cloud:deprovision`) can hang (no timeout on
 *      `getAccessToken()`) and, on remote failure, does NOT clear local config —
 *      stranding the user pointing at a dead/unreachable instance.
 *
 * These assert the post-fix contract: teardown always produces a fully-cleared
 * local state (no `mode:'local'` + live URL), never hangs, and always clears
 * locally even when the remote call fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const mockGetAccessToken = vi.fn<() => Promise<string | null>>();
vi.mock('@core/services/mindstoneApiUrl', () => ({
  MINDSTONE_API_URL: 'https://test.rebel.mindstone.com',
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
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
}));
vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => mockBroadcastService,
}));

const mockFlyApiClient = vi.hoisted(() => ({
  allocateSharedIpv4: vi.fn(),
  getMachineState: vi.fn(),
  destroyMachine: vi.fn(),
  createMachine: vi.fn(),
  waitForMachineState: vi.fn(),
}));
vi.mock('@core/services/flyApiClient', () => mockFlyApiClient);

vi.mock('@core/services/flyProvisioningService', () => ({
  lookupFlyInstance: vi.fn().mockResolvedValue({ found: false, error: 'mocked' }),
}));

// cloud:destroy non-force path dynamically imports cloudRouter; mock it so a
// best-effort sync (if any path still calls it) never does real I/O.
const mockDrainOutbox = vi.fn().mockResolvedValue(undefined);
const mockPullChangedSessions = vi.fn().mockResolvedValue(undefined);
const mockSyncNow = vi.fn().mockResolvedValue({ success: true });
const mockDisconnect = vi.fn();
vi.mock('../../services/cloud/cloudRouter', () => ({
  cloudRouter: {
    drainOutbox: (...a: unknown[]) => mockDrainOutbox(...a),
    pullChangedSessions: (...a: unknown[]) => mockPullChangedSessions(...a),
    syncNow: (...a: unknown[]) => mockSyncNow(...a),
    disconnect: (...a: unknown[]) => mockDisconnect(...a),
  },
}));

const mockProviderDeprovision = vi.fn();
const mockGetCloudProviderOrDefault = vi.fn();
vi.mock('@core/services/cloud/providers', () => ({
  getCloudProviderOrDefault: (...args: unknown[]) => mockGetCloudProviderOrDefault(...args),
}));

const mockLoadFlyApiToken = vi.fn<() => string | null>();
const mockClearFlyApiToken = vi.fn();
vi.mock('../../services/flyTokenStorage', () => ({
  loadFlyApiToken: () => mockLoadFlyApiToken(),
  clearFlyApiToken: () => mockClearFlyApiToken(),
  saveFlyApiToken: vi.fn(),
  hasFlyApiToken: () => false,
}));

const mockLoadProviderToken = vi.fn<(p: string) => string | null>();
const mockClearProviderToken = vi.fn();
vi.mock('../../services/providerTokenStorage', () => ({
  loadProviderToken: (p: string) => mockLoadProviderToken(p),
  clearProviderToken: (p: string) => mockClearProviderToken(p),
  saveProviderToken: vi.fn(),
}));

vi.mock('../../services/cloud/cloudOutbox', () => ({
  cloudOutbox: {
    clearAll: vi.fn(),
    getStatus: vi.fn().mockReturnValue({ pending: 0, failed: 0 }),
  },
}));

// ---------------------------------------------------------------------------
// Settings — shallow-assign mirrors the real store's cloudInstance replacement.
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
    lastKnownStatus: 'running',
    lastSyncedAt: 123456,
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

beforeEach(async () => {
  handlers.clear();
  settings = {};
  updateSettings.mockClear();
  mockGetAccessToken.mockReset();
  mockDrainOutbox.mockClear();
  mockPullChangedSessions.mockClear();
  mockSyncNow.mockClear();

  const { registerCloudHandlers } = await import('../cloudHandlers');
  registerCloudHandlers({ getSettings, updateSettings });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function invoke(channel: string, ...args: unknown[]) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(null, ...args);
}

/** The invariant this whole change defends: never persist a live URL in local mode. */
function expectFullyClearedLocal() {
  const ci = settings.cloudInstance;
  expect(ci?.mode).toBe('local');
  expect(ci?.cloudUrl).toBeUndefined();
  expect(ci?.cloudToken).toBeUndefined();
  expect(ci?.lastKnownStatus).toBeUndefined();
  expect(ci?.lastSyncedAt).toBeUndefined();
}

// ---------------------------------------------------------------------------
// Bug 1 — local disconnect must FULLY clear (no drift state).
// ---------------------------------------------------------------------------
describe('cloud:destroy — local Forget (full wipe, no drift)', () => {
  it('force wipe clears cloudUrl/cloudToken/status (no mode:local + live URL drift)', async () => {
    settings = { cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:destroy', { force: true }) as { success: boolean };

    expect(result.success).toBe(true);
    expectFullyClearedLocal();
  });

  it('default (non-force) disconnect also fully clears and never strands creds', async () => {
    settings = { cloudInstance: byokCloudInstance() as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:destroy', {}) as { success: boolean; syncFailed?: boolean };

    expect(result.success).toBe(true);
    expect(result.syncFailed).toBeFalsy();
    expectFullyClearedLocal();
  });

  it('does not perform network I/O on the local forget path', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    settings = { cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'] };

    await invoke('cloud:destroy', { force: true });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bug 2 — remote deprovision must terminate and always clear locally.
// ---------------------------------------------------------------------------
describe('cloud:deprovision (managed) — reliability', () => {
  it('clears local config even when the remote DELETE returns non-OK', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve('Bad gateway'),
    }));
    settings = { cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:deprovision') as { kind: string };

    expect(result.kind).toBe('local-only-remote-uncertain');
    expectFullyClearedLocal();
  });

  it('clears local config even when the remote DELETE throws', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    settings = { cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:deprovision') as { kind: string };

    expect(result.kind).toBe('local-only-remote-uncertain');
    expectFullyClearedLocal();
  });

  it('terminates (does not hang) when getAccessToken() never resolves', { timeout: 8000 }, async () => {
    vi.useFakeTimers();
    // Simulate the production stall: a token fetch that never settles.
    mockGetAccessToken.mockReturnValue(new Promise<string>(() => {}));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) }));
    settings = { cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'] };

    const resultPromise = invoke('cloud:deprovision') as Promise<{ kind: string; error?: string }>;

    // Advance past any reasonable auth deadline.
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;

    // It must resolve and must still clear locally (never strand the user).
    expect(result.kind).toBe('local-only-remote-uncertain');
    expectFullyClearedLocal();
  });

  it('happy path still clears local config on remote success', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) }));
    settings = { cloudInstance: managedCloudInstance() as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:deprovision') as { kind: string };

    expect(result.kind).toBe('remote-removed');
    expectFullyClearedLocal();
  });
});

// ---------------------------------------------------------------------------
// Managed-orphan recovery — after a local Forget the backend instance keeps
// running. The user must be able to (a) reconnect to it and (b) destroy it,
// even though local settings no longer carry provisionMode:'managed'.
// ---------------------------------------------------------------------------
describe('cloud:reattach-managed — recover an orphaned backend instance', () => {
  it('writes the discovered managed credentials back into settings', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    // discoverCloudInstances → GET /api/cloud/managed/status
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        exists: true,
        status: 'running',
        cloudUrl: 'https://recovered.fly.dev',
        cloudToken: 'recovered-token',
      }),
    }));
    // Local config was wiped by a prior Forget.
    settings = { cloudInstance: { mode: 'local' } as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:reattach-managed') as { success: boolean };

    expect(result.success).toBe(true);
    const ci = settings.cloudInstance;
    expect(ci?.mode).toBe('cloud');
    expect(ci?.cloudUrl).toBe('https://recovered.fly.dev');
    expect(ci?.cloudToken).toBe('recovered-token');
    expect(ci?.provisionMode).toBe('managed');
    expect(ci?.providerId).toBe('mindstone');
  });

  it('asks the user to re-provision when the instance exists but no token is recoverable', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ exists: true, cloudUrl: 'https://recovered.fly.dev' }),
    }));
    settings = { cloudInstance: { mode: 'local' } as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:reattach-managed') as { success: boolean; needsReprovision?: boolean };

    expect(result.success).toBe(false);
    expect(result.needsReprovision).toBe(true);
    // Settings must NOT have been switched to a half-attached cloud state.
    expect(settings.cloudInstance?.mode).toBe('local');
  });

  it('fails clearly when no managed instance exists on the backend', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ exists: false }),
    }));
    settings = { cloudInstance: { mode: 'local' } as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:reattach-managed') as { success: boolean; needsReprovision?: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.needsReprovision).toBeFalsy();
    expect(result.error).toBeTruthy();
  });

  it('does not write settings when not signed in', async () => {
    mockGetAccessToken.mockResolvedValue(null);
    settings = { cloudInstance: { mode: 'local' } as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:reattach-managed') as { success: boolean };

    expect(result.success).toBe(false);
    expect(settings.cloudInstance?.mode).toBe('local');
  });
});

describe('cloud:deprovision { managed: true } — destroy an orphan after Forget', () => {
  it('runs the managed DELETE path even when local provisionMode is gone', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) });
    vi.stubGlobal('fetch', mockFetch);
    // Local config already wiped — no provisionMode:'managed' to key off.
    settings = { cloudInstance: { mode: 'local' } as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:deprovision', { managed: true }) as { kind: string };

    expect(result.kind).toBe('remote-removed');
    // The managed teardown hits the platform DELETE endpoint.
    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    const calledInit = mockFetch.mock.calls[0]?.[1] as { method?: string };
    expect(calledUrl).toContain('/api/cloud/managed/provision');
    expect(calledInit?.method).toBe('DELETE');
  });

  it('without the managed scope, a cleared local config has nothing to deprovision', async () => {
    mockGetAccessToken.mockResolvedValue('jwt-token-123');
    mockGetCloudProviderOrDefault.mockReturnValue({
      config: { id: 'fly', name: 'Fly.io' },
      deprovision: mockProviderDeprovision,
    });
    settings = { cloudInstance: { mode: 'local' } as AppSettings['cloudInstance'] };

    const result = await invoke('cloud:deprovision') as { kind: string; error?: string };

    expect(result.kind).toBe('precondition-failed');
  });
});
