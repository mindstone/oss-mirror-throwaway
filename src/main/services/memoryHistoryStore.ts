/**
 * Memory History Store
 *
 * Persists memory updates across sessions for the "What Rebel Knows" panel.
 * Provides aggregate view of all memory updates with filtering and stats.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import type { MemoryHistoryEntry, MemorySpaceStats, MemoryUpdateStatus } from '@shared/types';
import {
  MEMORY_HISTORY_STORE_VERSION,
  MAX_MEMORY_HISTORY_ENTRIES,
  MEMORY_HISTORY_MAX_AGE_DAYS
} from '../constants';
import { migrateStore, shouldEnterReadOnlyMode, type VersionedData, type MigrationFn, type MigrationResult } from '../utils/storeMigration';
import { loadStoreSafely, isLoadFailedReadOnly, resolveConfStorePath } from '@core/utils/loadStoreSafely';
import { toPortablePath } from '@core/utils/portablePath';

const log = createScopedLogger({ service: 'memoryHistory' });

interface MemoryHistoryStoreShape extends VersionedData {
  version: number;
  entries: MemoryHistoryEntry[];
  lastPruned: number;
  backfillCompleted: boolean;
  lastFilePathRepair?: {
    workspacePath: string;
    spacesSignature: string;
    repairedAt: number;
  };
}

const MEMORY_HISTORY_MIGRATIONS: Record<number, MigrationFn<MemoryHistoryStoreShape>> = {
  // No migrations needed yet - store is at version 1
};

const createDefaultMemoryHistoryState = (): MemoryHistoryStoreShape => ({
  version: MEMORY_HISTORY_STORE_VERSION,
  entries: [],
  lastPruned: Date.now(),
  backfillCompleted: false
});

let _memoryHistoryStore: KeyValueStore<MemoryHistoryStoreShape> | null = null;
const getMemoryHistoryStore = () => _memoryHistoryStore ??= createStore<MemoryHistoryStoreShape>({
  name: 'memory-history',
  defaults: createDefaultMemoryHistoryState()
});

let memoryHistoryReadOnlyMode = false;
/**
 * Memoized ephemeral degraded state. Once the on-disk file is classified
 * load-failed (existing-but-unreadable), `loadMemoryHistoryInternal` would
 * otherwise re-run the full (re-throwing) `.store` read + migrate on EVERY
 * getter — `getMemoryHistory`, `getMemoryStats`, `getMemoryHistoryCount`, etc.
 * are all hot-path. Read-only-until-restart means the verdict can't change this
 * session, so we cache the ephemeral defaults and short-circuit to them,
 * avoiding the repeated failing load (and the repeated `loadStoreSafely`
 * classify call, even though its noisy side effects are already deduped).
 */
let _memoryHistoryDegradedState: MemoryHistoryStoreShape | null = null;

type MemoryHistoryListener = (entries: MemoryHistoryEntry[]) => void;
const listeners = new Set<MemoryHistoryListener>();

const emitMemoryHistoryChange = (entries: MemoryHistoryEntry[]): void => {
  for (const listener of listeners) {
    try {
      listener(entries);
    } catch (error) {
      log.warn({ err: error }, 'Memory history listener failed');
    }
  }
};

const pruneOldEntries = (entries: MemoryHistoryEntry[]): MemoryHistoryEntry[] => {
  const now = Date.now();
  const maxAge = MEMORY_HISTORY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = now - maxAge;

  // Filter by age first
  let pruned = entries.filter((entry) => entry.timestamp >= cutoff);

  // Then cap at max entries (keep most recent)
  if (pruned.length > MAX_MEMORY_HISTORY_ENTRIES) {
    pruned = pruned
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_MEMORY_HISTORY_ENTRIES);
  }

  return pruned;
};

const DEFAULT_LEGACY_ENTITY = 'Memory';
const DEFAULT_LEGACY_SUMMARY = 'Memory entry';

