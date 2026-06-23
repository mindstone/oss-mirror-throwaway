/**
 * Settings Accessors — Unit Tests
 *
 * Validates the provider-neutral accessor layer that isolates Rebel Core
 * runtime code from direct model-settings property accesses.
 */
import { describe, it, expect } from 'vitest';
import type { AppSettings } from '@shared/types';
import {
  getModelEfforts,
  getGlobalThinkingEffort,
  getContextOverflowFallbackModel,
  getContextOverflowFallbackProfileId,
  resolveEffectiveModelSettings,
  getEffectiveWorkingModel,
  getEffectiveThinkingModel,
  toBareModelId,
} from '../settingsAccessors';

/**
 * Minimal AppSettings factory — only populates fields under test.
 * Matches the pattern used by other rebelCore tests (e.g., queryRouter.test.ts).
 */
function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    models: {
      apiKey: '',
      model: 'claude-sonnet-4-20250514',
      thinkingModel: 'claude-opus-4-20250514',
      behindTheScenesModel: 'claude-haiku-3.5-20241022',
      planMode: true,
      maxTurns: 20,
      thinkingEffort: 'high',
      maxOutputTokens: 16384,
      extendedContext: false,
    },
    diagnostics: {
      showRawMessages: false,
    },
    experimental: {},
    ...overrides,
  } as AppSettings;
}

// ---------------------------------------------------------------------------
// getModelEfforts
// ---------------------------------------------------------------------------
describe('getModelEfforts', () => {
  it('returns per-model effort overrides when configured', () => {
    const settings = makeSettings({
      models: {
        ...makeSettings().models!,
        modelEfforts: {
          'claude-opus-4-20250514': 'xhigh',
          'claude-sonnet-4-20250514': 'medium',
        },
      },
    });
    const efforts = getModelEfforts(settings);
    expect(efforts).toEqual({
      'claude-opus-4-20250514': 'xhigh',
      'claude-sonnet-4-20250514': 'medium',
    });
  });

  it('returns undefined when modelEfforts is not configured', () => {
    const settings = makeSettings();
    expect(getModelEfforts(settings)).toBeUndefined();
  });

  it('returns undefined when models settings are missing', () => {
    const settings = makeSettings();
    (settings as Record<string, unknown>).models = undefined;
    expect(getModelEfforts(settings)).toBeUndefined();
  });

  it('supports non-Anthropic model IDs as keys', () => {
    const settings = makeSettings({
      models: {
        ...makeSettings().models!,
        modelEfforts: {
          'gpt-5.5': 'high',
          'claude-opus-4-20250514': 'xhigh',
        },
      },
    });
    const efforts = getModelEfforts(settings);
    expect(efforts?.['gpt-5.5']).toBe('high');
    expect(efforts?.['claude-opus-4-20250514']).toBe('xhigh');
  });

  it('per-model override takes precedence over global effort', () => {
    const settings = makeSettings({
      models: {
        ...makeSettings().models!,
        thinkingEffort: 'low',
        modelEfforts: {
          'claude-opus-4-20250514': 'xhigh',
        },
      },
    });
    const efforts = getModelEfforts(settings);
    const global = getGlobalThinkingEffort(settings);
    // Model-specific override should differ from global
    expect(efforts?.['claude-opus-4-20250514']).toBe('xhigh');
    expect(global).toBe('low');
    // Consumer-side precedence: efforts[model] ?? globalEffort
    const resolved = efforts?.['claude-opus-4-20250514'] ?? global;
    expect(resolved).toBe('xhigh');
  });
});

