/**
 * Per-process namespace for safety-eval cooldown coalescing.
 *
 * Staged approval cards can persist across app restarts, while cooldown
 * generation counters are intentionally process-local. Including this boot ID
 * in coalesce keys prevents a stale pre-restart card from absorbing the first
 * post-restart rate-limited action.
 */
export const SAFETY_EVAL_PROCESS_BOOT_ID = `${Date.now()}-${process.pid}`;
