/**
 * Shared finish-line constants used by IPC schemas (preload-reachable).
 *
 * The `@core/utils/finishLine` module re-exports this constant and adds the
 * `normalizeFinishLine()` helper for use in core / renderer code.  Shared IPC
 * schemas MUST import from here (`@shared/utils/finishLine`) rather than from
 * `@core` so the preload Vite build — which only resolves `@shared` — succeeds.
 */
export const FINISH_LINE_MAX_LENGTH = 500;
