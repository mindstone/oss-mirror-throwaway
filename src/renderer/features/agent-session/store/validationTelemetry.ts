/**
 * Cross-session event-ingress validation + outcome telemetry for the renderer
 * session store.
 *
 * Extracted from `sessionStore.ts` (behavior-preserving Stage 4). Houses the
 * fail-closed `shouldDropForeignIngressEvent` guard (used by the store's append
 * paths) and the once-per-tuple validation-outcome message reporter, plus its
 * test-only reset hook. `sessionStore.ts` re-exports
 * `__resetValidationOutcomeReportingForTest` so the canonical
 * `.../store/sessionStore` import path keeps resolving.
 *
 * @see ./sessionStore.ts — the store implementation that drives this guard
 * @see ./currentSessionEvents.ts — primary consumer of shouldDropForeignIngressEvent
 * @see docs/plans/260622_refactor-session-store/PLAN.md — extraction plan
 */
import type { AgentEvent } from "@shared/types";
import {
  validateEventForSession,
  getEventSessionValidationDiagnostics,
  type EventSessionValidationSource,
} from "@shared/utils/eventSessionValidation";
import type { SequencedAgentEvent } from "@shared/utils/eventIdentity";
import { recordRendererBreadcrumb, captureRendererMessage } from "@renderer/src/sentry";
import { hashSessionIdForBreadcrumb } from "@shared/utils/hashSessionIdForBreadcrumb";
import type { EventIngressProvenance } from "./sessionStoreTypes";

/**
 * Stage 19a refinement (Fix 2): make the validator's drop / accepted-legacy
 * outcomes observable in production.
 *
 * The validator's per-tuple counters (`getEventSessionValidationDiagnostics`)
 * and the `cross-session-event-dropped` Sentry *breadcrumb* only surface
 * attached to a later captured error — so a steady-state over-drop or a
 * residual foreign-accept would otherwise be silent. We escalate to a
 * standalone, production-readable Sentry *message* (`captureRendererMessage`,
 * the established message-sink pattern used for MCP/connector/toast failures)
 * so an operator can SEE the foreign-drop rate and the accepted-legacy rate on
 * the Sentry issues page without needing an accompanying error.
 *
 * Cheap by construction: we fire the standalone message only the FIRST time a
 * given (source, outcome, eventType) tuple is observed in this renderer
 * session — subsequent occurrences just bump the validator's counter (already
 * done inside the validator) and the breadcrumb. The count carried in the tags
 * is the running total from the validator diagnostics, so the first sample
 * already conveys "this is happening" and the counter conveys "how often".
 */
const reportedValidationOutcomeTuples = new Set<string>();

const emitValidationOutcomeMessageOnce = (
  outcome: 'rejected-foreign' | 'accepted-legacy',
  source: EventSessionValidationSource,
  eventType: string,
): void => {
  const tupleKey = `${source}:${outcome}:${eventType}`;
  if (reportedValidationOutcomeTuples.has(tupleKey)) {
    return;
  }
  reportedValidationOutcomeTuples.add(tupleKey);
  const diagnostics = getEventSessionValidationDiagnostics();
  const count =
    outcome === 'rejected-foreign'
      ? diagnostics.rejectsByKey[tupleKey] ?? 1
      : diagnostics.legacyByKey[tupleKey] ?? 1;
  captureRendererMessage(`cross-session-event-${outcome}`, {
    level: outcome === 'rejected-foreign' ? 'warning' : 'info',
    tags: {
      crossSessionOutcome: outcome,
      crossSessionSource: source,
      crossSessionEventType: eventType,
    },
    extra: { firstSeenCount: count },
  });
};

/** Test-only: clear the once-per-tuple message dedup set between cases. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- double-underscore convention denotes test-only escape hatch
export const __resetValidationOutcomeReportingForTest = (): void => {
  reportedValidationOutcomeTuples.clear();
};

/**
 * Run the shared cross-session validator for an ingress write.
 *
 * Returns `true` when the caller should DROP the event (foreign-session
 * contamination — telemetry already emitted). Returns `false` when the
 * caller should write (accept or accept-legacy). NEVER throws — a throw on
 * the live event path would crash the renderer event loop.
 */
export const shouldDropForeignIngressEvent = (
  turnId: string,
  event: AgentEvent,
  provenance: EventIngressProvenance,
): boolean => {
  const { targetSessionId, source } = provenance.scope;
  const result = validateEventForSession(
    event as SequencedAgentEvent<AgentEvent>,
    targetSessionId,
    {
      turnId,
      source,
      eventSessionId: provenance.eventSessionId,
    },
  );
  if (result.ok) {
    return false;
  }
  if (result.outcome.kind === 'accepted-legacy') {
    // accept-legacy → caller writes (counter already bumped inside the
    // validator). Surface the legacy rate as a standalone message (once per
    // tuple) so an operator can drive it toward 0 before tightening the union.
    emitValidationOutcomeMessageOnce('accepted-legacy', source, event.type);
    return false;
  }
  // rejected-foreign: fail-closed drop + structured telemetry. The
  // validator already incremented its per-tuple reject counter; we add a
  // Sentry breadcrumb so a non-zero rate surfaces on the issue page, plus a
  // standalone production-readable message (once per tuple) so the foreign-drop
  // rate is visible even without an accompanying error.
  emitValidationOutcomeMessageOnce('rejected-foreign', source, event.type);
  recordRendererBreadcrumb({
    category: 'cross-session-event-dropped',
    message: `Dropped foreign-session event at ${source}`,
    level: 'warning',
    data: {
      source,
      eventType: event.type,
      turnIdHash: hashSessionIdForBreadcrumb(turnId),
      currentSessionIdHash: hashSessionIdForBreadcrumb(
        result.outcome.targetSessionId,
      ),
      eventSessionIdHash: hashSessionIdForBreadcrumb(
        result.outcome.eventSessionId,
      ),
    },
  });
  return true;
};
