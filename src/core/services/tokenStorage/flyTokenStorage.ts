/**
 * Fly API Token Storage Service
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { getSecureTokenStore } from '@core/secureTokenStore';
import { isValidNonEmptyAscii } from '@core/services/safeStorageDecode';

const log = createScopedLogger({ service: 'fly-token-storage' });

const STORE_NAMESPACE = 'fly-tokens';
const FLY_TOKEN_STORE_KEY = 'encryptedFlyApiToken';
const TOKEN_KIND = 'fly-api-token';

interface FlyTokenStore extends Record<string, unknown> {
  [FLY_TOKEN_STORE_KEY]?: string;
}

let _store: KeyValueStore<FlyTokenStore> | null = null;
const getStore = (): KeyValueStore<FlyTokenStore> => {
  if (!_store) {
    _store = createStore<FlyTokenStore>({
      name: STORE_NAMESPACE,
      defaults: {} as FlyTokenStore,
    });
  }
  return _store;
};

export function saveFlyApiToken(token: string): void {
  try {
    getSecureTokenStore().write({
      store: getStore(),
      namespace: STORE_NAMESPACE,
      key: FLY_TOKEN_STORE_KEY,
      value: token,
    });
    log.debug('Fly API token saved');
  } catch (error) {
    log.error({ err: error }, 'Failed to save Fly API token');
    throw new Error('Failed to save Fly API token securely');
  }
}

export function loadFlyApiToken(): string | null {
  try {
    return getSecureTokenStore().read({
      store: getStore(),
      namespace: STORE_NAMESPACE,
      key: FLY_TOKEN_STORE_KEY,
      kind: TOKEN_KIND,
      validate: isValidNonEmptyAscii,
    });
  } catch (error) {
    log.error({ err: error }, 'Failed to load Fly API token');
    return null;
  }
}

export function clearFlyApiToken(): void {
  try {
    getSecureTokenStore().delete({
      store: getStore(),
      namespace: STORE_NAMESPACE,
      key: FLY_TOKEN_STORE_KEY,
    });
    log.debug('Fly API token cleared');
  } catch (error) {
    log.error({ err: error }, 'Failed to clear Fly API token');
  }
}

export function hasFlyApiToken(): boolean {
  return getSecureTokenStore().has({
    store: getStore(),
    namespace: STORE_NAMESPACE,
    key: FLY_TOKEN_STORE_KEY,
  });
}
