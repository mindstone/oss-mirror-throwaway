/**
 * Renderer-local sanitisation rate-limit state for composer drafts.
 *
 * Tracks which sessions have already been sanitised in this app session so the
 * `setDraftForSession` write boundary and the localStorage-migration path can
 * short-circuit the structured "sanitised corrupted draft" log on subsequent
 * calls. The pure `sanitiseCorruptedDraftText` function still runs on every
 * call (per C2 in the planning doc — `markdownToDoc` stays pure and silent);
 * this module only gates the *logging + boundary-side actions*, not the
 * sanitiser itself.
 *
 * Stage 6 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md`. This is
 * the post-spike GPT-High amendment: the `sanitisedAt` map lives in a
 * dedicated module — NOT in the Zustand `sessionStore` (would couple the
 * persistence layer to UI state), NOT in React state (the migration runs
 * outside React on app startup), NOT on `DraftContent` / `src/shared/types/agent.ts`
 * (would force a cross-surface schema change for renderer-only ephemeral state
 * — option (a) per 90%-push critique H8).
 *
 * Contract:
 *   - In-memory only. Not serialised to disk. Not sent to cloud.
 *   - Survives app reload via lazy regeneration: on first hydrate post-reload,
 *     sanitise once; if corruption was found, mark sanitised so subsequent
 *     boundary calls in the same session don't re-log.
 *   - Cleared on session deletion via `clearSanitisationState(sessionId)`.
 *
 * Both `useDraftPersistence.ts` (migration boundary) and `sessionStore.ts`
 * (`setDraftForSession` write boundary) import this module, avoiding any
 * cross-feature/circular-import risk of co-locating the state with either
 * consumer.
 */

const sanitisedSessions = new Map<string, number>();

/** Mark `sessionId` as sanitised at the current time. Idempotent re-marks update the timestamp. */
export function markSessionSanitised(sessionId: string): void {
  sanitisedSessions.set(sessionId, Date.now());
}

/** Returns true iff `sessionId` was previously marked sanitised in this app session. */
export function wasSessionSanitised(sessionId: string): boolean {
  return sanitisedSessions.has(sessionId);
}

/**
 * Clear the sanitisation marker for `sessionId`. Used when a session is
 * deleted (so a future session that reuses the same id starts fresh) and from
 * tests that want isolated state per case.
 */
export function clearSanitisationState(sessionId: string): void {
  sanitisedSessions.delete(sessionId);
}

/**
 * Reset the entire sanitisation map. **Test-only** — production code must use
 * `clearSanitisationState(sessionId)` for the targeted clear. The leading
 * underscore signals "do not call from product code"; ESLint guards against
 * accidental imports in production paths via the conventional underscore-name
 * convention.
 */
export function _resetSanitisationStateForTests(): void {
  sanitisedSessions.clear();
}
