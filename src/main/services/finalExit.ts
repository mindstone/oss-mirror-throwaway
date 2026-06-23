/**
 * Final-exit primitive: the ONLY sanctioned way to hard-exit the process.
 *
 * Why this exists — and why it is PERMANENT: a live fsevents native instance
 * at env teardown hangs in the fsevents finalizer (nodejs/node#55706 — see
 * `fseventsLeakGuard.ts`). On Electron 39 (Node 22.x) it SIGABRTed; on Node 24
 * (Electron >= 41) the lifetime fix converts the crash into an indefinite quit
 * DEADLOCK at the same `fse_instance_destroy → napi_release_threadsafe_function
 * → __psynch_mutexwait` site (spike §3 — telemetry-blind hung quit, not a
 * crash). The sweep neutralises both, so this primitive does NOT retire on the
 * 42 upgrade. `app.exit()` does NOT skip that teardown (the 260611 crash stack
 * proves it) and emits NO lifecycle events, so neither `before-quit` cleanup nor
 * a `will-quit` listener can cover a direct `app.exit()` call site. The fix
 * shape (PLAN.md Stage 2, Arbitrator F1 +
 * amendment F1/F2): every point-of-no-return exit goes through
 * `immediateExitWithFseventsSweep()`, which force-stops any leaked fsevents
 * instances (a stopped instance provably cannot crash — FSEStop nulls the
 * native callback) immediately before exiting.
 *
 * Scoping rule (CRITICAL — Arbitrator F1): the sweep runs ONLY here, at true
 * points of no return. NEVER call it from `shutdownInternal()` /
 * `gracefulShutdownServicesOnly()` / `closeNativeWatchersForUpdate()` — those
 * paths can be followed by a watcher restart (workspace rename, failed-update
 * restore), and force-stopping a pool-refcounted instance there silently
 * dead-watchers the resumed watcher.
 *
 * `scripts/check-app-exit-chokepoint.ts` enforces by construction that no
 * bare `app.exit(` exists in src/main/** outside this module and a classified
 * pre-watcher allowlist.
 *
 * Everything here is fail-open: a sweep failure must never prevent the exit.
 *
 * Design source: docs/plans/260611_fsevents-shutdown-crash/PLAN.md (Stage 2).
 */
import { getElectronModule } from '@core/lazyElectron';
import { logger } from '@core/logger';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { captureMainMessage, flushMainSentry } from '../sentry';
import { enterQuitMode, liveNativeInstanceCount, sweepLeakedInstances } from './fseventsLeakGuard';

/**
 * Outer belt around the sweep. `sweepLeakedInstances()` already bounds itself
 * (1s internal budget); this race is belt-and-braces so the exit can never
 * stall even if the guard's own bounding fails.
 */
const OUTER_SWEEP_BELT_MS = 2_000;

/**
 * Sentry transport budget for the pre-exit leak-confirmation capture. Only
 * spent on the sweptCount>0 path — the common clean quit never waits on it.
 */
const PRE_EXIT_SENTRY_FLUSH_MS = 1_500;

/**
 * Hard cap on the combined pre-exit telemetry flush (Sentry + diagnostic
 * ledger), bounding worst-case added exit latency on the leak path (RS F1).
 */
const PRE_EXIT_TELEMETRY_BELT_MS = 2_000;

/** Which point-of-no-return path performed the sweep (ledger discriminator). */
type SweepTrigger =
  | { trigger: 'immediate_exit'; exitReason: string }
  | { trigger: 'will_quit_backstop' };

/**
 * Persist + best-effort-deliver the leak confirmation before the process
 * dies (RS F1): a Sentry capture fired microtasks before `app.exit()` has no
 * flush and is mostly lost (in-flight HTTP aborted at exit; the offline queue
 * persists failed sends, not aborted ones), and the diagnostic ledger's
 * shutdown flush ran earlier in the chain — a bare append would still sit in
 * its 50ms debounce queue at exit. So: append a structured ledger entry (the
 * durable local copy Stage 4's canary can always read), then await a BOUNDED
 * combined flush. Fail-open; bounded by PRE_EXIT_TELEMETRY_BELT_MS.
 *
 * Residual (documented, not fixable here): on the will-quit BACKSTOP path
 * Electron proceeds with its own quit without awaiting this promise, so the
 * flushes may not complete before process death — telemetry delivery on that
 * path is inherently best-effort. Stage 4/5 must not over-trust the canary
 * for update-path quits.
 */
