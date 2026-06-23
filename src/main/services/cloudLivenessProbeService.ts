/**
 * cloudLivenessProbeService — desktop implementation of the Stage-1
 * `CloudLivenessProbe` interface (`@core/services/cloudLivenessProbe`).
 *
 * Owns a long-lived child PROCESS (`utilityProcess.fork` of
 * `cloudLivenessWorker.js`) that does all cloud-mount filesystem probing. The
 * per-probe timeout + kill-and-respawn live HERE, in the parent — the only
 * mechanism the Stage-0 spike proved actually isolates a wedged syscall:
 *
 *  - worker_threads share the process-global libuv threadpool and are
 *    un-killable when syscall-blocked → ruled out;
 *  - `runWithTimeout` (`Promise.race`) resolves on timeout but ABANDONS the
 *    underlying `fs.stat`, keeping a libuv worker parked → insufficient alone;
 *  - only SIGKILLing the child OS process reclaims the parked worker.
 *
 * Lifecycle is modelled on the three existing precedents:
 *  - `embeddingService` — long-lived crash/respawn + cooldown backoff;
 *  - `preTurnWorkerService` — `getElectronModule()` gating (disabled on
 *    cloud/headless) + packaged `app.asar.unpacked/workers` path resolution;
 *  - the `runIndexHealthCheckWithTimeout` shape in `index.ts` — kill-on-hang.
 *
 * STILL UNWIRED from descent/purge (Stage 4+). Spawning happens LAZILY on the
 * first `probeHealth`, so importing/registering this service is inert until
 * something actually probes — keeping the pre-Stage-7 behaviour exactly today's.
 *
 * RS-F4: on child SIGKILL/exit/crash, EVERY in-flight `probeHealth` promise is
 * drained to `degraded` (invert embeddingService's reject-pending pattern) so a
 * Stage-3 awaiter never leaks/hangs.
 *
 * Stage 3 (260619_cloud-symlink-indexing) layers the RECOVERY behaviour on top of
 * the Stage-2 engine, all inside this one retained instance:
 *  - real verdict TTLs (healthy ~45s); a non-healthy verdict has a short TTL so the
 *    hot-path `getCachedVerdict` re-reads `unknown` rather than a stale `degraded`.
 *    (S4.2: the per-target EXPONENTIAL BACKOFF re-probe + the auto-recovery/degrade
 *    transition callbacks were RETIRED — the cloud periodic re-walk scheduler
 *    re-probes ALL cloud targets each tick and drives the recovery re-walk.)
 *  - cold-start `prewarm(targets)` so a healthy Drive is verified within ONE
 *    launch (DA-2: the cold-start-dark-Drive bug), off-thread, never blocks boot;
 *  - a producer-side flap-debounced `getDisplayVerdict` (stable status for the
 *    Stage-8 UI) — distinct from the RAW un-debounced `getCachedVerdict` that
 *    admission/purge read for the immediate truth;
 *  - `invalidateVerdict(target)` for event-driven re-probe (workspace re-scan,
 *    watcher error).
 * RAW `getCachedVerdict` stays SYNCHRONOUS + UN-DEBOUNCED — admission/purge want
 * the immediate truth. The main thread never blocks on a mount on any path.
 *
 * Desktop-only (`utilityProcess`). Never loaded by core/cloud — the
 * transitive-electron-deps gate keeps `src/core` clean; this file lives in
 * `src/main`.
 */

import type { UtilityProcess } from 'electron';
import { getElectronModule } from '@core/lazyElectron';
import { getPlatformConfig } from '@core/platform';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type {
  CloudHealthVerdict,
  CloudLivenessProbe,
  ReadlinkResolvedTarget,
} from '@core/services/cloudLivenessProbe';
import { mintCloudHopTargetCloudRootSafe } from '@core/services/cloudLivenessProbe.types';
import { detectCloudStorage } from '@core/utils/cloudStorageUtils';
import type { SpaceConfig } from '@shared/types/settings';

const logger = createScopedLogger({ service: 'cloudLivenessProbe' });

// ---------------------------------------------------------------------------
// Tuning. Spike F5: healthy real-Drive metadata ops are sub-ms; depth-2 max
// 0.54ms. A 200ms parent-side timeout is 300–2000× headroom for a healthy mount
// while reclaiming a dead-mount child fast. Backoff prevents a respawn storm
// when a mount is permanently dead.
// ---------------------------------------------------------------------------

/** Hard parent-side per-probe timeout (ms). On expiry: SIGKILL child + degraded. */
const PROBE_TIMEOUT_MS = 200;

/**
 * Respawn cooldown after a child death (timeout-kill/crash/exit). Mirrors
 * embeddingService's CRASH_COOLDOWN_MS. While cooling down, `probeHealth`
 * short-circuits to `degraded` without spawning — so a permanently-dead mount
 * that kills the child every probe cannot cause a respawn storm.
 */
const RESPAWN_COOLDOWN_MS = 5000;

