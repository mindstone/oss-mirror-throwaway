import { tagFsExhaustion } from '@core/utils/gracefulFsObservability';

export function isTooManyOpenFilesError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EMFILE' || code === 'ENFILE';
}

export type EmfileRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
};

/**
 * Single-attempt synchronous retry for EMFILE/ENFILE errors.
 *
 * Purpose: covers `*Sync` fs paths that graceful-fs cannot reach
 * (it patches only callback APIs). Intentionally minimal: ONE retry
 * with no delay and no busy-wait. The premise is that EMFILE is
 * transient — between the two attempts, an FD may have been freed
 * by an unrelated `fs.close`, or graceful-fs's queue may have
 * drained. If both attempts fail, the error propagates.
 *
 * Used by: src/main/settingsStore.ts (REBEL-1C8 crash site).
 * Do not promote for general use without Sentry data confirming
 * other sync sites are hot. Not scheduled for removal — see
 * `docs/plans/260428_graceful_fs_emfile_fix.md` § Defence-in-depth
 * preservation.
 */
export function withSingleSyncRetryOnEmfile<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (isTooManyOpenFilesError(error)) {
      // No delay: graceful-fs's queue may have drained between
      // catch and re-call. If still EMFILE, surface to caller.
      return fn();
    }
    throw error;
  }
}

/**
 * Defence-in-depth retry helper covering paths that the global
 * `graceful-fs` patch CANNOT reach: synchronous fs ops (`*Sync`),
 * `node:fs/promises` named imports, and any callsite explicitly
 * wrapped here. Re-evaluated for removal once Sentry confirms a
 * ≥99% reduction in `fs_exhaustion`-tagged events relative to the
 * 28-day pre-rollout baseline AND queue-overflow events stay below
 * 10/release for two consecutive stable releases — see
 * `docs/plans/260428_graceful_fs_emfile_fix.md` § "Removal criteria".
 * A dedicated removal planning doc will be created once those
 * criteria are met; do not delete this helper preemptively.
 *
 * **When wrapping a callback-style fs op that graceful-fs queues**
 * (e.g. `fs.readFile(path, cb)`, `fs.open(path, flags, cb)`, the
 * stream constructors), pass `{ maxAttempts: 1 }` to avoid stacking
 * with graceful-fs's hard-coded 60s in-process queue. Wrapping
 * `node:fs/promises` named-import calls or `*Sync` calls does NOT
 * require this — graceful-fs does not queue those, so the default
 * `maxAttempts: 3` (worst-case ~175ms backoff) is correct.
 */
export async function withRetryOnEmfile<T>(
  fn: () => Promise<T>,
  options: EmfileRetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 25,
    maxDelayMs = 250,
    random = Math.random,
  } = options;

  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be >= 1');
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isTooManyOpenFilesError(error) || attempt >= maxAttempts) {
        // Final rethrow path — tag the EMFILE/ENFILE event for Sentry
        // observability before propagating. Wrapped so a tagging failure
        // can never alter retry semantics.
        if (isTooManyOpenFilesError(error)) {
          try { tagFsExhaustion(error, 'emfile_retry_final'); } catch { /* never fail retry on tag errors */ }
        }
        throw error;
      }

      const expBackoff = baseDelayMs * Math.pow(2, attempt - 1);
      const capped = Math.min(expBackoff, maxDelayMs);
      const jitterRatio = 0.25;
      const jitter = (random() - 0.5) * 2 * jitterRatio * capped;
      const delayMs = Math.max(0, Math.round(capped + jitter));

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
