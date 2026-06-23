/**
 * Install Completion Reconciliation
 *
 * Decides what to do at startup with a previously-written
 * `update-install-marker` (set by `safeQuitAndInstall*()` just before
 * triggering `quitAndInstall()`).
 *
 * The decision logic itself is a small **pure** function
 * (`decideInstallCompletion`) — no I/O, no logging, no Electron imports.
 * Side effects (clearing the marker, persisting state, scheduling a silent
 * auto-heal) live in the orchestrator (`handleInstallMarkerStartupReconciliation`),
 * which receives all dependencies via injection. Tests can exercise either
 * layer in isolation.
 *
 * Rationale & history:
 *   - REBEL-52C (commit `f9adb3848` / planning doc
 *     `260428_install_completion_contract.md`) introduced telemetry-aware
 *     reconciliation but defaulted ambiguous outcomes to "fail-loud as
 *     stuck" + a bespoke recovery dialog.
 *   - REBEL-53B (this rearchitecture; investigation
 *     `260429_rebel_53b_stuck_install_false_positive.md`) flips the
 *     ambiguous default to "applied (warn log)" because:
 *       1. Pre-Stage-1 markers (no `targetVersion`) are pre-existing and
 *          common in the install base — defaulting them to stuck triggered
 *          a flood of REBEL-53B Sentry false positives after a successful
 *          upgrade. Plan I6 still required the legacy heuristic
 *          (`fromVersion === currentVersion → stuck`, else `applied`) so a
 *          truly stuck install on a pre-Stage-1 marker still triggers the
 *          silent auto-heal — see decision rule 4.
 *       2. Even modern markers can drift if `versionLabel` parsing changes
 *          (latent risk, edge case #5/#8 in the diagnosis doc).
 *     "We moved somewhere" beats "alarm the user." The structured warn log
 *     + Sentry forensics keep observability on the truly ambiguous path.
 *   - The bespoke `StuckInstallRecoveryDialog` was deleted alongside this
 *     change (user redirect — reuse `UpdateAvailableToast` instead).
 *     A bounded silent auto-heal (`silentAutoHealStuckInstall`) gets
 *     triggered once per `updateKey` before any user-visible surface; if
 *     the auto-heal is exhausted, the existing `UpdateAvailableToast`
 *     adapts its copy to the recovery context.
 *
 * Decision rules (applied in order):
 *   1. No marker                                         → `none`
 *   2. `watchdog.installFailedBundleVersionUnchanged`    → `stuck` (decisive)
 *   3. `currentVersion === marker.targetVersion`         → `applied` (decisive)
 *   4. Marker has no `targetVersion` (pre-Stage-1):
 *        - bundle moved (`currentVersion !== fromVersion`) → `applied` (warn)
 *        - bundle unchanged (`currentVersion === fromVersion`) → `stuck`
 *   5. `currentVersion === marker.fromVersion`            → `stuck` (heuristic)
 *   6. Anything else (truly ambiguous)                    → `applied` (warn)
 *
 * Rule order rationale: decisive watchdog evidence (rule 2) outranks both the
 * decisive applied path AND the heuristic — a future bug in version parsing
 * could let `currentVersion === marker.targetVersion` evaluate true even when
 * the bundle didn't actually swap. The watchdog has physically inspected the
 * on-disk bundle, so its signal is authoritative.
 */

import type { Logger } from '@core/logger';
import { assertNever } from '@shared/utils/assertNever';
import type {
  AutoUpdateState,
} from './autoUpdateStateStore';
import type { UpdateInstallMarker } from './updateInstallMarker';
import type { WatchdogTelemetryPayload } from './autoUpdateService';

export type ReconciliationStatus = 'none' | 'applied' | 'stuck';

/**
 * Reasons emitted by `decideInstallCompletion` so the orchestrator can pick
 * the right log shape and side effects without re-deriving the rule that
 * fired.
 */
export type ReconciliationReason =
  | 'no-marker'
  | 'legacy-marker-bundle-moved'
  | 'legacy-marker-bundle-unchanged'
  | 'current-equals-target'
  | 'watchdog-bundle-unchanged'
  | 'from-version-equals-current'
  | 'ambiguous-applied-default';

export interface DecideInstallCompletionInputs {
  marker: UpdateInstallMarker | null;
  currentVersion: string;
  watchdogTelemetry: WatchdogTelemetryPayload | null;
}

/** Reasons that can accompany each terminal status. */
export type NoneReason = 'no-marker';
export type AppliedReason =
  | 'current-equals-target'
  | 'legacy-marker-bundle-moved'
  | 'ambiguous-applied-default';
export type StuckReason =
  | 'watchdog-bundle-unchanged'
  | 'legacy-marker-bundle-unchanged'
  | 'from-version-equals-current';

