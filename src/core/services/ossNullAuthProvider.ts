import { setLicenseTier } from '@core/featureGating';
import { createScopedLogger } from '@core/logger';
import type { RebelAuthProvider } from '@core/rebelAuth';
import type { AuthConfigPresence } from '@shared/ipc/channels/auth';
import type { AuthState } from '@shared/ipc/schemas/auth';

/**
 * OSS-build Rebel auth implementation, intentionally distinct from
 * `NULL_REBEL_AUTH_PROVIDER` in `@core/rebelAuth`. The core sentinel is an
 * inert unwired fallback; this provider is the authoritative OSS auth surface
 * that B3 can explicitly register once desktop auth is removed.
 *
 * It reports `licenseTier: 'teams'` because the OSS strategy treats local OSS
 * builds as having the only currently relevant paid gate
 * (`spaces:create-additional`) enabled, without involving Mindstone auth.
 *
 * Listener semantics follow Amendment A1.4: subscribing stores the listener but
 * does not synchronously invoke it. `initializeAuth()` is the broadcast point,
 * matching the real provider's store-then-broadcast-via-init shape.
 */

const log = createScopedLogger({ service: 'oss-null-auth-provider' });

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

const AUTH_CONFIG_PRESENCE: AuthConfigPresence = {
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
};

const listeners: Array<(state: AuthState) => void> = [];

function broadcastAuthenticatedState(): void {
  const snapshot = listeners.slice();
  for (const listener of snapshot) {
    try {
      listener(AUTHENTICATED_STATE);
    } catch (err) {
      log.warn({ err }, 'OSS null auth listener threw during auth initialization');
    }
  }
}

export const OSS_NULL_AUTH_PROVIDER: RebelAuthProvider = {
  getAuthState: () => AUTHENTICATED_STATE,
  onAuthStateChange: (listener) => {
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    };
  },
  getAccessToken: async () => null,
  invalidateAccessToken: () => {},
  initializeAuth: async () => {
    setLicenseTier('teams');
    broadcastAuthenticatedState();
    return AUTHENTICATED_STATE;
  },
  setPostLoginCallback: (_cb) => {},
  getCachedAuthConfig: () => AUTH_CONFIG_PRESENCE,
  requestAuthConfigRefresh: async () => {},
  refreshLicenseTier: async () => {
    setLicenseTier('teams');
    return 'teams';
  },
  clearCachedProviderKey: (_provider) => {},
  getSharedDriveConfig: () => null,
  getSubscriptionState: () => null,
  getManagedAllowanceResetsAt: () => undefined,
};
