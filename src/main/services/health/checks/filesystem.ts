/**
 * Filesystem Health Checks
 */

import { getPlatformConfig } from '@core/platform';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import type { CheckResult } from '../types';
import {
  detectCloudStorage,
  detectInPlaceCloudDocuments,
  getTimeoutForPath,
  FS_TIMEOUT_CLOUD_MS,
} from '../../../utils/cloudStorageUtils';

const log = createScopedLogger({ service: 'healthCheck:filesystem' });

// =============================================================================
// Workspace-access health-check budget (Bug A + Bug C — timeout coherence)
// =============================================================================

/**
 * Max probe attempts in the *health-check* path (`checkWorkspaceAccessible`).
 *
 * The user-initiated validators (`system:validate-workspace-access`, onboarding)
 * keep the default 3-attempt budget — they are explicit, foreground, and have no
 * outer wrapper racing them. The health path is fired ~47-wide via `Promise.all`
 * inside `safeCheck`; a 3×@up-to-15s+backoff (~ tens of seconds) budget there
 * both balloons quick-tier health AND gets cut off at the wrapper, leaving
 * abandoned retries running in the background and producing a false `critical`.
 *
 * Two bounded attempts is enough to ride out a QUICK transient (EBUSY / EPERM /
 * ENOENT-on-read / DATA_MISMATCH — these clear sub-second). Crucially the health
 * path runs with `retryOnTimeout: false` (see ProbeWorkspaceOptions), so an
 * `ETIMEDOUT` is terminal after the FIRST attempt at the detection-informed
 * budget — we do NOT spend a second full 15s attempt on a slow mount. This keeps
 * the health-path worst case to ≈ one 15s cloud op + one sub-second backoff (the
 * quick-transient case), which fits strictly inside the wrapper below.
 */
export const WORKSPACE_ACCESS_HEALTH_MAX_ATTEMPTS = 2;

/** Exponential backoff base (ms) for probe retries: 500, 1000, 2000, … */
const PROBE_RETRY_BACKOFF_BASE_MS = 500;

/**
 * Short per-attempt budget for a HEALTH-path retry that follows a QUICK transient
 * (EBUSY/EPERM/ENOENT-on-read/DATA_MISMATCH). These clear sub-second, so the
 * retry attempt does not need the full cloud budget — bounding it keeps the
 * multi-attempt budget small. Health-path only (gated on retryOnTimeout being
 * false); foreground/onboarding retries keep the full budget.
 */
const WORKSPACE_QUICK_RETRY_BUDGET_MS = 2_000;

/**
 * STRUCTURAL whole-call budget for the HEALTH path (GPT-5.5-high F1 round 3).
 *
 * Rounds 1-2 bounded each op, then each ATTEMPT — but the loop-level
 * `cleanupProbeFiles` after an attempt settled still used the full `timeoutMs`
 * per leftover file, so a slow cloud `unlink` could run past the attempt deadline
 * and race the `safeCheck` wrapper. To end that "another sub-op" class for good,
 * the HEALTH path now bounds the ENTIRE `probeWorkspaceAccess` call — all
 * attempts + backoffs + the final cleanup — by ONE overall deadline:
 *   - each attempt's per-attempt deadline is `min(now + timeoutMs, overallDeadline)`,
 *   - backoffs are clamped to the remaining overall budget,
 *   - the final `cleanupProbeFiles` is budget-aware (each unlink gets
 *     `min(remaining-overall, small-cap)`, and is SKIPPED with an observable log
 *     when the budget is spent or the signal aborted).
 * By construction the whole health call ≤ this value, no matter how many internal
 * ops/files. Sits comfortably under the `safeCheck` wrapper.
 */
const WORKSPACE_HEALTH_OVERALL_BUDGET_MS = 17_000;

/**
 * Per-file cap for the budget-aware final cleanup so a single slow `unlink` can't
 * consume the entire remaining overall budget.
 */
const WORKSPACE_CLEANUP_PER_FILE_CAP_MS = 2_000;

/**
 * Outer `safeCheck` timeout for the `workspaceAccessible` health check.
 *
 * INVARIANT (GPT-5.5-high F1, rounds 1-3): the wrapper MUST be ≥ the worst-case
 * whole-call health budget, so it never fires while the bounded inner policy is
 * still legitimately running (the Bug C root cause — a 14s wrapper recreated it
 * for a legit 15s cloud probe; per-op then per-attempt bounding still left the
 * final cleanup unbounded). The health path now bounds the ENTIRE call (attempts
 * + backoffs + cleanup) by `WORKSPACE_HEALTH_OVERALL_BUDGET_MS` (17s), so the
 * wrapper is sized strictly above it with margin. The abort signal threaded into
 * the probe is a true backstop, not the primary bound. An ~17s worst case only
 * when the mount is genuinely slow-hydrating is acceptable for a background health
 * check; failing fast and false-criticaling is worse.
 *
 * Mirrors the `SYSTEM_PROMPT_COHERENCE_TIMEOUT_MS` custom-timeout pattern at
 * `systemHealthService.ts`. A budget-math regression test in
 * `__tests__/systemHealthService.test.ts` pins
 * `computeHealthWorkspaceWorstCaseMs() < WORKSPACE_ACCESS_CHECK_TIMEOUT_MS`.
 */
export const WORKSPACE_ACCESS_CHECK_TIMEOUT_MS = 18_000;

