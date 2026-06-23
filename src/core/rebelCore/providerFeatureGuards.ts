/**
 * [BUG-PREVENTION] Provider feature gate predicates.
 *
 * These predicates exist because the codebase has shipped 4 bugs (B/C/D/E) of
 * the form "feature added to shared client → silently fans out to provider that
 * doesn't support it" — all traceable to commit 225170e7f. ESLint blocks adding
 * new ad-hoc `providerType === '<literal>'` gates in client/planning paths;
 * this module is where those gates live instead.
 *
 * From the originating intake (verbatim):
 *   "The temptation when adding a new feature will be to 'just gate on
 *    `providerType` for now and add it to the matrix later.' Resist."
 *
 * Add a new predicate here — do NOT inline a check at the call site.
 *
 * Each predicate uses a `switch` over `OpenAIProviderType` with
 * `assertNever(default)` for TS exhaustiveness. Adding a new provider variant
 * forces every predicate to be revisited at compile time.
 *
 * See docs/plans/260505_typed_provider_capability_matrix.md.
 */

import type { OpenAIProviderType } from './clients/openaiClientTypes';
import { assertNever } from './providerRouteDecision';

/**
 * Whether the OpenAI-compatible client should emit `response_format` (strict
 * JSON Schema) for structured outputs.
 *
 * Mirrors the pre-migration check at `openaiClient.ts:135`
 * (`if (this.providerType !== 'openai') return undefined`) — a
 * codex-INDEPENDENT decision keyed on `providerType` alone. Codex profiles
 * carry `providerType: 'openai'` (per `clientFactory.ts`), so they DID emit
 * `response_format` pre-migration; the codex short-circuit in `doCreate` /
 * `doStream` (`if (this.codexMode) return this.doCodexCreate(...)`) is what
 * adapts the resulting request to the Codex Responses API. Adding a
 * `codexMode` axis here would suppress emission for Codex passthrough, which
 * is a behavior CHANGE rather than the mechanical migration this commit
 * targets. If hardening Codex's structured-output path is desired, do it as a
 * separate, evaluated follow-up.
 */
export function emitsStrictResponseFormat(providerType: OpenAIProviderType): boolean {
  switch (providerType) {
    case 'openai':
      return true;
    case 'together':
    case 'cerebras':
    case 'other':
      return false;
    default:
      return assertNever(providerType, 'OpenAIProviderType (emitsStrictResponseFormat)');
  }
}

/**
 * Whether the OpenAI-compatible client should route through the Responses API
 * (vs the Chat Completions API).
 *
 * Mirrors the pre-migration check at `openaiClient.ts:497-500`
 * (`return this.providerType === 'openai' && hasTools && !!request.reasoning_effort`)
 * — a codex-INDEPENDENT decision. The codex short-circuit higher in `doCreate` /
 * `doStream` already routes Codex passthrough to `doCodexCreate` before this
 * gate is consulted; encoding a broader rule here than the original gate it
 * replaced would be a future-trap. Returns `true` only when `providerType` is
 * native `'openai'`; the actual decision to use Responses requires
 * `hasTools && reasoning_effort` at the call site.
 */
export function takesResponsesApiRoute(providerType: OpenAIProviderType): boolean {
  switch (providerType) {
    case 'openai':
      return true;
    case 'together':
    case 'cerebras':
    case 'other':
      return false;
    default:
      return assertNever(providerType, 'OpenAIProviderType (takesResponsesApiRoute)');
  }
}

/**
 * Whether the non-chat-model guard (catalog regex check rejecting embeddings,
 * TTS, image, moderation models) should run for this provider. Only OpenAI
 * native ships those non-chat models on the same endpoint as chat completions;
 * other compat providers either don't expose them or use different model id
 * conventions.
 */
export function nonChatModelGuardEnabled(providerType: OpenAIProviderType): boolean {
  switch (providerType) {
    case 'openai':
      return true;
    case 'together':
    case 'cerebras':
    case 'other':
      return false;
    default:
      return assertNever(providerType, 'OpenAIProviderType (nonChatModelGuardEnabled)');
  }
}

