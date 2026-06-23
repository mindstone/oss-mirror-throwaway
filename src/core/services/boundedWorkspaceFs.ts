/**
 * boundedWorkspaceFs — the ONE classified workspace-filesystem boundary every
 * cloud-capable read/stat/readdir/realpath must go through (PLAN.md SYNTHESIS
 * Re-Plan, Stage S1; architecture-review/FINAL-arbitration.md §1).
 *
 * --- Why this exists (the root cause it serves) ---
 * The 0.4.48→0.4.49 turn-hang class was: one shared UNBOUNDED resource — the libuv
 * threadpool, reached via bare `fs` — serving two workloads with OPPOSITE latency
 * contracts (latency-critical turn-path work vs latency-insensitive bulk Drive
 * indexing). A symlink into a dead cloud FUSE mount makes `stat`/`readdir`/`realpath`
 * block in the kernel with no timeout, parking pool workers until the turn path
 * starves. The cure is to budget the bulk work AND make the budget reclaimable,
 * behind ONE enforced boundary:
 *
 *   - LOCAL lane  → bare `fs` (byte-identical fast path; the overwhelming hot path
 *                   is never throttled, marshalled, or routed off-thread).
 *   - CLOUD lane  → a small bounded, KILLABLE child-process fs pool executor
 *                   (Stage S2). On timeout the executor KILLS the wedged child,
 *                   the OS reclaims the kernel-blocked syscall, and the boundary
 *                   resolves a typed `reconnecting` outcome — never a hang, never a
 *                   permanently-squatted lane (the property a main-thread semaphore
 *                   structurally cannot deliver; see FINAL-arbitration §1).
 *
 * --- Classification is FS-FREE and leak-free (containment-based) ---
 * "Is this a cloud path?" is answered by {@link isUnderCloudSpace} — a pure string
 * prefix match against the readlink-classified `cloudSpaceContainment` map (built
 * from settings `spaces`, never by dereferencing a mount). This is deliberately
 * CONTAINMENT-based, not a naive `detectCloudStorage(path)` string match: a
 * fast-local Dropbox folder that happens to BE the workspace root (matches the
 * legacy `/dropbox/` pattern but is not a symlinked cloud space) must NOT be routed
 * off-thread — that mis-classify is one of the two leaks this build proved
 * (FINAL-arbitration §2). Only paths under (or AT) an actual cloud-symlink-backed
 * space (in either stored form — workspace-symlink or resolved-cloud-realpath) take
 * the cloud lane.
 *
 * SCOPE/RESIDUAL (be precise — do not overclaim): the boundary bounds every cloud
 * read **under a configured cloud space, once the containment map is built**. Two
 * deliberate gaps follow from the containment-based choice:
 *   (a) Until `configureCloudSpaceContainment` runs at startup the map is empty, so
 *       a consumer that reads before then sees `'local'`. S3/S5 MUST configure the
 *       map EARLY and unconditionally (before any consumer routes through here, and
 *       independent of the admission flag — MA1/MA2 are live hang vectors regardless
 *       of the flag).
 *   (b) An explicitly-named cloud path OUTSIDE any configured space (an on-demand
 *       `ls ~/Library/CloudStorage/…`) classifies `'local'` → bare fs. This upholds
 *       "on-demand named-cloud reads still work" but leaves that narrow carve-out a
 *       hang surface for a *dead* named path — the same accepted residual the plan
 *       notes for the cloud-root carve-out. Behavior-based slow-mount quarantine
 *       (route any path that BEHAVES slow) is the tracked follow-up
 *       (FINAL-arbitration §1: "leave room … name it workspaceFs not cloudFs").
 *
 * Hang-safety is INDEPENDENT of the admission flag: the flag governs whether cloud
 * spaces get WALKED/INDEXED (Stage S5); it does not govern whether a read is bounded.
 *
 * --- Read surface only ---
 * This is a READ boundary (stat/lstat/realpath/readlink/readdir/readFile/
 * readFileBytes/access). Cloud WRITE/COPY work (cloudWorkspaceSync / migration) is bounded
 * coarsely at the op level (SYNTHESIS reuse map), NOT routed through here. Subprocess
 * walks (`rg`/`find`/`grep` in glob/search tools) are governed separately by
 * `cloudSubprocessExclusion.ts` (Stage 9) — this boundary does not cover them.
 *
 * --- Fail-closed by construction ---
 * Every op returns a discriminated {@link WorkspaceFsOutcome}: `ok` | `reconnecting`
 * | `error`. A degraded cloud op can NEVER masquerade as success or as a hard fs
 * error — the caller is forced to make a conscious cloud-degraded decision (retain /
 * skip / show-empty). When a real executor IS wired (desktop, after Stage S2), a cloud
 * read that exceeds its budget resolves `reconnecting` and the executor kills + reclaims
 * the wedged child — it NEVER falls back to bare `fs` on a live cloud mount (that fallback
 * IS the hang).
 *
 * NO-EXECUTOR → LOCAL (cross-surface, S4.1e final-review F1): when NO executor is wired —
 * cloud/mobile (no FUSE mount) and the tiny desktop boot window before the child pool
 * installs — a "looks cloudy" path (containment OR pattern `forceCloud`) takes the bare-fsp
 * LOCAL lane and reads byte-identically, rather than degrading to a spurious `reconnecting`.
 * Rationale: with no executor there is nothing to bound the read WITH, and on those surfaces
 * there is no dead FUSE mount to bound AGAINST — a local read is the only sensible behaviour
 * and it preserves the documented contract "cloud/mobile → local bare fs → byte-identical".
 * On desktop the executor wires at startup BEFORE the containment map is built, so all REAL
 * cloud routing there sees a wired executor and stays bounded (dead-mount protection intact).
 * See {@link shouldRouteCloud} + the {@link _executorWired} flag.
 *
 * --- Enforcement ---
 * `scripts/check-workspace-fs-boundary.ts` (RS-F5 sibling) bans raw dereferencing
 * `fs` calls in the boundary-governed consumer files, so a future consumer cannot
 * silently re-introduce an unbounded cloud syscall — the bypass is impossible by
 * construction, not merely guarded.
 *
 * Pure `@core` (Node `fs`/`path` only, no `electron`). The async-only surface forces
 * the few remaining SYNC cloud reads (the MA1 hang class) to become async + bounded.
 */
