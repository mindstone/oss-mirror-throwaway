/**
 * Event session validation — Stage 1 of 260506_cross_session_event_boundary_validation.md.
 *
 * Provides the runtime validator and branded type that ingress
 * boundaries use to reject foreign-stamped AgentEvents before they reach
 * session-scoped event state. As of the 260526 hotspot-refactor run
 * (Stages 19a/19c) it is WIRED at the renderer ingress scopes
 * (onAgentEvent, cache-hit backfill, history replay, history hydration,
 * ingest-external) and the main sessions-handler union, all fail-closed
 * (drop + telemetry, never throw). It ships the type, the validator, and
 * per-tuple telemetry counters with a `getDiagnostics()` accessor. The
 * `ValidatedSessionWriteScope` brand (below) is an OPTIONAL compile-time
 * write-scope token — it does not yet force every write to validate.
 *
 * Bug class context (260424 → 260502 → 260506):
 * - 260424 (REBEL-5D5): foreign user-question/answered events landed in
 *   the wrong conversation through useUserQuestions extractor race;
 *   producer-side stamping + Layer-4 extractor filter shipped.
 * - 260502: persist-side variable-swap miss — fixed via the
 *   `SequencedAgentEvent` brand in `eventIdentity.ts`.
 * - 260506: same Layer-4 filter re-emitted ~96 console.warns in 15min
 *   because foreign events sat in `eventsByTurn` for the life of a long
 *   tool-running turn; Stage 1 dedup latch shipped (commit e0f947459).
 *
 * `validateEventForSession` is now wired at ingress boundaries so foreign
 * events are rejected at write rather than relying on the Layer-4 read-time
 * filter as the last line of defence. Remaining residual (see
 * docs/plans/260529_codebase-health-initiatives/INITIATIVES.md §4): forcing
 * every write through validation (the optional brand → required) is a deferred
 * low-leverage migration.
 *
 * Cross-surface note (260604): the own/foreign/legacy *decision* is now a shared
 * SSOT — `classifyEventForSession` in `@rebel/shared` (re-exported above). This
 * validator layers telemetry counters + the branded type on top for desktop
 * ingress; the cloud-client read-time extractors (`useUserQuestions.ts`) call the
 * same classifier for their decision and keep their own render-path dedup-warning
 * latch. So the *guard logic* no longer drifts cross-surface. The telemetry
 * *counters* here remain ingress-only (the cloud extractors run per-render, so
 * counting from them would re-amplify like 260506); cloud keeps its dedup
 * breadcrumb as its render-path signal — counter unification was consciously
 * not pursued.
 *
 * @see docs/plans/260506_cross_session_event_boundary_validation.md
 * @see docs-private/postmortems/260506_cross_session_drop_warning_amplifier_postmortem.md
 * @see src/shared/utils/eventIdentity.ts — sibling brand for the (turnId, seq) pair.
 */

import { classifyEventForSession, type EventSessionClassification } from '@rebel/shared';
import type { AgentEvent } from '@shared/types';

import type { SequencedAgentEvent } from './eventIdentity';

// Re-export the cross-surface classifier (the SSOT lives in @rebel/shared so
// cloud-client can take a runtime dep on it) for desktop callers that import it
// alongside the validator.
export { classifyEventForSession };
export type { EventSessionClassification };

/**
 * Branded type marking events that have been validated against a target
 * session id. Layered on top of `SequencedAgentEvent<E>` so the brand
 * carries both invariants — `seq` stamped AND `sessionId === target`.
 *
 * Brand is compile-time only; deserialised events from disk or IPC do
 * not carry it. The validator must re-mint the brand each time, never
 * trust an inbound brand. Same pattern as `assertEventHasSeq` in
 * `eventIdentity.ts`.
 */
export type SequencedSessionedAgentEvent<
  S extends string = string,
  E extends AgentEvent = AgentEvent,
> = SequencedAgentEvent<E> & {
  readonly __sessionBrand: 'SequencedSessionedAgentEvent';
  readonly __session: S;
};

/**
 * Source of a validated event. Used for telemetry keying and
 * Sentry-breadcrumb labelling so a non-zero rate at any single source
 * pinpoints which ingress boundary still needs hardening.
 */
export type EventSessionValidationSource =
  | 'ipc-agent-event'
  | 'cache-hit-backfill'
  | 'history-replay'
  | 'history-hydration'
  | 'ingest-external'
  | 'sessions-handler-union'
  // For unit tests / non-production callers that don't fit the above.
  | 'test-only';

