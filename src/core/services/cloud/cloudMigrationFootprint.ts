/**
 * Cloud Migration Footprint
 *
 * Measures the total bytes that would be uploaded during cloud migration so
 * the provisioning UI can recommend a right-sized volume instead of defaulting
 * to an arbitrary constant.
 *
 * Walks `coreDirectory` (the workspace) with `WORKSPACE_SKIP_DIRS` and the
 * userData path with `APP_DATA_SKIP`. The skip sets live in `migrationSkipLists`
 * so they cannot drift from what `cloudMigrationService.uploadWorkspaceFiles` /
 * `uploadAppData` actually upload.
 *
 * Returns a discriminated `FootprintOutcome`:
 *   - `measured_zero`    — empty workspace & no app-data (still valid).
 *   - `measured_nonzero` — scan finished with a reliable total.
 *   - `unknown_partial`  — scan could not produce an authoritative total
 *                          (timeout, permission denied, mount error, symlink
 *                          cycle, or missing userData mount point). Renderer
 *                          surfaces an interactive dialog.
 *
 * "No fabrication" contract
 * -------------------------
 * We never claim `measured_zero` for a subtree we couldn't actually read. If
 * any dir/file under the scan raises EACCES / EIO / ELOOP (or the visited-
 * inode cycle guard fires), the whole outcome becomes `unknown_partial`, with
 * `partialBytes` reflecting whatever we managed to count before the error.
 *
 * The one exception is a *legitimately* missing `coreDirectory` root — that's
 * "user has no workspace yet" and stays `measured_zero` per Stage 1 spec.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 1 — Shared Utilities; Review-Driven Amendments → Stage 1)
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { WORKSPACE_SKIP_DIRS, APP_DATA_SKIP } from './migrationSkipLists';
import type { FootprintOutcome, FootprintPartialReason } from '@shared/cloudMigrationTypes';

const log = createScopedLogger({ service: 'cloudMigrationFootprint' });

export interface FootprintClock {
  now(): number;
}

const DEFAULT_CLOCK: FootprintClock = {
  now: () => Date.now(),
};

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Severity order for picking the "most specific" reason when multiple errors
 * are encountered during a single scan. Higher number wins. Timeout is the
 * weakest reason — if anything more specific happened, report that instead.
 */
const REASON_PRIORITY: Record<FootprintPartialReason, number> = {
  permission: 4,
  mount_error: 3,
  symlink_cycle: 2,
  timeout: 1,
};

export interface FootprintOptions {
  /** Workspace root (from `AppSettings.coreDirectory`). May be `null` / undefined. */
  coreDirectory?: string | null;
  /** Electron `userData` path. Required — app-data is always measured. */
  userDataPath: string;
  /** Top-level timeout. Defaults to 2000 ms. */
  timeoutMs?: number;
  /** Injectable clock for tests. */
  clock?: FootprintClock;
}

/**
 * Measure the cloud-migration footprint. Never throws — errors are folded
 * into an `unknown_partial` outcome so callers can branch cleanly.
 *
 * The promise resolves with the outcome plus `durationMs` for observability.
 */