const normalizeLegacyMemoryHistoryEntries = (
  state: MemoryHistoryStoreShape,
): {
  state: MemoryHistoryStoreShape;
  normalizedCount: number;
  entityDefaultedCount: number;
  summaryDefaultedCount: number;
} => {
  let normalizedCount = 0;
  let entityDefaultedCount = 0;
  let summaryDefaultedCount = 0;

  if (!Array.isArray(state.entries)) {
    return {
      state,
      normalizedCount,
      entityDefaultedCount,
      summaryDefaultedCount,
    };
  }

  const entries = state.entries.map((entry) => {
    const candidate = entry as MemoryHistoryEntry & { entity?: unknown; summary?: unknown };
    const entityNeedsDefault = typeof candidate.entity !== 'string' || candidate.entity.trim().length === 0;
    const summaryNeedsDefault = typeof candidate.summary !== 'string' || candidate.summary.trim().length === 0;

    if (!entityNeedsDefault && !summaryNeedsDefault) {
      return entry;
    }

    normalizedCount += 1;
    if (entityNeedsDefault) {
      entityDefaultedCount += 1;
    }
    if (summaryNeedsDefault) {
      summaryDefaultedCount += 1;
    }

    return {
      ...entry,
      entity: entityNeedsDefault ? DEFAULT_LEGACY_ENTITY : entry.entity,
      summary: summaryNeedsDefault ? DEFAULT_LEGACY_SUMMARY : entry.summary,
    };
  });

  if (normalizedCount === 0) {
    return {
      state,
      normalizedCount,
      entityDefaultedCount,
      summaryDefaultedCount,
    };
  }

  return {
    state: {
      ...state,
      entries,
    },
    normalizedCount,
    entityDefaultedCount,
    summaryDefaultedCount,
  };
};

const loadMemoryHistoryInternal = (): MemoryHistoryStoreShape => {
  // Short-circuit a previously-latched load failure: the verdict is sticky for
  // the session (read-only-until-restart), so don't re-run the failing load on
  // every hot-path getter. Serve the memoized ephemeral defaults.
  if (memoryHistoryReadOnlyMode && _memoryHistoryDegradedState !== null) {
    return _memoryHistoryDegradedState;
  }

  // Guard the `.store` read + migrate: a thrown load (corrupt JSON / schema /
  // decrypt / transient IO) must NEVER reset+persist over real on-disk data.
  // The guard classifies ENOENT (fresh init) vs existing-but-unreadable
  // (preserve raw + read-only).
  const guarded = loadStoreSafely<MigrationResult<MemoryHistoryStoreShape>>(
    'memory-history',
    resolveConfStorePath('memory-history'),
    () =>
      migrateStore(getMemoryHistoryStore().store, {
        storeName: 'memory-history',
        currentVersion: MEMORY_HISTORY_STORE_VERSION,
        migrations: MEMORY_HISTORY_MIGRATIONS,
        createDefault: createDefaultMemoryHistoryState
      }),
    // Consumed only on `absent` (genuine fresh init → writable); `load-failed`
    // short-circuits before reading shouldPersist.
    () => ({
      data: createDefaultMemoryHistoryState(),
      status: 'fresh' as const,
      fromVersion: null,
      toVersion: MEMORY_HISTORY_STORE_VERSION,
      backupPath: null,
      shouldPersist: true,
    }),
  );

  if (isLoadFailedReadOnly(guarded)) {
    // Existing-but-unreadable file: preserve it, run on ephemeral defaults, block writes.
    // Memoize the degraded state so subsequent hot-path getters short-circuit
    // above instead of re-running the failing load every time.
    memoryHistoryReadOnlyMode = true;
    if (_memoryHistoryDegradedState === null) {
      _memoryHistoryDegradedState = createDefaultMemoryHistoryState();
    }
    return _memoryHistoryDegradedState;
  }

  {
    const migrationResult = guarded.data;

    // Read-only on future_version AND corrupted. The corrupted case is critical
    // here: this caller has an EXTRA persist condition below
    // (`normalizedCount > 0 && !readOnly`). On a corrupted migration we run on
    // in-memory defaults while the real data stays on disk; setting read-only
    // ensures NEITHER the `shouldPersist` clause (already false) NOR the
    // normalization clause can write defaults over the preserved file.
    memoryHistoryReadOnlyMode = shouldEnterReadOnlyMode(migrationResult);

    const normalizationResult = normalizeLegacyMemoryHistoryEntries(migrationResult.data);

    if (migrationResult.shouldPersist || (normalizationResult.normalizedCount > 0 && !memoryHistoryReadOnlyMode)) {
      getMemoryHistoryStore().store = normalizationResult.state;
    }

    if (normalizationResult.normalizedCount > 0) {
      log.warn(
        {
          event: 'MEMORY_HISTORY_LEGACY_ENTRIES_NORMALIZED',
          normalizedCount: normalizationResult.normalizedCount,
          entityDefaultedCount: normalizationResult.entityDefaultedCount,
          summaryDefaultedCount: normalizationResult.summaryDefaultedCount,
          totalEntries: normalizationResult.state.entries.length,
          persisted: !memoryHistoryReadOnlyMode,
        },
        'Normalized malformed legacy memory history entries'
      );
    }

    if (migrationResult.status === 'future_version') {
      log.warn(
        { storedVersion: migrationResult.fromVersion, currentVersion: MEMORY_HISTORY_STORE_VERSION },
        'Memory history from newer app version - operating in read-only mode'
      );
    } else if (migrationResult.status === 'migrated') {
      log.info(
        { fromVersion: migrationResult.fromVersion, toVersion: migrationResult.toVersion },
        'Memory history migrated successfully'
      );
    }

    return normalizationResult.state;
  }
};

