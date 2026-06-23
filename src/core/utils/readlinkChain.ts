/**
 * readlinkChain — walk a symlink chain using `readlinkSync` ONLY.
 *
 * The single hard rule of this module: it NEVER calls `realpath`/`stat`/`access`
 * on the chain. `readlinkSync` reads the link's OWN inode (which lives in the
 * local parent directory), so it returns instantly even when the chain points
 * into a dead/unresponsive cloud FUSE mount. `realpath`/`stat`/`access` would
 * dereference the target and block in the kernel with no timeout — that touch IS
 * the libuv-threadpool-exhaustion hang (0.4.48→0.4.49 class). See
 * docs/plans/260619_cloud-symlink-indexing/PLAN.md (RS-F1/F9) and
 * src/main/services/workspaceWatcherService.ts `classifySymlinkChainViaReadlink`,
 * which this generalises so the cloud-liveness probe and the watcher share ONE
 * readlink-only walker.
 *
 * Pure, synchronous, no I/O beyond `readlinkSync`. Safe in `src/core/` (no
 * `electron` import; Node `fs`/`path` only — RN/cloud never call the readlink
 * minter, they get the no-op probe).
 */
import { readlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { detectCloudStorage } from '@core/utils/cloudStorageUtils';

/**
 * Max symlink hops before we give up and fail closed. Mirrors
 * `MAX_SYMLINK_CHAIN_HOPS` in workspaceWatcherService — a chain longer than this
 * is treated as unclassifiable (cycle / pathological link farm).
 */
export const MAX_SYMLINK_CHAIN_HOPS = 8;

/**
 * Outcome of walking a symlink chain with `readlinkSync` only.
 *
 * - `kind: 'terminus'` — the chain bottomed out at a real (non-symlink) path.
 *   `path` is the absolute terminus. If the input was not a symlink at all,
 *   `path` is the (resolved-to-absolute) input and `hops` is 0.
 * - `kind: 'broken'`   — a `readlinkSync` hop threw something other than EINVAL
 *   (ENOENT/EACCES/ELOOP/EIO/timeout/…). We cannot prove a terminus without
 *   touching the target, so we stop. `lastTarget` is the deepest hop we resolved
 *   to a string (may be the input).
 * - `kind: 'too-long'` — the hop cap was exceeded.
 */
export type ReadlinkChainResult =
  | { readonly kind: 'terminus'; readonly path: string; readonly hops: number }
  | { readonly kind: 'broken'; readonly lastTarget: string; readonly code?: string }
  | { readonly kind: 'too-long' };

/**
 * Walk a symlink chain starting at `startPath` using `readlinkSync` ONLY.
 *
 * NEVER dereferences the target (no realpath/stat/access) — returns instantly
 * even on a dead cloud mount. Resolves each relative hop against its parent
 * directory so the walk follows the on-disk topology without touching the
 * (possibly dead) target.
 *
 * @returns a {@link ReadlinkChainResult}. Callers that need fail-closed
 *   behaviour should treat anything but `kind: 'terminus'` as "cannot prove
 *   safe → exclude".
 */
export function walkSymlinkChainViaReadlink(startPath: string): ReadlinkChainResult {
  let current = isAbsolute(startPath) ? startPath : resolve(startPath);
  for (let hop = 0; hop < MAX_SYMLINK_CHAIN_HOPS; hop++) {
    let rawTarget: string;
    try {
      rawTarget = readlinkSync(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EINVAL') {
        // `current` is not a symlink — the chain bottomed out at a real path.
        return { kind: 'terminus', path: current, hops: hop };
      }
      // ENOENT / EACCES / ELOOP / EIO / timeout, etc. — cannot prove a terminus
      // without dereferencing (which we refuse to do). Stop and report broken.
      return { kind: 'broken', lastTarget: current, code };
    }
    current = isAbsolute(rawTarget) ? rawTarget : resolve(dirname(current), rawTarget);
  }
  // Chain too long to resolve within the hop cap — fail closed.
  return { kind: 'too-long' };
}

/**
 * Outcome of walking a symlink chain with `readlinkSync` only, STOPPING at the
 * first cloud-classified hop.
 *
 * - `kind: 'cloud'`         — a hop pointed at a cloud-storage path. `target` is
 *   that first cloud hop's target (the path we want an off-thread prober to
 *   check). We STOP here and NEVER `readlinkSync` past it — once a hop is inside a
 *   dead FUSE mount, even `readlinkSync` on the next inode (which lives in the
 *   mount's directory) blocks. This is the load-bearing F2 safety property.
 * - `kind: 'local-terminus'`— the chain bottomed out at a real, non-cloud path
 *   (every hop classified non-cloud). `path` is that terminus. Not a prewarm
 *   target (it is a genuinely local space, e.g. `rebel-system → /Applications/…`).
 * - `kind: 'unclassifiable'`— a `readlinkSync` hop threw something other than
 *   EINVAL (dangling link / dead mount on the FIRST hop / timeout) or the hop cap
 *   was exceeded. We could not prove cloud-ness without touching the target, so we
 *   fail closed — callers skip (no prewarm target).
 */
export type FirstCloudHopResult =
  | { readonly kind: 'cloud'; readonly target: string }
  | { readonly kind: 'local-terminus'; readonly path: string }
  | { readonly kind: 'unclassifiable'; readonly code?: string };

/**
 * Walk a symlink chain starting at `startPath` using `readlinkSync` ONLY, checking
 * the cloud-storage pattern at EVERY hop and STOPPING at the first cloud-classified
 * hop — returning that hop's target.
 *
 * This is the generalised, target-returning form of
 * `workspaceWatcherService.classifySymlinkChainViaReadlink` (which returns a
 * `{skip}` classification, not a target). Both the cloud-liveness prewarm
 * (deriving the probe target / verdict-cache key) and the watcher want EXACTLY
 * this walk: a Drive link may be chained through an intermediate LOCAL alias
 * (`workspace/link → ~/DriveAlias → ~/Library/CloudStorage/GoogleDrive-…`), so a
 * non-cloud FIRST target does NOT prove the destination is local — but the moment
 * a hop IS cloud, we must stop and probe THAT target off-thread, never
 * `readlinkSync` further into the (possibly dead) mount.
 *
 * `detectCloudStorage` is a pure string match (no I/O), checked on BOTH the raw
 * link target and its parent-resolved form at each hop (catches a relative link
 * whose cloud-ness only shows once joined to the parent dir).
 *
 * @returns a {@link FirstCloudHopResult}. Callers wanting a cloud probe target use
 *   `kind: 'cloud'`; anything else means "no cloud target here" (local space, or
 *   unclassifiable → fail closed → skip).
 */
export function walkToFirstCloudHopViaReadlink(startPath: string): FirstCloudHopResult {
  let current = isAbsolute(startPath) ? startPath : resolve(startPath);
  for (let hop = 0; hop < MAX_SYMLINK_CHAIN_HOPS; hop++) {
    let rawTarget: string;
    try {
      rawTarget = readlinkSync(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EINVAL') {
        // `current` is not a symlink — the chain bottomed out at a real file/dir.
        // We checked the cloud pattern on every hop on the way here, so reaching a
        // non-cloud terminus means the chain is provably local.
        return { kind: 'local-terminus', path: current };
      }
      // ENOENT / EACCES / ELOOP / EIO / timeout, etc. — cannot prove cloud-ness
      // without dereferencing (which we refuse to do). Fail closed.
      return { kind: 'unclassifiable', code };
    }
    const nextTarget = isAbsolute(rawTarget) ? rawTarget : resolve(dirname(current), rawTarget);
    // Cloud-pattern check on BOTH the raw target and its resolved form. The raw
    // target catches a relative-but-cloud-pointing link (`../CloudStorage/…`); the
    // resolved form catches a relative link whose cloud-ness only shows up once
    // joined to the parent dir.
    if (detectCloudStorage(rawTarget).isCloud || detectCloudStorage(nextTarget).isCloud) {
      // STOP HERE — return this first cloud hop's target. NEVER readlink past it:
      // the next inode would live in the (possibly dead) mount's directory.
      return { kind: 'cloud', target: nextTarget };
    }
    current = nextTarget;
  }
  // Chain too long to resolve within the hop cap — fail closed.
  return { kind: 'unclassifiable' };
}
