/**
 * cloudPeriodicRewalkService — the periodic re-walk scheduler for the
 * `260619_cloud-symlink-indexing` feature (S4.3). It REPLACES, in spirit, two
 * pieces of the "heavy machinery" S4.2 deletes:
 *
 *  1. the prober's decaying-backoff re-probe (`scheduleReprobe`) — each tick
 *     re-probes EVERY known cloud target, so a dead/recovering mount keeps getting
 *     checked without a per-target backoff timer; and
 *  2. the recovery re-index (`fireRecovery` → `restartCurrent` + reindex) — when a
 *     tick observes ANY cloud target healthy, it schedules ONE coalesced re-walk so
 *     a recovered mount's content rejoins the index.
 *
 * It deliberately does NOT replace de-admission watcher retraction (gone once cloud
 * is never live-watched — S4.2/DROP-3) nor absence-purge (retain, no auto-purge in
 * v1 — PLAN invariant 3). A degraded mount is simply retried next tick; its
 * last-known index is retained, never purged.
 *
 * ── DESIGN CONTRACT (binding revisions from the S4.3 cross-family review) ──
 *  - R6 (flag-OFF neutrality): the tick re-reads `isEnabled()` FIRST and STRICTLY —
 *    with the flag off it does NO work beyond an inert, `.unref()`'d timer (no target
 *    derivation, no probe, no re-walk). `getCloudTargets()→[]` is only a SECOND guard.
 *  - R1 (settled verdicts): the tick `await`s `probeHealth()` for its targets before
 *    deciding to re-walk. The prober's `prewarm`/`getCachedVerdict` are
 *    fire-and-forget, so checking the cache immediately after a prewarm would miss a
 *    just-recovered mount and slip recovery to the next interval.
 *  - R2 (real re-walk): `rewalk()` must be a forced, NON-CLEARING discovery pass that
 *    bypasses the startup skip heuristic — `fileWatcherService.discoverWorkspaceNow()`,
 *    NOT `reindexWorkspace(false)` (which commonly skips discovery entirely).
 *  - R3 (S4.3 was purely additive): S4.3 left the legacy prober recovery/degrade
 *    machinery + `restartCurrent` in place and ran this scheduler alongside it. S4.2
 *    then deleted that legacy machinery and rewired the admission flag-flip caller
 *    onto `triggerRewalk` (below) — the one explicit re-walk push the scheduler now
 *    exposes (recovery itself stays tick-only, Q1).
 *  - R4 (target enumeration): callers pass a readlink-only "all cloud targets"
 *    enumerator (`deriveCloudPrewarmTargets`) — FS-free, returns dead targets too
 *    (we WANT to probe them), with no coupling to the absence-producer's purge
 *    semantics.
 *
 * The single-flight + trailing-coalesce below is COPIED (not imported) from
 * `cloudRecoveryReindex.ts` so S4.2 can delete that file without touching this one.
 *
 * `src/main` only: it drives the desktop file watcher. Cloud/mobile don't run a
 * local chokidar workspace watcher, so there is nothing to periodically re-walk
 * there. Triggers are INJECTED so the gating/coalescing is unit-testable without the
 * real watcher or prober.
 */
import { createScopedLogger } from '@core/logger';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { CloudHealthVerdict, ReadlinkResolvedTarget } from '@core/services/cloudLivenessProbe';

const log = createScopedLogger({ service: 'cloudPeriodicRewalk' });

/**
 * v1 interval: 5 minutes. The dropped `scheduleReprobe` backoff capped near ~120s,
 * but it only re-probed individual dead targets; this tick can drive a
 * full-workspace re-walk, so a tighter cadence would over-churn. The retained index
 * makes ≤5-min recovery latency tolerable (S4.3 review Q2).
 */
export const CLOUD_PERIODIC_REWALK_INTERVAL_MS = 300_000;

export interface CloudPeriodicRewalkDeps {
  /**
   * Re-read per tick (R6). The admission flag — `false` short-circuits the tick
   * before ANY target derivation / probe / re-walk so behaviour is byte-identical
   * with the flag off.
   */
  isEnabled: () => boolean;
  /**
   * Readlink-only, FS-free enumeration of ALL known cloud-symlink targets (R4 —
   * `deriveCloudPrewarmTargets`). Dead targets ARE included (we probe them). Returns
   * `[]` when there are no cloud-symlink spaces.
   */
  getCloudTargets: () => readonly ReadlinkResolvedTarget[];
  /**
   * Probe ONE target and resolve its SETTLED verdict (R1 — the prober's
   * `probeHealth`, a total function that never rejects). The tick awaits these
   * before deciding whether to re-walk.
   */
  probeHealth: (target: ReadlinkResolvedTarget) => Promise<CloudHealthVerdict>;
  /**
   * Forced, non-clearing discovery re-walk of the current workspace (R2 —
   * `fileWatcherService.discoverWorkspaceNow`). Bounded by the workspace-fs boundary;
   * retains last-known on a degraded mount; never clears the index.
   */
  rewalk: () => Promise<void>;
  /** Tick interval (injected so tests can use a short value). */
  intervalMs: number;
}