async function persistAndFlushSweepTelemetry(sweptCount: number, source: SweepTrigger): Promise<void> {
  try {
    appendDiagnosticEvent({
      kind: 'fsevents_leak_sweep',
      data: {
        sweptCount,
        trigger: source.trigger,
        ...(source.trigger === 'immediate_exit' ? { exitReason: source.exitReason } : {}),
      },
    });

    const flushes = Promise.allSettled([
      flushMainSentry(PRE_EXIT_SENTRY_FLUSH_MS),
      (async () => {
        // Same dynamic-import pattern as gracefulShutdown's ledger flushes.
        const { flushDiagnosticEventsLedger } = await import('./diagnosticEventsLedgerWriter');
        await flushDiagnosticEventsLedger();
      })(),
    ]);

    let beltTimer: NodeJS.Timeout | undefined;
    const belt = new Promise<void>((resolve) => {
      beltTimer = setTimeout(resolve, PRE_EXIT_TELEMETRY_BELT_MS);
      beltTimer.unref?.();
    });
    try {
      await Promise.race([flushes, belt]);
    } finally {
      if (beltTimer) {
        clearTimeout(beltTimer);
      }
    }
  } catch (error) {
    logger.warn({ err: error }, 'final exit: sweep telemetry persist/flush failed (fail-open)');
  }
}

/**
 * Enter quit mode and force-stop every leaked fsevents instance, with
 * telemetry.
 *
 * Timing note (final review F1): the real fsevents stop closure is
 * `Promise.resolve(instance).then(Native.stop)` (fsevents.js:33) — invoking
 * the closure inside `sweepLeakedInstances()` only SCHEDULES the native stop
 * as a promise microtask. The stop is therefore guaranteed only once this
 * function's sweep await has resolved — callers that need the instances
 * provably stopped before process teardown MUST await (the primitive does;
 * the will-quit backstop routes live-instance cases through the primitive
 * for exactly this reason).
 */
async function sweepAtPointOfNoReturn(source: SweepTrigger): Promise<void> {
  const context =
    source.trigger === 'immediate_exit' ? `immediate-exit:${source.exitReason}` : 'will-quit-backstop';
  enterQuitMode();

  let outcome: { sweptCount: number } | 'belt-timeout' = 'belt-timeout';
  let beltTimer: NodeJS.Timeout | undefined;
  try {
    const belt = new Promise<void>((resolve) => {
      beltTimer = setTimeout(resolve, OUTER_SWEEP_BELT_MS);
      beltTimer.unref?.();
    });
    await Promise.race([
      sweepLeakedInstances().then((sweptCount) => {
        outcome = { sweptCount };
      }),
      belt,
    ]);
  } finally {
    if (beltTimer) {
      clearTimeout(beltTimer);
    }
  }

  if (outcome === 'belt-timeout') {
    logger.warn({ context }, 'final exit: fsevents sweep exceeded outer belt budget (fail-open)');
    return;
  }

  const { sweptCount } = outcome;
  logger.info({ context, sweptCount }, 'final exit: fsevents sweep complete');
  if (sweptCount > 0) {
    // Any nonzero count is an in-the-wild confirmation of the chokidar-v3
    // pool leak that produced the quit-time SIGABRT class. Raw info-level
    // message captures are forbidden at compile time (Sentry sink policy) —
    // warning is the lowest adjudicable raw level and this IS noteworthy.
    captureMainMessage(`fsevents leak sweep stopped ${sweptCount} instances`, {
      level: 'warning',
      fingerprint: ['fsevents-leak-sweep-stopped-instances'],
      tags: { condition: 'fsevents-leak-sweep-stopped-instances', context },
      extra: { sweptCount },
    });
    // RS F1: make the confirmation survive the imminent exit — durable
    // ledger entry + bounded flush of both sinks. Leak path only.
    await persistAndFlushSweepTelemetry(sweptCount, source);
  }
}

/**
 * Sweep leaked fsevents instances, then hard-exit the process.
 *
 * Use this — and ONLY this — at every point-of-no-return exit site:
 * graceful-shutdown completion, the macOS update Tier-2 fallback, headless
 * CLI completion, etc. Desktop exits via `app.exit(exitCode)`; cloud (no
 * electron module) via `process.exit(exitCode)` — plain-Node `process.exit`
 * skips handle teardown so the sweep there is harmless belt-and-braces.
 *
 * Callers that must preserve `markCleanExit()` / clean-exit-flag ordering
 * should set the flag BEFORE calling this (the sweep runs after the flag
 * write, immediately before exit).
 *
 * Safe to call more than once (a second sweep finds an empty set; a second
 * exit call is unreachable or a no-op).
 */
export async function immediateExitWithFseventsSweep(reason: string, exitCode: number): Promise<void> {
  await finalExitWithSweep({ trigger: 'immediate_exit', exitReason: reason }, exitCode);
}

/**
 * Shared awaited sweep-then-exit core. Internal so the SweepTrigger ledger
 * attribution stays honest: the will-quit backstop's deterministic leg exits
 * through here with `trigger: 'will_quit_backstop'` instead of masquerading
 * as an immediate-exit reason string.
 */
