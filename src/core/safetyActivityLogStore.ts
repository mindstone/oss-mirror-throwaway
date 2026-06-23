/**
 * Safety Activity Log Store
 *
 * Bounded ring buffer store for safety evaluation entries and version
 * change events. Uses the core StoreFactory for platform-agnostic persistence.
 * Max SAFETY_ACTIVITY_LOG_MAX_ENTRIES entries; oldest are dropped when capacity is exceeded.
 */

import { createScopedLogger } from '@core/logger';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import type {
  ActivityLogEntry,
  EvaluationEntry,
  VersionChangeEntry,
  SafetyActivityLogStoreSchema,
} from './safetyActivityLogTypes';
import { SAFETY_ACTIVITY_LOG_MAX_ENTRIES } from './safetyActivityLogTypes';

const log = createScopedLogger({ service: 'safetyActivityLogStore' });

export const SAFETY_ACTIVITY_LOG_STORE_VERSION = 1;

const createDefaultState = (): SafetyActivityLogStoreSchema => ({
  entries: [],
});

let _store: KeyValueStore<SafetyActivityLogStoreSchema> | null = null;

function getStore(): KeyValueStore<SafetyActivityLogStoreSchema> {
  if (!_store) {
    _store = createStore<SafetyActivityLogStoreSchema>({
      name: 'safety-activity-log',
      defaults: createDefaultState(),
    });
  }
  return _store;
}

function compareEntriesChronologically(a: ActivityLogEntry, b: ActivityLogEntry): number {
  const timestampDiff = a.timestamp - b.timestamp;
  if (timestampDiff !== 0) {
    return timestampDiff;
  }
  return a.id.localeCompare(b.id);
}

function capNewestEntries(entries: ActivityLogEntry[]): ActivityLogEntry[] {
  return [...entries]
    .sort(compareEntriesChronologically)
    .slice(-SAFETY_ACTIVITY_LOG_MAX_ENTRIES);
}

/**
 * Get all activity log entries, newest-first.
 */
export function getActivityLog(): ActivityLogEntry[] {
  try {
    const entries = getStore().get('entries', []);
    // Stored in chronological order; return newest-first
    return [...entries].reverse();
  } catch (error) {
    log.error({ err: error }, 'Failed to read activity log');
    return [];
  }
}

/**
 * Merge already-validated cloud activity entries into the local log.
 *
 * Existing rows are audit-immutable: same-id incoming entries are ignored so a
 * re-fetch cannot rewrite persisted audit text or local flag state.
 *
 * Returns `{ added }` (0 when there is nothing new). **Throws** if persistence
 * fails — the caller (the S3 cloud catch-up) owns the user-facing sync state and
 * must distinguish a failed merge from "nothing new" so the Safety Activity Log
 * never looks falsely complete after a failed cloud sync.
 */
export function mergeEntries(incoming: ActivityLogEntry[]): { added: number } {
  if (incoming.length === 0) {
    return { added: 0 };
  }

  try {
    const store = getStore();
    // Read inside the synchronous mutation path so this second writer preserves
    // any desktop append that landed before the merge call.
    const currentEntries = store.get('entries', []);
    const entriesById = new Map(
      currentEntries.map((entry): [string, ActivityLogEntry] => [entry.id, entry]),
    );
    let added = 0;

    for (const entry of incoming) {
      if (entriesById.has(entry.id)) {
        continue;
      }

      const cloudEntry: ActivityLogEntry = {
        ...entry,
        executionSurface: 'cloud',
      };
      entriesById.set(cloudEntry.id, cloudEntry);
      added += 1;
    }

    if (added === 0) {
      return { added: 0 };
    }

    store.set('entries', capNewestEntries([...entriesById.values()]));
    log.debug({ added, incomingCount: incoming.length }, 'Merged cloud entries into activity log');
    return { added };
  } catch (error) {
    // Log with context AND rethrow: returning { added: 0 } here would be
    // indistinguishable from "no new entries", letting S3's sync-state affordance
    // show a complete history after a failed local merge (the exact
    // false-completeness this feature exists to prevent).
    log.error({ err: error, incomingCount: incoming.length }, 'Failed to merge activity log entries');
    throw error;
  }
}

