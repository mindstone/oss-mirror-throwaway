/**
 * Quit-deadlock telemetry (Stage 3b of
 * docs/plans/260617_bricked-state-0448-electron42/PLAN.md).
 *
 * Makes the telemetry-blind quit/install hang class observable. A "quit
 * deadlock" is when the quit sequence does not complete in its budget — on
 * Electron ≥41 an unswept native-module (fsevents / TSFN) instance at env
 * teardown no longer SIGABRTs, so the quit can hang indefinitely (FOX-3487;
 * CHANGELOG 0.4.47; docs/plans/260611_fsevents-shutdown-crash). The existing
 * quit/install fallbacks (macOS Tier-1/Tier-2, Windows install, the
 * graceful-shutdown 10s race) fire when this happens but emit no distinct
 * "deadlock detected" signal.
 *
 * CRITICAL ORDERING (the load-bearing contract of this module):
 *   1. `appendDiagnosticEvent` FIRST — the on-device ledger survives the exit
 *      even when the companion Sentry capture is lost at process death.
 *   2. THEN a registry-owned Sentry capture (`quit_deadlock_detected`).
 *   3. THEN a BOUNDED `flushMainSentry(<= 2000ms)` — never an unbounded flush
 *      that could itself extend an already-hung quit.
 *
 * Keyed distinctly per `tier` so it never collides with the relaunch-watchdog
 * telemetry (`spawnRelaunchWatchdog` / `consumeWatchdogTelemetryOnStartup`),
 * which is about RELAUNCH, not the quit-hang.
 */

import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { flushMainSentry } from '../sentry';
import type { NativeLivenessSnapshot } from './nativeLivenessSnapshot';

/**
 * Which quit/install fallback fired. Mirrors the `tier` enum on the
 * `quit_deadlock_detected` diagnostic event + known condition.
 */
export type QuitDeadlockTier = 'mac_tier1' | 'mac_tier2' | 'win' | 'graceful_10s';

/** Bounded pre-exit Sentry flush budget — must never extend a hung quit. */
export const QUIT_DEADLOCK_FLUSH_BUDGET_MS = 2_000;

/**
 * Budget after which the Windows install path force-exits if the process is
 * still alive (mirrors the macOS Tier-2 pattern, which the Windows path
 * historically lacked entirely). Set slightly above macOS Tier-2's 8s to allow
 * for NSIS handoff slack — generous enough to let a healthy quitAndInstall tear
 * down normally, short enough that a genuine deadlock produces an observable
 * signal + force-exit rather than an indefinite hang. Conservative default with
 * no field evidence base yet; tunable once `quit_deadlock_detected` telemetry
 * lands (see PLAN Stage 3).
 */
export const WINDOWS_FORCE_EXIT_BUDGET_MS = 10_000;

/**
 * Emit the quit-deadlock signal: ledger FIRST, then a registry-owned Sentry
 * capture, then a bounded flush. Never throws and never hangs past the flush
 * budget — safe to `await` on the exit path.
 *
 * Dependencies are injectable for unit testing the ordering + bounded-flush
 * contract without the real Sentry/ledger sinks.
 */
export async function emitQuitDeadlockDetected(
  tier: QuitDeadlockTier,
  deps: {
    appendDiagnosticEvent?: typeof appendDiagnosticEvent;
    captureKnownCondition?: typeof captureKnownCondition;
    flushMainSentry?: typeof flushMainSentry;
    flushBudgetMs?: number;
  } = {},
  /**
   * Optional native-resource liveness snapshot captured synchronously at the
   * quit-deadlock boundary (see `nativeLivenessSnapshot.ts`). Additive — when
   * provided it is threaded into BOTH the survives-process-death ledger `data`
   * and the Sentry capture (scalar counts as filterable tags, full object as
   * extra) so the NEXT occurrence NAMES the live-at-quit native modules. When
   * omitted (existing callers, non-mac tiers), telemetry is unchanged.
   */
  nativeLiveness?: NativeLivenessSnapshot,
): Promise<void> {
  const append = deps.appendDiagnosticEvent ?? appendDiagnosticEvent;
  const capture = deps.captureKnownCondition ?? captureKnownCondition;
  const flush = deps.flushMainSentry ?? flushMainSentry;
  const flushBudgetMs = deps.flushBudgetMs ?? QUIT_DEADLOCK_FLUSH_BUDGET_MS;
  const platform = process.platform as 'darwin' | 'win32' | 'linux';

  // 1. Ledger FIRST — survives the exit even if the Sentry flush is lost.
  try {
    append({
      kind: 'quit_deadlock_detected',
      data: { tier, platform, ...(nativeLiveness ? { nativeLiveness } : {}) },
    });
  } catch (ledgerErr) {
    // Best-effort; appendDiagnosticEvent is itself safe-by-construction, this
    // is belt-and-suspenders so a sink error never blocks the exit.
    ignoreBestEffortCleanup(ledgerErr, {
      operation: 'emitQuitDeadlockDetected.appendDiagnosticEvent',
      reason: 'Quit-deadlock ledger write is best-effort and must never block or break the exit path',
    });
  }

  // 2. Registry-owned Sentry capture (warning, fingerprinted per tier).
  //    Scalar liveness counts ride as filterable TAGS (so the suspect module is
  //    queryable in Sentry); the full snapshot rides as EXTRA for detail. The
  //    fingerprint (per-tier) is unaffected — these are additive context only.
  try {
    const livenessTags: Record<string, string> = nativeLiveness
      ? {
          native_fsevents_live: String(nativeLiveness.fseventsLiveInstances),
          native_moonshine_sessions: String(nativeLiveness.moonshineSessions),
          native_lancedb_conv: String(nativeLiveness.lancedbConnections.conversation),
          native_lancedb_file: String(nativeLiveness.lancedbConnections.file),
          native_lancedb_tool: String(nativeLiveness.lancedbConnections.tool),
          native_supermcp_running: String(nativeLiveness.superMcpRunning),
        }
      : {};
    capture(
      'quit_deadlock_detected',
      {
        tier,
        tags: { platform, quit_deadlock_tier: tier, ...livenessTags },
        ...(nativeLiveness ? { extra: { nativeLiveness } } : {}),
      },
      new Error(`Quit deadlock detected (${tier})`),
    );
  } catch (captureErr) {
    ignoreBestEffortCleanup(captureErr, {
      operation: 'emitQuitDeadlockDetected.captureKnownCondition',
      reason: 'Quit-deadlock Sentry capture is best-effort; a capture failure must never block or break the exit path',
    });
  }

  // 3. BOUNDED flush — flushMainSentry resolves false (never throws) on
  // timeout/failure, so this can never extend an already-hung quit.
  try {
    await flush(flushBudgetMs);
  } catch (flushErr) {
    ignoreBestEffortCleanup(flushErr, {
      operation: 'emitQuitDeadlockDetected.flushMainSentry',
      reason: 'Pre-exit Sentry flush is best-effort and bounded; a flush failure must never block or break the exit path',
    });
  }
}

