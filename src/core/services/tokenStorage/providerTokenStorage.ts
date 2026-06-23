/**
 * Generic Cloud Provider Token Storage
 *
 * Secure storage for cloud provider API/OAuth tokens.
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { getSecureTokenStore } from '@core/secureTokenStore';
import type { CloudProviderId } from '@core/services/cloud/providers/types';
import { isValidNonEmptyAscii } from '@core/services/safeStorageDecode';

const log = createScopedLogger({ service: 'provider-token-storage' });

type TokenStoreMap = Record<string, string | undefined>;

export interface ProviderOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountEmail?: string;
  teamName?: string;
  teamUuid?: string;
}

const stores = new Map<string, KeyValueStore<TokenStoreMap>>();

function getStore(providerId: CloudProviderId): KeyValueStore<TokenStoreMap> {
  let store = stores.get(providerId);
  if (!store) {
    store = createStore<TokenStoreMap>({
      name: `${providerId}-tokens`,
      defaults: {} as TokenStoreMap,
    });
    stores.set(providerId, store);
  }
  return store;
}

const API_STORE_KEY = 'encryptedApiToken';
const OAUTH_STORE_KEY = 'encryptedOAuthTokens';

function apiTokenKind(providerId: CloudProviderId): string {
  return `provider-api-token:${providerId}`;
}

function oauthTokenKind(providerId: CloudProviderId): string {
  return `provider-oauth-token:${providerId}`;
}

function isProviderOAuthTokens(parsed: unknown): parsed is ProviderOAuthTokens {
  if (parsed === null || typeof parsed !== 'object') return false;
  const p = parsed as Record<string, unknown>;
  if (typeof p.accessToken !== 'string' || !isValidNonEmptyAscii(p.accessToken)) return false;
  if (typeof p.refreshToken !== 'string' || !isValidNonEmptyAscii(p.refreshToken)) return false;
  if (typeof p.expiresAt !== 'number' || !Number.isFinite(p.expiresAt) || p.expiresAt <= 0) return false;
  return true;
}

function parseProviderOAuthTokens(raw: string): ProviderOAuthTokens | null {
  try {
    const parsed = JSON.parse(raw);
    if (!isProviderOAuthTokens(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveProviderToken(providerId: CloudProviderId, token: string): void {
  try {
    getSecureTokenStore().write({
      store: getStore(providerId),
      namespace: `${providerId}-tokens`,
      key: API_STORE_KEY,
      value: token,
    });
    log.debug({ providerId }, 'Provider token saved');
  } catch (error) {
    log.error({ err: error, providerId }, 'Failed to save provider token');
    throw new Error(`Failed to save ${providerId} token securely`);
  }
}

export function loadProviderToken(providerId: CloudProviderId): string | null {
  try {
    return getSecureTokenStore().read({
      store: getStore(providerId),
      namespace: `${providerId}-tokens`,
      key: API_STORE_KEY,
      kind: apiTokenKind(providerId),
      validate: isValidNonEmptyAscii,
    });
  } catch (error) {
    log.error({ err: error, providerId }, 'Failed to load provider token');
    return null;
  }
}

export function clearProviderToken(providerId: CloudProviderId): void {
  try {
    getSecureTokenStore().delete({
      store: getStore(providerId),
      namespace: `${providerId}-tokens`,
      key: API_STORE_KEY,
    });
    log.debug({ providerId }, 'Provider token cleared');
  } catch (error) {
    log.error({ err: error, providerId }, 'Failed to clear provider token');
  }
}

export function hasProviderToken(providerId: CloudProviderId): boolean {
  return getSecureTokenStore().has({
    store: getStore(providerId),
    namespace: `${providerId}-tokens`,
    key: API_STORE_KEY,
  });
}

export function saveProviderOAuthTokens(providerId: CloudProviderId, tokens: ProviderOAuthTokens): void {
  try {
    getSecureTokenStore().write({
      store: getStore(providerId),
      namespace: `${providerId}-tokens`,
      key: OAUTH_STORE_KEY,
      value: JSON.stringify(tokens),
    });
    log.debug({ providerId }, 'Provider OAuth tokens saved');
  } catch (error) {
    log.error({ err: error, providerId }, 'Failed to save provider OAuth tokens');
    throw new Error(`Failed to save ${providerId} OAuth tokens securely`);
  }
}

export function loadProviderOAuthTokens(providerId: CloudProviderId): ProviderOAuthTokens | null {
  try {
    const raw = getSecureTokenStore().read({
      store: getStore(providerId),
      namespace: `${providerId}-tokens`,
      key: OAUTH_STORE_KEY,
      kind: oauthTokenKind(providerId),
      validate: (value) => parseProviderOAuthTokens(value) !== null,
    });
    if (!raw) return null;
    return parseProviderOAuthTokens(raw);
  } catch (error) {
    log.error({ err: error, providerId }, 'Failed to load provider OAuth tokens');
    return null;
  }
}

export function clearProviderOAuthTokens(providerId: CloudProviderId): void {
  try {
    getSecureTokenStore().delete({
      store: getStore(providerId),
      namespace: `${providerId}-tokens`,
      key: OAUTH_STORE_KEY,
    });
    log.debug({ providerId }, 'Provider OAuth tokens cleared');
  } catch (error) {
    log.error({ err: error, providerId }, 'Failed to clear provider OAuth tokens');
  }
}

export function hasProviderOAuthTokens(providerId: CloudProviderId): boolean {
  return getSecureTokenStore().has({
    store: getStore(providerId),
    namespace: `${providerId}-tokens`,
    key: OAUTH_STORE_KEY,
  });
}
