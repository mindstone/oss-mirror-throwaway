/**
 * cloudLivenessProbe — `@core` boundary interface for deciding whether a
 * cloud-storage–backed symlink target is currently HEALTHY, without ever issuing
 * an unbounded blocking syscall against the (possibly dead) mount on the main
 * thread.
 *
 * The desktop implementation (Stage 2) owns a long-lived child PROCESS that does
 * all cloud-mount filesystem probing, with the per-probe timeout + kill-and-
 * respawn living in the PARENT — the only mechanism the Stage-0 spike proved
 * actually isolates a wedged syscall (worker_threads share the global libuv pool
 * and are un-killable when blocked). Cloud/mobile have no FUSE mounts, so they
 * keep the no-op default forever.
 *
 * This Stage-1 file is the CONTRACT ONLY: the interface, a module-singleton
 * setter/getter (mirroring `broadcastService.ts` / `errorReporter.ts`), and a
 * default `unknown`-returning no-op probe installed AT MODULE IMPORT. No probing
 * engine, no process spawn, no consumer wiring — inert by construction
 * (default `unknown` == today's behaviour: nothing admitted, nothing purged).
 *
 * RS-F5 (critical, the deliberate difference from broadcastService/errorReporter):
 * the consult is a TOTAL function. `broadcastService` THROWS when unwired; here a
 * throw on the hot descent/purge path could be caught upstream and wrongly
 * default to admit/purge — re-opening the hang and the index-wipe. So
 * `getCloudLivenessProbe()` ALWAYS returns a usable probe, and both
 * `getCachedVerdict` and `probeHealth` are wrapped so ANY internal error
 * resolves/returns `'unknown'`. `unknown` ⇒ callers exclude + retain
 * (fail-closed both ways).
 *
 * No `electron` import; safe in `src/core/`.
 */
import type { ReadlinkResolvedTarget } from '@core/services/cloudLivenessProbe.types';

export type { ReadlinkResolvedTarget } from '@core/services/cloudLivenessProbe.types';

/**
 * Health of a cloud-storage mount behind a workspace symlink.
 *
 * - `healthy`  — the mount answered a bounded probe at local-disk latency;
 *   safe to admit to walk/watch/index.
 * - `degraded` — the mount timed out / errored / is flapping; SKIP admission,
 *   RETAIN the last-known index, surface a degraded signal, auto-retry.
 * - `unknown`  — no verdict yet (cold start / no prober wired / probe errored).
 *   Treated identically to `degraded` for gating purposes (exclude + retain),
 *   but distinguishable for telemetry/UI ("reconnecting" vs "not checked yet").
 */
export type CloudHealthVerdict = 'healthy' | 'degraded' | 'unknown';

/**
 * A cached verdict plus its freshness — for callers that must distinguish a
 * fresh-healthy verdict from a stale-but-not-yet-expired one (Stage 4c / R5: a
 * destructive `watcher-unlink` removal requires a FRESH healthy verdict, not a
 * 40s-old healthy cache that predates a just-died mount).
 *
 * `ageMs` is how long ago the verdict was observed (`Number.POSITIVE_INFINITY`
 * when there is no cached verdict / it is `unknown`). Never blocks, never throws.
 */
export interface CloudHealthVerdictDetail {
  readonly verdict: CloudHealthVerdict;
  /** ms since the verdict was observed; `+Infinity` when unknown / uncached. */
  readonly ageMs: number;
}

/**
 * The cloud-liveness probe seam every consumer (Stage 4 coordinator, Stage 6
 * descent, Stage 8 producer) calls.
 *
 * Targets are {@link ReadlinkResolvedTarget} — minted readlink-only — so a
 * consumer physically cannot pass a path it obtained by `realpath`-ing a dead
 * mount (that dereference is the hang). See cloudLivenessProbe.types.ts.
 */
export interface CloudLivenessProbe {
  /**
   * Asynchronously probe the target's current health. MUST never throw and never
   * block the caller's event loop on a cloud syscall (the desktop impl delegates
   * to the child process; the no-op resolves immediately). On timeout/crash the
   * impl resolves `degraded`/`unknown`, never rejects.
   */
  probeHealth(target: ReadlinkResolvedTarget): Promise<CloudHealthVerdict>;
  /**
   * Synchronous read of the last cached verdict for the target — for HOT paths
   * (the chokidar matcher, `safeWalkDirectory`) that must NOT await. Returns
   * `unknown` when there's no cached verdict. MUST never throw and MUST do no
   * I/O.
   */
  getCachedVerdict(target: ReadlinkResolvedTarget): CloudHealthVerdict;
  /**
   * Synchronous read of the cached verdict WITH its freshness (Stage 4c / R5).
   * OPTIONAL: an impl that omits it gets a fallback (`{ verdict, ageMs:+Infinity }`)
   * from the totality wrapper, so a destructive caller that requires freshness
   * fails CLOSED (treats it as stale → retain) when the impl can't report age.
   * MUST never throw and MUST do no I/O.
   */
  getCachedVerdictDetail?(target: ReadlinkResolvedTarget): CloudHealthVerdictDetail;
  /**
   * Synchronous read of the FLAP-DEBOUNCED display verdict (Stage 8 UI producer).
   * DISTINCT from `getCachedVerdict` (the immediate raw truth admission/purge
   * read): this one suppresses transient blips per the Chief-Designer spec
   * (show degraded only after a settle window, clear on the first healthy verdict,
   * cooldown before re-showing) so the per-space "Reconnecting" badge/banner does
   * NOT strobe on a 2-second mount blip. OPTIONAL: an impl that omits it gets a
   * fallback to `getCachedVerdict` from the totality wrapper. MUST never throw and
   * MUST do no I/O. Cloud/mobile keep the no-op default (`unknown` ⇒ no signal).
   */
  getDisplayVerdict?(target: ReadlinkResolvedTarget): CloudHealthVerdict;
}