// Local-lane fs. Import from `node:fs/promises` (NOT `node:fs`'s `promises`): they are
// the SAME object at runtime, but they are DISTINCT module specifiers under the test
// runner's module mocker. The codebase's entire fs-unit-test convention mocks
// `node:fs/promises`; importing it here keeps the boundary's LOCAL lane interceptable by
// that standard seam (so a consumer routed onto the boundary stays testable exactly as
// when it called bare fs — S4.1a). The CLOUD lane never touches fs (it calls the executor),
// so this only affects local-lane behaviour, which is byte-identical to bare fs.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { isUnderCloudSpace } from '@core/services/cloudSpaceContainment';
import { detectCloudStorage, FS_TIMEOUT_CLOUD_MS } from '@core/utils/cloudStorageUtils';
import { runWithTimeout } from '@core/utils/withTimeout';

const log = createScopedLogger({ service: 'boundedWorkspaceFs' });

// ---------------------------------------------------------------------------
// Public result shapes (serializable — identical across both lanes and the child).
// ---------------------------------------------------------------------------

/** Which lane an op was routed to. `reconnecting` only ever occurs on `cloud`. */
export type WorkspaceFsLane = 'local' | 'cloud';

/**
 * A serializable subset of `fs.Stats` — the fields cloud consumers actually use.
 * Metadata-only by design (the spike proved metadata-only + batched child replies
 * reach ~parity with bare fs; full `fs.Stats` cannot cross the IPC boundary and its
 * extra fields are unused by the indexer/search/watcher consumers).
 */