/**
 * Read-only check that GUARANTEES the load/migration has run first.
 *
 * `memoryHistoryReadOnlyMode` defaults to `false` and is only set during
 * `loadMemoryHistoryInternal()` (future_version / corrupted migration /
 * existing-but-unreadable load failure). A writer that read the bare flag as a
 * FIRST touch (no prior load) would see a stale `false` and bypass the guard —
 * wiping a real on-disk store. Forcing the load here (which sets the flag)
 * before reading it makes every write guard first-touch-safe by construction,
 * matching `isInboxReadOnly()` / `isAchievementsReadOnly()`. (Every public
 * mutator already loads first, so this is belt-and-braces — but by-construction
 * rather than by-convention.)
 */
const isMemoryHistoryReadOnly = (): boolean => {
  loadMemoryHistoryInternal();
  return memoryHistoryReadOnlyMode;
};

const saveMemoryHistoryInternal = (state: MemoryHistoryStoreShape): void => {
  if (isMemoryHistoryReadOnly()) {
    log.warn('Skipping memory history save - operating in read-only mode');
    return;
  }

  getMemoryHistoryStore().store = state;
};

/**
 * Get all memory history entries with optional filtering.
 */
export const getMemoryHistory = (options?: {
  space?: string;
  limit?: number;
  beforeTimestamp?: number;
}): { entries: MemoryHistoryEntry[]; hasMore: boolean } => {
  const state = loadMemoryHistoryInternal();
  let entries = [...state.entries];

  // Filter by space if specified
  if (options?.space) {
    entries = entries.filter((e) => e.entity === options.space);
  }

  // Filter by timestamp if specified
  if (options?.beforeTimestamp) {
    const cutoff = options.beforeTimestamp;
    entries = entries.filter((e) => e.timestamp < cutoff);
  }

  // Sort by timestamp descending (most recent first)
  entries.sort((a, b) => b.timestamp - a.timestamp);

  // Apply limit
  const limit = options?.limit ?? 100;
  const hasMore = entries.length > limit;
  entries = entries.slice(0, limit);

  return { entries, hasMore };
};

/**
 * Lightweight count of all memory history entries. Avoids the workspace scan
 * that `getMemoryStats` performs — suitable for hot-path callers (e.g. the
 * Daily Spark activity-baseline gate on the homepage).
 */
export const getMemoryHistoryCount = (): number => {
  const state = loadMemoryHistoryInternal();
  return state.entries.length;
};

/**
 * Get aggregate stats by space.
 */

// Import space scanning from spaceService to avoid duplication
import { scanSpaces, type SpaceInfo as SpaceServiceInfo } from './spaceService';

// Cache for scanned spaces
let cachedSpacesPromise: Promise<SpaceServiceInfo[]> | null = null;
let cachedWorkspacePath: string | null = null;

/**
 * Get spaces for a workspace (cached).
 */
