/**
 * Safe Directory Walker
 *
 * A bounded, cycle-safe alternative to ad-hoc `fs.readdir` recursion.
 *
 * Why this exists:
 * - User workspaces can contain real-directory loops or symlinks-to-ancestor
 *   that are completely valid on disk but blow up any naïve walker with
 *   `ENAMETOOLONG: name too long` once the synthesized path crosses the OS
 *   PATH_MAX (1024 on macOS, 4096 on Linux, 260 on Windows by default).
 * - Sentry cluster REBEL-4WS through REBEL-510 (~100 issues) and the
 *   recurrence in REBEL-506 came from one user's self-nested workspace
 *   tripping every walker that descends from the workspace root.
 * - Each previous fix patched ONE walker. This utility centralises the
 *   defence so every recursive walker in the codebase gets the same guards
 *   and a single regression suite covers them all.
 *
 * Guards (all enforced internally):
 * 1. **Visited-realpath set** — breaks symlink-to-ancestor loops AND real-
 *    directory loops introduced by the user (same canonical path reached
 *    twice). The proven mechanism from `listMarkdownFilesRecursively`.
 * 2. **Depth cap** — hard limit on tree depth.
 * 3. **Path-length cap** — bails before any path string approaches OS
 *    PATH_MAX, so we never make the syscall that would return ENAMETOOLONG.
 * 4. **Entries cap** — defence in depth against pathological fan-out.
 *
 * Usage:
 * ```ts
 * await safeWalkDirectory(rootDir, {
 *   onFile: ({ absolutePath, name }) => {
 *     if (name.endsWith('.md')) results.push(absolutePath);
 *   },
 *   onDirectory: ({ name }) =>
 *     name.startsWith('.') ? false : true, // skip hidden dirs
 * });
 * ```
 *
 * Defaults are the same proven values from `listMarkdownFilesRecursively`
 * and are appropriate for any walker rooted at a workspace or space root.
 * Callers with very specific needs can override per-call.
 *
 * Planning context:
 * - REBEL-506 fix (this file is the catch-all)
 * - Previous walker-specific fix: commit 4d8981cd2
 * - Sentry triage: docs-private/sentry-triage-log/260427_111800_harry_triage.md
 */

import path from 'node:path';
import { shouldSkipCloudSymlinkTarget } from '@core/utils/cloudStorageUtils';
import { walkToFirstCloudHopViaReadlink } from '@core/utils/readlinkChain';
import { resolveCloudSymlinkAdmission } from '@core/services/cloudSymlinkIndexing';
import {
  workspaceFs,
  cloudLaneOptionForPath,
  classifyWorkspacePath,
  type WorkspaceFsOptions,
} from '@core/services/boundedWorkspaceFs';

/**
 * S4.1a — every cloud-capable fs op in the walker now routes through the ONE
 * classified boundary (`boundedWorkspaceFs`), replacing the Stage-5 `runWithTimeout`
 * + bare-`fs` carve-out. The explicit-cloud-root case is thereby UPGRADED from
 * ABANDON (runWithTimeout left the wedged syscall parking a libuv worker) to RECLAIM
 * (the boundary's killable child pool kills the wedged child and frees the slot).
 *
 * Classification stays split, deliberately (S4 review R-MUST-2 / design D1):
 *   - CONTAINMENT (`classifyWorkspacePath` = `isUnderCloudSpace`, the boundary's
 *     default) routes every read UNDER a configured cloud space to the cloud lane.
 *   - PATTERN (`detectCloudStorage`, via `cloudLaneOptionForPath` → `forceCloud`)
 *     bridges the EXPLICIT-cloud-root carve-out: an on-demand `ls`/`glob` of a cloud
 *     folder that is NOT a configured space classifies `'local'` by containment, so
 *     the walker forces the cloud lane from its own pattern evidence. Without this the
 *     carve-out would silently regress to UNBOUNDED bare fs.
 * The boundary's default classifier is NOT broadened back to pattern (that would
 * reintroduce the Dropbox-fast-local misclassify leak — FINAL-arbitration §2).
 */
const FORCE_CLOUD_LANE: WorkspaceFsOptions = Object.freeze({ forceCloud: true });

/**
 * Defaults match `listMarkdownFilesRecursively`'s proven values. Any walker
 * descending from a workspace/space root should be fine with these.
 */

// Bounded-walker primitive — see docs/plans/260503_s9_bounded_walker_resource_budget.md and CODING_PRINCIPLES.md § "Intent & Design Rationale: bounded-walker completeness propagation".