export interface WorkspaceStat {
  /** Last-modified time in epoch ms (the indexer's change-detection signal). */
  readonly mtimeMs: number;
  /** Change time in epoch ms (some cache-invalidation paths use it). */
  readonly ctimeMs: number;
  /** Size in bytes. */
  readonly size: number;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

/** A serializable subset of `fs.Dirent` for `readdir({ withFileTypes: true })`. */
export interface WorkspaceDirent {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

/**
 * The outcome of any boundary op — a discriminated union so a degraded cloud op
 * cannot be confused with success or a hard fs error.
 *
 *  - `ok`            — the op completed; `value` is the result, `lane` tells you how.
 *  - `reconnecting`  — a CLOUD op exceeded its budget (the executor killed the
 *                      wedged child and reclaimed the slot) or no executor is wired.
 *                      The caller should RETAIN last-known state / show "reconnecting"
 *                      / skip — never treat it as absence. Always the cloud lane.
 *  - `error`         — a real filesystem error (ENOENT/EACCES/…); `error.code`
 *                      carries the cause, exactly as bare `fs` would have thrown.
 */
export type WorkspaceFsOutcome<T> =
  | { readonly status: 'ok'; readonly lane: WorkspaceFsLane; readonly value: T }
  | { readonly status: 'reconnecting'; readonly path: string }
  | { readonly status: 'error'; readonly lane: WorkspaceFsLane; readonly error: NodeJS.ErrnoException };

// ---------------------------------------------------------------------------
// The cloud-lane executor seam (implemented by the Stage S2 killable child pool).
// ---------------------------------------------------------------------------

/**
 * Result of a single executor op. The executor OWNS the per-op timeout + kill
 * (the proven reclaim): on a wedged syscall it kills the child and resolves
 * `{ ok: false, reason: 'timeout' }`; a real fs error resolves
 * `{ ok: false, reason: 'error', error }`. It MUST never reject and MUST never
 * block the caller's event loop.
 */
export type WorkspaceFsExecResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'timeout' }
  | { readonly ok: false; readonly reason: 'error'; readonly error: NodeJS.ErrnoException };

/**
 * The cloud-lane executor: does the actual (potentially mount-blocking) fs work in
 * a small bounded, KILLABLE child-process pool so a dead mount can be reclaimed by
 * killing the child. Only the CLOUD lane uses it; the local lane never touches it.
 *
 * Implemented by the desktop child pool (Stage S2, repurposed from the
 * `cloudLivenessProbeService` child lifecycle) and wired via
 * {@link setWorkspaceFsExecutor} at bootstrap. Cloud/mobile keep the no-op default.
 */
export interface WorkspaceFsExecutor {
  stat(absolutePath: string): Promise<WorkspaceFsExecResult<WorkspaceStat>>;
  lstat(absolutePath: string): Promise<WorkspaceFsExecResult<WorkspaceStat>>;
  realpath(absolutePath: string): Promise<WorkspaceFsExecResult<string>>;
  /** Read a symlink's stored target. The link inode itself lives on the (possibly
   * cloud) mount, so this MUST be bounded too (S3 review F1) — not a target deref. */
  readlink(absolutePath: string): Promise<WorkspaceFsExecResult<string>>;
  readdir(absolutePath: string): Promise<WorkspaceFsExecResult<string[]>>;
  readdirWithFileTypes(absolutePath: string): Promise<WorkspaceFsExecResult<WorkspaceDirent[]>>;
  readFile(absolutePath: string, encoding: BufferEncoding): Promise<WorkspaceFsExecResult<string>>;
  /** Binary read — the bytes cross IPC as a Buffer (for base64/binary consumers). */
  readFileBytes(absolutePath: string): Promise<WorkspaceFsExecResult<Buffer>>;
  /**
   * True iff the path is accessible (an existence/permission probe; never throws).
   * `mode` is an `fs.constants.*_OK` bitmask (defaults to `F_OK` = existence) so a
   * caller can probe write-permission (`W_OK`) on a possibly-cloud path without an
   * unbounded raw `fs.access` (spaceService `checkSpaceWritable`, S4.1e). A failing
   * mode check surfaces as `{ ok: false, reason: 'error', error }` (e.g. EACCES),
   * exactly as bare `fs.access` would throw.
   */
  access(absolutePath: string, mode?: number): Promise<WorkspaceFsExecResult<true>>;
}

/**
 * Default cloud-lane executor: resolves EVERY op to `reason: 'timeout'` → the
 * boundary maps it to `reconnecting`. This is the fail-closed default before the
 * desktop executor is wired (Stage S2) and the permanent behaviour on cloud/mobile
 * (no FUSE mount). It NEVER does bare `fs` on a cloud path (that fallback is the
 * hang). A one-time warning makes "cloud read attempted with no executor wired"
 * observable rather than silent.
 */
function makeUnwiredExecutor(): WorkspaceFsExecutor {
  let warned = false;
  const unwired = <T>(): Promise<WorkspaceFsExecResult<T>> => {
    if (!warned) {
      warned = true;
      log.warn(
        'cloud workspace-fs op requested but no executor is wired — returning "reconnecting" (fail-closed). ' +
          'This is expected on cloud/mobile and during the boot window before the desktop child pool is installed.',
      );
    }
    return Promise.resolve({ ok: false, reason: 'timeout' });
  };
  return {
    stat: unwired,
    lstat: unwired,
    realpath: unwired,
    readlink: unwired,
    readdir: unwired,
    readdirWithFileTypes: unwired,
    readFile: unwired,
    readFileBytes: unwired,
    access: unwired,
  };
}

let _executor: WorkspaceFsExecutor = makeUnwiredExecutor();
/**
 * Whether a REAL cloud-lane executor has been wired (desktop child pool at bootstrap).
 * `false` on cloud/mobile (no FUSE mount) and during the tiny desktop boot window before
 * {@link setWorkspaceFsExecutor} runs. Drives the no-executor→LOCAL lane fallback in
 * {@link shouldRouteCloud} (S4.1e final-review F1): with no executor there is nothing to
 * bound the read WITH, and on the no-executor surfaces there is no FUSE mount to bound
 * AGAINST — so a path that merely LOOKS cloudy (pattern `forceCloud`, or a containment
 * entry on a surface that never wires the executor) must take the bare-`fsp` LOCAL lane
 * and read byte-identically, not degrade to a spurious `reconnecting`. This preserves the
 * documented cross-surface contract "cloud/mobile (empty/irrelevant cloud env) → local
 * bare fs → byte-identical". Desktop wires the executor at startup (src/main/index.ts),
 * BEFORE the containment map is built, so real cloud routing on desktop always sees a
 * wired executor and stays bounded (the dead-mount protection is unaffected).
 */
let _executorWired = false;
/** One-time guard so the no-executor→local downgrade is logged once, not per-read. */
let _warnedNoExecutorLocalFallback = false;

/**
 * Wire the host's concrete cloud-lane executor (desktop killable child pool, at
 * bootstrap). Mirrors `setCloudLivenessProbe` / `setBroadcastService`.
 */
export function setWorkspaceFsExecutor(executor: WorkspaceFsExecutor): void {
  _executor = executor;
  _executorWired = true;
}

/** Get the active cloud-lane executor (defaults to the fail-closed unwired one). */
export function getWorkspaceFsExecutor(): WorkspaceFsExecutor {
  return _executor;
}

/** Test-only: restore the fail-closed unwired executor (and the no-executor state). */
export function __resetWorkspaceFsExecutorForTesting(): void {
  _executor = makeUnwiredExecutor();
  _executorWired = false;
  _warnedNoExecutorLocalFallback = false;
}

// ---------------------------------------------------------------------------
// Classification + the bounded backstop.
// ---------------------------------------------------------------------------

/**
 * Belt-and-suspenders backstop over the executor's OWN timeout. The executor kills
 * a wedged child at `FS_TIMEOUT_CLOUD_MS` and resolves cleanly; this slightly-longer
 * backstop guarantees the boundary's caller is released even if the executor's IPC
 * itself wedges (e.g. the child crashed mid-flight before its kill timer fired). On
 * backstop fire the boundary resolves `reconnecting` — so the boundary can NEVER
 * hang its caller regardless of executor behaviour.
 */
const EXECUTOR_BACKSTOP_GRACE_MS = 2_000;

/**
 * Classify an absolute workspace path FS-FREE: `'cloud'` iff it is under a
 * readlink-classified cloud space (either stored form), else `'local'`. Pure string
 * work, never blocks, never throws. Exposed so a consumer can branch on lane (e.g.
 * the search path's "retain cloud entries instead of fs-checking them") without
 * issuing an op.
 */
export function classifyWorkspacePath(absolutePath: string): WorkspaceFsLane {
  return isUnderCloudSpace(absolutePath) ? 'cloud' : 'local';
}

/**
 * Route a cloud-lane op through the executor with the bounded backstop, mapping the
 * executor result to a {@link WorkspaceFsOutcome}. Never throws, never hangs.
 */
async function runCloudOp<T>(
  absolutePath: string,
  op: (executor: WorkspaceFsExecutor) => Promise<WorkspaceFsExecResult<T>>,
  backstopMs: number = FS_TIMEOUT_CLOUD_MS + EXECUTOR_BACKSTOP_GRACE_MS,
): Promise<WorkspaceFsOutcome<T>> {
  const { value: result } = await runWithTimeout<WorkspaceFsExecResult<T>>({
    timeoutMs: backstopMs,
    // The executor contract says "never rejects", but the boundary must uphold
    // "never throws, never hangs" REGARDLESS of a buggy/misbehaving executor (S1
    // review F2). Catch a synchronous throw or a rejected promise and fail closed
    // to a timeout result (→ reconnecting → retain). Observable, not silent.
    work: async () => {
      try {
        return await op(getWorkspaceFsExecutor());
      } catch (err) {
        log.warn(
          { err },
          'cloud workspace-fs executor threw/rejected (contract violation) — failing closed to reconnecting',
        );
        return { ok: false, reason: 'timeout' };
      }
    },
    // Backstop fired before the executor returned → treat as reconnecting.
    onTimeout: () => ({ ok: false, reason: 'timeout' }),
  });
  // Defend against a malformed executor result (not a conforming union) — fail
  // closed to reconnecting rather than dereferencing `.ok`/`.value` blindly.
  if (!result || typeof result !== 'object' || typeof (result as { ok?: unknown }).ok !== 'boolean') {
    log.warn({ path: absolutePath }, 'cloud workspace-fs executor returned a malformed result — failing closed to reconnecting');
    return { status: 'reconnecting', path: absolutePath };
  }
  if (result.ok) {
    return { status: 'ok', lane: 'cloud', value: result.value };
  }
  if (result.reason === 'timeout') {
    return { status: 'reconnecting', path: absolutePath };
  }
  return { status: 'error', lane: 'cloud', error: result.error };
}

/** Map a real `fs.Stats` to the serializable {@link WorkspaceStat}. */
function toWorkspaceStat(stats: {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): WorkspaceStat {
  return {
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    size: stats.size,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    isSymbolicLink: stats.isSymbolicLink(),
  };
}

/** Wrap a bare local fs op: success → `ok`, thrown fs error → `error`. */
async function runLocalOp<T>(work: () => Promise<T>): Promise<WorkspaceFsOutcome<T>> {
  try {
    return { status: 'ok', lane: 'local', value: await work() };
  } catch (err) {
    return { status: 'error', lane: 'local', error: err as NodeJS.ErrnoException };
  }
}

// ---------------------------------------------------------------------------
// The boundary surface.
// ---------------------------------------------------------------------------

/**
 * Per-call options for a boundary op.
 *  - `timeoutMs` — override the CLOUD-lane backstop budget (the deadline after which
 *    the caller is released with `reconnecting`). Defaults to
 *    `FS_TIMEOUT_CLOUD_MS + grace` (~17s). A latency-critical caller (e.g. the
 *    turn-path system-prompt assembly, MA1) should pass a TIGHTER budget (e.g. 3s)
 *    so a dead Drive degrades the read fast instead of stalling the turn — the
 *    executor still kills + reclaims the wedged child at its own internal timeout,
 *    independent of this caller-facing budget. Ignored on the LOCAL lane (bare fs).
 */
export interface WorkspaceFsOptions {
  readonly timeoutMs?: number;
  /**
   * Force the CLOUD lane even when {@link classifyWorkspacePath} (containment) would
   * say `'local'`. For callers that hold their OWN cloud evidence the containment map
   * lacks — specifically an explicitly-named cloud path OUTSIDE any configured space
   * (an on-demand `ls`/`glob` of an arbitrary `~/Library/CloudStorage/…` folder, or a
   * `safeWalkDirectory` root flagged by the PATTERN classifier `detectCloudStorage`).
   * Without this, such a path classifies `'local'` → bare fs → UNBOUNDED, silently
   * regressing the pre-boundary `runWithTimeout` carve-out (S4 review R-MUST-2). The
   * boundary's DEFAULT stays containment-based (broadening the default classifier back
   * to `detectCloudStorage` would reintroduce the Dropbox-fast-local misclassify leak,
   * FINAL-arbitration §2); this is an opt-in per-call override, NOT a classifier change.
   * Use {@link cloudLaneOptionForPath} to derive it from a path's pattern class.
   */
  readonly forceCloud?: boolean;
}

/**
 * Bridge a caller's PATTERN-based cloud knowledge to a boundary lane override. Returns
 * `{ forceCloud: true }` iff `detectCloudStorage(p)` flags the path as cloud, else
 * `undefined` (so the boundary's containment default applies). Centralises the
 * pattern→lane bridge so no consumer hand-rolls `detectCloudStorage(p) ? … : …`
 * (S4 review R-MUST-2). Pure string work — no I/O. Merge extra options as needed:
 * `{ ...cloudLaneOptionForPath(p), timeoutMs: 3_000 }`.
 */
export function cloudLaneOptionForPath(p: string): WorkspaceFsOptions | undefined {
  return detectCloudStorage(p).isCloud ? { forceCloud: true } : undefined;
}

/**
 * Whether an op on `abs` should take the cloud lane: containment OR a forced override —
 * BUT ONLY when a real executor is wired (S4.1e final-review F1). With no executor wired
 * (cloud/mobile, or the desktop pre-bootstrap window) there is nothing to bound the read
 * WITH and — on those surfaces — no FUSE mount to bound AGAINST, so a "looks cloudy" path
 * (pattern `forceCloud`, or a stray containment entry) must take the bare-`fsp` LOCAL lane
 * and read byte-identically rather than degrade to a spurious `reconnecting`. The cloud
 * lane exists solely to bound a dead FUSE mount via the killable executor; absent that
 * executor, a local read is the only sensible behaviour. Pure decision; the one-time warn
 * keeps the downgrade observable, not silent.
 */
function shouldRouteCloud(abs: string, options?: WorkspaceFsOptions): boolean {
  const wantsCloud = options?.forceCloud === true || classifyWorkspacePath(abs) === 'cloud';
  if (!wantsCloud) return false;
  // see docs/plans/260622_libraryhandlers-read-lane/PLAN.md § Intent & Design Rationale #3
  // (no-executor → LOCAL: nothing to bound with, no FUSE mount to bound against).
  if (!_executorWired) {
    if (!_warnedNoExecutorLocalFallback) {
      _warnedNoExecutorLocalFallback = true;
      log.warn(
        'workspace-fs: a cloud-classified path was requested with NO executor wired — ' +
          'reading via the LOCAL bare-fs lane (expected on cloud/mobile, where a "cloudy"-looking ' +
          'path is genuinely local; and during the desktop boot window before the child pool wires).',
      );
    }
    return false;
  }
  return true;
}

/**
 * The single classified workspace-fs boundary. Every cloud-capable workspace
 * read/stat/readdir/realpath goes through here; the lint gate enforces no bypass in
 * boundary-governed files. `absolutePath` MUST be absolute (a workspace consumer
 * always joins against `coreDirectory`); relative paths are resolved against cwd
 * defensively but that is not a supported call shape.
 */
export const workspaceFs = {
  async stat(absolutePath: string, options?: WorkspaceFsOptions): Promise<WorkspaceFsOutcome<WorkspaceStat>> {
    const abs = path.resolve(absolutePath);
    if (shouldRouteCloud(abs, options)) {
      return runCloudOp(abs, (ex) => ex.stat(abs), options?.timeoutMs);
    }
    return runLocalOp(async () => toWorkspaceStat(await fsp.stat(abs)));
  },

  async lstat(absolutePath: string, options?: WorkspaceFsOptions): Promise<WorkspaceFsOutcome<WorkspaceStat>> {
    const abs = path.resolve(absolutePath);
    if (shouldRouteCloud(abs, options)) {
      return runCloudOp(abs, (ex) => ex.lstat(abs), options?.timeoutMs);
    }
    return runLocalOp(async () => toWorkspaceStat(await fsp.lstat(abs)));
  },

  async realpath(absolutePath: string, options?: WorkspaceFsOptions): Promise<WorkspaceFsOutcome<string>> {
    const abs = path.resolve(absolutePath);
    if (shouldRouteCloud(abs, options)) {
      return runCloudOp(abs, (ex) => ex.realpath(abs), options?.timeoutMs);
    }
    return runLocalOp(() => fsp.realpath(abs));
  },

  /**
   * Read a symlink's stored target string. The symlink's OWN inode lives on the
   * (possibly cloud/FUSE) mount, so a wedged mount can block `readlink` even though
   * it does not dereference the target — it MUST be bounded like the other ops
   * (S3 review F1). `value` is the raw target (may be relative or absolute).
   */
  async readlink(absolutePath: string, options?: WorkspaceFsOptions): Promise<WorkspaceFsOutcome<string>> {
    const abs = path.resolve(absolutePath);
    if (shouldRouteCloud(abs, options)) {
      return runCloudOp(abs, (ex) => ex.readlink(abs), options?.timeoutMs);
    }
    return runLocalOp(() => fsp.readlink(abs));
  },

  async readdir(absolutePath: string, options?: WorkspaceFsOptions): Promise<WorkspaceFsOutcome<string[]>> {
    const abs = path.resolve(absolutePath);
    if (shouldRouteCloud(abs, options)) {
      return runCloudOp(abs, (ex) => ex.readdir(abs), options?.timeoutMs);
    }
    return runLocalOp(() => fsp.readdir(abs));
  },

  async readdirWithFileTypes(
    absolutePath: string,
    options?: WorkspaceFsOptions,
  ): Promise<WorkspaceFsOutcome<WorkspaceDirent[]>> {
    const abs = path.resolve(absolutePath);
    if (shouldRouteCloud(abs, options)) {
      return runCloudOp(abs, (ex) => ex.readdirWithFileTypes(abs), options?.timeoutMs);
    }
    return runLocalOp(async () => {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
        isSymbolicLink: e.isSymbolicLink(),
      }));
    });
  },

  async readFile(
    absolutePath: string,
    encoding: BufferEncoding = 'utf8',
    options?: WorkspaceFsOptions,
  ): Promise<WorkspaceFsOutcome<string>> {
    const abs = path.resolve(absolutePath);
    if (shouldRouteCloud(abs, options)) {
      return runCloudOp(abs, (ex) => ex.readFile(abs, encoding), options?.timeoutMs);
    }
    return runLocalOp(() => fsp.readFile(abs, encoding));
  },

  /** Binary read — returns the raw bytes (for base64/binary consumers). */
  async readFileBytes(absolutePath: string, options?: WorkspaceFsOptions): Promise<WorkspaceFsOutcome<Buffer>> {
    const abs = path.resolve(absolutePath);
    if (shouldRouteCloud(abs, options)) {
      return runCloudOp(abs, (ex) => ex.readFileBytes(abs), options?.timeoutMs);
    }
    return runLocalOp(() => fsp.readFile(abs));
  },

  /**
   * Existence/permission probe. `ok` (value `true`) iff accessible; a real fs error
   * (ENOENT/EACCES) → `error`; a dead cloud mount → `reconnecting` (NOT absence —
   * the caller must retain, not purge). `mode` is an `fs.constants.*_OK` bitmask
   * (default `F_OK` = existence); pass `W_OK` to probe write-permission on a
   * possibly-cloud path without an unbounded raw `fs.access` (S4.1e
   * `checkSpaceWritable`).
   */
  async access(absolutePath: string, mode?: number, options?: WorkspaceFsOptions): Promise<WorkspaceFsOutcome<true>> {
    const abs = path.resolve(absolutePath);
    if (shouldRouteCloud(abs, options)) {
      return runCloudOp(abs, (ex) => ex.access(abs, mode), options?.timeoutMs);
    }
    return runLocalOp(async () => {
      // Only forward `mode` when the caller actually passed one (W_OK), so a plain
      // existence probe stays a byte-identical `fsp.access(abs)` call — `fsp.access(abs,
      // undefined)` is functionally the same but changes the observed call shape (S4.1e
      // final-review: a consumer test spies the exact `fsp.access(path)` args).
      if (mode === undefined) {
        await fsp.access(abs);
      } else {
        await fsp.access(abs, mode);
      }
      return true as const;
    });
  },
} as const;