/**
 * Add a safety evaluation entry to the log.
 * Ring buffer: drops oldest entry when at capacity.
 */
export function addEvaluationEntry(
  entry: Omit<EvaluationEntry, 'id' | 'timestamp' | 'type'>,
): void {
  try {
    const store = getStore();
    const entries = store.get('entries', []);

    const newEntry: EvaluationEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'evaluation',
      ...entry,
    };

    const updated = [...entries, newEntry];
    // Ring buffer: keep only the newest MAX entries
    if (updated.length > SAFETY_ACTIVITY_LOG_MAX_ENTRIES) {
      updated.splice(0, updated.length - SAFETY_ACTIVITY_LOG_MAX_ENTRIES);
    }

    store.set('entries', updated);
    log.debug(
      { entryId: newEntry.id, decision: entry.decision, tool: entry.toolId },
      'Added evaluation entry to activity log',
    );
  } catch (error) {
    log.error({ err: error }, 'Failed to add evaluation entry to activity log');
  }
}

/**
 * Add a version change entry to the log.
 */
export function addVersionChangeEntry(
  fromVersion: number,
  toVersion: number,
  source?: VersionChangeEntry['source'],
): void {
  try {
    const store = getStore();
    const entries = store.get('entries', []);

    const newEntry: ActivityLogEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'version-change',
      fromVersion,
      toVersion,
      ...(source ? { source } : {}),
    };

    const updated = [...entries, newEntry];
    if (updated.length > SAFETY_ACTIVITY_LOG_MAX_ENTRIES) {
      updated.splice(0, updated.length - SAFETY_ACTIVITY_LOG_MAX_ENTRIES);
    }

    store.set('entries', updated);
    log.debug(
      { entryId: newEntry.id, fromVersion, toVersion, source },
      'Added version change entry to activity log',
    );
  } catch (error) {
    log.error({ err: error }, 'Failed to add version change entry to activity log');
  }
}

/**
 * Flag an entry as incorrect. Returns true if the entry was found and flagged.
 */
export function flagEntry(entryId: string): boolean {
  try {
    const store = getStore();
    const entries = store.get('entries', []);
    const index = entries.findIndex((e) => e.id === entryId);

    if (index === -1) {
      return false;
    }

    const entry = entries[index];
    if (entry.type !== 'evaluation' || entry.decision !== 'allowed') {
      return false;
    }

    const updated = [...entries];
    updated[index] = { ...entry, flagged: true };
    store.set('entries', updated);

    log.info({ entryId }, 'Flagged activity log entry');
    return true;
  } catch (error) {
    log.error({ err: error, entryId }, 'Failed to flag activity log entry');
    return false;
  }
}

/**
 * Unflag a previously flagged entry. Returns true if the entry was found and unflagged.
 */
export function unflagEntry(entryId: string): boolean {
  try {
    const store = getStore();
    const entries = store.get('entries', []);
    const index = entries.findIndex((e) => e.id === entryId);

    if (index === -1) {
      return false;
    }

    const entry = entries[index];
    if (entry.type !== 'evaluation' || !entry.flagged) {
      return false;
    }

    const updated = [...entries];
    updated[index] = { ...entry, flagged: false };
    store.set('entries', updated);

    log.info({ entryId }, 'Unflagged activity log entry');
    return true;
  } catch (error) {
    log.error({ err: error, entryId }, 'Failed to unflag activity log entry');
    return false;
  }
}

/**
 * Clear all activity log entries. Internal/test-only — no IPC channel.
 */
export function clearActivityLog(): void {
  try {
    getStore().set('entries', []);
    log.info('Cleared activity log');
  } catch (error) {
    log.error({ err: error }, 'Failed to clear activity log');
  }
}

/**
 * Reset the store reference for testing.
 */
export function resetStoreForTesting(): void {
  _store = null;
}