export interface EventSessionValidationOpts {
  turnId: string;
  source: EventSessionValidationSource;
  /**
   * Explicit provenance sessionId for the event, supplied by the caller.
   *
   * THE CONTRACT FIX (Stage 19a / 260506 Stages 2–4): the base `AgentEvent`
   * union carries `sessionId` only on *some* variants (`user_question`,
   * status broadcast payloads). On the primary foreground live path the
   * provenance arrives as a *separate envelope field* (`AgentTurnEvent.sessionId`,
   * a.k.a. `eventSessionId`) or as a function argument threaded through
   * `processAgentEvent` — NOT on the event object. Reading `event.sessionId`
   * alone would classify nearly every foreground live event as
   * `accepted-legacy` and never reject a foreign one (a phantom fix).
   *
   * When `eventSessionId` is provided here, it is the authoritative provenance
   * and overrides `event.sessionId`. When omitted (or undefined), the validator
   * falls back to reading `event.sessionId` off the event — preserving the
   * original behaviour for callers (and tests) that stamp provenance on the
   * event itself.
   *
   * An empty string is treated as "missing" (legacy), same as `event.sessionId`.
   */
  eventSessionId?: string;
}

export type EventSessionValidationOutcome =
  | { kind: 'rejected-foreign'; eventSessionId: string; targetSessionId: string }
  | { kind: 'accepted-legacy'; targetSessionId: string };

export type EventSessionValidationResult<
  S extends string,
  E extends AgentEvent,
> =
  | { ok: true; event: SequencedSessionedAgentEvent<S, E> }
  | { ok: false; outcome: EventSessionValidationOutcome };

interface CounterMap {
  rejectsByKey: Record<string, number>;
  legacyByKey: Record<string, number>;
  firstRejectAt: number | null;
  lastRejectAt: number | null;
}

const counters: CounterMap = {
  rejectsByKey: {},
  legacyByKey: {},
  firstRejectAt: null,
  lastRejectAt: null,
};

function tupleKey(
  source: EventSessionValidationSource,
  outcomeKind: EventSessionValidationOutcome['kind'],
  eventType: string,
): string {
  return `${source}:${outcomeKind}:${eventType}`;
}

/**
 * Validate `event` belongs to `targetSessionId`. Mints the brand on
 * success.
 *
 * Outcome semantics:
 * - **accept** (`ok: true`): `event.sessionId === targetSessionId`. Brand is
 *   minted; callers should write the event to session-scoped state.
 * - **reject-foreign** (`ok: false, outcome.kind = 'rejected-foreign'`):
 *   `event.sessionId` is present but does not match. Caller MUST drop
 *   the event (do not write to session-scoped state). Counters and
 *   timestamps update.
 * - **accept-legacy** (`ok: false, outcome.kind = 'accepted-legacy'`):
 *   `event.sessionId` is missing. The validator does not mint the brand
 *   (cannot prove the event belongs to the target), but callers are
 *   currently permitted to write the event to session-scoped state until
 *   `AgentEvent.sessionId` is required across the union (Option C in the
 *   plan, deferred). Legacy counter updates so production telemetry can
 *   confirm the legacy-event rate is ~0 before tightening the union.
 *
 * The function is pure aside from the module-level counter mutation;
 * callers do not need to thread state through.
 */
export function validateEventForSession<
  S extends string,
  E extends AgentEvent,
>(
  event: SequencedAgentEvent<E>,
  targetSessionId: S,
  opts: EventSessionValidationOpts,
): EventSessionValidationResult<S, E> {
  const classification =
    opts.eventSessionId === undefined
      ? classifyEventForSession(event, targetSessionId)
      : classifyEventForSession(event, targetSessionId, {
        eventSessionId: opts.eventSessionId,
      });
  const eventType: string = (event as { type?: unknown }).type === undefined
    ? 'unknown'
    : String((event as { type: unknown }).type);

  if (classification.kind === 'accepted-legacy') {
    const key = tupleKey(opts.source, 'accepted-legacy', eventType);
    counters.legacyByKey[key] = (counters.legacyByKey[key] ?? 0) + 1;
    return {
      ok: false,
      outcome: { kind: 'accepted-legacy', targetSessionId },
    };
  }

  if (classification.kind === 'rejected-foreign') {
    const key = tupleKey(opts.source, 'rejected-foreign', eventType);
    counters.rejectsByKey[key] = (counters.rejectsByKey[key] ?? 0) + 1;
    const now = Date.now();
    if (counters.firstRejectAt === null) counters.firstRejectAt = now;
    counters.lastRejectAt = now;
    return {
      ok: false,
      outcome: {
        kind: 'rejected-foreign',
        eventSessionId: classification.eventSessionId,
        targetSessionId,
      },
    };
  }

  return {
    ok: true,
    event: event as SequencedSessionedAgentEvent<S, E>,
  };
}

