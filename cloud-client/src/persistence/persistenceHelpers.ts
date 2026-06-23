// cloud-client/src/persistence/persistenceHelpers.ts

import { createLogger } from '../utils/logger';
import { getPersistence, trackKey, untrackKey, getTrackedKeys } from './persistenceRegistry';

const log = createLogger('persistence');

// ---------------------------------------------------------------------------
// Cache key builder
// ---------------------------------------------------------------------------

/** Simple non-crypto string hash for cache key namespacing. */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0; // Convert to 32bit integer
  }
  // Return unsigned hex to avoid negative signs
  return (hash >>> 0).toString(16);
}

/**
 * Build a versioned, cloudUrl-namespaced cache key.
 * Format: `rebel:v1:<cloudUrlHash>:<storeName>`
 */
export function buildCacheKey(cloudUrl: string, storeName: string): string {
  return `rebel:v1:${hashString(cloudUrl)}:${storeName}`;
}

/**
 * Build the key prefix for a given cloudUrl (for bulk clearing on unpair).
 * Format: `rebel:v1:<cloudUrlHash>:`
 */
export function buildCacheKeyPrefix(cloudUrl: string): string {
  return `rebel:v1:${hashString(cloudUrl)}:`;
}

// ---------------------------------------------------------------------------
// Debounce bookkeeping
// ---------------------------------------------------------------------------

interface PendingWrite {
  key: string;
  data: string;
  timer: ReturnType<typeof setTimeout>;
}

const DEBOUNCE_MS = 500;

/** Map of cache key → pending debounced write. */
const _pending = new Map<string, PendingWrite>();

// ---------------------------------------------------------------------------
// hydrateStore
// ---------------------------------------------------------------------------

/**
 * Read a cached value from the persistence adapter, parse JSON, and validate.
 *
 * - Returns `null` (and removes the corrupt key) if JSON parsing or validation fails.
 * - Returns `null` with no side-effects if no adapter is initialised or key is missing.
 */
export async function hydrateStore<T>(
  key: string,
  validate: (data: unknown) => T | null,
): Promise<T | null> {
  const adapter = getPersistence();
  if (!adapter) return null;

  try {
    const raw = await adapter.getItem(key);
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn('Corrupt JSON in cache, removing key', { key });
      await safeRemove(adapter, key);
      return null;
    }

    const validated = validate(parsed);
    if (validated === null) {
      log.warn('Cache validation failed, removing key', { key });
      await safeRemove(adapter, key);
      return null;
    }

    log.debug('Hydrated from cache', { key });
    return validated;
  } catch (err) {
    log.error('hydrateStore failed', { key, error: String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// persistStore
// ---------------------------------------------------------------------------

/** Default max serialized size: 2 MB. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Debounced write-through to the persistence adapter.
 *
 * Serialises `data` as JSON and schedules a write after 500 ms. If called again
 * for the same key before the timer fires, the previous write is replaced.
 *
 * - No-ops when no adapter is initialised.
 * - Skips (with warning) if serialised size exceeds `maxBytes`.
 * - All errors are caught and logged — never throws.
 */
export function persistStore(key: string, data: unknown, maxBytes: number = DEFAULT_MAX_BYTES): void {
  const adapter = getPersistence();
  if (!adapter) return;

  let serialised: string;
  try {
    serialised = JSON.stringify(data);
  } catch (err) {
    log.error('persistStore: JSON.stringify failed', { key, error: String(err) });
    return;
  }

  if (serialised.length > maxBytes) {
    log.warn('persistStore: data exceeds size limit, skipping', {
      key,
      size: serialised.length,
      maxBytes,
    });
    return;
  }

  // Cancel any existing debounce for this key
  const existing = _pending.get(key);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    _pending.delete(key);
    writeToAdapter(adapter, key, serialised);
  }, DEBOUNCE_MS);

  _pending.set(key, { key, data: serialised, timer });
}

// ---------------------------------------------------------------------------
// flushPending
// ---------------------------------------------------------------------------

/**
 * Immediately flush all pending debounced writes.
 * Call this when the app moves to background/inactive to prevent data loss.
 */
export async function flushPending(): Promise<void> {
  const adapter = getPersistence();
  if (!adapter) return;

  const entries = Array.from(_pending.values());
  _pending.clear();

  // Cancel all timers
  for (const entry of entries) {
    clearTimeout(entry.timer);
  }

  // Write all pending data
  const results = await Promise.allSettled(
    entries.map((entry) => writeToAdapter(adapter, entry.key, entry.data)),
  );

  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    log.warn('flushPending: some writes failed', { failureCount: failures.length });
  }
}

// ---------------------------------------------------------------------------
// clearKeysForPrefix
// ---------------------------------------------------------------------------

/**
 * Remove all persistence keys matching the given prefix.
 * Used on unpair to clear cached data for a specific cloudUrl.
 *
 * Uses the adapter's `getAllKeys()` if available, otherwise falls back to
 * in-memory key tracking.
 */
export async function clearKeysForPrefix(prefix: string): Promise<void> {
  const adapter = getPersistence();
  if (!adapter) return;

  // Cancel any pending debounced writes for matching keys to prevent
  // a queued write from recreating just-cleared data (e.g. on unpair).
  for (const [key, entry] of _pending) {
    if (key.startsWith(prefix)) {
      clearTimeout(entry.timer);
      _pending.delete(key);
    }
  }

  try {
    let allKeys: string[];
    if (adapter.getAllKeys) {
      allKeys = await adapter.getAllKeys();
    } else {
      allKeys = getTrackedKeys();
    }

    const matching = allKeys.filter((k) => k.startsWith(prefix));
    if (matching.length === 0) return;

    log.info('Clearing cached keys', { prefix, count: matching.length });

    await Promise.allSettled(
      matching.map(async (key) => {
        await safeRemove(adapter, key);
      }),
    );
  } catch (err) {
    log.error('clearKeysForPrefix failed', { prefix, error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// cancelAndRemoveKey
// ---------------------------------------------------------------------------

/**
 * Cancel any pending debounced write for the given key, then remove it from
 * the adapter. Use this instead of raw `adapter.removeItem()` when evicting
 * or deleting a single key — otherwise the debounced write can re-create the
 * entry after removal.
 */
export async function cancelAndRemoveKey(key: string): Promise<void> {
  const adapter = getPersistence();
  if (!adapter) return;

  const pending = _pending.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    _pending.delete(key);
  }

  await safeRemove(adapter, key);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function writeToAdapter(
  adapter: NonNullable<ReturnType<typeof getPersistence>>,
  key: string,
  data: string,
): Promise<void> {
  try {
    await adapter.setItem(key, data);
    trackKey(key);
    log.debug('Persisted to cache', { key, size: data.length });
  } catch (err) {
    log.error('persistStore: write failed', { key, error: String(err) });
  }
}

async function safeRemove(
  adapter: NonNullable<ReturnType<typeof getPersistence>>,
  key: string,
): Promise<void> {
  try {
    await adapter.removeItem(key);
    untrackKey(key);
  } catch (err) {
    log.error('Failed to remove key', { key, error: String(err) });
  }
}
