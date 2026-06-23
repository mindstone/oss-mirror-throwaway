import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { getPlatformConfig } from '@core/platform';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { hasTerminalEvent } from './sessionMergeUtils';

const log = createScopedLogger({ service: 'inbox' });
import type {
  AgentEvent,
  AgentSession,
  TaskHistoryEntry,
  TaskQueueItem,
  TaskQueueState,
  TaskReference,
  TaskSource,
  TaskExecutionMode,
  InboxAction,
  SocialPlatform,
  InboxIndexEntry,
  InboxIndexState,
  InboxDismissReasonCategory,
  InboxItem,
  InboxItemStatus,
  InboxPriority,
  InboxItemCategory
} from '@shared/types';
import { MAX_INBOX_HISTORY_ENTRIES, INBOX_STORE_VERSION } from '../constants';
import { migrateStore, shouldEnterReadOnlyMode, type MigrationFn, type MigrationResult } from '../utils/storeMigration';
import { loadStoreSafely, isLoadFailedReadOnly, resolveConfStorePath } from '../utils/loadStoreSafely';
import { isNonEmptyString } from '@shared/utils/validators';
import {
  OTHER_PERSON_TASK_PATTERNS as _OTHER_PERSON_TASK_PATTERNS,
  hasUserActionSignal,
  isThirdPartyInitiative,
  isUserDirectedByThirdParty,
  isWinsLearningsSource,
} from '@shared/utils/inboxQualityPatterns';
import { isUserDataReadOnly } from '@core/userDataWriteGate';
import { buildAgentEvent } from '@shared/contracts/agentEventManifest';
import { TURN_INTERRUPTION_MESSAGE, type TurnInterruptionSource } from '@shared/constants/turnInterruption';

// =============================================================================
// Tombstone constants (Stage 2: delete tombstones)
// =============================================================================

/** Maximum age for tombstones before cleanup removes them. */
const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Maximum number of tombstones to keep in the index. Oldest dropped first on overflow. */
const MAX_TOMBSTONES = 500;

/**
 * Record a delete tombstone in the index store.
 * Appends `{ id, deletedAt }` to `deletedIds`, capping at MAX_TOMBSTONES (oldest dropped first).
 */
const recordTombstone = (itemId: string): void => {
  const store = getInboxIndexStore();
  const existing: Array<{ id: string; deletedAt: number }> = store.get('deletedIds') ?? [];
  const updated = [...existing, { id: itemId, deletedAt: Date.now() }];

  // Cap at MAX_TOMBSTONES — drop oldest first
  const capped = updated.length > MAX_TOMBSTONES
    ? updated.slice(updated.length - MAX_TOMBSTONES)
    : updated;

  store.set('deletedIds', capped);
};

/**
 * Remove tombstones older than 30 days.
 * Called during periodic sync to prevent unbounded growth.
 * @returns The number of tombstones removed.
 */
export const cleanupTombstones = (): number => {
  const store = getInboxIndexStore();
  const tombstones: Array<{ id: string; deletedAt: number }> = store.get('deletedIds') ?? [];
  if (tombstones.length === 0) return 0;

  const cutoff = Date.now() - TOMBSTONE_MAX_AGE_MS;
  const before = tombstones.length;
  const remaining = tombstones.filter(t => t.deletedAt >= cutoff);

  if (remaining.length !== before) {
    store.set('deletedIds', remaining);
  }
  return before - remaining.length;
};

/**
 * Get all current delete tombstones.
 * Used by pull/push reconciliation to skip deleted items.
 */
export const getDeletedIds = (): Array<{ id: string; deletedAt: number }> => {
  return getInboxIndexStore().get('deletedIds') ?? [];
};

// =============================================================================
// Status / Archived Bidirectional Sync
// =============================================================================

const VALID_STATUSES: InboxItemStatus[] = ['active', 'executing', 'completed', 'dismissed'];

/**
 * Bidirectional sync between `status` and the legacy `archived` boolean.
 * Precedence: `status` wins when both are present.
 *
 * Returns a shallow copy — never mutates the input.
 *   `const item = normalizeStatusFields({ ...original, status: 'completed' });`
 */
export const normalizeStatusFields = <T extends Partial<InboxItem>>(item: T): T => {
  const result = { ...item };
  const hasStatus = typeof result.status === 'string' && VALID_STATUSES.includes(result.status as InboxItemStatus);
  const hasArchived = typeof result.archived === 'boolean';

  if (hasStatus) {
    const s = result.status as InboxItemStatus;
    const shouldArchive = s === 'completed' || s === 'dismissed';
    result.archived = shouldArchive;

    if (shouldArchive && !result.archivedAt) {
      result.archivedAt = Date.now();
    }
    if (!shouldArchive) {
      result.archivedAt = undefined;
    }

    if (s === 'completed' && !result.completedAt) {
      result.completedAt = Date.now();
    }
    if (s !== 'completed') {
      result.completedAt = undefined;
      result.completedBy = undefined;
    }

    if (s === 'dismissed' && !result.dismissedAt) {
      result.dismissedAt = Date.now();
    }
    if (s !== 'dismissed') {
      result.dismissedAt = undefined;
      result.dismissedReason = undefined;
      result.dismissedReasonCategory = undefined;
    }
  } else if (hasArchived && !hasStatus) {
    // Legacy archived=true maps to 'completed' (the old "archive" meant "done")
    result.status = result.archived ? 'completed' : 'active';
    if (result.archived && !result.archivedAt) {
      result.archivedAt = Date.now();
    }
    if (result.archived && !result.completedAt) {
      result.completedAt = Date.now();
    }
    if (result.archived) {
      result.dismissedAt = undefined;
      result.dismissedReason = undefined;
      result.dismissedReasonCategory = undefined;
    }
    if (!result.archived) {
      result.archivedAt = undefined;
      result.completedAt = undefined;
      result.completedBy = undefined;
      result.dismissedAt = undefined;
      result.dismissedReason = undefined;
      result.dismissedReasonCategory = undefined;
    }
  }

  return result;
};

// =============================================================================
// Stage 2.1: Entry File Infrastructure
// =============================================================================

/** UUID regex for path traversal protection */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate item ID is a valid UUID (path traversal protection).
 * Returns true if valid, false otherwise.
 */
export const validateItemId = (id: string): boolean => {
  if (!id || typeof id !== 'string') return false;
  return UUID_REGEX.test(id);
};

/**
 * Get the inbox entries directory path, creating it if needed.
 */
export const getInboxDir = (): string | null => {
  const userDataPath = getPlatformConfig().userDataPath;
  const inboxDir = path.join(userDataPath, 'inbox');
  
  if (!fs.existsSync(inboxDir)) {
    fs.mkdirSync(inboxDir, { recursive: true });
    log.debug({ inboxDir }, 'Created inbox entries directory');
  }
  
  return inboxDir;
};

/**
 * Read an entry file by ID.
 * Returns null if file doesn't exist or ID is invalid.
 */
export const readEntryFile = (id: string): InboxItem | null => {
  if (!validateItemId(id)) {
    log.warn({ id }, 'Invalid item ID - possible path traversal attempt');
    return null;
  }
  
  const inboxDir = getInboxDir();
  if (!inboxDir) return null;
  
  const filePath = path.join(inboxDir, `${id}.json`);
  
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content) as InboxItem;
    if (!parsed.category) parsed.category = 'uncategorized';
    if (parsed.priority && !['p1', 'p2', 'p3'].includes(parsed.priority)) {
      const legacyMap: Record<string, InboxItem['priority']> = { high: 'p1', medium: 'p2', low: 'p3' };
      parsed.priority = legacyMap[parsed.priority] ?? 'p2';
    }
    return parsed;
  } catch (error) {
    log.warn({ id, err: error }, 'Failed to read entry file');
    return null;
  }
};

/**
 * Write an entry file atomically (temp file + rename).
 */
export const writeEntryFile = (id: string, data: InboxItem): boolean => {
  if (isUserDataReadOnly()) {
    log.warn({ id }, 'Blocked inbox entry file write — global read-only mode');
    return false;
  }
  if (!validateItemId(id)) {
    log.error({ id }, 'Invalid item ID - cannot write entry file');
    return false;
  }
  
  const inboxDir = getInboxDir();
  if (!inboxDir) return false;
  
  const filePath = path.join(inboxDir, `${id}.json`);
  const tempPath = `${filePath}.tmp`;
  
  const startMs = Date.now();
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath); // Atomic on POSIX
    // Record performance metric (dynamic import to avoid circular deps)
    const durationMs = Date.now() - startMs;
    import('./perfAccumulator').then(({ recordStoreWrite }) => {
      recordStoreWrite(durationMs, 'inbox.writeEntryFile');
    }).catch(() => { /* ignore import errors */ });
    return true;
  } catch (error) {
    log.error({ id, err: error }, 'Failed to write entry file');
    // Clean up temp file if it exists
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    return false;
  }
};

/**
 * Delete an entry file by ID.
 * Returns true if deleted or didn't exist.
 */
export const deleteEntryFile = (id: string): boolean => {
  if (isUserDataReadOnly()) {
    log.warn({ id }, 'Blocked inbox entry file delete — global read-only mode');
    return true; // Return true (success) to avoid error handling in callers
  }
  if (!validateItemId(id)) {
    log.warn({ id }, 'Invalid item ID - cannot delete entry file');
    return false;
  }
  
  const inboxDir = getInboxDir();
  if (!inboxDir) return true;
  
  const filePath = path.join(inboxDir, `${id}.json`);
  
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log.debug({ id }, 'Deleted entry file');
    }
    return true;
  } catch (error) {
    log.warn({ id, err: error }, 'Failed to delete entry file');
    return false;
  }
};

// =============================================================================
// Stage 2.2: Index Store and Loading Logic
// =============================================================================

/**
 * Convert a full inbox item to an index entry (metadata only).
 */
export const toIndexEntry = (item: InboxItem): InboxIndexEntry => ({
  id: item.id,
  title: item.title,
  archived: item.archived ?? false,
  addedAt: item.addedAt,
  archivedAt: item.archivedAt,
  sourceKind: item.source?.kind,
  priority: item.priority,
  urgent: item.urgent,
  important: item.important,
  executingSessionId: item.executingSessionId,
  relevantDate: item.relevantDate,
  dueBy: item.dueBy,
  category: item.category,
  tags: item.tags,
  confidence: item.confidence,
  autoCompleted: item.autoCompleted,
  status: item.status,
  updatedAt: item.updatedAt,
});

/**
 * Create default index state.
 */
const createDefaultIndexState = (): InboxIndexState => ({
  version: INBOX_STORE_VERSION,
  entries: [],
  history: [],
  migrationComplete: false,
});

/** Index store for inbox metadata */
let _inboxIndexStore: KeyValueStore<InboxIndexState> | null = null;
function getInboxIndexStore(): KeyValueStore<InboxIndexState> {
  if (!_inboxIndexStore) {
    _inboxIndexStore = createStore<InboxIndexState>({
      name: 'inbox-index',
      defaults: createDefaultIndexState(),
    });
  }
  return _inboxIndexStore;
}

/**
 * Load inbox items by IDs in batches.
 * Handles missing files gracefully. Limits concurrency to avoid EMFILE.
 */
export const loadInboxItems = async (ids: string[]): Promise<InboxItem[]> => {
  const BATCH_SIZE = 50;
  const results: InboxItem[] = [];
  
  // Process in batches to avoid EMFILE limits
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(id => Promise.resolve(readEntryFile(id)))
    );
    results.push(...batchResults.filter((r): r is InboxItem => r !== null));
  }
  
  return results;
};

/**
 * Load inbox index (metadata only) for fast startup.
 * Handles migration from legacy inbox.json if needed.
 */
export const loadInboxIndex = (): InboxIndexState => {
  // Run migration if not complete
  migrateLegacyInbox();
  
  const stored = getInboxIndexStore().store;
  let entries = Array.isArray(stored.entries) ? stored.entries : [];

  // Backfill: set category='uncategorized' on entries missing it.
  // Most users are already on migrationComplete=true so INBOX_MIGRATIONS
  // won't run for them — this handles those users.
  const needsBackfill = entries.some(e => !e.category);
  if (needsBackfill && !isUserDataReadOnly()) {
    entries = entries.map(e => e.category ? e : { ...e, category: 'uncategorized' as const });
    getInboxIndexStore().set('entries', entries);
    log.info({ count: entries.filter(e => e.category === 'uncategorized').length }, 'Backfilled missing category on index entries');
  }

  // Guard: remove entries that are also in history. This can happen if the
  // index was rebuilt from disk files (which outlive their index lifecycle)
  // or from race conditions during execution. History wins — the item was
  // already executed/completed.
  const history = Array.isArray(stored.history) ? stored.history : [];
  const historyIds = new Set(history.map(h => h.id));
  const entriesBeforeDedup = entries.length;
  entries = entries.filter(e => !historyIds.has(e.id));
  if (entries.length < entriesBeforeDedup && !isUserDataReadOnly()) {
    getInboxIndexStore().set('entries', entries);
    log.info({ removed: entriesBeforeDedup - entries.length }, 'Removed index entries that are also in history');
  }

  return {
    version: stored.version ?? INBOX_STORE_VERSION,
    entries,
    history,
    deletedIds: Array.isArray(stored.deletedIds) ? stored.deletedIds : undefined,
    migrationComplete: stored.migrationComplete ?? false,
  };
};

/**
 * Get a read-only snapshot of inbox index state.
 * Does NOT trigger migrations - safe for health checks.
 * Deduplicates entries vs history (same guard as loadInboxIndex).
 */
export const getInboxIndexSnapshot = (): InboxIndexState => {
  const stored = getInboxIndexStore().store;
  const history = Array.isArray(stored.history) ? stored.history : [];
  const historyIds = new Set(history.map(h => h.id));
  const entries = (Array.isArray(stored.entries) ? stored.entries : [])
    .filter(e => !historyIds.has(e.id));
  return {
    version: stored.version ?? INBOX_STORE_VERSION,
    entries,
    history,
    deletedIds: Array.isArray(stored.deletedIds) ? stored.deletedIds : undefined,
    migrationComplete: stored.migrationComplete ?? false,
  };
};

// =============================================================================
// Stage 2.3: Migration from Legacy inbox.json
// =============================================================================

/** Track if migration has run this session to avoid redundant calls */
let migrationRanThisSession = false;

/**
 * Migrate from legacy inbox.json to index + entry files.
 * Idempotent - uses migrationComplete marker and can be safely re-run.
 */
function migrateLegacyInbox(): void {
  // Skip if already migrated or already ran this session
  if (migrationRanThisSession) return;
  migrationRanThisSession = true;
  
  // Check if already migrated
  const stored = getInboxIndexStore().store;
  if (stored.migrationComplete) {
    log.debug('Legacy inbox migration already complete');
    return;
  }
  
  try {
    const userDataPath = getPlatformConfig().userDataPath;
    const legacyPath = path.join(userDataPath, 'inbox.json');
    
    // Check if legacy file exists
    if (!fs.existsSync(legacyPath)) {
      // No legacy data - mark as complete
      getInboxIndexStore().set('migrationComplete', true);
      log.debug('No legacy inbox.json found - marking migration complete');
      return;
    }
    
    // Read legacy data
    const legacyContent = fs.readFileSync(legacyPath, 'utf8');
    const legacyData = JSON.parse(legacyContent) as {
      version?: number;
      items?: TaskQueueItem[];
      history?: TaskHistoryEntry[];
    };
    
    if (!legacyData.items?.length && !legacyData.history?.length) {
      // Empty legacy data - mark as complete
      getInboxIndexStore().set('migrationComplete', true);
      log.debug('Legacy inbox.json is empty - marking migration complete');
      return;
    }
    
    const totalItems = legacyData.items?.length ?? 0;
    log.info(
      { itemCount: totalItems, historyCount: legacyData.history?.length ?? 0 },
      'Starting legacy inbox migration'
    );
    
    // Create entry files for each item (idempotent - overwrites existing)
    const indexEntries: InboxIndexEntry[] = [];
    let failedCount = 0;
    for (const item of legacyData.items ?? []) {
      // Validate or generate new UUID
      const id = validateItemId(item.id) ? item.id : randomUUID();
      const normalizedItem: InboxItem = normalizeStatusFields({
        ...item,
        id,
        archived: item.archived ?? false,
        category: (item as Record<string, unknown>).category as InboxItemCategory ?? 'uncategorized',
      });
      
      // Write entry file
      if (writeEntryFile(id, normalizedItem)) {
        indexEntries.push(toIndexEntry(normalizedItem));
      } else {
        failedCount++;
        log.warn({ itemId: item.id }, 'Failed to write entry file during migration');
      }
    }
    
    // If any items failed to migrate, don't mark as complete yet
    // This allows retry on next startup
    if (failedCount > 0) {
      log.warn(
        { failedCount, totalItems, successCount: indexEntries.length },
        'Some items failed to migrate - will retry on next startup'
      );
      migrationRanThisSession = false;
      
      // Still save successful entries to index (partial progress)
      if (indexEntries.length > 0) {
        getInboxIndexStore().set('entries', indexEntries);
      }
      return;
    }
    
    // Normalize history entries
    const history: TaskHistoryEntry[] = (legacyData.history ?? []).map(entry => ({
      ...entry,
      archived: entry.archived ?? false,
    }));
    
    // Update index store
    getInboxIndexStore().set('entries', indexEntries);
    getInboxIndexStore().set('history', history);
    getInboxIndexStore().set('version', INBOX_STORE_VERSION);
    
    // Mark migration complete only if ALL items migrated successfully
    getInboxIndexStore().set('migrationComplete', true);
    
    // Backup legacy file (non-critical - failure is OK)
    try {
      const backupPath = `${legacyPath}.migrated`;
      fs.renameSync(legacyPath, backupPath);
      log.info({ backupPath }, 'Legacy inbox.json backed up');
    } catch (err) {
      log.warn({ err }, 'Could not rename legacy inbox file (non-critical)');
    }
    
    log.info(
      { entriesCount: indexEntries.length, historyCount: history.length },
      'Legacy inbox migration completed successfully'
    );
  } catch (error) {
    log.error({ err: error }, 'Failed to migrate legacy inbox');
    // Don't mark as complete - will retry next time
    migrationRanThisSession = false;
  }
}