/**
 * TRUE whole-call worst-case for the HEALTH path: the structural overall budget
 * that bounds all attempts + backoffs + the final cleanup. Exposed so a test can
 * assert the F1 invariant `worstCase < wrapper` by construction. Because the whole
 * `probeWorkspaceAccess` health call is clamped to
 * `WORKSPACE_HEALTH_OVERALL_BUDGET_MS` (including cleanup), this IS the bound.
 *
 * @internal Test seam — consumed only by the budget-math regression test in
 * `__tests__/systemHealthService.test.ts` (it just returns the constant below). The
 * default knip leg still tracks it via the `health/checks/index.ts` barrel re-export.
 */
export function computeHealthWorkspaceWorstCaseMs(): number {
  return WORKSPACE_HEALTH_OVERALL_BUDGET_MS;
}

// =============================================================================
// Timeout utilities
// =============================================================================

/**
 * Run an fs operation under a timeout and an optional AbortSignal.
 *
 * Takes a THUNK (not an already-created promise) so the underlying fs work is NOT
 * scheduled when the signal is already aborted — the F2 fix: with a pre-created
 * promise, `fs.unlink(probePath)` / `fs.writeFile(...)` had already been queued
 * before this helper could see the abort, leaking fs work after settlement. We
 * check `signal?.aborted` BEFORE invoking the thunk, so no NEW fs work is
 * scheduled post-abort.
 *
 * Callers should pass an op that forwards `{ signal }` to the underlying fs API
 * where supported: only `readFile` / `writeFile` honour it here and abort the
 * in-flight libuv op. `fs.stat`, `fs.mkdir`, and `fs.unlink` are invoked as plain
 * thunks (no signal forwarded), so their in-flight op is best-effort/
 * uncancellable and only abandoned by the race. Either way the race + the
 * pre-invoke guard guarantee the invariant that matters: no further fs work is
 * *scheduled* once the wrapper aborts.
 */
async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  operationName: string,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    throw new Error(`Operation '${operationName}' timed out after 0ms (aborted)`);
  }
  // timeoutId is assigned synchronously inside the Promise constructor before any await
  let timeoutId: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Operation '${operationName}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (signal) {
      onAbort = () =>
        reject(new Error(`Operation '${operationName}' timed out after ${timeoutMs}ms (aborted)`));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    // Invoke the thunk only after the abort check above, so an already-aborted
    // signal never schedules the fs side effect.
    const result = await Promise.race([operation(), timeoutPromise]);
    return result;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

// =============================================================================
// Shared workspace probe utilities
// =============================================================================

/** Result of probing a workspace path */
export interface WorkspaceProbeResult {
  accessible: boolean;
  code?: string;
  error?: string;
  resolvedPath?: string;
  created?: boolean;
  /**
   * True when the directory `stat` succeeded (the path exists and is a
   * directory) even if a later write/read step failed. Drives both the
   * ETIMEDOUT timeout escalation (only escalate when the dir provably exists)
   * and the honest remediation copy (distinguish "exists but slow" from
   * "unreachable / missing").
   */
  statSucceeded?: boolean;
}

/** Options for retry behavior on transient cloud sync errors */
export interface ProbeRetryOptions {
  /** Enable retry on transient errors (EBUSY, EPERM, ENOENT on read, DATA_MISMATCH) */
  enabled: boolean;
  /** Maximum number of attempts (default: 3 when enabled) */
  maxAttempts?: number;
}

/** Options for probing workspace access */
export interface ProbeWorkspaceOptions {
  /** If true, creates the directory if it doesn't exist */
  createIfMissing?: boolean;
  /** Override timeout for all operations (auto-detected if not provided) */
  timeoutMs?: number;
  /** Retry configuration for handling transient cloud sync errors */
  retry?: ProbeRetryOptions;
  /**
   * Whether an `ETIMEDOUT` result is retryable (and whether the per-attempt
   * timeout budget may escalate toward `FS_TIMEOUT_CLOUD_MS` on a timeout).
   *
   * Defaults to `true` for the FOREGROUND / onboarding paths
   * (`permissionsHandlers`, `systemHandlers`) — they have no outer wrapper, so a
   * second escalated attempt is fine and helps a slow mount succeed.
   *
   * The HEALTH path sets this `false` (GPT-5.5-high F1): a timeout there is the
   * slow/unreachable case, and the detection-informed budget (5s local / 15s
   * cloud-or-in-place-iCloud) is the SINGLE budget for it — we never spend a
   * second full 15s attempt, so the bounded worst-case wall-clock fits strictly
   * inside `WORKSPACE_ACCESS_CHECK_TIMEOUT_MS`. Quick transient codes (EBUSY /
   * EPERM / ENOENT-on-read / DATA_MISMATCH) are still retried regardless — they
   * clear sub-second.
   */
  retryOnTimeout?: boolean;
  /**
   * Abort signal from the outer health-check wrapper (`safeCheck`). When it
   * aborts, the retry loop stops scheduling new attempts and in-flight fs ops
   * are abandoned promptly (no background fs work after the check settles).
   */
  signal?: AbortSignal;
}

/**
 * Error codes that should trigger a retry.
 *
 * Most are transient cloud-sync interference (EBUSY/EPERM while OneDrive/Dropbox
 * etc. has the file open, DATA_MISMATCH when sync rewrites our probe file mid-flight).
 *
 * ETIMEDOUT is included because the timeout is also fired when the libuv thread
 * pool is saturated during heavy app startup (workspace manifest load, watcher
 * subscription, MCP spawning, network requests). The underlying fs syscall is
 * usually sub-millisecond; it just hasn't been scheduled yet when the timeout
 * fires. A short backoff lets the queue drain so the next attempt succeeds.
 * See docs-private/postmortems for the misleading "Path is unreachable" UX this avoids.
 */
const RETRYABLE_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'DATA_MISMATCH', 'ETIMEDOUT']);
/** Additional error codes retryable only during read operations */
const RETRYABLE_READ_ERROR_CODES = new Set(['ENOENT']);

