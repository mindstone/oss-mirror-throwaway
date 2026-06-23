/**
 * Typed substring-cascade classifier for `turnErrorRecovery.ts` dispatch.
 *
 * Stage 4 of `docs/plans/260526_hotspot-refactor-roadmap/PLAN.md` (Hotspot 2).
 *
 * Replaces the substring cascade in `classifyAndDispatchError` (the
 * `lowerErrorMsg.includes('request_too_large')`, `lowerErrorMsg.includes('image exceeds')`,
 * `isExpectedOperationalTimeout(...)` cluster at lines 2438–2548) with a
 * single-pass classifier whose result is a discriminated union the
 * dispatcher can `switch` on.
 *
 * Closes the substring-coverage-drift bug class (researcher F4 / cluster 1
 * in `subagent_reports/260526_154201_researcher-bugarch-turnerrorrecovery-opus47.md`):
 * each substring expression that drifts in isolation is a recurring
 * postmortem source. Centralising them lets future signals land in one
 * place with type-system enforcement.
 *
 * **Semantic preservation.** The 51 invariant tests (Stage 1) — including
 * `INV-18-classifier` which pins the underscore-form `request_too_large`
 * not matching context-overflow — are the contract. The classifier
 * preserves the exact substring matches and their precedence:
 *
 *   1. `stream-closed` — case-sensitive `'Stream closed'`
 *   2. `image-exceeds-limit` — `'image exceeds' && 'maximum' && 'bytes'`
 *   3. `request-too-large` — `'request_too_large'` (underscore) OR
 *      `'request too large'` (spaced) OR `('413' && 'request')`
 *      Carries `alsoContextOverflow: boolean` so the dispatcher's
 *      `isContextOverflowError` derivation matches today's: spaced /
 *      `413+request` forms also fire context-overflow, the underscore
 *      form does NOT.
 *   4. `context-overflow` — broader match (`'413'` alone, `'context'+...`,
 *      `'token'+...`) when not already classified as request-too-large.
 *   5. `prompt-too-long` — `'prompt' && ('too long' | 'too large' | 'exceed')`.
 *   6. `schema-validation` — `'invalid_request_error' && ('input_schema' | 'json schema is invalid')`.
 *   7. `process-exit` — `'process exited with code'`.
 *   8. `transport-not-ready` — `'processtransport' && 'not ready'`.
 *   9. `expected-operational-timeout` — see `isExpectedOperationalTimeout`.
 *  10. `unknown` — fallthrough.
 *
 * `prompt-too-long` runs after the request-too-large / context-overflow
 * matchers because the historical dispatcher derived `isPromptTooLongError`
 * with `!isAttachmentSizeError` (composition with `hasMedia`). For messages
 * that match both, the dispatcher's `isPromptTooLongError || isContextOverflowError`
 * arm fires regardless of which classification kind we return, so the
 * observable behaviour is preserved.
 */

import { getErrorMessage } from '../../utils/agentTurnUtils';

export type ErrorClassification =
  | { kind: 'stream-closed' }
  | { kind: 'image-exceeds-limit' }
  | {
      kind: 'request-too-large';
      /**
       * `true` when the same message ALSO matches the broader
       * context-overflow predicate (spaced "request too large" or
       * "413 request" forms). The underscore form `request_too_large`
       * does NOT — pinned by `INV-18-classifier-b`.
       */
      alsoContextOverflow: boolean;
    }
  | { kind: 'context-overflow' }
  | { kind: 'prompt-too-long' }
  | { kind: 'schema-validation' }
  | { kind: 'process-exit' }
  | { kind: 'transport-not-ready' }
  | { kind: 'expected-operational-timeout' }
  | { kind: 'unknown'; rawMessage: string };

function isExpectedOperationalTimeout(lower: string): boolean {
  return (
    lower.includes('run timed out before completion') ||
    lower.includes('timed out before completion') ||
    lower.includes('turn unresponsive') ||
    lower.includes('took too long to respond')
  );
}

function matchesContextOverflowBroad(lower: string): boolean {
  return (
    lower.includes('413') ||
    (lower.includes('context') &&
      (lower.includes('overflow') ||
        lower.includes('length') ||
        lower.includes('reduction') ||
        (lower.includes('window') && lower.includes('exceed')))) ||
    (lower.includes('token') && (lower.includes('exceed') || lower.includes('maximum')))
  );
}

function matchesRequestTooLarge(lower: string): boolean {
  return (
    lower.includes('request_too_large') ||
    lower.includes('request too large') ||
    (lower.includes('413') && lower.includes('request'))
  );
}

function matchesContextOverflowFromRequestTooLarge(lower: string): boolean {
  return lower.includes('request too large') || lower.includes('413');
}

function matchesPromptTooLong(lower: string): boolean {
  return (
    lower.includes('prompt') &&
    (lower.includes('too long') || lower.includes('too large') || lower.includes('exceed'))
  );
}

function matchesSchemaValidation(lower: string): boolean {
  return (
    lower.includes('invalid_request_error') &&
    (lower.includes('input_schema') || lower.includes('json schema is invalid'))
  );
}

/**
 * Single-pass classification of a thrown error. Pure: depends only on the
 * stringified error message — no `ctx`, no IO. The dispatcher composes
 * `hasMedia` / `outputCap` with the result to decide attachment vs context-
 * overflow vs prompt-too-long branches.
 */
export function classifyError(error: unknown): ErrorClassification {
  const rawMessage = getErrorMessage(error);
  if (!rawMessage) return { kind: 'unknown', rawMessage: '' };

  if (rawMessage.includes('Stream closed')) return { kind: 'stream-closed' };

  const lower = rawMessage.toLowerCase();

  if (
    lower.includes('image exceeds') &&
    lower.includes('maximum') &&
    lower.includes('bytes')
  ) {
    return { kind: 'image-exceeds-limit' };
  }

  if (matchesRequestTooLarge(lower)) {
    return {
      kind: 'request-too-large',
      alsoContextOverflow: matchesContextOverflowFromRequestTooLarge(lower),
    };
  }

  if (matchesContextOverflowBroad(lower)) {
    return { kind: 'context-overflow' };
  }

  if (matchesPromptTooLong(lower)) {
    return { kind: 'prompt-too-long' };
  }

  if (matchesSchemaValidation(lower)) {
    return { kind: 'schema-validation' };
  }

  if (lower.includes('process exited with code')) {
    return { kind: 'process-exit' };
  }

  if (lower.includes('processtransport') && lower.includes('not ready')) {
    return { kind: 'transport-not-ready' };
  }

  if (isExpectedOperationalTimeout(lower)) {
    return { kind: 'expected-operational-timeout' };
  }

  return { kind: 'unknown', rawMessage };
}
