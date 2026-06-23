/**
 * Unit tests for `installCompletionReconciliation`.
 *
 * REBEL-53B rearchitecture — see
 * `docs-private/investigations/260429_rebel_53b_stuck_install_false_positive.md`.
 *
 * Two layers under test:
 *   - `decideInstallCompletion()` — pure decision function exercising the
 *     full edge case matrix (#1-#15 in the diagnosis doc).
 *   - `handleInstallMarkerStartupReconciliation()` — orchestrator routing
 *     side effects (logging, marker clearing, watchdog persistence,
 *     auto-heal trigger) through injected deps.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  decideInstallCompletion,
  handleInstallMarkerStartupReconciliation,
} from '../installCompletionReconciliation';
import type {
  ReconciliationDeps,
  ReconciliationStatus,
} from '../installCompletionReconciliation';
import type { AutoUpdateState, StuckInstall } from '../autoUpdateStateStore';
import type { UpdateInstallMarker } from '../updateInstallMarker';
import type { WatchdogTelemetryPayload } from '../autoUpdateService';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    flush: (cb?: () => void) => cb?.(),
    child: () => makeLogger(),
    level: 'info',
    levels: { values: {}, labels: {} },
    bindings: () => ({}),
    isLevelEnabled: () => true,
    setBindings: () => undefined,
    version: '0.0.0-test',
  } as unknown as ReconciliationDeps['logger'];
}

const FROM_VERSION = '0.4.33';
const TARGET_VERSION = '0.4.34';
const UPDATE_KEY = 'beta:darwin:arm64:0.4.34';
const ATTEMPTED_AT = 1_700_000_000_000;

function makeMarker(overrides: Partial<UpdateInstallMarker> = {}): UpdateInstallMarker {
  return {
    updateKey: UPDATE_KEY,
    fromVersion: FROM_VERSION,
    targetVersion: TARGET_VERSION,
    requestedAt: ATTEMPTED_AT,
    ...overrides,
  };
}

function makeWatchdog(
  overrides: Partial<WatchdogTelemetryPayload> = {},
): WatchdogTelemetryPayload {
  return {
    ranAt: ATTEMPTED_AT / 1000,
    oldPid: 1,
    oldPidWaitSec: 0,
    shipItWaitSec: 1,
    appAlreadyRunning: false,
    openFired: true,
    installFailedBundleVersionUnchanged: false,
    onDiskVersion: TARGET_VERSION,
    ...overrides,
  };
}

function makeDefaultState(overrides: Partial<AutoUpdateState> = {}): AutoUpdateState {
  return {
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
    ...overrides,
  };
}

interface FakeDepsOverrides {
  currentVersion?: string;
  platform?: NodeJS.Platform;
  isHeadless?: boolean;
  marker?: UpdateInstallMarker | null;
  state?: AutoUpdateState;
  telemetry?: WatchdogTelemetryPayload | null;
  setStateChecked?: ReconciliationDeps['setStateChecked'];
}

function makeDeps(overrides: FakeDepsOverrides = {}) {
  let state = overrides.state ?? makeDefaultState();
  const setStateCheckedSpy =
    overrides.setStateChecked ??
    vi.fn((partial: Partial<AutoUpdateState>) => {
      state = { ...state, ...partial };
      return { ok: true } as { ok: boolean; error?: string };
    });

  const triggerSilentAutoHeal = vi.fn();

  const deps = {
    currentVersion: overrides.currentVersion ?? FROM_VERSION,
    platform: overrides.platform ?? ('darwin' as NodeJS.Platform),
    isHeadless: overrides.isHeadless ?? false,
    getMarker: vi.fn(() => overrides.marker ?? null),
    clearMarker: vi.fn(),
    getState: vi.fn(() => state),
    setStateChecked: setStateCheckedSpy as ReconciliationDeps['setStateChecked'],
    getWatchdogTelemetry: vi.fn(() => overrides.telemetry ?? null),
    consumeWatchdogTelemetry: vi.fn(),
    triggerSilentAutoHeal,
    emitDiagnosticEvent: vi.fn(),
    logger: makeLogger(),
  } as unknown as ReconciliationDeps & {
    getMarker: ReturnType<typeof vi.fn>;
    clearMarker: ReturnType<typeof vi.fn>;
    getState: ReturnType<typeof vi.fn>;
    setStateChecked: ReturnType<typeof vi.fn>;
    getWatchdogTelemetry: ReturnType<typeof vi.fn>;
    consumeWatchdogTelemetry: ReturnType<typeof vi.fn>;
    triggerSilentAutoHeal: ReturnType<typeof vi.fn>;
    emitDiagnosticEvent: ReturnType<typeof vi.fn>;
  };

  return {
    deps,
    getCurrentState: () => state,
  };
}

// ── decideInstallCompletion (pure function) ────────────────────────────────

describe('decideInstallCompletion', () => {
  // Edge case #1
  it('returns none when no marker is present', () => {
    const result = decideInstallCompletion({
      marker: null,
      currentVersion: TARGET_VERSION,
      watchdogTelemetry: null,
    });
    expect(result).toEqual({ status: 'none', reason: 'no-marker' });
  });

  // Edge case #2: new marker, install applied (decisive)
  it('returns applied when currentVersion === marker.targetVersion (decisive)', () => {
    const result = decideInstallCompletion({
      marker: makeMarker(),
      currentVersion: TARGET_VERSION,
      watchdogTelemetry: null,
    });
    expect(result).toEqual({ status: 'applied', reason: 'current-equals-target' });
  });

  // Edge case #3 / #4: ShipIt failed (with or without telemetry)
  it('returns stuck when watchdog says installFailedBundleVersionUnchanged === true', () => {
    const result = decideInstallCompletion({
      marker: makeMarker(),
      currentVersion: FROM_VERSION,
      watchdogTelemetry: makeWatchdog({ installFailedBundleVersionUnchanged: true }),
    });
    expect(result).toEqual({ status: 'stuck', reason: 'watchdog-bundle-unchanged' });
  });

  it('returns stuck when currentVersion === marker.fromVersion (no telemetry)', () => {
    const result = decideInstallCompletion({
      marker: makeMarker(),
      currentVersion: FROM_VERSION,
      watchdogTelemetry: null,
    });
    expect(result).toEqual({
      status: 'stuck',
      reason: 'from-version-equals-current',
    });
  });

  // Edge case #5: ambiguous — the philosophy change.
  it("returns applied (warn) when ambiguous (modern marker, neither from nor target match, no decisive telemetry)", () => {
    const result = decideInstallCompletion({
      marker: makeMarker(),
      currentVersion: '0.4.50', // neither from nor target
      watchdogTelemetry: null,
    });
    expect(result).toEqual({ status: 'applied', reason: 'ambiguous-applied-default' });
  });

  // Edge case #6: REBEL-53B regression case — pre-Stage-1 marker, install
  // applied (bundle moved, even though we can't confirm against
  // targetVersion). This is the canonical case f9adb3848 broke.
  it('returns applied for legacy marker when bundle moved (REBEL-53B fix, edge matrix row #6)', () => {
    const oldMarker: UpdateInstallMarker = {
      fromVersion: FROM_VERSION,
      requestedAt: ATTEMPTED_AT,
    };
    const result = decideInstallCompletion({
      marker: oldMarker,
      // The user has clearly upgraded — currentVersion differs from the
      // recorded fromVersion. Pre-fix this fell through to "stuck".
      currentVersion: '0.4.99',
      watchdogTelemetry: null,
    });
    expect(result).toEqual({ status: 'applied', reason: 'legacy-marker-bundle-moved' });
  });

  // Edge case #7: Pre-Stage-1 marker, install failed (bundle unchanged).
  // Plan I6 specifies this MUST still trigger silent auto-heal — the
  // earlier "always applied for legacy markers" was over-corrective.
  it('returns stuck for legacy marker when bundle unchanged (plan I6, edge matrix row #7)', () => {
    const oldMarker: UpdateInstallMarker = {
      fromVersion: FROM_VERSION,
      requestedAt: ATTEMPTED_AT,
    };
    const result = decideInstallCompletion({
      marker: oldMarker,
      currentVersion: FROM_VERSION,
      watchdogTelemetry: null,
    });
    expect(result).toEqual({ status: 'stuck', reason: 'legacy-marker-bundle-unchanged' });
  });

  // Rule ordering: decisive watchdog signal beats decisive applied path.
  // If a future bug let `currentVersion === marker.targetVersion` evaluate
  // true while the bundle didn't actually swap, we want the watchdog's
  // physical inspection to take precedence.
  it('prefers watchdog stuck signal over decisive applied path', () => {
    const result = decideInstallCompletion({
      marker: makeMarker(),
      currentVersion: TARGET_VERSION,
      watchdogTelemetry: makeWatchdog({ installFailedBundleVersionUnchanged: true }),
    });
    expect(result).toEqual({ status: 'stuck', reason: 'watchdog-bundle-unchanged' });
  });

  // Edge case #8: latent format-drift — modern marker but versionLabel
  // parsing produces a string that doesn't match app.getVersion().
  it('returns applied (warn) on version-label format drift', () => {
    const driftMarker = makeMarker({ targetVersion: '0.4.35' });
    const result = decideInstallCompletion({
      marker: driftMarker,
      currentVersion: '0.4.3510701',
      watchdogTelemetry: null,
    });
    expect(result).toEqual({ status: 'applied', reason: 'ambiguous-applied-default' });
  });

  // Telemetry takes precedence even for cross-version edges.
  it('returns stuck on watchdog signal even when versions are cross-cutting', () => {
    const result = decideInstallCompletion({
      marker: makeMarker(),
      currentVersion: '0.4.99', // not from, not target
      watchdogTelemetry: makeWatchdog({ installFailedBundleVersionUnchanged: true }),
    });
    expect(result).toEqual({ status: 'stuck', reason: 'watchdog-bundle-unchanged' });
  });
});

// ── handleInstallMarkerStartupReconciliation (orchestrator) ────────────────

describe('handleInstallMarkerStartupReconciliation', () => {
  describe("returns 'none'", () => {
    it('when no marker is present', () => {
      const { deps } = makeDeps({ marker: null });
      const result: ReconciliationStatus = handleInstallMarkerStartupReconciliation(deps);
      expect(result).toBe('none');
      expect(deps.clearMarker).not.toHaveBeenCalled();
      expect(deps.consumeWatchdogTelemetry).not.toHaveBeenCalled();
      expect(deps.setStateChecked).not.toHaveBeenCalled();
      expect(deps.triggerSilentAutoHeal).not.toHaveBeenCalled();
    });
  });

  describe("returns 'applied'", () => {
    it('decisive applied logs at info', () => {
      const { deps } = makeDeps({
        currentVersion: TARGET_VERSION,
        marker: makeMarker(),
      });
      const result = handleInstallMarkerStartupReconciliation(deps);
      expect(result).toBe('applied');
      expect(deps.clearMarker).toHaveBeenCalledOnce();
      expect(deps.consumeWatchdogTelemetry).toHaveBeenCalledOnce();
      expect(deps.triggerSilentAutoHeal).not.toHaveBeenCalled();
      expect(vi.mocked(deps.logger.info)).toHaveBeenCalled();
      expect(vi.mocked(deps.logger.warn)).not.toHaveBeenCalled();
    });

    it('legacy marker (no targetVersion), bundle moved → applied with warn log (REBEL-53B fix)', () => {
      const oldMarker: UpdateInstallMarker = {
        fromVersion: FROM_VERSION,
        requestedAt: ATTEMPTED_AT,
      };
      const { deps } = makeDeps({
        currentVersion: '0.4.99',
        marker: oldMarker,
      });
      const result = handleInstallMarkerStartupReconciliation(deps);
      expect(result).toBe('applied');
      expect(deps.clearMarker).toHaveBeenCalledOnce();
      expect(deps.triggerSilentAutoHeal).not.toHaveBeenCalled();
      expect(vi.mocked(deps.logger.warn)).toHaveBeenCalled();
    });

    it('ambiguous default → applied with warn log (philosophy change)', () => {
      const { deps } = makeDeps({
        currentVersion: '0.4.50', // neither from nor target
        marker: makeMarker(),
        telemetry: null,
      });
      const result = handleInstallMarkerStartupReconciliation(deps);
      expect(result).toBe('applied');
      expect(deps.triggerSilentAutoHeal).not.toHaveBeenCalled();
      expect(vi.mocked(deps.logger.warn)).toHaveBeenCalled();
    });

    it('clears stale stuckInstall when applied path runs', () => {
      const stale: StuckInstall = {
        updateKey: UPDATE_KEY,
        fromVersion: FROM_VERSION,
        targetVersion: TARGET_VERSION,
        attemptedAt: ATTEMPTED_AT,
        platform: 'darwin',
        attemptCount: 2,
        lastFailedAt: ATTEMPTED_AT + 1,
      };
      const { deps, getCurrentState } = makeDeps({
        currentVersion: TARGET_VERSION,
        marker: makeMarker(),
        state: makeDefaultState({ stuckInstall: stale }),
      });
      const result = handleInstallMarkerStartupReconciliation(deps);
      expect(result).toBe('applied');
      expect(deps.setStateChecked).toHaveBeenCalledWith({ stuckInstall: null });
      expect(getCurrentState().stuckInstall).toBeNull();
    });

    it('clears recoveryAttempts[updateKey] on applied path (bounds map growth)', () => {
      const { deps, getCurrentState } = makeDeps({
        currentVersion: TARGET_VERSION,
        marker: makeMarker(),
        state: makeDefaultState({
          recoveryAttempts: { [UPDATE_KEY]: 1, 'beta:darwin:arm64:9.9.9': 1 },
        }),
      });
      const result = handleInstallMarkerStartupReconciliation(deps);
      expect(result).toBe('applied');
      expect(deps.setStateChecked).toHaveBeenCalledWith({
        recoveryAttempts: { 'beta:darwin:arm64:9.9.9': 1 },
      });
      expect(getCurrentState().recoveryAttempts).toEqual({
        'beta:darwin:arm64:9.9.9': 1,
      });
    });

    it('clears both stuckInstall AND recoveryAttempts[updateKey] in a single write', () => {
      const stale: StuckInstall = {
        updateKey: UPDATE_KEY,
        fromVersion: FROM_VERSION,
        targetVersion: TARGET_VERSION,
        attemptedAt: ATTEMPTED_AT,
        platform: 'darwin',
        attemptCount: 1,
        lastFailedAt: ATTEMPTED_AT,
      };
      const { deps, getCurrentState } = makeDeps({
        currentVersion: TARGET_VERSION,
        marker: makeMarker(),
        state: makeDefaultState({
          stuckInstall: stale,
          recoveryAttempts: { [UPDATE_KEY]: 1 },
        }),
      });
      const result = handleInstallMarkerStartupReconciliation(deps);
      expect(result).toBe('applied');
      expect(deps.setStateChecked).toHaveBeenCalledOnce();
      expect(deps.setStateChecked).toHaveBeenCalledWith({
        stuckInstall: null,
        recoveryAttempts: {},
      });
      expect(getCurrentState().stuckInstall).toBeNull();
      expect(getCurrentState().recoveryAttempts).toEqual({});
    });

    it('does not write state when there is no stale stuckInstall or recovery entry to clear', () => {
      const { deps } = makeDeps({
        currentVersion: TARGET_VERSION,
        marker: makeMarker(),
      });
      const result = handleInstallMarkerStartupReconciliation(deps);
      expect(result).toBe('applied');
      expect(deps.setStateChecked).not.toHaveBeenCalled();
    });

    // Pins the per-`reason` switch routing introduced for the assertNever
    // exhaustiveness anchor (rec #50 / postmortem
    // 260429_rebel_53b_stuck_install_false_positive). The compiler enforces
    // exhaustiveness; these assertions enforce that each applied reason still
    // routes to the right log channel + carries the discriminant in the
    // binding, so a wrong-arm refactor is caught at runtime too.
    it('decisive applied carries reason=current-equals-target on the info log', () => {
      const { deps } = makeDeps({
        currentVersion: TARGET_VERSION,
        marker: makeMarker(),
      });
      expect(handleInstallMarkerStartupReconciliation(deps)).toBe('applied');
      expect(vi.mocked(deps.logger.info)).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'current-equals-target' }),
        expect.any(String),
      );
      expect(vi.mocked(deps.logger.warn)).not.toHaveBeenCalled();
      expect(vi.mocked(deps.logger.error)).not.toHaveBeenCalled();
    });

    it('legacy-marker-bundle-moved carries reason on the warn log', () => {
      const { deps } = makeDeps({
        currentVersion: '0.4.99',
        marker: { fromVersion: FROM_VERSION, requestedAt: ATTEMPTED_AT },
      });
      expect(handleInstallMarkerStartupReconciliation(deps)).toBe('applied');
      expect(vi.mocked(deps.logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'legacy-marker-bundle-moved' }),
        expect.any(String),
      );
      expect(vi.mocked(deps.logger.error)).not.toHaveBeenCalled();
    });

    it('ambiguous-applied-default carries reason on the warn log', () => {
      const { deps } = makeDeps({
        currentVersion: '0.4.50',
        marker: makeMarker(),
        telemetry: null,
      });
      expect(handleInstallMarkerStartupReconciliation(deps)).toBe('applied');
      expect(vi.mocked(deps.logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'ambiguous-applied-default' }),
        expect.any(String),
      );
      expect(vi.mocked(deps.logger.error)).not.toHaveBeenCalled();
    });
  });

  describe("returns 'stuck'", () => {
    it("triggers silent auto-heal when watchdog telemetry says installFailedBundleVersionUnchanged === true", () => {
      const { deps } = makeDeps({
        currentVersion: '0.4.99',
        marker: makeMarker(),
        telemetry: makeWatchdog({ installFailedBundleVersionUnchanged: true }),
      });
      const result = handleInstallMarkerStartupReconciliation(deps);
      expect(result).toBe('stuck');
      expect(deps.clearMarker).toHaveBeenCalledOnce();
      expect(deps.consumeWatchdogTelemetry).toHaveBeenCalledOnce();
      expect(deps.triggerSilentAutoHeal).toHaveBeenCalledWith(UPDATE_KEY);
    });

    it('triggers silent auto-heal when currentVersion === marker.fromVersion (no telemetry)', () => {
      const { deps } = makeDeps({
        currentVersion: FROM_VERSION,
        marker: makeMarker(),
        telemetry: null,
      });
      const result = handleInstallMarkerStartupReconciliation(deps);
      expect(result).toBe('stuck');
      expect(deps.triggerSilentAutoHeal).toHaveBeenCalledWith(UPDATE_KEY);
    });

    it('does NOT persist stuckInstall on the stuck path (post-REBEL-53B)', () => {
      const { deps, getCurrentState } = makeDeps({
        currentVersion: FROM_VERSION,
        marker: makeMarker(),
      });
      handleInstallMarkerStartupReconciliation(deps);
      // The new architecture never writes a non-null stuckInstall.
      const writes = vi.mocked(deps.setStateChecked).mock.calls.flatMap((c) => c as unknown[]);
      expect(writes).not.toContainEqual(expect.objectContaining({ stuckInstall: expect.anything() }));
      expect(getCurrentState().stuckInstall).toBeNull();
    });

    it('persists watchdog signal when telemetry is decisive', () => {
      const { deps, getCurrentState } = makeDeps({
        currentVersion: FROM_VERSION,
        marker: makeMarker(),
        telemetry: makeWatchdog({
          installFailedBundleVersionUnchanged: true,
          onDiskVersion: FROM_VERSION,
        }),
      });
      handleInstallMarkerStartupReconciliation(deps);
      expect(getCurrentState().watchdogInstallFailedBundleVersionUnchanged).toBe(true);
      expect(getCurrentState().watchdogOnDiskVersion).toBe(FROM_VERSION);
    });

    it('reconstructs an updateKey when a modern marker lacks one', () => {
      const partialMarker: UpdateInstallMarker = {
        fromVersion: FROM_VERSION,
        targetVersion: TARGET_VERSION,
        requestedAt: ATTEMPTED_AT,
      };
      const { deps } = makeDeps({
        currentVersion: FROM_VERSION,
        marker: partialMarker,
      });
      handleInstallMarkerStartupReconciliation(deps);
      expect(deps.triggerSilentAutoHeal).toHaveBeenCalledWith(`${TARGET_VERSION}-darwin`);
    });

    it('triggers silent auto-heal for legacy marker when bundle unchanged (plan I6, edge matrix row #7)', () => {
      // Legacy marker (no targetVersion) AND currentVersion === fromVersion
      // → the install didn't take. Should trigger silent auto-heal so a
      // genuinely-stuck pre-Stage-1 install isn't silently swallowed.
      const oldMarker: UpdateInstallMarker = {
        fromVersion: FROM_VERSION,
        requestedAt: ATTEMPTED_AT,
      };
      const { deps } = makeDeps({
        currentVersion: FROM_VERSION,
        marker: oldMarker,
      });
      const result = handleInstallMarkerStartupReconciliation(deps);
      expect(result).toBe('stuck');
      expect(deps.clearMarker).toHaveBeenCalledOnce();
      // With no marker.updateKey AND no marker.targetVersion the
      // reconstructed key falls back to '(unknown)-<platform>'. The
      // silent auto-heal still runs — better an imperfect bookkeeping key
      // than letting a legacy stuck install fester.
      expect(deps.triggerSilentAutoHeal).toHaveBeenCalledWith('(unknown)-darwin');
    });
  });

  describe('headless guard', () => {
    it('does NOT trigger silent auto-heal in headless mode', () => {
      const { deps } = makeDeps({
        currentVersion: FROM_VERSION,
        marker: makeMarker(),
        isHeadless: true,
      });
      const result = handleInstallMarkerStartupReconciliation(deps);
      expect(result).toBe('stuck');
      expect(deps.triggerSilentAutoHeal).not.toHaveBeenCalled();
      // Marker still cleared (the next launch shouldn't re-process it).
      expect(deps.clearMarker).toHaveBeenCalledOnce();
    });
  });

  describe('best-effort state writes', () => {
    it('continues clearing the marker on the applied path even if stuckInstall clear fails', () => {
      const stale: StuckInstall = {
        updateKey: UPDATE_KEY,
        fromVersion: FROM_VERSION,
        targetVersion: TARGET_VERSION,
        attemptedAt: ATTEMPTED_AT,
        platform: 'darwin',
        attemptCount: 1,
        lastFailedAt: ATTEMPTED_AT,
      };
      const failingSetState = vi.fn(() => ({ ok: false, error: 'disk full' }));
      const { deps } = makeDeps({
        currentVersion: TARGET_VERSION,
        marker: makeMarker(),
        state: makeDefaultState({ stuckInstall: stale }),
        setStateChecked: failingSetState as ReconciliationDeps['setStateChecked'],
      });
      const result = handleInstallMarkerStartupReconciliation(deps);
      expect(result).toBe('applied');
      // The applied path is best-effort: marker still cleared.
      expect(deps.clearMarker).toHaveBeenCalledOnce();
      expect(vi.mocked(deps.logger.warn)).toHaveBeenCalled();
    });

    it('triggers silent auto-heal even if watchdog persistence fails', () => {
      const failingSetState = vi.fn(() => ({ ok: false, error: 'disk full' }));
      const { deps } = makeDeps({
        currentVersion: FROM_VERSION,
        marker: makeMarker(),
        telemetry: makeWatchdog({ installFailedBundleVersionUnchanged: true }),
        setStateChecked: failingSetState as ReconciliationDeps['setStateChecked'],
      });
      handleInstallMarkerStartupReconciliation(deps);
      expect(deps.triggerSilentAutoHeal).toHaveBeenCalledWith(UPDATE_KEY);
      expect(vi.mocked(deps.logger.warn)).toHaveBeenCalled();
    });
  });

  describe('platform narrowing for reconstructed updateKey', () => {
    it('uses win32 when platform is win32 and marker has updateKey', () => {
      const { deps } = makeDeps({
        currentVersion: FROM_VERSION,
        marker: makeMarker({ updateKey: 'stable:win32:x64:0.4.34' }),
        platform: 'win32',
      });
      handleInstallMarkerStartupReconciliation(deps);
      expect(deps.triggerSilentAutoHeal).toHaveBeenCalledWith('stable:win32:x64:0.4.34');
    });
  });

  describe('triggerSilentAutoHeal failures are non-fatal', () => {
    it('still returns stuck when triggerSilentAutoHeal throws', () => {
      const { deps } = makeDeps({
        currentVersion: FROM_VERSION,
        marker: makeMarker(),
      });
      vi.mocked(deps.triggerSilentAutoHeal).mockImplementation(() => {
        throw new Error('boom');
      });
      const result = handleInstallMarkerStartupReconciliation(deps);
      expect(result).toBe('stuck');
      expect(vi.mocked(deps.logger.warn)).toHaveBeenCalled();
    });
  });
});