/**
 * Arm a one-shot Windows force-exit fallback timer. After `budgetMs`, if the
 * process is still alive AND the quit is genuinely stuck (`isStillStuck()`
 * returns true), emit `quit_deadlock_detected` then force-exit via the injected
 * exit primitive (which sweeps leaked fsevents instances). Returns the timer
 * handle so the caller can `clearTimeout` it when the normal quit handoff is
 * observed.
 *
 * FALSE-POSITIVE PREVENTION (two layers — mirrors how macOS Tier-1 guards on
 * `if (!quitEventFired)`):
 *   1. Caller is expected to `clearTimeout` the returned handle on positive
 *      clean-handoff evidence (before-quit / will-quit fired).
 *   2. Defence-in-depth: even if a clear is missed (timer/event race), the
 *      callback re-checks `isStillStuck()` and SKIPS the emit + force-exit when
 *      the quit is already proceeding. A normal-but-slow install handoff must
 *      NEVER be force-exited mid-install — that would be worse than the hang
 *      this backstop is meant to catch. When `isStillStuck` is omitted the
 *      gate defaults to "stuck" (fire), preserving the unguarded contract for
 *      callers that drive the clear themselves.
 *
 * Extracted as a pure, dependency-injected function so the timer + gate + emit
 * + force-exit behaviour is directly unit-testable with fake timers (the
 * surrounding `safeQuitAndInstallWindows` is too entangled with the
 * electron-updater singleton to drive end-to-end in a unit test).
 */
export function scheduleWindowsForceExitFallback(deps: {
  budgetMs?: number;
  emit?: (tier: QuitDeadlockTier) => Promise<void>;
  forceExit: () => void;
  /**
   * Returns true iff the quit is still genuinely stuck (no clean-handoff
   * lifecycle event has fired). Defaults to always-stuck when omitted.
   */
  isStillStuck?: () => boolean;
  setTimeoutFn?: typeof setTimeout;
}): ReturnType<typeof setTimeout> {
  const budgetMs = deps.budgetMs ?? WINDOWS_FORCE_EXIT_BUDGET_MS;
  const emit = deps.emit ?? emitQuitDeadlockDetected;
  const isStillStuck = deps.isStillStuck ?? (() => true);
  const schedule = deps.setTimeoutFn ?? setTimeout;

  return schedule(() => {
    // Defence-in-depth gate: if the quit is already proceeding, this is a
    // false positive — do nothing rather than force-exit a normal install.
    if (!isStillStuck()) {
      return;
    }
    fireAndForget((async () => {
      try {
        // Ledger + bounded-flush emit BEFORE the force-exit so the signal is
        // durable even if the exit beats the flush.
        await emit('win');
      } catch (emitErr) {
        // emit is already fail-safe; never let it block the force-exit.
        ignoreBestEffortCleanup(emitErr, {
          operation: 'scheduleWindowsForceExitFallback.emit',
          reason: 'Quit-deadlock emit is best-effort; the force-exit must run regardless of telemetry outcome',
        });
      } finally {
        try {
          deps.forceExit();
        } catch (exitErr) {
          ignoreBestEffortCleanup(exitErr, {
            operation: 'scheduleWindowsForceExitFallback.forceExit',
            reason: 'Force-exit primitive failure is logged best-effort; nothing further can run on this exit path',
          });
        }
      }
    })(), 'quitDeadlockTelemetry.windowsForceExitFallback');
  }, budgetMs);
}