export interface CloudPeriodicRewalkScheduler {
  /** Begin the periodic `.unref()`'d tick. Idempotent. */
  start(): void;
  /** Stop the timer and prevent further ticks/re-walks. Idempotent. */
  dispose(): void;
  /**
   * Push a coalesced re-walk NOW (S4.2). Used by the admission flag-flip caller so a
   * flip takes effect immediately instead of waiting up to one interval for the
   * periodic tick. Shares the SAME single-flight + trailing-coalesce as the tick (one
   * re-walk at a time; a push during an in-flight re-walk runs exactly one trailing
   * pass). No-op when disposed OR when the flag is off (R6 — a flip-OFF must not leak
   * an observable re-walk; DROP-3 already excludes cloud from the live watch, so an
   * off-flip has nothing to retract). `reason` is logged for traceability.
   */
  triggerRewalk(reason: string): void;
  /**
   * Test-only: run exactly one tick to completion (the probe phase). The re-walk it
   * may schedule is fire-and-forget (single-flighted); awaiting this resolves once
   * the probe-and-decide phase is done.
   */
  __runTickForTests(): Promise<void>;
}

export function createCloudPeriodicRewalkScheduler(
  deps: CloudPeriodicRewalkDeps,
): CloudPeriodicRewalkScheduler {
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  // Guards the PROBE phase: a slow/dead mount's `probeHealth` could outlast the
  // interval; without this, ticks would pile up probes. The re-walk has its own
  // single-flight below.
  let tickInFlight = false;
  // Single-flight + trailing-coalesce for the heavy re-walk (copied from
  // cloudRecoveryReindex.ts). At most one re-walk runs; a trigger during a run
  // collapses to exactly one trailing re-walk reading the latest workspace state.
  let rewalkInFlight = false;
  let rewalkPendingRerun = false;

  const scheduleRewalk = (): void => {
    if (disposed) return;
    if (rewalkInFlight) {
      rewalkPendingRerun = true;
      return;
    }
    rewalkInFlight = true;
    fireAndForget(
      (async () => {
        try {
          await deps.rewalk();
        } catch (err) {
          // A re-walk failure must never break the periodic loop.
          log.warn({ err }, 'cloud periodic re-walk failed');
        } finally {
          rewalkInFlight = false;
          const rerun = rewalkPendingRerun;
          rewalkPendingRerun = false;
          // R6: a trailing re-walk must NOT fire if the flag flipped off (or we were
          // disposed) while re-walk #1 was in flight — otherwise an observable
          // re-walk leaks past a flag-off. Re-read `isEnabled()` here, not just at
          // tick entry.
          if (rerun && !disposed && deps.isEnabled()) {
            scheduleRewalk();
          }
        }
      })(),
      'cloudPeriodicRewalk.scheduleRewalk',
    );
  };

  const runTick = async (): Promise<void> => {
    // R6: strict flag gate FIRST — flag off ⇒ no observable work.
    if (!deps.isEnabled() || disposed) return;
    // Don't pile up probe phases across ticks on a slow/dead mount.
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const targets = deps.getCloudTargets();
      if (targets.length === 0) return; // second guard: no cloud-symlink spaces
      // R1: AWAIT settled verdicts. `probeHealth` is a total fn (never rejects), so
      // Promise.all never rejects either.
      const verdicts = await Promise.all(targets.map((t) => deps.probeHealth(t)));
      // The flag could have flipped off, or we could have been disposed, while the
      // probes settled — re-check before scheduling an observable re-walk.
      if (disposed || !deps.isEnabled()) return;
      const healthyCount = verdicts.filter((v) => v === 'healthy').length;
      if (healthyCount > 0) {
        log.info(
          { targetCount: targets.length, healthyCount },
          'cloud periodic re-walk: ≥1 healthy cloud target — scheduling a coalesced re-walk',
        );
        scheduleRewalk();
      }
      // else: all degraded/unknown ⇒ retain last-known index, retry next tick.
    } finally {
      tickInFlight = false;
    }
  };

  return {
    start(): void {
      if (timer !== null || disposed) return;
      timer = setInterval(() => {
        fireAndForget(runTick(), 'cloudPeriodicRewalk.tick');
      }, deps.intervalMs);
      // Never keep the process alive for a re-walk tick.
      timer.unref?.();
      log.info({ intervalMs: deps.intervalMs }, 'cloud periodic re-walk scheduler started');
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    triggerRewalk(reason: string): void {
      if (disposed) return;
      // R6: a flip-OFF must NOT drive an observable re-walk. The flag-flip caller
      // invokes this on BOTH transitions; gate on isEnabled so flip-OFF is a clean
      // no-op (DROP-3 already excludes cloud — nothing to retract) and flip-ON
      // re-walks. (scheduleRewalk's trailing-rerun also re-checks isEnabled.)
      if (!deps.isEnabled()) {
        log.info({ reason }, 'cloud re-walk trigger ignored (admission flag off)');
        return;
      }
      log.info({ reason }, 'cloud periodic re-walk: explicit trigger');
      scheduleRewalk();
    },
    async __runTickForTests(): Promise<void> {
      await runTick();
    },
  };
}