export async function getCloudMigrationFootprint(
  opts: FootprintOptions,
): Promise<FootprintOutcome & { durationMs: number }> {
  const clock = opts.clock ?? DEFAULT_CLOCK;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = clock.now();

  // `userDataPath` is required — a missing/empty/nonexistent mount point is
  // NOT "user has no app data", it's "we can't see the mount". Fail closed to
  // unknown_partial so the UI can ask the user instead of silently claiming
  // zero bytes.
  const userDataPath = opts.userDataPath?.trim() ?? '';
  if (!userDataPath) {
    return emitPartial({
      reason: 'mount_error',
      partialBytes: 0,
      startedMs: started,
      clock,
      detail: 'userDataPath empty or undefined',
    });
  }

  const ctx: WalkContext = {
    ancestorInodes: new Set<string>(),
    deadline: started + timeoutMs,
    clock,
    startedMs: started,
    worstReason: null,
    aborted: false,
    bytesSoFar: 0,
  };

  // ---- Workspace (coreDirectory) -----------------------------------------
  let workspaceBytes: number | undefined;
  const coreDir = opts.coreDirectory?.trim() ? opts.coreDirectory : null;

  if (coreDir) {
    const rootStat = await statRoot(coreDir);
    if (rootStat.kind === 'missing') {
      // Legitimately-missing `coreDirectory` root: "user has no workspace yet"
      // remains `measured_zero` per Stage 1 spec. (Only applies to the
      // workspace root — userData missing is handled above.)
      workspaceBytes = 0;
    } else if (rootStat.kind === 'error') {
      return emitPartial({
        reason: rootStat.reason,
        partialBytes: ctx.bytesSoFar,
        startedMs: started,
        clock,
        detail: `coreDirectory root stat failed (${rootStat.reason})`,
      });
    } else {
      const before = ctx.bytesSoFar;
      await walk(coreDir, WORKSPACE_SKIP_DIRS, ctx);
      workspaceBytes = ctx.bytesSoFar - before;
    }
  }

  // ---- App data (userData) -----------------------------------------------
  // Reset the ancestor-inode stack between independent top-level walks: a
  // symlink leading out of the workspace and into userData (or vice versa)
  // must not poison the second walk's cycle detection. (In practice the
  // stack should already be empty after walk() unwinds, but clear defensively.)
  ctx.ancestorInodes.clear();

  const appDataBefore = ctx.bytesSoFar;
  if (!ctx.aborted) {
    const appDataRootStat = await statRoot(userDataPath);
    if (appDataRootStat.kind === 'missing') {
      // userData mount-point disappeared between the preflight check above
      // and now: this is a mount error, not "zero bytes".
      return emitPartial({
        reason: 'mount_error',
        partialBytes: ctx.bytesSoFar,
        startedMs: started,
        clock,
        detail: 'userDataPath missing at walk time',
      });
    }
    if (appDataRootStat.kind === 'error') {
      return emitPartial({
        reason: appDataRootStat.reason,
        partialBytes: ctx.bytesSoFar,
        startedMs: started,
        clock,
        detail: `userDataPath root stat failed (${appDataRootStat.reason})`,
      });
    }
    await walk(userDataPath, APP_DATA_SKIP, ctx);
  }

  // If we encountered any subtree-level error during either walk, we cannot
  // claim a clean total — return the accumulated partial with the highest-
  // priority reason observed.
  if (ctx.worstReason !== null) {
    return emitPartial({
      reason: ctx.worstReason,
      partialBytes: ctx.bytesSoFar,
      startedMs: started,
      clock,
    });
  }

  const appDataBytes = ctx.bytesSoFar - appDataBefore;
  const totalBytes = ctx.bytesSoFar;
  const durationMs = Math.max(0, clock.now() - started);

  if (totalBytes === 0) {
    const outcome: FootprintOutcome = {
      kind: 'measured_zero',
      totalBytes: 0,
      workspaceBytes: 0,
      appDataBytes,
    };
    log.info(
      {
        event: 'footprint.result',
        kind: 'measured_zero',
        totalBytes: 0,
        workspaceBytes: 0,
        appDataBytes,
        elapsed_ms: durationMs,
      },
      'Cloud migration footprint scan complete',
    );
    return { ...outcome, durationMs };
  }

  const outcome: FootprintOutcome = {
    kind: 'measured_nonzero',
    totalBytes,
    ...(workspaceBytes !== undefined ? { workspaceBytes } : {}),
    appDataBytes,
  };
  log.info(
    {
      event: 'footprint.result',
      kind: 'measured_nonzero',
      totalBytes,
      workspaceBytes,
      appDataBytes,
      elapsed_ms: durationMs,
    },
    'Cloud migration footprint scan complete',
  );
  return { ...outcome, durationMs };
}

// ---------------------------------------------------------------------------
// Implementation detail
// ---------------------------------------------------------------------------

interface WalkContext {
  /**
   * Tracks directory inodes currently ON THE RECURSION PATH (i.e., ancestors
   * of the directory being walked right now). We push before descending
   * into a directory symlink and pop afterwards — that means a true cycle
   * (a → b → a, where `a` is still on the stack when `b` links back) fires
   * `symlink_cycle`, but a plain alias (two different directory symlinks
   * to the same target, walked at different times, never overlapping)
   * does not. This matches the standard "DFS ancestor set" cycle check.
   *
   * Keys follow `dev:ino` (normal case) or `dev:absolutePath` when `ino`
   * is 0 — Windows / some filesystems return `ino === 0`, which would
   * otherwise collapse every entry into the same bucket and defeat the
   * guard. Only populated for directory symlinks; regular files and file
   * symlinks terminate naturally and can't form a cycle.
   */
  ancestorInodes: Set<string>;
  readonly deadline: number;
  readonly clock: FootprintClock;
  readonly startedMs: number;
  worstReason: FootprintPartialReason | null;
  aborted: boolean;
  bytesSoFar: number;
}

