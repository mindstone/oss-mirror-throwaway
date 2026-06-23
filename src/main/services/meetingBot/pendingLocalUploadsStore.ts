/**
 * Pending Local Uploads Store
 *
 * Tracks local recording uploads that are waiting for transcription.
 * Survives app restarts so uploads are not lost.
 * Uses electron-store for persistence with demo mode support.
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'local-upload-store' });

/**
 * Store version for migrations.
 *
 * v2: added the `transport` discriminator to `PendingLocalUpload`. Records
 * persisted under v1 predate any direct-to-Recall path, so they default to
 * `'worker'` on load (see `migrateAddTransport`).
 */
const STORE_VERSION = 2;

/** How long to keep pending uploads before expiry (7 days) */
const EXPIRY_DAYS = 7;

/** Maximum number of pending uploads to keep */
const MAX_PENDING = 20;

/** Status of a pending local upload */
export type PendingLocalUploadStatus = 'uploading' | 'transcribing' | 'failed';

/**
 * Which transport created/owns this upload.
 * - `'worker'`: created via the Cloudflare Worker (today's only path).
 * - `'direct'`: created directly against Recall with a user-supplied key (later stage).
 */
export type PendingLocalUploadTransport = 'worker' | 'direct';

/** Schema for a pending local upload */
export interface PendingLocalUpload {
  uploadId: string;
  clientSecret: string;
  meetingTitle: string;
  createdAt: string;
  expiresAt: string;
  status: PendingLocalUploadStatus;
  pollAttempts: number;
  lastPollAt?: string;
  errorMessage?: string;
  /**
   * Transport that owns this upload. REQUIRED on new records (written as
   * `'worker'` this stage). Old persisted records without it default to
   * `'worker'` on load so restart-recovery routes them correctly.
   */
  transport: PendingLocalUploadTransport;
  /**
   * Recall's native upload id, used to address Recall directly on the `'direct'`
   * transport (the worker maps `uploadId`→Recall id server-side, so the worker
   * path does not need this). Unset for `'worker'` records.
   */
  recallUploadId?: string;
}

/** Store schema */
type PendingLocalUploadsState = {
  version: number;
  uploads: PendingLocalUpload[];
}

const createDefaultState = (): PendingLocalUploadsState => ({
  version: STORE_VERSION,
  uploads: [],
});

/** Lazy-initialized store instance */
let _store: KeyValueStore<PendingLocalUploadsState> | null = null;
const getStore = (): KeyValueStore<PendingLocalUploadsState> => {
  if (!_store) {
    _store = createStore<PendingLocalUploadsState>({
      name: 'meeting-bot-local-uploads',
      defaults: createDefaultState(),
    });
    migrateAddTransport(_store);
  }
  return _store;
};

/**
 * Idempotent migration: existing persisted records predate the `transport`
 * discriminator. They were all created via the worker, so default them to
 * `'worker'` on load. Also bumps the stored `version` to the current value.
 */
function migrateAddTransport(store: KeyValueStore<PendingLocalUploadsState>): void {
  const state = store.store;
  let migrated = 0;

  const updated = state.uploads.map(u => {
    if (u.transport === undefined) {
      migrated++;
      return { ...u, transport: 'worker' as const };
    }
    return u;
  });

  if (migrated > 0 || state.version !== STORE_VERSION) {
    store.store = { ...state, version: STORE_VERSION, uploads: updated };
    if (migrated > 0) {
      log.info({ migrated }, 'Defaulted legacy pending local uploads to worker transport');
    }
  }
}

/**
 * Get current state.
 */
function getState(): PendingLocalUploadsState {
  return getStore().store;
}

/**
 * Save state.
 */
function saveState(state: PendingLocalUploadsState): void {
  getStore().store = state;
}

/**
 * Get all pending local uploads.
 */
export function getPendingLocalUploads(): PendingLocalUpload[] {
  const state = getState();
  return state.uploads;
}

/**
 * Get pending uploads that need polling (not complete/failed, not expired).
 */
export function getPendingLocalUploadsNeedingPoll(): PendingLocalUpload[] {
  const state = getState();
  const now = Date.now();
  
  return state.uploads.filter(u => {
    // Skip completed or failed
    if (u.status === 'failed') return false;
    // Skip expired
    if (new Date(u.expiresAt).getTime() < now) return false;
    return true;
  });
}

/**
 * Add a new pending local upload.
 */
export function addPendingLocalUpload(upload: Omit<PendingLocalUpload, 'createdAt' | 'expiresAt' | 'pollAttempts' | 'status'>): void {
  const state = getState();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const newUpload: PendingLocalUpload = {
    ...upload,
    createdAt: now,
    expiresAt,
    status: 'uploading',
    pollAttempts: 0,
  };

  // Remove duplicates and add new
  const filtered = state.uploads.filter(u => u.uploadId !== upload.uploadId);
  const updated = [newUpload, ...filtered].slice(0, MAX_PENDING);

  saveState({
    ...state,
    uploads: updated,
  });

  log.info({ uploadId: upload.uploadId, meetingTitle: upload.meetingTitle }, 'Added pending local upload');
}

/**
 * Update status of a pending local upload.
 */
export function updatePendingLocalUploadStatus(
  uploadId: string,
  status: PendingLocalUploadStatus,
  errorMessage?: string
): void {
  const state = getState();
  const updated = state.uploads.map(u => {
    if (u.uploadId === uploadId) {
      return { ...u, status, errorMessage };
    }
    return u;
  });

  saveState({ ...state, uploads: updated });
  log.debug({ uploadId, status, errorMessage }, 'Updated pending local upload status');
}

/**
 * Remove a pending local upload (on completion or permanent failure).
 */
export function removePendingLocalUpload(uploadId: string): void {
  const state = getState();
  const updated = state.uploads.filter(u => u.uploadId !== uploadId);

  saveState({ ...state, uploads: updated });
  log.info({ uploadId }, 'Removed pending local upload');
}

/**
 * Clean up expired uploads.
 */
export function cleanupExpiredUploads(): number {
  const state = getState();
  const now = Date.now();
  const before = state.uploads.length;
  
  const updated = state.uploads.filter(u => {
    const expiresAt = new Date(u.expiresAt).getTime();
    return expiresAt > now;
  });

  if (updated.length !== before) {
    saveState({ ...state, uploads: updated });
    const removed = before - updated.length;
    log.info({ removed }, 'Cleaned up expired local uploads');
    return removed;
  }
  
  return 0;
}