/**
 * Default probe: `unknown` for everything, zero I/O. Installed at module import
 * so the seam is ALWAYS usable. `unknown` == today's behaviour (exclude all
 * cloud, retain all index entries), so importing this module changes nothing.
 */
const _noopProbe: CloudLivenessProbe = {
  probeHealth: async () => 'unknown',
  getCachedVerdict: () => 'unknown',
};

/**
 * The probe `getCloudLivenessProbe()` hands back: every method is TOTAL, and
 * `getCachedVerdictDetail` is GUARANTEED present (the wrapper synthesises it from
 * `getCachedVerdict` when the impl omits it), so freshness-requiring callers
 * (Stage 4c / R5) can always call it.
 */
export interface TotalCloudLivenessProbe extends CloudLivenessProbe {
  getCachedVerdictDetail(target: ReadlinkResolvedTarget): CloudHealthVerdictDetail;
  getDisplayVerdict(target: ReadlinkResolvedTarget): CloudHealthVerdict;
}

/**
 * Wraps any probe so the consult is a TOTAL function (RS-F5): any thrown error or
 * rejected promise from the underlying impl collapses to `'unknown'`
 * (exclude + retain) rather than escaping to a caller that might default to
 * admit/purge. Also guarantees `getCachedVerdictDetail` is present: an impl that
 * omits it (or whose `getCachedVerdictDetail` throws) gets a fail-closed
 * `{ verdict, ageMs:+Infinity }` derived from `getCachedVerdict` — so a
 * freshness-requiring caller treats the verdict as STALE and retains.
 */
function makeTotal(probe: CloudLivenessProbe): TotalCloudLivenessProbe {
  return {
    async probeHealth(target: ReadlinkResolvedTarget): Promise<CloudHealthVerdict> {
      try {
        return await probe.probeHealth(target);
      } catch {
        // A probe must never throw on the hot path — collapse to the
        // fail-closed verdict. Deliberately silent: this is the safety net for
        // a misbehaving impl, not a swallowed business error.
        return 'unknown';
      }
    },
    getCachedVerdict(target: ReadlinkResolvedTarget): CloudHealthVerdict {
      try {
        return probe.getCachedVerdict(target);
      } catch {
        return 'unknown';
      }
    },
    getCachedVerdictDetail(target: ReadlinkResolvedTarget): CloudHealthVerdictDetail {
      try {
        if (probe.getCachedVerdictDetail) {
          return probe.getCachedVerdictDetail(target);
        }
        // Impl doesn't report age → fail closed: a known verdict with UNKNOWN
        // age is treated as stale (+Infinity) by freshness-requiring callers.
        // `unknown` keeps `+Infinity` (no fresh evidence) which is also correct.
        return { verdict: probe.getCachedVerdict(target), ageMs: Number.POSITIVE_INFINITY };
      } catch {
        return { verdict: 'unknown', ageMs: Number.POSITIVE_INFINITY };
      }
    },
    getDisplayVerdict(target: ReadlinkResolvedTarget): CloudHealthVerdict {
      try {
        if (probe.getDisplayVerdict) {
          return probe.getDisplayVerdict(target);
        }
        // Impl doesn't debounce a display verdict → fall back to the raw cached
        // verdict. The UI consumer maps degraded/unknown → "reconnecting" either
        // way; the only loss is flap-suppression (an impl without a display
        // verdict has no flap state to suppress anyway).
        return probe.getCachedVerdict(target);
      } catch {
        return 'unknown';
      }
    },
  };
}

// Installed at module import (NOT lazy) so `getCloudLivenessProbe()` can never
// return undefined and the consult can never throw. Already total (the no-op
// can't throw), but wrapped uniformly so the invariant holds regardless of impl.
let _probe: TotalCloudLivenessProbe = makeTotal(_noopProbe);

/**
 * Wire the host's concrete probe (desktop child-process impl at bootstrap). The
 * probe is wrapped to guarantee totality, so the host impl does not itself have
 * to be defensive about throwing.
 */
export function setCloudLivenessProbe(probe: CloudLivenessProbe): void {
  _probe = makeTotal(probe);
}

/**
 * Get the active probe. ALWAYS returns a usable, total probe — the default no-op
 * is installed at import, so this never throws and never returns undefined
 * (contrast `getBroadcastService`, which throws when unwired). See RS-F5.
 */
export function getCloudLivenessProbe(): TotalCloudLivenessProbe {
  return _probe;
}

/**
 * Test-only: restore the default `unknown` no-op probe. Lets a test that wired a
 * stub probe reset module state between cases.
 */
export function __resetCloudLivenessProbeForTesting(): void {
  _probe = makeTotal(_noopProbe);
}