/**
 * Stage 19b — COMPILE-TIME guarantee on top of the runtime validator.
 *
 * `ValidatedSessionWriteScope` is a nominal, unforgeable token that proves the
 * holder ran the cross-session validator (`validateEventForSession`) for a
 * specific `(targetSessionId, source)` write. The session-scoped event-write
 * functions at the renderer ingress seam (`appendEventToCurrentSession` /
 * `setCurrentSessionEvents`) accept this token via an OPTIONAL `scope`
 * parameter; the only way to obtain a scope is to call
 * `beginValidatedSessionWrite` here, which lives next to the validator.
 *
 * ACCURATE guarantee (refined 260530, see report
 * 260530_080000_implementer-stage19b-refinement-write-seam.md): the token is
 * unforgeable, all CURRENT cross-session ingress paths mint it, and
 * re-introducing the pre-19b plain `{ currentSessionId, source }` provenance
 * shape is a COMPILE error. It does NOT (yet) make every write require a token:
 * because `scope` is optional, a NEW cross-session-ingress site could still
 * compile without minting one. Forcing validation universally needs the
 * named-API split (a `*LocalUnchecked` variant for the genuinely-local callers
 * + migrating the ~50 local/test call sites) — measured as a >20-site cascade
 * and deferred as a follow-up. The optional path is retained for same-session
 * resync (version-coalescing edit) and local/test callers, which legitimately
 * write events already known to belong to the current session.
 *
 * Why a scope token and not the branded *event*: on the `accepted-legacy`
 * outcome the validator deliberately does NOT mint `SequencedSessionedAgentEvent`
 * (it cannot prove provenance), yet the caller is still permitted to write the
 * legacy event (Option C deferred). Requiring the branded event would therefore
 * force casts on the legacy write path and defeat the guarantee. The scope
 * token instead proves "the validator was consulted for this write" — which is
 * exactly the bad pattern Stage 19a closed at runtime and 19b now closes at
 * compile time — while leaving the accept-vs-accept-legacy decision to the
 * runtime validator as before. Runtime behaviour is unchanged: the token is a
 * compile-time-only brand (a plain frozen descriptor object at runtime).
 *
 * The brand uses a module-private `unique symbol` so no other module can
 * fabricate a scope (the symbol is never exported). Same nominal-brand
 * mechanism family as `SequencedAgentEvent` / `BareToolId`, hardened to be
 * unforgeable across module boundaries.
 */
declare const validatedSessionWriteBrand: unique symbol;

export interface ValidatedSessionWriteScope {
  readonly targetSessionId: string;
  readonly source: EventSessionValidationSource;
  readonly [validatedSessionWriteBrand]: 'ValidatedSessionWriteScope';
}

/**
 * The SOLE constructor for a {@link ValidatedSessionWriteScope}. Callers obtain
 * a scope here and hand it to a validated write function; the write function
 * then drives `validateEventForSession` per event under this scope. Minting a
 * scope is the caller's explicit assertion "I am about to run the validator for
 * writes targeting `targetSessionId` at `source`" — and because the scope is
 * unforgeable, a write that PASSES one provably went through the validator. A
 * write that passes NO scope still type-checks (the parameter is optional; see
 * the brand JSDoc above for why that local-write path is retained and the
 * deferred follow-up to force validation universally).
 */
export function beginValidatedSessionWrite(
  targetSessionId: string,
  source: EventSessionValidationSource,
): ValidatedSessionWriteScope {
  return Object.freeze({
    targetSessionId,
    source,
  }) as unknown as ValidatedSessionWriteScope;
}

/** Snapshot of validator counters for diagnostics logging. Pure read. */
export function getEventSessionValidationDiagnostics(): {
  rejectsByKey: Record<string, number>;
  legacyByKey: Record<string, number>;
  firstRejectAt: number | null;
  lastRejectAt: number | null;
} {
  return {
    rejectsByKey: { ...counters.rejectsByKey },
    legacyByKey: { ...counters.legacyByKey },
    firstRejectAt: counters.firstRejectAt,
    lastRejectAt: counters.lastRejectAt,
  };
}

/** Test-only: clear counters between cases. Not exported via barrel. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- double-underscore convention denotes test-only escape hatch (mirrors `__resetForTests` style used elsewhere in the codebase)
export function __resetEventSessionValidationDiagnosticsForTest(): void {
  counters.rejectsByKey = {};
  counters.legacyByKey = {};
  counters.firstRejectAt = null;
  counters.lastRejectAt = null;
}