type InboxStoreShape = Record<string, unknown> & TaskQueueState;

/**
 * Migrate a single inbox item from v1 (read) to v2 (archived).
 * Uses destructuring to fully remove the old 'read' field.
 */
const migrateInboxItemV1ToV2 = (item: Record<string, unknown>): Record<string, unknown> => {
   
  const { read, ...rest } = item;
  return {
    ...rest,
    archived: typeof read === 'boolean' ? read : undefined,
  };
};

const INBOX_MIGRATIONS: Record<number, MigrationFn<InboxStoreShape>> = {
  // v1 -> v2: Rename 'read' to 'archived' in both items and history
  1: (data) => ({
    ...data,
    version: 2,
    items: Array.isArray(data.items)
      ? data.items.map((item) => migrateInboxItemV1ToV2(item as Record<string, unknown>) as unknown as TaskQueueItem)
      : [],
    history: Array.isArray(data.history)
      ? data.history.map((entry) => migrateInboxItemV1ToV2(entry as Record<string, unknown>) as unknown as TaskHistoryEntry)
      : [],
  }),
  // v2 -> v3: Add priority field (defaults to 'p2')
  2: (data) => ({
    ...data,
    version: 3,
    items: Array.isArray(data.items)
      ? data.items.map((item) => ({
          ...item,
          priority: (item as Record<string, unknown>).priority ?? 'p2',
        }) as unknown as TaskQueueItem)
      : [],
    history: Array.isArray(data.history)
      ? data.history.map((entry) => ({
          ...entry,
          priority: (entry as Record<string, unknown>).priority ?? 'p2',
        }) as unknown as TaskHistoryEntry)
      : [],
  }),
  // v3 -> v4: Add urgent/important fields (Eisenhower Matrix)
  // Migration logic: p1 -> urgent+important, p2 -> important only, p3 -> neither
  3: (data) => {
    const migrateItem = (item: Record<string, unknown>) => {
      const priority = item.priority as string | undefined;
      return {
        ...item,
        urgent: priority === 'p1',
        important: priority === 'p1' || priority === 'p2',
      };
    };
    return {
      ...data,
      version: 4,
      items: Array.isArray(data.items)
        ? data.items.map((item) => migrateItem(item as Record<string, unknown>) as unknown as TaskQueueItem)
        : [],
      history: Array.isArray(data.history)
        ? data.history.map((entry) => migrateItem(entry as Record<string, unknown>) as unknown as TaskHistoryEntry)
        : [],
    };
  },
  // v4 -> v5: Add category field (origin/intent) — defaults to 'uncategorized'
  4: (data) => ({
    ...data,
    version: 5,
    items: Array.isArray(data.items)
      ? data.items.map((item) => ({
          ...item,
          category: (item as Record<string, unknown>).category ?? 'uncategorized',
        }) as unknown as TaskQueueItem)
      : [],
    history: Array.isArray(data.history)
      ? data.history.map((entry) => ({
          ...entry,
          category: (entry as Record<string, unknown>).category ?? 'uncategorized',
        }) as unknown as TaskHistoryEntry)
      : [],
  }),
  // v5 -> v6: Add tags field — no-op (tags default to undefined)
  5: (data) => ({ ...data, version: 6 }),
};

const sanitizeLabel = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const MAX_TAGS_PER_ITEM = 20;

/**
 * Normalize tags: trim, lowercase, deduplicate, filter empty, limit count.
 * Returns undefined when the result is empty (avoids storing `[]` in entry files).
 */
export const normalizeTags = (tags: unknown): string[] | undefined => {
  if (!Array.isArray(tags)) return undefined;
  const normalized = tags
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, MAX_TAGS_PER_ITEM);
  return normalized.length > 0 ? normalized : undefined;
};

export const sanitizeTaskReference = (reference: unknown): TaskReference | null => {
  if (!reference || typeof reference !== 'object') {
    return null;
  }
  const ref = reference as Record<string, unknown>;
  if (ref.kind === 'workspace' && typeof ref.path === 'string' && ref.path.trim().length > 0) {
    return {
      kind: 'workspace',
      path: ref.path.trim(),
      label: sanitizeLabel(ref.label)
    };
  }
  if (ref.kind === 'url' && typeof ref.url === 'string' && ref.url.trim().length > 0) {
    return {
      kind: 'url',
      url: ref.url.trim(),
      label: sanitizeLabel(ref.label)
    };
  }
  if (ref.kind === 'email' && typeof ref.threadId === 'string' && ref.threadId.trim().length > 0) {
    return {
      kind: 'email',
      threadId: ref.threadId.trim(),
      messageId: typeof ref.messageId === 'string' && ref.messageId.trim().length > 0
        ? ref.messageId.trim()
        : undefined,
      provider: ref.provider === 'gmail' || ref.provider === 'outlook'
        ? ref.provider
        : undefined,
      label: sanitizeLabel(ref.label),
    };
  }
  if (ref.kind === 'linear' && typeof ref.issueId === 'string' && ref.issueId.trim().length > 0) {
    return {
      kind: 'linear',
      issueId: ref.issueId.trim(),
      label: sanitizeLabel(ref.label),
    };
  }
  if (ref.kind === 'github' && typeof ref.owner === 'string' && ref.owner.trim().length > 0
    && typeof ref.repo === 'string' && ref.repo.trim().length > 0
    && typeof ref.issueNumber === 'number' && Number.isInteger(ref.issueNumber) && ref.issueNumber > 0) {
    return {
      kind: 'github',
      owner: ref.owner.trim(),
      repo: ref.repo.trim(),
      issueNumber: ref.issueNumber,
      label: sanitizeLabel(ref.label),
    };
  }
  if (ref.kind === 'asana' && typeof ref.taskId === 'string' && ref.taskId.trim().length > 0) {
    return {
      kind: 'asana',
      taskId: ref.taskId.trim(),
      label: sanitizeLabel(ref.label),
    };
  }
  return null;
};

const sanitizeTaskSource = (source: unknown): TaskSource | null => {
  if (!source || typeof source !== 'object') {
    return null;
  }
  const value = source as Record<string, unknown>;
  if (value.kind === 'text' && typeof value.label === 'string' && value.label.trim().length > 0) {
    return {
      kind: 'text',
      label: value.label.trim()
    };
  }
  if (value.kind === 'workspace' && typeof value.path === 'string' && value.path.trim().length > 0) {
    return {
      kind: 'workspace',
      path: value.path.trim(),
      label: sanitizeLabel(value.label)
    };
  }
  if (value.kind === 'automation' && typeof value.automationId === 'string' && value.automationId.trim().length > 0
      && typeof value.automationName === 'string' && value.automationName.trim().length > 0) {
    return {
      kind: 'automation',
      automationId: value.automationId.trim(),
      automationName: value.automationName.trim(),
      label: sanitizeLabel(value.label)
    };
  }
  if (value.kind === 'role' && typeof value.roleId === 'string' && value.roleId.trim().length > 0
      && typeof value.roleName === 'string' && value.roleName.trim().length > 0) {
    return {
      kind: 'role',
      roleId: value.roleId.trim(),
      roleName: value.roleName.trim(),
      rhythmLabel: typeof value.rhythmLabel === 'string' && value.rhythmLabel.trim().length > 0
        ? value.rhythmLabel.trim()
        : undefined,
      label: sanitizeLabel(value.label)
    };
  }
  if (value.kind === 'meeting') {
    return {
      kind: 'meeting',
      meetingId: typeof value.meetingId === 'string' && value.meetingId.trim().length > 0 ? value.meetingId.trim() : undefined,
      meetingTitle: typeof value.meetingTitle === 'string' && value.meetingTitle.trim().length > 0 ? value.meetingTitle.trim() : undefined,
      label: sanitizeLabel(value.label)
    };
  }
  if (value.kind === 'conversation' && typeof value.sessionId === 'string' && value.sessionId.trim().length > 0) {
    return {
      kind: 'conversation',
      sessionId: value.sessionId.trim(),
      label: sanitizeLabel(value.label)
    };
  }
  return null;
};

const VALID_SOCIAL_PLATFORMS: SocialPlatform[] = ['twitter', 'linkedin', 'facebook'];

const sanitizeInboxAction = (action: unknown): InboxAction | null => {
  if (!action || typeof action !== 'object') {
    return null;
  }
  const value = action as Record<string, unknown>;
  if (value.type === 'execute') {
    return { type: 'execute' };
  }
  if (value.type === 'shareToSocial' && typeof value.text === 'string' && value.text.trim().length > 0) {
    const platforms = Array.isArray(value.platforms)
      ? value.platforms.filter((p): p is SocialPlatform => VALID_SOCIAL_PLATFORMS.includes(p as SocialPlatform))
      : undefined;
    return {
      type: 'shareToSocial',
      text: value.text.trim(),
      url: typeof value.url === 'string' && value.url.trim().length > 0 ? value.url.trim() : undefined,
      platforms: platforms && platforms.length > 0 ? platforms : undefined
    };
  }
  return null;
};

const sanitizeInboxActions = (actions: unknown): InboxAction[] | undefined => {
  if (!Array.isArray(actions)) {
    return undefined;
  }
  const sanitized = actions
    .map(sanitizeInboxAction)
    .filter((a): a is InboxAction => a !== null);
  return sanitized.length > 0 ? sanitized : undefined;
};

const createDefaultInboxItems = (): TaskQueueItem[] => [];

const createDefaultInboxState = (): InboxStoreShape => ({
  version: INBOX_STORE_VERSION,
  items: createDefaultInboxItems(),
  history: []
});

const migrateTaskQueueToInbox = (): void => {
  try {
    const userDataPath = getPlatformConfig().userDataPath;
    const oldPath = path.join(userDataPath, 'task-queue.json');
    const newPath = path.join(userDataPath, 'inbox.json');
    
    const oldExists = fs.existsSync(oldPath);
    const newExists = fs.existsSync(newPath);
    
    if (!oldExists) {
      return;
    }
    
    if (!newExists) {
      fs.renameSync(oldPath, newPath);
      log.info({ oldPath, newPath }, 'Migrated task-queue.json to inbox.json');
      return;
    }
    
    // Both files exist - prefer the one with more items
    const oldData = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    const newData = JSON.parse(fs.readFileSync(newPath, 'utf8'));
    const oldItemCount = (oldData.items?.length ?? 0) + (oldData.history?.length ?? 0);
    const newItemCount = (newData.items?.length ?? 0) + (newData.history?.length ?? 0);
    
    if (oldItemCount > newItemCount) {
      fs.unlinkSync(newPath);
      fs.renameSync(oldPath, newPath);
      log.info({ oldPath, newPath, oldItemCount, newItemCount }, 'Migrated task-queue.json to inbox.json (old had more data)');
    } else if (oldItemCount > 0 && oldItemCount === newItemCount) {
      // Same count, keep new and remove old
      fs.unlinkSync(oldPath);
      log.info({ oldPath }, 'Removed task-queue.json (inbox.json already has same data)');
    } else {
      // New has more or old is empty, just remove old
      fs.unlinkSync(oldPath);
      log.info({ oldPath }, 'Removed empty/stale task-queue.json');
    }
  } catch (error) {
    log.warn({ err: error }, 'Failed to migrate task-queue.json to inbox.json');
  }
};

let _migrationRan = false;
const ensureTaskQueueMigration = (): void => {
  if (_migrationRan) return;
  _migrationRan = true;
  migrateTaskQueueToInbox();
};

let _inboxStore: KeyValueStore<InboxStoreShape> | null = null;
const getInboxStore = (): KeyValueStore<InboxStoreShape> => {
  if (!_inboxStore) {
    ensureTaskQueueMigration();
    _inboxStore = createStore<InboxStoreShape>({
      name: 'inbox',
      defaults: createDefaultInboxState()
    });
  }
  return _inboxStore;
};

type InboxListener = (state: TaskQueueState) => void;
const listeners = new Set<InboxListener>();

export const emitInboxState = (state: TaskQueueState): void => {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (error) {
      log.warn({ err: error }, 'Inbox listener failed');
    }
  }
};