/**
 * Cache TTLs. A healthy verdict is trusted for ~45s (Drive metadata is local-disk
 * fast; re-probing more often is wasteful). A non-healthy verdict has a short TTL
 * so a hot-path `getCachedVerdict` re-reads `unknown` (→ exclude + retain) rather
 * than a stale `degraded`. The cloud periodic re-walk scheduler (S4.2) is what
 * actually re-checks a non-healthy mount off-thread on its next tick.
 */
const HEALTHY_VERDICT_TTL_MS = 45_000;
const DEGRADED_VERDICT_TTL_MS = 5_000;


/**
 * Flap-debounce (producer-side, for the Stage-8 UI display verdict ONLY).
 * Chief-Designer spec: show degraded only after the mount has been non-healthy
 * for `DISPLAY_DEGRADE_AFTER_MS` OR `DISPLAY_DEGRADE_AFTER_SAMPLES` consecutive
 * non-healthy verdicts (whichever first); clear on the FIRST healthy verdict; and
 * a `DISPLAY_RESHOW_COOLDOWN_MS` cooldown after clearing before degraded can show
 * again, so a flapping mount doesn't strobe the badge.
 */
const DISPLAY_DEGRADE_AFTER_MS = 8_000;
const DISPLAY_DEGRADE_AFTER_SAMPLES = 2;
const DISPLAY_RESHOW_COOLDOWN_MS = 18_000;

interface CachedVerdict {
  verdict: CloudHealthVerdict;
  at: number;
}

/**
 * Per-target recovery/backoff/display bookkeeping. Kept separate from the raw
 * verdict cache so the hot-path `getCachedVerdict` read stays a single Map.get +
 * TTL check with no extra branching.
 */
interface RecoveryState {
  /**
   * The last verdict that came from an actual probe REPLY/TIMEOUT/DRAIN (never a
   * cold default). Used to detect a CONFIRMED `degraded|unknown → healthy`
   * transition without firing on cold-start `unknown`. `null` = no real verdict
   * observed yet for this target.
   */
  lastObservedVerdict: CloudHealthVerdict | null;
  // ── Display (flap-debounce) state ──
  /** What the debounced UI currently shows. */
  displayVerdict: CloudHealthVerdict;
  /** Count of consecutive non-healthy observed verdicts (resets on healthy). */
  consecutiveNonHealthy: number;
  /** When the current non-healthy streak began (for the time-based threshold). */
  nonHealthySince: number | null;
  /** Earliest time the display may flip back to degraded after a clear (cooldown). */
  displayReshowAllowedAt: number;
}

interface PendingProbe {
  /** Resolves the public `probeHealth` promise. Never rejects (total fn). */
  resolve: (verdict: CloudHealthVerdict) => void;
  /** Parent-side hard timeout that kills the child if the reply doesn't arrive. */
  timeoutId: NodeJS.Timeout;
  /** Target being probed, so we can write the cache + log on reply. */
  target: ReadlinkResolvedTarget;
}

interface ProbeReply {
  id: string;
  healthy: boolean;
}

/**
 * Resolve the worker JS path. Mirrors `embeddingService.getWorkerPath()` /
 * `preTurnWorkerService.getWorkerPath()` exactly:
 *  - packaged: `app.asar.unpacked/workers/cloudLivenessWorker.js` (a forked
 *    child needs a real on-disk path, not an asar entry);
 *  - dev: `__dirname/workers/...` then `out/main/workers/...` fallbacks.
 * Returns `null` if no candidate exists on disk → FAIL CLOSED (the caller keeps
 * the no-op `unknown` default registered, so callers exclude + retain).
 */
