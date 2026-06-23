/**
 * Conflict-copy cleanup — run-once SURFACING marker (REBEL-62A Stage 3).
 *
 * Cloned from `driveHistoryMigration.ts`'s `createStore` + completion-marker
 * pattern, but with a Stage-3-specific twist (see the Safety Contract + the
 * Stage-3 researcher report §2):
 *
 *   - `completed` gates SCANNING. While `!completed` the startup detect re-runs
 *     on every launch (cheap, read-only) so we keep finding any remaining
 *     backlog. `completed` flips true when a startup scan finds an EMPTY plan
 *     across all spaces (nothing left to clean) — and, in Stage 4, after a
 *     confirmed execute fully drains the plan (mirrors driveHistoryMigration's
 *     "complete only after a clean full pass"). Once `completed`, no more scans.
 *   - `surfaced` gates the TOAST only. The detect keeps scanning while
 *     `!completed`, but the available-cleanup toast is auto-surfaced just ONCE
 *     (`surfaced` flips true on the first non-empty broadcast); subsequent
 *     non-empty scans re-detect silently without re-broadcasting.
 *
 * Pure marker plumbing — no Electron, no filesystem walk; the scan itself lives
 * in `spaceMaintenanceAdapter.scheduleConflictCopyCleanupDetection`. Writes are
 * durable/atomic via the shared `createStore` (electron-store temp-file+rename),
 * the same mechanism `driveHistoryMigration` relies on.
 */
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';

type ConflictCleanupMarkerState = {
  /** True once the available-cleanup toast has been auto-surfaced (once-per-install). */
  surfaced: boolean;
  surfacedAt: number | null;
  /** The runId of the most-recently surfaced/detected plan (for dedup + execute). */
  lastDetectRunId: string | null;
  /** True only after a confirmed execute fully drained the plan. */
  completed: boolean;
  completedAt: number | null;
};

const createDefaultState = (): ConflictCleanupMarkerState => ({
  surfaced: false,
  surfacedAt: null,
  lastDetectRunId: null,
  completed: false,
  completedAt: null,
});

let _store: KeyValueStore<ConflictCleanupMarkerState> | null = null;

function getStore(): KeyValueStore<ConflictCleanupMarkerState> {
  if (!_store) {
    _store = createStore<ConflictCleanupMarkerState>({
      name: 'conflict-copy-cleanup-migration',
      defaults: createDefaultState(),
    });
  }
  return _store;
}

/** True once the toast has been auto-surfaced (gates the TOAST, not scanning). */
export function isConflictCleanupSurfaced(): boolean {
  return getStore().get('surfaced') === true;
}

/**
 * True once the backlog is fully drained (gates SCANNING). Flips when a startup
 * scan finds an empty plan across all spaces, or after a confirmed full execute.
 */
export function isConflictCleanupCompleted(): boolean {
  return getStore().get('completed') === true;
}

/** Record that the available-cleanup toast was auto-surfaced for a given run. */
export function markConflictCleanupSurfaced(runId: string, now: number): void {
  const store = getStore();
  store.set('surfaced', true);
  store.set('surfacedAt', now);
  store.set('lastDetectRunId', runId);
}

/** Record that the cleanup is fully done (no more scanning/surfacing). */
export function markConflictCleanupCompleted(now: number): void {
  const store = getStore();
  store.set('completed', true);
  store.set('completedAt', now);
}

export function getLastConflictCleanupRunId(): string | null {
  return getStore().get('lastDetectRunId') ?? null;
}

export function resetConflictCopyCleanupStateForTests(): void {
  _store = null;
}