const getSpacesForWorkspace = async (workspacePath: string): Promise<SpaceServiceInfo[]> => {
  if (cachedWorkspacePath === workspacePath && cachedSpacesPromise) {
    return cachedSpacesPromise;
  }
  
  cachedWorkspacePath = workspacePath;
  // Read-only consumer (memory matching) — never mutate frontmatter.
  // See docs/plans/260411_shared_space_maintenance.md Stage 3 Refinement.
  cachedSpacesPromise = scanSpaces(workspacePath, { skipAutoFix: true });
  
  const spaces = await cachedSpacesPromise;
  log.info({ workspacePath, spaceCount: spaces.length, spaces: spaces.map(s => s.path) }, 'Loaded spaces for memory matching');
  
  return spaces;
};

/**
 * Clear the cached spaces (call when workspace changes).
 */
export const clearSpacesCache = (): void => {
  cachedSpacesPromise = null;
  cachedWorkspacePath = null;
};

const MEMORY_RELATIVE_PATH_PREFIX = /^memory\//i;

const normalizeNameForMatch = (value: string | undefined): string => toPortablePath(value ?? '')
  .toLowerCase()
  .replace(/[-_/]+/g, ' ')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const findSpaceForEntity = (
  entity: string,
  spaces: readonly SpaceServiceInfo[],
): SpaceServiceInfo | undefined => {
  const normalizedEntity = normalizeNameForMatch(entity);
  if (!normalizedEntity) {
    return undefined;
  }

  const directMatches = spaces.filter((space) => {
    const displayName = normalizeNameForMatch(space.displayName);
    const name = normalizeNameForMatch(space.name);
    return displayName === normalizedEntity || name === normalizedEntity;
  });

  if (directMatches.length > 0) {
    return directMatches[0];
  }

  const segmentMatches = spaces.filter((space) => (
    toPortablePath(space.path)
      .split('/')
      .map((segment) => normalizeNameForMatch(segment))
      .includes(normalizedEntity)
  ));

  if (segmentMatches.length === 1) {
    return segmentMatches[0];
  }

  return undefined;
};

const prefixSpacePath = (spacePath: string, filePath: string): string => {
  const normalizedSpacePath = toPortablePath(spacePath).replace(/\/+$/, '');
  const normalizedFilePath = toPortablePath(filePath).replace(/^\/+/, '');
  return `${normalizedSpacePath}/${normalizedFilePath}`;
};

const buildSpacesSignature = (spaces: readonly SpaceServiceInfo[]): string => spaces
  .map((space) => toPortablePath(space.path).toLowerCase())
  .sort()
  .join('|');

const fileExists = async (absolutePath: string): Promise<boolean> => {
  try {
    await stat(absolutePath);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      return false;
    }
    log.warn({ err, absolutePath }, 'Failed to stat memory history candidate path');
    return false;
  }
};

/**
 * Normalize a file path to workspace-relative format.
 * If the path is absolute and under workspacePath, strips the prefix.
 * Returns paths with forward slashes, no leading slash for relative paths.
 */
const normalizeFilePath = (filePath: string | undefined, workspacePath?: string): string | undefined => {
  if (!filePath) return undefined;
  
  // Normalize slashes
  let normalized = toPortablePath(filePath);
  
  // If we have a workspace path and the file path is absolute, try to make it relative
  if (workspacePath && normalized.startsWith('/')) {
    const normalizedWorkspace = toPortablePath(workspacePath).replace(/\/+$/, '');
    
    // Case-insensitive comparison for matching, but preserve original case in result
    if (normalized.toLowerCase().startsWith(normalizedWorkspace.toLowerCase() + '/')) {
      normalized = normalized.slice(normalizedWorkspace.length + 1);
    } else if (normalized.toLowerCase() === normalizedWorkspace.toLowerCase()) {
      normalized = '';
    }
  }
  
  // Remove any leading slash from relative paths
  if (normalized.startsWith('/') && workspacePath) {
    // Path wasn't under workspace - leave as-is (shouldn't happen in practice)
    log.debug({ filePath, workspacePath }, 'File path not under workspace, keeping absolute');
  }
  
  return normalized || undefined;
};

export const normalizeWriteFilePath = (
  filePath: string | undefined,
  entity: string,
  workspacePath?: string,
  spaces: readonly SpaceServiceInfo[] = [],
): string | undefined => {
  if (!filePath) {
    return undefined;
  }

  const normalized = normalizeFilePath(filePath, workspacePath) ?? filePath;
  const portablePath = toPortablePath(normalized);
  if (!MEMORY_RELATIVE_PATH_PREFIX.test(portablePath)) {
    return normalized;
  }

  const matchingSpace = findSpaceForEntity(entity, spaces);
  if (!matchingSpace) {
    return normalized;
  }

  return prefixSpacePath(matchingSpace.path, portablePath);
};