/**
 * Classify whether an fs error is a timeout OR an abort. Native fs cancellation
 * (`{ signal }` on readFile/writeFile) rejects with an `AbortError`
 * (`code:'ABORT_ERR'` / `name:'AbortError'`), not a "timed out" message, so we
 * normalize both to the same ETIMEDOUT-shaped result the rest of the probe and
 * the remediation copy expect.
 */
function isTimeoutOrAbort(err: NodeJS.ErrnoException): boolean {
  return (
    err.message?.includes('timed out') === true ||
    err.code === 'ABORT_ERR' ||
    (err as Error).name === 'AbortError'
  );
}

/** Generate a unique probe filename to avoid cloud sync conflicts */
function generateProbeFilename(): string {
  const timestamp = Date.now();
  const shortId = crypto.randomUUID().slice(0, 8);
  return `.mindstonerebel-probe-${timestamp}-${shortId}.tmp`;
}

/**
 * Probes a directory path for accessibility by attempting to:
 * 1. Resolve the path to absolute
 * 2. Stat the path (verify it exists and is a directory)
 * 3. Optionally create it if missing (when createIfMissing is true)
 * 4. Write, read, and unlink a probe file to verify read/write access
 *
 * All fs operations are wrapped with timeouts to avoid blocking on
 * disconnected network drives. Cloud storage paths (OneDrive, Dropbox, etc.)
 * automatically get extended timeouts to allow for file hydration.
 *
 * When retry is enabled, the probe will retry on transient errors (EBUSY, EPERM,
 * ENOENT during read, DATA_MISMATCH) with exponential backoff. Each retry uses
 * a new unique filename to avoid sync conflicts.
 *
 * @param targetPath The path to probe
 * @param options.createIfMissing If true, creates the directory if it doesn't exist
 * @param options.timeoutMs Override timeout for all operations. If not provided,
 *        auto-detects based on whether the path is in cloud storage.
 * @param options.retry Enable retry on transient cloud sync errors
 * @param options.signal Abort signal from an outer wrapper; stops retries and
 *        abandons in-flight ops promptly when aborted.
 * @returns Result indicating whether the path is accessible
 */
