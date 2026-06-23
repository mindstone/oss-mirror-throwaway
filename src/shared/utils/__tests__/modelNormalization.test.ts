import { describe, it, expect, vi } from 'vitest';
import {
  stripExtendedContextFromConfig,
  stripExtendedContextHeader,
  isExtendedContextUnavailableError,
  isThinkingModelUnavailableError,
  downgradeThinkingModelConfig,
  resolveModelConfig,
  resolvePlanningThinkingModel,
  resolvePlanModeTarget,
  planModeTargetFromThinkingModel,
  applyExtendedContextSuffix,
  modelSupportsExtendedContext,
  getModelDisplayName,
  getThinkingModelDowngradeTarget,
  PREFERRED_PLANNING_MODEL,
  FALLBACK_PLANNING_MODEL,
} from '../modelNormalization';

describe('modelNormalization', () => {
  describe('stripExtendedContextFromConfig', () => {
    it('should remove [1m] suffix from model name', () => {
      const config = { model: 'claude-sonnet-4-6[1m]' };
      const result = stripExtendedContextFromConfig(config);
      expect(result.model).toBe('claude-sonnet-4-6');
    });

    it('should not modify model without [1m] suffix', () => {
      const config = { model: 'claude-sonnet-4-6' };
      const result = stripExtendedContextFromConfig(config);
      expect(result.model).toBe('claude-sonnet-4-6');
    });

    it('should remove [1m] from EXECUTION_MODEL env override', () => {
      const config = {
        model: 'planner',
        envOverrides: {
          EXECUTION_MODEL: 'claude-sonnet-4-6[1m]'
        }
      };
      const result = stripExtendedContextFromConfig(config);
      expect(result.model).toBe('planner');
      expect(result.envOverrides?.EXECUTION_MODEL).toBe('claude-sonnet-4-6');
    });

    it('should remove [1m] from PLANNING_MODEL env override', () => {
      const config = {
        model: 'planner',
        envOverrides: {
          PLANNING_MODEL: 'claude-opus-4-7[1m]',
          EXECUTION_MODEL: 'claude-sonnet-4-6[1m]'
        }
      };
      const result = stripExtendedContextFromConfig(config);
      expect(result.model).toBe('planner');
      expect(result.envOverrides?.PLANNING_MODEL).toBe('claude-opus-4-7');
      expect(result.envOverrides?.EXECUTION_MODEL).toBe('claude-sonnet-4-6');
    });

    it('should not modify PLANNING_MODEL without [1m] suffix', () => {
      const config = {
        model: 'planner',
        envOverrides: {
          PLANNING_MODEL: 'claude-opus-4-7'
        }
      };
      const result = stripExtendedContextFromConfig(config);
      expect(result.envOverrides?.PLANNING_MODEL).toBe('claude-opus-4-7');
    });

    it('should handle config without envOverrides', () => {
      const config = { model: 'claude-sonnet-4-6[1m]' };
      const result = stripExtendedContextFromConfig(config);
      expect(result.envOverrides).toBeUndefined();
    });
  });

  describe('stripExtendedContextHeader', () => {
    it('should remove context-1m header from single header string', () => {
      const headers = 'anthropic-beta: context-1m-2025-08-07';
      const result = stripExtendedContextHeader(headers);
      expect(result).toBeUndefined();
    });

    it('should remove context-1m header from newline-separated list', () => {
      const headers = 'anthropic-beta: other-feature\nanthropic-beta: context-1m-2025-08-07';
      const result = stripExtendedContextHeader(headers);
      expect(result).toBe('anthropic-beta: other-feature');
    });

    it('should preserve other headers when removing context-1m', () => {
      const headers = 'anthropic-beta: structured-outputs-2025-11-13\nanthropic-beta: context-1m-2025-08-07';
      const result = stripExtendedContextHeader(headers);
      expect(result).toBe('anthropic-beta: structured-outputs-2025-11-13');
    });

    it('should preserve x-proxy-auth when removing context-1m from multiple headers', () => {
      const headers = [
        'anthropic-beta: structured-outputs-2025-11-13',
        'anthropic-beta: context-1m-2025-08-07',
        'x-proxy-auth: test-token',
      ].join('\n');

      const result = stripExtendedContextHeader(headers);
      expect(result).toBe('anthropic-beta: structured-outputs-2025-11-13\nx-proxy-auth: test-token');
    });

    it('should handle CRLF line endings and normalize output to \\n', () => {
      const headers =
        '  anthropic-beta: structured-outputs-2025-11-13  \r\n' +
        '\r\n' +
        'anthropic-beta: context-1m-2025-08-07\r\n' +
        '  x-proxy-auth: test-token  \r\n';

      const result = stripExtendedContextHeader(headers);
      expect(result).toBe('anthropic-beta: structured-outputs-2025-11-13\nx-proxy-auth: test-token');
      expect(result).not.toContain('\r');
    });

    it('should return undefined for undefined input', () => {
      const result = stripExtendedContextHeader(undefined);
      expect(result).toBeUndefined();
    });
  });

  describe('isExtendedContextUnavailableError', () => {
    it('should detect long context beta error in API error format', () => {
      const error = new Error('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"The long context beta is not yet available for this subscription."}}');
      expect(isExtendedContextUnavailableError(error)).toBe(true);
    });

    it('should detect error with invalid_request_error type', () => {
      const error = new Error('invalid_request_error: The long context beta is not yet available');
      expect(isExtendedContextUnavailableError(error)).toBe(true);
    });

    it('should be case insensitive for API error prefix', () => {
      const error = new Error('api error: 400 - The LONG CONTEXT BETA is not available');
      expect(isExtendedContextUnavailableError(error)).toBe(true);
    });

    it('should return false for other errors', () => {
      const error = new Error('Rate limit exceeded');
      expect(isExtendedContextUnavailableError(error)).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isExtendedContextUnavailableError(null)).toBe(false);
      expect(isExtendedContextUnavailableError(undefined)).toBe(false);
    });

    it('should handle error-like objects with API error format', () => {
      const error = { message: 'API Error: The long context beta is not yet available for this subscription.' };
      expect(isExtendedContextUnavailableError(error)).toBe(true);
    });

    it('should return false for conversational mentions of long context beta', () => {
      // User asking about the error should NOT trigger retry
      const error = new Error('What does "long context beta" mean in Claude?');
      expect(isExtendedContextUnavailableError(error)).toBe(false);
    });

    it('should return false for Claude explaining the error', () => {
      // Claude explaining the error in conversation should NOT trigger retry
      const error = new Error('The "long context beta" feature allows for 1M tokens but requires special access.');
      expect(isExtendedContextUnavailableError(error)).toBe(false);
    });
  });

  describe('resolveModelConfig', () => {
    it('should add [1m] suffix when extendedContext is true for Sonnet (single model)', () => {
      const result = resolveModelConfig('claude-sonnet-4-6', null, true);
      expect(result.model).toBe('claude-sonnet-4-6[1m]');
    });

    it('should not add [1m] suffix when extendedContext is false', () => {
      const result = resolveModelConfig('claude-sonnet-4-6', null, false);
      expect(result.model).toBe('claude-sonnet-4-6');
    });

    it('should use planner alias with thinkingModel[1m] env override when a plan-mode target is provided and extendedContext true', () => {
      const result = resolveModelConfig(
        'claude-sonnet-4-6',
        planModeTargetFromThinkingModel(PREFERRED_PLANNING_MODEL, 'claude-sonnet-4-6'),
        true,
      );
      expect(result.model).toBe('planner');
      expect(result.envOverrides?.PLANNING_MODEL).toBe(`${PREFERRED_PLANNING_MODEL}[1m]`);
      expect(result.envOverrides?.EXECUTION_MODEL).toBe('claude-sonnet-4-6[1m]');
    });

    it('should use planner alias with thinkingModel (no [1m]) when a plan-mode target is provided but extendedContext false', () => {
      const result = resolveModelConfig(
        'claude-sonnet-4-6',
        planModeTargetFromThinkingModel(PREFERRED_PLANNING_MODEL, 'claude-sonnet-4-6'),
        false,
      );
      expect(result.model).toBe('planner');
      expect(result.envOverrides?.PLANNING_MODEL).toBe(PREFERRED_PLANNING_MODEL);
      expect(result.envOverrides?.EXECUTION_MODEL).toBe('claude-sonnet-4-6');
    });

    it('should use single model mode when the thinking model is same as workingModel (target collapses to null)', () => {
      const target = planModeTargetFromThinkingModel('claude-sonnet-4-6', 'claude-sonnet-4-6');
      expect(target).toBeNull();
      const result = resolveModelConfig('claude-sonnet-4-6', target, true);
      expect(result.model).toBe('claude-sonnet-4-6[1m]');
      expect(result.envOverrides).toBeUndefined();
    });

    it('should use single model mode when the plan-mode target is null', () => {
      const result = resolveModelConfig('claude-sonnet-4-6', null, false);
      expect(result.model).toBe('claude-sonnet-4-6');
      expect(result.envOverrides).toBeUndefined();
    });
  });

  describe('resolvePlanningThinkingModel (REBEL-655)', () => {
    it('returns the thinking profile model (NOT a Claude sentinel) when a profile is configured', () => {
      const result = resolvePlanningThinkingModel({
        thinkingModelOverride: undefined,
        thinkingProfileModel: 'gpt-5.5',
        settingsThinkingModel: undefined,
      });
      expect(result).toBe('gpt-5.5');
      // Regression guard: must never substitute the synthetic Claude sentinel.
      expect(result).not.toBe(PREFERRED_PLANNING_MODEL);
    });

    it('falls back to settings.thinkingModel when no profile is configured', () => {
      const result = resolvePlanningThinkingModel({
        thinkingModelOverride: undefined,
        thinkingProfileModel: null,
        settingsThinkingModel: 'claude-opus-4-8',
      });
      expect(result).toBe('claude-opus-4-8');
    });

    it('returns null when nothing is configured (single-model mode)', () => {
      const result = resolvePlanningThinkingModel({
        thinkingModelOverride: undefined,
        thinkingProfileModel: null,
        settingsThinkingModel: undefined,
      });
      expect(result).toBeNull();
    });

    it('honours an explicit override, including empty-string suppression', () => {
      expect(
        resolvePlanningThinkingModel({
          thinkingModelOverride: 'o4-mini',
          thinkingProfileModel: 'gpt-5.5',
          settingsThinkingModel: 'claude-opus-4-8',
        }),
      ).toBe('o4-mini');
      expect(
        resolvePlanningThinkingModel({
          thinkingModelOverride: '',
          thinkingProfileModel: 'gpt-5.5',
          settingsThinkingModel: 'claude-opus-4-8',
        }),
      ).toBeNull();
    });
  });

  describe('REBEL-655: plan-mode resolution at the true seam (resolvePlanningThinkingModel → resolveModelConfig)', () => {
    // The incident user had workingProfile == thinkingProfile == codex-gpt-5.5 and
    // no Anthropic key. Before the fix, agentTurnExecute substituted
    // PREFERRED_PLANNING_MODEL (claude-opus-4-8) as the planning model whenever ANY
    // thinking profile existed — so resolveModelConfig entered plan mode with
    // PLANNING_MODEL=claude-opus-4-8 (a model the Codex user can't route → auth toast).
    //
    // With the real thinking model fed in, thinking == working → single-model mode.
    it('Codex working profile == thinking profile (gpt-5.5) → single-model mode, NO claude sentinel leak', () => {
      const workingModel = 'gpt-5.5';
      const target = resolvePlanModeTarget({
        workingModel,
        thinkingModelOverride: undefined,
        thinkingProfileModel: 'gpt-5.5', // same Codex profile as working
        settingsThinkingModel: undefined,
      });
      // The typed target collapses to null when thinking == working.
      expect(target).toBeNull();
      const config = resolveModelConfig(workingModel, target, false);
      // No plan mode: model is the working model, no PLANNING_MODEL override.
      expect(config.model).toBe('gpt-5.5');
      expect(config.envOverrides).toBeUndefined();
      // The leak (PLANNING_MODEL=claude-opus-4-8) must NOT appear.
      expect(config.envOverrides?.PLANNING_MODEL).toBeUndefined();
    });

    it('distinct Codex thinking model → plan mode names the REAL proxy-backed model, not a sentinel', () => {
      const workingModel = 'gpt-5.5';
      const target = resolvePlanModeTarget({
        workingModel,
        thinkingModelOverride: undefined,
        thinkingProfileModel: 'o4-mini', // a distinct supported Codex thinking model
        settingsThinkingModel: undefined,
      });
      expect(target?.thinkingModel).toBe('o4-mini');
      const config = resolveModelConfig(workingModel, target, false);
      expect(config.model).toBe('planner');
      // PLANNING_MODEL must be the real model so rebelCoreQuery routes it via the same proxy.
      expect(config.envOverrides?.PLANNING_MODEL).toBe('o4-mini');
      expect(config.envOverrides?.PLANNING_MODEL).not.toBe(PREFERRED_PLANNING_MODEL);
      expect(config.envOverrides?.EXECUTION_MODEL).toBe('gpt-5.5');
    });

    it('Anthropic user with a real Claude thinking model is unchanged (plan mode preserved)', () => {
      const workingModel = 'claude-sonnet-4-6';
      const target = resolvePlanModeTarget({
        workingModel,
        thinkingModelOverride: undefined,
        thinkingProfileModel: 'claude-opus-4-8',
        settingsThinkingModel: undefined,
      });
      const config = resolveModelConfig(workingModel, target, false);
      expect(config.model).toBe('planner');
      expect(config.envOverrides?.PLANNING_MODEL).toBe('claude-opus-4-8');
      expect(config.envOverrides?.EXECUTION_MODEL).toBe('claude-sonnet-4-6');
    });
  });

  // The Stage-1 KILL ASSERTION (PLAN.md Stage 1 Verification): there is no value
  // of the public plan-mode API that produces a plan-mode config naming a model
  // the active provider can't serve via a raw-string masquerade. Plan mode is now
  // ONLY requestable via a typed PlanModeTarget carrying a branded RoutingModelId.
  describe('Stage 1 kill assertion — typed plan-mode target is the only plan-mode trigger', () => {
    it('a non-null target is the ONLY way resolveModelConfig emits the planner alias', () => {
      // No target → never plan mode, regardless of working model.
      expect(resolveModelConfig('gpt-5.5', null, false).model).toBe('gpt-5.5');
      expect(resolveModelConfig('claude-sonnet-4-6', null, true).model).toBe('claude-sonnet-4-6[1m]');
    });

    it('the synthetic PREFERRED_PLANNING_MODEL can only enter as an explicitly-decoded RoutingModelId', () => {
      // The accessor brands the value; it is the same byte-for-byte model id, but
      // it can only arrive via the typed gate (decode), never as a raw positional
      // string masquerading as a "thinking model".
      const target = planModeTargetFromThinkingModel(PREFERRED_PLANNING_MODEL, 'claude-sonnet-4-6');
      expect(target?.thinkingModel).toBe(PREFERRED_PLANNING_MODEL);
      // When working == the sentinel, the target collapses to null (no plan mode).
      expect(planModeTargetFromThinkingModel(PREFERRED_PLANNING_MODEL, PREFERRED_PLANNING_MODEL)).toBeNull();
    });

    it('empty / whitespace-only thinking models never produce a plan-mode target', () => {
      expect(planModeTargetFromThinkingModel('', 'claude-sonnet-4-6')).toBeNull();
      expect(planModeTargetFromThinkingModel('   ', 'claude-sonnet-4-6')).toBeNull();
      expect(planModeTargetFromThinkingModel(null, 'claude-sonnet-4-6')).toBeNull();
      expect(planModeTargetFromThinkingModel(undefined, 'claude-sonnet-4-6')).toBeNull();
    });
  });

  describe('getModelDisplayName', () => {
    it('should return display labels for known model IDs', () => {
      expect(getModelDisplayName('claude-haiku-4-5')).toBe('Haiku 4.5');
      expect(getModelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    });

    it('should fall back to raw model ID for unknown models', () => {
      expect(getModelDisplayName('claude-not-a-real-model')).toBe('claude-not-a-real-model');
    });

    it('should resolve catalog labels for OpenRouter/auxiliary models not in MODEL_OPTIONS', () => {
      // MODEL_OPTIONS only covers Anthropic main models; these resolve via the catalog entry's
      // openRouter.label so the Turn Usage tooltip shows friendly names, not raw provider/model ids.
      expect(getModelDisplayName('deepseek/deepseek-v4-pro')).toBe('DeepSeek V4 Pro');
      expect(getModelDisplayName('deepseek/deepseek-v4-flash')).toBe('DeepSeek V4 Flash');
    });

    it('should strip [1m] extended context suffix before lookup', () => {
      expect(getModelDisplayName('claude-sonnet-4-6[1m]')).toBe('Sonnet 4.6');
      expect(getModelDisplayName('claude-opus-4-7[1m]')).toBe('Opus 4.7');
    });
  });

  describe('isThinkingModelUnavailableError', () => {
    it('should detect 403 permission error for model access', () => {
      const error = new Error("API Error: 403 You don't have access to the model with the specified model ID.");
      expect(isThinkingModelUnavailableError(error)).toBe(true);
    });

    it('should detect permission_error type', () => {
      const error = new Error('permission_error: You do not have access to the model');
      expect(isThinkingModelUnavailableError(error)).toBe(true);
    });

    it('should detect 404 does not exist model error message', () => {
      const error = new Error('API Error: 404 The model `claude-opus-4-7` does not exist or you do not have access to it.');
      expect(isThinkingModelUnavailableError(error)).toBe(true);
    });

    it('should detect structured error with status 404 and does not exist message', () => {
      const error = {
        status: 404,
        message: 'The model `claude-opus-4-7` does not exist or you do not have access to it.',
      };
      expect(isThinkingModelUnavailableError(error)).toBe(true);
    });

    it('should detect 404 model not found errors', () => {
      const error = new Error('API Error: 404 model not found');
      expect(isThinkingModelUnavailableError(error)).toBe(true);
    });

    it('should detect 403 errors with access to it phrasing', () => {
      const error = new Error('API Error: 403 The model exists, but you do not have access to it.');
      expect(isThinkingModelUnavailableError(error)).toBe(true);
    });

    it('should return false for generic 404 page not found errors', () => {
      const error = new Error('API Error: 404 page not found');
      expect(isThinkingModelUnavailableError(error)).toBe(false);
    });

    it('should return false for generic resource not found errors without model context', () => {
      const error = new Error('resource not found');
      expect(isThinkingModelUnavailableError(error)).toBe(false);
    });

    it('should return false for non-model 404 does not exist errors', () => {
      const error = new Error('API Error: 404 workspace does not exist');
      expect(isThinkingModelUnavailableError(error)).toBe(false);
    });

    it('should return false for structured 404 without model context', () => {
      expect(isThinkingModelUnavailableError({ status: 404, message: 'Not Found' })).toBe(false);
    });

    it('should detect model unavailable when passed a raw string (runtime text path)', () => {
      expect(isThinkingModelUnavailableError(
        'API Error: 404 The model `claude-opus-4-7` does not exist or you do not have access to it.'
      )).toBe(true);
    });

    it('should return false for other errors', () => {
      const error = new Error('Rate limit exceeded');
      expect(isThinkingModelUnavailableError(error)).toBe(false);
    });

    // Stage 7 of docs/plans/260611_fable-5-support/PLAN.md: the defensive
    // console.warn must stay quiet for known thinking-tier models (Fable 5,
    // Opus 4.6-4.8) and keep firing for unrecognized ones.
    it('should not warn for Fable 5 permission errors (known thinking model)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const error = new Error(
          "API Error: 403 permission_error: You don't have access to the model claude-fable-5."
        );
        expect(isThinkingModelUnavailableError(error)).toBe(true);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should not warn for Opus permission errors (known thinking model)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const error = new Error(
          "API Error: 403 permission_error: You don't have access to the model claude-opus-4-8."
        );
        expect(isThinkingModelUnavailableError(error)).toBe(true);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should still warn (but return true) for permission errors on unrecognized models', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const error = new Error(
          "API Error: 403 permission_error: You don't have access to the model mystery-model-9."
        );
        expect(isThinkingModelUnavailableError(error)).toBe(true);
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should return false for null/undefined', () => {
      expect(isThinkingModelUnavailableError(null)).toBe(false);
      expect(isThinkingModelUnavailableError(undefined)).toBe(false);
    });

    it('should handle nested error.error.message format', () => {
      const error = { 
        error: { 
          message: "403: You don't have access to the model" 
        } 
      };
      expect(isThinkingModelUnavailableError(error)).toBe(true);
    });
  });

  describe('downgradeThinkingModelConfig', () => {
    it('should downgrade from Opus 4.7 to fallback', () => {
      const config = {
        model: 'planner',
        envOverrides: {
          PLANNING_MODEL: PREFERRED_PLANNING_MODEL
        }
      };
      const result = downgradeThinkingModelConfig(config);
      expect(result.envOverrides?.PLANNING_MODEL).toBe(FALLBACK_PLANNING_MODEL);
    });

    it('should downgrade from Opus 4.7[1m] to fallback (preserves 1m since fallback supports it)', () => {
      const config = {
        model: 'planner',
        envOverrides: {
          PLANNING_MODEL: `${PREFERRED_PLANNING_MODEL}[1m]`
        }
      };
      const result = downgradeThinkingModelConfig(config);
      expect(result.envOverrides?.PLANNING_MODEL).toBe(`${FALLBACK_PLANNING_MODEL}[1m]`);
    });

    it('should be idempotent - return unchanged if already on fallback', () => {
      const config = {
        model: 'planner',
        envOverrides: {
          PLANNING_MODEL: FALLBACK_PLANNING_MODEL
        }
      };
      const result = downgradeThinkingModelConfig(config);
      expect(result).toBe(config); // Same reference - no change
    });

    it('should return unchanged config if no thinking model override', () => {
      const config = { model: 'claude-sonnet-4-6' };
      const result = downgradeThinkingModelConfig(config);
      expect(result).toBe(config);
    });

    it('should downgrade direct-mode Opus 4.7 to fallback', () => {
      const config = { model: PREFERRED_PLANNING_MODEL };
      const result = downgradeThinkingModelConfig(config);
      expect(result.model).toBe(FALLBACK_PLANNING_MODEL);
    });

    it('should downgrade direct-mode Opus 4.7[1m] to fallback (preserves 1m)', () => {
      const config = { model: `${PREFERRED_PLANNING_MODEL}[1m]` };
      const result = downgradeThinkingModelConfig(config);
      expect(result.model).toBe(`${FALLBACK_PLANNING_MODEL}[1m]`);
    });

    it('should be idempotent in direct mode - return unchanged if already on fallback', () => {
      const config = { model: FALLBACK_PLANNING_MODEL };
      const result = downgradeThinkingModelConfig(config);
      expect(result).toBe(config);
    });

    // Fable 5 Stage 6 piece 4: models above the default thinking tier step
    // down to the default thinking model (Opus 4.8) instead of soft-failing
    // with no downgrade path.
    describe('Fable 5 downgrade ladder (Stage 6)', () => {
      it('downgrades plan-mode Fable 5 to the preferred planning model', () => {
        const config = {
          model: 'planner',
          envOverrides: {
            PLANNING_MODEL: 'claude-fable-5'
          }
        };
        const result = downgradeThinkingModelConfig(config);
        expect(result.envOverrides?.PLANNING_MODEL).toBe(PREFERRED_PLANNING_MODEL);
      });

      it('downgrades plan-mode Fable 5[1m] to preferred planning model preserving [1m]', () => {
        const config = {
          model: 'planner',
          envOverrides: {
            PLANNING_MODEL: 'claude-fable-5[1m]'
          }
        };
        const result = downgradeThinkingModelConfig(config);
        expect(result.envOverrides?.PLANNING_MODEL).toBe(`${PREFERRED_PLANNING_MODEL}[1m]`);
      });

      it('downgrades direct-mode Fable 5 to the preferred planning model', () => {
        const config = { model: 'claude-fable-5' };
        const result = downgradeThinkingModelConfig(config);
        expect(result.model).toBe(PREFERRED_PLANNING_MODEL);
      });

      it('keeps the existing Opus chain: preferred still downgrades to fallback (behavior preservation)', () => {
        const planMode = downgradeThinkingModelConfig({
          model: 'planner',
          envOverrides: { PLANNING_MODEL: PREFERRED_PLANNING_MODEL }
        });
        expect(planMode.envOverrides?.PLANNING_MODEL).toBe(FALLBACK_PLANNING_MODEL);

        const directMode = downgradeThinkingModelConfig({ model: PREFERRED_PLANNING_MODEL });
        expect(directMode.model).toBe(FALLBACK_PLANNING_MODEL);
      });

      it('returns unchanged config for models with no downgrade path', () => {
        const config = {
          model: 'planner',
          envOverrides: { PLANNING_MODEL: 'gpt-5.5' }
        };
        expect(downgradeThinkingModelConfig(config)).toBe(config);
      });

      it('getThinkingModelDowngradeTarget exposes the ladder (and undefined off-ladder)', () => {
        expect(getThinkingModelDowngradeTarget('claude-fable-5')).toBe(PREFERRED_PLANNING_MODEL);
        expect(getThinkingModelDowngradeTarget('claude-fable-5[1m]')).toBe(PREFERRED_PLANNING_MODEL);
        expect(getThinkingModelDowngradeTarget(PREFERRED_PLANNING_MODEL)).toBe(FALLBACK_PLANNING_MODEL);
        expect(getThinkingModelDowngradeTarget(FALLBACK_PLANNING_MODEL)).toBeUndefined();
        expect(getThinkingModelDowngradeTarget('gpt-5.5')).toBeUndefined();
      });
    });
  });

  describe('modelSupportsExtendedContext', () => {
    it('should return true for Sonnet 4.6', () => {
      expect(modelSupportsExtendedContext('claude-sonnet-4-6')).toBe(true);
    });

    it('should return true for Opus 4.7', () => {
      expect(modelSupportsExtendedContext('claude-opus-4-7')).toBe(true);
    });

    it('should return true for models with [1m] suffix', () => {
      expect(modelSupportsExtendedContext('claude-sonnet-4-6[1m]')).toBe(true);
      expect(modelSupportsExtendedContext('claude-opus-4-7[1m]')).toBe(true);
    });

    it('should return false for Opus 4.5', () => {
      expect(modelSupportsExtendedContext('claude-opus-4-5')).toBe(false);
    });

    it('should return false for Haiku', () => {
      expect(modelSupportsExtendedContext('claude-haiku-4-5')).toBe(false);
    });

    it('should return false for empty/unknown models', () => {
      expect(modelSupportsExtendedContext('')).toBe(false);
      expect(modelSupportsExtendedContext('some-unknown-model')).toBe(false);
    });

    it('should not false-positive on substring model names', () => {
      expect(modelSupportsExtendedContext('claude-sonnet-4-60')).toBe(false);
      expect(modelSupportsExtendedContext('claude-opus-4-60')).toBe(false);
    });

    it('recognizes OpenRouter-routed Anthropic ids — dashed AND dotted (OR canonical) spellings', () => {
      // dashed (our catalog) + dotted (OpenRouter canonical, e.g. anthropic/claude-opus-4.8) +
      // dotted with [1m] all resolve to the underlying extended-context model.
      expect(modelSupportsExtendedContext('anthropic/claude-opus-4-8')).toBe(true);
      expect(modelSupportsExtendedContext('anthropic/claude-opus-4.8')).toBe(true);
      expect(modelSupportsExtendedContext('anthropic/claude-sonnet-4.6')).toBe(true);
      expect(modelSupportsExtendedContext('anthropic/claude-opus-4.8[1m]')).toBe(true);
    });

    it('does not false-positive on non-Anthropic OpenRouter ids via prefix/dot normalization', () => {
      expect(modelSupportsExtendedContext('openai/gpt-5.5')).toBe(false);
      expect(modelSupportsExtendedContext('deepseek/deepseek-v4-flash')).toBe(false);
      expect(modelSupportsExtendedContext('anthropic/claude-opus-4.5')).toBe(false); // 4.5 not extended
    });
  });

  describe('applyExtendedContextSuffix', () => {
    it('should add [1m] suffix to Sonnet 4.6', () => {
      expect(applyExtendedContextSuffix('claude-sonnet-4-6', true)).toBe('claude-sonnet-4-6[1m]');
    });

    it('should add [1m] suffix to Opus 4.7 (supports 1M context)', () => {
      expect(applyExtendedContextSuffix('claude-opus-4-7', true)).toBe('claude-opus-4-7[1m]');
    });

    it('should not add [1m] suffix to Opus 4.5 (does not support 1M)', () => {
      expect(applyExtendedContextSuffix('claude-opus-4-5', true)).toBe('claude-opus-4-5');
    });

    it('should not add [1m] suffix to Haiku models', () => {
      expect(applyExtendedContextSuffix('claude-haiku-4-5', true)).toBe('claude-haiku-4-5');
    });

    it('should not add duplicate [1m] suffix', () => {
      expect(applyExtendedContextSuffix('claude-sonnet-4-6[1m]', true)).toBe('claude-sonnet-4-6[1m]');
    });

    it('should not add suffix when extendedContext is false', () => {
      expect(applyExtendedContextSuffix('claude-sonnet-4-6', false)).toBe('claude-sonnet-4-6');
    });

    it('budgets 1M for OpenRouter-routed Anthropic but sends the BARE slug (no [1m] — OR 400s on the suffix)', () => {
      // modelSupportsExtendedContext is true for these (capability follows the model), so 1M is
      // budgeted — but the wire slug must stay bare; OpenRouter serves 1M by GA capability.
      expect(modelSupportsExtendedContext('anthropic/claude-opus-4-8')).toBe(true);
      expect(applyExtendedContextSuffix('anthropic/claude-opus-4-8', true)).toBe('anthropic/claude-opus-4-8');
      expect(applyExtendedContextSuffix('anthropic/claude-sonnet-4-6', true)).toBe('anthropic/claude-sonnet-4-6');
    });

    it('still adds [1m] for DIRECT Anthropic ids (unchanged)', () => {
      expect(applyExtendedContextSuffix('claude-opus-4-8', true)).toBe('claude-opus-4-8[1m]');
    });
  });
});