/**
 * Match a file path to a space.
 * Returns [spaceName, metaSpace] where metaSpace is the company name for work/ spaces, or null.
 * Handles both workspace-relative paths and absolute paths (for backwards compatibility).
 */
const matchPathToSpace = (
  filePath: string | undefined,
  spaces: SpaceServiceInfo[],
  _workspacePath?: string
): [string, string | null] => {
  if (!filePath) return ['Unknown', null];

  const normalized = toPortablePath(filePath).toLowerCase();
  const isAbsolute = normalized.startsWith('/');

  // Find the best matching space (longest path prefix match)
  let bestMatch: SpaceServiceInfo | null = null;
  let bestMatchLength = 0;

  for (const space of spaces) {
    // Try matching against relative path (for properly normalized entries)
    const spacePath = space.path.toLowerCase();
    if (normalized.startsWith(spacePath + '/') || normalized === spacePath) {
      if (spacePath.length > bestMatchLength) {
        bestMatch = space;
        bestMatchLength = spacePath.length;
      }
    }
    
    // Also try matching against absolute path (for backwards compatibility with old entries)
    if (isAbsolute && space.absolutePath) {
      const absPath = toPortablePath(space.absolutePath).toLowerCase();
      if (normalized.startsWith(absPath + '/') || normalized === absPath) {
        if (absPath.length > bestMatchLength) {
          bestMatch = space;
          bestMatchLength = absPath.length;
        }
      }
    }
  }

  if (bestMatch) {
    // Check if this is under work/[Company]/[Space]
    const workMatch = bestMatch.path.match(/^work\/([^/]+)\/([^/]+)$/i);
    if (workMatch) {
      // Return [companyName, spaceName] for hierarchy (preserve original case)
      return [workMatch[1], bestMatch.name];
    }
    return [bestMatch.name, null];
  }

  return ['Unknown', null];
};

export const getMemoryStats = async (workspacePath?: string): Promise<{ bySpace: MemorySpaceStats[]; total: number }> => {
  await repairStaleFilePathsIfNeeded(workspacePath);
  const state = loadMemoryHistoryInternal();

  // Get spaces from workspace using spaceService
  let spaces: SpaceServiceInfo[] = [];
  if (workspacePath) {
    try {
      spaces = await getSpacesForWorkspace(workspacePath);
    } catch (error) {
      log.warn(
        { err: error, workspacePath },
        'Failed to load spaces while normalizing memory history write paths; using raw paths',
      );
    }
  }

  // Track stats by parent space, then by child space
  type SpaceData = { count: number; lastUpdated: number; visibility: 'private' | 'shared' };
  const parentMap = new Map<string, SpaceData & { children: Map<string, SpaceData> }>();

  for (const entry of state.entries) {
    const [parent, child] = matchPathToSpace(entry.filePath, spaces);

    let parentData = parentMap.get(parent);
    if (!parentData) {
      parentData = {
        count: 0,
        lastUpdated: 0,
        visibility: entry.visibility,
        children: new Map()
      };
      parentMap.set(parent, parentData);
    }

    if (child) {
      // Add to child space
      let childData = parentData.children.get(child);
      if (!childData) {
        childData = { count: 0, lastUpdated: 0, visibility: entry.visibility };
        parentData.children.set(child, childData);
      }
      childData.count++;
      if (entry.timestamp > childData.lastUpdated) {
        childData.lastUpdated = entry.timestamp;
      }
    }

    // Always count towards parent total
    parentData.count++;
    if (entry.timestamp > parentData.lastUpdated) {
      parentData.lastUpdated = entry.timestamp;
    }
  }

  // Convert to hierarchical MemorySpaceStats
  const bySpace: MemorySpaceStats[] = Array.from(parentMap.entries()).map(([space, data]) => {
    const children = data.children.size > 0
      ? Array.from(data.children.entries())
          .map(([childSpace, childData]) => ({
            space: childSpace,
            count: childData.count,
            lastUpdated: childData.lastUpdated,
            visibility: childData.visibility
          }))
          .sort((a, b) => b.count - a.count)
      : undefined;

    return {
      space,
      count: data.count,
      lastUpdated: data.lastUpdated,
      visibility: data.visibility,
      children
    };
  });

  // Sort: Known spaces by count descending, "Unknown" always at the end
  bySpace.sort((a, b) => {
    if (a.space === 'Unknown' && b.space !== 'Unknown') return 1;
    if (a.space !== 'Unknown' && b.space === 'Unknown') return -1;
    return b.count - a.count;
  });

  return { bySpace, total: state.entries.length };
};

