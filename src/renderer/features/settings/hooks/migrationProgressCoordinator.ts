/**
 * Migration Progress Coordinator
 *
 * Tiny cross-hook coordinator that lets `useCloudProvisioning` (and any
 * future sibling flow) mark a migration as in-progress so `useCloudSync`'s
 * `'cloud:migration-progress'` listener stops gating events out.
 *
 * Why a separate module:
 *   The cloud hooks follow a star topology — `useCloudProvisioning` and
 *   `useCloudSync` must not import each other. This file acts as the
 *   neutral ground through which they coordinate a shared module-level
 *   flag.
 *
 * Without this, the switch-provider flow broadcasts migration progress
 * from the main process, but the renderer's `useCloudSync` hook discards
 * the events because `_syncInProgress` was only set by the `migrate()`
 * path. The net effect was a silent UI during a provider switch despite
 * the backend doing work.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 2 — Review-Driven Amendments → `_syncInProgress` flag coverage)
 */

import type { CloudMigrationProgress } from '@shared/cloudMigrationTypes';

type State = {
  syncInProgress: boolean;
  lastProgress: CloudMigrationProgress | null;
};

/**
 * Module-level backing store. Shared between `useCloudSync` (which both
 * reads and writes it from inside the hook) and `useCloudProvisioning`
 * (which marks migration as in-progress around an outer flow such as
 * `cloud:switch-provider`).
 */
const state: State = {
  syncInProgress: false,
  lastProgress: null,
};

/** Read the current sync-in-progress flag. */
export function isMigrationInProgress(): boolean {
  return state.syncInProgress;
}

/** Read the last-seen progress snapshot (null before the first event). */
export function getLastProgress(): CloudMigrationProgress | null {
  return state.lastProgress;
}

/**
 * Mutate the sync-in-progress flag from inside `useCloudSync`'s hook
 * implementation. External callers should use `beginExternalMigration`
 * / `endExternalMigration` instead.
 */
export function setSyncInProgress(value: boolean): void {
  state.syncInProgress = value;
}

/** Update the last-seen progress snapshot. */
export function setLastProgress(progress: CloudMigrationProgress | null): void {
  state.lastProgress = progress;
}

/**
 * Mark a migration as in-progress from outside `useCloudSync` so its
 * progress-event listener forwards incoming events to the UI. Used by
 * the provider-switch flow, which does not call `window.cloudApi.migrate`
 * directly yet still causes the main process to emit migration events.
 */
export function beginExternalMigration(): void {
  state.syncInProgress = true;
}

/** Clear the external migration flag and last-progress snapshot. */
export function endExternalMigration(): void {
  state.syncInProgress = false;
  state.lastProgress = null;
}

/** Test seam — resets the coordinator back to its initial state. */
export function __resetMigrationCoordinatorForTesting(): void {
  state.syncInProgress = false;
  state.lastProgress = null;
}
