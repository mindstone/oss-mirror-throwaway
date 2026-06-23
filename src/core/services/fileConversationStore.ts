/**
 * File-Conversation Store
 *
 * Tracks associations between files and conversations for smart routing
 * when sending annotations to Rebel.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { toPortablePath } from '@core/utils/portablePath';
import { migrateStore, shouldEnterReadOnlyMode, type VersionedData, type MigrationFn } from '../utils/storeMigration';
import { loadStoreSafely, isLoadFailedReadOnly, resolveConfStorePath } from '../utils/loadStoreSafely';

const log = createScopedLogger({ service: 'fileConversation' });

// Constants
const FILE_CONVERSATION_STORE_VERSION = 1;
const MAX_ENTRIES_PER_FILE = 5;
const MAX_TOTAL_ENTRIES = 500;
const MAX_AGE_DAYS = 30;

export interface FileConversationLink {
  id: string;
  filePath: string; // Relative to workspace
  sessionId: string;
  sessionTitle: string;
  timestamp: number;
  source: 'write' | 'open';
}

interface FileConversationStoreShape extends VersionedData {
  version: number;
  entries: FileConversationLink[];
  lastPruned: number;
}

const FILE_CONVERSATION_MIGRATIONS: Record<number, MigrationFn<FileConversationStoreShape>> = {
  // No migrations needed yet - store is at version 1
};

const createDefaultState = (): FileConversationStoreShape => ({
  version: FILE_CONVERSATION_STORE_VERSION,
  entries: [],
  lastPruned: Date.now()
});

let _store: KeyValueStore<FileConversationStoreShape> | null = null;
const getStore = (): KeyValueStore<FileConversationStoreShape> => {
  if (!_store) {
    _store = createStore<FileConversationStoreShape>({
      name: 'file-conversation',
      defaults: createDefaultState()
    });
  }
  return _store;
};

let readOnlyMode = false;
// Set true once load/migration has run, so the read-only flag is authoritative.
let _fileConversationMigrationRan = false;

const pruneEntries = (entries: FileConversationLink[]): FileConversationLink[] => {
  const now = Date.now();
  const maxAge = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = now - maxAge;

  // Filter by age
  const pruned = entries.filter((entry) => entry.timestamp >= cutoff);

  // Group by file and keep only most recent N per file
  const byFile = new Map<string, FileConversationLink[]>();
  for (const entry of pruned) {
    const existing = byFile.get(entry.filePath) ?? [];
    existing.push(entry);
    byFile.set(entry.filePath, existing);
  }

  // Keep only MAX_ENTRIES_PER_FILE per file (most recent)
  const result: FileConversationLink[] = [];
  for (const fileEntries of byFile.values()) {
    const sorted = fileEntries.sort((a, b) => b.timestamp - a.timestamp);
    result.push(...sorted.slice(0, MAX_ENTRIES_PER_FILE));
  }

  // Cap total entries
  if (result.length > MAX_TOTAL_ENTRIES) {
    return result
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_TOTAL_ENTRIES);
  }

  return result;
};

const loadInternal = (): FileConversationStoreShape => {
  // Guard the `.store` read + migrate: a thrown load (corrupt JSON / schema /
  // decrypt / transient IO) must NEVER reset+persist over real on-disk data.
  // The guard classifies ENOENT (fresh init) vs existing-but-unreadable
  // (preserve raw + read-only). The thunk carries the full migration result so
  // we never re-read `.store`; on `load-failed` we latch read-only + never
  // persist; on `loaded`/`absent` we honour the migration result as before.
  // NOTE: `getStore()` (conf construction) is INSIDE the thunk — conf throws at
  // construction time when the backing file is already corrupt, so the guard
  // must cover construction too. The path is derived independently
  // (`resolveConfStorePath`) so we can still classify/backup when construction
  // fails and no store instance exists.
  const result = loadStoreSafely(
    'file-conversation',
    resolveConfStorePath('file-conversation'),
    () =>
      migrateStore(getStore().store, {
        storeName: 'file-conversation',
        currentVersion: FILE_CONVERSATION_STORE_VERSION,
        migrations: FILE_CONVERSATION_MIGRATIONS,
        createDefault: createDefaultState
      }),
    // Default-factory result is consumed ONLY on the `absent` outcome (a genuine
    // ENOENT fresh init → writable). On `load-failed` the caller short-circuits
    // via isLoadFailedReadOnly() BEFORE reading shouldPersist, so `fresh` here is
    // correct for absent and never mis-applied to a preserved corrupt file.
    () => ({
      data: createDefaultState(),
      status: 'fresh' as const,
      fromVersion: null,
      toVersion: FILE_CONVERSATION_STORE_VERSION,
      backupPath: null,
      shouldPersist: true,
    }),
  );

  _fileConversationMigrationRan = true;

  if (isLoadFailedReadOnly(result)) {
    readOnlyMode = true;
    return result.data.data;
  }

  const migrationResult = result.data;
  readOnlyMode = shouldEnterReadOnlyMode(migrationResult);

  if (migrationResult.shouldPersist) {
    getStore().store = migrationResult.data;
  }

  if (migrationResult.status === 'future_version') {
    log.warn(
      { storedVersion: migrationResult.fromVersion, currentVersion: FILE_CONVERSATION_STORE_VERSION },
      'File-conversation store from newer app version - operating in read-only mode'
    );
  }

  return migrationResult.data;
};

/**
 * Read-only check that GUARANTEES load/migration has run first. A writer that
 * read the raw `readOnlyMode` as the FIRST touch (no prior read) would see a
 * stale `false` and clobber real, un-migrated data. Use in EVERY writer.
 */
