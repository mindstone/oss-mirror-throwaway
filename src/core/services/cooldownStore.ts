/**
 * Cooldown Store
 *
 * Persists API rate-limit cooldown state across app restarts.
 * Without persistence, restarting the app during an active cooldown
 * causes immediate retry storms against rate-limited providers.
 *
 * Uses the lazy getStore() pattern required by storeFactory.
 *
 * @see docs/plans/260410_comprehensive_resilience_improvements.md (Stage 3.2 / SF12)
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'cooldownStore' });

export const COOLDOWN_STORE_VERSION = 1;

/** Maximum believable cooldown — rejects obviously corrupt / clock-skewed values. */
const MAX_COOLDOWN_MS = 5 * 60_000;

type CooldownStoreShape = {
  version: number;
  rateLimitCooldownUntil: number;
};

const createDefaultState = (): CooldownStoreShape => ({
  version: COOLDOWN_STORE_VERSION,
  rateLimitCooldownUntil: 0,
});

let _store: KeyValueStore<CooldownStoreShape> | null = null;
const getStore = () => _store ??= createStore<CooldownStoreShape>({
  name: 'api-cooldowns',
  defaults: createDefaultState(),
});

/**
 * Load the persisted cooldown timestamp.
 * Returns the `cooldownUntil` epoch-ms value, or 0 if none / expired / error.
 */
export function getPersistedCooldown(): number {
  try {
    const until = getStore().get('rateLimitCooldownUntil') ?? 0;
    const now = Date.now();
    if (until <= now) {
      // Expired — clean up lazily
      clearPersistedCooldown();
      return 0;
    }
    // Reject obviously corrupt / clock-skewed values (> MAX_COOLDOWN_MS in the future)
    if (until > now + MAX_COOLDOWN_MS) {
      log.warn({ until, maxAllowed: now + MAX_COOLDOWN_MS }, 'Persisted cooldown exceeds max — discarding');
      clearPersistedCooldown();
      return 0;
    }
    return until;
  } catch (error) {
    log.warn({ err: error }, 'Failed to read persisted cooldown');
    return 0;
  }
}

/**
 * Persist a cooldown expiry timestamp.
 */
export function persistCooldown(until: number): void {
  try {
    getStore().set('rateLimitCooldownUntil', until);
    log.debug({ cooldownUntil: new Date(until).toISOString() }, 'Persisted cooldown');
  } catch (error) {
    log.warn({ err: error }, 'Failed to persist cooldown');
  }
}

/**
 * Clear any persisted cooldown state.
 */
export function clearPersistedCooldown(): void {
  try {
    getStore().set('rateLimitCooldownUntil', 0);
  } catch (error) {
    log.warn({ err: error }, 'Failed to clear persisted cooldown');
  }
}

/** Reset the lazy store reference (for testing). */
export function _resetStore(): void {
  _store = null;
}
