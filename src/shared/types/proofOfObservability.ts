/**
 * Cross-cutting discriminant for typed-outcome failure variants.
 *
 * Per AGENTS.md "Silent failure is a bug" — every failure path that compiles
 * must prove it is observable (logged with structure, optionally captured to
 * Sentry with a fingerprint class) or explicitly opt out with a reason.
 *
 * Reused by (actual consumers, verified at Phase 7):
 * - turnErrorRecovery.ts handlers — `HandlerOutcome` (Stage 3 of hotspot roadmap, 260526)
 * - `BtsCallResult` failure/degraded variants (Stage 8) — `src/core/services/bts/types.ts`
 *
 * NOT used by the proxy `RequestClassification` (Stage 12): the proxy chose a
 * stronger, compile-time guarantee — a branded `CodexEgressModel` + its own
 * `CodexRemapDiagnostic` for observability — rather than a runtime failure
 * proof. The cross-session validator (Stage 19a/c, `eventSessionValidation.ts`)
 * likewise has its own validation-outcome/counter model, not this failure-proof
 * shape. Both are deliberate, not drift.
 *
 * Shape:
 *   - `{ logged: true; structured: boolean; sentryClass?: string }` — path
 *     emits a structured log line, optionally captures to Sentry under the
 *     named fingerprint class.
 *   - `{ observable: false; reason: string }` — path is acknowledged as not
 *     observable today; `reason` records why (typically a Stage 5 follow-up).
 *     Honest opt-out beats an unverifiable claim of observability.
 *
 * See `docs/plans/260526_hotspot-refactor-roadmap/PLAN.md` Stage 3 and
 * Amendments § 2026-05-26 17:30 for the cross-cutting principle.
 */
export type ProofOfObservability =
  | { logged: true; structured: boolean; sentryClass?: string }
  | { observable: false; reason: string };
