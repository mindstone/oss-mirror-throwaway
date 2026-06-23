/**
 * Import Tracking Store
 *
 * Tracks which external transcripts have been imported to avoid duplicates.
 * Uses electron-store for persistence with demo mode support.
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import type { ExternalProvider } from './types';

const log = createScopedLogger({ service: 'import-tracking' });

/** Store version for migrations */
const STORE_VERSION = 1;

/** How long to keep import records (90 days) */
const RETENTION_DAYS = 90;

/** Maximum records to keep */
const MAX_RECORDS = 5000;

/**
 * Record of an imported transcript.
 */
export interface ImportedTranscript {
  /** Provider's transcript ID */
  externalId: string;
  /** Which provider */
  provider: ExternalProvider;
  /** When it was imported */
  importedAt: string;
  /** Where it was saved */
  savedPath: string;
  /** Meeting title (for reference) */
  title?: string;
}

/** Store schema */
type ImportTrackingState = {
  version: number;
  /** Last sync time per provider */
  lastSyncTimes: Record<ExternalProvider, string | null>;
  /** Imported transcripts keyed by "provider:externalId" */
  imports: Record<string, ImportedTranscript>;
}

const createDefaultState = (): ImportTrackingState => ({
  version: STORE_VERSION,
  lastSyncTimes: {
    fireflies: null,
    fathom: null,
  },
  imports: {},
});

/** Lazy-initialized store instance */
let _store: KeyValueStore<ImportTrackingState> | null = null;
const getStore = (): KeyValueStore<ImportTrackingState> => {
  if (!_store) {
    _store = createStore<ImportTrackingState>({
      name: 'meeting-bot-imports',
      defaults: createDefaultState(),
    });
  }
  return _store;
};

/**
 * Get current state.
 */
function getState(): ImportTrackingState {
  return getStore().store;
}

/**
 * Save state.
 */
function saveState(state: ImportTrackingState): void {
  getStore().store = state;
}

/**
 * Generate key for import record.
 */
function makeKey(provider: ExternalProvider, externalId: string): string {
  return `${provider}:${externalId}`;
}

/**
 * Check if a transcript has already been imported.
 */
export function isAlreadyImported(provider: ExternalProvider, externalId: string): boolean {
  const state = getState();
  const key = makeKey(provider, externalId);
  return key in state.imports;
}

/**
 * Mark a transcript as imported.
 */
export function markAsImported(record: ImportedTranscript): void {
  const state = getState();
  const key = makeKey(record.provider, record.externalId);

  state.imports[key] = {
    ...record,
    importedAt: record.importedAt || new Date().toISOString(),
  };

  saveState(state);
  log.debug({ provider: record.provider, externalId: record.externalId }, 'Marked transcript as imported');
}

/**
 * Get the last sync time for a provider.
 */
export function getLastSyncTime(provider: ExternalProvider): Date | null {
  const state = getState();
  const time = state.lastSyncTimes[provider];
  return time ? new Date(time) : null;
}

/**
 * Update the last sync time for a provider.
 */
export function setLastSyncTime(provider: ExternalProvider, time: Date): void {
  const state = getState();
  state.lastSyncTimes[provider] = time.toISOString();
  saveState(state);
  log.debug({ provider, time: time.toISOString() }, 'Updated last sync time');
}


/**
 * Clean up old import records beyond retention period.
 */
export function cleanupOldRecords(): number {
  const state = getState();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let removed = 0;

  const newImports: Record<string, ImportedTranscript> = {};
  const records = Object.entries(state.imports);

  // Sort by importedAt descending to keep newest
  records.sort((a, b) => {
    const dateA = new Date(a[1].importedAt).getTime();
    const dateB = new Date(b[1].importedAt).getTime();
    return dateB - dateA;
  });

  for (const [key, record] of records) {
    // Skip if beyond retention
    if (new Date(record.importedAt) < cutoff) {
      removed++;
      continue;
    }

    // Skip if at max records
    if (Object.keys(newImports).length >= MAX_RECORDS) {
      removed++;
      continue;
    }

    newImports[key] = record;
  }

  if (removed > 0) {
    state.imports = newImports;
    saveState(state);
    log.info({ removed }, 'Cleaned up old import records');
  }

  return removed;
}