// ---------------------------------------------------------------------------
// getGlobalThinkingEffort
// ---------------------------------------------------------------------------
describe('getGlobalThinkingEffort', () => {
  it('returns the global thinking effort when set', () => {
    const settings = makeSettings({
      models: { ...makeSettings().models!, thinkingEffort: 'medium' },
    });
    expect(getGlobalThinkingEffort(settings)).toBe('medium');
  });

  it('returns each valid effort level', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
      const settings = makeSettings({
        models: { ...makeSettings().models!, thinkingEffort: effort },
      });
      expect(getGlobalThinkingEffort(settings)).toBe(effort);
    }
  });

  it('returns undefined when models settings are missing', () => {
    const settings = makeSettings();
    (settings as Record<string, unknown>).models = undefined;
    expect(getGlobalThinkingEffort(settings)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getContextOverflowFallbackModel
// ---------------------------------------------------------------------------
describe('getContextOverflowFallbackModel', () => {
  it('returns the fallback model when configured', () => {
    const settings = makeSettings({
      models: {
        ...makeSettings().models!,
        longContextFallbackModel: 'claude-sonnet-4-20250514',
      },
    });
    expect(getContextOverflowFallbackModel(settings)).toBe('claude-sonnet-4-20250514');
  });

  it('returns undefined when not configured', () => {
    const settings = makeSettings();
    expect(getContextOverflowFallbackModel(settings)).toBeUndefined();
  });

  it('returns undefined when models settings are missing', () => {
    const settings = makeSettings();
    (settings as Record<string, unknown>).models = undefined;
    expect(getContextOverflowFallbackModel(settings)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getContextOverflowFallbackProfileId
// ---------------------------------------------------------------------------
describe('getContextOverflowFallbackProfileId', () => {
  it('returns the fallback profile ID when configured', () => {
    const settings = makeSettings({
      models: {
        ...makeSettings().models!,
        longContextFallbackProfileId: 'profile-openai-gpt5',
      },
    });
    expect(getContextOverflowFallbackProfileId(settings)).toBe('profile-openai-gpt5');
  });

  it('returns undefined when not configured', () => {
    const settings = makeSettings();
    expect(getContextOverflowFallbackProfileId(settings)).toBeUndefined();
  });

  it('returns undefined when models settings are missing', () => {
    const settings = makeSettings();
    (settings as Record<string, unknown>).models = undefined;
    expect(getContextOverflowFallbackProfileId(settings)).toBeUndefined();
  });

  it('profileId takes precedence over model name (consumer-side)', () => {
    const settings = makeSettings({
      models: {
        ...makeSettings().models!,
        longContextFallbackModel: 'claude-sonnet-4-20250514',
        longContextFallbackProfileId: 'profile-openai-gpt5',
      },
    });
    const profileId = getContextOverflowFallbackProfileId(settings);
    const model = getContextOverflowFallbackModel(settings);
    // Both are set, but consumer should prefer profileId
    expect(profileId).toBe('profile-openai-gpt5');
    expect(model).toBe('claude-sonnet-4-20250514');
    // Consumer-side precedence: profileId ?? model
    const resolved = profileId ?? model;
    expect(resolved).toBe('profile-openai-gpt5');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: Mixed / OpenAI-only settings
// ---------------------------------------------------------------------------
describe('mixed and OpenAI-only settings', () => {
  it('all accessors work with OpenAI-only user (minimal models settings)', () => {
    // An OpenAI-only user still has model defaults, but model-specific fields
    // may be absent.
    const settings = makeSettings({
      models: {
        ...makeSettings().models!,
        apiKey: '', // No Anthropic key
        thinkingEffort: 'high',
      },
    });
    expect(getGlobalThinkingEffort(settings)).toBe('high');
    expect(getModelEfforts(settings)).toBeUndefined();
    expect(getContextOverflowFallbackModel(settings)).toBeUndefined();
    expect(getContextOverflowFallbackProfileId(settings)).toBeUndefined();
  });

  it('all accessors return defined values with fully-configured mixed profile', () => {
    const settings = makeSettings({
      models: {
        ...makeSettings().models!,
        thinkingEffort: 'medium',
        modelEfforts: {
          'gpt-5.5': 'high',
          'claude-opus-4-20250514': 'xhigh',
        },
        longContextFallbackModel: 'gpt-5.5-128k',
        longContextFallbackProfileId: 'profile-openai-large',
      },
    });
    expect(getGlobalThinkingEffort(settings)).toBe('medium');
    expect(getModelEfforts(settings)).toEqual({
      'gpt-5.5': 'high',
      'claude-opus-4-20250514': 'xhigh',
    });
    expect(getContextOverflowFallbackModel(settings)).toBe('gpt-5.5-128k');
    expect(getContextOverflowFallbackProfileId(settings)).toBe('profile-openai-large');
  });
});

// ---------------------------------------------------------------------------
// Resolved view re-export smoke + onMalformed wiring smoke
// ---------------------------------------------------------------------------
describe('resolveEffectiveModelSettings (re-export)', () => {
  it('re-exports the resolver and produces the same shape as @shared/utils', () => {
    const resolved = resolveEffectiveModelSettings({
      models: { model: 'anthropic/claude-sonnet-4-6' } as never,
    });
    expect(resolved.workingModel).toBe('claude-sonnet-4-6');
  });

  it('per-tier helper re-exports return expected values', () => {
    const settings = {
      models: {
        model: 'anthropic/claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-7',
      } as never,
    };
    expect(getEffectiveWorkingModel(settings)).toBe('claude-sonnet-4-6');
    expect(getEffectiveThinkingModel(settings)).toBe('claude-opus-4-7');
  });

  it('toBareModelId is re-exported with provider-aware semantics', () => {
    expect(toBareModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(
      toBareModelId('anthropic/claude-sonnet-4-6', { activeProvider: 'openrouter' }),
    ).toBe('anthropic/claude-sonnet-4-6');
  });

  it('user-provided onMalformed overrides the default errorReporter wiring', () => {
    let observed = false;
    resolveEffectiveModelSettings(
      { models: 'broken' as never },
      {
        throwOnMalformed: false,
        onMalformed: () => {
          observed = true;
        },
      },
    );
    expect(observed).toBe(true);
  });
});
