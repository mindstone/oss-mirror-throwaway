/**
 * Cloud Sync Metadata
 *
 * Tracks which sessions have been synced to/from cloud via a separate metadata
 * file (`sessions/cloud-sync-meta.json`). This is intentionally decoupled from
 * the session index to avoid erasure when `createSummary()` rebuilds index
 * entries, and to survive index rebuilds and crash recovery.
 *
 * Used by `executePullSync()` to implement additive-only delete logic:
 * sessions without `cloudSyncedAt` are local-only and must never be deleted
 * based on cloud state.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '../../utils/dataPaths';

const log = createScopedLogger({ service: 'cloudSyncMetadata' });

const SESSIONS_DIR = 'sessions';
const META_FILENAME = 'cloud-sync-meta.json';

/** In-memory map: sessionId -> cloudSyncedAt timestamp */
let syncMeta: Map<string, number> = new Map();

/** Whether metadata has been loaded from disk */
let loaded = false;

/** Debounce timer for writes */
let writeTimer: ReturnType<typeof setTimeout> | null = null;
const WRITE_DEBOUNCE_MS = 1_000;

function getMetaFilePath(): string {
  return path.join(getDataPath(), SESSIONS_DIR, META_FILENAME);
}

/**
 * Load cloud sync metadata from disk. Safe to call multiple times (no-op after first load).
 */
export function loadCloudSyncMetadata(): void {
  if (loaded) return;
  try {
    const filePath = getMetaFilePath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, number>;
      syncMeta = new Map(Object.entries(parsed));
      log.info({ count: syncMeta.size }, 'Loaded cloud sync metadata');
    }
  } catch (err) {
    log.warn({ err }, 'Failed to load cloud sync metadata, starting fresh');
    syncMeta = new Map();
  }
  loaded = true;
}

/**
 * Write metadata to disk (debounced).
 */
function scheduleDiskWrite(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writeToDisk();
  }, WRITE_DEBOUNCE_MS);
}

function writeToDisk(): void {
  try {
    const filePath = getMetaFilePath();
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const data = Object.fromEntries(syncMeta);
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
  } catch (err) {
    log.warn({ err }, 'Failed to write cloud sync metadata');
  }
}

/**
 * Mark a session as synced to/from cloud.
 */
export function markCloudSynced(sessionId: string): void {
  loadCloudSyncMetadata();
  syncMeta.set(sessionId, Date.now());
  scheduleDiskWrite();
}

/**
 * Check whether a session has been synced to/from cloud.
 */
export function isCloudSynced(sessionId: string): boolean {
  loadCloudSyncMetadata();
  return syncMeta.has(sessionId);
}

/**
 * Get the timestamp when a session was last synced to/from cloud.
 */
export function getCloudSyncedAt(sessionId: string): number | undefined {
  loadCloudSyncMetadata();
  return syncMeta.get(sessionId);
}

/**
 * Remove sync metadata for a session (e.g., when session is deleted).
 */
export function removeCloudSyncMetadata(sessionId: string): void {
  loadCloudSyncMetadata();
  if (syncMeta.delete(sessionId)) {
    scheduleDiskWrite();
  }
}

/**
 * Flush pending writes immediately (for shutdown or tests).
 */
export function flushCloudSyncMetadata(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (loaded) writeToDisk();
}

/**
 * Reset in-memory state (for tests only).
 */
export function _resetForTesting(): void {
  syncMeta = new Map();
  loaded = false;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}