export const DEFAULT_SAFE_WALK_LIMITS = {
  /** Max tree depth (0 = root only). 12 covers any realistic memory/topics tree. */
  MAX_DEPTH: 12,
  /**
   * Hard cap on absolute path length we'll attempt to traverse.
   * macOS PATH_MAX = 1024, Linux PATH_MAX = 4096, Windows MAX_PATH = 260
   * (default; long-paths opt-in raises it). 900 stays well under macOS,
   * which is where the bulk of REBEL-506 events came from.
   */
  MAX_PATH_LENGTH: 900,
  /** Defensive cap on entries visited per walk. */
  MAX_ENTRIES: 50_000,
} as const;

export type SafeWalkTruncationReason =
  | 'depth'
  | 'pathLength'
  | 'entries'
  | 'aborted'
  /**
   * A directory could not be read because the filesystem denied permission
   * (`EACCES` / `EPERM`). The walker continues with siblings, but any
   * descendants of the denied directory are missed. Manifest-deriving
   * consumers (set-difference deletion, cross-source diffs) MUST treat this
   * as "the walk is incomplete" and skip destructive operations.
   */
  | 'permission'
  /**
   * A directory entry could not be enumerated for a reason that isn't a
   * permission denial — typically `ENOENT` (race: directory removed between
   * dirent listing and `readdir`), `ENOTDIR`, `ENAMETOOLONG` (path too long
   * even after the path-length cap, e.g. when a symlink expands the path
   * post-stat), `EIO`, `ELOOP`. Same consumer guidance as `'permission'`:
   * the walk is incomplete; do not derive destructive set-differences from it.
   */
  | 'unreadable'
  /**
   * An **incidental** symlink-to-directory encountered during the walk resolved
   * to a cloud-storage mount (Google Drive / Dropbox / OneDrive / iCloud / Box)
   * and descent was skipped to avoid hanging on FUSE/network I/O (RC-1,
   * docs/plans/260618_library-scan-freeze-investigation/PLAN.md). The dirent is
   * still visible at its parent; only descent into it is skipped. This is a
   * deliberate, default-on exclusion (`skipCloudSymlinkTargets`), NOT an error —
   * but it does mean the walk did not enumerate that subtree, so manifest-
   * deriving consumers MUST treat it like any other truncation (do not derive
   * destructive set-differences). Consumers that intentionally traverse cloud
   * (cloud sync / migration) opt out via `skipCloudSymlinkTargets: false`.
   */
  | 'cloud-symlink-skipped'
  /**
   * A bounded filesystem op (root `realpath`, or a `readdir` of a directory the
   * pure-string classifier flags as a cloud mount) did not return within the
   * cloud timeout budget and was abandoned (Stage 5, cloud-root hang-proofing).
   * This is the EXPLICITLY-TARGETED cloud-root carve-out: a caller that names a
   * cloud folder AS the root (on-demand `ls`/`glob`, or a cloud workspace root)
   * still gets walked, but a DEAD mount can no longer block the main thread
   * unbounded — the op times out and the (sub)tree is reported incomplete instead
   * of hanging. Like every other truncation reason, manifest-deriving consumers
   * MUST treat this as "the walk is incomplete; do not derive destructive
   * set-differences from it" (`isSafeWalkComplete` already returns `false`).
   */
  | 'cloud-timeout';

/**
 * Classify a Node.js filesystem error into a truncation reason. Returns
 * `'permission'` for `EACCES`/`EPERM` and `'unreadable'` for anything else
 * (including unclassifiable errors).
 */
function classifyFsError(err: unknown): SafeWalkTruncationReason {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'EACCES' || code === 'EPERM') return 'permission';
  }
  return 'unreadable';
}

/**
 * Returns `true` if a `safeWalkDirectory` walk visited every directory it
 * was asked to (no caps fired, no permission/unreadable skips, no abort).
 *
 * Use this at any consumer that derives destructive operations from a walk's
 * output (e.g., manifest set-difference for cloud delete). On `false`, the
 * walk's results are partial and must not be used as proof-of-absence.
 */
export function isSafeWalkComplete(result: SafeWalkResult): boolean {
  return result.truncatedReasons.length === 0;
}

export interface SafeWalkFileInfo {
  /** Absolute path to the file (may include the entry name resolved through a symlink). */
  readonly absolutePath: string;
  /** Just the entry name (last path segment). */
  readonly name: string;
  /** Absolute path of the parent directory containing this file. */
  readonly parentDir: string;
  /** Depth from root (0 = direct child of `rootDir`). */
  readonly depth: number;
  /** True if this file was reached via a symlink (i.e. the entry was a symlink-to-file). */
  readonly viaSymlink: boolean;
}

