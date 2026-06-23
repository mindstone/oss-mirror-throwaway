/**
 * Pending Physical Recordings Store
 *
 * Tracks physical recording (Limitless/Plaud) transcripts waiting for analysis.
 * Uses electron-store for persistence with demo mode support.
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'pending-physical-recordings' });

/** Store version for migrations */
const STORE_VERSION = 1;

/** Days to keep old entries before cleanup */
const CLEANUP_DAYS = 7;

export type PhysicalRecordingSourceSystem = 'limitless' | 'plaud';

export interface PendingPhysicalRecording {
  /** Composite key: `${sourceSystem}:${sourceUid}` */
  id: string;
  sourceUid: string;
  sourceSystem: PhysicalRecordingSourceSystem;
  filePath: string;
  spacePath?: string;
  meetingTitle: string;
  status: 'pending' | 'analyzing' | 'complete' | 'failed';
  attempts: number;
  createdAt: number;
  lastAttemptAt?: number;
  error?: string;
}

type PendingPhysicalRecordingsState = {
  version: number;
  recordings: PendingPhysicalRecording[];
}

const createDefaultState = (): PendingPhysicalRecordingsState => ({
  version: STORE_VERSION,
  recordings: [],
});

let _store: KeyValueStore<PendingPhysicalRecordingsState> | null = null;
const getStore = (): KeyValueStore<PendingPhysicalRecordingsState> => {
  if (!_store) {
    _store = createStore<PendingPhysicalRecordingsState>({
      name: 'physical-recording-pending',
      defaults: createDefaultState(),
    });
  }
  return _store;
};

function getState(): PendingPhysicalRecordingsState {
  return getStore().store;
}

function saveState(state: PendingPhysicalRecordingsState): void {
  getStore().store = state;
}

/**
 * Check if a pending recording exists (for de-duplication).
 */
export function hasPendingRecording(id: string): boolean {
  const state = getState();
  return state.recordings.some(r => r.id === id);
}

/**
 * Get a pending recording by ID.
 */
export function getPendingRecording(id: string): PendingPhysicalRecording | undefined {
  const state = getState();
  return state.recordings.find(r => r.id === id);
}


/**
 * Mark a recording as complete and remove from store.
 */
export function markComplete(id: string): void {
  const state = getState();
  const index = state.recordings.findIndex(r => r.id === id);
  if (index !== -1) {
    state.recordings.splice(index, 1);
    saveState(state);
    log.info({ id }, 'Recording analysis complete, removed from pending');
  }
}

/**
 * Mark a recording as failed.
 */
export function markFailed(id: string, error: string): void {
  const state = getState();
  const recording = state.recordings.find(r => r.id === id);
  if (recording) {
    recording.status = 'failed';
    recording.error = error;
    saveState(state);
    log.warn({ id, attempts: recording.attempts, error }, 'Recording analysis failed');
  }
}

/**
 * Remove old entries (older than CLEANUP_DAYS).
 */
export function cleanupOldEntries(): number {
  const state = getState();
  const cutoff = Date.now() - CLEANUP_DAYS * 24 * 60 * 60 * 1000;
  const before = state.recordings.length;
  
  state.recordings = state.recordings.filter(r => r.createdAt > cutoff);
  
  const removed = before - state.recordings.length;
  if (removed > 0) {
    saveState(state);
    log.info({ removed }, 'Cleaned up old pending recordings');
  }
  
  return removed;
}
