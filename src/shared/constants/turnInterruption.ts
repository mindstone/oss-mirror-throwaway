/**
 * Turn-interruption status constants.
 *
 * `markSessionTurnsAsCompleted` (src/core/services/inboxStore.ts) appends a
 * synthetic status event with this message to turns that were cut off without
 * a terminal event (app quit / crash). The renderer's silent-stop classifier
 * (`detectSilentStop.ts`) matches on the same message to classify the turn as
 * `interrupted` and offer a Continue affordance.
 *
 * Shared here so the producer (core/main) and the reader (renderer) cannot
 * drift — both sides import the same literal.
 *
 * @see docs/plans/260610_fox2771-2601-silent-stall/PLAN.md (Stage 1)
 */

/**
 * User-facing status message appended to turns interrupted by app shutdown.
 * NOTE: persisted sessions contain this exact string — do not change it
 * without a migration plan for the renderer-side predicate.
 */
export const TURN_INTERRUPTION_MESSAGE = 'Agent turn interrupted when Mindstone Rebel closed.';

/**
 * Machine-readable discriminator for WHY the interruption status was emitted:
 * - `'shutdown'` — graceful quit (`finalizeActiveSessionsOnShutdown`); the
 *   user chose to close the app while a turn was running.
 * - `'startup-correction'` — crash/kill recovery (`correctInterruptedSessionsOnStartup`
 *   and other stale-busy correction paths); the previous process died without
 *   finalizing.
 *
 * Optional on persisted events — sessions written before this field existed
 * have `undefined` (treat as unknown origin).
 */
export type TurnInterruptionSource = 'shutdown' | 'startup-correction';