export const onInboxStateChange = (listener: InboxListener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** @deprecated Use onInboxStateChange */
export const onTaskQueueStateChange = onInboxStateChange;

const normalizeInboxItem = (item: unknown, fallbackTitle: string): TaskQueueItem | null => {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const data = item as Record<string, unknown>;
  const title = isNonEmptyString(data.title) ? data.title.trim() : fallbackTitle;
  const text = isNonEmptyString(data.text) ? data.text.trim() : title;
  const addedAt = typeof data.addedAt === 'number' && Number.isFinite(data.addedAt) ? data.addedAt : Date.now();
  const referencesRaw = Array.isArray(data.references) ? data.references : [];
  const references = referencesRaw.map(sanitizeTaskReference).filter((ref): ref is TaskReference => Boolean(ref));
  const source = sanitizeTaskSource(data.source) ?? undefined;
  const id = isNonEmptyString(data.id) ? data.id.trim() : randomUUID();
  // Support both 'archived' (new) and 'read' (legacy) field names for robustness.
  // Default to false so items without the field are treated as active (not undefined).
  const archived = typeof data.archived === 'boolean' ? data.archived : undefined;
  const read = typeof data.read === 'boolean' ? data.read : undefined;
  const effectiveArchived = archived ?? read ?? false;
  const archivedAt = typeof data.archivedAt === 'number' && Number.isFinite(data.archivedAt) ? data.archivedAt : undefined;
  const actions = sanitizeInboxActions(data.actions);
  // Eisenhower matrix fields
  const priority = typeof data.priority === 'string' && ['p1', 'p2', 'p3'].includes(data.priority) 
    ? data.priority as InboxPriority 
    : undefined;
  const urgent = typeof data.urgent === 'boolean' ? data.urgent : undefined;
  const important = typeof data.important === 'boolean' ? data.important : undefined;
  // Content fields
  const clarifyingQuestion = isNonEmptyString(data.clarifyingQuestion) ? data.clarifyingQuestion.trim() : undefined;
  const draft = isNonEmptyString(data.draft) ? data.draft.trim() : undefined;
  // Execution tracking
  const executingSessionId = isNonEmptyString(data.executingSessionId) ? data.executingSessionId.trim() : undefined;
  // Time-relevance
  const relevantDate = typeof data.relevantDate === 'number' && Number.isFinite(data.relevantDate) ? data.relevantDate : undefined;
  // Category (origin/intent) — defaults to 'uncategorized' for items without a category (backward compat with pre-v5 data)
  const VALID_CATEGORIES: InboxItemCategory[] = ['user-request', 'automation', 'meeting-action', 'follow-up', 'system', 'uncategorized'];
  const category: InboxItemCategory = typeof data.category === 'string' && VALID_CATEGORIES.includes(data.category as InboxItemCategory)
    ? data.category as InboxItemCategory
    : 'uncategorized';
  // Topic tags
  const tags = normalizeTags(data.tags);
  // Temporal + confidence fields
  const dueBy = typeof data.dueBy === 'number' && Number.isFinite(data.dueBy) ? data.dueBy : undefined;
  const confidence = typeof data.confidence === 'string' && ['high', 'medium', 'low'].includes(data.confidence)
    ? data.confidence as 'high' | 'medium' | 'low'
    : undefined;
  const actionLabel = isNonEmptyString(data.actionLabel) ? data.actionLabel.trim() : undefined;
  const autoCompleted = typeof data.autoCompleted === 'boolean' ? data.autoCompleted : undefined;
  // Status lifecycle fields
  const status = typeof data.status === 'string' && VALID_STATUSES.includes(data.status as InboxItemStatus)
    ? data.status as InboxItemStatus
    : undefined;
  const completedBy = typeof data.completedBy === 'string' && ['user', 'rebel'].includes(data.completedBy)
    ? data.completedBy as 'user' | 'rebel'
    : undefined;
  const completedAt = typeof data.completedAt === 'number' && Number.isFinite(data.completedAt) ? data.completedAt : undefined;
  const dismissedAt = typeof data.dismissedAt === 'number' && Number.isFinite(data.dismissedAt) ? data.dismissedAt : undefined;
  const updatedAt = typeof data.updatedAt === 'number' && Number.isFinite(data.updatedAt) ? data.updatedAt : undefined;
  return normalizeStatusFields({
    id,
    title,
    text,
    source,
    references,
    addedAt,
    archived: effectiveArchived,
    archivedAt,
    actions,
    priority,
    urgent,
    important,
    clarifyingQuestion,
    draft,
    executingSessionId,
    relevantDate,
    category,
    tags,
    dueBy,
    confidence,
    actionLabel,
    autoCompleted,
    status,
    completedBy,
    completedAt,
    dismissedAt,
    updatedAt,
  });
};

const normalizeInboxHistoryEntry = (entry: unknown, fallbackTitle: string): TaskHistoryEntry | null => {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const base = normalizeInboxItem(entry, fallbackTitle);
  if (!base) {
    return null;
  }
  const data = entry as Record<string, unknown>;
  const executedAt = typeof data.executedAt === 'number' && Number.isFinite(data.executedAt) ? data.executedAt : Date.now();
  const sessionId = isNonEmptyString(data.sessionId) ? data.sessionId.trim() : randomUUID();
  const mode = data.mode === 'execute_with_context' ? 'execute_with_context' : 'execute';
  return {
    ...base,
    executedAt,
    sessionId,
    mode
  };
};

const clampInboxHistoryEntries = (entries: TaskHistoryEntry[]): TaskHistoryEntry[] =>
  entries.slice(0, MAX_INBOX_HISTORY_ENTRIES);

let inboxReadOnlyMode = false;
/**
 * Memoized ephemeral degraded state. `loadInboxInternal` is called from many
 * hot-path getters; once the legacy `inbox.json` is classified load-failed
 * (existing-but-unreadable), re-running the (re-throwing) `.store` read + migrate
 * on every call is pure waste — the read-only-until-restart verdict can't change
 * this session. Cache the ephemeral defaults and short-circuit to them.
 */
let _inboxDegradedState: InboxStoreShape | null = null;

/** Check both per-store and global read-only flags */
const isInboxReadOnly = (): boolean => inboxReadOnlyMode || isUserDataReadOnly();

const loadInboxInternal = (): InboxStoreShape => {
  // Short-circuit a previously-latched load failure: serve memoized ephemeral
  // defaults instead of re-running the failing load on every getter.
  if (inboxReadOnlyMode && _inboxDegradedState !== null) {
    return _inboxDegradedState;
  }

  // Guard the `.store` read + migrate: a thrown load (corrupt JSON / schema /
  // decrypt / transient IO) must NEVER reset+persist over the real on-disk inbox.
  // The guard classifies ENOENT (fresh init) vs existing-but-unreadable
  // (preserve raw + read-only).
  const guarded = loadStoreSafely<MigrationResult<InboxStoreShape>>(
    'inbox',
    resolveConfStorePath('inbox'),
    () =>
      migrateStore<InboxStoreShape>(getInboxStore().store, {
        storeName: 'inbox',
        currentVersion: INBOX_STORE_VERSION,
        migrations: INBOX_MIGRATIONS,
        createDefault: createDefaultInboxState
      }),
    // Consumed only on `absent` (genuine fresh init → writable); `load-failed`
    // short-circuits before reading shouldPersist.
    () => ({
      data: createDefaultInboxState(),
      status: 'fresh' as const,
      fromVersion: null,
      toVersion: INBOX_STORE_VERSION,
      backupPath: null,
      shouldPersist: true,
    }),
  );

  if (isLoadFailedReadOnly(guarded)) {
    // Existing-but-unreadable inbox file: preserve it, run on ephemeral
    // in-memory defaults this session, block all writes. Memoize so subsequent
    // getters short-circuit above instead of re-running the failing load.
    inboxReadOnlyMode = true;
    if (_inboxDegradedState === null) {
      _inboxDegradedState = createDefaultInboxState();
    }
    return _inboxDegradedState;
  }

  {
    const migrationResult = guarded.data;

    // Track read-only mode for future version protection AND corrupted
    // migrations. The corrupted case is critical here: the post-normalize
    // persist below (`if (!isInboxReadOnly()) getInboxStore().store = normalized`)
    // would otherwise write the empty normalized DEFAULTS over the user's real
    // inbox file. Treating corrupted as read-only blocks that write and all
    // later saves, preserving the on-disk data + the pre-migration backup.
    inboxReadOnlyMode = shouldEnterReadOnlyMode(migrationResult);

    // Persist migrated data if needed (but not for future versions)
    if (migrationResult.shouldPersist) {
      getInboxStore().store = migrationResult.data;
    }

    // Log migration status
    if (migrationResult.status === 'future_version') {
      log.warn(
        {
          storedVersion: migrationResult.fromVersion,
          currentVersion: INBOX_STORE_VERSION
        },
        'Inbox from newer app version - operating in read-only mode to prevent data loss'
      );
    } else if (migrationResult.status === 'migrated') {
      log.info(
        {
          fromVersion: migrationResult.fromVersion,
          toVersion: migrationResult.toVersion,
          backupPath: migrationResult.backupPath
        },
        'Inbox migrated successfully'
      );
    }

    // Support both old "tasks" and new "items" property for backwards compatibility
    // Prefer non-empty items array, otherwise fall back to tasks (nullish coalesce doesn't work for empty arrays)
    const dataItems = (migrationResult.data as unknown as Record<string, unknown>).items;
    const dataTasks = (migrationResult.data as unknown as Record<string, unknown>).tasks;
    const rawItems = Array.isArray(dataItems) && dataItems.length > 0 ? dataItems : dataTasks;
    const items = Array.isArray(rawItems)
      ? rawItems
          .map((item, index) => normalizeInboxItem(item, `Item ${index + 1}`))
          .filter((item): item is TaskQueueItem => Boolean(item))
      : [];
    const history = Array.isArray(migrationResult.data.history)
      ? migrationResult.data.history
          .map((entry, index) => normalizeInboxHistoryEntry(entry, `History ${index + 1}`))
          .filter((entry): entry is TaskHistoryEntry => Boolean(entry))
      : [];

    const normalized: InboxStoreShape = {
      version: INBOX_STORE_VERSION,
      items,
      history: clampInboxHistoryEntries(history)
    };
    
    // Only persist normalized data if not in read-only mode
    if (!isInboxReadOnly()) {
      getInboxStore().store = normalized;
    }

    return normalized;
  }
};

const saveInboxInternal = (state: TaskQueueState): void => {
  // Load/migrate FIRST so a first-touch save (e.g. the exported `saveInboxState`
  // called with no prior read) sets `inboxReadOnlyMode` before we check it.
  // `loadInboxInternal()` does not write via this function, so there is no
  // recursion; without it a first-touch save would see a stale `false` flag and
  // clobber a real, un-migrated (corrupted/future-version) inbox file.
  loadInboxInternal();
  // Prevent writes in read-only mode (future version or global version gate)
  if (isInboxReadOnly()) {
    log.warn('Skipping inbox save - operating in read-only mode due to future version');
    return;
  }

  const items = state.items
    .map((item, index) => normalizeInboxItem(item, `Item ${index + 1}`))
    .filter((item): item is TaskQueueItem => Boolean(item));
  const history = state.history
    .map((entry, index) => normalizeInboxHistoryEntry(entry, `History ${index + 1}`))
    .filter((entry): entry is TaskHistoryEntry => Boolean(entry));

  const persistedState: InboxStoreShape = {
    version: INBOX_STORE_VERSION,
    items,
    history: clampInboxHistoryEntries(history)
  };
  getInboxStore().store = persistedState;
};

/**
 * Get the full inbox state.
 * Uses the new index + entry files system after migration.
 * Falls back to legacy load for backwards compatibility.
 */
export const getInboxState = (): TaskQueueState => {
  // Check if using new system (migration complete)
  const index = loadInboxIndex();
  if (index.migrationComplete) {
    // Load all items from entry files. Normalize archived from the index entry
    // (source of truth) since entry files may have archived as undefined.
    const items: TaskQueueItem[] = index.entries
      .map((entry): TaskQueueItem | null => {
        const item = readEntryFile(entry.id);
        if (!item) return null;
        return { ...item, archived: entry.archived };
      })
      .filter((item): item is TaskQueueItem => item !== null);
    
    return {
      version: INBOX_STORE_VERSION,
      items,
      history: index.history,
    };
  }
  
  // Fall back to legacy load
  return loadInboxInternal();
};

/** @deprecated Use getInboxState */
export const getTaskQueueState = getInboxState;

const DEFAULT_FEEDBACK_EXAMPLE_LIMIT = 5;
const MAX_FEEDBACK_EXAMPLE_LIMIT = 20;
const DEFAULT_FEEDBACK_MAX_AGE_DAYS = 90;
const FEEDBACK_TEXT_MAX_CHARS = 240;

const clampFeedbackLimit = (limit: number | undefined): number => {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_FEEDBACK_EXAMPLE_LIMIT;
  return Math.max(1, Math.min(MAX_FEEDBACK_EXAMPLE_LIMIT, Math.floor(limit)));
};

const truncateFeedbackText = (text: string | undefined): string | undefined => {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > FEEDBACK_TEXT_MAX_CHARS
    ? `${trimmed.slice(0, FEEDBACK_TEXT_MAX_CHARS - 1)}…`
    : trimmed;
};

const getSourceLabel = (source: TaskSource | null | undefined): string | undefined => {
  if (!source) return undefined;
  if ('label' in source && source.label) return source.label;
  switch (source.kind) {
    case 'automation':
      return source.automationName;
    case 'meeting':
      return source.meetingTitle;
    case 'workspace':
      return source.path;
    case 'conversation':
      return source.sessionId;
    case 'role':
      return source.roleName;
    case 'text':
      return source.label;
    default:
      return (source as { kind?: string }).kind;
  }
};

const sourceMatchesFeedbackQuery = (source: TaskSource | null | undefined, query: InboxFeedbackQuery): boolean => {
  if (query.sourceKind && source?.kind !== query.sourceKind) return false;
  if (query.automationId) {
    if (source?.kind !== 'automation' || source.automationId !== query.automationId) return false;
  }
  if (query.automationName) {
    if (source?.kind !== 'automation') return false;
    if (source.automationName.toLowerCase() !== query.automationName.toLowerCase()) return false;
  }
  return true;
};

/**
 * Return bounded dismissal feedback examples for agent calibration.
 *
 * This intentionally derives examples from existing dismissed items instead of
 * storing learned keyword rules. Callers should present these as weak examples
 * of past misses, scoped by source/category, not as suppression rules.
 */
export const getInboxFeedbackExamples = (query: InboxFeedbackQuery = {}): InboxFeedbackExample[] => {
  const state = getInboxState();
  const limit = clampFeedbackLimit(query.limit);
  const maxAgeDays = typeof query.maxAgeDays === 'number' && Number.isFinite(query.maxAgeDays)
    ? Math.max(1, query.maxAgeDays)
    : DEFAULT_FEEDBACK_MAX_AGE_DAYS;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  return state.items
    .filter((item) => {
      const hasFeedback = Boolean(item.dismissedReasonCategory || item.dismissedReason?.trim());
      if (!hasFeedback || item.status !== 'dismissed') return false;
      if (query.category && item.category !== query.category) return false;
      if (!sourceMatchesFeedbackQuery(item.source, query)) return false;
      const dismissedAt = item.dismissedAt ?? item.archivedAt ?? item.updatedAt ?? item.addedAt;
      return dismissedAt >= cutoff;
    })
    .sort((a, b) => {
      const aTime = a.dismissedAt ?? a.archivedAt ?? a.updatedAt ?? a.addedAt;
      const bTime = b.dismissedAt ?? b.archivedAt ?? b.updatedAt ?? b.addedAt;
      return bTime - aTime;
    })
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      title: item.title,
      text: truncateFeedbackText(item.text),
      category: item.category,
      sourceKind: item.source?.kind,
      sourceLabel: getSourceLabel(item.source),
      sourceAutomationId: item.source?.kind === 'automation' ? item.source.automationId : undefined,
      sourceAutomationName: item.source?.kind === 'automation' ? item.source.automationName : undefined,
      dismissedReasonCategory: item.dismissedReasonCategory,
      dismissedReason: truncateFeedbackText(item.dismissedReason),
      dismissedAt: item.dismissedAt ?? item.archivedAt,
      addedAt: item.addedAt,
    }));
};

export interface TaskMutationInput {
  /** Pre-generated UUID for deterministic dual-write (desktop + cloud get same ID) */
  id?: string;
  title: string;
  text?: string;
  source?: TaskSource | null;
  references?: TaskReference[] | null;
  actions?: InboxAction[] | null;
  /** @deprecated Use urgent + important instead */
  priority?: InboxPriority;
  /** Eisenhower: requires immediate attention. Default: false */
  urgent?: boolean;
  /** Eisenhower: matters for goals/values. Default: true */
  important?: boolean;
  /** Optional clarifying question from Rebel */
  clarifyingQuestion?: string;
  /** Pre-drafted deliverable (email, post, document) ready for user approval */
  draft?: string;
  /** Archive status - true to archive, false to unarchive */
  archived?: boolean;
  /** Epoch ms after which this item is no longer actionable (e.g. the event it refers to has passed) */
  relevantDate?: number;
  /** Origin/intent category for filtering and analytics */
  category?: InboxItemCategory;
  /** Free-form topic tags for filtering and search */
  tags?: string[];
  /** Epoch ms by which this item should be completed (for temporal grouping) */
  dueBy?: number;
  /** Rebel's confidence that this item is actionable */
  confidence?: 'high' | 'medium' | 'low';
  /** CTA label override (e.g. "Review draft", "Send email") */
  actionLabel?: string;
  /** Whether Rebel auto-completed this item */
  autoCompleted?: boolean;
}

const buildInboxItemFromMutation = (input: TaskMutationInput): TaskQueueItem => {
  const title = input.title.trim();
  const text = input.text && input.text.trim().length > 0 ? input.text.trim() : title;
  const references = Array.isArray(input.references)
    ? input.references.map(sanitizeTaskReference).filter((ref): ref is TaskReference => Boolean(ref))
    : [];
  const source = input.source ? sanitizeTaskSource(input.source) ?? undefined : undefined;
  const actions = input.actions ? sanitizeInboxActions(input.actions) : undefined;
  const priority = input.priority ?? 'p2';
  // Eisenhower fields:
  // - If urgent/important explicitly provided, use them
  // - urgent: derive from priority for backwards compat
  // - important: for agent-created items (meeting-action, follow-up, automation),
  //   derive from action signals in the title — items without action verbs get
  //   important=false so they don't compete for homepage real estate.
  //   user-request items always default to important=true (user is trusted).
  const urgent = input.urgent ?? (input.priority === 'p1');
  const AGENT_CATEGORIES: InboxItemCategory[] = ['meeting-action', 'follow-up', 'automation'];
  const isAgentCreated = input.category != null && AGENT_CATEGORIES.includes(input.category);
  const important = input.important
    ?? (isAgentCreated
      ? (!!input.draft?.trim() || !!input.clarifyingQuestion?.trim() || input.urgent === true || hasUserActionSignal(title))
      : (input.priority !== 'p3'));
  const clarifyingQuestion = input.clarifyingQuestion?.trim() || undefined;
  const draft = input.draft?.trim() || undefined;
  const relevantDate = typeof input.relevantDate === 'number' && Number.isFinite(input.relevantDate)
    ? input.relevantDate
    : undefined;
  const VALID_CATEGORIES: InboxItemCategory[] = ['user-request', 'automation', 'meeting-action', 'follow-up', 'system', 'uncategorized'];
  const category: InboxItemCategory = input.category && VALID_CATEGORIES.includes(input.category)
    ? input.category
    : 'uncategorized';
  const tags = normalizeTags(input.tags);
  const dueBy = typeof input.dueBy === 'number' && Number.isFinite(input.dueBy) ? input.dueBy : undefined;
  const confidence = input.confidence && ['high', 'medium', 'low'].includes(input.confidence)
    ? input.confidence
    : undefined;
  const actionLabel = input.actionLabel?.trim() || undefined;
  const autoCompleted = typeof input.autoCompleted === 'boolean' ? input.autoCompleted : undefined;
  const id = input.id && validateItemId(input.id) ? input.id : (() => {
    if (input.id) log.debug({ providedId: input.id }, 'Invalid ID provided, generating new UUID');
    return randomUUID();
  })();
  return {
    id,
    title,
    text,
    source,
    references,
    addedAt: Date.now(),
    updatedAt: Date.now(),
    actions,
    priority,
    urgent,
    important,
    clarifyingQuestion,
    draft,
    relevantDate,
    category,
    tags,
    dueBy,
    confidence,
    actionLabel,
    autoCompleted,
  };
};