export interface SafeWalkDirInfo {
  readonly absolutePath: string;
  readonly name: string;
  readonly parentDir: string;
  readonly depth: number;
  readonly isSymbolicLink: boolean;
}

export interface SafeWalkResult {
  /** Total dirent entries inspected (files + directories). */
  readonly entriesVisited: number;
  /** Reasons truncation fired during the walk. Empty if walk ran to completion. */
  readonly truncatedReasons: readonly SafeWalkTruncationReason[];
  /** Resolved real path of the root, or null if the root itself could not be resolved. */
  readonly rootRealPath: string | null;
}

export interface SafeWalkOptions {
  /**
   * Called once for every file entry visited (including symlinks-to-file).
   * Errors thrown by the callback abort the walk and propagate to the caller.
   */
  readonly onFile?: (info: SafeWalkFileInfo) => void | Promise<void>;
  /**
   * Called BEFORE descending into each directory (including symlinks-to-dir).
   * Return `false` to skip descent. Return `true` or `undefined` to descend.
   * Callers can use this to skip hidden dirs, `node_modules`, archive dirs,
   * etc. Note: cycle detection runs regardless — `onDirectory` is consulted
   * AFTER the cycle check, so callers do not need to maintain their own
   * visited-set.
   */
  readonly onDirectory?: (info: SafeWalkDirInfo) => boolean | undefined | Promise<boolean | undefined>;
  /** Maximum tree depth; defaults to `DEFAULT_SAFE_WALK_LIMITS.MAX_DEPTH`. */
  readonly maxDepth?: number;
  /** Per-entry path-length cap; defaults to `DEFAULT_SAFE_WALK_LIMITS.MAX_PATH_LENGTH`. */
  readonly maxPathLength?: number;
  /** Per-walk entries-visited cap; defaults to `DEFAULT_SAFE_WALK_LIMITS.MAX_ENTRIES`. */
  readonly maxEntries?: number;
  /**
   * Skip descending into an **incidental** symlink-to-directory whose resolved
   * realpath is a cloud-storage mount (Google Drive / Dropbox / OneDrive /
   * iCloud / Box). **Default ON (opt-out).**
   *
   * Why default-on: following a symlink into a network-backed FUSE mount makes
   * every `readdir`/`stat` block on hydration and can hang the whole walk
   * indefinitely (RC-1 — the Library "Scanning…" freeze). A local workspace
   * commonly contains an incidental cloud symlink (e.g. `Company Memories →
   * ~/Library/CloudStorage/.../Shared drives/...`); descending into it is a hang
   * trap for ANY caller, so the safe default is to skip it and record the
   * `'cloud-symlink-skipped'` truncation reason.
   *
   * **Scope — incidental symlinks only.** This NEVER applies to an explicitly
   * targeted cloud `rootDir`: if a caller passes a cloud path (or a symlink to
   * one) AS the root, the walk proceeds — the caller chose it (e.g. an on-demand
   * `ls`/`glob` of a folder the user named). The skip fires only for cloud
   * symlinks reached *during* descent. It is cloud-specific: a non-cloud
   * outside-workspace symlink (e.g. `rebel-system → /Applications/…`) is still
   * followed, since `detectCloudStorage` returns `isCloud:false` for it.
   *
   * Set to `false` for callers that intentionally traverse cloud storage
   * (cloud workspace sync / cloud migration mirror the full local workspace,
   * including linked Drive/Dropbox folders).
   */
  readonly skipCloudSymlinkTargets?: boolean;
  /**
   * Force **every** filesystem op in the walk — the root `realpath`, every
   * directory `readdir`, and every per-entry `stat`/`realpath` — through the
   * killable cloud lane, even when the pattern classifier (`detectCloudStorage`)
   * and containment both read the paths as LOCAL. **Default OFF.**
   *
   * Why this opt-in exists: the boundary classifies paths FS-FREE (pattern string
   * + containment map). It physically cannot know that a pattern-LOCAL root path is
   * actually a SYMLINK whose target is a cloud mount — only a caller that already
   * saw the dirent (or otherwise holds out-of-band symlink-to-cloud evidence) knows
   * that. The real dead-Drive case: a `Chief-of-Staff` symlink to a dead cloud mount
   * drops out of `settings.spaces`, so containment never learned it and its workspace
   * path string is pattern-local. The bare-fs LOCAL lane would then HANG dereferencing
   * the dead symlink target. Callers holding that evidence set this so the walk is
   * RECLAIMABLE (killable cloud lane → `cloud-timeout` truncation) instead of an
   * unbounded main-thread hang.
   *
   * Scope: the WHOLE walk subtree. When the root is a symlink to a dead cloud mount,
   * EVERY descendant op is behind that same dead mount, so forcing only the root
   * `realpath` is not enough — a root that resolves `realpath` `ok` can still HANG on
   * the first `readdir` (the boundary's bare local `fsp.readdir`), and likewise any
   * per-entry `stat`/`realpath`. So this forces the cloud lane uniformly for the root
   * realpath, every directory enumeration, and every per-entry stat/realpath in the
   * walk (merged with each path's OWN pattern evidence so neither source is lost).
   * Mirrors how `readSpaceReadmeBounded` got its `forceCloud` option (260622 rd4 — the
   * analogous README-read fix). When false, all ops keep the bare-fs local fast path
   * (no regression to ordinary local walks).
   */
  readonly forceCloudRoot?: boolean;
  /** Optional cancellation signal. Aborts the walk between entries. */
  readonly signal?: AbortSignal;
  /**
   * Called once with a list of unique truncation reasons when the walk did NOT
   * run to completion — either a cap fired (`depth`/`pathLength`/`entries`), a
   * subtree was unreadable (`permission`/`unreadable`), the walk was aborted, or
   * a cloud symlink was deliberately skipped (`cloud-symlink-skipped`). Note
   * that not all reasons are CAPS: `cloud-symlink-skipped` is an intentional
   * exclusion, not a resource limit. Use this to log or surface "results may be
   * incomplete" to the user. Not called on a clean walk.
   */
  readonly onTruncated?: (info: {
    readonly rootDir: string;
    readonly reasons: readonly SafeWalkTruncationReason[];
    readonly entriesVisited: number;
  }) => void;
}

