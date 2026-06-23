import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  classifyRequest,
  remapToCodexEgressModel,
  type ClassifiableRequest,
} from '../localModelProxy/classifier';

const FAST_CHECK_NUM_RUNS = 300;
const FAST_CHECK_SEED = 260530;

const getFastCheckConfig = () => ({ numRuns: FAST_CHECK_NUM_RUNS, seed: FAST_CHECK_SEED });

const modelTokenArbitrary = fc.oneof(
  fc.constantFrom(
    '',
    'claude-opus-4-7',
    'CLAUDE-SONNET-4-5',
    'anthropic/claude-opus-4-7',
    'Anthropic/Claude-Sonnet-4-5',
    'gpt-5.5',
    'gpt-5.5-pro',
    'openai/gpt-4.1',
    'random-model',
  ),
  fc.string({ unit: 'grapheme', maxLength: 128 }),
);

const requestArbitrary: fc.Arbitrary<ClassifiableRequest> = fc.record({
  model: fc.option(modelTokenArbitrary, { nil: undefined }),
  stream: fc.option(fc.boolean(), { nil: undefined }),
  output_format: fc.option(
    fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.record({ type: fc.string({ maxLength: 16 }) }),
      fc.string({ maxLength: 32 }),
      fc.boolean(),
      fc.integer(),
    ),
    { nil: undefined },
  ),
});

const headerValueArbitrary = fc.option(fc.constantFrom('true', 'false', 'TRUE', '', '1'), {
  nil: undefined,
});

describe('localModelProxy classifier property tests', () => {
  it('REBEL-540: Codex egress model never uses a claude/anthropic dialect for arbitrary requested models', () => {
    fc.assert(
      fc.property(modelTokenArbitrary, (requestedModel) => {
        const resolution = remapToCodexEgressModel(requestedModel);
        const lower = resolution.model.toLowerCase();

        expect(lower.startsWith('claude')).toBe(false);
        expect(lower.startsWith('anthropic/claude')).toBe(false);
      }),
      getFastCheckConfig(),
    );
  });

  it('remapToCodexEgressModel is total and deterministic for arbitrary model strings', () => {
    fc.assert(
      fc.property(modelTokenArbitrary, (requestedModel) => {
        const first = remapToCodexEgressModel(requestedModel);
        const second = remapToCodexEgressModel(requestedModel);

        expect(first).toEqual(second);
        expect(typeof first.model).toBe('string');
        expect(first.model.length).toBeGreaterThan(0);
      }),
      getFastCheckConfig(),
    );
  });

  it('classifyRequest codex-turn branch always yields consistent codex axis combination with non-claude egress', () => {
    fc.assert(
      fc.property(requestArbitrary, headerValueArbitrary, headerValueArbitrary, (request, openRouterHeader, codexHeader) => {
        const classification = classifyRequest({
          headers: {
            'x-openrouter-turn': openRouterHeader,
            'x-codex-turn': codexHeader,
          },
          request,
          turnId: 'turn-prop',
        });

        if (classification.consumerClass === 'codex-turn') {
          expect(classification.providerTransport).toBe('codex-responses');
          expect(classification.authPlan).toBe('codex-oauth');
          const lower = classification.egress.model.toLowerCase();
          expect(lower.startsWith('claude')).toBe(false);
          expect(lower.startsWith('anthropic/claude')).toBe(false);
        }
      }),
      getFastCheckConfig(),
    );
  });

  it('classifyRequest never produces internally inconsistent axis combinations', () => {
    fc.assert(
      fc.property(requestArbitrary, headerValueArbitrary, headerValueArbitrary, (request, openRouterHeader, codexHeader) => {
        const classification = classifyRequest({
          headers: {
            'x-openrouter-turn': openRouterHeader,
            'x-codex-turn': codexHeader,
          },
          request,
          turnId: undefined,
        });

        switch (classification.consumerClass) {
          case 'openrouter-turn': {
            expect(classification.providerTransport).toBe('openrouter-passthrough');
            expect(classification.authPlan).toBe('openrouter-bearer');
            break;
          }
          case 'codex-turn': {
            expect(classification.providerTransport).toBe('codex-responses');
            expect(classification.authPlan).toBe('codex-oauth');
            break;
          }
          case 'route-resolved': {
            expect(classification.providerTransport).toBe('route-resolved');
            expect(classification.authPlan).toBe('route-resolved');
            break;
          }
          default: {
            const _exhaustive: never = classification;
            return _exhaustive;
          }
        }
      }),
      getFastCheckConfig(),
    );
  });
});