/**
 * Discriminated union keyed on `status`. Each status constrains `reason` to
 * the subset of `ReconciliationReason` that can actually fire for it, so
 * impossible `{status, reason}` pairs are not representable. This is what
 * lets the orchestrator's `switch` over an applied result's reason be
 * exhaustive over *exactly* the applied reasons with `assertNever`, rather
 * than handling reasons that can never reach that branch.
 */
export type DecideInstallCompletionResult =
  | { status: 'none'; reason: NoneReason }
  | { status: 'applied'; reason: AppliedReason }
  | { status: 'stuck'; reason: StuckReason };

/**
 * Pure decision function — no side effects, no I/O, no logger.
 * The orchestrator (`handleInstallMarkerStartupReconciliation`) is the only
 * caller in production; tests should exercise this directly.
 */
export function decideInstallCompletion({
  marker,
  currentVersion,
  watchdogTelemetry: tel,
}: DecideInstallCompletionInputs): DecideInstallCompletionResult {
  // Rule 1: no marker → nothing to do
  if (!marker) {
    return { status: 'none', reason: 'no-marker' };
  }

  // Rule 2: decisive stuck — watchdog physically inspected the on-disk
  // bundle and confirmed it didn't advance. Beats the decisive-applied
  // path (rule 3) AND the heuristic (rule 5) because the watchdog is the
  // only signal grounded in actual on-disk state — version-string
  // comparison can be fooled by parsing drift (edge case #8).
  //
  // Stale-telemetry risk: if the prior session's `consumeWatchdogTelemetry`
  // call failed (best-effort fs.unlink), an outdated `installFailed=true`
  // record could persist. We accept this risk because (a) the orchestrator
  // consumes telemetry on every reconciliation that has a marker, so the
  // stale window is a single launch; (b) adding an `onDiskVersion ===
  // currentVersion` correlation would defeat the version-drift defense
  // that motivated Rule 2's priority over Rule 3 in the first place. If
  // production canary surfaces false-stuck events from stale telemetry,
  // the right fix is to make consume more durable, not to gate the rule.
  if (tel?.installFailedBundleVersionUnchanged === true) {
    return { status: 'stuck', reason: 'watchdog-bundle-unchanged' };
  }

  // Rule 3: decisive applied — running on the version the user expected.
  if (currentVersion === marker.targetVersion) {
    return { status: 'applied', reason: 'current-equals-target' };
  }

  // Rule 4: legacy back-compat — marker without targetVersion (pre-Stage-1
  // app versions). The plan I6 contract is to fall back to the legacy
  // heuristic so a real REBEL-52C-class failure on a pre-Stage-1 marker
  // still triggers silent auto-heal:
  //   - bundle moved (currentVersion !== fromVersion) → applied (warn log)
  //   - bundle unchanged (currentVersion === fromVersion) → stuck
  // The earlier "always applied for legacy markers" was over-corrective
  // and erased the row #7 stuck path; see investigation doc.
  if (marker.targetVersion === undefined) {
    if (currentVersion !== marker.fromVersion) {
      return { status: 'applied', reason: 'legacy-marker-bundle-moved' };
    }
    // Bundle unchanged — install didn't take. Treat as stuck so the
    // orchestrator fires silent auto-heal.
    return { status: 'stuck', reason: 'legacy-marker-bundle-unchanged' };
  }

  // Rule 5: heuristic stuck — modern marker, running on the from-version
  // (the install didn't move us at all and watchdog wasn't decisive).
  if (currentVersion === marker.fromVersion) {
    return { status: 'stuck', reason: 'from-version-equals-current' };
  }

  // Rule 6: ambiguous (the philosophy change). marker.targetVersion is set
  // but we're not on it AND we're not on fromVersion AND watchdog isn't
  // decisive. Treat as applied — we moved somewhere — and emit a warn so
  // the case is forensically traceable.
  return { status: 'applied', reason: 'ambiguous-applied-default' };
}

/**
 * Minimum dependency surface for the orchestrator. All side effects route
 * through this — no direct imports of electron, BrowserWindow, the auto
 * updater, or the file-backed stores.
 */
