/**
 * Typed outcome for `turnErrorRecovery.ts` handler functions.
 *
 * Replaces the overloaded `boolean` handler return that conflated three
 * meanings:
 *   - "this isn't my error" (genuinely fall through)
 *   - "I tried to recover and failed; ctx.error reassigned, fall through"
 *   - "I dispatched events, dispatcher will run terminal cleanup"
 *
 * The 260427 outer-retry-guard postmortem documents the bug class this fixes:
 * a handler returned `false` after emitting real API output, the next handler
 * read stale ctx state, and the user saw duplicate replies. Making
 * "fall through" explicit (`kind: 'passthrough'`) is the structural fix.
 *
 * The `proofOfObservability` discriminant on the non-passthrough variants
 * makes silent failure a type error: every failure path must either prove it
 * is logged + (optionally) captured to Sentry with a fingerprint class, or
 * explicitly opt out with a reason (`observable: false`).
 *
 * See `docs/plans/260526_hotspot-refactor-roadmap/PLAN.md` Stage 3.
 */
import type { ProofOfObservability } from '@shared/types/proofOfObservability';

export type HandlerOutcome =
  | { kind: 'handled'; activityEmitted: boolean; proofOfObservability: ProofOfObservability }
  | { kind: 'passthrough'; reason: string }
  | { kind: 'soft-failed'; activityEmitted: boolean; proofOfObservability: ProofOfObservability };

export const handled = (input: {
  activityEmitted: boolean;
  proofOfObservability: ProofOfObservability;
}): HandlerOutcome => ({
  kind: 'handled',
  activityEmitted: input.activityEmitted,
  proofOfObservability: input.proofOfObservability,
});

export const passthrough = (reason: string): HandlerOutcome => ({
  kind: 'passthrough',
  reason,
});

export const softFailed = (input: {
  activityEmitted: boolean;
  proofOfObservability: ProofOfObservability;
}): HandlerOutcome => ({
  kind: 'soft-failed',
  activityEmitted: input.activityEmitted,
  proofOfObservability: input.proofOfObservability,
});
