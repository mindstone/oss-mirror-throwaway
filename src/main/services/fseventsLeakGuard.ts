/**
 * fsevents Leak Guard
 *
 * Tracks every native fsevents instance the process starts so that leaked
 * instances can be force-stopped at the point of no return on quit.
 *
 * Why this exists — and why it is PERMANENT (NOT a bridge): a live fsevents
 * instance at Node env teardown hangs the quit in fsevents' N-API finalizer
 * (`fse_instance_destroy → napi_release_threadsafe_function → __psynch_mutexwait`).
 * On Electron 39 (Node 22.x) this aborted the process (SIGABRT, nodejs/node#55706);
 * the Node 24 TSFN lifetime fix (nodejs/node#55877, in Electron >= 41) does NOT
 * make the unswept leak safe — it converts the crash into an indefinite quit
 * DEADLOCK at the SAME finalizer site (measured deterministic across 48/48
 * leak-injected quits, stationary for a 600s probe; see
 * docs/project/AUTO_UPDATE.md (fsevents sweep / Electron 42 section) for the finding + measurements).
 * A deadlocked quit is telemetry-blind (no .ips, no Sentry crash) and would
 * stall an updater waiting on process exit. So this guard does NOT retire on the
 * Electron 42 upgrade — it is the only thing standing between a chokidar pool
 * refcount leak and a hung quit, on every Electron line. A cleanly STOPPED
 * instance is harmless on both Node 22 and Node 24 (`FSEStop` nulls
 * `instance->callback`, so the finalizer no-ops). chokidar v3's
 * fsevents-handler keeps a module-global pool of shared refcounted native
 * instances; a refcount miss leaks an instance even when every
 * `FSWatcher.close()` resolves. This guard is the chokepoint BELOW that
 * pooling: it patches `watch` on the shared fsevents CJS exports object
 * (chokidar reads `fsevents.watch` via call-time property lookup —
 * node_modules/chokidar/lib/fsevents-handler.js:94), so every instance is
 * tracked regardless of which leak path produced it.
 *
 * Sweep placement rule: `sweepLeakedInstances()` / `enterQuitMode()` must run
 * ONLY at a true point of no return (Stage 2 final-exit primitive) — never in
 * shared cleanup paths that can be followed by a watcher restart (workspace
 * rename, failed-update restore); force-stopping a pool-refcounted instance
 * there silently dead-watchers the resumed watcher.
 *
 * Everything here is fail-open: a guard failure must never break boot,
 * watching, or quit.
 *
 * Design + verified mechanics: docs/plans/260611_fsevents-shutdown-crash/PLAN.md
 * (Stage 1, Root Cause Assessment, Assumptions).
 */
import { logger } from '@core/logger';

/**
 * Shape of the real stop closure returned by `fsevents.watch()`
 * (node_modules/fsevents/fsevents.js:33-37). It is double-stop safe: the
 * closure nulls its captured instance, so a second invocation resolves
 * `undefined` without touching native state.
 */
type FseventsStopClosure = () => Promise<unknown>;

type FseventsWatch = (...args: unknown[]) => FseventsStopClosure;

/** Minimal structural view of the fsevents CJS exports object. */
export interface FseventsModuleLike {
  watch: FseventsWatch;
}

export type FseventsLeakGuardInstallResult =
  | 'installed'
  | 'already-installed'
  | 'inert:non-darwin'
  | 'inert:unloadable'
  | 'inert:unexpected-shape'
  | 'inert:install-failed';

export interface InstallFseventsLeakGuardOptions {
  /** Test seam — defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Test seam — defaults to a CJS `require('fsevents')`. */
  loadFseventsModule?: () => FseventsModuleLike;
}

/**
 * Native stops are near-instant once they run, but they run as PROMISE
 * MICROTASKS, not synchronously: the fsevents stop closure is
 * `Promise.resolve(instance).then(Native.stop)` (fsevents.js:33). Callers
 * that need the instances provably stopped must therefore AWAIT the sweep
 * (final review F1). The budget only bounds pathological hangs so quit can
 * never stall here.
 */
const DEFAULT_SWEEP_TIME_BUDGET_MS = 1_000;

let patchedModule: FseventsModuleLike | null = null;
let originalWatch: FseventsWatch | null = null;
let quitMode = false;
let quitModeEnteredAt: number | null = null;
let lateQuitModeWatchReported = false;
let installState: FseventsLeakGuardInstallResult | null = null;
const liveStopClosures = new Set<FseventsStopClosure>();

/**
 * A watch() arriving this long after `enterQuitMode()` means the process is
 * still alive long after a point-of-no-return exit was requested — either a
 * quit stalled, or a cancelled-quit edge we believe unreachable occurred
 * (the strangled-live-app signature, RS F3). One-shot loud report.
 */
const LATE_QUIT_MODE_WATCH_THRESHOLD_MS = 10_000;