export interface ReconciliationDeps {
  /** `app.getVersion()` at startup. */
  currentVersion: string;
  /** `process.platform`. */
  platform: NodeJS.Platform;
  /** True when running headless (no renderer); suppresses auto-heal triggers. */
  isHeadless: boolean;
  getMarker: () => UpdateInstallMarker | null;
  clearMarker: () => void;
  getState: () => AutoUpdateState;
  /**
   * Checked variant of `updateAutoUpdateState`. Returns `{ ok: false }` on
   * write failure so the orchestrator can log and continue without
   * cascading state corruption.
   */
  setStateChecked: (partial: Partial<AutoUpdateState>) => { ok: boolean; error?: string };
  getWatchdogTelemetry: () => WatchdogTelemetryPayload | null;
  /** Side-effect: delete the consumed telemetry payload (best-effort). */
  consumeWatchdogTelemetry: () => void;
  /**
   * Stage 3 of the REBEL-53B rearchitecture: bounded, best-effort silent
   * recovery. The orchestrator calls this when the decision is `stuck`.
   * Implementations: clear the ShipIt cache (macOS), reset
   * `pendingDownloadedUpdate`, retrigger `autoUpdater.checkForUpdates()`,
   * bump `recoveryAttempts[updateKey]` once. Headless callers should
   * receive a no-op trigger (the orchestrator does not call this when
   * `isHeadless === true`).
   *
   * Synchronous to keep startup deterministic — implementations fire and
   * forget the actual checkForUpdates() call.
   */
  triggerSilentAutoHeal: (updateKey: string) => void;
  emitDiagnosticEvent?: (transition: 'install_succeeded' | 'install_failed') => void;
  logger: Logger;
}

/**
 * Build a stable updateKey for the auto-heal counter when the marker
 * itself doesn't carry one (back-compat with OLD markers from pre-Stage-1
 * app versions).
 *
 * Modern markers always carry `updateKey` (populated by `safeQuitAndInstall*()`
 * from `pending.updateKey`), so this fallback only fires for legacy markers
 * that hit the stuck path (rule 4 sub-case `legacy-marker-bundle-unchanged`).
 * The `'(unknown)-<platform>'` fallback is intentionally ugly so the case
 * stays observable in logs — pre-Stage-1 markers shouldn't be common after
 * the install base rolls forward.
 */
function reconstructUpdateKey(
  marker: UpdateInstallMarker,
  platform: NodeJS.Platform,
): string {
  if (marker.updateKey && marker.updateKey.length > 0) return marker.updateKey;
  return `${marker.targetVersion ?? '(unknown)'}-${platform}`;
}

/**
 * Run the install-completion reconciliation. Returns the decision so callers
 * can log / branch on it. All side effects are routed through the injected
 * deps.
 *
 * Invariants:
 *   - Always clears the marker on `applied` or `stuck` (the marker is
 *     transient — the next launch shouldn't re-process it). The pure
 *     `decideInstallCompletion` is the single source of truth for the
 *     decision; anything that survived to here was already reconciled.
 *   - Never persists `stuckInstall` to the store. The legacy field is kept
 *     in the schema for back-compat read but not written.
 *   - Best-effort observability: a write failure on the applied-clear path
 *     is logged at warn but doesn't block clearing the marker.
 */
