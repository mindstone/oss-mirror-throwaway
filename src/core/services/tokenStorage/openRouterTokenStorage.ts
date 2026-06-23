/**
 * OpenRouter OAuth Token Storage Service
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { getSecureTokenStore } from '@core/secureTokenStore';
import { isValidNonEmptyAscii } from '@core/services/safeStorageDecode';

const log = createScopedLogger({ service: 'openrouter-token-storage' });

const STORE_NAMESPACE = 'openrouter-oauth-tokens';
const STORE_KEY = 'encryptedTokens';
const TOKEN_KIND = 'openrouter-oauth-token';

function isOpenRouterTokens(parsed: unknown): parsed is OpenRouterTokens {
  if (parsed === null || typeof parsed !== 'object') return false;
  const p = parsed as Record<string, unknown>;
  if (typeof p.apiKey !== 'string') return false;
  return isValidNonEmptyAscii(p.apiKey);
}

function parseOpenRouterTokens(raw: string): OpenRouterTokens | null {
  try {
    const parsed = JSON.parse(raw);
    if (!isOpenRouterTokens(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface OpenRouterTokens {
  apiKey: string;
}

interface OpenRouterTokenStore extends Record<string, unknown> {
  [STORE_KEY]?: string;
}

let _store: KeyValueStore<OpenRouterTokenStore> | null = null;
const getStore = (): KeyValueStore<OpenRouterTokenStore> => {
  if (!_store) {
    _store = createStore<OpenRouterTokenStore>({
      name: STORE_NAMESPACE,
      defaults: {} as OpenRouterTokenStore,
    });
  }
  return _store;
};

export function saveOpenRouterTokens(tokens: OpenRouterTokens): void {
  try {
    getSecureTokenStore().write({
      store: getStore(),
      namespace: STORE_NAMESPACE,
      key: STORE_KEY,
      value: JSON.stringify(tokens),
    });
    log.debug('OpenRouter tokens saved');
  } catch (error) {
    log.error({ err: error }, 'Failed to save OpenRouter tokens');
    throw new Error('Failed to save OpenRouter tokens securely');
  }
}

export function loadOpenRouterTokens(): OpenRouterTokens | null {
  try {
    const raw = getSecureTokenStore().read({
      store: getStore(),
      namespace: STORE_NAMESPACE,
      key: STORE_KEY,
      kind: TOKEN_KIND,
      validate: (value) => parseOpenRouterTokens(value) !== null,
    });
    if (!raw) return null;
    return parseOpenRouterTokens(raw);
  } catch (error) {
    log.error({ err: error }, 'Failed to load OpenRouter tokens');
    return null;
  }
}

export function clearOpenRouterTokens(): void {
  try {
    getSecureTokenStore().delete({
      store: getStore(),
      namespace: STORE_NAMESPACE,
      key: STORE_KEY,
    });
    log.debug('OpenRouter tokens cleared');
  } catch (error) {
    log.error({ err: error }, 'Failed to clear OpenRouter tokens');
  }
}

export function hasOpenRouterTokens(): boolean {
  return getSecureTokenStore().has({
    store: getStore(),
    namespace: STORE_NAMESPACE,
    key: STORE_KEY,
  });
}
