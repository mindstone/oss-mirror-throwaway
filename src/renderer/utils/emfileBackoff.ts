/**
 * Renderer-side EMFILE / ENFILE detection + exponential-backoff helpers.
 *
 * Used by polling hooks (e.g. `useMcpBuildCardState`,
 * `useContributionNotifications`) to detect file-descriptor exhaustion
 * surfaced through IPC error responses and slow polling down so the
 * renderer doesn't aggravate the FD pressure that's already saturating
 * the main process. See REBEL-1HF.
 *
 * Pure helpers — no React. Hooks compose this with their own scheduler.
 */

/**
 * Detect whether an error reflects a Node "too many open files" condition.
 * Matches both `EMFILE` and `ENFILE` (per-process and system-wide).
 *
 * Accepts:
 *  - `Error`-like objects with `.code` (e.g. `NodeJS.ErrnoException`).
 *  - String error payloads (IPC bridges may stringify the original error).
 *  - `unknown` shapes — returns false defensively.
 *
 * NOTE: keep loose-textual detection for IPC. Errors traveling across
 * Electron's IPC bridge can lose their `.code` property and arrive as a
 * plain string like `"Error: EMFILE: too many open files, ..."`. Checking
 * the message body is the only reliable signal in that case.
 */
export function isEmfileError(error: unknown): boolean {
  if (!error) return false;
  // Object-shaped error with `.code`.
  if (typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (code === 'EMFILE' || code === 'ENFILE') return true;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return matchesEmfileText(message);
    }
  }
  // Stringified error.
  if (typeof error === 'string') {
    return matchesEmfileText(error);
  }
  return false;
}

function matchesEmfileText(text: string): boolean {
  return text.includes('EMFILE') || text.includes('ENFILE');
}

/**
 * Exponential-backoff schedule used by polling hooks when they detect
 * EMFILE/ENFILE failures. Doubles up to a 30s cap, with a longer cooldown
 * applied after sustained failure.
 *
 * - `attempt`: 0-based count of consecutive EMFILE failures observed.
 * - `baseDelayMs`: the hook's normal poll interval (e.g. 2000 ms).
 * - `pauseAfterAttempts`: after this many consecutive failures, the hook
 *   should switch to a longer cooldown to give the OS time to recover.
 * - `cooldownDelayMs`: delay applied once `pauseAfterAttempts` is exceeded.
 *
 * Returns the delay (ms) to wait before the next polling attempt.
 */
export interface BackoffOptions {
  baseDelayMs: number;
  /** Cap on the doubling backoff (default: 30s). */
  maxDelayMs?: number;
  /** Number of consecutive failures before switching to the cooldown. */
  pauseAfterAttempts?: number;
  /** Cooldown delay applied after `pauseAfterAttempts` exhausted (default: 60s). */
  cooldownDelayMs?: number;
}

export function computeEmfileBackoffDelay(
  attempt: number,
  options: BackoffOptions,
): number {
  const {
    baseDelayMs,
    maxDelayMs = 30_000,
    pauseAfterAttempts = 5,
    cooldownDelayMs = 60_000,
  } = options;

  if (attempt <= 0) return baseDelayMs;
  if (attempt >= pauseAfterAttempts) return cooldownDelayMs;

  // First failure → 2x base, then 4x, 8x, 16x, capped at maxDelayMs.
  const exponential = baseDelayMs * Math.pow(2, attempt);
  return Math.min(exponential, maxDelayMs);
}