function reportLateQuitModeWatchOnce(sinceQuitModeMs: number): void {
  if (lateQuitModeWatchReported) {
    return;
  }
  lateQuitModeWatchReported = true;
  logger.warn(
    { sinceQuitModeMs },
    'fsevents leak guard: watch() called long after quit mode entered — app appears alive past its point of no return',
  );
  // Lazy import: keeps the heavy sentry module off this bootstrap-time
  // module's import graph (and out of the unit tests' way). App is alive
  // here, so no flush is needed. Fail-open.
  import('../sentry')
    .then(({ captureMainMessage }) => {
      captureMainMessage('fsevents watch() in quit mode long after final exit requested', {
        level: 'warning',
        fingerprint: ['fsevents-late-quit-mode-watch'],
        tags: { condition: 'fsevents-late-quit-mode-watch' },
        extra: { sinceQuitModeMs },
      });
    })
    .catch((error: unknown) => {
      logger.warn({ error }, 'fsevents leak guard: late-quit-mode Sentry report failed (fail-open)');
    });
}

function defaultLoadFseventsModule(): FseventsModuleLike {
  // Deliberate CJS require (NOT a static import): resolves the exact same
  // module-cache entry chokidar's fsevents-handler gets via its own
  // `require('fsevents')`, so patching `watch` below mutates the one shared
  // exports object. A bundler-transformed import could yield a separate
  // namespace copy. See PLAN.md Stage 1 load-order spec.
  return require('fsevents') as FseventsModuleLike;
}

function stopInstanceFailOpen(stop: FseventsStopClosure, context: string): void {
  try {
    Promise.resolve(stop()).catch((error: unknown) => {
      logger.warn({ error, context }, 'fsevents leak guard: native stop rejected (fail-open)');
    });
  } catch (error) {
    logger.warn({ error, context }, 'fsevents leak guard: native stop threw synchronously (fail-open)');
  }
}

/**
 * Patch `watch` on the shared fsevents exports object so every returned stop
 * closure is tracked until it is invoked (normal stop) or swept.
 *
 * Must be called from EXECUTED bootstrap code BEFORE `./index` loads (index
 * statically imports the chokidar consumers). Idempotent and fail-open.
 */
export function installFseventsLeakGuard(
  options: InstallFseventsLeakGuardOptions = {},
): FseventsLeakGuardInstallResult {
  const result = installFseventsLeakGuardInternal(options);
  if (result !== 'already-installed') {
    installState = result;
  }
  return result;
}

function installFseventsLeakGuardInternal(
  options: InstallFseventsLeakGuardOptions,
): FseventsLeakGuardInstallResult {
  if (patchedModule) {
    return 'already-installed';
  }

  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    // fsevents is darwin-only (its module body throws elsewhere) — stay inert.
    return 'inert:non-darwin';
  }

  try {
    let fseventsModule: FseventsModuleLike;
    try {
      fseventsModule = (options.loadFseventsModule ?? defaultLoadFseventsModule)();
    } catch (error) {
      // chokidar tolerates an unloadable fsevents (falls back) — so do we.
      logger.info(
        { error: error instanceof Error ? error.message : String(error) },
        'fsevents leak guard: fsevents unloadable — guard inert',
      );
      return 'inert:unloadable';
    }

    if (typeof fseventsModule?.watch !== 'function') {
      logger.warn({}, 'fsevents leak guard: fsevents exports have unexpected shape — guard inert');
      return 'inert:unexpected-shape';
    }

    const original = fseventsModule.watch;
    const patchedWatch: FseventsWatch = (...args: unknown[]) => {
      const rawStop = original(...args);
      if (quitMode) {
        // Started-after-sweep hole, closed by construction (Arbitrator F3):
        // past the point of no return every new native instance is stopped
        // immediately so it cannot be live at env teardown.
        logger.warn(
          { path: typeof args[0] === 'string' ? args[0] : undefined },
          'fsevents leak guard: watch() called in quit mode — auto-stopping new native instance',
        );
        const sinceQuitModeMs = quitModeEnteredAt !== null ? Date.now() - quitModeEnteredAt : 0;
        if (sinceQuitModeMs > LATE_QUIT_MODE_WATCH_THRESHOLD_MS) {
          reportLateQuitModeWatchOnce(sinceQuitModeMs);
        }
        stopInstanceFailOpen(rawStop, 'quit-mode-auto-stop');
        // Honour the contract anyway; rawStop is double-stop safe.
        return rawStop;
      }
      liveStopClosures.add(rawStop);
      return () => {
        liveStopClosures.delete(rawStop);
        return rawStop();
      };
    };

    fseventsModule.watch = patchedWatch;
    patchedModule = fseventsModule;
    originalWatch = original;
    logger.info({}, 'fsevents leak guard installed');
    return 'installed';
  } catch (error) {
    logger.warn({ error }, 'fsevents leak guard: install failed — fsevents left unpatched (fail-open)');
    return 'inert:install-failed';
  }
}

/** Number of native fsevents instances currently live (started, not stopped). */
export function liveNativeInstanceCount(): number {
  return liveStopClosures.size;
}

