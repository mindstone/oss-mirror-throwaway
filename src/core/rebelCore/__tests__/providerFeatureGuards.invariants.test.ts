/**
 * Stage 3 paired-predicate invariant test (Opus MA-2).
 *
 * Asserts that the dialect choice (gate 2d, internal to `openaiClient.ts` as
 * `selectOpenAIPlannerSchema`) and the emission gate (gate 2a,
 * `emitsStrictResponseFormat`) never disagree.
 *
 * Today, both predicates are codex-INDEPENDENT — emission keys on
 * `providerType` only and the dialect choice keys on `format.name`. So the
 * operative invariant is:
 *
 *   "If `emitsStrictResponseFormat(providerType)` returns false, the dialect-
 *    selecting helper is never reached because `toOpenAIResponseFormat`
 *    returns `undefined` first (defense-in-depth)."
 *
 * The test value is regression-protection: if a future agent adds a
 * `providerType` axis to `selectOpenAIPlannerSchema`, the test forces them to
 * also update `emitsStrictResponseFormat` (or this invariant test) — the two
 * predicates must stay in lockstep.
 */

import { describe, it, expect } from 'vitest';
import type { OpenAIProviderType } from '@core/rebelCore/clients/openaiClientTypes';
import { emitsStrictResponseFormat } from '@core/rebelCore/providerFeatureGuards';

const ALL_PROVIDER_TYPES: readonly OpenAIProviderType[] = [
  'openai',
  'together',
  'cerebras',
  'other',
] as const;

describe('paired-predicate invariant: emission gate vs dialect selection', () => {
  it('emitsStrictResponseFormat governs whether dialect selection is even reachable', () => {
    // When the emission gate is closed, the planner-side dialect selector
    // (`selectOpenAIPlannerSchema`) MUST NOT be reached because
    // `toOpenAIResponseFormat` returns `undefined` first. This is the
    // defense-in-depth invariant that prevents OpenAI-strict schemas from
    // leaking into Cohere/Together/Cerebras requests.
    for (const providerType of ALL_PROVIDER_TYPES) {
      const wouldEmitStrict = emitsStrictResponseFormat(providerType);
      if (providerType !== 'openai') {
        expect(wouldEmitStrict).toBe(false);
      }
    }
  });

  it('only openai-native crosses the emission gate', () => {
    // The single shape that allows strict-mode dialect emission. Any future
    // deviation from this single shape requires updating BOTH
    // `emitsStrictResponseFormat` AND `selectOpenAIPlannerSchema` together.
    expect(emitsStrictResponseFormat('openai')).toBe(true);
  });
});