export async function repairStaleFilePathsIfNeeded(workspacePath?: string): Promise<{
  repaired: number;
  totalScanned: number;
  skipped: boolean;
}> {
  if (!workspacePath) {
    return { repaired: 0, totalScanned: 0, skipped: true };
  }

  const state = loadMemoryHistoryInternal();
  if (state.entries.length === 0) {
    return { repaired: 0, totalScanned: 0, skipped: true };
  }

  let spaces: SpaceServiceInfo[];
  try {
    spaces = await getSpacesForWorkspace(workspacePath);
  } catch (error) {
    log.warn({ err: error, workspacePath }, 'Failed to load spaces for memory history file-path repair');
    return { repaired: 0, totalScanned: 0, skipped: true };
  }

  const normalizedWorkspacePath = toPortablePath(workspacePath);
  const spacesSignature = buildSpacesSignature(spaces);
  const previousRepair = state.lastFilePathRepair;
  if (
    previousRepair
    && previousRepair.workspacePath === normalizedWorkspacePath
    && previousRepair.spacesSignature === spacesSignature
  ) {
    return { repaired: 0, totalScanned: 0, skipped: true };
  }

  const updatedEntries = [...state.entries];
  let repaired = 0;
  let totalScanned = 0;

  for (let index = 0; index < updatedEntries.length; index += 1) {
    const entry = updatedEntries[index];
    const entryFilePath = entry?.filePath;
    if (!entryFilePath) {
      continue;
    }

    const portableFilePath = toPortablePath(entryFilePath);
    if (!MEMORY_RELATIVE_PATH_PREFIX.test(portableFilePath)) {
      continue;
    }

    totalScanned += 1;

    const recordedAbsolutePath = path.join(workspacePath, portableFilePath);
    if (await fileExists(recordedAbsolutePath)) {
      continue;
    }

    const matchingSpace = findSpaceForEntity(entry.entity, spaces);
    if (!matchingSpace) {
      continue;
    }

    const repairedFilePath = prefixSpacePath(matchingSpace.path, portableFilePath);
    if (repairedFilePath === entryFilePath) {
      continue;
    }

    const repairedAbsolutePath = path.join(workspacePath, repairedFilePath);
    if (!(await fileExists(repairedAbsolutePath))) {
      continue;
    }

    updatedEntries[index] = {
      ...entry,
      filePath: repairedFilePath,
    };
    repaired += 1;
  }

  const nextState: MemoryHistoryStoreShape = {
    ...state,
    entries: repaired > 0 ? updatedEntries : state.entries,
    lastFilePathRepair: {
      workspacePath: normalizedWorkspacePath,
      spacesSignature,
      repairedAt: Date.now(),
    },
  };

  saveMemoryHistoryInternal(nextState);
  if (repaired > 0) {
    emitMemoryHistoryChange(nextState.entries);
  }

  log.info(
    {
      event: 'MEMORY_HISTORY_REPAIR_COMPLETED',
      repaired,
      totalScanned,
      workspacePath: normalizedWorkspacePath,
    },
    'Completed memory history file-path repair sweep',
  );

  return { repaired, totalScanned, skipped: false };
}

/**
 * Add entries from a memory update status broadcast.
 * 
 * Note: This is used for background memory update turns. The `entityUpdates` are parsed
 * from the skill's text output (markdown links), which provides better summaries than
 * generic content summarization. The `autoApproveReason` field is intentionally NOT
 * propagated here because:
 * 1. Background memory updates always auto-approve (the hook skips tracking for them)
 * 2. The skill-parsed summaries are more accurate than hook-generated summaries
 * 3. The "why no approval" explanation is most useful for main conversation writes
 *    where users might wonder why they weren't prompted
 * 
 * For main conversation memory writes, see `addApprovedMemoryEntry()` which DOES
 * include `autoApproveReason` for the in-card explanation feature.
 */
