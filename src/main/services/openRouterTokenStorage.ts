/**
 * OpenRouter OAuth Token Storage Service
 *
 * Secure storage for OpenRouter API key obtained via OAuth PKCE.
 * Follows the Electron safeStorage pattern for encrypted credential storage.
 *
 * Unlike Claude Max tokens, OpenRouter returns a permanent API key
 * (no refresh token or expiry). We store it encrypted anyway for
 * consistency and security.
 *
 * Main-process-only -- raw tokens are never exposed to the renderer.
 */

import { getElectronModule } from '@core/lazyElectron';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { isE2eTestMode } from '../utils/testIsolation';
import {
  clearDegradedLatch,
  decodeJsonStore,
  isValidNonEmptyAscii,
} from '@core/services/safeStorageDecode';

const log = createScopedLogger({ service: 'openrouter-token-storage' });

const STORE_KEY = 'encryptedTokens';
const TOKEN_KIND = 'openrouter-oauth-token';

function isOpenRouterTokens(parsed: unknown): parsed is OpenRouterTokens {
  if (parsed === null || typeof parsed !== 'object') return false;
  const p = parsed as Record<string, unknown>;
  if (typeof p.apiKey !== 'string') return false;
  return isValidNonEmptyAscii(p.apiKey);
}

export interface OpenRouterTokens {
  apiKey: string;
}

const MANAGED_PENDING_CLOUD_CLEAR_KEY = 'managedPendingCloudClear';

type ManagedPendingCloudClearFailureReason =
  // Eager mark written BEFORE the mutation-null relay is attempted, so an app
  // exit during an in-flight POST cannot lose the clear/revoke intent. Observed
  // failures refine the reason; confirmed delivery clears the marker. Mirrors
  // the Codex token pending-clear marker (codexTokenStorage.ts).
  | 'mutation_in_flight'
  | 'mutation_post_failed'
  | 'mutation_skipped_no_client'
  | 'mutation_skipped_no_config';

interface ManagedPendingCloudClearMarker {
  setAt: number;
  reason: ManagedPendingCloudClearFailureReason;
}

interface OpenRouterTokenStore extends Record<string, unknown> {
  [STORE_KEY]?: string;
  encryptedManagedKey?: string;
  [MANAGED_PENDING_CLOUD_CLEAR_KEY]?: ManagedPendingCloudClearMarker;
}

let _store: KeyValueStore<OpenRouterTokenStore> | null = null;
const getStore = (): KeyValueStore<OpenRouterTokenStore> => {
  if (!_store) {
    _store = createStore<OpenRouterTokenStore>({
      name: 'openrouter-oauth-tokens',
      defaults: {} as OpenRouterTokenStore,
    });
  }
  return _store;
};

function isEncryptionAvailable(): boolean {
  if (isE2eTestMode()) return false;
  try {
    const safeStorage = getElectronModule()?.safeStorage;
    return safeStorage?.isEncryptionAvailable() ?? false;
  } catch (error) {
    log.warn({ err: error }, 'Failed to check safeStorage availability');
    return false;
  }
}

/**
 * Save OpenRouter API key securely using safeStorage encryption.
 * Falls back to plain base64 encoding if encryption is unavailable.
 */
export function saveOpenRouterTokens(tokens: OpenRouterTokens): void {
  try {
    const json = JSON.stringify(tokens);
    if (isEncryptionAvailable()) {
      const safeStorage = getElectronModule()?.safeStorage;
      if (!safeStorage) throw new Error('safeStorage unavailable after encryption check');
      const encrypted = safeStorage.encryptString(json);
      getStore().set(STORE_KEY, encrypted.toString('base64'));
      log.debug('OpenRouter tokens saved with encryption');
    } else {
      log.warn('safeStorage unavailable — storing OpenRouter tokens without encryption');
      getStore().set(STORE_KEY, Buffer.from(json).toString('base64'));
    }
  } catch (error) {
    log.error({ err: error }, 'Failed to save OpenRouter tokens');
    throw new Error('Failed to save OpenRouter tokens securely');
  }
}

/**
 * Load OpenRouter API key from secure storage.
 * Returns null if no tokens are stored or decryption/parsing fails.
 */
export function loadOpenRouterTokens(): OpenRouterTokens | null {
  try {
    const stored = getStore().get(STORE_KEY);
    if (!stored) return null;

    const result = decodeJsonStore<OpenRouterTokens>({
      stored,
      isEncryptionAvailable,
      decryptString: (buf) => {
        const safeStorage = getElectronModule()?.safeStorage;
        if (!safeStorage) throw new Error('safeStorage unavailable after encryption check');
        return safeStorage.decryptString(buf);
      },
      validate: isOpenRouterTokens,
      kind: TOKEN_KIND,
    });

    switch (result.kind) {
      case 'ok':
        clearDegradedLatch(TOKEN_KIND);
        return result.value;
      case 'corrupt':
        log.error('OpenRouter token decryption failed on encrypted-prefixed payload — clearing corrupt tokens from store');
        getStore().delete(STORE_KEY);
        return null;
      case 'unavailable_encrypted':
      case 'null':
        return null;
    }
  } catch (error) {
    log.error({ err: error }, 'Failed to load OpenRouter tokens');
    return null;
  }
}

/**
 * Clear stored OpenRouter API key.
 */