// =============================================================================
// Write-time quality filtering (Stage 6)
// =============================================================================

/**
 * Compute normalized string similarity (0–1) using bigram Dice coefficient.
 * Multiset-aware: counts repeated bigrams for better precision.
 */
export const normalizedSimilarity = (a: string, b: string): number => {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;

  const bigramsA = new Map<string, number>();
  for (let i = 0; i < na.length - 1; i++) {
    const bg = na.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) ?? 0) + 1);
  }

  const bigramsB = new Map<string, number>();
  for (let i = 0; i < nb.length - 1; i++) {
    const bg = nb.slice(i, i + 2);
    bigramsB.set(bg, (bigramsB.get(bg) ?? 0) + 1);
  }

  let intersection = 0;
  for (const [bg, countA] of bigramsA) {
    intersection += Math.min(countA, bigramsB.get(bg) ?? 0);
  }

  return (2 * intersection) / ((na.length - 1) + (nb.length - 1));
};

export type ValidationResult = {
  outcome: 'accepted' | 'rejected' | 'redirected';
  reason?: string;
  redirectTarget?: 'coach';
};

export type InboxAddResult = {
  accepted: boolean;
  redirected?: boolean;
  redirectTarget?: string;
  rejectedReason?: string;
  itemId?: string;
  state: TaskQueueState;
};

export type InboxFeedbackExample = {
  id: string;
  title: string;
  text?: string;
  category?: InboxItemCategory;
  sourceKind?: TaskSource['kind'];
  sourceLabel?: string;
  sourceAutomationId?: string;
  sourceAutomationName?: string;
  dismissedReasonCategory?: InboxDismissReasonCategory;
  dismissedReason?: string;
  dismissedAt?: number;
  addedAt: number;
};

export type InboxFeedbackQuery = {
  limit?: number;
  maxAgeDays?: number;
  sourceKind?: TaskSource['kind'];
  automationId?: string;
  automationName?: string;
  category?: InboxItemCategory;
};

const SEMI_TRUSTED_CATEGORIES: InboxItemCategory[] = ['user-request', 'meeting-action', 'follow-up', 'automation', 'system'];
const ARCHIVED_DEDUP_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

const INSIGHT_PREFIXES = [
  'insight:', 'learning:', 'win:', 'recap:',
  'summary:', 'fyi:', 'note:', 'decision:',
  'context:', 'ux insight:',
  'highlight:', 'takeaway:', 'reflection:',
  'office hour recap:',
  'confirmed:', 'resolved:', 'shipped:',
  'observation:',
  'look ahead:', 'product idea:', 'new:', 'watch for:',
];

/**
 * Strong FYI signals in body text — phrases that unambiguously indicate the
 * item is informational-only with no user action required. Checked against
 * `text` (not just title) as a safety net for items whose titles look
 * actionable but whose bodies reveal they're purely informational.
 */
const BODY_FYI_PATTERNS: RegExp[] = [
  /\bfyi\s+only\b/i,
  /\bno\s+action\s+(for\s+you|needed|required|necessary|on\s+your\s+(end|part|side))\b/i,
  /\bno\s+follow.?up\s+(needed|required|necessary|on\s+your\s+(end|part|side))\b/i,
  /\bnothing\s+(for\s+you\s+)?to\s+(do|act\s+on)\b/i,
  /\bfor\s+your\s+(info|information|awareness)\s+only\b/i,
  /\bpurely\s+informational\b/i,
  /\bno\s+deliverables\s+on\s+your\s+side\b/i,
];

const SIMILARITY_THRESHOLD = 0.85;

/**
 * Action-verb prefixes that LLMs use interchangeably when generating inbox
 * items.  Stripping these before similarity comparison lets us detect
 * "Reply to Greg re: chart" vs "Respond to Greg re: chart" as duplicates.
 *
 * Order matters: longer/more specific patterns first to avoid partial matches.
 */
const ACTION_PREFIX_RE = /^(?:follow\s+up\s+(?:on|with)|weigh\s+in\s+on|rsvp(?:\s+to|\s+decision:?)?|prep\s+for|decide\s+on|look\s+into|check(?:\s+on)?|reply\s+to|respond\s+to|acknowledge|investigate|confirm|support|review|accept|attend|read|join)\s+/i;

/** Slack channel references that add noise to similarity comparison. */
const CHANNEL_REF_RE = /\s+(?:in\s+)?#\S+/g;

/**
 * Normalize a title for duplicate comparison: strip action-verb prefixes and
 * Slack channel references so the comparison focuses on the subject matter.
 * Returns the lowercased, trimmed result.
 */
export const stripActionPrefix = (title: string): string => {
  const lower = title.toLowerCase().trim();
  return lower.replace(ACTION_PREFIX_RE, '').replace(CHANNEL_REF_RE, '').trim();
};

const STRIPPED_SIMILARITY_THRESHOLD = 0.70;

const KEYWORD_STOP_WORDS = new Set([
  // Grammatical
  'the', 'and', 'for', 'with', 'from', 'about', 'your', 'this', 'that',
  'who', 'what', 'when', 'where', 'how', 'been', 'have', 'been', 'will',
  'would', 'could', 'should', 'must', 'shall', 'need', 'into', 'also',
  'them', 'they', 'their', 'some', 'more', 'than', 'then', 'before',
  'after', 'added',
  // Temporal — appear across many items regardless of topic
  'today', 'tomorrow', 'yesterday', 'week', 'month', 'daily', 'next',
  'last', 'first', 'each', 'every',
  // Workplace terms — too common to distinguish topics
  'email', 'meeting', 'slack', 'review', 'update', 'send', 'share',
  'discuss', 'draft', 'schedule', 'check', 'reply', 'respond',
]);

/**
 * Extract keyword stems from a title for topic-based duplicate detection.
 * Strips possessives, punctuation, stop words; returns first-6-char stems.
 */
const extractKeywordStems = (title: string): Set<string> => {
  const cleaned = title
    .toLowerCase()
    .replace(/['']s\b/g, '')    // strip possessives
    .replace(/[^a-z0-9\s]/g, ' ');
  const stems = new Set<string>();
  for (const word of cleaned.split(/\s+/)) {
    if (word.length >= 4 && !KEYWORD_STOP_WORDS.has(word)) {
      stems.add(word.slice(0, 6));
    }
  }
  return stems;
};

const KEYWORD_JACCARD_THRESHOLD = 0.25;
const KEYWORD_MIN_SHARED = 3;

/**
 * Conservative duplicate check (Tiers 1+2 only).
 *
 * Used for **real-time validation** in `validateInboxItem` where rejected
 * items are silently dropped (irreversible). Only uses high-confidence
 * string-similarity tiers to avoid false positives.
 */
export const isLikelyDuplicate = (a: string, b: string): boolean => {
  if (normalizedSimilarity(a, b) > SIMILARITY_THRESHOLD) return true;

  const strippedA = stripActionPrefix(a);
  const strippedB = stripActionPrefix(b);
  const aWasStripped = strippedA !== a.toLowerCase().trim();
  const bWasStripped = strippedB !== b.toLowerCase().trim();
  if ((aWasStripped || bWasStripped) && strippedA.length >= 4 && strippedB.length >= 4) {
    if (normalizedSimilarity(strippedA, strippedB) > STRIPPED_SIMILARITY_THRESHOLD) return true;
    const [shorter, longer] = strippedA.length <= strippedB.length
      ? [strippedA, strippedB] : [strippedB, strippedA];
    if (shorter.length >= 10 && longer.startsWith(shorter)) return true;
  }

  return false;
};

/**
 * Aggressive duplicate check (all 3 tiers).
 *
 * Used only for **retroactive cleanup** where matched items are archived
 * (reversible). Adds a keyword-stem Jaccard tier that catches semantically
 * similar titles with different structure ("Greg re: Mar 31 event attendance"
 * vs "Greg: who's attending the 31 March event?").
 */
export const isLikelyDuplicateAggressive = (a: string, b: string): boolean => {
  if (isLikelyDuplicate(a, b)) return true;

  const stemsA = extractKeywordStems(a);
  const stemsB = extractKeywordStems(b);
  if (stemsA.size >= KEYWORD_MIN_SHARED && stemsB.size >= KEYWORD_MIN_SHARED) {
    let shared = 0;
    for (const s of stemsA) if (stemsB.has(s)) shared++;
    if (shared >= KEYWORD_MIN_SHARED) {
      const jaccard = shared / (stemsA.size + stemsB.size - shared);
      if (jaccard >= KEYWORD_JACCARD_THRESHOLD) return true;
    }
  }

  return false;
};

/**
 * Strip leading emojis, symbols, and whitespace from a title so prefix
 * matching works regardless of decorative prefixes like 💡 or 🏆.
 */
const stripLeadingEmojis = (s: string): string =>
  s.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{So}\s\u200d\ufe0f]+/u, '');

/**
 * Check whether a title (after emoji-stripping and lowercasing) matches
 * any of the non-actionable insight prefixes.
 */
const matchesInsightPrefix = (title: string): string | null => {
  const stripped = stripLeadingEmojis(title).toLowerCase().trim();
  for (const prefix of INSIGHT_PREFIXES) {
    if (stripped.startsWith(prefix)) return prefix.slice(0, -1);
  }
  return null;
};

/**
 * Observation/status-update patterns — titles that describe what happened
 * rather than something the user needs to do.
 */
