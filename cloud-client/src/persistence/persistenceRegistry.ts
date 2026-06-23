// cloud-client/src/persistence/persistenceRegistry.ts

import type { PersistenceAdapter } from './types';

let _adapter: PersistenceAdapter | null = null;

/** Keys written via persistStore, tracked for clearKeysForPrefix fallback. */
const _trackedKeys = new Set<string>();

/**
 * Initialise the persistence layer with a platform-specific adapter.
 * Must be called once at app startup (like `initAuthStore`).
 * No-ops if called again with the same adapter; warns if called with a different one.
 */
export function initPersistence(adapter: PersistenceAdapter): void {
  if (_adapter && _adapter !== adapter) {
    console.warn('[persistence] initPersistence called with a different adapter — ignoring.');
    return;
  }
  _adapter = adapter;
}

/**
 * Returns the current persistence adapter, or `null` if not initialised.
 * All persistence helpers check this and no-op gracefully when null.
 */
export function getPersistence(): PersistenceAdapter | null {
  return _adapter;
}

/**
 * Track a key that has been written to persistence.
 * Used by `clearKeysForPrefix` when the adapter lacks `getAllKeys()`.
 */
export function trackKey(key: string): void {
  _trackedKeys.add(key);
}

/**
 * Remove a key from the in-memory tracking set.
 */
export function untrackKey(key: string): void {
  _trackedKeys.delete(key);
}

/**
 * Returns all in-memory tracked keys (snapshot).
 */
export function getTrackedKeys(): string[] {
  return Array.from(_trackedKeys);
}

/**
 * Reset the persistence layer. For test teardown only.
 */
export function resetPersistence(): void {
  _adapter = null;
  _trackedKeys.clear();
}
