/**
 * libuv threadpool sizing — a BUFFER against shared-pool exhaustion, not a fix.
 *
 * ## Why this exists (root cause)
 * Node's libuv threadpool (default `UV_THREADPOOL_SIZE` = 4) is shared by async
 * `fs` ops, `crypto`, `zlib`, and `dns.lookup`/getaddrinfo. A chronically
 * unresponsive cloud-storage FUSE mount (dead Google Drive File Stream) produces
 * `stat`/`readdir`/`realpath` syscalls that block in the kernel with NO timeout —
 * just 4 of them park ALL 4 pool threads. Then the agent turn's own pre-dispatch
 * fs reads (and DNS) queue forever behind them and the turn hangs without ever
 * reaching the model. See docs/plans/260619_turn-hang-bugmode/PLAN.md (the
 * "turn never sends to the models" incident) and the DNS-starvation lineage in
 * `@core/utils/dnsThreadpoolDecouple`.
 *
 * ## What raising the pool does — and does NOT do
 * A bigger pool means a few dead-mount syscalls no longer consume the ENTIRE
 * pool, so a turn's fs/DNS work still has live threads to run on. This is a
 * BUFFER / blast-radius reducer, NOT a cure: a sufficiently broken mount with
 * enough parked syscalls can still exhaust any finite pool. The real fixes are
 * keeping the watcher out of cloud mounts (Stage 4a) and the pre-dispatch
 * liveness guard (Stage 2). This buffer just raises the bar so the turn-path
 * usually wins the race in the first place.
 *
 * ## CRITICAL — WHERE this value must be applied
 * libuv creates the threadpool lazily on the FIRST async threadpool op and reads
 * `UV_THREADPOOL_SIZE` exactly ONCE at that moment (uv_once). Setting
 * `process.env.UV_THREADPOOL_SIZE` AFTER the pool exists is a silent no-op for
 * the rest of the process lifetime. Therefore the env var MUST be set before the
 * first async fs / `dns.lookup` / async crypto call — in practice, at the very
 * top of the bundled main entry, before `installGracefulFs` (the first fs touch).
 * Empirically verified on Electron 42 / Node 22 that the pool is NOT yet
 * initialised when the main entry's first JS line runs, so a first-line
 * `process.env` set DOES grow the pool (no relaunch required). See
 * `applyThreadpoolSizeBuffer` and its desktop wrapper for the wiring.
 *
 * Pure (no I/O, no env mutation) so it is unit-testable in isolation; the
 * env-mutation + apply-once logic lives in `applyThreadpoolSizeBuffer`.
 */

/**
 * Floor: never run with fewer than this many pool threads once we intervene.
 *
 * Anchored to PARKED-SYSCALL HEADROOM, not CPU parallelism (GPT review F1). The
 * threads we are buffering against are sleeping in blocked dead-mount I/O, so a
 * 4-core machine with a dead Drive mount needs the SAME minimum as an 8-core one
 * — CPU count is irrelevant to how many syscalls a dead FileProvider mount parks.
 * A Mindstone employee's diagnostics (a recent beta build) showed **9 cloud
 * symlinks** directly under the coreDirectory, each realpath'd-then-parked by readdirp's `_getEntryType`
 * BEFORE our ignore matcher runs (chokidar 3.6.0 / readdirp 3.6.0 index.js:209,
 * confirmed by source read — there is no clean config hook to skip it). With the
 * default pool of 4, 9 parked syscalls wedge the turn's own fs/DNS. The floor
 * MUST exceed a realistic cloud-symlink count on EVERY machine, regardless of
 * core count. DNS now rides the libuv pool by default too, so the floor also
 * needs room for `dns.lookup` under load after those parked syscalls are already
 * occupying workers. 32 leaves that baseline headroom for both dead-mount I/O
 * and on-pool DNS.
 */
export const THREADPOOL_SIZE_FLOOR = 32;
/**
 * Cap: bound many-core machines while giving DNS-under-load real headroom.
 * After the Stage 3 resolver flip, `dns.lookup` uses the libuv pool by default;
 * the original DNS-starvation repro needed `UV_THREADPOOL_SIZE=64` to keep
 * lookup latency flat under heavy load in the 260621 provider-transport-resolver
 * spike. 64 is therefore the evidence-based safe ceiling, not idle excess.
 *
 * The main downside of a larger pool — letting more dead-mount syscalls park
 * before backpressure — is mitigated by the cloud-symlink scan-skip drain that
 * already landed on dev. Memory cost is about 1MB per mostly-idle native stack
 * (≈64MB worst case on a many-core box), negligible for the protection.
 *
 * (For reference, libuv historically caps `UV_THREADPOOL_SIZE` at 1024 and clamps
 * anything above that itself — we never approach it, but a future tuner should not
 * pick a value libuv would silently reject.)
 */
export const THREADPOOL_SIZE_CAP = 64;

/**
 * Compute the desired pool size given the machine's available parallelism.
 *
 * Scales as `parallelism * 2` (a dead mount can park MANY threads, and DNS now
 * shares the same pool) then clamps to `[FLOOR 32, CAP 64]`. The
 * FLOOR is the load-bearing part: it must exceed a realistic cloud-symlink count
 * (a Mindstone employee's field count of 9) on EVERY machine, including small ones, because parked-syscall count
 * is independent of CPU count. A non-finite or non-positive input falls back to
 * the floor.
 */