export function clearOpenRouterTokens(): void {
  try {
    getStore().delete(STORE_KEY);
    log.debug('OpenRouter tokens cleared');
  } catch (error) {
    log.error({ err: error }, 'Failed to clear OpenRouter tokens');
  }
}

/**
 * Check if OpenRouter API key is stored.
 */
export function hasOpenRouterTokens(): boolean {
  return getStore().has(STORE_KEY);
}

// ---------------------------------------------------------------------------
// Managed (Mindstone subscription) key slot
// ---------------------------------------------------------------------------

const MANAGED_STORE_KEY = 'encryptedManagedKey';
const MANAGED_TOKEN_KIND = 'mindstone-managed-key';

/**
 * Save managed OpenRouter API key (from Mindstone subscription).
 * Same encryption pattern as personal OAuth key.
 * Main-process-only — never exposed to renderer.
 */
export function saveManagedOpenRouterKey(apiKey: string): void {
  try {
    const json = JSON.stringify({ apiKey });
    if (isEncryptionAvailable()) {
      const safeStorage = getElectronModule()?.safeStorage;
      if (!safeStorage) throw new Error('safeStorage unavailable after encryption check');
      const encrypted = safeStorage.encryptString(json);
      getStore().set(MANAGED_STORE_KEY, encrypted.toString('base64'));
      log.debug('Managed OpenRouter key saved with encryption');
    } else {
      log.warn('safeStorage unavailable — storing managed OpenRouter key without encryption');
      getStore().set(MANAGED_STORE_KEY, Buffer.from(json).toString('base64'));
    }
  } catch (error) {
    log.error({ err: error }, 'Failed to save managed OpenRouter key');
    throw new Error('Failed to save managed OpenRouter key securely');
  }
}

/**
 * Load managed OpenRouter API key from secure storage.
 * Returns null if no managed key is stored or decryption fails.
 */
export function loadManagedOpenRouterKey(): string | null {
  try {
    const stored = getStore().get(MANAGED_STORE_KEY);
    if (!stored) return null;

    const result = decodeJsonStore<OpenRouterTokens>({
      stored,
      isEncryptionAvailable,
      decryptString: (buf) => {
        const safeStorage = getElectronModule()?.safeStorage;
        if (!safeStorage) throw new Error('safeStorage unavailable after encryption check');
        return safeStorage.decryptString(buf);
      },
      validate: isOpenRouterTokens,
      kind: MANAGED_TOKEN_KIND,
    });

    switch (result.kind) {
      case 'ok':
        clearDegradedLatch(MANAGED_TOKEN_KIND);
        return result.value.apiKey;
      case 'corrupt':
        log.error('Managed OpenRouter key decode failed — clearing corrupt managed key from store');
        getStore().delete(MANAGED_STORE_KEY);
        return null;
      case 'unavailable_encrypted':
      case 'null':
        return null;
    }
  } catch (error) {
    log.error({ err: error }, 'Failed to load managed OpenRouter key');
    return null;
  }
}

/**
 * Clear stored managed OpenRouter API key.
 */
export function clearManagedOpenRouterKey(): void {
  try {
    getStore().delete(MANAGED_STORE_KEY);
    log.debug('Managed OpenRouter key cleared');
  } catch (error) {
    log.error({ err: error }, 'Failed to clear managed OpenRouter key');
  }
}

/**
 * Check if managed OpenRouter API key is stored.
 */
export function hasManagedOpenRouterKey(): boolean {
  return getStore().has(MANAGED_STORE_KEY);
}

// ---------------------------------------------------------------------------
// Managed-key → cloud relay: durable pending-clear marker
//
// Mirrors the Codex pending-clear marker (codexTokenStorage.ts). When the
// desktop relays a clear/revoke of the managed key to the user's cloud
// instance and the POST fails (or cloud is unreachable), the durable marker
// lets the next reconnect-driven sync replay the clear — so a revoked key
// never goes stale on cloud. Confirmed delivery clears the marker. The marker
// is also what lets the destructive-null guard distinguish a genuine clear
// intent from a transient desktop read returning null.
// ---------------------------------------------------------------------------

function parseManagedPendingCloudClearMarker(raw: unknown): ManagedPendingCloudClearMarker | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const marker = raw as Record<string, unknown>;
  const setAt = marker.setAt;
  const reason = marker.reason;
  if (typeof setAt !== 'number' || !Number.isFinite(setAt)) return null;
  if (
    reason !== 'mutation_in_flight'
    && reason !== 'mutation_post_failed'
    && reason !== 'mutation_skipped_no_client'
    && reason !== 'mutation_skipped_no_config'
  ) {
    return null;
  }
  return { setAt, reason };
}

export function markPendingManagedKeyCloudClear(reason: ManagedKeyPendingCloudClearFailureReason): void {
  getStore().set(MANAGED_PENDING_CLOUD_CLEAR_KEY, {
    setAt: Date.now(),
    reason,
  } satisfies ManagedPendingCloudClearMarker);
}

export function clearPendingManagedKeyCloudClear(): void {
  getStore().delete(MANAGED_PENDING_CLOUD_CLEAR_KEY);
}

export function hasPendingManagedKeyCloudClear(): boolean {
  return parseManagedPendingCloudClearMarker(getStore().get(MANAGED_PENDING_CLOUD_CLEAR_KEY)) !== null;
}

export type ManagedKeyPendingCloudClearFailureReason = ManagedPendingCloudClearFailureReason;