export async function probeWorkspaceAccess(
  targetPath: string,
  options: ProbeWorkspaceOptions = {}
): Promise<WorkspaceProbeResult> {
  const { createIfMissing = false, retry, signal } = options;
  // Foreground/onboarding default: retry + escalate on timeout. The health path
  // overrides this to false so a timeout is terminal at the detection-informed
  // budget (F1 — keeps worst-case wall-clock inside the safeCheck wrapper).
  const retryOnTimeout = options.retryOnTimeout ?? true;
  const resolvedPath = path.resolve(targetPath);
  // Auto-detect timeout based on cloud storage, or use provided override
  const baseTimeoutMs = options.timeoutMs ?? getTimeoutForPath(resolvedPath);
  // Per-attempt timeout. Starts at the base budget and may be escalated toward
  // FS_TIMEOUT_CLOUD_MS after an empirical ETIMEDOUT on a directory that
  // provably exists (see below) — path-agnostic, so it self-corrects for
  // iCloud Desktop/Documents, SMB, AV scans, or libuv saturation that the static
  // detection missed. Escalation is gated on `retryOnTimeout`, so the health path
  // never grows a second 15s attempt.
  let timeoutMs = baseTimeoutMs;

  // Determine retry parameters
  const retryEnabled = retry?.enabled ?? false;
  const maxAttempts = retryEnabled ? (retry?.maxAttempts ?? 3) : 1;

  // F1 (round 3): the HEALTH path (retryOnTimeout:false) bounds the ENTIRE call —
  // every attempt + backoff + the final cleanup — by ONE overall deadline, so a
  // slow leftover-file unlink can't run past the budget and race the wrapper.
  // Foreground/onboarding (retryOnTimeout:true) keep their unbounded semantics.
  const overallDeadlineAt = retryOnTimeout
    ? undefined
    : Date.now() + WORKSPACE_HEALTH_OVERALL_BUDGET_MS;

  // Track all probe files for cleanup
  const probeFilesToCleanup: string[] = [];

  // Get cloud info for diagnostic logging
  const cloudInfo = retryEnabled ? detectCloudStorage(resolvedPath) : null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Stop before starting a new attempt if the outer wrapper has aborted, so we
    // never run abandoned fs work after the health check has already settled.
    if (signal?.aborted) {
      await cleanupProbeFiles(probeFilesToCleanup, timeoutMs, signal, overallDeadlineAt);
      return {
        accessible: false,
        code: 'ETIMEDOUT',
        error: 'Workspace access check aborted (operation timed out)',
        resolvedPath,
      };
    }

    const result = await probeWorkspaceAccessSingle(
      resolvedPath,
      timeoutMs,
      createIfMissing,
      probeFilesToCleanup,
      signal,
      overallDeadlineAt
    );

    // If successful or not retryable, return the result
    if (result.accessible || !retryEnabled || attempt >= maxAttempts) {
      // Best-effort cleanup of all probe files (budget-aware on the health path).
      await cleanupProbeFiles(probeFilesToCleanup, timeoutMs, signal, overallDeadlineAt);
      return result;
    }

    // Check if error is retryable.
    // - Quick transient codes (EBUSY/EPERM/DATA_MISMATCH, and ENOENT during read)
    //   clear sub-second → always retryable.
    // - ETIMEDOUT is retryable ONLY when retryOnTimeout is set (foreground paths).
    //   In the health path (retryOnTimeout:false) a timeout is terminal at the
    //   detection-informed budget, so the worst-case wall-clock stays inside the
    //   safeCheck wrapper (F1).
    // Note: ENOENT is only retryable during read operations (file deleted by cloud
    // sync); detected via the "Cannot read from directory" prefix added only for
    // read failures, not stat failures.
    const isTimeout = result.code === 'ETIMEDOUT';
    const isQuickRetryable =
      (RETRYABLE_ERROR_CODES.has(result.code ?? '') && !isTimeout) ||
      (result.code && RETRYABLE_READ_ERROR_CODES.has(result.code) &&
       result.error?.startsWith('Cannot read from directory'));
    const isRetryable = isQuickRetryable || (isTimeout && retryOnTimeout);

    if (!isRetryable) {
      await cleanupProbeFiles(probeFilesToCleanup, timeoutMs, signal, overallDeadlineAt);
      return result;
    }

    // Empirical ETIMEDOUT escalation (Bug A defense-in-depth, path-agnostic):
    // if a write/read timed out but the directory's `stat` succeeded (it exists),
    // the slowness is hydration/saturation rather than an unreachable path — so
    // give the NEXT attempt the extended cloud budget. Gated on retryOnTimeout so
    // the health path never grows a second 15s attempt. Capped at
    // FS_TIMEOUT_CLOUD_MS and only escalates upward.
    if (isTimeout && retryOnTimeout && result.statSucceeded && timeoutMs < FS_TIMEOUT_CLOUD_MS) {
      const escalated = FS_TIMEOUT_CLOUD_MS;
      log.info(
        { fromTimeoutMs: timeoutMs, toTimeoutMs: escalated, resolvedPath },
        'Workspace probe timed out on an existing directory; escalating timeout budget'
      );
      timeoutMs = escalated;
    }

    // HEALTH path only: a retry here is necessarily after a QUICK transient
    // (timeouts are terminal when retryOnTimeout is false). Such transients clear
    // sub-second, so bound the next attempt to the short quick-retry budget. This
    // guarantees AT MOST ONE attempt uses the full cloud budget, keeping the
    // multi-attempt worst case (one full attempt + backoff + short retries)
    // strictly inside WORKSPACE_ACCESS_CHECK_TIMEOUT_MS (F1 round 2).
    if (!retryOnTimeout) {
      timeoutMs = Math.min(timeoutMs, WORKSPACE_QUICK_RETRY_BUDGET_MS);
    }

    // Log retry attempt with cloud provider info for diagnostics
    const cloudProvider = cloudInfo?.isCloud ? cloudInfo.provider : 'local';
    log.info(
      {
        attempt,
        maxAttempts,
        errorCode: result.code,
        cloudProvider,
        resolvedPath,
      },
      `Workspace probe failed, retrying (${attempt}/${maxAttempts})`
    );

    // Exponential backoff: 500ms, 1000ms, 2000ms, ...
    // Tuned for two distinct retryable scenarios:
    //   - Cloud-sync interference (EBUSY/EPERM/DATA_MISMATCH/ENOENT): hundreds of ms
    //     is usually enough.
    //   - Event-loop saturation (ETIMEDOUT): the libuv thread pool may still be
    //     draining background work for ~1s during startup, so the first 200ms
    //     retry was too eager and just timed out again.
    let delayMs = PROBE_RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
    // Clamp the backoff to the remaining overall budget on the health path so the
    // sleep itself can't push the whole call past WORKSPACE_HEALTH_OVERALL_BUDGET_MS.
    if (overallDeadlineAt !== undefined) {
      delayMs = Math.min(delayMs, Math.max(0, overallDeadlineAt - Date.now()));
    }
    const aborted = await sleepUnlessAborted(delayMs, signal);
    if (aborted) {
      await cleanupProbeFiles(probeFilesToCleanup, timeoutMs, signal, overallDeadlineAt);
      return {
        accessible: false,
        code: 'ETIMEDOUT',
        error: 'Workspace access check aborted (operation timed out)',
        resolvedPath,
      };
    }
  }

  // Should not reach here, but just in case
  await cleanupProbeFiles(probeFilesToCleanup, timeoutMs, signal, overallDeadlineAt);
  return {
    accessible: false,
    code: 'UNKNOWN',
    error: 'Retry loop completed without result',
    resolvedPath,
  };
}

/**
 * Sleep for `delayMs`, resolving early if `signal` aborts. Returns `true` if the
 * sleep was cut short by an abort, `false` if it completed normally.
 */
