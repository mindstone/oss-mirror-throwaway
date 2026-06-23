/**
 * Auto-Update State Store
 *
 * Persistent store that captures the latest auto-update lifecycle state.
 * Survives app restarts so diagnostics can report update status even after
 * the 15-minute log window has passed.
 *
 * Follows the same pattern as updateInstallMarker.ts.
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import type { AutoUpdateForensics } from '@core/services/diagnostics/manifest';
import { getUpdateInstallMarker, type UpdateInstallMarker } from './updateInstallMarker';

const log = createScopedLogger({ service: 'autoUpdateStateStore' });

/**
 * Legacy stuck-install record. Originally written by reconciliation when an
 * Install & Relaunch attempt didn't actually swap the bundle.
 *
 * After REBEL-53B (investigation `260429_rebel_53b_stuck_install_false_positive.md`)
 * this type is **read-only**: reconciliation no longer writes a non-null
 * value, the bespoke recovery dialog has been deleted, and the field is
 * preserved only so existing on-disk state can be migrated / cleared on the
 * next startup. The `recoveryAttempts` map below is the new source of truth
 * for the silent auto-heal counter.
 */
export type StuckInstall = {
  /** Same shape as `acknowledgedUpdateKeys` (channel:platform:arch:version). */
  updateKey: string;
  fromVersion: string;
  targetVersion: string;
  attemptedAt: number;
  platform: 'darwin' | 'win32' | 'linux';
  /** Bumped on each subsequent stuck detection for the same updateKey. */
  attemptCount: number;
  lastFailedAt: number;
};

/**
 * Legacy analytics queue entry. Originally drained after `initAnalytics()`.
 *
 * After REBEL-53B no longer written. Preserved on the schema so the
 * post-init flush in `main/index.ts` can drain any leftover entries from
 * pre-REBEL-53B builds (and the migration step can drop regression-tainted
 * `(unknown)`-targetVersion entries).
 */
export type PendingStuckInstallEvent = {
  updateKey: string;
  fromVersion: string;
  targetVersion: string;
  detectedAt: number;
};

export type AutoUpdateState = {
  lastCheckAt: number | null;
  lastCheckResult: 'available' | 'not-available' | 'error' | null;
  lastCheckUrl: string | null;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  lastDownloadedVersion: string | null;
  lastDownloadedAt: number | null;
  initSucceeded: boolean | null;
  appVersionAtLastEvent: string | null;
  // macOS relaunch watchdog telemetry (see spawnRelaunchWatchdog in autoUpdateService.ts).
  // Populated on the launch AFTER an "Install & Relaunch" by consumeWatchdogTelemetryOnStartup.
  watchdogLastRanAt: number | null;
  watchdogOldPidWaitSec: number | null;
  watchdogShipItWaitSec: number | null;
  watchdogAppAlreadyRunning: boolean | null;
  watchdogOpenFired: boolean | null;
  // Stage 1 (install completion contract) — schema additions only; no consumers
  // wired up yet. See docs/plans/260428_install_completion_contract.md.
  /** True iff the watchdog detected the on-disk bundle did not advance to the new version. */
  watchdogInstallFailedBundleVersionUnchanged: boolean | null;
  /** Reported on-disk `CFBundleShortVersionString` at watchdog time (or "unknown"). */
  watchdogOnDiskVersion: string | null;
  /**
   * Out-of-process force-kill escalation (260622): the strongest signal the
   * relaunch watchdog sent to the wedged old PID. `'none'` on a normal install
   * (the old PID died on its own); `'TERM'`/`'KILL'` when the external killer
   * fired because the old PID outlived its budget. Populated on the launch
   * AFTER an "Install & Relaunch" by consumeWatchdogTelemetryOnStartup.
   */
  watchdogExternalForceKillSignal: 'none' | 'TERM' | 'KILL' | null;
  /**
   * Out-of-process force-kill escalation (260622): identity-guard outcome, so a
   * never-matching guard is observable rather than a silent no-op.
   */
  watchdogExternalForceKillGuardOutcome: 'na' | 'identityMatched' | 'identityMismatch' | null;
  /**
   * Legacy stuck-install record (pre-REBEL-53B). After the rearchitecture
   * reconciliation never writes a non-null value here; the field is kept
   * for back-compat reads + one-time migration clears stale records left
   * over from `f9adb3848`.
   */
  stuckInstall: StuckInstall | null;
  /**
   * Legacy analytics queue (pre-REBEL-53B). Drained on next startup; never
   * enqueued by current code.
   */
  pendingStuckInstallEvents: PendingStuckInstallEvent[];
  /**
   * REBEL-53B silent auto-heal counter, keyed by updateKey.
   * `silentAutoHealStuckInstall(updateKey)` increments this once per key;
   * a counter of `>= 1` means we've already attempted silent recovery for
   * that key and the next surface should adapt its copy (no second silent
   * retry — the renderer surfaces an "install didn't take" affordance via
   * `UpdateAvailableToast`).
   */
  recoveryAttempts: Record<string, number>;
}

