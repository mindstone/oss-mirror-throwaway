/**
 * Model Resolution Tests
 *
 * Validates that Rebel Core correctly resolves ALL model patterns
 * that the production code produces before sending to the Anthropic API.
 *
 * These patterns come from modelNormalization.ts / agentTurnExecutor.ts:
 * - 'planner' (alias for thinking+working split)
 * - 'claude-sonnet-4-6[1m]' (extended context suffix)
 * - 'planner' with env overrides containing [1m]
 * - Direct model names ('claude-sonnet-4-6', 'claude-opus-4-7', etc.)
 * - Council/ad-hoc model names via proxy
 *
 * If this test fails, it means a model pattern exists in production
 * that Rebel Core would send to the API and get a 404.
 */
import { describe, it, expect } from 'vitest';
import { resolveRuntimeModels } from '../planningMode';
import type { AppSettings } from '@shared/types';

const TEST_SETTINGS: AppSettings = {
  coreDirectory: null,
  mcpConfigFile: null,
  onboardingCompleted: true,
  userEmail: null,
  onboardingFirstCompletedAt: null,
  voice: { enabled: false },
  models: {
    apiKey: 'fake-ant-test',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-20250514',
    thinkingModel: 'claude-opus-4-7',
    thinkingProfileId: null,
    workingProfileId: null,
    permissionMode: 'plan',
    executablePath: null,
    planMode: true,
    extendedContext: false,
  },
  localModel: { activeProfileId: null, profiles: [] },
  diagnostics: { enabled: false },
} as unknown as AppSettings;

function resolveModel(model: string, env?: Record<string, string>): string {
  const resolved = resolveRuntimeModels({ model, env, settings: TEST_SETTINGS } as any);
  return resolved.planningModel ?? resolved.executionModel;
}

// These are the REAL model IDs that the Anthropic API accepts
const VALID_API_MODELS = [
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-opus-4-7',
  'claude-opus-4-5',
  'claude-haiku-4-5',
  // Dated snapshots also work
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
];

describe('Model Resolution for Rebel Core', () => {
  describe('planner alias', () => {
    it('resolves planner alias with PLANNING_MODEL env', () => {
      const result = resolveModel('planner', {
        PLANNING_MODEL: 'claude-opus-4-7',
      });
      expect(result).toBe('claude-opus-4-7');
      expect(VALID_API_MODELS).toContain(result);
    });

    it('resolves planner alias with [1m] suffix in env', () => {
      const result = resolveModel('planner', {
        PLANNING_MODEL: 'claude-opus-4-7[1m]',
      });
      expect(result).toBe('claude-opus-4-7');
      expect(VALID_API_MODELS).toContain(result);
    });

    it('resolves planner alias with fallback Opus model in env', () => {
      const result = resolveModel('planner', {
        PLANNING_MODEL: 'claude-opus-4-5',
      });
      expect(result).toBe('claude-opus-4-5');
      expect(VALID_API_MODELS).toContain(result);
    });

    it('resolves planner alias with no env (settings-backed fallback)', () => {
      const result = resolveModel('planner', {});
      expect(result).toBe('claude-opus-4-7');
      expect(VALID_API_MODELS).toContain(result);
    });

    it('resolves planner alias with undefined env', () => {
      const result = resolveModel('planner', undefined);
      expect(result).toBe('claude-opus-4-7');
    });
  });

  describe('[1m] extended context suffix', () => {
    it('strips [1m] from claude-sonnet-4-6[1m]', () => {
      const result = resolveModel('claude-sonnet-4-6[1m]');
      expect(result).toBe('claude-sonnet-4-6');
      expect(VALID_API_MODELS).toContain(result);
    });

    it('strips [1m] from claude-opus-4-7[1m]', () => {
      const result = resolveModel('claude-opus-4-7[1m]');
      expect(result).toBe('claude-opus-4-7');
      expect(VALID_API_MODELS).toContain(result);
    });

    it('strips [1M] case-insensitively', () => {
      const result = resolveModel('claude-sonnet-4-6[1M]');
      expect(result).toBe('claude-sonnet-4-6');
    });
  });

  describe('direct model names (passthrough)', () => {
    for (const model of VALID_API_MODELS) {
      it(`passes through ${model} unchanged`, () => {
        expect(resolveModel(model)).toBe(model);
      });
    }
  });

  describe('all resolveModelConfig() output patterns', () => {
    // These are the EXACT patterns resolveModelConfig() produces
    // (from src/shared/utils/modelNormalization.ts)

    it('single model, no extended context', () => {
      // resolveModelConfig('claude-sonnet-4-6', null, false) → { model: 'claude-sonnet-4-6' }
      expect(resolveModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    });

    it('single model, extended context', () => {
      // resolveModelConfig('claude-sonnet-4-6', null, true) → { model: 'claude-sonnet-4-6[1m]' }
      expect(resolveModel('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6');
    });

    it('plan mode, no extended context', () => {
      // resolveModelConfig('claude-sonnet-4-6', 'claude-opus-4-7', false)
      // → { model: 'planner', envOverrides: { PLANNING_MODEL: 'claude-opus-4-7', EXECUTION_MODEL: 'claude-sonnet-4-6' } }
      expect(resolveModel('planner', {
        PLANNING_MODEL: 'claude-opus-4-7',
        EXECUTION_MODEL: 'claude-sonnet-4-6',
      })).toBe('claude-opus-4-7');
    });

    it('plan mode, extended context', () => {
      // resolveModelConfig('claude-sonnet-4-6', 'claude-opus-4-7', true)
      // → { model: 'planner', envOverrides: { PLANNING_MODEL: 'claude-opus-4-7[1m]', EXECUTION_MODEL: 'claude-sonnet-4-6[1m]' } }
      expect(resolveModel('planner', {
        PLANNING_MODEL: 'claude-opus-4-7[1m]',
        EXECUTION_MODEL: 'claude-sonnet-4-6[1m]',
      })).toBe('claude-opus-4-7');
    });

    it('plan mode, after stripExtendedContextFromConfig', () => {
      // stripExtendedContextFromConfig strips [1m] from env but keeps 'planner'
      expect(resolveModel('planner', {
        PLANNING_MODEL: 'claude-opus-4-7',
        EXECUTION_MODEL: 'claude-sonnet-4-6',
      })).toBe('claude-opus-4-7');
    });

    it('plan mode with fallback opus', () => {
      // downgradeThinkingModelConfig may switch to claude-opus-4-5
      expect(resolveModel('planner', {
        PLANNING_MODEL: 'claude-opus-4-5',
        EXECUTION_MODEL: 'claude-sonnet-4-6',
      })).toBe('claude-opus-4-5');
    });
  });

  describe('edge cases', () => {
    it('handles empty string model', () => {
      // Should not crash
      const result = resolveModel('');
      expect(typeof result).toBe('string');
    });

    it('handles model with extra whitespace', () => {
      // Shouldn't happen in practice but shouldn't crash
      const result = resolveModel('claude-sonnet-4-6 ');
      expect(result).toBe('claude-sonnet-4-6 '); // passthrough, normalization happens elsewhere
    });
  });
});