export function handleInstallMarkerStartupReconciliation(
  deps: ReconciliationDeps,
): ReconciliationStatus {
  const marker = deps.getMarker();
  const tel = deps.getWatchdogTelemetry();
  const decision = decideInstallCompletion({
    marker,
    currentVersion: deps.currentVersion,
    watchdogTelemetry: tel,
  });

  if (decision.status === 'none') {
    return 'none';
  }

  // From here on we always have a non-null marker (Rule 1 returned 'none'
  // above when marker was null), so the assertion is safe.
  const presentMarker = marker as UpdateInstallMarker;

  if (decision.status === 'applied') {
    // Pick the right log shape per applied reason. Because the result is a
    // discriminated union (`AppliedReason` is the only `reason` shape on an
    // `applied` result), this `switch` is exhaustive over *exactly* the
    // applied reasons and its `assertNever` default turns adding (or removing)
    // an `AppliedReason` member into a compile error here. That kills the
    // I6-class "a back-compat branch was silently dropped" regression at the
    // type level (postmortem 260429_rebel_53b_stuck_install_false_positive).
    //
    // Sub-cases:
    //   - decisive applied (rule 3, `current-equals-target`) → info log
    //   - legacy marker, bundle moved (rule 4) → warn log
    //   - ambiguous default (rule 6) → warn log
    //     (we moved somewhere but couldn't confirm the user landed where they
    //      expected; surface in Sentry for forensics)
    const appliedReason = decision.reason;
    switch (appliedReason) {
      case 'current-equals-target':
        deps.logger.info(
          {
            marker: presentMarker,
            currentVersion: deps.currentVersion,
            watchdog: tel ?? null,
            reason: appliedReason,
          },
          '[UPDATE] Install completion reconciliation: applied (currentVersion === targetVersion)',
        );
        break;
      case 'legacy-marker-bundle-moved':
        deps.logger.warn(
          {
            marker: presentMarker,
            currentVersion: deps.currentVersion,
            watchdog: tel ?? null,
            platform: deps.platform,
            reason: appliedReason,
          },
          '[UPDATE] Install completion reconciliation: applied (legacy marker, bundle moved)',
        );
        break;
      case 'ambiguous-applied-default':
        deps.logger.warn(
          {
            marker: presentMarker,
            currentVersion: deps.currentVersion,
            watchdog: tel ?? null,
            platform: deps.platform,
            reason: appliedReason,
          },
          '[UPDATE] Install completion reconciliation: applied (ambiguous — preferring quiet over false alarm)',
        );
        break;
      default:
        assertNever(appliedReason, 'decideInstallCompletion applied reason');
    }

    // Clear any stale persisted stuckInstall (left over from prior
    // versions of this code that wrote it) AND bound `recoveryAttempts` by
    // dropping the entry for the successfully-installed updateKey. The
    // recoveryAttempts map otherwise grows monotonically as users
    // accumulate update history. Best-effort — even if the write fails we
    // still clear the marker so we don't loop on the same decision next
    // launch.
    const existingState = deps.getState();
    const stalePartial: Partial<AutoUpdateState> = {};
    if (existingState.stuckInstall != null) {
      stalePartial.stuckInstall = null;
    }
    const updateKey = presentMarker.updateKey;
    if (updateKey != null && existingState.recoveryAttempts?.[updateKey] != null) {
      const newAttempts = { ...existingState.recoveryAttempts };
      delete newAttempts[updateKey];
      stalePartial.recoveryAttempts = newAttempts;
    }
    if (Object.keys(stalePartial).length > 0) {
      const result = deps.setStateChecked(stalePartial);
      if (!result.ok) {
        deps.logger.warn(
          { err: result.error },
          '[UPDATE] Failed to clear stale state on applied path (continuing)',
        );
      }
    }

    deps.clearMarker();
    deps.consumeWatchdogTelemetry();
    deps.emitDiagnosticEvent?.('install_succeeded');
    return 'applied';
  }

  // ── stuck ────────────────────────────────────────────────────────────
  deps.logger.warn(
    {
      marker: presentMarker,
      currentVersion: deps.currentVersion,
      watchdog: tel ?? null,
      platform: deps.platform,
      reason: decision.reason,
    },
    '[UPDATE] Install completion reconciliation: stuck install detected',
  );

  const updateKey = reconstructUpdateKey(presentMarker, deps.platform);

  // Always clear the marker — the next launch shouldn't re-process the
  // same marker just because we couldn't recover (auto-heal is bounded by
  // recoveryAttempts[updateKey] independently).
  deps.clearMarker();
  deps.consumeWatchdogTelemetry();
  deps.emitDiagnosticEvent?.('install_failed');

  // Persist watchdog signal for diagnostics if present (back-compat with
  // existing observability).
  if (tel != null) {
    const writeResult = deps.setStateChecked({
      watchdogInstallFailedBundleVersionUnchanged:
        tel.installFailedBundleVersionUnchanged ?? null,
      watchdogOnDiskVersion: tel.onDiskVersion ?? null,
    });
    if (!writeResult.ok) {
      deps.logger.warn(
        { err: writeResult.error, updateKey },
        '[UPDATE] Failed to persist watchdog signal on stuck path (continuing)',
      );
    }
  }

  if (deps.isHeadless) {
    deps.logger.info(
      { updateKey },
      '[UPDATE] Headless mode — skipping silent auto-heal trigger',
    );
    return 'stuck';
  }

  try {
    deps.triggerSilentAutoHeal(updateKey);
  } catch (err) {
    deps.logger.warn(
      { err, updateKey },
      '[UPDATE] silentAutoHeal trigger threw (non-fatal)',
    );
  }

  return 'stuck';
}

// ── REBEL-53B migration predicate ───────────────────────────────────────
//
// Co-located here so the unit test (`rebel53bMigration.test.ts`) and the
// startup migration block (`src/main/index.ts`) share a single source of
// truth. The migration runs once per app launch BEFORE reconciliation: it
// clears any stale `stuckInstall` record left by the `f9adb3848` regression
// where `targetVersion === '(unknown)'`, the user has clearly moved on to
// a different version, AND there's no active install marker (i.e.
// reconciliation isn't about to overwrite the field anyway).
//
// See `docs-private/investigations/260429_rebel_53b_stuck_install_false_positive.md`.

export interface ShouldClearStaleStuckInstallArgs {
  state: Pick<AutoUpdateState, 'stuckInstall'>;
  currentVersion: string;
  hasMarker: boolean;
}

/**
 * Pure predicate — returns true iff the on-disk `stuckInstall` is a
 * regression artifact (targetVersion === '(unknown)') AND can be safely
 * cleared without erasing a genuine stuck-install signal.
 */
export function shouldClearStaleStuckInstall({
  state,
  currentVersion,
  hasMarker,
}: ShouldClearStaleStuckInstallArgs): boolean {
  const stale = state.stuckInstall;
  return (
    stale != null &&
    stale.targetVersion === '(unknown)' &&
    stale.fromVersion !== currentVersion &&
    !hasMarker
  );
}
