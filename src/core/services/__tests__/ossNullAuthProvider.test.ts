import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLicenseTier, resetFeatureGating, setLicenseTier } from '@core/featureGating';
import { AuthConfigPresenceSchema } from '@shared/ipc/channels/auth';
import type { AuthState } from '@shared/ipc/schemas/auth';
import { OSS_NULL_AUTH_PROVIDER } from '../ossNullAuthProvider';

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => loggerMock,
}));

const AUTHENTICATED_STATE: AuthState = {
  user: {
    id: 'oss-user',
    name: 'You',
    email: '',
    image: null,
  },
  isAuthenticated: true,
  isLoading: false,
};

describe('OSS_NULL_AUTH_PROVIDER', () => {
  let unsubscribers: Array<() => void> = [];

  beforeEach(() => {
    resetFeatureGating();
    loggerMock.warn.mockReset();
    unsubscribers = [];
  });

  afterEach(() => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    unsubscribers = [];
    resetFeatureGating();
    vi.restoreAllMocks();
  });

  function subscribe(listener: (state: AuthState) => void): () => void {
    const unsubscribe = OSS_NULL_AUTH_PROVIDER.onAuthStateChange(listener);
    unsubscribers.push(unsubscribe);
    return unsubscribe;
  }

  it('returns the OSS authenticated state and cached config presence', () => {
    expect(OSS_NULL_AUTH_PROVIDER.getAuthState()).toEqual(AUTHENTICATED_STATE);

    const config = OSS_NULL_AUTH_PROVIDER.getCachedAuthConfig();

    expect(AuthConfigPresenceSchema.parse(config)).toEqual(config);
    expect(config).toEqual({
      hasVoiceProvider: false,
      hasVoiceApiKey: false,
      hasAnthropicApiKey: false,
      hasSharedDriveConfig: false,
      recommendedConnectors: [],
      hasSpaces: false,
      licenseTier: 'teams',
      disabledConnectorTools: {},
      hasManagedKey: false,
      isOssBuild: true,
    });
  });

  it('resolves null/no-op interface methods without throwing', async () => {
    await expect(OSS_NULL_AUTH_PROVIDER.getAccessToken()).resolves.toBeNull();
    expect(() => OSS_NULL_AUTH_PROVIDER.invalidateAccessToken()).not.toThrow();
    expect(() => OSS_NULL_AUTH_PROVIDER.setPostLoginCallback(null)).not.toThrow();
    await expect(OSS_NULL_AUTH_PROVIDER.requestAuthConfigRefresh()).resolves.toBeUndefined();
    expect(() => OSS_NULL_AUTH_PROVIDER.clearCachedProviderKey('anthropic')).not.toThrow();
    expect(() => OSS_NULL_AUTH_PROVIDER.clearCachedProviderKey('voice')).not.toThrow();
    expect(OSS_NULL_AUTH_PROVIDER.getSharedDriveConfig()).toBeNull();
    expect(OSS_NULL_AUTH_PROVIDER.getSubscriptionState()).toBeNull();
    expect(OSS_NULL_AUTH_PROVIDER.getManagedAllowanceResetsAt()).toBeUndefined();
  });

  it('does not synchronously invoke auth listeners on subscribe', () => {
    const listener = vi.fn();

    subscribe(listener);

    expect(listener).not.toHaveBeenCalled();
  });

  it('invokes subscribed auth listeners once during initializeAuth', async () => {
    const listener = vi.fn();
    subscribe(listener);

    await expect(OSS_NULL_AUTH_PROVIDER.initializeAuth()).resolves.toEqual(AUTHENTICATED_STATE);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(AUTHENTICATED_STATE);
  });

  it('stops invoking auth listeners after unsubscribe', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    unsubscribe();
    unsubscribers = unsubscribers.filter((candidate) => candidate !== unsubscribe);
    await OSS_NULL_AUTH_PROVIDER.initializeAuth();

    expect(listener).not.toHaveBeenCalled();
  });

  it('broadcasts to every listener exactly once per initializeAuth call (Phase 6 F1 regression)', async () => {
    // Self-unsubscribing listener: regression test for the live-array-iteration bug where
    // splicing the listeners array mid-broadcast caused the next listener to be skipped.
    // Fix: broadcastAuthenticatedState() iterates over `listeners.slice()` so mutation
    // during iteration is safe.
    const survivingListener = vi.fn();
    const handle: { unsubscribe?: () => void } = {};
    const selfUnsubscribingListener = vi.fn(() => {
      handle.unsubscribe?.();
    });
    handle.unsubscribe = subscribe(selfUnsubscribingListener);
    subscribe(survivingListener);

    await OSS_NULL_AUTH_PROVIDER.initializeAuth();

    expect(selfUnsubscribingListener).toHaveBeenCalledTimes(1);
    expect(survivingListener).toHaveBeenCalledTimes(1);
  });

  it('does not invoke a listener subscribed mid-broadcast in the same broadcast (Phase 6 F1 regression)', async () => {
    // Subscribe-during-broadcast: regression test for the live-array-iteration bug where
    // a newly added listener could be invoked in the same broadcast.
    // With the snapshot fix, the new listener is invoked only on the NEXT initializeAuth.
    const lateSubscriber = vi.fn();
    const earlyListener = vi.fn(() => {
      subscribe(lateSubscriber);
    });
    subscribe(earlyListener);

    await OSS_NULL_AUTH_PROVIDER.initializeAuth();

    expect(earlyListener).toHaveBeenCalledTimes(1);
    expect(lateSubscriber).not.toHaveBeenCalled();

    await OSS_NULL_AUTH_PROVIDER.initializeAuth();

    expect(lateSubscriber).toHaveBeenCalledTimes(1);
  });

  it('broadcasts on each subsequent initializeAuth call (A1.4 once-per-init contract)', async () => {
    const listener = vi.fn();
    subscribe(listener);

    await OSS_NULL_AUTH_PROVIDER.initializeAuth();
    await OSS_NULL_AUTH_PROVIDER.initializeAuth();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('continues broadcasting when one auth listener throws', async () => {
    const throwingListener = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const survivingListener = vi.fn();
    subscribe(throwingListener);
    subscribe(survivingListener);

    await OSS_NULL_AUTH_PROVIDER.initializeAuth();

    expect(throwingListener).toHaveBeenCalledTimes(1);
    expect(survivingListener).toHaveBeenCalledTimes(1);
    expect(survivingListener).toHaveBeenCalledWith(AUTHENTICATED_STATE);
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it('sets the global license tier to teams during initializeAuth', async () => {
    setLicenseTier('free');

    await OSS_NULL_AUTH_PROVIDER.initializeAuth();

    expect(getLicenseTier()).toBe('teams');
  });

  it('sets the global license tier to teams during refreshLicenseTier', async () => {
    setLicenseTier('free');

    await expect(OSS_NULL_AUTH_PROVIDER.refreshLicenseTier()).resolves.toBe('teams');

    expect(getLicenseTier()).toBe('teams');
  });

  it('does not call fetch from any provider method', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null));
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    OSS_NULL_AUTH_PROVIDER.getAuthState();
    await OSS_NULL_AUTH_PROVIDER.getAccessToken();
    OSS_NULL_AUTH_PROVIDER.invalidateAccessToken();
    await OSS_NULL_AUTH_PROVIDER.initializeAuth();
    OSS_NULL_AUTH_PROVIDER.setPostLoginCallback(null);
    OSS_NULL_AUTH_PROVIDER.getCachedAuthConfig();
    await OSS_NULL_AUTH_PROVIDER.requestAuthConfigRefresh();
    await OSS_NULL_AUTH_PROVIDER.refreshLicenseTier();
    OSS_NULL_AUTH_PROVIDER.clearCachedProviderKey('anthropic');
    OSS_NULL_AUTH_PROVIDER.getSharedDriveConfig();
    OSS_NULL_AUTH_PROVIDER.getSubscriptionState();
    OSS_NULL_AUTH_PROVIDER.getManagedAllowanceResetsAt();
    unsubscribe();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