type RootStat =
  | { kind: 'ok' }
  | { kind: 'missing' }
  | { kind: 'error'; reason: FootprintPartialReason };

async function statRoot(p: string): Promise<RootStat> {
  try {
    await fsPromises.stat(p);
    return { kind: 'ok' };
  } catch (err) {
    const reason = classifyFsError(err);
    if (reason === null) {
      // Treat unknown errors on the root as mount errors — we can't
      // meaningfully walk past this.
      return { kind: 'error', reason: 'mount_error' };
    }
    if (reason === 'missing') {
      return { kind: 'missing' };
    }
    return { kind: 'error', reason };
  }
}

/**
 * Record a partial-reason observation. Keeps the highest-priority reason
 * seen so far. Does not abort the walk — timeouts handle abort separately.
 */
function recordError(ctx: WalkContext, reason: FootprintPartialReason): void {
  if (
    ctx.worstReason === null ||
    REASON_PRIORITY[reason] > REASON_PRIORITY[ctx.worstReason]
  ) {
    ctx.worstReason = reason;
  }
}

async function walk(
  dir: string,
  skip: ReadonlySet<string>,
  ctx: WalkContext,
): Promise<void> {
  if (ctx.aborted) return;
  if (ctx.clock.now() >= ctx.deadline) {
    recordError(ctx, 'timeout');
    ctx.aborted = true;
    return;
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const reason = classifyFsError(err);
    if (reason === 'missing') {
      // Dir disappeared mid-walk — benign, skip silently.
      return;
    }
    const resolved: FootprintPartialReason = reason ?? 'mount_error';
    log.warn(
      {
        event: 'footprint.partial',
        reason: resolved,
        elapsed_ms: elapsedMs(ctx),
        scanned_bytes: ctx.bytesSoFar,
        dir,
        err: String(err),
      },
      'Footprint scan: readdir failed, skipping subtree',
    );
    recordError(ctx, resolved);
    return;
  }

  for (const entry of entries) {
    if (ctx.aborted) return;
    if (ctx.clock.now() >= ctx.deadline) {
      recordError(ctx, 'timeout');
      ctx.aborted = true;
      return;
    }
    if (skip.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walk(fullPath, skip, ctx);
    } else if (entry.isSymbolicLink()) {
      // Resolve symlink target. `readdir({withFileTypes:true})` already gave
      // us `isSymbolicLink()` — we effectively have the lstat result. Now
      // stat-through to see whether the target is a dir (recurse) or file
      // (count bytes).
      let targetStat: import('node:fs').Stats;
      try {
        targetStat = await fsPromises.stat(fullPath);
      } catch (err) {
        const reason = classifyFsError(err);
        if (reason === 'missing') {
          // Broken symlink — skip silently, matches uploader behaviour.
          continue;
        }
        if (reason === null) {
          // Unknown symlink error — skip the one entry and keep going, but
          // record a mount_error so the outcome reflects it.
          log.warn(
            {
              event: 'footprint.partial',
              reason: 'mount_error',
              elapsed_ms: elapsedMs(ctx),
              scanned_bytes: ctx.bytesSoFar,
              path: fullPath,
              err: String(err),
            },
            'Footprint scan: symlink stat failed',
          );
          recordError(ctx, 'mount_error');
          continue;
        }
        log.warn(
          {
            event: 'footprint.partial',
            reason,
            elapsed_ms: elapsedMs(ctx),
            scanned_bytes: ctx.bytesSoFar,
            path: fullPath,
          },
          'Footprint scan: symlink stat failed',
        );
        recordError(ctx, reason);
        continue;
      }

      if (targetStat.isDirectory()) {
        // Cycle detection applies ONLY to directory symlinks — those can
        // form an infinite walk if they re-enter a directory already on
        // the current recursion path (a → b → a). Two separate dir
        // symlinks pointing to the same target but walked at different
        // times are just aliases, not cycles, so we push/pop from an
        // *ancestor* set (DFS) rather than a global visited set.
        //
        // File symlinks that resolve to an already-seen inode are NOT
        // cycles either — they're plain aliases (e.g. `CLAUDE.md ->
        // AGENTS.md` in a repo that has both names). Counting their bytes
        // twice matches uploader behaviour, which treats each symlink as
        // its own upload path. See postmortem
        // 260422_footprint_symlink_cycle_false_positive.
        const cycleKey = visitedKey(targetStat, fullPath);
        if (ctx.ancestorInodes.has(cycleKey)) {
          log.warn(
            {
              event: 'footprint.partial',
              reason: 'symlink_cycle',
              elapsed_ms: elapsedMs(ctx),
              scanned_bytes: ctx.bytesSoFar,
              path: fullPath,
            },
            'Footprint scan: symlink cycle detected, skipping',
          );
          recordError(ctx, 'symlink_cycle');
          continue;
        }
        ctx.ancestorInodes.add(cycleKey);
        try {
          await walk(fullPath, skip, ctx);
        } finally {
          ctx.ancestorInodes.delete(cycleKey);
        }
      } else if (targetStat.isFile()) {
        ctx.bytesSoFar += targetStat.size;
      }
    } else if (entry.isFile()) {
      try {
        const st = await fsPromises.stat(fullPath);
        ctx.bytesSoFar += st.size;
      } catch (err) {
        const reason = classifyFsError(err);
        if (reason === 'missing') {
          // File vanished between readdir and stat — benign.
          continue;
        }
        const resolved: FootprintPartialReason = reason ?? 'mount_error';
        log.warn(
          {
            event: 'footprint.partial',
            reason: resolved,
            elapsed_ms: elapsedMs(ctx),
            scanned_bytes: ctx.bytesSoFar,
            path: fullPath,
            err: String(err),
          },
          'Footprint scan: file stat failed',
        );
        recordError(ctx, resolved);
        continue;
      }
    }
    // Ignore sockets/block devices/etc — they don't contribute bytes.
  }
}

