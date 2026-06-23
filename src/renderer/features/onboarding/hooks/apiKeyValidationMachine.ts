/**
 * Pure API-key-validation logic module for onboarding — the single typed source
 * of truth for "what validation state are we in, and what does that imply for
 * the step-skip decision". Replaces the two independent `useState`s in
 * `useOnboardingFlow.ts` (`apiKeyValidationStatus` + `canSkipApiStep`) that could
 * silently drift apart (e.g. `canSkip === true` while status is `invalid`).
 * Design rationale + the must-preserve invariant list (I1–I16) live in
 * `docs/plans/260609_onboarding-apikey-validation-fsm/PLAN.md` and its Planner
 * report §1.
 *
 * This slice is deliberately LIGHTER than `toolAuthMachine.ts`: it is single-
 * shot (ref-guarded, runs ≤once per wizard open), single-writer (one effect),
 * 4 strictly-linear states, with zero readers of the status field anywhere in
 * `src/`. So there is NO event-dispatch reducer and NO `assertNever`. The one
 * load-bearing bug class — `canSkipApiStep` drifting from the validation status
 * — is killed by DERIVING `canSkip` (never storing it): drift is not in the
 * state space.
 *
 * Discipline this module enforces (read before editing):
 *
 *  1. Transition constructors (`validating`, `validated`, `resetValidation`) are
 *     the SINGLE named chokepoint for building an `ApiKeyValidation`. The
 *     welcome-step decision (I9/I10) is captured by the caller and passed into
 *     `validated(onWelcomeStep, ...)` at SETTLE time — never read from a ref in
 *     here. The machine is pure (NO React import, NO side effects, no tracking,
 *     no logging — those stay in the hook layer per I13/I16).
 *
 *  2. `canSkipOf` DERIVES the public skip flag from the union; it is never
 *     stored. `valid && validatedOnWelcomeStep` is the only path to `true`.
 *
 *  3. OPEN-UNION DISCIPLINE at the IPC seam. The two
 *     `window.settingsApi.validate*Key` results are typed `ApiKeyValidationResult`
 *     at compile time but are runtime-unvalidated in-process IPC payloads, so
 *     `summariseValidation` treats them as `unknown` and reads `ok`/`reason`
 *     defensively (optional-chaining; no throw on `null`/non-object). There is
 *     deliberately NO `assertNever` over the raw payload — that is the exact
 *     open-union crash class (`project_codex_assertnever_open_unions`) we avoid.
 */
import type { ApiKeyValidation, ApiKeyValidationStatus } from './apiKeyValidationTypes';

/**
 * The initial / reset validation state. Exported as the single canonical seed so
 * the hook does not hand-author the literal.
 */
export const INITIAL_API_KEY_VALIDATION: ApiKeyValidation = { status: 'idle' };

// --- Transition constructors (the single named chokepoint) -------------------

/** Enter the in-flight `validating` state (idle → validating). */
export function validating(): ApiKeyValidation {
  return { status: 'validating' };
}

/**
 * Settle the validation. `bothValid` ⇒ `valid` carrying the welcome-step flag
 * captured by the caller at settle time (I6/I10); otherwise `invalid`. The
 * `valid` variant carrying `validatedOnWelcomeStep: false` (valid-but-too-late)
 * is intentionally reachable — status becomes `valid` unconditionally on
 * both-valid in the live effect, with the skip gated separately (I9/I10).
 */
export function validated(onWelcomeStep: boolean, bothValid: boolean): ApiKeyValidation {
  return bothValid ? { status: 'valid', validatedOnWelcomeStep: onWelcomeStep } : { status: 'invalid' };
}

/** Collapse back to `idle` (wizard close / reset). */
export function resetValidation(): ApiKeyValidation {
  return { status: 'idle' };
}

// --- Selectors (public-surface derivation) -----------------------------------

/** Flat 4-value public status (unchanged contract). */
export function statusOf(v: ApiKeyValidation): ApiKeyValidationStatus {
  return v.status;
}

