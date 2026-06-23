/**
 * Stage 3 behavioural test: `cloud:do-start-oauth` (DigitalOcean) returns STRUCTURED setup
 * guidance on the not-configured path, classified BEFORE the service's
 * getDigitalOceanCredentialsOrThrow() throw (which stays the internal safety net).
 *
 * Asserts: when resolveDigitalOceanCredentials() returns null, the handler returns
 * { success: false, setupGuidance.code === 'oauth-credentials-not-configured', provider: 'digitalocean' }
 * and never imports/invokes the DigitalOcean auth service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('@core/services/mindstoneApiUrl', () => ({
  MINDSTONE_API_URL: 'https://test.rebel.mindstone.com',
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
    getAuthState: vi.fn(() => ({ isAuthenticated: false, user: null, isLoading: false })),
    onAuthStateChange: vi.fn(() => () => {}),
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

// resolveDigitalOceanCredentials → null (broken-by-default / OSS).
const mockResolveDigitalOceanCredentials = vi.fn<() => { clientId: string; clientSecret: string } | null>();
vi.mock('../../services/oauthCredentials', () => ({
  resolveDigitalOceanCredentials: () => mockResolveDigitalOceanCredentials(),
}));

// The DigitalOcean auth service is dynamically imported only AFTER the credential check; if the
// classify-before path works, startDigitalOceanOAuth() is never reached.
const mockStartDigitalOceanOAuth = vi.fn();
vi.mock('../../services/digitalOceanAuthService', () => ({
  startDigitalOceanOAuth: (...args: unknown[]) => mockStartDigitalOceanOAuth(...args),
  getDigitalOceanOAuthStatus: vi.fn(),
  disconnectDigitalOceanOAuth: vi.fn(),
}));

let settings: Partial<AppSettings>;
const getSettings = () => settings as AppSettings;
const updateSettings = vi.fn((patch: Partial<AppSettings>) => {
  Object.assign(settings, patch);
});

beforeEach(async () => {
  handlers.clear();
  settings = {};
  vi.clearAllMocks();
  const { registerCloudHandlers } = await import('../cloudHandlers');
  registerCloudHandlers({ getSettings, updateSettings });
});

describe('cloud:do-start-oauth — DigitalOcean not-configured returns structured setupGuidance', () => {
  it('returns setupGuidance for digitalocean and never reaches startDigitalOceanOAuth()', async () => {
    mockResolveDigitalOceanCredentials.mockReturnValue(null);

    const handler = handlers.get('cloud:do-start-oauth');
    expect(handler).toBeDefined();
    const result = (await handler!()) as {
      success: boolean;
      error?: string;
      setupGuidance?: { code: string; provider: string; message: string; envVars: string[] };
    };

    expect(result.success).toBe(false);
    expect(result.setupGuidance?.code).toBe('oauth-credentials-not-configured');
    expect(result.setupGuidance?.provider).toBe('digitalocean');
    // Back-compat error string is sourced from guidance.message (no drift).
    expect(result.error).toBe(result.setupGuidance?.message);
    expect(result.error).toBeTruthy();
    expect(result.setupGuidance?.envVars).toContain('DIGITAL_OCEAN_CLIENT_ID');
    expect(mockStartDigitalOceanOAuth).not.toHaveBeenCalled();
  });

  it('falls through to startDigitalOceanOAuth() when credentials ARE configured (no guidance)', async () => {
    mockResolveDigitalOceanCredentials.mockReturnValue({ clientId: 'id', clientSecret: 'secret' });
    mockStartDigitalOceanOAuth.mockResolvedValue(undefined);

    const handler = handlers.get('cloud:do-start-oauth');
    const result = (await handler!()) as { success: boolean; setupGuidance?: unknown };

    expect(result.success).toBe(true);
    expect(result.setupGuidance).toBeUndefined();
    expect(mockStartDigitalOceanOAuth).toHaveBeenCalledTimes(1);
  });
});