/**
 * Build the ancestor-set key for cycle detection. See {@link WalkContext.ancestorInodes}.
 */
function visitedKey(st: import('node:fs').Stats, absPath: string): string {
  const dev = typeof st.dev === 'number' ? st.dev : 0;
  if (typeof st.ino === 'number' && st.ino > 0) {
    return `${dev}:${st.ino}`;
  }
  return `${dev}:${absPath}`;
}

function elapsedMs(ctx: WalkContext): number {
  return Math.max(0, ctx.clock.now() - ctx.startedMs);
}

/**
 * Classify a Node fs error. `null` means "unknown — caller decides".
 * `'missing'` is intentionally not part of `FootprintPartialReason`: ENOENT
 * is frequently benign (file deleted mid-walk) and must be handled by the
 * caller rather than abort the whole scan.
 */
function classifyFsError(err: unknown): FootprintPartialReason | 'missing' | null {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: string }).code;
    switch (code) {
      case 'ENOENT':
        return 'missing';
      case 'EACCES':
      case 'EPERM':
        return 'permission';
      case 'ELOOP':
        return 'symlink_cycle';
      case 'EIO':
      case 'ENXIO':
      case 'ENOTCONN':
      case 'EHOSTDOWN':
      case 'EHOSTUNREACH':
      case 'ENETDOWN':
      case 'ENETUNREACH':
      case 'EBUSY':
        return 'mount_error';
      case undefined:
        return null;
    }
  }
  return null;
}

/**
 * Emit an `unknown_partial` outcome with a structured `footprint.partial`
 * top-level log. Centralised so every partial path emits the same shape.
 */
function emitPartial(args: {
  reason: FootprintPartialReason;
  partialBytes: number;
  startedMs: number;
  clock: FootprintClock;
  detail?: string;
}): FootprintOutcome & { durationMs: number } {
  const durationMs = Math.max(0, args.clock.now() - args.startedMs);
  log.warn(
    {
      event: 'footprint.partial',
      reason: args.reason,
      elapsed_ms: durationMs,
      scanned_bytes: args.partialBytes,
      ...(args.detail ? { detail: args.detail } : {}),
    },
    'Cloud migration footprint scan partial',
  );
  log.info(
    {
      event: 'footprint.result',
      kind: 'unknown_partial',
      reason: args.reason,
      partialBytes: args.partialBytes,
      elapsed_ms: durationMs,
    },
    'Cloud migration footprint scan partial',
  );
  return {
    kind: 'unknown_partial',
    reason: args.reason,
    partialBytes: args.partialBytes,
    durationMs,
  };
}