/**
 * Read-only diagnostic snapshot of the guard's state.
 *
 * Consumed by the test-mode-only `e2e:fsevents-leak-guard-diagnostics` IPC
 * handler (src/main/index.ts) that backs the GATING packaged interception
 * assertion in scripts/check-packaged-app-boot-smoke.ts (PLAN.md Stage 3a):
 * on darwin a packaged run with the workspace watcher ready MUST show
 * `liveNativeInstanceCount > 0`, proving the module-cache interception works
 * in the packaged artifact. Pure read — no production caller, no side effects.
 */
export interface FseventsLeakGuardDiagnostics {
  /** Result of the bootstrap install call; null = install never ran. */
  installState: FseventsLeakGuardInstallResult | null;
  quitMode: boolean;
  liveNativeInstanceCount: number;
}

export function getFseventsLeakGuardDiagnostics(): FseventsLeakGuardDiagnostics {
  return {
    installState,
    quitMode,
    liveNativeInstanceCount: liveStopClosures.size,
  };
}

/**
 * Force-stop every outstanding native instance. Returns the number of leaked
 * instances found (the telemetry signal — any nonzero value is an in-the-wild
 * confirmation of the chokidar pool leak). Per-closure failures are contained
 * and the total wait is bounded, so quit can never hang here.
 *
 * Call ONLY from the point-of-no-return exit primitive (see module header).
 */
export async function sweepLeakedInstances(
  timeBudgetMs: number = DEFAULT_SWEEP_TIME_BUDGET_MS,
): Promise<number> {
  const leaked = [...liveStopClosures];
  liveStopClosures.clear();
  if (leaked.length === 0) {
    return 0;
  }

  const pendingStops: Array<Promise<unknown>> = [];
  for (const stop of leaked) {
    try {
      pendingStops.push(
        Promise.resolve(stop()).catch((error: unknown) => {
          logger.warn({ error }, 'fsevents leak guard: swept stop rejected (fail-open)');
        }),
      );
    } catch (error) {
      logger.warn({ error }, 'fsevents leak guard: swept stop threw synchronously (fail-open)');
    }
  }

  let budgetTimer: NodeJS.Timeout | undefined;
  const budget = new Promise<void>((resolve) => {
    budgetTimer = setTimeout(resolve, timeBudgetMs);
    budgetTimer.unref?.();
  });
  try {
    await Promise.race([Promise.allSettled(pendingStops), budget]);
  } finally {
    if (budgetTimer) {
      clearTimeout(budgetTimer);
    }
  }

  logger.info({ sweptCount: leaked.length }, 'fsevents leak guard: swept leaked native instances');
  return leaked.length;
}

/**
 * After this, any `fsevents.watch()` call is auto-stopped immediately (and
 * logged) instead of tracked. One-way; only the point-of-no-return exit
 * primitive may call it (a quit past this point is by definition uncancellable).
 */
export function enterQuitMode(): void {
  if (quitMode) {
    return;
  }
  quitMode = true;
  quitModeEnteredAt = Date.now();
  if (patchedModule) {
    logger.info(
      { liveInstances: liveStopClosures.size },
      'fsevents leak guard: quit mode entered — new watches will be auto-stopped',
    );
  }
}

/** Test-only: restore the original `watch` and clear all module state. */
export function resetFseventsLeakGuardForTests(): void {
  if (patchedModule && originalWatch) {
    patchedModule.watch = originalWatch;
  }
  patchedModule = null;
  originalWatch = null;
  quitMode = false;
  quitModeEnteredAt = null;
  lateQuitModeWatchReported = false;
  installState = null;
  liveStopClosures.clear();
}

export interface InjectLeakedFseventsInstanceResult {
  injected: boolean;
  reason?: string;
  liveNativeInstanceCount: number;
}

/**
 * Test-only (final review DA F1 leak-injection evidence): start ONE native
 * fsevents instance through the patched exports object and deliberately DROP
 * its stop closure, reproducing the chokidar-pool leak shape (a live native
 * instance nothing will ever stop). The point-of-no-return sweep is then the
 * only thing standing between this instance and the fatal env-teardown outcome
 * (SIGABRT on Electron <=40 / Node <=22; indefinite quit-deadlock on >=41 / Node >=24.13) —
 * exactly the wild scenario the packaged leak-injection stress verifies.
 *
 * Reached ONLY via the REBEL_E2E_TEST_MODE-gated `e2e:fsevents-inject-leak`
 * IPC handler (src/main/index.ts) — no production surface. Lives here (not in
 * the e2e block) so the `watch` call goes through the exact patched module
 * object the guard tracks.
 */
export function injectLeakedFseventsInstanceForTests(watchPath: string): InjectLeakedFseventsInstanceResult {
  if (!patchedModule) {
    return {
      injected: false,
      reason: `guard not active (installState=${installState ?? 'null'})`,
      liveNativeInstanceCount: liveStopClosures.size,
    };
  }
  try {
    // Deliberately drop the returned stop closure — this is the leak.
    patchedModule.watch(watchPath, () => {
      /* fsevents change callback — unused */
    });
    return { injected: true, liveNativeInstanceCount: liveStopClosures.size };
  } catch (error) {
    return {
      injected: false,
      reason: error instanceof Error ? error.message : String(error),
      liveNativeInstanceCount: liveStopClosures.size,
    };
  }
}
