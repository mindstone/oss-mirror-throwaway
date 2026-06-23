import { createScopedLogger } from '@core/logger';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { DARWIN_OPEN_MAX_FD } from '@core/utils/fdPressure';

const defaultLog = createScopedLogger({ service: 'fd-limit' });

type SetFdLimit = (maxDescriptors: number) => void;

/** Read the process open-files soft rlimit (best-effort; null if unavailable). */
function readSoftLimitFromProcess(): number | null {
  try {
    const report = process.report?.getReport?.() as
      | { userLimits?: { open_files?: { soft?: unknown } } }
      | undefined;
    const soft = report?.userLimits?.open_files?.soft;
    return typeof soft === 'number' ? soft : null;
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'raiseFdLimit.readSoftLimit',
      reason: 'rlimit read is best-effort diagnostics only',
    });
    return null;
  }
}

export interface RaiseFdLimitDeps {
  setFdLimit?: SetFdLimit;
  readSoftLimit?: () => number | null;
  logger?: Pick<ReturnType<typeof createScopedLogger>, 'info' | 'warn'>;
  target?: number;
}

/**
 * Raise the process open-files (file-descriptor) soft limit toward the OS hard
 * limit at startup, to reduce EMFILE ("too many open files") under FD pressure.
 *
 * Uses Electron's built-in `process.setFdLimit` — which binds to Chromium
 * `base::IncreaseFdLimitTo` → `setrlimit(RLIMIT_NOFILE, …)`, so no native module
 * or dependency is required. It only ever RAISES and clamps to the OS hard limit,
 * so it cannot break anything by overshooting.
 *
 * No-op (returns silently) where `setFdLimit` is undefined:
 *  - **Windows** — has no `RLIMIT_NOFILE`; the EMFILE-equivalent there is the C
 *    runtime `_setmaxstdio` cap, a separate native-only concern.
 *  - **Non-Electron surfaces** — cloud plain-Node (Node already auto-raises the
 *    soft limit to the hard limit at startup) and any `utilityProcess`.
 *
 * Raising the ceiling is complementary to (not a substitute for) fixing fd leaks
 * and bounding fan-outs; it buys headroom so transient pressure doesn't EMFILE.
 */
export function raiseFdLimit(deps: RaiseFdLimitDeps = {}): void {
  const setFdLimit =
    deps.setFdLimit ?? (process as NodeJS.Process & { setFdLimit?: SetFdLimit }).setFdLimit;
  if (typeof setFdLimit !== 'function') return; // win32 / non-Electron surfaces

  const log = deps.logger ?? defaultLog;
  const readSoftLimit = deps.readSoftLimit ?? readSoftLimitFromProcess;
  // 10240 = macOS kern.maxfilesperproc default ceiling (requesting higher is
  // silently capped); Linux clamps to its (large) hard limit. Shared constant.
  const target = deps.target ?? DARWIN_OPEN_MAX_FD;

  const before = readSoftLimit();
  // setFdLimit sets the soft limit to min(target, hard limit) — it does NOT only
  // ever raise. On Linux, Node already auto-raises the soft limit to the (often
  // huge) hard limit at startup, so blindly calling setFdLimit(10240) would LOWER
  // it. Only mutate when the current soft limit is below the target (review F1).
  if (before !== null && before >= target) {
    log.info({ before, target }, 'open-files soft limit already at or above target; left unchanged');
    return;
  }
  try {
    setFdLimit(target);
    // Read-back + outcome logging live inside the try so they only run when the
    // set actually succeeded (and so the catch needs no early-return sentinel).
    const after = readSoftLimit();
    if (after === null) {
      // Could not read the limit back — the set was attempted but is unverified.
      log.info({ before, target }, 'open-files soft limit raise attempted (could not verify)');
    } else if (after < target) {
      // macOS setrlimit can silently cap below the request — surface it rather
      // than assume success.
      log.warn({ before, after, target }, 'open-files soft limit raised but below target (OS cap?)');
    } else {
      log.info({ before, after, target }, 'open-files soft limit raised');
    }
  } catch (error) {
    // Best-effort: a failed raise is non-fatal — the app continues with the
    // default limit. Logged (not silently swallowed) for visibility.
    log.warn(
      { err: error instanceof Error ? error.message : String(error), target },
      'open-files soft limit raise failed',
    );
  }
}