function resolveWorkerPath(): string | null {
  const config = getPlatformConfig();
  if (config.isPackaged) {
    const packaged = path.join(
      config.appPath.replace('app.asar', 'app.asar.unpacked'),
      'workers',
      'cloudLivenessWorker.js',
    );
    return fs.existsSync(packaged) ? packaged : null;
  }

  const candidates = [
    path.join(__dirname, 'workers', 'cloudLivenessWorker.js'),
    path.join(config.appPath, 'out', 'main', 'workers', 'cloudLivenessWorker.js'),
    path.join(process.cwd(), 'out', 'main', 'workers', 'cloudLivenessWorker.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Desktop child-process cloud-liveness prober. One instance per main process;
 * `setCloudLivenessProbe(new CloudLivenessProbeService())` wires it at bootstrap
 * (gated on `utilityProcess` availability — see index.ts).
 */
export class CloudLivenessProbeService implements CloudLivenessProbe {
  private worker: UtilityProcess | null = null;
  /** True once we've given up spawning (worker file missing). Permanent. */
  private spawnFailedPermanently = false;
  /** Earliest time we may respawn after a child death (backoff). */
  private respawnCooldownUntilMs = 0;
  private readonly cache = new Map<string, CachedVerdict>();
  /** In-flight probes keyed by correlation id (RS-F4 drain target). */
  private readonly pending = new Map<string, PendingProbe>();
  /** Per-target display/recovery state (Stage 3). */
  private readonly recovery = new Map<string, RecoveryState>();
  /** Whether to ask the child for a bounded readdir in addition to stat. */
  private readonly probeReaddir: boolean;
  private disposed = false;

  constructor(options: { probeReaddir?: boolean } = {}) {
    this.probeReaddir = options.probeReaddir ?? false;
  }

  /**
   * Synchronous cache read — hot-path safe (no I/O, no await, never throws).
   * Returns `unknown` when there's no fresh cached verdict. Expired entries are
   * treated as `unknown` (and lazily evicted) so the caller re-probes.
   */
  getCachedVerdict(target: ReadlinkResolvedTarget): CloudHealthVerdict {
    const cached = this.cache.get(target);
    if (!cached) return 'unknown';
    const ttl = cached.verdict === 'healthy' ? HEALTHY_VERDICT_TTL_MS : DEGRADED_VERDICT_TTL_MS;
    if (Date.now() - cached.at > ttl) {
      this.cache.delete(target);
      return 'unknown';
    }
    return cached.verdict;
  }

  /**
   * Synchronous cached verdict WITH freshness (Stage 4c / R5). Same TTL semantics
   * as {@link getCachedVerdict}, but also reports how long ago the verdict was
   * observed so a destructive caller (a cloud `watcher-unlink` removal) can require
   * a FRESH healthy verdict — a 40s-old healthy cache that predates a just-died
   * mount must NOT authorize wiping the index. No I/O, never throws. `unknown` /
   * expired ⇒ `ageMs:+Infinity`.
   */
  getCachedVerdictDetail(target: ReadlinkResolvedTarget): { verdict: CloudHealthVerdict; ageMs: number } {
    const cached = this.cache.get(target);
    if (!cached) return { verdict: 'unknown', ageMs: Number.POSITIVE_INFINITY };
    const ttl = cached.verdict === 'healthy' ? HEALTHY_VERDICT_TTL_MS : DEGRADED_VERDICT_TTL_MS;
    const ageMs = Date.now() - cached.at;
    if (ageMs > ttl) {
      this.cache.delete(target);
      return { verdict: 'unknown', ageMs: Number.POSITIVE_INFINITY };
    }
    return { verdict: cached.verdict, ageMs };
  }

  /**
   * Probe the target off-thread with a hard parent-side timeout. NEVER throws,
   * NEVER blocks the main event loop on a cloud syscall (the child does the
   * blocking op; we race it against a timer and SIGKILL on expiry). Resolves
   * `degraded` on timeout/crash/spawn-failure, `healthy`/`degraded` on a reply.
   */
  probeHealth(target: ReadlinkResolvedTarget): Promise<CloudHealthVerdict> {
    if (this.disposed) return Promise.resolve('degraded');

    // Permanent spawn failure (missing worker file) → fail closed forever. Record
    // the degraded verdict (so display/cache stay consistent). No re-probe loop to
    // self-terminate (the periodic re-walk scheduler owns re-probing now).
    if (this.spawnFailedPermanently) {
      this.recordObservedVerdict(target, 'degraded');
      return Promise.resolve('degraded');
    }

    // Respawn cooldown: a permanently-dead mount keeps killing the child; don't
    // respawn on every probe. Serve degraded until the cooldown elapses; the periodic
    // re-walk scheduler re-probes on its next tick once the mount may be back.
    if (Date.now() < this.respawnCooldownUntilMs && !this.worker) {
      this.recordObservedVerdict(target, 'degraded');
      return Promise.resolve('degraded');
    }

    const worker = this.ensureWorker();
    if (!worker) {
      // ensureWorker already recorded the failure mode (permanent or cooldown).
      // Record degraded (the periodic re-walk scheduler re-probes on its next tick).
      this.recordObservedVerdict(target, 'degraded');
      return Promise.resolve('degraded');
    }

    const id = crypto.randomUUID();
    return new Promise<CloudHealthVerdict>((resolve) => {
      const timeoutId = setTimeout(() => {
        // Reply didn't arrive in time → the child is wedged on a dead mount.
        // F1 (settle-race): the timeout IS the safety boundary, so settle THIS
        // probe degraded FIRST (deletes the id from `pending`, caches degraded,
        // resolves the public promise) and only THEN SIGKILL the child. A reply
        // that arrives in the kill→exit window now hits handleReply →
        // settlePending → empty `pending` → no-op (no late `healthy` cache write,
        // no double-resolve). The subsequent exit→drainPending is a safe no-op
        // for this already-removed id and still drains any OTHER pending probes.
        logger.warn(
          { redactedTargetHash: hashTarget(target), timeoutMs: PROBE_TIMEOUT_MS },
          'Cloud liveness probe timed out — killing child and respawning',
        );
        this.settlePending(id, 'degraded');
        this.killWorker('probe-timeout');
      }, PROBE_TIMEOUT_MS);
      // Don't let a pending probe keep the process alive.
      timeoutId.unref?.();

      this.pending.set(id, { resolve, timeoutId, target });

      try {
        worker.postMessage({ id, target, probeReaddir: this.probeReaddir });
      } catch (err) {
        // postMessage can throw if the child died between ensureWorker and now.
        // Resolve this probe degraded directly (it's still in `pending`).
        logger.warn({ err }, 'Cloud liveness probe postMessage failed');
        this.settlePending(id, 'degraded');
        this.killWorker('post-message-failed');
      }
    });
  }

  /**
   * Spawn the child lazily if needed. Returns the live worker, or null if it
   * couldn't be created (worker file missing → permanent; utilityProcess
   * unavailable → permanent). Caller maps null → degraded.
   */
  private ensureWorker(): UtilityProcess | null {
    if (this.worker) return this.worker;

    const electron = getElectronModule();
    if (!electron?.utilityProcess) {
      // Should not happen — index.ts only registers this service when
      // utilityProcess is available — but fail closed if it does.
      this.spawnFailedPermanently = true;
      logger.info('Cloud liveness prober disabled: utilityProcess unavailable');
      return null;
    }

    const workerPath = resolveWorkerPath();
    if (!workerPath) {
      // Worker file missing → fail closed PERMANENTLY (never a main-thread
      // blocking fallback; callers see degraded/unknown → exclude + retain).
      this.spawnFailedPermanently = true;
      logger.error('Cloud liveness worker file not found — prober disabled (fail-closed)');
      return null;
    }

    try {
      const worker = electron.utilityProcess.fork(workerPath, [], {
        serviceName: 'Cloud Liveness Worker',
        stdio: 'pipe',
      });

      // Drain stdout/stderr so the child can't deadlock on a full pipe. The
      // child has no logger, so this is only a safety net.
      worker.stdout?.on('data', (data: Buffer) => {
        const out = data.toString().trim();
        if (out) logger.debug({ source: 'cloud-liveness-worker-stdout' }, out);
      });
      worker.stderr?.on('data', (data: Buffer) => {
        const err = data.toString().trim();
        if (err) logger.warn({ source: 'cloud-liveness-worker-stderr' }, err);
      });

      // F2 (worker-identity guard): bind the originating worker so handlers can
      // ignore events from a STALE child. This matters on the kill()-throws path
      // (which clears this.worker immediately): the old child's late `exit` must
      // NOT clear a freshly-spawned worker or drain unrelated pending probes.
      worker.on('message', (raw: unknown) => this.handleReply(worker, raw));
      worker.on('exit', (code) => this.handleExit(worker, code));

      this.worker = worker;
      logger.info({ workerPath }, 'Cloud liveness worker spawned');
      return worker;
    } catch (err) {
      // Spawn threw — treat as a transient death (cooldown), not permanent. The
      // failure IS observed (logged + cooldown armed); recover by returning null
      // so the caller serves degraded rather than blocking.
      logger.warn({ err }, 'Failed to spawn cloud liveness worker');
      ignoreBestEffortCleanup(err, {
        operation: 'cloudLivenessProbeService.ensureWorker',
        reason: 'worker spawn failed; arm respawn cooldown and serve degraded',
        severity: 'warn',
      });
      this.respawnCooldownUntilMs = Date.now() + RESPAWN_COOLDOWN_MS;
      this.worker = null;
      return null;
    }
  }

  /** Handle a `{ id, healthy }` reply from the child. */
  private handleReply(worker: UtilityProcess, raw: unknown): void {
    // F2: ignore replies from a stale child (one we've already replaced). Its
    // pending ids are settled/drained already, so even without this guard the
    // reply would be a no-op — but dropping it early keeps the contract explicit.
    if (worker !== this.worker) return;
    const msg = raw as Partial<ProbeReply> | undefined;
    if (!msg || typeof msg.id !== 'string' || typeof msg.healthy !== 'boolean') {
      return;
    }
    this.settlePending(msg.id, msg.healthy ? 'healthy' : 'degraded');
  }

  /**
   * Handle child exit (crash, our own SIGKILL, or clean exit). Clears the
   * worker reference, arms the respawn cooldown, and RS-F4 drains every
   * remaining pending probe to `degraded`. handleExit is the single place all
   * pending probes get resolved on a death (killWorker delegates here via the
   * exit event).
   */
  private handleExit(worker: UtilityProcess, code: number | null): void {
    // F2: ignore a STALE child's exit. On the kill()-throws path we already
    // cleared this.worker + armed cooldown + drained pending; a late exit from
    // that dead child must NOT clear a freshly-spawned worker or re-drain. (On
    // the normal path this.worker is still this child, so the guard passes and
    // RS-F4 drains exactly once.)
    if (worker !== this.worker) return;
    if (!this.disposed) {
      logger.warn({ exitCode: code }, 'Cloud liveness worker exited — draining pending probes');
    }
    this.worker = null;
    // Arm backoff so a permanently-dead mount doesn't trigger a respawn storm.
    this.respawnCooldownUntilMs = Date.now() + RESPAWN_COOLDOWN_MS;
    this.drainPending('degraded');
  }

  /**
   * SIGKILL the child. The 'exit' handler does the actual pending-drain +
   * cooldown, so this is just the kill + reference clear. Safe to call when the
   * worker is already gone.
   */
  private killWorker(reason: string): void {
    const worker = this.worker;
    if (!worker) {
      // Already dead — make sure no probe leaks (defensive; exit drained it).
      this.drainPending('degraded');
      return;
    }
    logger.debug({ reason }, 'Killing cloud liveness worker');
    try {
      worker.kill();
      // Normal path: the 'exit' event fires async → handleExit drains pending +
      // arms cooldown. We do NOT drain here to avoid a double-drain.
    } catch (error) {
      // kill() threw (worker already a zombie/exited and the 'exit' event may
      // never fire). Fail safe: clear the reference, arm cooldown, and drain
      // pending HERE so a probe can never leak/hang waiting for an exit that
      // won't come (the F-find from self-review: the no-exit-after-kill leak).
      ignoreBestEffortCleanup(error, {
        operation: 'cloudLivenessProbeService.killWorker',
        reason: 'kill threw; drain pending defensively in case no exit event fires',
        severity: 'debug',
      });
      this.worker = null;
      this.respawnCooldownUntilMs = Date.now() + RESPAWN_COOLDOWN_MS;
      this.drainPending('degraded');
    }
  }

  /** Resolve one pending probe + cache the verdict; clears its timeout. */
  private settlePending(id: string, verdict: CloudHealthVerdict): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    this.pending.delete(id);
    this.recordObservedVerdict(pending.target, verdict);
    pending.resolve(verdict);
  }

  /** RS-F4: resolve EVERY in-flight probe with `verdict` and clear the map. */
  private drainPending(verdict: CloudHealthVerdict): void {
    if (this.pending.size === 0) return;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeoutId);
      this.recordObservedVerdict(pending.target, verdict);
      pending.resolve(verdict);
    }
    this.pending.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stage 3 — recovery / backoff / display / prewarm / invalidation
  // ─────────────────────────────────────────────────────────────────────────

  /** Get-or-create the per-target recovery state. */
  private recoveryStateFor(target: ReadlinkResolvedTarget): RecoveryState {
    let state = this.recovery.get(target);
    if (!state) {
      state = {
        lastObservedVerdict: null,
        displayVerdict: 'unknown',
        consecutiveNonHealthy: 0,
        nonHealthySince: null,
        displayReshowAllowedAt: 0,
      };
      this.recovery.set(target, state);
    }
    return state;
  }

  /**
   * The single funnel through which every REAL (probe reply / timeout / drain)
   * verdict flows. Writes the raw cache (the un-debounced truth admission/purge
   * read) and updates the flap-debounced DISPLAY verdict. The recovery/degrade
   * transition framing + per-target backoff re-probe were retired in S4.2 — the
   * cloud periodic re-walk scheduler (cloudPeriodicRewalkService) now re-probes ALL
   * cloud targets each tick and drives the recovery re-walk. Never blocks/throws.
   */
  private recordObservedVerdict(target: ReadlinkResolvedTarget, verdict: CloudHealthVerdict): void {
    // Raw cache first — this is the immediate truth `getCachedVerdict` returns.
    this.cache.set(target, { verdict, at: Date.now() });

    const state = this.recoveryStateFor(target);
    state.lastObservedVerdict = verdict;

    // Feed only the flap-debounced DISPLAY state (backs resolveSpaceSyncStatus).
    if (verdict === 'healthy') {
      this.updateDisplayOnHealthy(state);
    } else {
      this.updateDisplayOnNonHealthy(state);
    }
  }

  /** Flap-debounce: a healthy verdict clears the display + arms the reshow cooldown. */
  private updateDisplayOnHealthy(state: RecoveryState): void {
    state.consecutiveNonHealthy = 0;
    state.nonHealthySince = null;
    if (state.displayVerdict !== 'healthy') {
      state.displayVerdict = 'healthy';
      // After clearing, don't let a single flap re-show degraded immediately.
      state.displayReshowAllowedAt = Date.now() + DISPLAY_RESHOW_COOLDOWN_MS;
    }
  }

  /**
   * Flap-debounce: a non-healthy verdict only flips the display to degraded once
   * the streak crosses BOTH the cooldown gate AND (time-OR-samples) threshold.
   */
  private updateDisplayOnNonHealthy(state: RecoveryState): void {
    const now = Date.now();
    state.consecutiveNonHealthy += 1;
    if (state.nonHealthySince === null) state.nonHealthySince = now;

    if (state.displayVerdict === 'degraded') return; // already showing
    if (now < state.displayReshowAllowedAt) return; // cooldown after a recent clear

    const longEnough = now - state.nonHealthySince >= DISPLAY_DEGRADE_AFTER_MS;
    const enoughSamples = state.consecutiveNonHealthy >= DISPLAY_DEGRADE_AFTER_SAMPLES;
    if (longEnough || enoughSamples) {
      state.displayVerdict = 'degraded';
    }
  }

  /**
   * Stable, flap-debounced verdict for the Stage-8 UI. DISTINCT from the raw
   * `getCachedVerdict` (which admission/purge read for the immediate truth): this
   * one suppresses transient blips per the Chief-Designer spec. Sync, no I/O,
   * never throws. `unknown` until a real verdict has been observed.
   */
  getDisplayVerdict(target: ReadlinkResolvedTarget): CloudHealthVerdict {
    const state = this.recovery.get(target);
    if (!state) return 'unknown';
    // Read-time evaluation of the TIME-based degrade threshold (S4.2 B1). The display
    // flip to 'degraded' used to be advanced by `scheduleReprobe`'s repeated degraded
    // samples re-calling `updateDisplayOnNonHealthy`; that per-target backoff re-probe
    // is retired in S4.2 and the periodic re-walk tick probes only every ~5 min.
    // Evaluating the `DISPLAY_DEGRADE_AFTER_MS` threshold HERE keeps the ~8s
    // "Reconnecting" settle without re-introducing any timer — `resolveSpaceSyncStatus`
    // reads this PULL-based (no interval/broadcast), so a degraded mount surfaces within
    // 8s of the next read. Pure: compute, never mutate (the next observed verdict still
    // drives the state machine + the reshow cooldown). The cooldown (`displayReshowAllowedAt`)
    // and the "already showing / still healthy" cases are respected exactly as the
    // sample-driven path does.
    if (
      state.displayVerdict !== 'degraded' &&
      state.nonHealthySince !== null &&
      Date.now() >= state.displayReshowAllowedAt &&
      Date.now() - state.nonHealthySince >= DISPLAY_DEGRADE_AFTER_MS
    ) {
      return 'degraded';
    }
    return state.displayVerdict;
  }

  /**
   * Cold-start prewarm (DA-2): probe every known cloud-space target off-thread so
   * the verdict cache is populated within ONE launch — a healthy Drive must not
   * stay dark (`unknown`/excluded) until the next launch. Fire-and-forget; never
   * blocks/awaits the caller (boot must not wait on this). Each probe goes through
   * the child process; a dead mount just resolves `degraded` (the periodic re-walk
   * scheduler re-probes it on its next tick). Safe to call with an empty list /
   * after dispose.
   */
  prewarm(targets: readonly ReadlinkResolvedTarget[]): void {
    if (this.disposed || targets.length === 0) return;
    logger.info({ count: targets.length }, 'Cloud liveness prewarm: probing known cloud spaces');
    for (const target of targets) {
      // Fire-and-forget: probeHealth never throws, and the result flows into the
      // cache + recovery state via recordObservedVerdict.
      fireAndForget(this.probeHealth(target), 'cloudLivenessProbeService.prewarm');
    }
  }

  /**
   * Event-driven invalidation: drop the cached verdict for a target and kick an
   * immediate off-thread re-probe. Hooked to workspace re-scan + watcher error
   * (see index.ts). The raw cache read returns `unknown` until the fresh probe
   * settles (exclude + retain in the meantime). No-op after dispose.
   */
  invalidateVerdict(target: ReadlinkResolvedTarget): void {
    if (this.disposed) return;
    this.cache.delete(target);
    fireAndForget(this.probeHealth(target), 'cloudLivenessProbeService.invalidateVerdict');
  }

  /**
   * Tear down: kill the child, drain pending, drop per-target state, stop accepting
   * probes. Idempotent. Wired to `app.on('will-quit')` in index.ts on the RETAINED
   * instance so the child process is torn down (no orphaned child).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.recovery.clear();
    this.killWorker('dispose');
    this.drainPending('degraded');
    this.cache.clear();
  }

  /** Test-only diagnostics. */
  _debugState(): {
    hasWorker: boolean;
    pendingCount: number;
    cacheSize: number;
    spawnFailedPermanently: boolean;
    inCooldown: boolean;
    recoveryCount: number;
  } {
    return {
      hasWorker: this.worker !== null,
      pendingCount: this.pending.size,
      cacheSize: this.cache.size,
      spawnFailedPermanently: this.spawnFailedPermanently,
      inCooldown: Date.now() < this.respawnCooldownUntilMs,
      recoveryCount: this.recovery.size,
    };
  }

  /** Test-only: per-target display/verdict state inspection. */
  _debugRecoveryState(target: ReadlinkResolvedTarget): {
    lastObservedVerdict: CloudHealthVerdict | null;
    displayVerdict: CloudHealthVerdict;
    consecutiveNonHealthy: number;
  } | null {
    const state = this.recovery.get(target);
    if (!state) return null;
    return {
      lastObservedVerdict: state.lastObservedVerdict,
      displayVerdict: state.displayVerdict,
      consecutiveNonHealthy: state.consecutiveNonHealthy,
    };
  }
}

/**
 * Hash a target path for logging so we never leak an email-bearing CloudStorage
 * path (e.g. `~/Library/CloudStorage/GoogleDrive-<email>/…`) into logs. PLAN
 * "PII-in-logs" constraint.
 */
function hashTarget(target: string): string {
  return crypto.createHash('sha256').update(target).digest('hex').slice(0, 12);
}

/**
 * Cold-start prewarm target derivation (DA-2). Derive the cloud-mount targets to
 * probe at cold start, **WITHOUT any main-thread blocking filesystem call on a
 * cloud-classified path** (Stage-3 refinement F2).
 *
 * THE F2 INVARIANT: the previous implementation `readdirSync`'d the workspace root
 * to enumerate symlinks. But a real user's `coreDirectory` can itself be a
 * cloud-classified path (PLAN line 67: `~/.../Dropbox/...`, or set under
 * `~/Library/CloudStorage/<Provider>-<Account>/…`, a network-backed FUSE mount).
 * A bare `readdirSync` there blocks the main thread unbounded in the kernel — the
 * exact libuv-pool hang this whole plan exists to kill, fired 8s post-boot.
 *
 * So we DO NOT enumerate the root via the filesystem. The candidate symlink LINK
 * paths come FS-FREE from settings `spaces` (`isSymlink` spaces). Target derivation
 * then splits on whether the WORKSPACE ROOT is itself cloud-classified:
 *
 *  - LOCAL ROOT (the common case): walk the chain with
 *    `walkToFirstCloudHopViaReadlink` via {@link mintFirstCloudHopTargetSync} —
 *    `readlinkSync` ONLY, reads the LINK's own inode (which lives in the LOCAL
 *    workspace dir / a LOCAL alias dir), never `realpath`/`stat`/`access` and never
 *    `readlinkSync` PAST a cloud hop. Stops AT the first cloud hop and returns THAT
 *    target — the path we want the OFF-THREAD prober to check. Chained-alias safe
 *    (F1): `workspace/link → ~/DriveAlias → ~/Library/CloudStorage/GoogleDrive-…`
 *    resolves to the Drive hop, not silently dropped. DEAD-mount targets ARE
 *    returned — we WANT to probe them so they get a `degraded` verdict + recovery.
 *
 *  - CLOUD ROOT (the fix; PLAN Stage 2): the link inode itself lives IN the cloud
 *    root, so even a `readlinkSync` on it could block a dead FUSE mount. So we do
 *    NOT readlink here — we mint the probe target from the cached `space.sourcePath`
 *    via {@link mintCloudHopTargetFromKnownCloudPath}, a PURE STRING read of
 *    in-memory settings (ZERO filesystem I/O). Eligible only when `sourcePath` is
 *    an absolute cloud path; otherwise that one space is skipped (never a readlink
 *    under a possibly-dead root). The OLD behaviour skipped prewarm ENTIRELY under a
 *    cloud root, which left healthy cloud-symlinked Spaces permanently `unknown` →
 *    never admitted → rendered empty (the bug this stage fixes).
 *
 * Note: on ANY `coreDirectory`, the main thread issues NO `readdir`/`stat`/`access`
 * on a cloud mount, and NO `readlink` against a cloud-classified ROOT — the
 * main-thread-never-blocks invariant holds by construction.
 *
 * Keying: BOTH paths mint via helpers that yield a byte-identical key to what the
 * descent mints from the live link — the local path via the SAME readlink walker,
 * the cloud path via the cached `sourcePath` (which, for a direct cloud symlink, IS
 * the raw absolute readlink target the walker returns verbatim) — so the
 * prewarm-populated verdict is read back under the same key by construction.
 *
 * @param coreDirectory absolute workspace root — used ONLY for `path.join` of
 *   relative space paths (no filesystem touch).
 * @param spaces the configured spaces from settings (FS-free source of truth for
 *   which workspace entries are symlinks). `undefined`/empty → no targets.
 */
export function deriveCloudPrewarmTargets(
  coreDirectory: string,
  spaces: readonly SpaceConfig[] | undefined,
): ReadlinkResolvedTarget[] {
  const targets: ReadlinkResolvedTarget[] = [];
  if (!spaces || spaces.length === 0) return targets;

  // Whether the workspace root is itself a cloud-classified path (a real user can
  // set the workspace root under `/Dropbox/` or `~/Library/CloudStorage/…`).
  // `detectCloudStorage` is a pure-string match — no filesystem touch.
  const rootIsCloud = detectCloudStorage(coreDirectory).isCloud;

  const seen = new Set<string>();
  let cloudRootDerivedCount = 0;
  let cloudRootSkippedCount = 0;
  for (const space of spaces) {
    if (!space.isSymlink) continue; // only spaces reached via symlink

    // The link lives at `coreDirectory/space.path`. Pure string join — no filesystem
    // touch on `coreDirectory` even if it is itself cloud-classified.
    const linkPath = path.isAbsolute(space.path)
      ? space.path
      : path.join(coreDirectory, space.path);
    // Cloud-root-safe verdict-key mint — the SINGLE source shared with containment
    // (`configureCloudSpaceContainment`) and admission (`resolveCloudSymlinkAdmission`).
    //  - cloud root: ZERO I/O from the cached `space.sourcePath` (the OLD behaviour
    //    skipped prewarm ENTIRELY here, leaving healthy cloud Spaces permanently
    //    `unknown` → never admitted → rendered empty — the bug this subsystem fixes).
    //    KEY-EQUIVALENCE with the live-link mint holds for a DIRECT absolute cloud
    //    symlink, so the seeded verdict reads back under the same key at admission.
    //  - local root: the full-fidelity readlink walk (chained-local-alias aware),
    //    safe because a live local dir never blocks reading link inodes.
    // null → genuinely-local / unclassifiable space, or (under a cloud root) no
    // usable cached cloud `sourcePath` → skip (never a readlink under a possibly-dead
    // root).
    const target = mintCloudHopTargetCloudRootSafe({
      linkPath,
      sourcePath: space.sourcePath,
      rootIsCloud,
    });
    if (target === null) {
      if (rootIsCloud) {
        cloudRootSkippedCount += 1;
        logger.debug(
          { spacePath: space.path },
          'Cloud liveness prewarm: skipping space under a cloud-classified root (no usable cached absolute cloud sourcePath; no readlink performed)',
        );
      }
      continue;
    }
    if (seen.has(target)) continue; // de-dupe (two spaces under one Drive root)
    seen.add(target);
    targets.push(target);
    if (rootIsCloud) cloudRootDerivedCount += 1;
  }

  if (rootIsCloud && cloudRootDerivedCount > 0) {
    logger.debug(
      { derived: cloudRootDerivedCount, skipped: cloudRootSkippedCount },
      'Cloud liveness prewarm: derived cloud probe targets from cached sourcePath under a cloud-classified workspace root (zero-I/O)',
    );
  }

  return targets;
}

/**
 * A zero-I/O snapshot of cloud-Space INDEXING COVERAGE — how many cloud Spaces the
 * session discovered vs how many actually became admissible (a `healthy` verdict).
 *
 * This is the observability the original "empty cloud Spaces" incident lacked: it was
 * silent for 3 days because the only signal was an UNWATCHED debug log. The snapshot
 * makes the discovered≫admitted gap a first-class, alertable signal (postmortem #3).
 */
export interface CloudIndexingCoverageSnapshot {
  /**
   * N — definite cloud Spaces, counted ZERO-I/O: a symlink space whose cached
   * `sourcePath` is an absolute cloud path. Unambiguous (no readlink), so N>0 means
   * "the user genuinely has cloud Spaces configured" with no false positives.
   */
  readonly cloudSpacesConfigured: number;
  /**
   * M — probe targets we could DERIVE (`deriveCloudPrewarmTargets`). M<N reveals the
   * stale/missing/relative/chained-`sourcePath` population the zero-I/O fast path
   * can't key (those Spaces can never warm to `healthy` under a cloud root).
   */
  readonly probeTargetsDerived: number;
  /**
   * K — of the M derived targets, how many currently hold a `healthy` cached verdict
   * (i.e. would be ADMITTED at descent). K is the "actually working" count.
   */
  readonly healthyTargets: number;
  /**
   * The alert condition: the user HAS cloud Spaces (N>0) or we derived targets (M>0),
   * but NONE are healthy/admissible (K===0) — i.e. discovered-but-not-indexed, the
   * exact silent failure mode of the original incident.
   */
  readonly shouldAlert: boolean;
}

/**
 * Compute a {@link CloudIndexingCoverageSnapshot}. Intended to run ONCE per session,
 * after the cold-start prewarm + a settle window, so a `shouldAlert` snapshot means
 * "warm-up finished and the user's cloud Spaces still aren't indexable". I/O is the
 * same as `deriveCloudPrewarmTargets`: zero under a cloud root (sourcePath strings),
 * safe local readlinks under a local root — never a readlink under a dead cloud root.
 *
 * `getCachedVerdict` is injected (rather than reaching for the singleton) so the
 * coverage logic is unit-testable without wiring a prober.
 *
 * LIMITATION (S1 review F2): `healthyTargets` counts targets keyed the way PREWARM
 * keys them (under a cloud root, from `sourcePath`); admission reads the LIVE-link key.
 * For a DIRECT absolute cloud symlink these are byte-identical, but a stale / case-only
 * / trailing-slash-divergent `sourcePath` could make `K>0` here while admission keys
 * elsewhere and skips — a coverage false-negative. The alert still reliably catches the
 * COMMON failure (the original incident: every verdict `unknown` ⇒ K=0 ⇒ alert). Exact
 * admission-fidelity would require the live readlink this path deliberately avoids.
 */
export function computeCloudIndexingCoverage(
  coreDirectory: string,
  spaces: readonly SpaceConfig[] | undefined,
  getCachedVerdict: (target: ReadlinkResolvedTarget) => CloudHealthVerdict,
): CloudIndexingCoverageSnapshot {
  const cloudSpacesConfigured = (spaces ?? []).filter(
    (space) =>
      space.isSymlink &&
      typeof space.sourcePath === 'string' &&
      detectCloudStorage(space.sourcePath).isCloud,
  ).length;

  const targets = deriveCloudPrewarmTargets(coreDirectory, spaces);
  const healthyTargets = targets.filter((target) => getCachedVerdict(target) === 'healthy').length;

  const shouldAlert =
    (cloudSpacesConfigured > 0 || targets.length > 0) && healthyTargets === 0;

  return {
    cloudSpacesConfigured,
    probeTargetsDerived: targets.length,
    healthyTargets,
    shouldAlert,
  };
}
