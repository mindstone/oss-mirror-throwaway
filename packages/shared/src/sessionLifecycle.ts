/**
 * Canonical session-lifecycle predicates shared across every surface
 * (core, main, renderer, cloud-service, cloud-client, mobile, web-companion).
 *
 * This is the single source of truth for the Active/Done distinction. It exists
 * so the `pinnedAt` → `doneAt` rename (see
 * docs/plans/260614_done-state-rename/PLAN.md) is enforced by construction: read
 * lifecycle state ONLY through these predicates, never via raw truthiness.
 *
 * Polarity (affirmative-action, matching `starredAt`/`deletedAt`):
 *   `doneAt` non-null  → the conversation was marked Done.
 *   `doneAt` null/absent → the conversation is Active.
 *
 * CRITICAL: use strict `== null` / `!= null`, NEVER `!doneAt` / `Boolean(doneAt)`.
 * A backfilled timestamp is always > 0, but `doneAt: 0` is a legitimate "Done"
 * value and truthiness would misread it as Active. The discipline matters even
 * where a 0 timestamp is unlikely — it keeps every reader honest.
 *
 * Intentionally pure and platform-agnostic (no imports) so it can live in
 * `@rebel/shared` and be consumed everywhere.
 */

/** Minimal shape the lifecycle predicates need. */
export interface SessionLifecycleFields {
  doneAt?: number | null;
}

/** True when the session has been marked Done (`doneAt` is a non-null timestamp). */
export function isSessionDone(session: SessionLifecycleFields): boolean {
  return session.doneAt != null;
}

/** True when the session is Active (`doneAt` is null or absent). */
export function isSessionActive(session: SessionLifecycleFields): boolean {
  return session.doneAt == null;
}