export const addMemoryHistoryEntries = async (
  status: MemoryUpdateStatus,
  sessionId: string,
  sessionTitle?: string,
  workspacePath?: string,
): Promise<void> => {
  if (status.status !== 'success' || !status.entityUpdates || status.entityUpdates.length === 0) {
    return;
  }

  const spaces = workspacePath ? await getSpacesForWorkspace(workspacePath) : [];
  const state = loadMemoryHistoryInternal();
  const newEntries: MemoryHistoryEntry[] = [];

  for (const update of status.entityUpdates) {
    const normalizedFilePath = normalizeWriteFilePath(
      update.filePath,
      update.entity,
      workspacePath,
      spaces,
    );
    if (normalizedFilePath && update.filePath && normalizedFilePath !== update.filePath) {
      log.info({
        event: 'MEMORY_HISTORY_PATH_NORMALIZED',
        originalFilePath: update.filePath,
        normalizedFilePath,
        entity: update.entity,
      }, 'Normalized memory history file path');
    }

    newEntries.push({
      id: randomUUID(),
      timestamp: status.timestamp,
      sessionId,
      turnId: status.originalTurnId,
      entity: update.entity,
      visibility: update.visibility,
      action: update.action,
      summary: update.summary,
      filePath: normalizedFilePath,
      sessionTitle
    });
  }

  const updatedEntries = pruneOldEntries([...newEntries, ...state.entries]);

  const nextState: MemoryHistoryStoreShape = {
    ...state,
    entries: updatedEntries,
    lastPruned: Date.now()
  };

  saveMemoryHistoryInternal(nextState);
  emitMemoryHistoryChange(updatedEntries);

  log.debug({ count: newEntries.length, total: updatedEntries.length }, 'Added memory history entries');
};

/**
 * Add a single memory history entry for an approved memory write.
 * Called when user approves a memory write via the approval bar.
 * This ensures writes routed through the main session still get tracked as memory.
 */
export const addApprovedMemoryEntry = (params: {
  filePath: string;
  spaceName: string;
  summary: string;
  sessionId: string;
  sessionTitle?: string;
  isNew: boolean;
  workspacePath?: string;
  autoApproveReason?: MemoryHistoryEntry['autoApproveReason'];
  sharing?: MemoryHistoryEntry['sharing'];
}): void => {
  const { filePath, spaceName, summary, sessionId, sessionTitle, isNew, workspacePath, autoApproveReason, sharing } = params;
  
  // Normalize file path to workspace-relative format
  const normalizedPath = normalizeFilePath(filePath, workspacePath) ?? filePath;
  
  // Infer visibility from path
  const pathLower = toPortablePath(normalizedPath).toLowerCase();
  const visibility: 'private' | 'shared' = 
    pathLower.includes('chief-of-staff/') || pathLower.includes('/personal/')
      ? 'private'
      : 'shared';

  const state = loadMemoryHistoryInternal();
  
  const newEntry: MemoryHistoryEntry = {
    id: randomUUID(),
    timestamp: Date.now(),
    sessionId,
    turnId: `approved-${randomUUID().slice(0, 8)}`, // Synthetic turn ID for approved writes
    entity: spaceName,
    visibility,
    action: isNew ? 'created' : 'updated',
    summary,
    filePath: normalizedPath,
    sessionTitle,
    autoApproveReason,
    sharing,
  };

  const updatedEntries = pruneOldEntries([newEntry, ...state.entries]);
  
  const nextState: MemoryHistoryStoreShape = {
    ...state,
    entries: updatedEntries,
    lastPruned: Date.now()
  };

  saveMemoryHistoryInternal(nextState);
  emitMemoryHistoryChange(updatedEntries);
  
  log.info({ filePath: normalizedPath, spaceName, sessionId }, 'Added memory history entry for approved write');
};

