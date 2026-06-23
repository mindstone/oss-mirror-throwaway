import { describe, it, expect } from 'vitest';
import {
  normalizeOrModelId,
  OR_MODEL_CATALOG,
  remapModelOnProviderSwitch,
  resolveOrModelToSdkId,
} from '../openRouterModels';

describe('openRouterModels', () => {
  describe('OR_MODEL_CATALOG integrity', () => {
    it('should have unique model IDs', () => {
      const ids = OR_MODEL_CATALOG.map(e => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have at least one entry with sdkModel', () => {
      const withSdk = OR_MODEL_CATALOG.filter(e => e.sdkModel);
      expect(withSdk.length).toBeGreaterThanOrEqual(1);
    });

    it('should have unique sdkModel values', () => {
      const sdkModels = OR_MODEL_CATALOG
        .filter(e => e.sdkModel)
        .map(e => e.sdkModel);
      expect(new Set(sdkModels).size).toBe(sdkModels.length);
    });
  });

  describe('remapModelOnProviderSwitch', () => {
    // SDK → OpenRouter (toOpenRouter = true)
    describe('SDK to OpenRouter', () => {
      it('maps claude-opus-4-7 to anthropic/claude-opus-4-7', () => {
        expect(remapModelOnProviderSwitch('claude-opus-4-7', true))
          .toBe('anthropic/claude-opus-4-7');
      });

      it('maps claude-opus-4-6 to anthropic/claude-opus-4-6', () => {
        expect(remapModelOnProviderSwitch('claude-opus-4-6', true))
          .toBe('anthropic/claude-opus-4-6');
      });

      it('maps claude-sonnet-4-6 to anthropic/claude-sonnet-4-6', () => {
        expect(remapModelOnProviderSwitch('claude-sonnet-4-6', true))
          .toBe('anthropic/claude-sonnet-4-6');
      });

      it('maps claude-haiku-4-5 to anthropic/claude-haiku-4-5', () => {
        expect(remapModelOnProviderSwitch('claude-haiku-4-5', true))
          .toBe('anthropic/claude-haiku-4-5');
      });

      it('falls back to openai/gpt-5.5 for unknown SDK IDs', () => {
        expect(remapModelOnProviderSwitch('unknown-model', true))
          .toBe('openai/gpt-5.5');
      });

      it('falls back for empty string', () => {
        expect(remapModelOnProviderSwitch('', true))
          .toBe('openai/gpt-5.5');
      });
    });

    // OpenRouter → SDK (toOpenRouter = false)
    describe('OpenRouter to SDK', () => {
      it('maps anthropic/claude-opus-4-7 to claude-opus-4-7', () => {
        expect(remapModelOnProviderSwitch('anthropic/claude-opus-4-7', false))
          .toBe('claude-opus-4-7');
      });

      it('maps anthropic/claude-opus-4-6 to claude-opus-4-6', () => {
        expect(remapModelOnProviderSwitch('anthropic/claude-opus-4-6', false))
          .toBe('claude-opus-4-6');
      });

      it('maps anthropic/claude-sonnet-4-6 to claude-sonnet-4-6', () => {
        expect(remapModelOnProviderSwitch('anthropic/claude-sonnet-4-6', false))
          .toBe('claude-sonnet-4-6');
      });

      it('maps anthropic/claude-haiku-4-5 to claude-haiku-4-5', () => {
        expect(remapModelOnProviderSwitch('anthropic/claude-haiku-4-5', false))
          .toBe('claude-haiku-4-5');
      });

      it('falls back to claude-sonnet-4-6 for non-Claude OpenRouter models', () => {
        expect(remapModelOnProviderSwitch('google/gemini-3.1-pro-preview', false))
          .toBe('claude-sonnet-4-6');
      });

      it('falls back to claude-sonnet-4-6 for unknown OpenRouter IDs', () => {
        expect(remapModelOnProviderSwitch('unknown/model', false))
          .toBe('claude-sonnet-4-6');
      });

      it('falls back for empty string', () => {
        expect(remapModelOnProviderSwitch('', false))
          .toBe('claude-sonnet-4-6');
      });
    });

    // Round-trip consistency
    describe('round-trip consistency', () => {
      it('SDK → OR → SDK returns original for all mapped models', () => {
        const mappedModels = OR_MODEL_CATALOG
          .filter(e => e.sdkModel)
          .map(e => e.sdkModel!);

        for (const sdkId of mappedModels) {
          const orId = remapModelOnProviderSwitch(sdkId, true);
          const backToSdk = remapModelOnProviderSwitch(orId, false);
          expect(backToSdk).toBe(sdkId);
        }
      });

      it('OR → SDK → OR returns original for Claude models', () => {
        const claudeModels = OR_MODEL_CATALOG.filter(e => e.sdkModel);

        for (const entry of claudeModels) {
          const sdkId = remapModelOnProviderSwitch(entry.id, false);
          const backToOr = remapModelOnProviderSwitch(sdkId, true);
          expect(backToOr).toBe(entry.id);
        }
      });
    });
  });

  describe('resolveOrModelToSdkId', () => {
    it('resolves explicit catalog mappings', () => {
      expect(resolveOrModelToSdkId('anthropic/claude-opus-4-7')).toBe('claude-opus-4-7');
      expect(resolveOrModelToSdkId('anthropic/claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    });

    it('resolves legacy dotted Claude IDs through the OpenRouter remap', () => {
      expect(resolveOrModelToSdkId('anthropic/claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
    });

    it('resolves the OR-canonical Fable slug through the legacyIds remap', () => {
      // OR's internal canonical slug for Fable 5 has no dotted version, so the
      // step-3 `claude-{X.Y}-{tier}` pattern fallback can't parse it; without
      // the legacyIds entry it would mis-resolve to 'claude-5-fable' and miss
      // pricing entirely (PLAN.md 260611_fable-5-support, Runtime Safety F4).
      expect(resolveOrModelToSdkId('anthropic/claude-5-fable-20260609')).toBe('claude-fable-5');
      expect(resolveOrModelToSdkId('anthropic/claude-fable-5')).toBe('claude-fable-5');
    });

    it('resolves updated DeepSeek pricing mappings', () => {
      expect(resolveOrModelToSdkId('deepseek/deepseek-v3.2')).toBe('deepseek-chat');
      expect(resolveOrModelToSdkId('deepseek/deepseek-r1-0528')).toBe('deepseek-r1');
    });

    it('strips provider prefix for unmapped models', () => {
      expect(resolveOrModelToSdkId('openai/gpt-5.5')).toBe('gpt-5.5');
    });

    it('returns null for non-OR format IDs (no slash)', () => {
      expect(resolveOrModelToSdkId('claude-sonnet-4-6')).toBeNull();
    });

    describe('dated snapshot resolution', () => {
      it('resolves anthropic/claude-4.7-opus-20260416 to claude-opus-4-7', () => {
        expect(resolveOrModelToSdkId('anthropic/claude-4.7-opus-20260416')).toBe('claude-opus-4-7');
      });

      it('resolves anthropic/claude-4.6-opus-20260205 to claude-opus-4-6', () => {
        expect(resolveOrModelToSdkId('anthropic/claude-4.6-opus-20260205')).toBe('claude-opus-4-6');
      });

      it('resolves anthropic/claude-4.6-sonnet-20260217 to claude-sonnet-4-6', () => {
        expect(resolveOrModelToSdkId('anthropic/claude-4.6-sonnet-20260217')).toBe('claude-sonnet-4-6');
      });

      it('still resolves non-dated models: anthropic/claude-opus-4-7 to claude-opus-4-7', () => {
        expect(resolveOrModelToSdkId('anthropic/claude-opus-4-7')).toBe('claude-opus-4-7');
      });

      it('resolves non-Anthropic dated model: openai/gpt-5.5-20260301 to gpt-5.5', () => {
        expect(resolveOrModelToSdkId('openai/gpt-5.5-20260301')).toBe('gpt-5.5');
      });

      it('resolves dated catalog mapping: anthropic/claude-haiku-4-5-20260101 to claude-haiku-4-5', () => {
        // Date-stripped version matches OR_TO_SDK_MAP directly
        expect(resolveOrModelToSdkId('anthropic/claude-haiku-4-5-20260101')).toBe('claude-haiku-4-5');
      });

      it('resolves google dated snapshot via prefix+date stripping', () => {
        expect(resolveOrModelToSdkId('google/gemini-2.5-pro-20260301')).toBe('gemini-2.5-pro');
      });
    });
  });

  describe('normalizeOrModelId', () => {
    it('remaps all legacy IDs to current IDs', () => {
      const legacyToCurrent = new Map<string, string>([
        ['anthropic/claude-opus-4.7', 'anthropic/claude-opus-4-7'],
        ['anthropic/claude-opus-4.6', 'anthropic/claude-opus-4-6'],
        ['anthropic/claude-sonnet-4.6', 'anthropic/claude-sonnet-4-6'],
        ['anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-4-5'],
        ['deepseek/deepseek-chat-v3-0324', 'deepseek/deepseek-v3.2'],
        ['deepseek/deepseek-r1', 'deepseek/deepseek-r1-0528'],
        ['x-ai/grok-3', 'x-ai/grok-4.20'],
        ['x-ai/grok-3-mini', 'x-ai/grok-4.1-fast'],
        ['minimax/minimax-m2.5', 'minimax/minimax-m2.7'],
      ]);

      for (const [legacyId, currentId] of legacyToCurrent) {
        expect(normalizeOrModelId(legacyId)).toBe(currentId);
      }
    });

    it('returns the input when no remap exists', () => {
      expect(normalizeOrModelId('anthropic/claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
    });
  });
});
