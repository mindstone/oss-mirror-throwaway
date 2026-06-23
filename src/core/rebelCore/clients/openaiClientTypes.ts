/**
 * Shared types for the OpenAI-compatible client. Extracted from `openaiClient.ts`
 * so `providerFeatureGuards.ts` can import the discriminator without creating a
 * circular dependency through `openaiClient.ts -> providerFeatureGuards.ts ->
 * openaiClient.ts`.
 *
 * See docs/plans/260505_typed_provider_capability_matrix.md (Q-7).
 */
import { assertNever } from '../providerRouteDecision';
import type { ModelProviderType } from '@shared/types/settings';

export type OpenAIProviderType = 'openai' | 'together' | 'cerebras' | 'other';

/**
 * Normalizes the broader `ModelProviderType` union (anthropic | openai | google |
 * together | cerebras | openrouter | other | local) down to the closed
 * `OpenAIProviderType` union the OpenAI-compatible client and its predicates
 * understand.
 *
 * Anything that isn't natively in {'openai', 'together', 'cerebras'} is treated
 * as a generic OpenAI-compatible provider (`'other'`) — OpenRouter, the
 * localhost proxy, Google's OpenAI-compat endpoint, and any future
 * OpenAI-compat provider all share the OpenAI-compat HTTP shape but don't
 * receive OpenAI-strict structured outputs. Keeping `OpenAIProviderType` closed
 * AND normalizing at the boundary means the predicates can keep their
 * `assertNever(default)` exhaustiveness without crashing on values that flow
 * through `clientFactory` for routing.
 *
 * The parameter is typed as `ModelProviderType` (not `string`) so the switch
 * is exhaustive — adding a new variant to `ModelProviderType` becomes a
 * compile error here, forcing an explicit per-variant routing decision rather
 * than silently collapsing the new variant to `'other'`. This addresses the
 * Phase 7 Codex reviewer's silent-fail-closed concern at the type system level
 * rather than via runtime logging.
 */
export function normalizeToOpenAIProviderType(value: ModelProviderType): OpenAIProviderType {
  switch (value) {
    case 'openai':
    case 'together':
    case 'cerebras':
    case 'other':
      return value;
    case 'anthropic':
    case 'google':
    case 'openrouter':
    case 'local':
      return 'other';
    default:
      return assertNever(value, 'ModelProviderType (normalizeToOpenAIProviderType)');
  }
}
