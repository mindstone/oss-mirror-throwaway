/**
 * Auth Token Storage Service
 *
 * Secure storage for authentication tokens behind the SecureTokenStore
 * boundary.
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { getSecureTokenStore } from '@core/secureTokenStore';
import { isValidTokenString } from '@core/services/safeStorageDecode';

const log = createScopedLogger({ service: 'auth-token-storage' });

const STORE_NAMESPACE = 'auth-tokens';
const AUTH_STORE_KEY = 'encryptedSessionToken';
const TOKEN_KIND = 'auth-session-token';

type AuthTokenStore = {
  [AUTH_STORE_KEY]?: string;
  cachedUser?: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  };
};

let _tokenStore: KeyValueStore<AuthTokenStore> | null = null;
const getTokenStore = (): KeyValueStore<AuthTokenStore> => {
  if (!_tokenStore) {
    _tokenStore = createStore<AuthTokenStore>({
      name: STORE_NAMESPACE,
      defaults: {} as AuthTokenStore,
    });
  }
  return _tokenStore;
};

export function isEncryptionAvailable(): boolean {
  return getSecureTokenStore().isEncryptionAvailable();
}

export function saveSessionToken(token: string): void {
  try {
    getSecureTokenStore().write({
      store: getTokenStore(),
      namespace: STORE_NAMESPACE,
      key: AUTH_STORE_KEY,
      value: token,
    });
    log.debug('Session token saved');
  } catch (error) {
    log.error({ err: error }, 'Failed to save session token');
    throw new Error('Failed to save session token securely');
  }
}

export function loadSessionToken(): string | null {
  try {
    return getSecureTokenStore().read({
      store: getTokenStore(),
      namespace: STORE_NAMESPACE,
      key: AUTH_STORE_KEY,
      kind: TOKEN_KIND,
      validate: isValidTokenString,
    });
  } catch (error) {
    log.error({ err: error }, 'Failed to load session token');
    return null;
  }
}

export function clearSessionToken(): void {
  try {
    getSecureTokenStore().delete({
      store: getTokenStore(),
      namespace: STORE_NAMESPACE,
      key: AUTH_STORE_KEY,
    });
    log.debug('Session token cleared');
  } catch (error) {
    log.error({ err: error }, 'Failed to clear session token');
  }
}

export function hasSessionToken(): boolean {
  return getSecureTokenStore().has({
    store: getTokenStore(),
    namespace: STORE_NAMESPACE,
    key: AUTH_STORE_KEY,
  });
}

export function saveCachedUser(user: AuthTokenStore['cachedUser']): void {
  getTokenStore().set('cachedUser', user);
  log.debug({ email: user?.email }, 'Cached user info saved');
}

export function loadCachedUser(): AuthTokenStore['cachedUser'] | null {
  return getTokenStore().get('cachedUser') ?? null;
}

export function clearCachedUser(): void {
  getTokenStore().delete('cachedUser');
  log.debug('Cached user info cleared');
}

export function clearAllAuthData(): void {
  clearSessionToken();
  clearCachedUser();
  log.info('All auth data cleared');
}
