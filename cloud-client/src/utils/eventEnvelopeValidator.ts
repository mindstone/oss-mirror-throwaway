import type { AgentEvent } from '@shared/types';
import { GENERATED_KNOWN_AGENT_EVENT_TYPES } from './eventEnvelopeValidator.generated';
import { createLogger } from './logger';

/**
 * Stage 0.B (cross-surface centralization): `KNOWN_AGENT_EVENT_TYPES` is now
 * auto-generated from src/shared/ipc/schemas/agent.ts via
 * scripts/generate-event-envelope-validator.ts. Adding a new event variant
 * to the Zod schema automatically registers it here — no more silent drift
 * where mobile / web clients drop unknown event types because nobody updated
 * a hand-maintained allowlist. CI fails (validate:fast →
 * `validate:event-envelope-codegen`) if the generated file is stale.
 *
 * `__rebelEventEnvelopeUnknownTypeMarker` is a runtime sentinel attached to
 * events whose `type` is structurally valid but not in the generated set
 * (forward-compat scenario: desktop emits a new event variant before
 * cloud-client / mobile have been redeployed). These events pass through
 * (NOT dropped) so the seq stream stays gap-free and refreshes replay
 * correctly; downstream consumers can ignore them by checking for the
 * marker. This replaces the previous behavior where unknown types were
 * silently rejected as `unknown-type`.
 *
 * @see docs/plans/260516_cross_surface_centralization.md (Stage 0.B)
 */

export const REBEL_EVENT_ENVELOPE_UNKNOWN_TYPE_MARKER = '__rebelEventEnvelopeUnknownTypeMarker';

const log = createLogger('eventEnvelopeValidator');

export type AgentEventEnvelopeValidationResult =
  | { valid: true; event: AgentEvent; unknownType?: false }
  | { valid: true; event: AgentEvent; unknownType: true }
  | { valid: false; reason: string };

const KNOWN_AGENT_EVENT_TYPES: ReadonlySet<string> = GENERATED_KNOWN_AGENT_EVENT_TYPES;

let unknownEventTypeCount = 0;

/** Test-only: observe the unknown-event-type counter. */
export function getUnknownEventTypeCountForTests(): number {
  return unknownEventTypeCount;
}

/** Test-only: reset the counter between cases. */
export function resetUnknownEventTypeCountForTests(): void {
  unknownEventTypeCount = 0;
}

function isValidSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object' && !Array.isArray(input);
}

/**
 * Structural validation (seq/turnId/type-shape/timestamp). The `type` field
 * must be a non-empty string but is NOT checked against the generated allowlist
 * here — that membership test runs in `classifyTypeMembership` so unknown types
 * can be passed through with a sentinel rather than dropped.
 */
function validateStructure(candidate: Record<string, unknown>): string | null {
  if (!isValidSeq(candidate.seq)) return 'invalid-seq';
  if (typeof candidate.turnId !== 'string' || candidate.turnId.trim().length === 0) {
    return 'invalid-turn-id';
  }
  if (typeof candidate.type !== 'string' || candidate.type.length === 0) return 'invalid-type';
  if (typeof candidate.timestamp !== 'number' || !Number.isFinite(candidate.timestamp)) {
    return 'invalid-timestamp';
  }
  return null;
}

function isStructurallyValidAgentEventShape(input: unknown): input is AgentEvent & { turnId: string } {
  return isRecord(input) && validateStructure(input) === null;
}

function cloneStructurallyValidEvent(
  candidate: Record<string, unknown>,
  unknownType: boolean,
): AgentEventEnvelopeValidationResult {
  let cloned: unknown;
  try {
    cloned = JSON.parse(JSON.stringify(candidate));
  } catch {
    return { valid: false, reason: 'not-json-serializable' };
  }
  if (unknownType && isRecord(cloned)) {
    cloned[REBEL_EVENT_ENVELOPE_UNKNOWN_TYPE_MARKER] = true;
  }
  if (!isStructurallyValidAgentEventShape(cloned)) {
    return { valid: false, reason: 'clone-validation-failed' };
  }
  return unknownType
    ? { valid: true, event: cloned, unknownType: true }
    : { valid: true, event: cloned };
}

export function isValidAgentEventEnvelope(input: unknown): AgentEventEnvelopeValidationResult {
  if (!isRecord(input)) {
    return { valid: false, reason: 'not-object' };
  }

  const structureReason = validateStructure(input);
  if (structureReason) {
    return { valid: false, reason: structureReason };
  }

  const isKnownType = KNOWN_AGENT_EVENT_TYPES.has(input.type as string);
  if (!isKnownType) {
    unknownEventTypeCount += 1;
    log.warn('eventEnvelopeValidator.unknown-event-type', {
      eventType: input.type,
      seq: input.seq,
      turnId: input.turnId,
      knownTypeCount: KNOWN_AGENT_EVENT_TYPES.size,
      // schemaVersion is not currently propagated on AgentEvent envelopes. We
      // emit `null` rather than omitting so the log payload schema stays
      // stable for operational queries and downstream alerting.
      schemaVersion: null,
    });
  }

  return cloneStructurallyValidEvent(input, !isKnownType);
}
