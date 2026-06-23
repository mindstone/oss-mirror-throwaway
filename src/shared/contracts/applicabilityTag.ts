/**
 * Tagged-object sentinel for **applicability** of a manifest axis to a
 * given variant.
 *
 * Background — why this exists (parent plan
 * `260427_refactor_contract_manifest.md` § Manifest axes locked,
 * 2026-04-28): not every axis applies to every variant. For example,
 * `errorClassPolicy` (rate-limit / billing / retry semantics) only makes
 * sense for `error` and `result`; declaring it on `tool` or
 * `user_question` is meaningless. The naive escape hatches — leaving
 * the field out, or declaring `undefined` — both lose information at
 * review time:
 *
 *   - Leaving the field out conflicts with the **closed-strict**
 *     invariant of the manifest (every variant declares every axis).
 *     TypeScript would error.
 *   - Bare `undefined` compiles, but a future reviewer can't tell
 *     whether the implementer meant "intentionally not applicable" or
 *     "I forgot". That's exactly the parallel-declaration drift this
 *     refactor exists to eliminate.
 *
 * `applicabilityTag('not-applicable', '<rationale>')` solves both:
 *
 *   - **Closed-strict still enforced**: the axis type is, e.g.,
 *     `ErrorClassPolicy | ApplicabilityTag`, so TS demands a value
 *     either way.
 *   - **Semantic ambiguity surfaced**: any "this doesn't apply"
 *     declaration carries a non-empty rationale that ships with the
 *     value at runtime and is greppable in source.
 *
 * **Why a tagged object rather than a branded string?** (Round 2 review,
 * MUST-FIX from gemini3.1-pro + lens-structural-health, 2026-04-29.)
 * A branded string was the original v1 design but its runtime predicate
 * could not distinguish a tag from an arbitrary axis-enum string —
 * `isApplicabilityTag('transient-retry')` would return `true` because
 * the runtime check was just "non-empty string". A tagged object
 * (`{ kind: 'not-applicable', rationale: string }`) gives a real
 * structural test runtime callers can rely on; serialization round-trips
 * cleanly through JSON; and reviewers can still grep for
 * `'not-applicable'` to audit opt-outs.
 *
 * **Acceptance criterion (Stage 2, parent doc § 344-345)**: any axis
 * declared bare-`undefined` without this tag fails review; any tagged
 * `not-applicable` requires a rationale string.
 *
 * @see docs/plans/260427_refactor_contract_manifest.md § "Manifest axes (locked, 2026-04-28 — Stage 1.5)"
 * @see src/shared/types/bareToolId.ts (sibling pattern for branded scalar identities)
 */

/**
 * The kinds of applicability sentinels currently supported.
 *
 * Currently only `'not-applicable'` is defined. The kind is part of the
 * runtime payload so that future expansions (e.g., `'forwards-compat'`,
 * `'deferred'`) can be added without ambiguity.
 */
export type ApplicabilityKind = 'not-applicable';

/**
 * Tagged-object sentinel value for an axis that does not apply to a
 * given variant.
 *
 * Runtime shape is intentionally distinct from any plain axis-enum
 * value: the presence of the `kind: 'not-applicable'` literal makes
 * `isApplicabilityTag` reliably distinguishable from arbitrary string
 * inputs.
 */
export type ApplicabilityTag = Readonly<{
  kind: ApplicabilityKind;
  rationale: string;
}>;

/**
 * Construct an `ApplicabilityTag` declaring that a manifest axis does
 * not apply to the variant at hand. The returned object is frozen so
 * downstream consumers cannot mutate the rationale post-construction.
 *
 * Throws `TypeError` for empty / whitespace-only rationales. The
 * rationale is required for grep-ability per parent plan § 345; a
 * runtime guard is cheap insurance against an empty-string slip.
 */
export function applicabilityTag(
  kind: ApplicabilityKind,
  rationale: string,
): ApplicabilityTag {
  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    throw new TypeError(
      `applicabilityTag(${kind}, ...) requires a non-empty rationale string`,
    );
  }
  return Object.freeze({ kind, rationale });
}

/**
 * Predicate: is `value` an `ApplicabilityTag`? Performs a structural
 * check on the runtime shape (an object with a `kind: 'not-applicable'`
 * literal and a non-empty `rationale` string). Reliable across
 * surfaces; safe to use against deserialised JSON from the cloud
 * service or persisted store entries.
 */
export function isApplicabilityTag(value: unknown): value is ApplicabilityTag {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ApplicabilityTag>;
  return (
    candidate.kind === 'not-applicable'
    && typeof candidate.rationale === 'string'
    && candidate.rationale.trim().length > 0
  );
}

/**
 * Return the rationale embedded in an `ApplicabilityTag`. Exists so
 * tooling (lint scripts, doc generators) can inspect rationales without
 * the type-system juggling that the tagged shape otherwise requires.
 */
export function getApplicabilityRationale(tag: ApplicabilityTag): string {
  return tag.rationale;
}