/**
 * Whether the API step may be skipped. DERIVED, never stored: true ONLY when the
 * keys validated AND that result arrived while still on the welcome step
 * (I9/I10). By construction this can never be true unless `status === 'valid'`.
 */
export function canSkipOf(v: ApiKeyValidation): boolean {
  return v.status === 'valid' && v.validatedOnWelcomeStep;
}

// --- Boundary fold (the IPC seam) --------------------------------------------

/**
 * The shape of one validation outcome summary. `failureReason` is analytics-
 * load-bearing (I14) and is `null` exactly when `bothValid` is true.
 */
export interface ValidationSummary {
  claudeOk: boolean;
  voiceOk: boolean;
  bothValid: boolean;
  failureReason: string | null;
}

/**
 * Defensively read the OK-ness of one settled validation leg (I7). A leg is OK
 * iff it fulfilled with a truthy `ok` and a `reason` that is NOT `'unreachable'`.
 * Rejections (timeout/throw) ⇒ not OK; `reason === 'unreachable'` ⇒ not OK even
 * if `ok` is truthy (fail-safe); `ok` falsy ⇒ not OK. The settled `value` is
 * `unknown` at runtime, so fields are read with optional-chaining — never a
 * throw on `null`/non-object/missing fields.
 */
function legOk(result: PromiseSettledResult<unknown>): boolean {
  if (result.status !== 'fulfilled') {
    return false;
  }
  const value = result.value as { ok?: unknown; reason?: unknown } | null | undefined;
  return Boolean(value?.ok) && value?.reason !== 'unreachable';
}

/**
 * The per-leg reason fragment for `failureReason` (I14). A rejected leg
 * contributes `'network_error'`; a fulfilled leg contributes its raw `reason`,
 * falling back to `'unknown'` ONLY when `reason` is nullish (`null`/`undefined`).
 *
 * This `?? 'unknown'` mirrors the pre-extraction effect byte-for-byte: any other
 * value (a non-empty string like `'quota_exceeded'`, but also `''`, `0`, `false`,
 * or an object) is preserved and stringified by the caller's template literal —
 * it is NOT normalised to `'unknown'`. Do NOT "tighten" this to coerce
 * non-string values: those strings feed analytics dashboards (`claude_<reason>` /
 * `voice_<reason>`) and changing them is a silent analytics regression.
 */
function legReason(result: PromiseSettledResult<unknown>): string {
  if (result.status === 'rejected') {
    return 'network_error';
  }
  const value = result.value as { reason?: unknown } | null | undefined;
  return (value?.reason as string | undefined) ?? 'unknown';
}

/**
 * Fold the two `Promise.allSettled` results into the validation summary. This is
 * the seam where in-process IPC results (typed `ApiKeyValidationResult` at
 * compile time but runtime-unvalidated) are folded; the I7 OK-predicate and the
 * I14 `failureReason` precedence are reproduced byte-for-byte from the live
 * effect, with fail-safe defaults preserved exactly. No `assertNever` over the
 * raw payload (open-union crash hazard).
 *
 * `failureReason` precedence (only when !bothValid; else `null`):
 *   - `!claudeOk && !voiceOk`            → `'both_keys_invalid'`
 *   - else `!claudeOk`                   → `claude_${claudeReason}`
 *   - else (voice leg failed)            → `voice_${voiceReason}`
 * where each `*Reason` is `'network_error'` (rejected) or `value.reason ?? 'unknown'`.
 */
export function summariseValidation(
  claude: PromiseSettledResult<unknown>,
  voice: PromiseSettledResult<unknown>,
): ValidationSummary {
  const claudeOk = legOk(claude);
  const voiceOk = legOk(voice);
  const bothValid = claudeOk && voiceOk;

  let failureReason: string | null;
  if (bothValid) {
    failureReason = null;
  } else if (!claudeOk && !voiceOk) {
    failureReason = 'both_keys_invalid';
  } else if (!claudeOk) {
    failureReason = `claude_${legReason(claude)}`;
  } else {
    failureReason = `voice_${legReason(voice)}`;
  }

  return { claudeOk, voiceOk, bothValid, failureReason };
}