const OBSERVATION_PATTERNS: RegExp[] = [
  /\blanded\b.*\b(well|with)\b/i,
  /^your\b.+\blanded\b/i,
  /\bnow\s+(saved|set up|available|enabled|working|live|deployed|shipping|configured)\b/i,
  /\b(demoed|demonstrated|showcased|presented)\b/i,
  /\bimprovements?\s+shipping\b/i,
  /\b(is|are|was|were)\s+shipping\b/i,
  /\bdocumented\b.*\bworth\s+(reviewing|noting)\b/i,
  /\bschedule\s+agreed\b/i,
  /\bvalidated\s+by\b/i,
  /\b\d+\s+key\s+insights?\s+from\b/i,
  /\bwin:\s/i,
  /\binsight:\s/i,
  /\bworth\s+(noting|reviewing|exploring|considering)\b/i,
  /\bready\s+to\s+archive\b/i,
  /^\w+('s)?\s+(built|pushed|documented|created|shipped|released|demoed)\b/i,
  /^\w+('s)?\s+suggestion:/i,
  // Status confirmations — item describes something already resolved
  /^[A-Z]+-\d+\s+(confirmed|resolved|fixed|closed|shipped|merged|deployed):/i,
  /\b(has been|was|is now)\s+(confirmed|resolved|fixed|closed|shipped|deployed|merged|handled|addressed)\b/i,
  /\b(already|been)\s+(done|completed|fixed|resolved|shipped|handled|addressed|merged)\b/i,
  // Pure FYI / no-action-needed signals
  /\b(for\s+your\s+(info|information|reference|awareness)|just\s+(fyi|letting\s+you\s+know|an?\s+update))\b/i,
  /\bno\s+(action|follow.?up)\s+(needed|required|necessary)\b/i,
  /\bfyi\b.{0,10}:/i,
  // Mid-title "recap:" — non-actionable summary appearing after a topic
  // e.g., "CTOcraft workshop recap: 30 CTOs impressed"
  /\brecap:\s/i,
];

// Canonical definition lives in @shared/utils/inboxQualityPatterns.
// Re-export for backward compat (tests import from here).
export const OTHER_PERSON_TASK_PATTERNS = _OTHER_PERSON_TASK_PATTERNS;

/**
 * Validate an inbox item before adding it.
 *
 * Two-tier filtering:
 * - `user-request` items bypass ALL checks (user explicitly added it)
 * - `meeting-action`, `follow-up`, `automation`, `system` items get critical safety
 *   checks only: other-person task, observation/insight redirect, duplicates.
 *   These categories skip length/format checks.
 * - `uncategorized` items get the full filter pipeline.
 */
export const validateInboxItem = (
  input: TaskMutationInput,
  activeItems: ReadonlyArray<{ title: string; archived?: boolean; archivedAt?: number; addedAt?: number }>,
  historyItems: ReadonlyArray<{ title: string; addedAt?: number; executedAt?: number }>,
): ValidationResult => {
  // User explicitly added this — trust them completely
  if (input.category === 'user-request') {
    return { outcome: 'accepted' };
  }

  const title = input.title.trim();
  const isSemiTrusted = input.category != null && SEMI_TRUSTED_CATEGORIES.includes(input.category);

  // ── Full checks (uncategorized only) ───────────────────────────────

  if (!isSemiTrusted) {
    const wordCount = title.split(/\s+/).filter(Boolean).length;
    if (wordCount <= 3) {
      return { outcome: 'rejected', reason: `Title too short (${wordCount} words, minimum 4)` };
    }
    if (wordCount > 100) {
      return { outcome: 'rejected', reason: `Title too long (${wordCount} words, maximum 100)` };
    }

    const text = input.text?.trim();
    if (text && text === title) {
      return { outcome: 'rejected', reason: 'Text is identical to title' };
    }

    if (input.relevantDate && input.relevantDate < Date.now()) {
      return { outcome: 'rejected', reason: 'Item has already expired (relevantDate in the past)' };
    }
  }

  // ── Critical safety checks (all categories except user-request) ────

  if (isWinsLearningsSource(input.source)) {
    return {
      outcome: 'redirected',
      reason: 'Wins/learnings source belongs in Coach, not Actions',
      redirectTarget: 'coach',
    };
  }

  const matchedPrefix = matchesInsightPrefix(title);
  if (matchedPrefix) {
    return {
      outcome: 'redirected',
      reason: `Non-actionable content (starts with "${matchedPrefix}")`,
      redirectTarget: 'coach',
    };
  }

  for (const pattern of OBSERVATION_PATTERNS) {
    if (pattern.test(title)) {
      return {
        outcome: 'redirected',
        reason: `Observation/status update (matched pattern: ${pattern.source.slice(0, 40)})`,
        redirectTarget: 'coach',
      };
    }
  }

  // Check body text for strong FYI signals (title may be innocuous)
  const bodyText = input.text?.trim();
  if (bodyText) {
    for (const pattern of BODY_FYI_PATTERNS) {
      if (pattern.test(bodyText)) {
        return {
          outcome: 'redirected',
          reason: `Body text contains FYI signal (matched: ${pattern.source.slice(0, 40)})`,
          redirectTarget: 'coach',
        };
      }
    }
  }

  // ── Other-person task check (before action-signal gate so the rejection
  //    reason is precise rather than a generic "no action signal") ────────
  for (const pattern of OTHER_PERSON_TASK_PATTERNS) {
    if (pattern.test(title)) {
      return {
        outcome: 'rejected',
        reason: `Appears to be another person's task (matched pattern: ${pattern.source.slice(0, 40)})`,
      };
    }
  }

  // ── Meeting/follow-up action-signal gate ───────────────────────────
  // Items without action verbs in their titles are informational (status
  // updates, partnership news, etc.) and belong in coach/memory.
  // Bypass: items with a draft or clarifyingQuestion represent LLM
  // preparation work — the user should still see them even if the title
  // is a noun phrase (e.g. "Pricing proposal for Q3" + draft email).
  const isMeetingOrFollowUp = input.category === 'meeting-action' || input.category === 'follow-up';
  const hasPreparedContent = !!input.draft?.trim() || !!input.clarifyingQuestion?.trim();
  if (isMeetingOrFollowUp && bodyText && isThirdPartyInitiative(bodyText) && !isUserDirectedByThirdParty(bodyText)) {
    return {
      outcome: 'redirected',
      reason: 'Third-party initiative in body without clear user ownership',
      redirectTarget: 'coach',
    };
  }
  if (isMeetingOrFollowUp && !hasPreparedContent && !hasUserActionSignal(title)) {
    return {
      outcome: 'redirected',
      reason: 'Meeting/follow-up item without action signal in title',
      redirectTarget: 'coach',
    };
  }

  // ── Duplicate detection (all categories except user-request) ───────
  // Uses enhanced comparison that also strips action-verb prefixes so
  // "Reply to X about Y" and "Respond to X about Y" are caught as dupes.

  for (const item of activeItems) {
    if (item.archived) continue;
    if (isLikelyDuplicate(title, item.title)) {
      return { outcome: 'rejected', reason: `Duplicate of active item "${item.title}"` };
    }
  }

  for (const item of activeItems) {
    if (!item.archived) continue;
    const archivedTime = item.archivedAt ?? item.addedAt ?? 0;
    if (Date.now() - archivedTime > ARCHIVED_DEDUP_WINDOW_MS) continue;
    if (isLikelyDuplicate(title, item.title)) {
      return { outcome: 'rejected', reason: `Similar to archived item "${item.title}"` };
    }
  }

  for (const item of historyItems) {
    const itemTime = item.executedAt ?? item.addedAt ?? 0;
    if (Date.now() - itemTime > ARCHIVED_DEDUP_WINDOW_MS) continue;
    if (isLikelyDuplicate(title, item.title)) {
      return { outcome: 'rejected', reason: `Similar to executed item "${item.title}"` };
    }
  }

  return { outcome: 'accepted' };
};

export const addInboxItem = (input: TaskMutationInput): InboxAddResult => {
  if (!isNonEmptyString(input.title)) {
    throw new Error('Item title is required.');
  }
  
  // Check if using new system
  const index = loadInboxIndex();
  if (index.migrationComplete) {
    const validation = validateInboxItem(input, index.entries, index.history);

    if (validation.outcome === 'rejected') {
      log.info({ title: input.title, reason: validation.reason, category: input.category }, 'Inbox item rejected by quality filter');
      return { accepted: false, rejectedReason: validation.reason, state: getInboxState() };
    }

    if (validation.outcome === 'redirected') {
      log.info(
        { title: input.title, reason: validation.reason, redirectTarget: validation.redirectTarget, category: input.category },
        'Inbox item redirected by quality filter',
      );
      return {
        accepted: false,
        redirected: true,
        redirectTarget: validation.redirectTarget,
        rejectedReason: validation.reason,
        state: getInboxState(),
      };
    }

    const item = buildInboxItemFromMutation(input);
    
    // Write entry file - only update index if write succeeds
    if (!writeEntryFile(item.id, item)) {
      log.error({ itemId: item.id }, 'Failed to write entry file for new inbox item');
      return { accepted: false, rejectedReason: 'Failed to persist item', state: getInboxState() };
    }
    
    // Update index (add to front)
    const newEntries = [toIndexEntry(item), ...index.entries];
    getInboxIndexStore().set('entries', newEntries);
    
    const nextState = getInboxState();
    emitInboxState(nextState);
    return { accepted: true, itemId: item.id, state: nextState };
  }
  
  // Legacy path
  const state = loadInboxInternal();
  const validation = validateInboxItem(input, state.items, state.history);

  if (validation.outcome === 'rejected') {
    log.info({ title: input.title, reason: validation.reason, category: input.category }, 'Inbox item rejected by quality filter');
    return { accepted: false, rejectedReason: validation.reason, state };
  }
  if (validation.outcome === 'redirected') {
    log.info(
      { title: input.title, reason: validation.reason, redirectTarget: validation.redirectTarget, category: input.category },
      'Inbox item redirected by quality filter',
    );
    return { accepted: false, redirected: true, redirectTarget: validation.redirectTarget, rejectedReason: validation.reason, state };
  }

  const item = buildInboxItemFromMutation(input);
  const nextState: TaskQueueState = {
    version: INBOX_STORE_VERSION,
    items: [item, ...state.items],
    history: state.history
  };
  saveInboxInternal(nextState);
  emitInboxState(nextState);
  return { accepted: true, itemId: item.id, state: nextState };
};

/** @deprecated Use addInboxItem */
export const addTaskQueueItem = addInboxItem;

/**
 * Apply a partial patch to an inbox item, returning the updated copy.
 * Shared by both entry-file and legacy update paths to avoid duplication.
 */
const applyInboxItemPatch = (original: TaskQueueItem, patch: Partial<TaskMutationInput>): TaskQueueItem => {
  let nextItem: TaskQueueItem = { ...original };

  if (patch.title && patch.title.trim().length > 0) {
    nextItem.title = patch.title.trim();
  }
  if (typeof patch.text === 'string') {
    nextItem.text = patch.text.trim().length > 0 ? patch.text.trim() : nextItem.title;
  }
  if (patch.source !== undefined) {
    nextItem.source = patch.source ? sanitizeTaskSource(patch.source) ?? undefined : undefined;
  }
  if (patch.references !== undefined) {
    nextItem.references = Array.isArray(patch.references)
      ? patch.references.map(sanitizeTaskReference).filter((ref): ref is TaskReference => Boolean(ref))
      : [];
  }
  if (patch.actions !== undefined) {
    nextItem.actions = patch.actions ? sanitizeInboxActions(patch.actions) : undefined;
  }
  if (typeof patch.urgent === 'boolean') {
    nextItem.urgent = patch.urgent;
  }
  if (typeof patch.important === 'boolean') {
    nextItem.important = patch.important;
  }
  if (typeof patch.archived === 'boolean') {
    nextItem.archived = patch.archived;
    nextItem.archivedAt = patch.archived ? Date.now() : undefined;
    nextItem.status = undefined;
    if (!patch.archived) {
      nextItem.completedAt = undefined;
      nextItem.completedBy = undefined;
      nextItem.dismissedAt = undefined;
    }
    nextItem = normalizeStatusFields(nextItem);
  }
  if (patch.draft !== undefined) {
    nextItem.draft = patch.draft === null ? undefined : (patch.draft.trim() || undefined);
  }
  if (patch.clarifyingQuestion !== undefined) {
    nextItem.clarifyingQuestion = patch.clarifyingQuestion === null ? undefined : (patch.clarifyingQuestion.trim() || undefined);
  }
  if (patch.relevantDate !== undefined) {
    nextItem.relevantDate = (typeof patch.relevantDate === 'number' && Number.isFinite(patch.relevantDate))
      ? patch.relevantDate
      : undefined;
  }
  if (patch.tags !== undefined) {
    nextItem.tags = normalizeTags(patch.tags);
  }
  if (patch.dueBy !== undefined) {
    nextItem.dueBy = (typeof patch.dueBy === 'number' && Number.isFinite(patch.dueBy))
      ? patch.dueBy
      : undefined;
  }
  if (patch.confidence !== undefined) {
    nextItem.confidence = (typeof patch.confidence === 'string' && ['high', 'medium', 'low'].includes(patch.confidence))
      ? patch.confidence as 'high' | 'medium' | 'low'
      : undefined;
  }
  if (patch.category !== undefined) {
    nextItem.category = typeof patch.category === 'string' && patch.category.trim()
      ? patch.category.trim() as InboxItemCategory
      : nextItem.category;
  }

  return nextItem;
};

export const updateInboxItem = (
  itemId: string,
  patch: Partial<TaskMutationInput>
): TaskQueueState => {
  const index = loadInboxIndex();
  if (index.migrationComplete) {
    const original = readEntryFile(itemId);
    if (!original) {
      throw new Error('Item not found.');
    }
    
    const nextItem = applyInboxItemPatch(original, patch);
    nextItem.updatedAt = Date.now();
    
    if (!writeEntryFile(itemId, nextItem)) {
      log.error({ itemId }, 'Failed to write entry file for inbox item update');
      const currentState: TaskQueueState = {
        version: INBOX_STORE_VERSION,
        items: index.entries.map(e => readEntryFile(e.id)).filter((i): i is TaskQueueItem => i !== null),
        history: index.history,
      };
      return currentState;
    }
    
    const entryIndex = index.entries.findIndex(e => e.id === itemId);
    if (entryIndex !== -1) {
      const updatedEntries = [...index.entries];
      updatedEntries[entryIndex] = toIndexEntry(nextItem);
      getInboxIndexStore().set('entries', updatedEntries);
    }
    
    const allEntries = getInboxIndexStore().get('entries') as InboxIndexEntry[];
    const nextState: TaskQueueState = {
      version: INBOX_STORE_VERSION,
      items: allEntries.map(e => readEntryFile(e.id)).filter((i): i is TaskQueueItem => i !== null),
      history: index.history,
    };
    emitInboxState(nextState);
    return nextState;
  }
  
  // Legacy path
  const state = loadInboxInternal();
  const targetIndex = state.items.findIndex((item) => item.id === itemId);
  if (targetIndex === -1) {
    throw new Error('Item not found.');
  }

  const nextItem = applyInboxItemPatch(state.items[targetIndex], patch);
  nextItem.updatedAt = Date.now();

  const nextItems = [...state.items];
  nextItems.splice(targetIndex, 1, nextItem);
  const nextState: TaskQueueState = {
    version: INBOX_STORE_VERSION,
    items: nextItems,
    history: state.history
  };
  saveInboxInternal(nextState);
  emitInboxState(nextState);
  return nextState;
};

/** @deprecated Use updateInboxItem */
export const updateTaskQueueItem = updateInboxItem;

export const removeInboxItem = (itemId: string): TaskQueueState => {
  // Check if using new system
  const index = loadInboxIndex();
  if (index.migrationComplete) {
    // Delete from index FIRST (orphan files are safe; missing files break UI)
    const updatedEntries = index.entries.filter(e => e.id !== itemId);
    getInboxIndexStore().set('entries', updatedEntries);
    
    // Record tombstone so cloud pull doesn't resurrect this item
    recordTombstone(itemId);
    
    // Then delete the entry file
    deleteEntryFile(itemId);
    
    // Build full state for return
    const nextState: TaskQueueState = {
      version: INBOX_STORE_VERSION,
      items: updatedEntries.map(e => readEntryFile(e.id)).filter((i): i is TaskQueueItem => i !== null),
      history: index.history,
    };
    emitInboxState(nextState);
    return nextState;
  }
  
  // Legacy path
  const state = loadInboxInternal();

  // Record tombstone so cloud pull doesn't resurrect this item
  recordTombstone(itemId);

  const nextState: TaskQueueState = {
    version: INBOX_STORE_VERSION,
    items: state.items.filter((item) => item.id !== itemId),
    history: state.history
  };
  saveInboxInternal(nextState);
  emitInboxState(nextState);
  return nextState;
};

/** @deprecated Use removeInboxItem */
export const removeTaskQueueItem = removeInboxItem;

export const markInboxItemAsArchived = (itemId: string): TaskQueueState => {
  return setInboxItemArchived(itemId, true);
};

/** @deprecated Use markInboxItemAsArchived */
export const markInboxItemAsRead = markInboxItemAsArchived;
/** @deprecated Use markInboxItemAsArchived */
export const markTaskAsRead = markInboxItemAsArchived;

export function setInboxItemArchived(itemId: string, archived: boolean): TaskQueueState {
  // Check if using new system
  const index = loadInboxIndex();
  if (index.migrationComplete) {
    // Load the existing item from entry file
    const currentItem = readEntryFile(itemId);
    if (!currentItem) {
      return getInboxState(); // Item not found, return current state
    }
    
    const updatedItem = normalizeStatusFields({
      ...currentItem,
      archived,
      archivedAt: archived ? (currentItem.archivedAt ?? Date.now()) : undefined,
      status: undefined, // clear so normalizeStatusFields derives from archived
      completedAt: archived ? currentItem.completedAt : undefined,
      completedBy: archived ? currentItem.completedBy : undefined,
      dismissedAt: archived ? currentItem.dismissedAt : undefined,
      updatedAt: Date.now(),
    });
    
    // Write updated entry file - only update index if write succeeds
    if (!writeEntryFile(itemId, updatedItem)) {
      log.error({ itemId }, 'Failed to write entry file for archive state change');
      // Return current state unchanged
      const currentState: TaskQueueState = {
        version: INBOX_STORE_VERSION,
        items: index.entries.map(e => readEntryFile(e.id)).filter((i): i is TaskQueueItem => i !== null),
        history: index.history,
      };
      return currentState;
    }
    
    // Update index entry
    const entryIndex = index.entries.findIndex(e => e.id === itemId);
    if (entryIndex !== -1) {
      const updatedEntries = [...index.entries];
      updatedEntries[entryIndex] = toIndexEntry(updatedItem);
      getInboxIndexStore().set('entries', updatedEntries);
    }
    
    // Build full state for return
    const allEntries = getInboxIndexStore().get('entries') as InboxIndexEntry[];
    const nextState: TaskQueueState = {
      version: INBOX_STORE_VERSION,
      items: allEntries.map(e => readEntryFile(e.id)).filter((i): i is TaskQueueItem => i !== null),
      history: index.history,
    };
    emitInboxState(nextState);
    return nextState;
  }
  
  // Legacy path
  const state = loadInboxInternal();
  const targetIndex = state.items.findIndex((item) => item.id === itemId);
  if (targetIndex === -1) {
    return state;
  }
  const nextItems = [...state.items];
  const currentItem = nextItems[targetIndex];
  const archivedAt = archived
    ? (currentItem.archivedAt ?? Date.now())
    : undefined;
  nextItems[targetIndex] = normalizeStatusFields({
    ...currentItem,
    archived,
    archivedAt,
    status: undefined,
    completedAt: archived ? currentItem.completedAt : undefined,
    completedBy: archived ? currentItem.completedBy : undefined,
    dismissedAt: archived ? currentItem.dismissedAt : undefined,
    updatedAt: Date.now(),
  });
  const nextState: TaskQueueState = {
    version: INBOX_STORE_VERSION,
    items: nextItems,
    history: state.history
  };
  saveInboxInternal(nextState);
  emitInboxState(nextState);
  return nextState;
}

/** @deprecated Use setInboxItemArchived */
export const setInboxItemReadState = setInboxItemArchived;

/**
 * Set the lifecycle status of an inbox item.
 * Routes through `normalizeStatusFields` to keep `archived`/timestamps in sync.
 * When status is 'completed' or 'dismissed', clears `executingSessionId`.
 */
export const setInboxItemStatus = (
  itemId: string,
  status: InboxItemStatus,
  completedBy?: 'user' | 'rebel',
  options?: {
    dismissedReasonCategory?: InboxDismissReasonCategory;
    dismissedReason?: string;
  }
): TaskQueueState => {
  const index = loadInboxIndex();
  if (index.migrationComplete) {
    const currentItem = readEntryFile(itemId);
    if (!currentItem) {
      return getInboxState();
    }

    const updatedItem = normalizeStatusFields({
      ...currentItem,
      status,
      ...(completedBy != null ? { completedBy } : {}),
      ...(status === 'dismissed' && options?.dismissedReasonCategory != null
        ? { dismissedReasonCategory: options.dismissedReasonCategory }
        : {}),
      ...(status === 'dismissed' && options?.dismissedReason?.trim()
        ? { dismissedReason: options.dismissedReason.trim() }
        : {}),
      updatedAt: Date.now(),
    });

    if (status === 'completed' || status === 'dismissed') {
      updatedItem.executingSessionId = undefined;
      updatedItem.autoCompleteOnExecution = undefined;
    }

    if (!writeEntryFile(itemId, updatedItem)) {
      log.error({ itemId }, 'Failed to write entry file for status change');
      return getInboxState();
    }

    const entryIndex = index.entries.findIndex(e => e.id === itemId);
    if (entryIndex !== -1) {
      const updatedEntries = [...index.entries];
      updatedEntries[entryIndex] = toIndexEntry(updatedItem);
      getInboxIndexStore().set('entries', updatedEntries);
    }

    const allEntries = getInboxIndexStore().get('entries') as InboxIndexEntry[];
    const nextState: TaskQueueState = {
      version: INBOX_STORE_VERSION,
      items: allEntries.map(e => readEntryFile(e.id)).filter((i): i is TaskQueueItem => i !== null),
      history: index.history,
    };
    emitInboxState(nextState);
    return nextState;
  }

  // Legacy path: apply to in-memory state
  const state = loadInboxInternal();
  const targetIndex = state.items.findIndex((item) => item.id === itemId);
  if (targetIndex === -1) {
    return state;
  }
  const nextItems = [...state.items];
  const updatedItem = normalizeStatusFields({
    ...nextItems[targetIndex],
    status,
    ...(completedBy != null ? { completedBy } : {}),
    ...(status === 'dismissed' && options?.dismissedReasonCategory != null
      ? { dismissedReasonCategory: options.dismissedReasonCategory }
      : {}),
    ...(status === 'dismissed' && options?.dismissedReason?.trim()
      ? { dismissedReason: options.dismissedReason.trim() }
      : {}),
    updatedAt: Date.now(),
  });
  if (status === 'completed' || status === 'dismissed') {
    updatedItem.executingSessionId = undefined;
    updatedItem.autoCompleteOnExecution = undefined;
  }
  nextItems[targetIndex] = updatedItem;
  const nextState: TaskQueueState = {
    version: INBOX_STORE_VERSION,
    items: nextItems,
    history: state.history,
  };
  saveInboxInternal(nextState);
  emitInboxState(nextState);
  return nextState;
};

/**
 * Update the Eisenhower quadrant of an inbox item (urgent + important).
 */
export const setInboxItemQuadrant = (
  itemId: string,
  urgent: boolean,
  important: boolean
): TaskQueueState => {
  // Check if using new system
  const index = loadInboxIndex();
  if (index.migrationComplete) {
    // Load the existing item from entry file
    const currentItem = readEntryFile(itemId);
    if (!currentItem) {
      return getInboxState(); // Item not found, return current state
    }

    const updatedItem = { ...currentItem, urgent, important, updatedAt: Date.now() };

    // Write updated entry file - only update index if write succeeds
    if (!writeEntryFile(itemId, updatedItem)) {
      log.error({ itemId }, 'Failed to write entry file for quadrant change');
      const currentState: TaskQueueState = {
        version: INBOX_STORE_VERSION,
        items: index.entries.map(e => readEntryFile(e.id)).filter((i): i is TaskQueueItem => i !== null),
        history: index.history,
      };
      return currentState;
    }

    // Update index entry
    const entryIndex = index.entries.findIndex(e => e.id === itemId);
    if (entryIndex !== -1) {
      const updatedEntries = [...index.entries];
      updatedEntries[entryIndex] = toIndexEntry(updatedItem);
      getInboxIndexStore().set('entries', updatedEntries);
    }

    // Build full state for return
    const allEntries = getInboxIndexStore().get('entries') as InboxIndexEntry[];
    const nextState: TaskQueueState = {
      version: INBOX_STORE_VERSION,
      items: allEntries.map(e => readEntryFile(e.id)).filter((i): i is TaskQueueItem => i !== null),
      history: index.history,
    };
    emitInboxState(nextState);
    return nextState;
  }

  // Legacy path
  const state = loadInboxInternal();
  const targetIndex = state.items.findIndex((item) => item.id === itemId);
  if (targetIndex === -1) {
    return state;
  }
  const nextItems = [...state.items];
  nextItems[targetIndex] = { ...nextItems[targetIndex], urgent, important, updatedAt: Date.now() };
  const nextState: TaskQueueState = {
    version: INBOX_STORE_VERSION,
    items: nextItems,
    history: state.history
  };
  saveInboxInternal(nextState);
  emitInboxState(nextState);
  return nextState;
};

/**
 * Set or clear the executing session ID for an inbox item.
 * When setting a sessionId, also sets `status: 'executing'`.
 * When clearing, resets to `'active'` only if the item is still in `'executing'` state.
 * If the item has already been resolved (completed/dismissed), preserves that status.
 * Does NOT remove the item from the inbox (unlike `recordInboxExecutionEntry`).
 */
export const setInboxItemExecuting = (
  itemId: string,
  sessionId: string | null,
  options?: { autoCompleteOnExecution?: boolean }
): TaskQueueState => {
  // Check if using new system
  const index = loadInboxIndex();
  if (index.migrationComplete) {
    // Load the existing item from entry file
    const currentItem = readEntryFile(itemId);
    if (!currentItem) {
      return getInboxState(); // Item not found, return current state
    }

    // Guard: don't overwrite completed/dismissed items (race with auto-mark-done)
    if (sessionId && (currentItem.status === 'completed' || currentItem.status === 'dismissed')) {
      return getInboxState();
    }

    const clearStatus = currentItem.status === 'executing' ? 'active' as const : currentItem.status;
    const updatedItem = normalizeStatusFields(sessionId
      ? {
          ...currentItem,
          executingSessionId: sessionId,
          autoCompleteOnExecution: options?.autoCompleteOnExecution === true,
          status: 'executing' as const,
          updatedAt: Date.now(),
        }
      : {
          ...currentItem,
          executingSessionId: undefined,
          autoCompleteOnExecution: undefined,
          status: clearStatus,
          updatedAt: Date.now(),
        });

    // Write updated entry file - only update index if write succeeds
    if (!writeEntryFile(itemId, updatedItem)) {
      log.error({ itemId }, 'Failed to write entry file for executing state change');
      const currentState: TaskQueueState = {
        version: INBOX_STORE_VERSION,
        items: index.entries.map(e => readEntryFile(e.id)).filter((i): i is TaskQueueItem => i !== null),
        history: index.history,
      };
      return currentState;
    }

    // Update index entry
    const entryIndex = index.entries.findIndex(e => e.id === itemId);
    if (entryIndex !== -1) {
      const updatedEntries = [...index.entries];
      updatedEntries[entryIndex] = toIndexEntry(updatedItem);
      getInboxIndexStore().set('entries', updatedEntries);
    }

    // Build full state for return
    const allEntries = getInboxIndexStore().get('entries') as InboxIndexEntry[];
    const nextState: TaskQueueState = {
      version: INBOX_STORE_VERSION,
      items: allEntries.map(e => readEntryFile(e.id)).filter((i): i is TaskQueueItem => i !== null),
      history: index.history,
    };
    emitInboxState(nextState);
    return nextState;
  }

  // Legacy path
  const state = loadInboxInternal();
  const targetIndex = state.items.findIndex((item) => item.id === itemId);
  if (targetIndex === -1) {
    return state;
  }
  // Guard: don't overwrite completed/dismissed items (race with auto-mark-done)
  const target = state.items[targetIndex];
  if (sessionId && (target.status === 'completed' || target.status === 'dismissed')) {
    return state;
  }
  const nextItems = [...state.items];
  const legacyClearStatus = nextItems[targetIndex].status === 'executing' ? 'active' as const : nextItems[targetIndex].status;
  nextItems[targetIndex] = normalizeStatusFields(sessionId
    ? {
        ...nextItems[targetIndex],
        executingSessionId: sessionId,
        autoCompleteOnExecution: options?.autoCompleteOnExecution === true,
        status: 'executing' as const,
        updatedAt: Date.now(),
      }
    : {
        ...nextItems[targetIndex],
        executingSessionId: undefined,
        autoCompleteOnExecution: undefined,
        status: legacyClearStatus,
        updatedAt: Date.now(),
      });
  const nextState: TaskQueueState = {
    version: INBOX_STORE_VERSION,
    items: nextItems,
    history: state.history
  };
  saveInboxInternal(nextState);
  emitInboxState(nextState);
  return nextState;
};

export const recordInboxExecutionEntry = (
  itemId: string,
  sessionId: string,
  mode: TaskExecutionMode,
  executedAt?: number
): TaskQueueState => {
  // Check if using new system
  const index = loadInboxIndex();
  if (index.migrationComplete) {
    // Load the existing item from entry file
    const target = readEntryFile(itemId);
    if (!target) {
      return getInboxState(); // Item not found, return current state
    }
    
    // Create history entry
    const historyEntry: TaskHistoryEntry = {
      ...target,
      updatedAt: Date.now(),
      executedAt: executedAt && Number.isFinite(executedAt) ? executedAt : Date.now(),
      sessionId: isNonEmptyString(sessionId) ? sessionId.trim() : randomUUID(),
      mode: mode === 'execute_with_context' ? 'execute_with_context' : 'execute'
    };
    
    // Remove from index entries FIRST
    const updatedEntries = index.entries.filter(e => e.id !== itemId);
    getInboxIndexStore().set('entries', updatedEntries);
    
    // Then delete the entry file
    deleteEntryFile(itemId);
    
    // Update history in index
    const nextHistory = clampInboxHistoryEntries([historyEntry, ...index.history]);
    getInboxIndexStore().set('history', nextHistory);
    
    // Build full state for return
    const nextState: TaskQueueState = {
      version: INBOX_STORE_VERSION,
      items: updatedEntries.map(e => readEntryFile(e.id)).filter((i): i is TaskQueueItem => i !== null),
      history: nextHistory,
    };
    emitInboxState(nextState);
    return nextState;
  }
  
  // Legacy path
  const state = loadInboxInternal();
  const target = state.items.find((item) => item.id === itemId);
  if (!target) {
    return state;
  }
  const nextItems = state.items.filter((item) => item.id !== itemId);
  const historyEntry: TaskHistoryEntry = {
    ...target,
    updatedAt: Date.now(),
    executedAt: executedAt && Number.isFinite(executedAt) ? executedAt : Date.now(),
    sessionId: isNonEmptyString(sessionId) ? sessionId.trim() : randomUUID(),
    mode: mode === 'execute_with_context' ? 'execute_with_context' : 'execute'
  };
  const nextHistory = clampInboxHistoryEntries([historyEntry, ...state.history]);
  const nextState: TaskQueueState = {
    version: INBOX_STORE_VERSION,
    items: nextItems,
    history: nextHistory
  };
  saveInboxInternal(nextState);
  emitInboxState(nextState);
  return nextState;
};

/** @deprecated Use recordInboxExecutionEntry */
export const recordTaskExecutionEntry = recordInboxExecutionEntry;

export const deleteInboxItemById = (itemId: string): TaskQueueState => removeInboxItem(itemId);

/** @deprecated Use deleteInboxItemById */
export const deleteTaskById = deleteInboxItemById;

export const markSessionTurnsAsCompleted = (
  session: AgentSession,
  // Quit-vs-crash discriminator stamped on the synthetic interruption status.
  // Default 'startup-correction' covers the crash-recovery callers (startup
  // correction, stale-busy reaper, main/index session loading); the graceful
  // shutdown path passes 'shutdown' explicitly. See @shared/constants/turnInterruption.
  source: TurnInterruptionSource = 'startup-correction',
): AgentSession => {
  const now = Date.now();
  const normalizedEvents: Record<string, AgentEvent[]> = {};

  const appendInterruptionStatus = (
    events: AgentEvent[],
    timestamp: number,
    sessionId: string,
    turnId: string,
  ): AgentEvent[] => {
    if (hasTerminalEvent(events)) {
      return events.map((event) => ({ ...event }));
    }
    // Idempotency: skip if the last event is already the interruption status
    // (message match only — `source` is intentionally ignored so a startup
    // correction never appends a second status after a shutdown finalization).
    const lastEvent = events[events.length - 1];
    if (lastEvent?.type === 'status' && lastEvent.message === TURN_INTERRUPTION_MESSAGE) {
      return events.map((event) => ({ ...event }));
    }
    // R2 Stage 3a-B (260502 plan): construct the synthetic interruption-status
    // event via the manifest-derived buildAgentEvent.status(...) so the producer
    // enforces `status.requiredForNewEvents = ['sessionId', 'turnId']` at compile
    // time. The post-cutover event includes envelope axes (sessionId, turnId)
    // that the pre-cutover literal omitted — this is intentional migration
    // semantics, not a regression. Downstream readers find the same shape
    // predicates (event.type === 'status' && event.message === TURN_INTERRUPTION_MESSAGE
    // && typeof event.timestamp === 'number') unchanged.
    return [
      ...events.map((event) => ({ ...event })),
      buildAgentEvent.status(
        { message: TURN_INTERRUPTION_MESSAGE, timestamp, source },
        { sessionId, turnId },
      ),
    ];
  };

  for (const [turnId, events] of Object.entries(session.eventsByTurn ?? {})) {
    if (!Array.isArray(events)) {
      continue;
    }
    const timestamp = events.length > 0 ? events[events.length - 1]?.timestamp ?? now : now;
    normalizedEvents[turnId] = appendInterruptionStatus(events, timestamp, session.id, turnId);
  }

  return {
    ...session,
    // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- Startup interruption normalization appends synthetic interruption status then force-clears active turn to avoid stranded sessions.
    activeTurnId: null,
    // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- Interruption-clear path intentionally marks session idle after close-time completion normalization.
    isBusy: false,
    // Preserve original updatedAt — startup interruption annotations are system
    // housekeeping, not user activity. Bumping updatedAt here causes old sessions
    // to appear "recent" in the recency filter.
    updatedAt: session.updatedAt ?? now,
    eventsByTurn: normalizedEvents,
    lastError: session.lastError
  };
};

export const saveInboxState = saveInboxInternal;

/** @deprecated Use saveInboxState */
export const saveTaskQueueState = saveInboxState;

/**
 * Upsert an inbox item received from cloud into the local store.
 *
 * - New items: added in full (cloud-created items appear locally).
 * - Existing items: full-field merge based on `updatedAt`.
 *   - If local item has `status === 'executing'`, skip — UNLESS the incoming item
 *     is in a terminal state (completed/dismissed) AND strictly newer. This allows
 *     the executor to push completion back to the surface that still shows 'executing'.
 *   - Cloud's `effectiveUpdatedAt` > local's → replace full item from cloud.
 *   - Local's `effectiveUpdatedAt` >= cloud's → skip (desktop wins ties).
 *   - Backward compat: if NEITHER side has `updatedAt`, fall back to archive-only merge.
 * - Tombstoned items: skip (already deleted locally).
 *
 * Does NOT emit state changes — caller broadcasts once after batch.
 */
export const upsertInboxItemFromCloud = (item: InboxItem): boolean => {
  if (isInboxReadOnly()) {
    log.warn({ id: item.id }, 'Blocked cloud inbox upsert — read-only mode');
    return false;
  }
  if (!validateItemId(item.id)) {
    log.warn({ id: item.id }, 'Invalid item ID from cloud — skipping');
    return false;
  }

  // Check if using new system
  const index = loadInboxIndex();
  if (index.migrationComplete) {
    // Skip items that exist in local history — they were executed/removed
    // locally and the cloud hasn't caught up yet (dual-write race).
    if (index.history.some(h => h.id === item.id)) {
      log.debug({ id: item.id }, 'Skipping cloud upsert — item exists in local history');
      return false;
    }

    // Skip tombstoned items — deleted locally, don't resurrect
    const tombstones = getDeletedIds();
    if (tombstones.some(t => t.id === item.id)) {
      log.debug({ id: item.id }, 'Skipping cloud upsert — item is tombstoned locally');
      return false;
    }

    const existingIdx = index.entries.findIndex(e => e.id === item.id);
    if (existingIdx !== -1) {
      // Existing item: full-field merge based on updatedAt
      const local = readEntryFile(item.id);
      if (!local) return false;

      // Protect in-progress local execution from stale cloud data — but allow
      // terminal states (completed/dismissed) through when they're strictly newer.
      // Without this, a completion pushed from the executor gets permanently blocked
      // because the receiver's copy is still 'executing'.
      if (local.status === 'executing') {
        if (!canClobberLocalExecuting(local, item)) {
          log.debug({ id: item.id }, 'Skipping cloud upsert — item is executing locally');
          return false;
        }
        log.info({ id: item.id, incomingStatus: item.status }, 'Allowing terminal status upsert over executing item');
      }

      // Backward compat: if NEITHER side has updatedAt, fall back to archive-only merge
      if (local.updatedAt == null && item.updatedAt == null) {
        const archiveChanged = Boolean(local.archived) !== Boolean(item.archived);
        if (!archiveChanged) return false;

        const merged = normalizeStatusFields({ ...local, archived: item.archived, archivedAt: item.archivedAt });
        if (!writeEntryFile(item.id, merged)) return false;

        const updatedEntries = [...index.entries];
        updatedEntries[existingIdx] = toIndexEntry(merged);
        getInboxIndexStore().set('entries', updatedEntries);

        log.info({ id: item.id, archived: item.archived }, 'Updated inbox item archive state from cloud (legacy fallback)');
        return true;
      }

      // Full-field merge: cloud wins if strictly newer, desktop wins ties
      const localEffective = effectiveUpdatedAt(local);
      const cloudEffective = effectiveUpdatedAt(item);

      if (cloudEffective <= localEffective) {
        // Entry file is already up-to-date, but the INDEX entry may be stale
        // (e.g., built from migration before updatedAt was tracked). Reconcile
        // the index from the entry file so the sync plan sees consistent data
        // and stops re-pushing the same items every cycle.
        const currentIndexEntry = index.entries[existingIdx];
        const freshIndexEntry = toIndexEntry(local);
        if (currentIndexEntry.updatedAt !== freshIndexEntry.updatedAt
          || currentIndexEntry.status !== freshIndexEntry.status
          || currentIndexEntry.archived !== freshIndexEntry.archived) {
          const updatedEntries = [...index.entries];
          updatedEntries[existingIdx] = freshIndexEntry;
          getInboxIndexStore().set('entries', updatedEntries);
          log.debug({ id: item.id }, 'Reconciled stale index entry from entry file');
        }
        return false; // No content change
      }

      // Cloud is newer → replace full item from cloud
      const normalizedItem = normalizeStatusFields({ ...item });
      if (!writeEntryFile(item.id, normalizedItem)) return false;

      const updatedEntries = [...index.entries];
      updatedEntries[existingIdx] = toIndexEntry(normalizedItem);
      getInboxIndexStore().set('entries', updatedEntries);

      log.info({ id: item.id, localUpdatedAt: localEffective, cloudUpdatedAt: cloudEffective }, 'Full-field merge from cloud (cloud is newer)');
      return true;
    }

    // New item: normalize status/archived sync, then write full entry
    const normalizedItem = normalizeStatusFields({ ...item });
    if (!writeEntryFile(normalizedItem.id, normalizedItem)) {
      log.error({ id: normalizedItem.id }, 'Failed to write cloud inbox item entry file');
      return false;
    }

    const newEntries = [toIndexEntry(normalizedItem), ...index.entries];
    getInboxIndexStore().set('entries', newEntries);

    log.info({ id: item.id, title: item.title }, 'Upserted inbox item from cloud');
    return true;
  }

  // Legacy path: skip (legacy store doesn't support cloud upsert)
  return false;
};

// =============================================================================
// Full-field reconciliation (Stage 3: inbox sync)
// =============================================================================

export interface InboxSyncAction {
  /** Items to fetch from cloud and upsert locally */
  toFetchFromCloud: string[];
  /** Items to push from desktop to cloud */
  toPushToCloud: string[];
  /** Items to delete locally (cloud deleted them) */
  toDeleteLocally: string[];
  /** Item IDs to delete on cloud (desktop deleted them) */
  toDeleteOnCloud: string[];
}

/**
 * Effective updatedAt: `updatedAt ?? addedAt`.
 * Items without `updatedAt` (pre-Stage 1 legacy) use `addedAt` as a fallback.
 */
function effectiveUpdatedAt(e: { updatedAt?: number; addedAt: number }): number {
  return e.updatedAt ?? e.addedAt;
}

/**
 * Merge policy for clobbering a locally-executing inbox item from an incoming
 * cloud update. Used by both the sync planner (deciding what to fetch) and
 * the applier (deciding what to write). Centralised here so the two sites
 * cannot drift on what counts as "safe to clobber" — the original bug was
 * caused by exactly that kind of drift.
 *
 * Rule: never clobber a locally-executing item EXCEPT when the incoming
 * cloud item is in a terminal state (completed/dismissed) AND strictly newer.
 * This allows the executor to push completion back to the originating
 * surface without orphaning in-progress work.
 */
export function canClobberLocalExecuting(
  local: { status?: string; updatedAt?: number; addedAt: number },
  incoming: { status?: string; updatedAt?: number; addedAt: number },
): boolean {
  if (local.status !== 'executing') return true; // normal merge rules apply elsewhere
  const incomingIsTerminal = incoming.status === 'completed' || incoming.status === 'dismissed';
  const incomingIsNewer = effectiveUpdatedAt(incoming) > effectiveUpdatedAt(local);
  return incomingIsTerminal && incomingIsNewer;
}

/**
 * Pure function: compute sync actions by comparing local and cloud index state.
 * Desktop wins ties. Locally-executing items are only overwritten by strictly-newer
 * terminal (completed/dismissed) cloud updates — see `canClobberLocalExecuting`.
 */
export function computeInboxSyncPlan(
  localEntries: Array<{ id: string; updatedAt?: number; addedAt: number; status?: string; archived?: boolean }>,
  cloudEntries: Array<{ id: string; updatedAt?: number; addedAt: number; status?: string; archived?: boolean }>,
  localTombstones: Array<{ id: string; deletedAt: number }>,
  cloudTombstones: Array<{ id: string; deletedAt: number }>,
  localHistoryIds: Set<string>,
): InboxSyncAction {
  const localById = new Map(localEntries.map(e => [e.id, e]));
  const cloudById = new Map(cloudEntries.map(e => [e.id, e]));
  const localTombstoneIds = new Set(localTombstones.map(t => t.id));
  const cloudTombstoneMap = new Map(cloudTombstones.map(t => [t.id, t]));

  const toFetchFromCloud: string[] = [];
  const toPushToCloud: string[] = [];
  const toDeleteLocally: string[] = [];
  const toDeleteOnCloud: string[] = [];

  // Cloud → Desktop: check each cloud entry
  for (const cloudEntry of cloudEntries) {
    if (localTombstoneIds.has(cloudEntry.id)) continue; // Desktop deleted it
    if (localHistoryIds.has(cloudEntry.id)) continue; // Already executed locally

    const localEntry = localById.get(cloudEntry.id);
    if (!localEntry) {
      toFetchFromCloud.push(cloudEntry.id); // Missing locally → fetch
    } else if (localEntry.status === 'executing') {
      // Only fetch if the cloud version is a terminal handoff (completed/dismissed,
      // strictly newer) the applier will accept. See canClobberLocalExecuting().
      if (canClobberLocalExecuting(localEntry, cloudEntry)) {
        toFetchFromCloud.push(cloudEntry.id);
      }
    } else if (effectiveUpdatedAt(cloudEntry) > effectiveUpdatedAt(localEntry)) {
      toFetchFromCloud.push(cloudEntry.id); // Cloud is newer → fetch
    }
  }

  // Desktop → Cloud: check each local entry
  for (const localEntry of localEntries) {
    const cloudTombstone = cloudTombstoneMap.get(localEntry.id);
    if (cloudTombstone && cloudTombstone.deletedAt > effectiveUpdatedAt(localEntry)) {
      toDeleteLocally.push(localEntry.id); // Cloud deleted it after our last update
      continue;
    }

    const cloudEntry = cloudById.get(localEntry.id);
    if (!cloudEntry) {
      toPushToCloud.push(localEntry.id); // Missing on cloud → push
    } else if (effectiveUpdatedAt(localEntry) > effectiveUpdatedAt(cloudEntry)) {
      toPushToCloud.push(localEntry.id); // Local is newer → push
    } else if (Boolean(localEntry.archived) !== Boolean(cloudEntry.archived)) {
      // Archive state diverged without updatedAt — desktop is authoritative
      toPushToCloud.push(localEntry.id);
    }
  }

  // Desktop tombstones → Cloud: delete on cloud if cloud still has the item
  for (const tombstone of localTombstones) {
    if (cloudById.has(tombstone.id)) {
      toDeleteOnCloud.push(tombstone.id);
    }
  }

  return { toFetchFromCloud, toPushToCloud, toDeleteLocally, toDeleteOnCloud };
}

// =============================================================================
// Retroactive quality cleanup (runs once to clean existing inbox items)
// =============================================================================

export type CleanupResult = {
  archived: number;
  redirectedToCoach: number;
  details: string[];
  itemsForCoach: Array<{ id: string; title: string; text?: string; sourceLabel?: string }>;
};

/** Bump this when cleanup rules improve — users at lower versions re-run. */
const CLEANUP_VERSION = 16;

// SYNC: must match FYI_TITLE_PREFIXES/FYI_TITLE_PHRASES in packages/shared/src/utils/inboxTiers.ts
const CLEANUP_FYI_PREFIXES = ['fyi:', 'fyi ', 'heads up:'];
const CLEANUP_FYI_PHRASES = ['context if needed', '\u2014 context', '\u2014 fyi', 'just so you know', 'no action needed'];
const CLEANUP_NON_ACTIONABLE_EMOJI_RE = /^[\u{1F3C6}\u{1F389}\u{2B50}\u{1F31F}\u{1F947}\u{1F948}\u{1F949}\u{1F4A1}]\s*/u;

/**
 * Shared freshness heuristic: auto-generated meeting summaries ("Meeting: <topic>").
 * Colon is REQUIRED — "Meeting with John" is a user task, not a summary.
 * These summaries lose value quickly; action items derived from meetings have
 * descriptive titles without the "Meeting:" prefix and are handled by the
 * LLM-based freshness check instead.
 */
const MEETING_SUMMARY_RE = /^Meeting:\s/i;
const MEETING_SUMMARY_STALENESS_MS = 24 * 60 * 60 * 1000; // 24 hours

const RELEVANTDATE_GRACE_MS = 72 * 60 * 60 * 1000; // 72 hours
const RELEVANTDATE_GRACE_WITH_SIGNALS_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const MEETING_PREP_RE = /^prep(are)?\b/i;
const MEETING_PREP_GRACE_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Normalize a legacy source object (e.g. `{ type: 'plaud-import-warning' }`)
 * into the current InboxSource discriminated union. Falls back to a text source
 * so provenance is preserved rather than silently dropped.
 */
const normalizeLegacySource = (source: unknown): TaskSource | undefined => {
  if (!source || typeof source !== 'object') return undefined;

  const sanitized = sanitizeTaskSource(source);
  if (sanitized) return sanitized;

  const raw = source as Record<string, unknown>;
  const label = typeof raw.label === 'string' && raw.label.trim().length > 0
    ? raw.label.trim()
    : typeof raw.type === 'string' && raw.type.trim().length > 0
      ? raw.type.trim()
      : typeof raw.name === 'string' && raw.name.trim().length > 0
        ? raw.name.trim()
        : undefined;

  if (label) return { kind: 'text', label };
  return undefined;
};

/**
 * One-time retroactive cleanup and normalization of existing inbox items.
 *
 * **Quality cleanup** (same rules as write-time filter):
 * - Title too short (≤3 words) → archive
 * - Insight prefixes → archive + return for Coach routing
 * - Expired relevantDate → archive
 * - Duplicates (bigram similarity > 0.85) → archive older copy
 *
 * **Data normalization** (updates surviving items to current schema):
 * - Backfills missing `category` to `'uncategorized'`
 * - Normalizes legacy `source` objects to the current InboxSource union
 *
 * Gated by `retroactiveCleanupComplete` flag in the index store.
 * Returns items that should be routed to Coach (caller handles the routing
 * to avoid circular dependencies with sessionCoachingScheduler).
 */
export const retroactiveInboxCleanup = (): CleanupResult => {
  const noopResult: CleanupResult = { archived: 0, redirectedToCoach: 0, details: [], itemsForCoach: [] };

  if (isUserDataReadOnly()) return noopResult;

  // Trigger migration first so migrationComplete is set for all users
  const index = loadInboxIndex();
  const store = getInboxIndexStore();

  if (!index.migrationComplete) return noopResult;

  // Version gating: read directly from store (loadInboxIndex() doesn't include this field).
  // Boolean true from v1 is treated as version 1.
  const storedCleanupVersion = store.get('retroactiveCleanupVersion');
  const storedCleanupComplete = store.get('retroactiveCleanupComplete');
  const appliedVersion = typeof storedCleanupVersion === 'number'
    ? storedCleanupVersion
    : storedCleanupComplete ? 1 : 0;
  if (appliedVersion >= CLEANUP_VERSION) return noopResult;

  const allEntries = index.entries ?? [];
  const activeEntries = allEntries.filter(e => !e.archived);

  if (activeEntries.length === 0) {
    // Even with no active items, normalize archived items' data before marking complete
    normalizeAllEntryFiles(allEntries, store);
    store.set('retroactiveCleanupVersion', CLEANUP_VERSION);
    log.info('Retroactive cleanup: no active items to process');
    return noopResult;
  }

  const details: string[] = [];
  const idsToArchive = new Set<string>();
  const idsToRedirect = new Set<string>();

  for (const entry of activeEntries) {
    // User-added items are always trusted
    if (entry.category === 'user-request') continue;

    const title = entry.title.trim();
    const isSemiTrusted = entry.category != null && SEMI_TRUSTED_CATEGORIES.includes(entry.category);

    // Meeting prep items expire quickly regardless of trust tier
    if (entry.category === 'meeting-action' && MEETING_PREP_RE.test(title)
        && entry.relevantDate && entry.relevantDate < Date.now()) {
      const expiredMs = Date.now() - entry.relevantDate;
      if (expiredMs > MEETING_PREP_GRACE_MS) {
        idsToArchive.add(entry.id);
        details.push(`Archived "${title}" — meeting prep expired ${Math.round(expiredMs / (60 * 60 * 1000))}h after meeting`);
        continue;
      }
    }

    // ── Full checks (uncategorized only) ─────────────────────────────

    if (!isSemiTrusted) {
      const wordCount = title.split(/\s+/).filter(Boolean).length;

      if (wordCount <= 3) {
        idsToArchive.add(entry.id);
        details.push(`Archived "${title}" — title too short (${wordCount} words)`);
        continue;
      }

      if (entry.relevantDate && entry.relevantDate < Date.now()) {
        const expiredMs = Date.now() - entry.relevantDate;
        const hasSignals = entry.urgent === true || entry.important === true || (entry.tags && entry.tags.length > 0);
        const graceMs = hasSignals ? RELEVANTDATE_GRACE_WITH_SIGNALS_MS : RELEVANTDATE_GRACE_MS;
        if (expiredMs > graceMs) {
          idsToArchive.add(entry.id);
          details.push(`Archived "${title}" — expired (relevantDate ${Math.floor(expiredMs / (24 * 60 * 60 * 1000))}d past, grace: ${Math.floor(graceMs / (24 * 60 * 60 * 1000))}d)`);
          continue;
        }
      }

      const ageMs = Date.now() - entry.addedAt;
      if (/\btoday\b/i.test(title) && ageMs > 24 * 60 * 60 * 1000) {
        idsToArchive.add(entry.id);
        details.push(`Archived "${title}" — references "today" but is ${Math.floor(ageMs / (24 * 60 * 60 * 1000))}d old`);
        continue;
      }

      if (/\bprep\s+for\b/i.test(title) && !entry.relevantDate && ageMs > 48 * 60 * 60 * 1000) {
        idsToArchive.add(entry.id);
        details.push(`Archived "${title}" — meeting prep from ${Math.floor(ageMs / (24 * 60 * 60 * 1000))}d ago with no future date`);
        continue;
      }
    }

    // ── Staleness: meeting summary items (title = "Meeting: <topic>") ──
    // These are auto-generated meeting summaries, NOT action items derived from meetings.
    // Action items from meetings (e.g. "Add flight details to Notion") have descriptive
    // titles without the "Meeting:" prefix and are handled by LLM-based freshness checks.
    // IMPORTANT: colon required — "Meeting with John" is NOT a meeting summary.

    const ageMs = Date.now() - entry.addedAt;
    const ageDays = ageMs / (24 * 60 * 60 * 1000);

    if (MEETING_SUMMARY_RE.test(title) && ageMs > MEETING_SUMMARY_STALENESS_MS) {
      idsToArchive.add(entry.id);
      details.push(`Archived "${title}" — meeting summary from ${Math.floor(ageDays)}d ago`);
      continue;
    }

    // ── Critical safety checks (all categories except user-request) ──

    const matchedPrefix = matchesInsightPrefix(title);
    if (matchedPrefix) {
      idsToRedirect.add(entry.id);
      details.push(`Redirected "${title}" to Coach — insight prefix "${matchedPrefix}"`);
      continue;
    }

    let observationMatch = false;
    for (const pattern of OBSERVATION_PATTERNS) {
      if (pattern.test(title)) {
        idsToRedirect.add(entry.id);
        details.push(`Redirected "${title}" to Coach — observation/status update`);
        observationMatch = true;
        break;
      }
    }
    if (observationMatch) continue;

    // ── FYI content patterns (mirrors FYI_TITLE_PREFIXES/PHRASES from @rebel/shared) ──
    // Only prepared content (draft/clarifyingQuestion) overrides — urgency alone
    // doesn't make a non-actionable item actionable.
    const lowerTitle = title.toLowerCase();
    const matchesFyiTitle = CLEANUP_FYI_PREFIXES.some(p => lowerTitle.startsWith(p))
      || CLEANUP_FYI_PHRASES.some(p => lowerTitle.includes(p));
    if (matchesFyiTitle) {
      const entryItem = readEntryFile(entry.id);
      if (entryItem && !entryItem.draft?.trim() && !entryItem.clarifyingQuestion) {
        idsToRedirect.add(entry.id);
        details.push(`Redirected "${title}" to Coach — FYI content pattern`);
        continue;
      }
    }

    // ── Non-actionable emoji (celebrations + insight 💡) without prepared content ──
    if (CLEANUP_NON_ACTIONABLE_EMOJI_RE.test(title)) {
      const entryItem = readEntryFile(entry.id);
      if (entryItem && !entryItem.draft?.trim() && !entryItem.clarifyingQuestion) {
        idsToRedirect.add(entry.id);
        details.push(`Redirected "${title}" to Coach — celebration/win emoji`);
        continue;
      }
    }

    // ── Wins-and-learnings automation or text source ──
    if (entry.sourceKind === 'automation' || entry.sourceKind === 'text') {
      const entryItem = readEntryFile(entry.id);
      const src = entryItem?.source;
      if (src) {
        if (isWinsLearningsSource(src)) {
          idsToRedirect.add(entry.id);
          details.push(`Redirected "${title}" to Coach — wins-and-learnings source`);
          continue;
        }
      }
    }

    // ── Other-person task check (before action-signal gate, mirrors validateInboxItem) ──
    let otherPersonMatch = false;
    for (const pattern of OTHER_PERSON_TASK_PATTERNS) {
      if (pattern.test(title)) {
        idsToArchive.add(entry.id);
        details.push(`Archived "${title}" — another person's task`);
        otherPersonMatch = true;
        break;
      }
    }
    if (otherPersonMatch) continue;

    // ── Meeting/follow-up action-signal gate (mirrors validateInboxItem) ──
    // Skip items with prepared content (draft/clarifyingQuestion) — read file to check.
    const isEntryMeetingOrFollowUp = entry.category === 'meeting-action' || entry.category === 'follow-up';
    if (isEntryMeetingOrFollowUp) {
      const entryItem = readEntryFile(entry.id);
      const entryBody = entryItem?.text?.trim();
      if (entryBody && isThirdPartyInitiative(entryBody) && !isUserDirectedByThirdParty(entryBody)) {
        idsToRedirect.add(entry.id);
        details.push(`Redirected "${title}" to Coach — third-party initiative without clear user ownership`);
        continue;
      }
      if (!hasUserActionSignal(title)) {
        const hasPrepared = !!entryItem?.draft?.trim() || !!entryItem?.clarifyingQuestion?.trim();
        if (!hasPrepared) {
          idsToRedirect.add(entry.id);
          details.push(`Redirected "${title}" to Coach — meeting/follow-up without action signal`);
          continue;
        }
      }
    }

  }

  // Duplicate detection among remaining active items (keep newest, archive older).
  // Uses aggressive variant (all 3 tiers including keyword Jaccard) because
  // archived items can be restored — acceptable to cast a wider net here.
  const remaining = activeEntries.filter(e => !idsToArchive.has(e.id) && !idsToRedirect.has(e.id));
  const sorted = [...remaining].sort((a, b) => b.addedAt - a.addedAt);
  for (let i = 0; i < sorted.length; i++) {
    if (idsToArchive.has(sorted[i].id)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      if (idsToArchive.has(sorted[j].id)) continue;
      if (isLikelyDuplicateAggressive(sorted[i].title, sorted[j].title)) {
        idsToArchive.add(sorted[j].id);
        details.push(`Archived "${sorted[j].title}" — duplicate of "${sorted[i].title}"`);
      }
    }
  }

  // Downgrade `important` for agent-created items that lack action signals.
  // These are items where the LLM didn't set important explicitly and the
  // old default (true) let them through. They stay in the inbox but stop
  // crowding the homepage. Only touches items that survived the checks above.
  const AGENT_CATEGORIES_CLEANUP: InboxItemCategory[] = ['meeting-action', 'follow-up', 'automation'];
  const idsToDowngrade = new Set<string>();
  for (const entry of remaining) {
    if (!AGENT_CATEGORIES_CLEANUP.includes(entry.category as InboxItemCategory)) continue;
    if (entry.important === false) continue;
    if (hasUserActionSignal(entry.title)) continue;
    idsToDowngrade.add(entry.id);
    details.push(`Downgraded "${entry.title}" — agent-created without action signal, set important=false`);
  }
  for (const id of idsToDowngrade) {
    const item = readEntryFile(id);
    if (item) writeEntryFile(id, { ...item, important: false });
  }

  const now = Date.now();
  const allIdsToArchive = new Set([...idsToArchive, ...idsToRedirect]);

  // Archive flagged items in entry files — use explicit status: 'dismissed'
  // to match the index (normalizeStatusFields would derive 'completed' from
  // archived: true, causing index/entry-file divergence).
  for (const id of allIdsToArchive) {
    const item = readEntryFile(id);
    if (item) {
      writeEntryFile(id, normalizeStatusFields({
        ...item, archived: true, archivedAt: now, status: 'dismissed' as const,
        dismissedAt: now, updatedAt: now,
      }));
    }
  }

  // Update index entries (archive, normalize, and downgrade importance)
  const updatedEntries = allEntries.map(entry => {
    let patched = allIdsToArchive.has(entry.id)
      ? { ...entry, archived: true as const, archivedAt: now, status: 'dismissed' as const, updatedAt: now }
      : entry;
    if (idsToDowngrade.has(entry.id)) {
      patched = { ...patched, important: false };
    }
    return patched.category ? patched : { ...patched, category: 'uncategorized' as const };
  });
  store.set('entries', updatedEntries);

  // Normalize all entry files (source format, category backfill)
  normalizeAllEntryFiles(updatedEntries, store);

  const itemsForCoach: Array<{ id: string; title: string; text?: string; sourceLabel?: string }> = [];
  for (const id of idsToRedirect) {
    const item = readEntryFile(id);
    if (item) {
      const src = item.source;
      const sourceLabel = src
        ? ('label' in src ? src.label : undefined)
          ?? ('automationName' in src ? src.automationName : undefined)
          ?? ('meetingTitle' in src ? src.meetingTitle : undefined)
          ?? src.kind
        : undefined;
      itemsForCoach.push({ id: item.id, title: item.title, text: item.text, sourceLabel });
    }
  }

  store.set('retroactiveCleanupVersion', CLEANUP_VERSION);

  const result: CleanupResult = {
    archived: idsToArchive.size,
    redirectedToCoach: idsToRedirect.size,
    details,
    itemsForCoach,
  };
  log.info(
    { archived: result.archived, redirectedToCoach: result.redirectedToCoach, normalized: allEntries.length, total: activeEntries.length },
    'Retroactive inbox cleanup completed',
  );
  for (const d of details) {
    log.debug(d);
  }
  return result;
};

/**
 * Normalize all entry files to the current schema:
 * - Backfill missing `category` to 'uncategorized'
 * - Convert legacy source formats to current InboxSource union
 */
function normalizeAllEntryFiles(
  entries: ReadonlyArray<InboxIndexEntry>,
  store: KeyValueStore<InboxIndexState>,
): void {
  let normalizedCount = 0;
  let indexChanged = false;
  const updatedEntries = [...entries];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const item = readEntryFile(entry.id);
    if (!item) continue;

    let changed = false;
    const patched = { ...item };

    if (!patched.category) {
      patched.category = 'uncategorized';
      changed = true;
    }

    if (patched.source) {
      const normalized = normalizeLegacySource(patched.source);
      if (normalized && JSON.stringify(normalized) !== JSON.stringify(patched.source)) {
        patched.source = normalized;
        changed = true;
      }
    }

    if (changed) {
      writeEntryFile(entry.id, patched);
      // Preserve archived/status/archivedAt from the existing index entry rather
      // than regenerating from the entry file. The index is the source of truth
      // for these fields, and toIndexEntry(patched) would clobber values that
      // were set by retroactiveInboxCleanup or periodicFreshnessCheck.
      const newIndexEntry = toIndexEntry(patched);
      updatedEntries[i] = {
        ...newIndexEntry,
        archived: entry.archived,
        status: entry.status,
        archivedAt: entry.archivedAt,
        updatedAt: entry.updatedAt,
      };
      indexChanged = true;
      normalizedCount++;
    }
  }

  if (indexChanged) {
    store.set('entries', updatedEntries);
    log.info({ normalizedCount }, 'Normalized entry files to current schema');
  }
}

// =============================================================================
// Periodic freshness check (Stage 10A)
// =============================================================================

export type FreshnessCheckResult = {
  archived: number;
  details: string[];
};

/**
 * Periodic non-LLM freshness check. Runs on every app-open.
 * Archives items that are clearly stale based on metadata alone.
 * Unlike retroactiveInboxCleanup(), this is NOT version-gated — it runs every time.
 * Gated by a "last checked" timestamp to avoid running more than once per hour.
 *
 * Skips `user-request` items — the user explicitly added them and auto-archiving
 * would violate the trust hierarchy established by the two-tier filtering model.
 */
export const periodicFreshnessCheck = (): FreshnessCheckResult => {
  const noopResult: FreshnessCheckResult = { archived: 0, details: [] };
  if (isUserDataReadOnly()) return noopResult;

  const store = getInboxIndexStore();
  const index = loadInboxIndex();
  if (!index.migrationComplete) return noopResult;

  const lastChecked = store.get('lastFreshnessCheck') as number | undefined;
  const ONE_HOUR_MS = 60 * 60 * 1000;
  if (lastChecked && Date.now() - lastChecked < ONE_HOUR_MS) return noopResult;

  const activeEntries = (index.entries ?? []).filter(e => !e.archived);
  if (activeEntries.length === 0) {
    store.set('lastFreshnessCheck', Date.now());
    return noopResult;
  }

  const idsToArchive = new Set<string>();
  const details: string[] = [];
  const now = Date.now();

  for (const entry of activeEntries) {
    if (entry.category === 'user-request') continue;

    const ageMs = now - entry.addedAt;
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const title = entry.title.trim();

    if (entry.relevantDate && entry.relevantDate < now) {
      const expiredMs = now - entry.relevantDate;

      if (entry.category === 'meeting-action' && MEETING_PREP_RE.test(title) && expiredMs > MEETING_PREP_GRACE_MS) {
        idsToArchive.add(entry.id);
        details.push(`Archived "${title}" — meeting prep expired ${Math.round(expiredMs / (60 * 60 * 1000))}h after meeting`);
        continue;
      }

      const hasIndexSignals = entry.urgent === true || entry.important === true || (entry.tags && entry.tags.length > 0);
      if (hasIndexSignals) {
        if (expiredMs > RELEVANTDATE_GRACE_WITH_SIGNALS_MS) {
          idsToArchive.add(entry.id);
          details.push(`Archived "${title}" — relevantDate expired ${Math.floor(expiredMs / (24 * 60 * 60 * 1000))}d ago (grace: 7d, has signals)`);
        }
        continue;
      }
      if (expiredMs <= RELEVANTDATE_GRACE_MS) {
        continue;
      }
      if (expiredMs <= RELEVANTDATE_GRACE_WITH_SIGNALS_MS) {
        const fullItem = readEntryFile(entry.id);
        if (fullItem && (fullItem.draft?.trim() || fullItem.clarifyingQuestion?.trim())) {
          continue;
        }
      }
      idsToArchive.add(entry.id);
      details.push(`Archived "${title}" — relevantDate expired ${Math.floor(expiredMs / (24 * 60 * 60 * 1000))}d ago (grace: 3d)`);
      continue;
    }

    if (/\b(today|this\s+morning|this\s+afternoon|this\s+evening|tonight)\b/i.test(title) && ageMs > 24 * 60 * 60 * 1000) {
      idsToArchive.add(entry.id);
      details.push(`Archived "${title}" — same-day temporal reference is ${Math.floor(ageDays)}d old`);
      continue;
    }

    // "already started/done/fixed" — the work is described as in-progress or complete.
    // After 48h the description is outdated: either user finished it or the status changed.
    const ALREADY_DONE_RE = /\balready\s+(started|begun|in\s+progress|done|completed|resolved|fixed|shipped|handled|addressed|merged|deployed|kicked\s+off)\b/i;
    if (ALREADY_DONE_RE.test(title) && ageMs > 48 * 60 * 60 * 1000) {
      idsToArchive.add(entry.id);
      details.push(`Archived "${title}" — "already in progress" item from ${Math.floor(ageDays)}d ago`);
      continue;
    }

    if (/\bprep\s+for\b/i.test(title) && !entry.relevantDate && ageMs > 48 * 60 * 60 * 1000) {
      idsToArchive.add(entry.id);
      details.push(`Archived "${title}" — meeting prep from ${Math.floor(ageDays)}d ago`);
      continue;
    }

    if (/\b(rsvp|respond\s+to\s+invitation)\b/i.test(title) && ageMs > 48 * 60 * 60 * 1000) {
      idsToArchive.add(entry.id);
      details.push(`Archived "${title}" — RSVP item from ${Math.floor(ageDays)}d ago`);
      continue;
    }

    // Meeting summary staleness — same rule as retroactiveInboxCleanup (see MEETING_SUMMARY_RE).
    // Colon required: "Meeting: Sprint Review" ✓, "Meeting with John" ✗
    if (MEETING_SUMMARY_RE.test(title) && ageMs > MEETING_SUMMARY_STALENESS_MS) {
      idsToArchive.add(entry.id);
      details.push(`Archived "${title}" — meeting summary from ${Math.floor(ageDays)}d ago`);
      continue;
    }

    // Agent-created items (meeting-action, follow-up, automation) older than 14
    // days without a relevantDate/dueBy AND without an action signal in the title
    // are almost certainly stale context/FYI that slipped through prompt filters.
    // Exempt items the user has invested in: important items, tagged items.
    // This is transitional — once prompt improvements ensure new items have dueBy,
    // the stale rule naturally stops applying to them.
    const AGENT_STALE_MS = 14 * 24 * 60 * 60 * 1000;
    const isAgentCategory = entry.category === 'meeting-action' || entry.category === 'follow-up' || entry.category === 'automation';
    const isUserCurated = entry.important === true || (entry.tags && entry.tags.length > 0);
    if (isAgentCategory && !entry.relevantDate && !entry.dueBy && ageMs > AGENT_STALE_MS && !hasUserActionSignal(title) && !isUserCurated) {
      idsToArchive.add(entry.id);
      details.push(`Archived "${title}" — agent-created item from ${Math.floor(ageDays)}d ago with no action signal`);
      continue;
    }
  }

  if (idsToArchive.size > 0) {
    const updatedEntries = index.entries.map(entry =>
      idsToArchive.has(entry.id)
        ? { ...entry, archived: true as const, archivedAt: now, status: 'dismissed' as const, updatedAt: now }
        : entry
    );
    store.set('entries', updatedEntries);

    // Write entry files with explicit status: 'dismissed' to match the index.
    // Without this, normalizeStatusFields derives 'completed' from archived: true,
    // causing index/entry-file divergence that propagates to cloud via pushInboxToCloud.
    for (const id of idsToArchive) {
      const item = readEntryFile(id);
      if (item) {
        writeEntryFile(id, normalizeStatusFields({
          ...item, archived: true, archivedAt: now, status: 'dismissed' as const,
          dismissedAt: now, updatedAt: now,
        }));
      }
    }
  }

  if (idsToArchive.size > 0) {
    emitInboxState(getInboxState());
  }

  store.set('lastFreshnessCheck', Date.now());
  log.info({ archived: idsToArchive.size }, 'Periodic freshness check complete');
  return { archived: idsToArchive.size, details };
};

// =============================================================================
// Metadata-based relevance scoring (Stage 9D)
// =============================================================================

export type RelevanceSignals = {
  ageMs: number;
  hasReferences: boolean;
  hasDraft: boolean;
  hasClarifyingQuestion: boolean;
  category: InboxItemCategory;
  sourceKind?: string; // reserved for future scoring (e.g., meeting-sourced items)
  wordCount: number;
};

/**
 * Compute a 0–100 relevance score from metadata alone (no LLM call).
 * Higher = more relevant. Used for ordering within quadrants, not for filtering.
 */
export const computeRelevanceScore = (signals: RelevanceSignals): number => {
  let score = 50;

  if (signals.category === 'user-request') score += 30;
  else if (signals.category === 'meeting-action') score += 15;
  else if (signals.category === 'follow-up') score += 10;
  else if (signals.category === 'automation') score -= 5;

  if (signals.hasDraft) score += 15;
  if (signals.hasReferences) score += 10;
  if (signals.hasClarifyingQuestion) score += 5;

  const ageDays = signals.ageMs / (24 * 60 * 60 * 1000);
  if (ageDays > 7) score -= 15;
  else if (ageDays > 3) score -= 5;

  if (signals.wordCount <= 5) score -= 5;
  if (signals.wordCount >= 8) score += 5;

  return Math.max(0, Math.min(100, score));
};

export type InboxMutationInput = TaskMutationInput;