export function computeThreadpoolSize(availableParallelism: number): number {
  if (!Number.isFinite(availableParallelism) || availableParallelism <= 0) {
    return THREADPOOL_SIZE_FLOOR;
  }
  const scaled = Math.round(availableParallelism) * 2;
  return Math.min(THREADPOOL_SIZE_CAP, Math.max(THREADPOOL_SIZE_FLOOR, scaled));
}

export interface ThreadpoolBufferDecision {
  /** Whether we (re)set the env var. */
  readonly applied: boolean;
  /** The value now in `UV_THREADPOOL_SIZE` (string), or the existing one. */
  readonly value: string;
  /** Human-readable reason, for the boot log. */
  readonly reason:
    | 'set-from-default'
    | 'kept-existing-larger'
    | 'raised-existing-smaller'
    | 'raised-existing-unparseable';
}

/**
 * Decide what `UV_THREADPOOL_SIZE` should be, honouring an operator override.
 *
 * - Unset → set to `desired`.
 * - Set to a parseable number ≥ `desired` → keep it (operator/power-user chose a
 *   bigger pool; never shrink it).
 * - Set to a parseable number < `desired` → raise to `desired` (an old/forgotten
 *   small value shouldn't undercut the buffer).
 * - Set to an UNPARSEABLE / non-positive value → raise to `desired` (GPT review
 *   F5). libuv only accepts a positive integer; a garbage value (`auto`, `0`,
 *   `-1`, …) makes libuv silently fall back to the default 4 — i.e. the buffer
 *   would NOT exist. Since `UV_THREADPOOL_SIZE` is documented as numeric-only,
 *   a non-numeric value can't be a meaningful intentional override, so we replace
 *   it with the working buffer rather than preserve a silent no-op.
 *
 * Pure decision function: takes the current env value, returns what to do. The
 * caller performs the actual `process.env` mutation (see `applyThreadpoolSizeAtBoot`).
 */
export function decideThreadpoolBuffer(
  currentEnvValue: string | undefined,
  desired: number,
): ThreadpoolBufferDecision {
  const desiredStr = String(desired);
  if (currentEnvValue === undefined || currentEnvValue.trim() === '') {
    return { applied: true, value: desiredStr, reason: 'set-from-default' };
  }
  const parsed = Number.parseInt(currentEnvValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // Garbage / non-positive → libuv would default to 4 (silent no-op buffer).
    // Replace with the working value rather than preserve a dead override.
    return { applied: true, value: desiredStr, reason: 'raised-existing-unparseable' };
  }
  if (parsed >= desired) {
    return { applied: false, value: currentEnvValue, reason: 'kept-existing-larger' };
  }
  return { applied: true, value: desiredStr, reason: 'raised-existing-smaller' };
}

/**
 * A read-back snapshot of the threadpool-buffer state, for the boot breadcrumb /
 * on-demand diagnostics. PURE read of `process.env.UV_THREADPOOL_SIZE` (already
 * applied at boot) plus the freshly-recomputed desired value — never mutates
 * env (the apply already happened first-thing in `applyThreadpoolSize`).
 *
 * GPT review F1 (Stage 4b): the source-order test proves the env var is SET
 * before the first pool op, but it cannot prove the EMITTED bundle preserved
 * that order — a bundler reorder would make the buffer a silent prod no-op. This
 * snapshot lets boot emit the value libuv will actually read, so field
 * diagnostics show whether the buffer was applied without a per-boot saturation
 * probe (too heavy for the hot startup path).
 */
export interface ThreadpoolBufferSnapshot {
  /** The value libuv will read (current `UV_THREADPOOL_SIZE`), parsed; `null` if unset/garbage → libuv default 4. */
  readonly effectiveSize: number | null;
  /** Raw `process.env.UV_THREADPOOL_SIZE` string (or `undefined` if unset). */
  readonly rawEnvValue: string | undefined;
  /** What `applyThreadpoolSizeAtBoot` would compute for this machine. */
  readonly desiredSize: number;
  /** True when the effective size is at least the desired buffer (buffer is in force). */
  readonly bufferApplied: boolean;
}

/**
 * Snapshot the current threadpool-buffer state. Pure read; no env mutation, no
 * I/O beyond the synchronous `availableParallelism` already used at apply time.
 */
export function snapshotThreadpoolBuffer(
  currentEnvValue: string | undefined,
  availableParallelism: number,
): ThreadpoolBufferSnapshot {
  const desiredSize = computeThreadpoolSize(availableParallelism);
  const parsed =
    currentEnvValue === undefined ? Number.NaN : Number.parseInt(currentEnvValue, 10);
  const effectiveSize = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  // libuv falls back to its default 4 when the env value is unset/garbage; the
  // buffer is only truly "applied" when the value libuv reads clears the desired.
  const bufferApplied = effectiveSize !== null && effectiveSize >= desiredSize;
  return { effectiveSize, rawEnvValue: currentEnvValue, desiredSize, bufferApplied };
}
