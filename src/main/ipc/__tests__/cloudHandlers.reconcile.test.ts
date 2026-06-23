/**
 * Stage 6 — `cloud:reconcile-migration` IPC contract.
 *
 * The handler is thin — it POSTs to the cloud-service `/api/data/reconcile`
 * endpoint using a short-lived `CloudServiceClient`. This test asserts:
 *   - happy path: forwards `target` and returns the server's state verbatim
 *   - no cloud config: returns `state: 'none'` plus an error message
 *     (never throws — would be user-hostile on startup)
 *   - cloud error: falls back to `state: 'none'` with the error text
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 6 — Orphan cleanup + reconcile)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@shared/types';

// ---------------------------------------------------------------------------
// Handler registry capture
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
// Cloud client mock
// ---------------------------------------------------------------------------
const mockPost = vi.fn();

vi.mock('../../services/cloud/cloudServiceClient', () => ({
  CloudServiceClient: class MockCloudServiceClient {
    constructor(public url: string, public token: string) {}
    post = mockPost;
  },
}));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
let settings: Partial<AppSettings>;
const getSettings = () => settings as AppSettings;
const updateSettings = vi.fn((patch: Partial<AppSettings>) => {
  Object.assign(settings, patch);
});

beforeEach(async () => {
  handlers.clear();
  mockPost.mockReset();
  settings = {
    cloudInstance: {
      mode: 'cloud',
      cloudUrl: 'https://rebel-test.fly.dev',
      cloudToken: 'token-abc',
    },
  };
  const { registerCloudHandlers } = await import('../cloudHandlers');
  registerCloudHandlers({ getSettings, updateSettings });
});

function invoke(channel: string, ...args: unknown[]) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(null, ...args);
}

describe('cloud:reconcile-migration handler', () => {
  it('registers under the cloud:reconcile-migration channel', () => {
    expect(handlers.has('cloud:reconcile-migration')).toBe(true);
  });

  it('forwards workspace target and returns state verbatim', async () => {
    mockPost.mockResolvedValue({ state: 'partial_extract' });
    const res = await invoke('cloud:reconcile-migration', { target: 'workspace' });
    expect(res).toEqual({ state: 'partial_extract' });
    expect(mockPost).toHaveBeenCalledWith('/api/data/reconcile', { target: 'workspace' });
  });

  it('forwards appdata target and returns state verbatim', async () => {
    mockPost.mockResolvedValue({ state: 'complete' });
    const res = await invoke('cloud:reconcile-migration', { target: 'appdata' });
    expect(res).toEqual({ state: 'complete' });
    expect(mockPost).toHaveBeenCalledWith('/api/data/reconcile', { target: 'appdata' });
  });

  it('returns none with error when cloud is not configured (no URL/token)', async () => {
    settings = { cloudInstance: { mode: 'local' } };
    const res = (await invoke('cloud:reconcile-migration', { target: 'workspace' })) as {
      state: string;
      error?: string;
    };
    expect(res.state).toBe('none');
    expect(res.error).toBeTruthy();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('returns none when cloud call fails — never throws to caller', async () => {
    mockPost.mockRejectedValue(new Error('NETWORK_FAIL'));
    const res = (await invoke('cloud:reconcile-migration', { target: 'workspace' })) as {
      state: string;
      error?: string;
    };
    expect(res.state).toBe('none');
    expect(res.error).toContain('NETWORK_FAIL');
  });

  it('returns none when cloud returns an unexpected shape', async () => {
    mockPost.mockResolvedValue({ weirdField: true });
    const res = (await invoke('cloud:reconcile-migration', { target: 'workspace' })) as {
      state: string;
    };
    expect(res.state).toBe('none');
  });
});