export const repairMemoryHistoryEntryPath = (entryId: string, repairedFilePath: string): boolean => {
  if (!entryId || !repairedFilePath) {
    return false;
  }

  const state = loadMemoryHistoryInternal();
  const entryIndex = state.entries.findIndex((entry) => entry.id === entryId);
  if (entryIndex === -1) {
    log.warn({ entryId }, 'Memory history entry not found for file path repair');
    return false;
  }

  const normalizedPath = toPortablePath(repairedFilePath);
  const currentEntry = state.entries[entryIndex];
  if (currentEntry?.filePath === normalizedPath) {
    return true;
  }

  const updatedEntries = [...state.entries];
  updatedEntries[entryIndex] = {
    ...currentEntry,
    filePath: normalizedPath,
  };

  const nextState: MemoryHistoryStoreShape = {
    ...state,
    entries: updatedEntries,
  };
  saveMemoryHistoryInternal(nextState);
  emitMemoryHistoryChange(updatedEntries);

  log.info(
    {
      event: 'MEMORY_HISTORY_ENTRY_PATH_REPAIRED',
      entryId,
      originalFilePath: currentEntry?.filePath,
      repairedFilePath: normalizedPath,
    },
    'Repaired memory history entry file path',
  );

  return true;
};

/**
 * Remove a specific memory history entry.
 */
export const removeMemoryHistoryEntry = (entryId: string): boolean => {
  const state = loadMemoryHistoryInternal();
  const index = state.entries.findIndex((e) => e.id === entryId);

  if (index === -1) {
    log.warn({ entryId }, 'Memory history entry not found for removal');
    return false;
  }

  const updatedEntries = state.entries.filter((e) => e.id !== entryId);

  const nextState: MemoryHistoryStoreShape = {
    ...state,
    entries: updatedEntries
  };

  saveMemoryHistoryInternal(nextState);
  emitMemoryHistoryChange(updatedEntries);

  log.info({ entryId }, 'Removed memory history entry');
  return true;
};

/**
 * Get a single entry by ID.
 */
export const getMemoryHistoryEntry = (entryId: string): MemoryHistoryEntry | null => {
  const state = loadMemoryHistoryInternal();
  return state.entries.find((e) => e.id === entryId) ?? null;
};

/**
 * Check if backfill from session history has been completed.
 */
export const isBackfillCompleted = (): boolean => {
  const state = loadMemoryHistoryInternal();
  return state.backfillCompleted;
};

/**
 * Mark backfill as completed.
 */
export const markBackfillCompleted = (): void => {
  const state = loadMemoryHistoryInternal();
  const nextState: MemoryHistoryStoreShape = {
    ...state,
    backfillCompleted: true
  };
  saveMemoryHistoryInternal(nextState);
  log.info('Memory history backfill marked as completed');
};

/**
 * Backfill memory history from existing session history.
 * Called once on startup if not already completed.
 */
export const backfillFromSessions = (
  sessions: Array<{
    id: string;
    title?: string;
    memoryUpdateStatusByTurn?: Record<string, MemoryUpdateStatus>;
  }>
): number => {
  if (isBackfillCompleted()) {
    log.debug('Backfill already completed, skipping');
    return 0;
  }

  const state = loadMemoryHistoryInternal();
  const newEntries: MemoryHistoryEntry[] = [];

  for (const session of sessions) {
    if (!session.memoryUpdateStatusByTurn) continue;

    for (const [turnId, status] of Object.entries(session.memoryUpdateStatusByTurn)) {
      if (status.status !== 'success' || !status.entityUpdates) continue;

      for (const update of status.entityUpdates) {
        newEntries.push({
          id: randomUUID(),
          timestamp: status.timestamp,
          sessionId: session.id,
          turnId,
          entity: update.entity,
          visibility: update.visibility,
          action: update.action,
          summary: update.summary,
          filePath: update.filePath,
          sessionTitle: session.title
        });
      }
    }
  }

  if (newEntries.length === 0) {
    markBackfillCompleted();
    return 0;
  }

  const updatedEntries = pruneOldEntries([...newEntries, ...state.entries]);

  const nextState: MemoryHistoryStoreShape = {
    ...state,
    entries: updatedEntries,
    backfillCompleted: true,
    lastPruned: Date.now()
  };

  saveMemoryHistoryInternal(nextState);
  emitMemoryHistoryChange(updatedEntries);

  log.info({ backfilledCount: newEntries.length, totalCount: updatedEntries.length }, 'Backfilled memory history from sessions');
  return newEntries.length;
};