const defaults: AutoUpdateState = {
  lastCheckAt: null,
  lastCheckResult: null,
  lastCheckUrl: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  lastDownloadedVersion: null,
  lastDownloadedAt: null,
  initSucceeded: null,
  appVersionAtLastEvent: null,
  watchdogLastRanAt: null,
  watchdogOldPidWaitSec: null,
  watchdogShipItWaitSec: null,
  watchdogAppAlreadyRunning: null,
  watchdogOpenFired: null,
  watchdogInstallFailedBundleVersionUnchanged: null,
  watchdogOnDiskVersion: null,
  watchdogExternalForceKillSignal: null,
  watchdogExternalForceKillGuardOutcome: null,
  stuckInstall: null,
  pendingStuckInstallEvents: [],
  recoveryAttempts: {},
};

let _store: KeyValueStore<AutoUpdateState> | null = null;
const getStore = () => _store ??= createStore<AutoUpdateState>({
  name: 'auto-update-state',
  defaults,
});

/**
 * Merge partial update state into the persistent store.
 * Best-effort: swallows write errors to avoid disrupting update event handlers.
 *
 * Stage 5 callers that need to observe write success (e.g. before clearing
 * the install marker) should use {@link updateAutoUpdateStateChecked} instead.
 */
export function updateAutoUpdateState(partial: Partial<AutoUpdateState>): void {
  try {
    for (const [key, value] of Object.entries(partial)) {
      getStore().set(key as keyof AutoUpdateState, value);
    }
  } catch {
    // Swallow errors (disk full, corrupted file) to avoid disrupting autoUpdater event handlers
  }
}

/**
 * Variant of {@link updateAutoUpdateState} that observes write failure.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, error }` if any `set()`
 * call throws (disk full, locked file, corrupt JSON). Callers that gate
 * subsequent destructive actions (e.g. clearing the install marker only after
 * `stuckInstall` is durably persisted) MUST use this variant — see Stage 1
 * critique C4 in `docs/plans/260428_install_completion_contract.md`.
 */
export function updateAutoUpdateStateChecked(
  partial: Partial<AutoUpdateState>,
): { ok: boolean; error?: string } {
  try {
    for (const [key, value] of Object.entries(partial)) {
      getStore().set(key as keyof AutoUpdateState, value);
    }
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ err, partialKeys: Object.keys(partial) }, 'Failed to persist auto-update state');
    return { ok: false, error };
  }
}

/**
 * Read the full persisted auto-update state.
 *
 * Runtime normalization: returned object is `{ ...defaults, ...stored }` so
 * that an OLD state file on disk (written before the Stage 1 schema additions)
 * yields explicit `null` / `[]` defaults for new fields rather than
 * `undefined`. Stage 5 + 6 consumers rely on this normalization to avoid
 * `undefined`-vs-`null` branching.
 *
 * Wrapped in try/catch so a corrupt state file (parse failure inside
 * `electron-store` / `conf`) cannot crash callers. Treats parse failure as
 * "use defaults" and emits a structured warn log.
 */
export function getAutoUpdateState(): AutoUpdateState {
  try {
    const stored = getStore().store ?? ({} as Partial<AutoUpdateState>);
    return { ...defaults, ...stored };
  } catch (err) {
    log.warn({ err }, 'Failed to read auto-update state (corrupt JSON?), returning defaults');
    return { ...defaults };
  }
}

/**
 * Gather a pure forensics snapshot of the auto-update state for diagnostics.
 */
export function getAutoUpdateForensicsSnapshot(input: {
  platform: NodeJS.Platform;
  store?: AutoUpdateState;
  installMarker?: UpdateInstallMarker | null;
}): AutoUpdateForensics {
  const state = input.store ?? getAutoUpdateState();
  const marker = input.installMarker !== undefined ? input.installMarker : getUpdateInstallMarker();

  return {
    platform: input.platform as 'darwin' | 'win32' | 'linux',
    lastCheckAt: state.lastCheckAt,
    lastCheckResult: state.lastCheckResult,
    lastErrorAt: state.lastErrorAt,
    lastErrorMessage: state.lastErrorMessage,
    recoveryAttempts: state.recoveryAttempts || {},
    installMarker: {
      hasMarker: !!marker,
      updateKey: marker?.updateKey,
      fromVersion: marker?.fromVersion,
      targetVersion: marker?.targetVersion,
      requestedAt: marker?.requestedAt,
    },
  };
}
