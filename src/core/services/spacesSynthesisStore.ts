/**
 * Spaces Synthesis Store
 *
 * Caches AI-generated synthesis of space activity to avoid repeated API calls.
 * Regenerates when cache is stale (>24h) or user's focus changes.
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'spacesSynthesis' });

const SYNTHESIS_STORE_VERSION = 1;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface SpacesSynthesis {
  hook: string;
  detail: string;
  generatedAt: number;
  focus: string;
}

type SpacesSynthesisStoreShape = {
  version: number;
  synthesis: SpacesSynthesis | null;
};

const createDefaultState = (): SpacesSynthesisStoreShape => ({
  version: SYNTHESIS_STORE_VERSION,
  synthesis: null,
});

let _store: KeyValueStore<SpacesSynthesisStoreShape> | null = null;
const getStore = () => _store ??= createStore<SpacesSynthesisStoreShape>({
  name: 'spaces-synthesis',
  defaults: createDefaultState(),
});

/**
 * Get cached synthesis if valid (not stale and focus matches).
 */
export function getCachedSynthesis(currentFocus: string): SpacesSynthesis | null {
  try {
    const stored = getStore().get('synthesis');
    if (!stored) return null;

    // Check if focus changed
    if (stored.focus !== currentFocus) {
      log.debug({ storedFocus: stored.focus, currentFocus }, 'Focus changed, cache invalid');
      return null;
    }

    // Check if stale
    const age = Date.now() - stored.generatedAt;
    if (age > CACHE_MAX_AGE_MS) {
      log.debug({ ageHours: Math.round(age / 3600000) }, 'Cache stale');
      return null;
    }

    log.debug({ ageHours: Math.round(age / 3600000) }, 'Returning cached synthesis');
    return stored;
  } catch (error) {
    log.warn({ err: error }, 'Failed to read synthesis cache');
    return null;
  }
}

/**
 * Store synthesis in cache.
 */
export function setCachedSynthesis(synthesis: SpacesSynthesis): void {
  try {
    getStore().set('synthesis', synthesis);
    log.info({ focus: synthesis.focus }, 'Cached synthesis');
  } catch (error) {
    log.warn({ err: error }, 'Failed to cache synthesis');
  }
}

/**
 * Clear the synthesis cache.
 */
export function clearSynthesisCache(): void {
  try {
    getStore().set('synthesis', null);
    log.info('Cleared synthesis cache');
  } catch (error) {
    log.warn({ err: error }, 'Failed to clear synthesis cache');
  }
}