/**
 * Safely walk `rootDir` breadth-first with bounded depth, path-length, and
 * entry caps and automatic realpath cycle detection.
 *
 * Behaviour:
 * - Resolves `rootDir`'s realpath up front; if that fails, returns a no-op
 *   result with `rootRealPath: null` and `entriesVisited: 0`. Mirrors
 *   `listMarkdownFilesRecursively`'s "missing root is empty, not an error".
 * - Symlinks are followed by default. A symlink-to-file fires `onFile` with
 *   `viaSymlink: true`. A symlink-to-dir fires `onDirectory` and, if the
 *   caller does not skip, descent proceeds with cycle protection.
 * - **Unreadable subdirectories are reported as truncation** via the
 *   `'permission'` (EACCES/EPERM) or `'unreadable'` (everything else)
 *   reasons. The walk continues with siblings, but any descendants of the
 *   denied directory are missed. Manifest-deriving consumers (set-difference
 *   deletion, cross-source diffs) MUST gate destructive operations on
 *   `isSafeWalkComplete(result)`. Surface "incomplete" via `onTruncated`
 *   or by inspecting `truncatedReasons`.
 * - **Broken symlinks** (where the target itself doesn't exist) are silently
 *   skipped without recording truncation. The dirent IS visible at its
 *   parent, so listing-style consumers see the entry; descent simply has
 *   nothing to descend into. This matches the existing behaviour and avoids
 *   noise from routine cases (e.g., a `latest` symlink pointing at a removed
 *   build).
 */