const isFileConversationReadOnly = (): boolean => {
  if (!_fileConversationMigrationRan) {
    loadInternal();
  }
  return readOnlyMode;
};

const saveInternal = (state: FileConversationStoreShape): void => {
  // Ensure load/migration has run so the flag is authoritative (first-touch-safe;
  // no recursion — load never calls save).
  if (isFileConversationReadOnly()) {
    log.warn('Skipping file-conversation save - operating in read-only mode');
    return;
  }
  getStore().store = state;
};

const WINDOWS_ABSOLUTE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

function isAbsoluteCrossPlatform(filePath: string): boolean {
  return path.isAbsolute(filePath) || WINDOWS_ABSOLUTE_PATH_REGEX.test(filePath);
}

function resolvePathForComparison(filePath: string, coreDirectory?: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  if (!isAbsoluteCrossPlatform(candidate)) {
    if (!coreDirectory || !coreDirectory.trim()) return null;
    candidate = path.join(coreDirectory, candidate);
  }

  try {
    if (WINDOWS_ABSOLUTE_PATH_REGEX.test(candidate)) {
      return toPortablePath(candidate).toLowerCase();
    }
    return toPortablePath(path.resolve(candidate)).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Track a file-conversation association.
 */
export const trackFileConversation = (
  filePath: string,
  sessionId: string,
  sessionTitle: string,
  source: 'write' | 'open'
): void => {
  if (!filePath || !sessionId) {
    log.warn({ filePath, sessionId }, 'Invalid track request - missing filePath or sessionId');
    return;
  }

  const state = loadInternal();

  // Check if we already have a recent entry for this exact file+session+source combo
  const existingIndex = state.entries.findIndex(
    (e) => e.filePath === filePath && e.sessionId === sessionId && e.source === source
  );

  if (existingIndex >= 0) {
    // Update timestamp of existing entry
    state.entries[existingIndex].timestamp = Date.now();
    state.entries[existingIndex].sessionTitle = sessionTitle;
  } else {
    // Add new entry
    const newEntry: FileConversationLink = {
      id: randomUUID(),
      filePath,
      sessionId,
      sessionTitle,
      timestamp: Date.now(),
      source
    };
    state.entries.unshift(newEntry);
  }

  // Prune and save
  state.entries = pruneEntries(state.entries);
  state.lastPruned = Date.now();
  saveInternal(state);

  log.debug({ filePath, sessionId, source }, 'Tracked file-conversation link');
};

/**
 * Get conversation links for a specific file.
 */
export const getFileConversations = (filePath: string): FileConversationLink[] => {
  const state = loadInternal();
  return state.entries
    .filter((e) => e.filePath === filePath)
    .sort((a, b) => b.timestamp - a.timestamp);
};

/**
 * Get the most recent conversation link for a file.
 */
export const getMostRecentForFile = (filePath: string): FileConversationLink | null => {
  const links = getFileConversations(filePath);
  return links[0] ?? null;
};

/**
 * Returns true when the given session has tracked write activity for any file
 * at or under `directoryPath`.
 *
 * `fileConversationTrackingHook` stores paths relative to the current
 * workspace (`coreDirectory`) when possible, so callers should pass
 * `coreDirectory` to make prefix comparisons deterministic.
 */
export const hasSessionWriteInDirectory = (
  sessionId: string,
  directoryPath: string,
  coreDirectory?: string,
): boolean => {
  if (!sessionId || !directoryPath) return false;

  const normalizedDirectory = resolvePathForComparison(directoryPath, coreDirectory);
  if (!normalizedDirectory) return false;

  const state = loadInternal();
  return state.entries.some((entry) => {
    if (entry.sessionId !== sessionId || entry.source !== 'write') return false;
    const normalizedFilePath = resolvePathForComparison(entry.filePath, coreDirectory);
    if (!normalizedFilePath) return false;
    return (
      normalizedFilePath === normalizedDirectory ||
      normalizedFilePath.startsWith(normalizedDirectory + '/')
    );
  });
};

/**
 * Clear all entries (for testing or reset).
 */
export const clearFileConversations = (): void => {
  // `isFileConversationReadOnly()` forces load/migration first, so a first-touch
  // clear (no prior read) sees the correct flag and can't overwrite a real,
  // un-migrated (corrupted/future-version) file with defaults.
  if (isFileConversationReadOnly()) {
    log.warn('Skipping clear - operating in read-only mode');
    return;
  }
  getStore().store = createDefaultState();
  log.info('Cleared file-conversation store');
};
