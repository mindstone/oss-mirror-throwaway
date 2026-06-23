/**
 * Shared API-key-validation type vocabulary for onboarding.
 *
 * Extracted into its own dependency-free module so both
 * `apiKeyValidationMachine.ts` (which owns the pure transition + derivation
 * logic) and `useOnboardingFlow.ts` (which owns the effects/IPC/tracking) can
 * import these types WITHOUT forming an import cycle — exactly mirroring the
 * `toolAuthTypes.ts` rationale shipped in 260608. Consumers continue to import
 * `ApiKeyValidationStatus` from `./useOnboardingFlow`, which re-exports it.
 *
 * Design discipline this module encodes (read before editing):
 *
 *  1. `canSkip` is DERIVED, NEVER STORED. The flat public surface
 *     (`apiKeyValidationStatus` + `canSkipApiStep`) is computed from the single
 *     `ApiKeyValidation` source of truth via the machine selectors, so the two
 *     values cannot drift apart — "canSkip while not valid" is not in the state
 *     space (the `validatedOnWelcomeStep` flag lives ONLY on the `valid`
 *     variant, and `canSkip` is `valid && validatedOnWelcomeStep`).
 *
 *  2. `validatedOnWelcomeStep` captures the welcome-step TOCTOU decision at
 *     SETTLE time (I9/I10). The live effect sets status to `valid`
 *     unconditionally, then only allows the step-skip if the user is still on
 *     the welcome step (`stepIndexRef.current === 0`) at result-arrival time. So
 *     `{ status: 'valid', validatedOnWelcomeStep: false }` (valid-but-too-late)
 *     is a real, reachable state — the flag is captured when the `valid` variant
 *     is constructed, never read from a ref inside the pure machine.
 */

/**
 * Public, flat 4-value API-key validation status surfaced on
 * `OnboardingFlowState`. Unchanged from its prior in-hook definition; moved here
 * to break the hook⇄machine import cycle.
 */
export type ApiKeyValidationStatus = 'idle' | 'validating' | 'valid' | 'invalid';

/**
 * Internal discriminated-union state for API-key validation. The
 * `validatedOnWelcomeStep` flag exists ONLY on the `valid` variant so that
 * "canSkip while not valid" is unrepresentable (see discipline #1 above). It
 * captures the welcome-step decision at settle time (I9/I10): a `valid` result
 * that arrived after the user navigated past welcome carries `false`.
 */
export type ApiKeyValidation =
  | { status: 'idle' }
  | { status: 'validating' }
  | { status: 'valid'; validatedOnWelcomeStep: boolean }
  | { status: 'invalid' };