// bounded-walker-exempt: canonical bounded walker primitive; see docs/plans/260503_s9_bounded_walker_resource_budget.md
export async function safeWalkDirectory(
  rootDir: string,
  options: SafeWalkOptions = {},
): Promise<SafeWalkResult> {
  const maxDepth = options.maxDepth ?? DEFAULT_SAFE_WALK_LIMITS.MAX_DEPTH;
  const maxPathLength = options.maxPathLength ?? DEFAULT_SAFE_WALK_LIMITS.MAX_PATH_LENGTH;
  const maxEntries = options.maxEntries ?? DEFAULT_SAFE_WALK_LIMITS.MAX_ENTRIES;
  const skipCloudSymlinkTargets = options.skipCloudSymlinkTargets ?? true;

  // Resolve the root once so cycle detection works against canonical paths
  // even if the root itself is a symlink. If the root is missing/unreadable,
  // bail cleanly (every existing walker treated this case as "empty").
  //
  // Cloud-root hang-proofing, now via the boundary (S4.1a): when `rootDir` is the
  // EXPLICITLY-TARGETED cloud-root carve-out (a caller named a cloud folder AS the
  // root — on-demand `ls`/`glob`, or a cloud workspace root), a DEAD mount makes a
  // raw `fs.realpath` block in the kernel with no timeout, parking a libuv worker.
  // `cloudLaneOptionForPath` forces the cloud lane from the walker's own PATTERN
  // evidence, so a dead root resolves to `reconnecting` (the killable child pool
  // kills the wedged child and RECLAIMS the slot — strictly better than the prior
  // `runWithTimeout` ABANDON) and the walk degrades to "empty" instead of hanging.
  // LOCAL roots take the boundary's bare-fs local lane (byte-identical fast path).
  //
  // R-MUST-3 — ROOT realpath has DIFFERENT error semantics than a mid-walk realpath:
  //   - `error` (ENOENT/EACCES/dangling) → "missing root is empty, NOT an error"
  //     → `{ rootRealPath: null, truncatedReasons: [] }` (no truncation; the generic
  //     mid-walk `error → classifyFsError` mapping is deliberately NOT applied here).
  //   - `reconnecting` (dead mount) → `{ rootRealPath: null, ['cloud-timeout'] }`.
  //
  // `forceCloudRoot` (rd4-analogous): a caller holding out-of-band symlink-to-cloud
  // evidence the pattern/containment classifier lacks (e.g. a scan-discovered
  // `Chief-of-Staff` symlink absent from `settings.spaces`) forces the cloud lane so a
  // dead symlink target degrades to `cloud-timeout` instead of hanging on bare-fs.
  //
  // CRITICAL — this forces the WHOLE walk subtree, not just the root realpath. When the
  // root is a symlink to a dead cloud mount, EVERY descendant lives behind that same dead
  // mount: a root that resolves `realpath` `ok` can still HANG on the first `readdir`
  // (`safeWalkDirectory.ts` documents this "realpath ok then first readdir blocks" class
  // for explicit cloud roots above), and so can any per-entry `stat`/`realpath`. So when
  // `forceCloudRoot` is set we OR `FORCE_CLOUD_LANE` into the lane option for every op in
  // the walk (root realpath, each directory enumeration, each per-entry stat/realpath),
  // merged with that path's OWN pattern evidence so neither source is lost. When unset,
  // every op keeps the bare-fs local fast path (no regression to ordinary local walks).
  const forceCloudWalk = options.forceCloudRoot === true;
  const rootLaneOpt: WorkspaceFsOptions | undefined = forceCloudWalk
    ? { ...cloudLaneOptionForPath(rootDir), ...FORCE_CLOUD_LANE }
    : cloudLaneOptionForPath(rootDir);
  const rootOutcome = await workspaceFs.realpath(rootDir, rootLaneOpt);
  if (rootOutcome.status === 'reconnecting') {
    // Dead/unresponsive mount: bounded (killable-pool reclaim), reported incomplete,
    // never blocks the main thread.
    return {
      entriesVisited: 0,
      truncatedReasons: Object.freeze(['cloud-timeout'] as SafeWalkTruncationReason[]),
      rootRealPath: null,
    };
  }
  if (rootOutcome.status === 'error') {
    // Missing/unreadable root is "empty, not an error" — NOT a truncation.
    return { entriesVisited: 0, truncatedReasons: [], rootRealPath: null };
  }
  const rootRealPath = rootOutcome.value;

  const visited = new Set<string>([rootRealPath]);
  const truncated = new Set<SafeWalkTruncationReason>();

  type QueueEntry = { absolutePath: string; depth: number };
  const queue: QueueEntry[] = [{ absolutePath: rootDir, depth: 0 }];

  let entriesVisited = 0;

  while (queue.length > 0) {
    if (options.signal?.aborted) {
      truncated.add('aborted');
      break;
    }

    const current = queue.pop();
    if (!current) continue;
    const { absolutePath: currentDir, depth } = current;

    if (depth > maxDepth) {
      truncated.add('depth');
      continue;
    }

    // Cloud-root hang-proofing via the boundary (S4.1a): a mount can resolve
    // `realpath(rootDir)` fast and then block on the FIRST `readdir`. Route the
    // enumeration through the boundary so a cloud dir is BOUNDED + reclaimable. Two
    // routing inputs combine inside the boundary: CONTAINMENT (its default — a dir
    // under a configured cloud space, reached only when admission descends with the
    // flag ON) and the PATTERN-flagged explicit-cloud-root carve-out (`currentDirCloudOpt`,
    // forces the cloud lane when containment doesn't cover it). LOCAL dirs take the
    // bare-fs local lane (byte-identical fast path).
    //
    // `currentDirIsCloud` (PATTERN) drives the LANE routing below (the explicit-cloud-
    // root carve-out's `forceCloud`); CONTAINMENT-cloud dirs take `undefined` here and
    // are routed by the boundary's containment default. The readlink-first guard below
    // is gated more broadly (`currentDirIsCloudOrContained`, defined at that site): a
    // synchronous `readlinkSync` is only safe when the link's OWN inode lives in a
    // LOCAL parent dir, which is false inside a cloud dir by EITHER pattern OR
    // containment.
    //
    // `forceCloudWalk` (whole-subtree force): when the root is a known symlink-to-dead-
    // cloud-mount, every directory under it lives behind that same dead mount, so we OR
    // `FORCE_CLOUD_LANE` into this dir's lane option. This single merge propagates to ALL
    // ops keyed off `currentDirCloudOpt`: the `readdir` below, and (via `symlinkLaneOpt` /
    // `childLaneOpt`, which default to `currentDirCloudOpt`) every per-entry `stat` and
    // `realpath`. It also makes `currentDirIsCloud` true → `currentDirIsCloudOrContained`
    // true, so the SYNCHRONOUS readlink-first guard is correctly suppressed inside the dead
    // subtree (a sync `readlinkSync` on an inode that lives on the dead mount could block
    // the main thread). When `forceCloudWalk` is false this is byte-identical to the prior
    // `cloudLaneOptionForPath(currentDir)`.
    const currentDirCloudOpt: WorkspaceFsOptions | undefined = forceCloudWalk
      ? { ...cloudLaneOptionForPath(currentDir), ...FORCE_CLOUD_LANE }
      : cloudLaneOptionForPath(currentDir);
    const currentDirIsCloud = currentDirCloudOpt !== undefined;
    const readdirOutcome = await workspaceFs.readdirWithFileTypes(currentDir, currentDirCloudOpt);
    if (readdirOutcome.status === 'reconnecting') {
      // Dead/unresponsive cloud mount — bounded, reclaimed, reported incomplete.
      truncated.add('cloud-timeout');
      continue;
    }
    if (readdirOutcome.status === 'error') {
      // A real fs error (ENOENT/EACCES/…) — classify exactly as the prior bare path.
      truncated.add(classifyFsError(readdirOutcome.error));
      continue;
    }
    const entries = readdirOutcome.value;

    for (const entry of entries) {
      if (entriesVisited >= maxEntries) {
        truncated.add('entries');
        break;
      }
      entriesVisited += 1;

      if (options.signal?.aborted) {
        truncated.add('aborted');
        break;
      }

      const absolutePath = path.join(currentDir, entry.name);
      if (absolutePath.length > maxPathLength) {
        truncated.add('pathLength');
        continue;
      }

      // Plain file (not a symlink): no realpath needed. `WorkspaceDirent` exposes
      // the type predicates as booleans (serializable subset of `fs.Dirent`).
      if (entry.isFile) {
        if (options.onFile) {
          await options.onFile({
            absolutePath,
            name: entry.name,
            parentDir: currentDir,
            depth,
            viaSymlink: false,
          });
        }
        continue;
      }

      const isPlainDir = entry.isDirectory;
      const isSymlink = entry.isSymbolicLink;

      // Anything else (sockets, FIFOs, block devices) is silently skipped.
      if (!isPlainDir && !isSymlink) continue;

      // Stage 6b admission: a cloud symlink reached during descent is normally
      // SKIPPED (below). When the admission flag is ON and the space's off-thread
      // liveness verdict is `healthy`, we instead ADMIT it — descend as if local.
      // This is decided readlink-only (no mount touch) and is `'skip'` by default
      // (flag off) so behaviour is byte-identical to today unless explicitly
      // enabled. Once admitted, the entry's `fs.stat`/`fs.realpath` below
      // dereference the cloud mount from this LOCAL parent dir (before
      // `currentDirIsCloud` flips on the NEXT descent level), so they are BOUNDED
      // with the cloud budget — a mount that dies between the verdict read and
      // here can't block the main thread (GPT review Q3): it degrades to a
      // `cloud-timeout` truncation + skip, never a hang.
      //
      // S5 (flip-blocker RESOLVED): the readlink-first guard does a SYNCHRONOUS
      // `readlinkSync` (inside `walkToFirstCloudHopViaReadlink`) on the entry's own
      // inode, which is safe ONLY when that inode lives in a LOCAL parent dir. So we
      // gate it on `!currentDirIsCloudOrContained` — false whenever `currentDir` is a
      // cloud dir by EITHER the PATTERN flag (the explicit-cloud-root carve-out) OR
      // CONTAINMENT (`classifyWorkspacePath` = `isUnderCloudSpace` — a configured space
      // we descended into with the flag ON). Inside such a dir the entry's inode is ON
      // the mount, so a sync readlink could block the main thread on a dead mount;
      // those nested symlinks instead take the async, boundary-bounded stat/realpath
      // path below (the boundary containment-routes them to the killable cloud lane →
      // a dead mount degrades to `cloud-timeout` + skip, never a hang). Nested-symlink
      // descend-vs-skip is thereby UNIFORM across pattern- and containment-cloud dirs
      // (both stat-follow via the bounded lane; the realpath backstop still skips one
      // that resolves into a pattern-cloud mount). With the admission flag OFF this is
      // byte-identical to today — no cloud dir is ever admitted, so `currentDir` is
      // never cloud mid-walk and the gate's extra term never fires.
      const currentDirIsCloudOrContained =
        currentDirIsCloud || classifyWorkspacePath(currentDir) === 'cloud';
      let admittedCloudSymlink = false;
      if (isSymlink && skipCloudSymlinkTargets && !currentDirIsCloudOrContained) {
        const classification = walkToFirstCloudHopViaReadlink(absolutePath);
        if (classification.kind === 'cloud') {
          if (resolveCloudSymlinkAdmission(absolutePath) === 'admit') {
            admittedCloudSymlink = true;
          } else {
            truncated.add('cloud-symlink-skipped');
            continue;
          }
        }
      }

      // For symlinks, follow the link via stat to learn whether it targets
      // a file or directory. Broken symlinks → boundary `error` → skip them.
      //
      // RS-F1 — READLINK-FIRST cloud classification + Stage-6b admission both ran
      // ABOVE (before this block): a proven cloud symlink was either SKIPPED
      // (`cloud-symlink-skipped` + `continue`, default) or marked
      // `admittedCloudSymlink` (flag on + healthy verdict). `local-terminus` /
      // fail-closed `unclassifiable` (dangling / dead-FIRST-hop / hop-cap) cases
      // were NOT classified cloud, so they reach here and take the boundary's stat
      // with byte-identical handling (a dangling non-cloud symlink → `error` →
      // silent `continue`). The readlink classification is GATED to a LOCAL
      // `currentDir` (`!currentDirIsCloudOrContained`): inside a cloud dir (pattern OR
      // containment) the parent IS the (possibly dead) mount, so a sync readlink there
      // could block the MAIN thread — those nested symlinks keep the async
      // (boundary-bounded) path.
      //
      // Lane (S4.1a): the stat DEREFERENCES the target, so it must take the cloud
      // lane whenever the target can be a cloud mount: an ADMITTED cloud symlink (its
      // proven-cloud target, reached from a LOCAL parent) → force cloud; OR a symlink
      // inside the explicit-cloud-root carve-out (`currentDirIsCloud`) → its parent is
      // the mount → cloud lane (these two are mutually exclusive: admission only runs
      // when `!currentDirIsCloudOrContained`). A symlink inside a CONTAINMENT-cloud dir
      // takes `currentDirCloudOpt === undefined` here but the boundary still routes it
      // to the cloud lane by its containment default. A non-cloud symlink in a local
      // parent takes the
      // bare-fs local lane (fast path unchanged). A dead mount → `reconnecting` →
      // `cloud-timeout` + skip, never a hang (killable-pool reclaim).
      if (isSymlink) {
        const symlinkLaneOpt: WorkspaceFsOptions | undefined = admittedCloudSymlink
          ? FORCE_CLOUD_LANE
          : currentDirCloudOpt;
        const statOutcome = await workspaceFs.stat(absolutePath, symlinkLaneOpt);
        if (statOutcome.status === 'reconnecting') {
          // Mount died between classification and here — degrade to skip, never hang.
          truncated.add('cloud-timeout');
          continue;
        }
        if (statOutcome.status === 'error') {
          // Broken/dangling symlink — skip silently (byte-identical to the prior
          // `catch { continue }`; broken symlinks are routine, not truncation).
          continue;
        }
        const targetStat = statOutcome.value;
        if (targetStat.isFile) {
          if (options.onFile) {
            await options.onFile({
              absolutePath,
              name: entry.name,
              parentDir: currentDir,
              depth,
              viaSymlink: true,
            });
          }
          continue;
        }
        if (!targetStat.isDirectory) {
          // Symlink to socket / device / etc. — skip.
          continue;
        }
        // Falls through to directory-descent path below.
      }

      // Directory descent: cycle check first, then optional caller filter.
      // realpath failures here mean we can't determine the canonical path —
      // typically EACCES (can't traverse to compute it) or ENOENT (race).
      // Either way the directory's descendants are unreachable; record as
      // truncation so destructive consumers don't trust the partial walk.
      //
      // Lane (S4.1a): same rule as the symlink stat above — an ADMITTED cloud
      // symlink-to-dir OR any entry inside the explicit-cloud-root carve-out
      // (`currentDirIsCloud`) dereferences a cloud mount → cloud lane; a plain local
      // dir / non-cloud symlink takes the bare-fs local lane. Unlike the ROOT realpath
      // (R-MUST-3), a MID-WALK realpath keeps the generic `error → classifyFsError`
      // truncation mapping (and `reconnecting → cloud-timeout`).
      const childLaneOpt: WorkspaceFsOptions | undefined = admittedCloudSymlink
        ? FORCE_CLOUD_LANE
        : currentDirCloudOpt;
      const realpathOutcome = await workspaceFs.realpath(absolutePath, childLaneOpt);
      if (realpathOutcome.status === 'reconnecting') {
        truncated.add('cloud-timeout');
        continue;
      }
      if (realpathOutcome.status === 'error') {
        truncated.add(classifyFsError(realpathOutcome.error));
        continue;
      }
      const childRealPath = realpathOutcome.value;

      if (visited.has(childRealPath)) {
        // Already-visited canonical path. Silently skip to break cycles.
        continue;
      }

      // Incidental cloud-symlink guard (default-on) — REALPATH BACKSTOP only.
      // The READLINK-FIRST classifier above already skipped every symlink whose
      // chain proves cloud, without touching the (possibly dead) mount (RS-F1).
      // This residual check covers the rare case a symlink the readlink walker
      // could NOT prove cloud (`local-terminus`/`unclassifiable`) nonetheless
      // realpath-resolves into a cloud mount — a hang trap whose readdir/stat
      // block on FUSE/network I/O (RC-1). We reuse `childRealPath` (already
      // computed above for cycle detection) — no extra realpath, no behaviour
      // change vs the pre-RS-F1 guard. Only symlinks are checked: a plain dir
      // under a cloud path is only reachable if we already followed a cloud
      // symlink, which this prevents. The explicitly-targeted root never reaches
      // here (resolved up front), so naming a cloud folder as `rootDir` still
      // walks. Stage 6b: an ADMITTED cloud symlink (flag on + healthy verdict) is
      // EXEMPT from this backstop — the readlink classifier proved it cloud and
      // admission chose to descend, so re-skipping here would defeat admission.
      if (
        skipCloudSymlinkTargets &&
        isSymlink &&
        !admittedCloudSymlink &&
        shouldSkipCloudSymlinkTarget(childRealPath).skip
      ) {
        truncated.add('cloud-symlink-skipped');
        continue;
      }

      const dirInfo: SafeWalkDirInfo = {
        absolutePath,
        name: entry.name,
        parentDir: currentDir,
        depth,
        isSymbolicLink: isSymlink,
      };

      if (options.onDirectory) {
        const decision = await options.onDirectory(dirInfo);
        if (decision === false) continue;
      }

      visited.add(childRealPath);
      queue.push({ absolutePath, depth: depth + 1 });
    }

    if (entriesVisited >= maxEntries) break;
  }

  const truncatedReasons = Object.freeze(Array.from(truncated));

  if (truncatedReasons.length > 0 && options.onTruncated) {
    options.onTruncated({
      rootDir,
      reasons: truncatedReasons,
      entriesVisited,
    });
  }

  return {
    entriesVisited,
    truncatedReasons,
    rootRealPath,
  };
}

/**
 * Convenience: collect all files matching a predicate. Returns an array of
 * absolute paths in walk order. Suitable for callers that just need file
 * paths and don't care about per-directory inspection.
 */
export async function safeListFiles(
  rootDir: string,
  predicate: (info: SafeWalkFileInfo) => boolean,
  options: Omit<SafeWalkOptions, 'onFile'> = {},
): Promise<{ files: string[]; result: SafeWalkResult }> {
  const files: string[] = [];
  const result = await safeWalkDirectory(rootDir, {
    ...options,
    onFile: (info) => {
      if (predicate(info)) files.push(info.absolutePath);
    },
  });
  return { files, result };
}
