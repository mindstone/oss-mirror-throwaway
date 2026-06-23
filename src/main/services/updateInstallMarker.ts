import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'updateInstallMarker' });

/**
 * Persisted marker recording an in-flight Install & Relaunch attempt.
 *
 * `updateKey` and `targetVersion` are optional ONLY for back-compat with
 * markers written by app versions that pre-date Stage 1 of the install
 * completion contract (`docs/plans/260428_install_completion_contract.md`).
 * Stage 5 wires `safeQuitAndInstall*()` to populate `targetVersion` and
 * `updateKey` on every new write; until then existing call sites continue
 * to write only `fromVersion` + `requestedAt`.
 */
export type UpdateInstallMarker = {
  /**
   * Stable key uniquely identifying the downloaded update (channel/platform/arch/version).
   * Optional for back-compat — older markers may not carry this field.
   */
  updateKey?: string;
  /** Version of the app at the moment Install & Relaunch was triggered. */
  fromVersion: string;
  /**
   * Version the user expected to land on (the `pending.versionLabel`).
   * Optional for back-compat. When present, reconciliation uses
   * `currentVersion === targetVersion` as the decisive "applied" signal.
   */
  targetVersion?: string;
  requestedAt: number;
};

type UpdateInstallMarkerStore = {
  pendingInstall?: UpdateInstallMarker | null;
};

let _updateInstallMarkerStore: KeyValueStore<UpdateInstallMarkerStore> | null = null;
const getUpdateInstallMarkerStore = () => _updateInstallMarkerStore ??= createStore<UpdateInstallMarkerStore>({ name: 'update-install-marker' });

export function markUpdateInstallRequested(marker: UpdateInstallMarker): void {
  getUpdateInstallMarkerStore().set('pendingInstall', marker);
}

/**
 * Read the persisted install marker.
 *
 * Wrapped in try/catch so a corrupt marker file (parse failure inside
 * `electron-store` / `conf`) cannot crash the module-load-time reconciliation
 * in `main/index.ts`. Treats parse failure as "no marker" and emits a
 * structured warn log so the failure is observable.
 */
export function getUpdateInstallMarker(): UpdateInstallMarker | null {
  try {
    return getUpdateInstallMarkerStore().get('pendingInstall', null) ?? null;
  } catch (err) {
    log.warn(
      { err },
      'Failed to read update install marker (corrupt JSON?), treating as absent',
    );
    return null;
  }
}

export function clearUpdateInstallMarker(): void {
  getUpdateInstallMarkerStore().set('pendingInstall', null);
}

// NOTE (REBEL-53B): the legacy `reconcileUpdateInstallMarkerOnStartup`
// helper was deleted as part of the install-completion rearchitecture. The
// single source of truth for reconciliation policy is now
// `decideInstallCompletion()` (in `installCompletionReconciliation.ts`),
// which is exercised through `handleInstallMarkerStartupReconciliation()`
// at startup. See
// `docs-private/investigations/260429_rebel_53b_stuck_install_false_positive.md`.