async function finalExitWithSweep(source: SweepTrigger, exitCode: number): Promise<void> {
  const reason = source.trigger === 'immediate_exit' ? source.exitReason : 'will-quit-backstop';
  try {
    logger.info({ reason, exitCode }, 'final exit requested — sweeping leaked fsevents instances before exit');
    await sweepAtPointOfNoReturn(source);
  } catch (error) {
    logger.warn({ err: error, reason }, 'final exit: sweep failed (fail-open) — exiting anyway');
  } finally {
    let electron: ReturnType<typeof getElectronModule> = null;
    try {
      electron = getElectronModule();
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'finalExit.resolveElectronModule',
        reason: 'Exiting must never fail — fall through to process.exit when the electron module is unresolvable',
      });
    }
    if (electron) {
      electron.app.exit(exitCode);
    } else {
      process.exit(exitCode);
    }
  }
}

/**
 * Guarded last-resort backstop for quits that bypass the final-exit primitive
 * (e.g. a stray `app.quit()` after `removeBeforeQuitHandlerForUpdate()` has
 * disarmed the graceful-shutdown chain). Registers a `will-quit` listener.
 *
 * MUST be registered late (after app ready) so it runs AFTER bootstrap's
 * early-registered will-quit handler. That handler can `event.preventDefault()`
 * to drain the upload outboxes and re-quit later — a prevented `will-quit` is
 * a CANCELLED quit: the app stays alive and its watchers must keep working.
 * Sweeping (and entering one-way quit mode) on a cancelled quit would silently
 * dead-watcher a live app (PLAN.md Stage 2 / amendment review F1), hence the
 * `event.defaultPrevented` no-op below.
 *
 * Two legs (final review F1):
 *  - **Live instances present → DETERMINISTIC.** The fsevents stop closure
 *    only SCHEDULES the native stop as a promise microtask (fsevents.js:33);
 *    letting Electron continue its own quit would race env teardown against
 *    that microtask — the exact SIGABRT window this plan exists to close, on
 *    the very paths where the backstop is the only protection (macOS update
 *    handoff after removeBeforeQuitHandlerForUpdate + quitAndInstall). The
 *    quit is already committed at an uncancelled will-quit, so forcing the
 *    exit after the bounded awaited sweep is semantics-preserving: route
 *    through the shared awaited core (sweep + telemetry + app.exit(0)).
 *    Chosen over preventDefault→await→re-quit, which would (a) put a
 *    cancel/re-emit cycle on a path ShipIt is sensitive to and (b) require
 *    allowlisting this module in the will-quit-preventDefault chokepoint
 *    guard, weakening it to two files.
 *  - **Nothing live → passive.** Enter quit mode (auto-stops any
 *    started-after-this watch, Arbitrator F3) and let Electron continue its
 *    own quit; no exit call, no behavior change. Sweep of an empty set is a
 *    no-op, so there is no microtask race to lose.
 */
export function registerWillQuitFseventsSweepBackstop(): void {
  const electron = getElectronModule();
  if (!electron) {
    // Cloud surface: no Electron lifecycle; exits go through the primitive.
    return;
  }
  electron.app.on('will-quit', (event: Electron.Event) => {
    if (event.defaultPrevented) {
      // An earlier handler (bootstrap's outbox drain) cancelled this quit —
      // the app is still alive. Do not sweep, do not enter quit mode.
      return;
    }
    if (liveNativeInstanceCount() > 0) {
      // Deterministic leg — see doc comment. finalExitWithSweep awaits the
      // sweep (so the scheduled native stops provably ran) before app.exit(0).
      //
      // Fire-and-forget WITHOUT event.preventDefault() is deliberate and safe,
      // not an oversight: the awaited core runs the sweep to completion before
      // its app.exit(0), and this exact "Electron continues teardown while the
      // sweep microtask is still pending" race was DIRECTLY MEASURED. In
      // docs/plans/260611_fsevents-shutdown-crash/ Stage 4(e) Leg B, a
      // guaranteed-live injected leaked native fsevents instance was driven
      // through this backstop-only path (before-quit listeners stripped,
      // windows destroyed) on Electron 39 — the runtime that actually SIGABRTs
      // — and produced 15/15 clean exits, 0 SIGABRT (45/45 combined with Leg A).
      // Do NOT "fix" this by adding preventDefault (rejected above; would also
      // weaken check-will-quit-preventdefault-chokepoint.ts). On a fixed
      // Electron 42 build the residual failure mode of an unswept leak is a
      // telemetry-blind deadlock, not this SIGABRT.
      finalExitWithSweep({ trigger: 'will_quit_backstop' }, 0).catch((error: unknown) => {
        logger.warn({ err: error }, 'will-quit fsevents sweep backstop failed (fail-open)');
      });
      return;
    }
    // Passive leg: nothing to stop; quit mode only.
    sweepAtPointOfNoReturn({ trigger: 'will_quit_backstop' }).catch((error: unknown) => {
      logger.warn({ err: error }, 'will-quit fsevents sweep backstop failed (fail-open)');
    });
  });
}