function sleepUnlessAborted(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise<boolean>(resolve => {
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, delayMs);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        resolve(true);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Clean up all probe files (best effort).
 *
 * Budget per unlink depends on the path:
 *  - FOREGROUND/onboarding (`overallDeadlineAt` undefined): each unlink gets the
 *    full `cleanupTimeoutMs` (= that attempt's `timeoutMs`, 5s/15s). These callers
 *    have no outer wrapper, so we keep their original cleanup budget — the 2s cap
 *    + overall clamp must NOT apply here (rev3 wrongly shrank it to 2s; this is
 *    the GPT-5.5-high round-4 F2 regression fix).
 *  - HEALTH (`overallDeadlineAt` defined): each unlink gets
 *    `min(WORKSPACE_CLEANUP_PER_FILE_CAP_MS, remaining-overall-budget)` so cleanup
 *    can never push the whole call past WORKSPACE_HEALTH_OVERALL_BUDGET_MS. When
 *    the overall budget is spent (or the signal aborted), the unlink is SKIPPED
 *    with an observable log line (not silently swallowed) — the leftover probe
 *    file `.mindstonerebel-probe-*.tmp` is reclaimed by a later probe/cleanup.
 *
 * @param cleanupTimeoutMs The foreground per-file cleanup budget (the attempt's
 *        own `timeoutMs`). Used directly off the health path.
 * @param overallDeadlineAt Absolute ms timestamp (Date.now()-based) that bounds
 *        the whole HEALTH call. `undefined` for foreground/onboarding callers.
 */
async function cleanupProbeFiles(
  probePaths: string[],
  cleanupTimeoutMs: number,
  signal?: AbortSignal,
  overallDeadlineAt?: number
): Promise<void> {
  for (const probePath of probePaths) {
    // Foreground: full timeoutMs. Health: 2s cap clamped to remaining-overall.
    const budget = overallDeadlineAt === undefined
      ? cleanupTimeoutMs
      : Math.min(WORKSPACE_CLEANUP_PER_FILE_CAP_MS, Math.max(0, overallDeadlineAt - Date.now()));

    // Skip (observably) if there is no budget left or we have already aborted, so
    // cleanup never runs past the overall deadline / after settlement.
    if (budget <= 0 || signal?.aborted) {
      log.debug(
        { probePath, budget, aborted: signal?.aborted === true },
        'Workspace probe cleanup skipped (budget spent or aborted); leftover .tmp will be reclaimed later'
      );
      continue;
    }

    // Thunk form: if the signal is already aborted, withTimeout throws BEFORE
    // fs.unlink is invoked, so no cleanup fs work is scheduled post-abort (F2).
    try {
      await withTimeout(() => fs.unlink(probePath), budget, 'cleanup', signal);
    } catch {
      log.debug({ probePath }, 'Workspace probe cleanup failed (non-fatal)');
    }
  }
}

/** Single probe attempt (internal helper) */
async function probeWorkspaceAccessSingle(
  resolvedPath: string,
  timeoutMs: number,
  createIfMissing: boolean,
  probeFilesToCleanup: string[],
  signal?: AbortSignal,
  overallDeadlineAt?: number
): Promise<WorkspaceProbeResult> {
  let created = false;
  let statSucceeded = false;

  // F1 (round 2): ONE deadline for the WHOLE attempt, computed once. An attempt
  // runs several sequential ops (stat → write → read → cleanup); giving each the
  // full `timeoutMs` would make one cloud attempt's worst case ~4×15s = 60s and
  // let the safeCheck wrapper abort a legitimately-running probe mid-op. By
  // handing each op the REMAINING budget to the shared deadline, the whole
  // attempt is bounded by `timeoutMs` (15s cloud / 5s local) regardless of how
  // many ops it does. Foreground/onboarding callers pass their own `timeoutMs`
  // and get the same correct per-attempt total bound.
  //
  // F1 (round 3): when an overall whole-call deadline is supplied (HEALTH path),
  // clamp the attempt deadline to it so a late attempt can't run past the overall
  // budget either.
  const deadlineAt = overallDeadlineAt === undefined
    ? Date.now() + timeoutMs
    : Math.min(Date.now() + timeoutMs, overallDeadlineAt);
  const remaining = () => Math.max(0, deadlineAt - Date.now());

  try {
    // Step 1: Stat the path
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      // fs.stat does not accept an AbortSignal; the pre-invoke guard in
      // withTimeout still prevents scheduling it post-abort, and the in-flight op
      // (best-effort/uncancellable) is abandoned by the race.
      stat = await withTimeout(
        () => fs.stat(resolvedPath),
        remaining(),
        'stat',
        signal
      );
      statSucceeded = true;
    } catch (statErr) {
      const err = statErr as NodeJS.ErrnoException;
      // If ENOENT and createIfMissing, try to create
      if (err.code === 'ENOENT' && createIfMissing) {
        try {
          await withTimeout(
            () => fs.mkdir(resolvedPath, { recursive: true }),
            remaining(),
            'mkdir',
            signal
          );
          created = true;

          // On Windows, give the filesystem a moment to settle after directory creation.
          // Windows Defender/antivirus may scan newly created directories. This
          // settle delay is part of the attempt and counts against the deadline.
          if (process.platform === 'win32') {
            await new Promise(resolve => setTimeout(resolve, 150));
          }

          // Re-stat after creation
          stat = await withTimeout(
            () => fs.stat(resolvedPath),
            remaining(),
            'stat after mkdir',
            signal
          );
          statSucceeded = true;
        } catch (mkdirErr) {
          const mkErr = mkdirErr as NodeJS.ErrnoException;
          // Normalize timeouts in the mkdir / re-stat path the same way the
          // top-level stat path does so that onboarding's createIfMissing
          // probe is equally resilient to libuv thread-pool saturation.
          const isTimeout = isTimeoutOrAbort(mkErr);
          return {
            accessible: false,
            code: isTimeout ? 'ETIMEDOUT' : (mkErr.code ?? 'MKDIR_FAILED'),
            error: isTimeout
              ? 'Path is unreachable (operation timed out)'
              : `Failed to create directory: ${mkErr.message}`,
            resolvedPath,
          };
        }
      } else if (isTimeoutOrAbort(err)) {
        return {
          accessible: false,
          code: 'ETIMEDOUT',
          error: 'Path is unreachable (operation timed out)',
          resolvedPath,
        };
      } else {
        return {
          accessible: false,
          code: err.code ?? 'STAT_FAILED',
          error: err.message,
          resolvedPath,
        };
      }
    }

    // Step 2: Verify it's a directory
    if (stat && !stat.isDirectory()) {
      return {
        accessible: false,
        code: 'ENOTDIR',
        error: 'Path exists but is not a directory',
        resolvedPath,
      };
    }

    // Step 3: Probe write/read/unlink with unique filename
    const probeFilename = generateProbeFilename();
    const probePath = path.join(resolvedPath, probeFilename);
    const probeContent = `workspace-probe:${Date.now()}`;
    // Track for cleanup (even if we fail partway through)
    probeFilesToCleanup.push(probePath);

    try {
      try {
        // writeFile honours the AbortSignal natively, so the in-flight libuv op
        // is actually cancelled on abort (not merely raced).
        await withTimeout(
          () => fs.writeFile(probePath, probeContent, { encoding: 'utf8', signal }),
          remaining(),
          'writeFile',
          signal
        );
      } catch (writeErr) {
        const err = writeErr as NodeJS.ErrnoException;
        const isTimeout = isTimeoutOrAbort(err);
        return {
          accessible: false,
          code: isTimeout ? 'ETIMEDOUT' : (err.code ?? 'WRITE_FAILED'),
          error: isTimeout
            ? 'Write operation timed out'
            : `Cannot write to directory: ${err.message}`,
          resolvedPath,
          created,
          statSucceeded,
        };
      }

      let readBack: string;
      try {
        // readFile honours the AbortSignal natively (cancels the in-flight op).
        readBack = await withTimeout(
          () => fs.readFile(probePath, { encoding: 'utf8', signal }),
          remaining(),
          'readFile',
          signal
        );
      } catch (readErr) {
        const err = readErr as NodeJS.ErrnoException;
        const isTimeout = isTimeoutOrAbort(err);
        return {
          accessible: false,
          code: isTimeout ? 'ETIMEDOUT' : (err.code ?? 'READ_FAILED'),
          error: isTimeout
            ? 'Read operation timed out'
            : `Cannot read from directory: ${err.message}`,
          resolvedPath,
          created,
          statSucceeded,
        };
      }

      // Verify content matches
      if (readBack !== probeContent) {
        return {
          accessible: false,
          code: 'DATA_MISMATCH',
          error: 'Write verification failed - data mismatch',
          resolvedPath,
          created,
          statSucceeded,
        };
      }

      return {
        accessible: true,
        resolvedPath,
        created,
        statSucceeded,
      };
    } finally {
      // Clean up probe file (best effort). Uses the REMAINING attempt budget, and
      // skips entirely if the deadline is already spent or the signal aborted —
      // so cleanup never pushes the attempt past `timeoutMs`. Thunk form so an
      // already-aborted signal never schedules the unlink (F2). Any file left
      // behind here stays in `probeFilesToCleanup` for the loop's final pass.
      const cleanupBudget = remaining();
      if (cleanupBudget > 0 && !signal?.aborted) {
        try {
          await withTimeout(
            () => fs.unlink(probePath),
            cleanupBudget,
            'unlink',
            signal
          );

          // If we successfully cleaned up this probe file, remove it from the
          // cross-attempt cleanup list so we don't unlink it twice.
          const cleanupIdx = probeFilesToCleanup.indexOf(probePath);
          if (cleanupIdx !== -1) {
            probeFilesToCleanup.splice(cleanupIdx, 1);
          }
        } catch (cleanupErr) {
          log.debug({ err: cleanupErr, probePath }, 'Workspace probe cleanup failed (non-fatal)');
        }
      }
    }

  } catch (err) {
    const error = err as Error;
    return {
      accessible: false,
      code: 'UNKNOWN',
      error: error.message,
      resolvedPath,
    };
  }
}

export async function checkUserDataWritable(): Promise<CheckResult> {
  const id = 'userDataWritable';
  const name = 'Application Data';

  try {
    const userDataPath = getPlatformConfig().userDataPath;
    
    await fs.mkdir(userDataPath, { recursive: true });
    
    // On Windows, give the filesystem a moment to settle after directory creation.
    // Windows Defender/antivirus may scan newly created directories, causing
    // immediate write operations to fail on first app launch.
    if (process.platform === 'win32') {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    
    // Use a unique filename per invocation to avoid concurrency races when
    // multiple health checks overlap (e.g. Sentry context + user diagnostics).
    const probePath = path.join(userDataPath, `.health-check-probe-${crypto.randomUUID()}.tmp`);
    const probeContent = `health-check:${Date.now()}`;

    try {
      await fs.writeFile(probePath, probeContent, 'utf8');
      const readBack = await fs.readFile(probePath, 'utf8');

      if (readBack !== probeContent) {
        return {
          id,
          name,
          status: 'fail',
          message: 'Write verification failed - data mismatch',
          remediation: 'Check disk health and available space',
        };
      }

      return {
        id,
        name,
        status: 'pass',
        message: `Writable at ${userDataPath}`,
        details: { path: userDataPath },
      };
    } finally {
      try {
        await fs.unlink(probePath);
      } catch (cleanupErr) {
        log.debug({ err: cleanupErr, probePath }, 'Probe cleanup failed (non-fatal)');
      }
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return {
      id,
      name,
      status: 'fail',
      message: `Cannot write to application data: ${err.message}`,
      details: { code: err.code },
      remediation: 'Check disk permissions and available space',
    };
  }
}

export async function checkWorkspaceAccessible(
  settings: AppSettings,
  signal?: AbortSignal
): Promise<CheckResult> {
  const id = 'workspaceAccessible';
  const name = 'Workspace';

  if (!settings.coreDirectory) {
    return {
      id,
      name,
      status: 'fail',
      message: 'Library not configured',
      remediation: 'Set a Library directory in Settings or re-run onboarding',
    };
  }

  // Use shared probe utility with createIfMissing=false for health checks
  // (health checks should only read, not modify filesystem).
  // Retry is enabled so transient cloud-sync interference or startup-time
  // libuv thread-pool saturation does not surface as a recurring "Library
  // folder is syncing / unreachable" toast for a workspace that is fine.
  //
  // Bug C fix: BOUNDED budget (WORKSPACE_ACCESS_HEALTH_MAX_ATTEMPTS, not 3) +
  // `retryOnTimeout: false` so an ETIMEDOUT is terminal at the detection-informed
  // budget (5s local / 15s cloud-or-in-place-iCloud) — we never spend a second
  // full 15s attempt. Worst-case wall-clock (one full cloud op + one quick-retry
  // backoff) stays strictly inside WORKSPACE_ACCESS_CHECK_TIMEOUT_MS, so the
  // wrapper never fires while the bounded inner policy is legitimately running
  // (the F1 invariant). The outer `safeCheck` signal is threaded in as a backstop
  // and to stop any quick-transient retry on abort.
  const result = await probeWorkspaceAccess(settings.coreDirectory, {
    createIfMissing: false,
    retry: { enabled: true, maxAttempts: WORKSPACE_ACCESS_HEALTH_MAX_ATTEMPTS },
    retryOnTimeout: false,
    signal,
  });

  if (result.accessible) {
    return {
      id,
      name,
      status: 'pass',
      message: `Accessible at ${result.resolvedPath}`,
      details: { path: result.resolvedPath },
    };
  }

  // Check for timeout errors on cloud storage paths - provide cloud-specific guidance
  // Belt-and-suspenders: check both normalized code AND error message
  const isTimeoutError = result.code === 'ETIMEDOUT' || result.error?.includes('timed out');
  const cloudInfo = detectCloudStorage(settings.coreDirectory);
  // In-place iCloud "Desktop & Documents" is physically local (so detectCloudStorage
  // returns isCloud:false), but can still hydrate slowly. Treat its timeouts with
  // the same calm "syncing" copy as a known cloud mount. See detectInPlaceCloudDocuments.
  //
  // F1 (round 4): gate the detector behind `!cloudInfo.isCloud`. A known-cloud path
  // can't ALSO be in-place-iCloud-Documents, so skip the (possibly COLD, ≤2s)
  // xattr there — on a known-cloud path `getTimeoutForPath` short-circuits before
  // ever calling/caching detectInPlaceCloudDocuments, so a cold xattr here would
  // land AFTER the ~17s bounded probe and could push checkWorkspaceAccessible past
  // the 18s wrapper. For a genuine in-place `~/Documents` path detectCloudStorage
  // is false, so getTimeoutForPath's `||` already called+cached the detector during
  // the probe → this hits the cache (~0ms). So gating behind `!isCloud` closes the
  // only cold path while preserving the in-place-iCloud remediation copy.
  const isInPlaceIcloud = !cloudInfo.isCloud && detectInPlaceCloudDocuments(settings.coreDirectory);

  if (isTimeoutError && (cloudInfo.isCloud || isInPlaceIcloud)) {
    const providerName = cloudInfo.isCloud
      ? ({
          onedrive: 'OneDrive',
          google_drive: 'Google Drive',
          dropbox: 'Dropbox',
          icloud: 'iCloud',
          box: 'Box',
        }[cloudInfo.provider as 'onedrive' | 'google_drive' | 'dropbox' | 'icloud' | 'box'] ?? 'cloud storage')
      : 'iCloud';

    return {
      id,
      name,
      status: 'fail',
      message: `Library folder is syncing from ${providerName}`,
      details: {
        path: settings.coreDirectory,
        code: result.code,
        provider: cloudInfo.provider ?? (isInPlaceIcloud ? 'icloud' : undefined),
      },
      remediation: `Please ensure the folder is set to sync locally, or wait for ${providerName} to finish syncing.`,
    };
  }

  // Honest, provider-agnostic remediation (Bug A §1d): only reserve the
  // "disconnected network drive" copy for paths that are genuinely unreachable
  // or missing. A timeout on a directory that provably EXISTS (statSucceeded) is
  // a slow/syncing filesystem, not a disconnected drive — say so calmly.
  const remediation = result.code === 'ENOENT'
    ? 'Library directory does not exist. Select a valid directory.'
    : result.code === 'ENOTDIR'
      ? 'Select a valid directory as Library'
      : result.code === 'ETIMEDOUT'
        ? (result.statSucceeded
            ? 'Your files may still be syncing or temporarily offline — Rebel will keep retrying.'
            : 'The Library path may be on a disconnected network drive. Check your connection.')
        : 'Check Library folder permissions';

  return {
    id,
    name,
    status: 'fail',
    message: `Library not accessible: ${result.error ?? 'Unknown error'}`,
    details: { path: settings.coreDirectory, code: result.code },
    remediation,
  };
}

export async function checkDiskSpace(): Promise<CheckResult> {
  const id = 'diskSpace';
  const name = 'Disk Space';

  try {
    const userDataPath = getPlatformConfig().userDataPath;
    const stats = await fs.statfs(userDataPath);
    
    const freeBytes = stats.bsize * stats.bavail;
    const freeMB = Math.round(freeBytes / (1024 * 1024));
    const freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(1);

    // Copy note: `remediation` is surfaced verbatim as the user-facing toast
    // description (REBEL — disk-full warning), so keep it plain and on-voice. The
    // status tiers (fail/warn) are also consumed by the onboarding preflight; the
    // renderer surfaces both tiers as a calm WARNING toast (environmental, not an
    // app fault) — see ENVIRONMENTAL_WARNING_CHECKS in App.tsx.
    if (freeMB < 100) {
      return {
        id,
        name,
        status: 'fail',
        message: `Critical: Only ${freeMB} MB free`,
        details: { freeBytes, freeMB },
        remediation: 'Your disk is nearly full. Free up some space and Rebel will pick up where it left off.',
      };
    }

    if (freeMB < 1024) {
      return {
        id,
        name,
        status: 'warn',
        message: `Low: ${freeMB} MB free`,
        details: { freeBytes, freeMB },
        remediation: 'Your disk is getting full — worth clearing some room before things get cramped.',
      };
    }

    return {
      id,
      name,
      status: 'pass',
      message: `${freeGB} GB available`,
      details: { freeBytes, freeMB },
    };
  } catch (error) {
    // A probe failure (e.g. statfs error) is an INABILITY to check free space, not
    // a low-disk condition — return skip so it doesn't surface a misleading "low
    // on disk space" warning toast (review F3). Genuine can't-access-storage
    // problems are covered separately by workspaceAccessible.
    return {
      id,
      name,
      status: 'skip',
      message: 'Could not check disk space',
      details: { error: (error as Error).message },
    };
  }
}

export async function checkSymlinkHealth(settings: AppSettings): Promise<CheckResult> {
  const id = 'symlinkHealth';
  const name = process.platform === 'win32' ? 'Library Links' : 'Library Symlinks';

  if (!settings.coreDirectory) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Skipped - Library not configured',
    };
  }

  const workspacePath = path.resolve(settings.coreDirectory);
  const issues: string[] = [];
  const checked: string[] = [];
  const isWindows = process.platform === 'win32';

  async function checkLink(linkPath: string, displayName: string, expectedTarget?: string): Promise<void> {
    try {
      const stat = await fs.lstat(linkPath);
      
      try {
        const target = await fs.readlink(linkPath);
        const resolvedTarget = expectedTarget ?? path.resolve(workspacePath, target);
        
        try {
          await fs.access(resolvedTarget);
          const linkType = isWindows && !stat.isSymbolicLink() ? 'junction' : 'symlink';
          checked.push(`${displayName} (${linkType})`);
        } catch {
          issues.push(`${displayName} link target not accessible`);
        }
      } catch {
        if (stat.isDirectory()) {
          checked.push(`${displayName} (directory)`);
        } else if (stat.isFile()) {
          checked.push(`${displayName} (file)`);
        }
      }
    } catch {
      issues.push(`${displayName} not found`);
    }
  }

  await checkLink(path.join(workspacePath, 'rebel-system'), 'rebel-system');

  const agentsMdPath = path.join(workspacePath, 'AGENTS.md');
  try {
    const stat = await fs.lstat(agentsMdPath);
    if (stat.isFile()) {
      checked.push(isWindows ? 'AGENTS.md (copy)' : 'AGENTS.md');
    }
  } catch {
    issues.push('AGENTS.md not found');
  }

  const spaces = settings.spaces ?? [];
  for (const space of spaces) {
    if (space.isSymlink && space.sourcePath) {
      await checkLink(
        path.join(workspacePath, space.path),
        space.name,
        space.sourcePath
      );
    }
  }

  if (issues.length === 0) {
    return {
      id,
      name,
      status: 'pass',
      message: `All symlinks healthy (${checked.length} checked)`,
      details: { checked },
    };
  }

  return {
    id,
    name,
    status: 'warn',
    message: issues.join('; '),
    details: { issues, checked },
    remediation: 'Re-run onboarding or reconnect external drives to fix broken symlinks',
  };
}

export async function checkTempDirectoryHealth(): Promise<CheckResult> {
  const id = 'tempDirectoryHealth';
  const name = 'Temp Directory';

  const tempDir = os.tmpdir();
  const tempPathLength = tempDir.length;
  const issues: string[] = [];
  const details: Record<string, unknown> = {
    path: tempDir,
    pathLength: tempPathLength,
  };

  if (process.platform === 'win32' && tempPathLength > 180) {
    issues.push(`path is ${tempPathLength} chars (near MAX_PATH limit of 260)`);
  }

  const probePath = path.join(tempDir, `.mindstone-health-probe-${Date.now()}.tmp`);
  try {
    await fs.writeFile(probePath, 'probe', 'utf8');
    try {
      await fs.unlink(probePath);
    } catch (cleanupErr) {
      log.debug({ err: cleanupErr, probePath }, 'Temp probe cleanup failed (non-fatal)');
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      id,
      name,
      status: 'fail',
      message: `Cannot write to temp directory: ${code}`,
      details: { ...details, error: code },
      remediation: 'Check temp directory permissions or set TEMP environment variable to a writable location',
    };
  }

  const syncArtifactPath = path.join(tempDir, 'rs-sync');
  try {
    const entries = await fs.readdir(syncArtifactPath);
    if (entries.length > 0) {
      issues.push('leftover sync artifacts found (previous sync may have failed)');
      details.syncArtifactPath = syncArtifactPath;
      details.artifactCount = entries.length;
    }
  } catch {
    // No artifacts = clean state
  }

  try {
    const stats = await fs.statfs(tempDir);
    const freeMB = Math.round((stats.bsize * stats.bavail) / (1024 * 1024));
    details.freeMB = freeMB;
    if (freeMB < 500) {
      issues.push(`low space (${freeMB}MB free, recommend 500MB+)`);
    }
  } catch {
    // statfs may not be available
  }

  if (issues.length > 0) {
    const hasArtifacts = issues.some(i => i.includes('artifact'));
    return {
      id,
      name,
      status: 'warn',
      message: `Temp directory issues: ${issues.join('; ')}`,
      details,
      remediation: hasArtifacts
        ? `Delete ${syncArtifactPath} and restart the app`
        : 'Consider using a shorter temp path or freeing disk space',
    };
  }

  return {
    id,
    name,
    status: 'pass',
    message: `Temp directory healthy (${tempPathLength} chars)`,
    details,
  };
}
