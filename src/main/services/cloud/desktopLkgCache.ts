/**
 * Desktop Last-Known-Good Image Cache
 *
 * Mirrors the cloud-service's last-known-good record onto the desktop so the
 * UI can render the "Try previous version" affordance even when the cloud is
 * unreachable (which is exactly when the user is most likely to want it).
 *
 * Stage D of docs/plans/260510_cloud_image_rollback_defense_in_depth.md.
 *
 * Refresh strategy: the desktop calls `cloud:fetch-lkg-image` on cloud-status
 * boundary changes (status card mount, recovery-suggestion polling). Cache
 * writes are atomic via electron-store. Failures to refresh are non-fatal;
 * the stale cached value is still useful to the user.
 *
 * Persistence layout: a single electron-store keyed `desktop-lkg-cache`.
 * Version is registered in `ALL_STORE_VERSIONS` (key
 * `DESKTOP_LKG_CACHE_STORE_VERSION`).
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'desktop-lkg-cache' });

export const DESKTOP_LKG_CACHE_STORE_VERSION = 1;

export interface DesktopLkgRecord {
  imageTag: string;
  buildCommit: string;
  schemaFingerprint: string;
  /** Millisecond timestamp from the cloud (when the cloud stamped its LKG). */
  recordedAt: number;
  isBootstrapFallback?: boolean;
  previousLastKnownGood: {
    imageTag: string;
    schemaFingerprint: string;
    recordedAt: number;
  } | null;
}

interface DesktopLkgCachePayload extends Record<string, unknown> {
  record: DesktopLkgRecord | null;
  /** When the desktop last successfully refreshed from the cloud. */
  refreshedAt: number;
  /** Cloud URL the record was fetched from — guards against stale data after a cloud swap. */
  fetchedFromCloudUrl: string | null;
}

const DEFAULTS: DesktopLkgCachePayload = {
  record: null,
  refreshedAt: 0,
  fetchedFromCloudUrl: null,
};

let store: KeyValueStore<DesktopLkgCachePayload> | null = null;

function getStore(): KeyValueStore<DesktopLkgCachePayload> {
  if (!store) {
    store = createStore<DesktopLkgCachePayload>({
      name: 'desktop-lkg-cache',
      defaults: DEFAULTS,
    });
  }
  return store;
}

export function readDesktopLkgCache(): DesktopLkgCachePayload {
  try {
    const s = getStore();
    return {
      record: s.get('record') ?? null,
      refreshedAt: s.get('refreshedAt') ?? 0,
      fetchedFromCloudUrl: s.get('fetchedFromCloudUrl') ?? null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ error: message }, 'Failed to read desktop LKG cache');
    return DEFAULTS;
  }
}

export function writeDesktopLkgCache(payload: DesktopLkgCachePayload): void {
  try {
    const s = getStore();
    s.set('record', payload.record);
    s.set('refreshedAt', payload.refreshedAt);
    s.set('fetchedFromCloudUrl', payload.fetchedFromCloudUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ error: message }, 'Failed to write desktop LKG cache');
  }
}

export function clearDesktopLkgCache(): void {
  try {
    const s = getStore();
    s.set('record', null);
    s.set('refreshedAt', 0);
    s.set('fetchedFromCloudUrl', null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ error: message }, 'Failed to clear desktop LKG cache');
  }
}

/** Reset internal singleton (test-only). */
export function __resetDesktopLkgCacheForTests(): void {
  store = null;
}
