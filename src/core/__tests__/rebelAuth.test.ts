import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RebelAuthProvider } from '@core/rebelAuth';

let getRebelAuthProvider: typeof import('@core/rebelAuth').getRebelAuthProvider;
let setRebelAuthProvider: typeof import('@core/rebelAuth').setRebelAuthProvider;
let NULL_REBEL_AUTH_PROVIDER: typeof import('@core/rebelAuth').NULL_REBEL_AUTH_PROVIDER;

const UNAUTHENTICATED_STATE = {
  isAuthenticated: false,
  user: null,
  isLoading: false,
};

describe('RebelAuthProvider boundary', () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@core/rebelAuth');
    getRebelAuthProvider = mod.getRebelAuthProvider;
    setRebelAuthProvider = mod.setRebelAuthProvider;
    NULL_REBEL_AUTH_PROVIDER = mod.NULL_REBEL_AUTH_PROVIDER;
  });

  it('exposes the documented inert sentinel shape', async () => {
    expect(NULL_REBEL_AUTH_PROVIDER.getAuthState()).toEqual(UNAUTHENTICATED_STATE);
    await expect(NULL_REBEL_AUTH_PROVIDER.getAccessToken()).resolves.toBeNull();
    expect(() => NULL_REBEL_AUTH_PROVIDER.invalidateAccessToken()).not.toThrow();
    await expect(NULL_REBEL_AUTH_PROVIDER.initializeAuth()).resolves.toEqual(UNAUTHENTICATED_STATE);
    expect(() => NULL_REBEL_AUTH_PROVIDER.setPostLoginCallback(null)).not.toThrow();
    expect(NULL_REBEL_AUTH_PROVIDER.getCachedAuthConfig()).toBeNull();
    await expect(NULL_REBEL_AUTH_PROVIDER.requestAuthConfigRefresh()).resolves.toBeUndefined();
    await expect(NULL_REBEL_AUTH_PROVIDER.refreshLicenseTier()).resolves.toBe('free');
    expect(() => NULL_REBEL_AUTH_PROVIDER.clearCachedProviderKey('anthropic')).not.toThrow();
    expect(() => NULL_REBEL_AUTH_PROVIDER.clearCachedProviderKey('voice')).not.toThrow();
    expect(NULL_REBEL_AUTH_PROVIDER.getSharedDriveConfig()).toBeNull();
    expect(NULL_REBEL_AUTH_PROVIDER.getSubscriptionState()).toBeNull();
    expect(NULL_REBEL_AUTH_PROVIDER.getManagedAllowanceResetsAt()).toBeUndefined();
  });

  it('keeps refreshLicenseTier inert and does not mutate feature gating state', async () => {
    const featureGating = await import('@core/featureGating');

    featureGating.resetFeatureGating();
    featureGating.setLicenseTier('teams');

    try {
      await expect(NULL_REBEL_AUTH_PROVIDER.refreshLicenseTier()).resolves.toBe('free');
      expect(featureGating.getLicenseTier()).toBe('teams');
    } finally {
      featureGating.resetFeatureGating();
    }
  });

  it('treats onAuthStateChange as a no-op subscription', () => {
    const listener = vi.fn();
    const unsubscribe = NULL_REBEL_AUTH_PROVIDER.onAuthStateChange(listener);

    expect(typeof unsubscribe).toBe('function');
    expect(listener).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
    expect(() => unsubscribe()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it('throws when provider is not registered', () => {
    expect(() => getRebelAuthProvider()).toThrow(
      'RebelAuthProvider not registered — call setRebelAuthProvider() during bootstrap',
    );
  });

  it('returns the registered provider implementation', () => {
    setRebelAuthProvider(NULL_REBEL_AUTH_PROVIDER);
    expect(getRebelAuthProvider()).toBe(NULL_REBEL_AUTH_PROVIDER);
  });

  it('creates mock providers from the sentinel with caller overrides', async () => {
    const { createMockRebelAuthProvider } = await import(
      '@core/__tests__/fixtures/rebelAuthProvider'
    );
    const provider: RebelAuthProvider = createMockRebelAuthProvider({
      getAccessToken: async () => 'fake-token',
    });

    await expect(provider.getAccessToken()).resolves.toBe('fake-token');
    expect(provider.getAuthState()).toEqual(UNAUTHENTICATED_STATE);
    expect(provider.getCachedAuthConfig()).toBeNull();
  });
});
