import { createScopedLogger } from '@core/logger';
import type { AuthConfigPresence } from '@shared/ipc/channels/auth';
import type {
  AuthProvider,
  AuthState,
  AuthUser,
  LicenseTier,
  SharedDriveConfig,
} from '@shared/ipc/schemas/auth';
import type { SubscriptionState } from '@shared/types/settings';

const log = createScopedLogger({ service: 'rebel-auth' });

/**
 * Boundary interface for Rebel/Mindstone auth across desktop, cloud, and mobile.
 *
 * This is intentionally one facade over identity state, access tokens, config
 * payload, and license/billing state. `fetchAuthConfig` populates the provider
 * key presence payload, shared-drive config, subscription metadata, and license
 * tier from one network call, so splitting those concerns would buy little
 * operational separation today. DA S1 left a possible split into smaller
 * interfaces as a B4-time refactor, not Stage 1 groundwork.
 *
 * Cross-surface intent matters: desktop registers a Mindstone-server-backed
 * implementation; cloud must register an implementation that answers
 * `getAccessToken()` from cloud bearer tokens; mobile must register an
 * implementation that answers from cloud-client tokens. Do not silently
 * null-provide non-desktop surfaces with `NULL_REBEL_AUTH_PROVIDER` once a
 * real implementation is available, because that would silently disable
 * Mindstone features anywhere that is not desktop. Stage 1 may use the
 * sentinel as a placeholder before auth IPC is cloud-routable; that is not the
 * long-term target.
 *
 * `getCurrentUser()` is intentionally absent. Consumers that need current-user
 * identity should use `getCurrentUserProvider().getCurrentUser()` from
 * `@core/currentUserProvider` instead of expanding this facade.
 */
export interface RebelAuthProvider {
  getAuthState(): AuthState;
  onAuthStateChange(listener: (state: AuthState) => void): () => void;
  getAccessToken(): Promise<string | null>;
  invalidateAccessToken(): void;
  initializeAuth(): Promise<AuthState>;
  setPostLoginCallback(
    cb: ((provider: AuthProvider, user: AuthUser) => Promise<void>) | null,
  ): void;
  getCachedAuthConfig(): AuthConfigPresence | null;
  requestAuthConfigRefresh(): Promise<void>;
  refreshLicenseTier(): Promise<LicenseTier>;
  clearCachedProviderKey(provider: 'anthropic' | 'voice'): void;
  getSharedDriveConfig(): SharedDriveConfig | null;
  getSubscriptionState(): SubscriptionState | null;
  getManagedAllowanceResetsAt(): string | undefined;
}

const UNAUTHENTICATED_STATE: AuthState = {
  isAuthenticated: false,
  user: null,
  isLoading: false,
};

export const NULL_REBEL_AUTH_PROVIDER: RebelAuthProvider = {
  getAuthState: () => UNAUTHENTICATED_STATE,
  onAuthStateChange: (_listener) => () => {},
  getAccessToken: async () => null,
  invalidateAccessToken: () => {},
  initializeAuth: async () => UNAUTHENTICATED_STATE,
  setPostLoginCallback: (_cb) => {},
  getCachedAuthConfig: () => null,
  requestAuthConfigRefresh: async () => {},
  refreshLicenseTier: () => Promise.resolve('free'),
  clearCachedProviderKey: (_provider) => {},
  getSharedDriveConfig: () => null,
  getSubscriptionState: () => null,
  getManagedAllowanceResetsAt: () => undefined,
};

let _provider: RebelAuthProvider | undefined;

// CROSS_SURFACE_PARITY_EXEMPT: Stage 2 intentionally registers the inert NULL_REBEL_AUTH_PROVIDER on cloud because no auth IPC channel is cloud-routed yet; B3 will replace the placeholder when cloud has a real auth-bearing surface.
export function setRebelAuthProvider(provider: RebelAuthProvider): void {
  _provider = provider;
  log.info(
    { authenticated: provider.getAuthState().isAuthenticated },
    'Rebel auth provider registered',
  );
}

export function getRebelAuthProvider(): RebelAuthProvider {
  if (!_provider) {
    throw new Error('RebelAuthProvider not registered — call setRebelAuthProvider() during bootstrap');
  }
  return _provider;
}
