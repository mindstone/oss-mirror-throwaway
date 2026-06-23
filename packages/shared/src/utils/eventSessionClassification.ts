/**
 * Pure cross-surface own/legacy/foreign classifier for session-scoped events.
 *
 * This is the single source of truth for the decision "does this event belong
 * to the target session?" shared by BOTH the desktop ingress validator
 * (`src/shared/utils/eventSessionValidation.ts`, which layers telemetry counters
 * + a branded type on top) AND the cloud-client read-time extractors
 * (`cloud-client/src/hooks/useUserQuestions.ts`, which layer their own
 * render-path dedup warnings on top). Keeping the decision here — in
 * `@rebel/shared`, the package both surfaces may take runtime deps on — prevents
 * the cross-surface guard drift that would re-open the cross-session
 * contamination class (260424 / 260502 / 260506) on one surface only.
 *
 * It is deliberately PURE: no counters, no telemetry, no `source`, no branding,
 * no side effects. It is also decoupled from the `AgentEvent` type (it reads
 * `sessionId` structurally) so it can live in `@rebel/shared` without that
 * package depending on `src/shared` — matching the convention used by
 * `humanizeAgentError.ts` here.
 *
 * Provenance semantics (must match the desktop validator exactly):
 * - An explicit non-empty `opts.eventSessionId` is authoritative and overrides
 *   `event.sessionId` (the foreground live path threads provenance as a separate
 *   envelope field, not on the event object).
 * - Otherwise a non-empty string `event.sessionId` is the provenance.
 * - Missing / non-string / empty-string provenance => `accepted-legacy` (the
 *   validator cannot prove ownership but callers may still use the event with
 *   the caller's session id, until the union requires `sessionId`).
 * - Present-and-different provenance => `rejected-foreign` (caller MUST drop).
 * - Present-and-equal => `own`.
 */
export type EventSessionClassification =
  | { kind: 'own' }
  | { kind: 'accepted-legacy' }
  | { kind: 'rejected-foreign'; eventSessionId: string };

function readEventSessionId(event: unknown): string | undefined {
  // Defensive structural read: `sessionId` is present on most session-scoped
  // event variants but not all, and this util is decoupled from the AgentEvent
  // type. `unknown` (rather than `{ sessionId?: unknown }`) avoids TS weak-type
  // errors for caller variants that carry no `sessionId` field at all.
  const candidate = (event as { sessionId?: unknown } | null | undefined)?.sessionId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

export function classifyEventForSession(
  event: unknown,
  targetSessionId: string,
  opts?: { eventSessionId?: string | undefined },
): EventSessionClassification {
  const explicit =
    typeof opts?.eventSessionId === 'string' && opts.eventSessionId.length > 0
      ? opts.eventSessionId
      : undefined;
  const eventSessionId = explicit ?? readEventSessionId(event);

  if (eventSessionId === undefined) {
    return { kind: 'accepted-legacy' };
  }

  if (eventSessionId !== targetSessionId) {
    return { kind: 'rejected-foreign', eventSessionId };
  }

  return { kind: 'own' };
}