/**
 * Whether the OpenAI-compatible client should advertise vision capability
 * (`capabilities.supportsImageContent`), i.e. whether it is safe to send an
 * inline image content block to this provider.
 *
 * FAIL-CLOSED: only the first-party `openai` endpoint is trusted for vision.
 * `together`, `cerebras`, and the catch-all `other` — into which
 * `normalizeToOpenAIProviderType` collapses OpenRouter, Google's OpenAI-compat
 * endpoint, and local/localhost proxies — are treated as NON-vision so that a
 * text-only model never receives an image block (which would be a provider
 * error). The model-facing boundary substitutes a text placeholder instead.
 *
 * This became load-bearing in the guard-large-tool-outputs fix (Stage 3/4):
 * `Read` now emits image blocks for arbitrary image files, not just
 * screenshots, so the capability bit can turn a file read into a provider
 * error on a text-only compat model unless we gate conservatively here.
 *
 * See docs/plans/260529_guard-large-tool-outputs/PLAN.md § Stage 4 (#4) and
 * docs/plans/260505_typed_provider_capability_matrix.md.
 */
export function supportsInlineImageContent(providerType: OpenAIProviderType): boolean {
  switch (providerType) {
    case 'openai':
      return true;
    case 'together':
    case 'cerebras':
    case 'other':
      return false;
    default:
      return assertNever(providerType, 'OpenAIProviderType (supportsInlineImageContent)');
  }
}

/**
 * Whether to run the gateway tool-signature diagnostic for this provider —
 * i.e. whether tool-calls from this provider can plausibly carry a Gemini
 * `thought_signature` over the OpenAI wire (litellm `id`/`provider_specific_fields`
 * or Google `extra_content`). Only the catch-all `other` covers custom gateways
 * (into which `normalizeToOpenAIProviderType` collapses OpenRouter, Google's
 * OpenAI-compat endpoint, and local/localhost proxies); first-party `openai`,
 * `together`, and `cerebras` never carry these conventions, so emitting the
 * diagnostic for them would be pure noise.
 *
 * Observability-only: this gate selects whether to EMIT a PII-safe analytics
 * event; it never changes request/response handling.
 *
 * See docs/project/CUSTOM_GATEWAY_COMPATIBILITY.md §2 and
 * docs/plans/260619_gemini-thought-signature-roundtrip/PLAN.md.
 */
export function surfacesCustomGatewayToolSignature(providerType: OpenAIProviderType): boolean {
  switch (providerType) {
    case 'other':
      return true;
    case 'openai':
    case 'together':
    case 'cerebras':
      return false;
    default:
      return assertNever(providerType, 'OpenAIProviderType (surfacesCustomGatewayToolSignature)');
  }
}

// TODO(2026-07-01): reassess provider feature gate hardening — see
// docs/plans/260505_typed_provider_capability_matrix.md Stage 7. Reassess
// triggers (escalate to Appendix A's typed-capability-matrix heavy plan):
//
//   A. A new bug of the silent-feature-fan-out class ships despite this
//      module + the lint rule. (Predicate dispatch wrong, lint rule bypassed,
//      etc.)
//   B. Predicate count grows to ≥8 within 8 weeks (hits the budget cap in
//      `scripts/check-feature-gate-budget.ts`, fails CI). The matrix's
//      cross-feature-consistency advantage starts paying off here.
//   C. Cross-feature inconsistency surfaces in code review (e.g., predicate
//      A says provider X is structured-output-capable but predicate B says
//      it isn't, with no documented rationale). CHIEF_ENGINEER reviewer
//      checkbox now requires pairwise cross-feature consistency check
//      whenever this module is modified.
//
// Negative trigger (CLOSE the TODO instead of escalating):
//
//   D. No new bugs of this class in 8 weeks AND <8 predicates AND no
//      cross-feature inconsistency. The matrix is YAGNI; remove this TODO.
