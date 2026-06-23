import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  calculateCost,
  calculateCostOrWarn,
  _resetWarnedModelsForTesting,
  getModelPricing,
  resolveProfileCostTier,
  isModelSupported,
  getSupportedModels,
} from '../pricingCalculator';
import { unsafeAssertRoutingModelId } from '../modelChoiceCodec';

describe('pricingCalculator', () => {
  describe('calculateCost', () => {
    describe('basic cost calculation', () => {
      it('should calculate cost for claude-haiku-4-5', () => {
        // 1M input tokens @ $1.00/MTok = $1.00
        // 500K output tokens @ $5.00/MTok = $2.50
        // Total = $3.50
        const cost = calculateCost('claude-haiku-4-5', 1_000_000, 500_000);
        expect(cost).toBe(3.5);
      });

      it('should calculate cost for claude-sonnet-4-5', () => {
        // 1M input tokens @ $3.00/MTok = $3.00
        // 500K output tokens @ $15.00/MTok = $7.50
        // Total = $10.50
        const cost = calculateCost('claude-sonnet-4-5', 1_000_000, 500_000);
        expect(cost).toBe(10.5);
      });

      it('should calculate cost for claude-opus-4-5', () => {
        // 1M input tokens @ $5.00/MTok = $5.00
        // 500K output tokens @ $25.00/MTok = $12.50
        // Total = $17.50
        const cost = calculateCost('claude-opus-4-5', 1_000_000, 500_000);
        expect(cost).toBe(17.5);
      });

      it('should calculate cost for claude-opus-4-6', () => {
        // 1M input tokens @ $5.00/MTok = $5.00
        // 500K output tokens @ $25.00/MTok = $12.50
        // Total = $17.50
        const cost = calculateCost('claude-opus-4-6', 1_000_000, 500_000);
        expect(cost).toBe(17.5);
      });

      it('should calculate cost for claude-fable-5', () => {
        // 1M input tokens @ $10.00/MTok = $10.00
        // 500K output tokens @ $50.00/MTok = $25.00
        // Total = $35.00
        const cost = calculateCost('claude-fable-5', 1_000_000, 500_000);
        expect(cost).toBe(35.0);
      });

      it('should calculate small token counts correctly', () => {
        // 1000 input tokens @ $1.00/MTok = $0.001
        // 500 output tokens @ $5.00/MTok = $0.0025
        // Total = $0.0035
        const cost = calculateCost('claude-haiku-4-5', 1000, 500);
        expect(cost).toBeCloseTo(0.0035, 6);
      });

      it('should return 0 for zero tokens', () => {
        const cost = calculateCost('claude-haiku-4-5', 0, 0);
        expect(cost).toBe(0);
      });

      it('should return 0 for deepseek-v4-flash local pricing', () => {
        const cost = calculateCost('deepseek-v4-flash', 1000, 500, 0, 0);
        expect(cost).toBe(0);
      });
    });

    describe('third-party model pricing', () => {
      it.each([
        // OpenAI: 1M input + 500K output
        ['gpt-5.5', 20.0],       // $5.00 + $15.00
        ['gpt-5.4', 10.0],       // $2.50 + $7.50
        ['gpt-5.4-mini', 3.0],   // $0.75 + $2.25
        ['gpt-5.4-nano', 0.825], // $0.20 + $0.625
        ['gpt-5.3-codex', 8.75], // $1.75 + $7.00
        ['gpt-5.2', 6.25],       // $1.25 + $5.00
        ['gpt-5.1', 5.0],        // $1.00 + $4.00
        ['gpt-4o', 7.5],         // $2.50 + $5.00
        ['gpt-4.1', 6.0],        // $2.00 + $4.00
        ['o3', 6.0],             // $2.00 + $4.00
        // Gemini
        ['gemini-3.1-pro', 8.0],  // $2.00 + $6.00
        ['gemini-3-flash', 2.0],  // $0.50 + $1.50
        ['gemini-2.5-pro', 6.25], // $1.25 + $5.00
        ['gemini-2.5-flash', 1.55], // $0.30 + $1.25
        // DeepSeek
        ['deepseek-chat', 0.82],  // $0.27 + $0.55
        // xAI
        ['grok-3', 10.5],        // $3.00 + $7.50
        // Cerebras
        ['llama3.1-8b', 0.15],   // $0.10 + $0.05
        ['gpt-oss-120b', 0.725], // $0.35 + $0.375
      ])('should calculate cost for %s', (model, expectedCost) => {
        const cost = calculateCost(model, 1_000_000, 500_000);
        expect(cost).toBeCloseTo(expectedCost, 2);
      });
    });

    describe('cache token handling', () => {
      it('should calculate cost with cache creation tokens', () => {
        // 1M input @ $1.00/MTok = $1.00
        // 500K output @ $5.00/MTok = $2.50
        // 100K cache creation @ $1.25/MTok (125% of input) = $0.125
        // Total = $3.625
        const cost = calculateCost('claude-haiku-4-5', 1_000_000, 500_000, 100_000, 0);
        expect(cost).toBeCloseTo(3.625, 6);
      });

      it('should calculate cost with cache read tokens', () => {
        // 1M input @ $1.00/MTok = $1.00
        // 500K output @ $5.00/MTok = $2.50
        // 100K cache read @ $0.10/MTok (10% of input) = $0.01
        // Total = $3.51
        const cost = calculateCost('claude-haiku-4-5', 1_000_000, 500_000, 0, 100_000);
        expect(cost).toBeCloseTo(3.51, 6);
      });

      it('should calculate cost with both cache creation and read tokens', () => {
        // Using Sonnet for this test
        // 1M input @ $3.00/MTok = $3.00
        // 500K output @ $15.00/MTok = $7.50
        // 200K cache creation @ $3.75/MTok = $0.75
        // 300K cache read @ $0.30/MTok = $0.09
        // Total = $11.34
        const cost = calculateCost('claude-sonnet-4-5', 1_000_000, 500_000, 200_000, 300_000);
        expect(cost).toBeCloseTo(11.34, 6);
      });

      it('should handle undefined cache tokens', () => {
        const cost = calculateCost('claude-haiku-4-5', 1_000_000, 500_000, undefined, undefined);
        expect(cost).toBe(3.5);
      });
    });

    describe('model alias resolution', () => {
      it('should handle dated snapshot: claude-haiku-4-5-20241022', () => {
        const cost = calculateCost('claude-haiku-4-5-20241022', 1_000_000, 500_000);
        expect(cost).toBe(3.5);
      });

      it('should handle dated snapshot: claude-sonnet-4-5-20241022', () => {
        const cost = calculateCost('claude-sonnet-4-5-20241022', 1_000_000, 500_000);
        expect(cost).toBe(10.5);
      });

      it('should handle dated snapshot: claude-opus-4-5-20250219', () => {
        const cost = calculateCost('claude-opus-4-5-20250219', 1_000_000, 500_000);
        expect(cost).toBe(17.5);
      });

      it('should handle dated snapshot: claude-opus-4-6-20260205', () => {
        const cost = calculateCost('claude-opus-4-6-20260205', 1_000_000, 500_000);
        expect(cost).toBe(17.5);
      });

      it('should handle legacy model: claude-3-5-haiku-20241022', () => {
        const cost = calculateCost('claude-3-5-haiku-20241022', 1_000_000, 500_000);
        expect(cost).toBe(3.5);
      });

      it('should handle legacy model: claude-3-5-sonnet-20241022', () => {
        const cost = calculateCost('claude-3-5-sonnet-20241022', 1_000_000, 500_000);
        expect(cost).toBe(10.5);
      });

      it('should handle legacy model: claude-3-opus-20240229', () => {
        // Opus 3: 1M input @ $15/MTok = $15.00, 500K output @ $75/MTok = $37.50
        const cost = calculateCost('claude-3-opus-20240229', 1_000_000, 500_000);
        expect(cost).toBe(52.5);
      });

      it('should handle future dated snapshots via pattern matching', () => {
        // Should match claude-haiku-4-5 via pattern matching
        const cost = calculateCost('claude-haiku-4-5-20251231', 1_000_000, 500_000);
        expect(cost).toBe(3.5);
      });

      it('should handle [1m] extended context suffix', () => {
        const cost = calculateCost('claude-sonnet-4-5[1m]', 1_000_000, 500_000);
        expect(cost).toBe(10.5);
      });

      it('should be case insensitive', () => {
        const cost = calculateCost('CLAUDE-HAIKU-4-5', 1_000_000, 500_000);
        expect(cost).toBe(3.5);
      });

      it('should handle whitespace', () => {
        const cost = calculateCost('  claude-haiku-4-5  ', 1_000_000, 500_000);
        expect(cost).toBe(3.5);
      });

      it('should resolve gpt-5.2-codex to gpt-5.2 pricing', () => {
        const canonical = calculateCost('gpt-5.2', 450_000, 180_000);
        const aliased = calculateCost('gpt-5.2-codex', 450_000, 180_000);
        expect(aliased).toBeCloseTo(canonical!, 6);
      });

      it('should resolve deepseek-r1 to deepseek-reasoner pricing', () => {
        const canonical = calculateCost('deepseek-reasoner', 600_000, 300_000);
        const aliased = calculateCost('deepseek-r1', 600_000, 300_000);
        expect(aliased).toBeCloseTo(canonical!, 6);
      });

      it('accepts RoutingModelId catalog ids without converting them to WireModelId', () => {
        const openRouterAlias = unsafeAssertRoutingModelId('openai/gpt-5.5');
        const dottedAnthropic = unsafeAssertRoutingModelId('claude-opus-4.7');
        const extendedContext = unsafeAssertRoutingModelId('claude-sonnet-4-5[1m]');

        expect(calculateCost(openRouterAlias, 1_000_000, 500_000)).toBeCloseTo(21.1, 2);
        expect(calculateCost(dottedAnthropic, 1_000_000, 500_000)).toBeCloseTo(17.5, 2);
        expect(calculateCost(extendedContext, 1_000_000, 500_000)).toBe(10.5);
      });
    });

    describe('unknown model handling', () => {
      it('should return null for unknown models', () => {
        const cost = calculateCost('unknown-model', 1000, 500);
        expect(cost).toBeNull();
      });

      it('should return null for use-alternative', () => {
        const cost = calculateCost('use-alternative', 1000, 500);
        expect(cost).toBeNull();
      });

      it('should return null for empty model name', () => {
        const cost = calculateCost('', 1000, 500);
        expect(cost).toBeNull();
      });

      it('should return null for gpt models', () => {
        const cost = calculateCost('gpt-4', 1000, 500);
        expect(cost).toBeNull();
      });
    });

    describe('input validation', () => {
      it('should throw for negative input tokens', () => {
        expect(() => calculateCost('claude-haiku-4-5', -1000, 500)).toThrow(/Invalid inputTokens/);
      });

      it('should throw for negative output tokens', () => {
        expect(() => calculateCost('claude-haiku-4-5', 1000, -500)).toThrow(/Invalid outputTokens/);
      });

      it('should throw for negative cache creation tokens', () => {
        expect(() => calculateCost('claude-haiku-4-5', 1000, 500, -100, 0)).toThrow(/Invalid cacheCreationTokens/);
      });

      it('should throw for negative cache read tokens', () => {
        expect(() => calculateCost('claude-haiku-4-5', 1000, 500, 0, -100)).toThrow(/Invalid cacheReadTokens/);
      });

      it('should throw for NaN input tokens', () => {
        expect(() => calculateCost('claude-haiku-4-5', NaN, 500)).toThrow(/Invalid inputTokens/);
      });

      it('should throw for NaN output tokens', () => {
        expect(() => calculateCost('claude-haiku-4-5', 1000, NaN)).toThrow(/Invalid outputTokens/);
      });

      it('should throw for Infinity input tokens', () => {
        expect(() => calculateCost('claude-haiku-4-5', Infinity, 500)).toThrow(/Invalid inputTokens/);
      });

      it('should throw for Infinity output tokens', () => {
        expect(() => calculateCost('claude-haiku-4-5', 1000, Infinity)).toThrow(/Invalid outputTokens/);
      });
    });
  });

  describe('getModelPricing', () => {
    it('should return pricing for known model', () => {
      const pricing = getModelPricing('claude-haiku-4-5');
      expect(pricing).toEqual({
        input: 1.0,
        output: 5.0,
        cacheRead: 0.10,
        cacheCreation: 1.25,
      });
    });

    it('should return pricing for dated snapshot', () => {
      const pricing = getModelPricing('claude-haiku-4-5-20241022');
      expect(pricing).not.toBeNull();
      expect(pricing?.input).toBe(1.0);
    });

    it('should return pricing for opus 4.6', () => {
      const pricing = getModelPricing('claude-opus-4-6');
      expect(pricing).toEqual({
        input: 5.0,
        output: 25.0,
        cacheRead: 0.50,
        cacheCreation: 6.25,
      });
    });

    it('should return null for unknown model', () => {
      const pricing = getModelPricing('unknown-model');
      expect(pricing).toBeNull();
    });
  });

  describe('resolveProfileCostTier', () => {
    it('returns profile costTier when explicitly set', () => {
      const tier = resolveProfileCostTier({ costTier: 'mid-tier', model: 'unknown-model', providerType: 'openai' });
      expect(tier).toBe('mid-tier');
    });

    it('falls through to catalog for known model when costTier is undefined', () => {
      const tier = resolveProfileCostTier({ model: 'gpt-5.5', providerType: 'openai' });
      expect(tier).toBe('premium');
    });

    it("falls through to 'economy' when model is unknown and providerType is local", () => {
      const tier = resolveProfileCostTier({ model: 'my-local-model', providerType: 'local' });
      expect(tier).toBe('economy');
    });

    it('returns null when model is unknown and providerType is not local', () => {
      const tier = resolveProfileCostTier({ model: 'my-unknown-cloud-model', providerType: 'openai' });
      expect(tier).toBeNull();
    });

    it('returns null when model is undefined and providerType is missing', () => {
      const tier = resolveProfileCostTier({});
      expect(tier).toBeNull();
    });

    it('uses override precedence over catalog tier', () => {
      const tier = resolveProfileCostTier({ costTier: 'premium', model: 'gpt-oss-120b', providerType: 'openai' });
      expect(tier).toBe('premium');
    });

    it("returns 'economy' for local DS4 preset profiles via catalog pricing", () => {
      const tier = resolveProfileCostTier({
        model: 'deepseek-v4-flash',
        providerType: 'other',
        presetKey: 'local:ds4',
      });
      expect(tier).toBe('economy');
    });
  });

  describe('isModelSupported', () => {
    it('should return true for supported models', () => {
      expect(isModelSupported('claude-haiku-4-5')).toBe(true);
      expect(isModelSupported('claude-sonnet-4-5')).toBe(true);
      expect(isModelSupported('claude-opus-4-5')).toBe(true);
    });

    it('should return true for dated snapshots', () => {
      expect(isModelSupported('claude-haiku-4-5-20241022')).toBe(true);
      expect(isModelSupported('claude-sonnet-4-5-20241022')).toBe(true);
    });

    it('should return true for extended context variants', () => {
      expect(isModelSupported('claude-sonnet-4-5[1m]')).toBe(true);
    });

    it('should return true for supported third-party models', () => {
      expect(isModelSupported('gpt-4o')).toBe(true);
      expect(isModelSupported('gpt-5.2')).toBe(true);
      expect(isModelSupported('gpt-5.5')).toBe(true);
      expect(isModelSupported('gpt-5.4-mini')).toBe(true);
      expect(isModelSupported('gpt-5.3-codex')).toBe(true);
      expect(isModelSupported('gpt-5.1')).toBe(true);
      expect(isModelSupported('gemini-3.1-pro')).toBe(true);
      expect(isModelSupported('gemini-3-flash')).toBe(true);
      expect(isModelSupported('gemini-2.5-pro')).toBe(true);
      expect(isModelSupported('deepseek-chat')).toBe(true);
      expect(isModelSupported('grok-3')).toBe(true);
      expect(isModelSupported('llama3.1-8b')).toBe(true);
      expect(isModelSupported('gpt-oss-120b')).toBe(true);
    });

    it('should return false for unsupported models', () => {
      expect(isModelSupported('unknown-model')).toBe(false);
      expect(isModelSupported('use-alternative')).toBe(false);
    });
  });

  describe('getSupportedModels', () => {
    it('should return all supported model aliases', () => {
      const models = getSupportedModels();
      // Anthropic models
      expect(models).toContain('claude-haiku-4-5');
      expect(models).toContain('claude-sonnet-4-6');
      expect(models).toContain('claude-sonnet-4-5');
      expect(models).toContain('claude-opus-4-5');
      expect(models).toContain('claude-opus-4-6');
      expect(models).toContain('claude-opus-4-1');
      expect(models).toContain('claude-opus-4');
      expect(models).toContain('claude-sonnet-4');
      expect(models).toContain('claude-sonnet-3-7');
      expect(models).toContain('claude-haiku-3-5');
      expect(models).toContain('claude-opus-3');
      expect(models).toContain('claude-haiku-3');
      // Third-party models
      expect(models).toContain('gpt-4o');
      expect(models).toContain('gpt-5.2');
      expect(models).toContain('gpt-5.5');
      expect(models).toContain('gpt-5.4-mini');
      expect(models).toContain('gpt-5.5-pro');
      expect(models).toContain('gpt-5.3-codex');
      expect(models).toContain('gemini-3.1-pro');
      expect(models).toContain('gemini-3-flash');
      expect(models).toContain('gemini-2.5-pro');
      expect(models).toContain('gemini-2.5-flash-lite');
      expect(models).toContain('deepseek-chat');
      expect(models).toContain('grok-3');
      expect(models).toContain('llama3.1-8b');
      expect(models).toContain('gpt-oss-120b');
      expect(models.length).toBeGreaterThanOrEqual(45);
    });
  });

  describe('FOX-2812 cost audit scenarios', () => {
    it('should calculate cost for FOX-2812 cited event: Opus 4.6[1m]', () => {
      // Real event: model=claude-opus-4-6[1m], input=43, output=11067,
      // cacheRead=7387606, cacheCreation=163523
      // Expected: (43/1M)*5 + (11067/1M)*25 + (7387606/1M)*0.50 + (163523/1M)*6.25
      //         = 0.000215 + 0.276675 + 3.693803 + 1.022019 = ~4.993
      const cost = calculateCost(
        'claude-opus-4-6[1m]', 43, 11067, 163523, 7387606
      );
      expect(cost).not.toBeNull();
      expect(cost!).toBeCloseTo(4.993, 2);
    });

    it('should calculate cost for claude-opus-4-1', () => {
      // 1M input @ $15/MTok = $15, 500K output @ $75/MTok = $37.50
      const cost = calculateCost('claude-opus-4-1', 1_000_000, 500_000);
      expect(cost).toBe(52.5);
    });

    it('should calculate cost for claude-opus-4', () => {
      const cost = calculateCost('claude-opus-4', 1_000_000, 500_000);
      expect(cost).toBe(52.5);
    });

    it('should calculate cost for claude-sonnet-4', () => {
      // 1M input @ $3/MTok = $3, 500K output @ $15/MTok = $7.50
      const cost = calculateCost('claude-sonnet-4', 1_000_000, 500_000);
      expect(cost).toBe(10.5);
    });

    it('should calculate cost for claude-sonnet-3-7', () => {
      const cost = calculateCost('claude-sonnet-3-7', 1_000_000, 500_000);
      expect(cost).toBe(10.5);
    });

    it('should calculate cost for claude-haiku-3-5', () => {
      // 1M input @ $0.80/MTok = $0.80, 500K output @ $4/MTok = $2.00
      const cost = calculateCost('claude-haiku-3-5', 1_000_000, 500_000);
      expect(cost).toBe(2.8);
    });

    it('should calculate cost for claude-opus-3', () => {
      const cost = calculateCost('claude-opus-3', 1_000_000, 500_000);
      expect(cost).toBe(52.5);
    });

    it('should calculate cost for claude-haiku-3', () => {
      // 1M input @ $0.25/MTok = $0.25, 500K output @ $1.25/MTok = $0.625
      const cost = calculateCost('claude-haiku-3', 1_000_000, 500_000);
      expect(cost).toBe(0.875);
    });

    it('should resolve snapshot aliases for new models', () => {
      expect(isModelSupported('claude-opus-4-1-20250805')).toBe(true);
      expect(isModelSupported('claude-opus-4-20250514')).toBe(true);
      expect(isModelSupported('claude-sonnet-4-20250514')).toBe(true);
      expect(isModelSupported('claude-sonnet-3-7-20250219')).toBe(true);
      expect(isModelSupported('claude-3-7-sonnet-20250219')).toBe(true);
      expect(isModelSupported('claude-3-haiku-20240307')).toBe(true);
    });

    it('should return null for composite model strings', () => {
      // Composite model strings (e.g. "model1 + model2") are not valid for pricing lookup
      const pricing = getModelPricing('claude-opus-4-6 + claude-sonnet-4-6');
      expect(pricing).toBeNull();
    });
  });

  describe('OpenRouter model ID resolution', () => {
    it('should use OR-specific pricing (with 5.5% platform markup), not SDK pricing', () => {
      const sdkCost = calculateCost('claude-sonnet-4-6', 1_000_000, 500_000);
      const orCost = calculateCost('anthropic/claude-sonnet-4-6', 1_000_000, 500_000);
      expect(orCost).not.toBeNull();
      expect(sdkCost).not.toBeNull();
      // OR pricing includes 5.5% platform markup — costs must differ
      expect(orCost).not.toBe(sdkCost);
      expect(orCost!).toBeGreaterThan(sdkCost!);
    });

    it.each([
      // [OR ID, expected input $/M, expected output $/M]
      // All values = OR list price × 1.055 platform-fee convention, rounded to 2 decimals.
      // Re-verified 2026-05-01 against openrouter.ai/<model> list prices (dashed IDs).
      ['anthropic/claude-fable-5', 10.55, 52.75],
      ['anthropic/claude-opus-4-7', 5.28, 26.38],
      ['anthropic/claude-sonnet-4-6', 3.17, 15.83],
      ['anthropic/claude-haiku-4-5', 1.06, 5.28],
      ['openai/gpt-5.5', 5.28, 31.65],
      ['openai/gpt-5.4', 2.64, 15.83],
      ['openai/gpt-5.3-codex', 1.85, 14.77],
      ['minimax/minimax-m2.7', 0.32, 1.27],
      ['minimax/minimax-m2.5', 0.53, 2.10], // historical: kept for cost calc on legacy m2.5 logs
      ['z-ai/glm-5.2', 1.06, 4.22],
      ['z-ai/glm-5.1', 1.11, 3.69],
      ['z-ai/glm-5-turbo', 1.27, 4.22],
      ['z-ai/glm-5', 0.63, 2.19],
      ['z-ai/glm-4.7', 0.40, 1.84],
      ['z-ai/glm-4.7-flash', 0.06, 0.42],
    ])('should calculate correct OR cost for %s', (orId, inputRate, outputRate) => {
      const cost = calculateCost(orId, 1_000_000, 500_000);
      // cost = (1M * inputRate / 1M) + (500K * outputRate / 1M)
      const expected = inputRate + (500_000 * outputRate) / 1_000_000;
      expect(cost).not.toBeNull();
      expect(cost).toBeCloseTo(expected, 4);
    });

    it('should return null for unknown OR provider/model', () => {
      const cost = calculateCost('unknownprovider/unknownmodel', 1_000_000, 500_000);
      expect(cost).toBeNull();
    });

    it('should resolve the OR-canonical Fable slug anthropic/claude-5-fable-20260609 for pricing', () => {
      // OR responses can echo OR's internal canonical slug instead of the dashed
      // external ID. It carries no dotted version, so resolveOrModelToSdkId's
      // pattern fallback can't parse it — the openRouter.legacyIds entry on
      // anthropic/claude-fable-5 is what makes this resolve (PLAN.md Stage 1,
      // Runtime Safety F4). Resolves to SDK base pricing, like other remapped ids.
      const pricing = getModelPricing('anthropic/claude-5-fable-20260609');
      expect(pricing).not.toBeNull();
      expect(pricing).toEqual(getModelPricing('claude-fable-5'));
      const cost = calculateCost('anthropic/claude-5-fable-20260609', 1_000_000, 500_000);
      expect(cost).toBe(35.0);
    });

    it('should resolve the OR-canonical GLM 5.2 slug z-ai/glm-5.2-20260616 for pricing', () => {
      // OR can echo its internal canonical slug (z-ai/glm-5.2-20260616) instead
      // of the catalog id z-ai/glm-5.2. This resolves via the openRouter.legacyIds
      // exact alias (and would also resolve via resolveOrModelToSdkId's date-strip
      // fallback, since stripping -20260616 yields the catalog id). Pins that
      // OR-echoed canonical-slug usage maps to the same base pricing for tracking.
      const pricing = getModelPricing('z-ai/glm-5.2-20260616');
      expect(pricing).not.toBeNull();
      expect(pricing).toEqual(getModelPricing('z-ai/glm-5.2'));
    });

    it('should resolve dated OR snapshot anthropic/claude-4.6-opus-20260205 via SDK fallback', () => {
      const cost = calculateCost('anthropic/claude-4.6-opus-20260205', 1_000_000, 500_000);
      expect(cost).not.toBeNull();
      // Falls through to SDK pricing (base cost without OR markup) since dated snapshots
      // are not in the OR catalog. Exact cost comes from the API response for OR turns.
      const sdkCost = calculateCost('claude-opus-4-6', 1_000_000, 500_000);
      expect(cost).toBe(sdkCost);
    });

    it('should resolve dated OR snapshot anthropic/claude-4.6-sonnet-20260217 via SDK fallback', () => {
      const cost = calculateCost('anthropic/claude-4.6-sonnet-20260217', 1_000_000, 500_000);
      expect(cost).not.toBeNull();
      const sdkCost = calculateCost('claude-sonnet-4-6', 1_000_000, 500_000);
      expect(cost).toBe(sdkCost);
    });

    it('should resolve dated non-Anthropic OR model openai/gpt-5.5-20260301 to OR pricing', () => {
      const cost = calculateCost('openai/gpt-5.5-20260301', 1_000_000, 500_000);
      expect(cost).not.toBeNull();
      // Resolves via dated-snapshot pattern matching to openai/gpt-5.5 (OR catalog entry with markup)
      const orCost = calculateCost('openai/gpt-5.5', 1_000_000, 500_000);
      expect(cost).toBe(orCost);
    });

    it('should return null for completely unknown OR model', () => {
      const cost = calculateCost('unknown/unknown-model', 1_000_000, 500_000);
      expect(cost).toBeNull();
    });

    it('should be case insensitive for OR model IDs', () => {
      const cost = calculateCost('Anthropic/Claude-Sonnet-4-6', 1_000_000, 500_000);
      expect(cost).not.toBeNull();
      // Should match the OR catalog entry pricing
      const expected = calculateCost('anthropic/claude-sonnet-4-6', 1_000_000, 500_000);
      expect(cost).toBe(expected);
    });

    it('should mark OR models as supported via isModelSupported', () => {
      expect(isModelSupported('anthropic/claude-sonnet-4-6')).toBe(true);
      expect(isModelSupported('openai/gpt-5.5')).toBe(true);
    });

    it('should return OR-specific pricing via getModelPricing', () => {
      const pricing = getModelPricing('anthropic/claude-sonnet-4-6');
      expect(pricing).not.toBeNull();
      expect(pricing?.input).toBe(3.17);
      expect(pricing?.output).toBe(15.83);
    });

    it.each([
      // [OR ID, expected cacheRead $/M, expected cacheCreation $/M]
      // OR list cache rates × 1.055; cache creation = OR cache write rate where OR
      // exposes one (Anthropic), else input price (OpenAI/MiniMax/GLM).
      ['anthropic/claude-fable-5',    1.06, 13.19],
      ['anthropic/claude-opus-4-7',  0.53, 6.59],
      ['anthropic/claude-sonnet-4-6', 0.32, 3.96],
      ['anthropic/claude-haiku-4-5',  0.11, 1.32],
      ['openai/gpt-5.5',              0.53, 5.28],
      ['openai/gpt-5.4',              0.26, 2.64],
      ['openai/gpt-5.3-codex',        0.18, 1.85],
      ['minimax/minimax-m2.7',        0.32, 0.32],
      ['z-ai/glm-5.2',                1.06, 1.06],
      ['z-ai/glm-5.1',                1.11, 1.11],
    ])('should return correct OR cache pricing for %s', (orId, cacheRead, cacheCreation) => {
      const pricing = getModelPricing(orId);
      expect(pricing).not.toBeNull();
      expect(pricing?.cacheRead).toBe(cacheRead);
      expect(pricing?.cacheCreation).toBe(cacheCreation);
    });
  });

  describe('calculateCostOrWarn', () => {
    const mockLogger = {
      warn: vi.fn(),
      error: vi.fn(),
    };

    beforeEach(() => {
      _resetWarnedModelsForTesting();
      mockLogger.warn.mockClear();
      mockLogger.error.mockClear();
    });

    it('should return cost for known model', () => {
      const cost = calculateCostOrWarn('claude-haiku-4-5', 1_000_000, 500_000, mockLogger, 'test');
      expect(cost).toBe(3.5);
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should return null and warn for unknown model', () => {
      const cost = calculateCostOrWarn('unknown-model', 1000, 500, mockLogger, 'test');
      expect(cost).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledOnce();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { model: 'unknown-model', context: 'test' },
        'Model has no pricing in MODEL_CATALOG — cost tracking skipped',
      );
    });

    it('should only warn once per model (second call does not warn)', () => {
      calculateCostOrWarn('unknown-model', 1000, 500, mockLogger, 'test');
      expect(mockLogger.warn).toHaveBeenCalledOnce();

      mockLogger.warn.mockClear();
      const cost2 = calculateCostOrWarn('unknown-model', 2000, 1000, mockLogger, 'test');
      expect(cost2).toBeNull();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should warn separately for different unknown models', () => {
      calculateCostOrWarn('unknown-a', 1000, 500, mockLogger, 'test');
      calculateCostOrWarn('unknown-b', 1000, 500, mockLogger, 'test');
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });

    it('should catch invalid-token throws and return null with error log', () => {
      const cost = calculateCostOrWarn('claude-haiku-4-5', NaN, 500, mockLogger, 'test');
      expect(cost).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledOnce();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-haiku-4-5', context: 'test' }),
        'calculateCost threw — invalid token data (bug)',
      );
      // Should NOT also warn (the throw is the error, not an unknown model)
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should use "unknown" as default context when not provided', () => {
      calculateCostOrWarn('unknown-model', 1000, 500, mockLogger);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { model: 'unknown-model', context: 'unknown' },
        'Model has no pricing in MODEL_CATALOG — cost tracking skipped',
      );
    });

    it('should support cache tokens', () => {
      const cost = calculateCostOrWarn(
        'claude-haiku-4-5', 1_000_000, 500_000, mockLogger, 'test', 100_000, 100_000,
      );
      expect(cost).not.toBeNull();
      expect(cost!).toBeGreaterThan(3.5); // Base cost + cache costs
    });
  });
});
