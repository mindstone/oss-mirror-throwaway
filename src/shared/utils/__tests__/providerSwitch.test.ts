import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCAL_MODEL_SETTINGS,
  DEFAULT_OPENROUTER_SETTINGS,
  type AppSettings,
} from '../../types';
import {
  CODEX_BTS_PROFILE_ID,
  CODEX_DEFAULT_MODEL,
  CODEX_WORKING_PROFILE_ID,
  applyCodexModelDefaults,
} from '../codexDefaults';
import {
  OR_DEFAULT_BTS_MODEL,
  OR_DEFAULT_THINKING_MODEL,
  OR_DEFAULT_WORKING_MODEL,
} from '../openRouterDefaults';
import { DEFAULT_AUXILIARY_MODEL, DEFAULT_MODEL } from '../modelNormalization';
import { formatActiveProviderLabel, pickFallbackProvider, planProviderSwitch } from '../providerSwitch';

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  const base: AppSettings = {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: false,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      ttsVoice: null,
      activationHotkey: null,
      activationHotkeyVoiceMode: true,
    },
    models: {
      apiKey: 'fake-anthropic',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: true,
      thinkingEffort: 'high',
    },
    claude: {
      apiKey: 'fake-anthropic',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: true,
      thinkingEffort: 'high',
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    openRouter: { ...DEFAULT_OPENROUTER_SETTINGS },
    localModel: { ...DEFAULT_LOCAL_MODEL_SETTINGS },
  } as unknown as AppSettings;

  return {
    ...base,
    ...overrides,
    models: {
      ...base.models!,
      ...(overrides.models! ?? {}),
    },
    openRouter:
      overrides.openRouter === undefined
        ? base.openRouter
        : {
            ...base.openRouter,
            ...overrides.openRouter,
          },
    localModel:
      overrides.localModel === undefined
        ? base.localModel
        : {
            ...base.localModel,
            ...overrides.localModel,
          },
  };
}

describe('planProviderSwitch', () => {
  it('applies Anthropic defaults to empty tier slots on fresh install', () => {
    const settings = makeSettings({
      activeProvider: undefined,
      models: {
        ...makeSettings().models!,
        model: '',
        thinkingModel: undefined,
        workingProfileId: undefined,
        thinkingProfileId: undefined,
      },
      behindTheScenesModel: undefined,
    });

    const plan = planProviderSwitch({
      to: 'anthropic',
      settings,
      codexConnected: false,
    });

    expect(plan.updates.activeProvider).toBe('anthropic');
    expect(plan.updates.models?.model).toBe(DEFAULT_MODEL);
    expect(plan.updates.models?.thinkingModel).toBeUndefined();
    expect(plan.updates.behindTheScenesModel).toBe(DEFAULT_AUXILIARY_MODEL);
  });

  it('applies OpenRouter defaults to empty tier slots on fresh install', () => {
    const settings = makeSettings({
      activeProvider: undefined,
      models: {
        ...makeSettings().models!,
        model: '',
        thinkingModel: undefined,
        workingProfileId: undefined,
        thinkingProfileId: undefined,
      },
      behindTheScenesModel: undefined,
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        oauthToken: 'or-token',
      },
    });

    const plan = planProviderSwitch({
      to: 'openrouter',
      settings,
      codexConnected: false,
    });

    expect(plan.updates.activeProvider).toBe('openrouter');
    expect(plan.updates.models?.model).toBe(OR_DEFAULT_WORKING_MODEL);
    expect(plan.updates.models?.thinkingModel).toBe(OR_DEFAULT_THINKING_MODEL);
    expect(plan.updates.behindTheScenesModel).toBe(OR_DEFAULT_BTS_MODEL);
    expect(plan.updates.openRouter).toEqual({
      ...DEFAULT_OPENROUTER_SETTINGS,
      enabled: true,
      oauthToken: 'or-token',
    });
  });

  it('preserves personal OpenRouter oauth token when switching from mindstone to openrouter', () => {
    const settings = makeSettings({
      activeProvider: 'mindstone',
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        enabled: true,
        oauthToken: 'or-test-token',
      },
    });

    const plan = planProviderSwitch({
      to: 'openrouter',
      settings,
      codexConnected: false,
    });

    expect(plan.updates.activeProvider).toBe('openrouter');
    expect(plan.updates.openRouter?.oauthToken).toBe('or-test-token');
  });

  it('resets primary slots for mindstone → openrouter when mindstone seeded OR-format managed defaults', () => {
    const settings = makeSettings({
      activeProvider: 'mindstone',
      models: {
        ...makeSettings().models!,
        model: 'anthropic/claude-sonnet-4-5',
        thinkingModel: 'anthropic/claude-opus-4',
      },
      behindTheScenesModel: 'google/gemini-flash',
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        oauthToken: 'or-token',
      },
    });

    const plan = planProviderSwitch({
      to: 'openrouter',
      settings,
      codexConnected: false,
    });

    expect(plan.updates.models?.model).toBe(OR_DEFAULT_WORKING_MODEL);
    expect(plan.updates.models?.thinkingModel).toBe(OR_DEFAULT_THINKING_MODEL);
    expect(plan.updates.behindTheScenesModel).toBe(OR_DEFAULT_BTS_MODEL);
  });

  it('resets primary slots to Anthropic defaults for mindstone → anthropic', () => {
    const settings = makeSettings({
      activeProvider: 'mindstone',
      models: {
        ...makeSettings().models!,
        model: 'anthropic/claude-sonnet-4-5',
        thinkingModel: 'anthropic/claude-opus-4',
      },
      behindTheScenesModel: 'google/gemini-flash',
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        oauthToken: 'or-token',
      },
    });

    const plan = planProviderSwitch({
      to: 'anthropic',
      settings,
      codexConnected: false,
    });

    expect(plan.updates.models?.model).toBe(DEFAULT_MODEL);
    expect(plan.updates.models?.thinkingModel).toBeUndefined();
    expect(plan.updates.behindTheScenesModel).toBe(DEFAULT_AUXILIARY_MODEL);
  });

  it('resets primary slots to Codex defaults for mindstone → codex', () => {
    const settings = makeSettings({
      activeProvider: 'mindstone',
      models: {
        ...makeSettings().models!,
        model: 'anthropic/claude-sonnet-4-5',
        thinkingModel: 'anthropic/claude-opus-4',
      },
      behindTheScenesModel: 'google/gemini-flash',
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        oauthToken: 'or-token',
      },
    });

    const plan = planProviderSwitch({
      to: 'codex',
      settings,
      codexConnected: true,
    });

    expect(plan.updates.models?.model).toBe(CODEX_DEFAULT_MODEL);
    expect(plan.updates.models?.workingProfileId).toBe(CODEX_WORKING_PROFILE_ID);
    expect(plan.updates.behindTheScenesModel).toBe(`profile:${CODEX_BTS_PROFILE_ID}`);
  });

  it('resets primary slots for codex → openrouter even when codex source carries OR-format thinking state', () => {
    const base = makeSettings({
      activeProvider: 'codex',
      models: {
        ...makeSettings().models!,
        model: CODEX_DEFAULT_MODEL,
        workingProfileId: CODEX_WORKING_PROFILE_ID,
        // This OR-format thinking value would be reused by format checks alone.
        thinkingModel: 'anthropic/claude-opus-4',
      },
      behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        oauthToken: 'or-token',
      },
    });
    const codexDefaults = applyCodexModelDefaults(base);
    const settings = makeSettings({
      ...base,
      localModel: codexDefaults.localModel,
    });

    const plan = planProviderSwitch({
      to: 'openrouter',
      settings,
      codexConnected: true,
    });

    expect(plan.updates.models?.model).toBe(OR_DEFAULT_WORKING_MODEL);
    expect(plan.updates.models?.thinkingModel).toBe(OR_DEFAULT_THINKING_MODEL);
    expect(plan.updates.behindTheScenesModel).toBe(OR_DEFAULT_BTS_MODEL);
  });

  it('preserves format-compatible primary picks for BYOK → BYOK (anthropic → openrouter) — pins managed-source guard does not widen reset scope', () => {
    const settings = makeSettings({
      activeProvider: 'anthropic',
      models: {
        ...makeSettings().models!,
        model: 'openai/gpt-5.5',
        thinkingModel: 'anthropic/claude-opus-4',
      },
      behindTheScenesModel: 'minimax/minimax-m2.7',
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        oauthToken: 'or-token',
      },
    });

    const plan = planProviderSwitch({
      to: 'openrouter',
      settings,
      codexConnected: false,
    });

    expect(plan.updates.models?.model).toBeUndefined();
    expect(plan.updates.models?.thinkingModel).toBeUndefined();
    expect(plan.updates.behindTheScenesModel).toBeUndefined();
  });

  it('applies Codex defaults to empty tier slots on fresh install', () => {
    const base = makeSettings({
      activeProvider: undefined,
      models: {
        ...makeSettings().models!,
        model: '',
        thinkingModel: undefined,
        workingProfileId: undefined,
        thinkingProfileId: undefined,
      },
      behindTheScenesModel: undefined,
    });

    const plan = planProviderSwitch({
      to: 'codex',
      settings: base,
      codexConnected: true,
    });

    expect(plan.updates.activeProvider).toBe('codex');
    expect(plan.updates.models?.model).toBe(CODEX_DEFAULT_MODEL);
    expect(plan.updates.models?.workingProfileId).toBe(CODEX_WORKING_PROFILE_ID);
    expect(plan.updates.behindTheScenesModel).toBe(`profile:${CODEX_BTS_PROFILE_ID}`);
    expect(plan.updates.localModel?.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: CODEX_WORKING_PROFILE_ID, authSource: 'codex-subscription' }),
        expect.objectContaining({ id: CODEX_BTS_PROFILE_ID, authSource: 'codex-subscription' }),
      ]),
    );
  });

  it('applies server-supplied managedDefaults to every tier slot when switching to mindstone', () => {
    const settings = makeSettings({ activeProvider: 'anthropic' });

    const managedDefaults = {
      working: 'anthropic/claude-sonnet-4',
      thinking: 'anthropic/claude-opus-4',
      bts: 'google/gemini-flash',
    };

    const plan = planProviderSwitch({
      to: 'mindstone',
      settings,
      codexConnected: false,
      managedDefaults,
    });

    expect(plan.updates.activeProvider).toBe('mindstone');
    expect(plan.updates.models?.model).toBe('anthropic/claude-sonnet-4');
    expect(plan.updates.models?.thinkingModel).toBe('anthropic/claude-opus-4');
    expect(plan.updates.models?.workingProfileId).toBeUndefined();
    expect(plan.updates.models?.thinkingProfileId).toBeUndefined();
    expect(plan.updates.behindTheScenesModel).toBe('google/gemini-flash');
    expect(plan.clearedSlots).toEqual([]);
    expect(plan.preservedSlots).toEqual([]);
  });

  it('falls back to OpenRouter defaults when switching to mindstone without managedDefaults', () => {
    const settings = makeSettings({ activeProvider: 'anthropic' });

    const plan = planProviderSwitch({
      to: 'mindstone',
      settings,
      codexConnected: false,
    });

    expect(plan.updates.activeProvider).toBe('mindstone');
    expect(plan.updates.models?.model).toBe(OR_DEFAULT_WORKING_MODEL);
    expect(plan.updates.models?.thinkingModel).toBe(OR_DEFAULT_THINKING_MODEL);
    expect(plan.updates.behindTheScenesModel).toBe(OR_DEFAULT_BTS_MODEL);
  });

  it('mixes partial managedDefaults with OpenRouter defaults per role when switching to mindstone', () => {
    const settings = makeSettings({ activeProvider: 'anthropic' });

    const managedDefaults = {
      working: 'anthropic/claude-sonnet-4',
    };

    const plan = planProviderSwitch({
      to: 'mindstone',
      settings,
      codexConnected: false,
      managedDefaults,
    });

    expect(plan.updates.activeProvider).toBe('mindstone');
    expect(plan.updates.models?.model).toBe('anthropic/claude-sonnet-4');
    expect(plan.updates.models?.thinkingModel).toBe(OR_DEFAULT_THINKING_MODEL);
    expect(plan.updates.behindTheScenesModel).toBe(OR_DEFAULT_BTS_MODEL);
  });

  it('preserves Anthropic fallbacks when switching to OpenRouter and Anthropic auth remains available', () => {
    const settings = makeSettings({
      activeProvider: 'anthropic',
      models: {
        ...makeSettings().models!,
        thinkingFallback: 'model:claude-opus-4-7',
      },
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        oauthToken: 'or-token',
      },
    });

    const plan = planProviderSwitch({
      to: 'openrouter',
      settings,
      codexConnected: false,
    });

    expect(plan.preservedSlots).toContainEqual({
      label: 'Thinking fallback',
      value: 'model:claude-opus-4-7',
    });
    expect(plan.clearedSlots).toEqual([]);
  });

  it('preserves OpenRouter-format fallbacks when switching to OpenRouter and OR auth exists', () => {
    const settings = makeSettings({
      activeProvider: 'anthropic',
      models: {
        ...makeSettings().models!,
        thinkingFallback: 'model:openai/gpt-5.5',
      },
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        oauthToken: 'or-token',
      },
    });

    const plan = planProviderSwitch({
      to: 'openrouter',
      settings,
      codexConnected: false,
    });

    expect(plan.preservedSlots).toContainEqual({
      label: 'Thinking fallback',
      value: 'model:openai/gpt-5.5',
    });
    expect(plan.clearedSlots).toEqual([]);
  });

  it('clears OpenRouter-format fallbacks when switching away from Codex without OR credentials', () => {
    const settings = makeSettings({
      activeProvider: 'codex',
      models: {
        ...makeSettings().models!,
        thinkingFallback: 'model:openai/gpt-5.5',
      },
    });

    const plan = planProviderSwitch({
      to: 'anthropic',
      settings,
      codexConnected: true,
    });

    expect(plan.updates.models?.thinkingFallback).toBeUndefined();
    expect(plan.clearedSlots).toContainEqual({
      label: 'Thinking fallback',
      previousValue: 'model:openai/gpt-5.5',
      reason: 'no-openrouter-credentials',
    });
  });

  it('preserves Anthropic fallbacks when switching to Codex and Anthropic auth still exists', () => {
    const settings = makeSettings({
      activeProvider: 'anthropic',
      models: {
        ...makeSettings().models!,
        thinkingFallback: 'model:claude-opus-4-7',
      },
    });

    const plan = planProviderSwitch({
      to: 'codex',
      settings,
      codexConnected: true,
    });

    expect(plan.preservedSlots).toContainEqual({
      label: 'Thinking fallback',
      value: 'model:claude-opus-4-7',
    });
    expect(plan.clearedSlots).toEqual([]);
  });

  it('clears OpenRouter fallbacks after disconnecting OpenRouter credentials', () => {
    const settings = makeSettings({
      activeProvider: 'openrouter',
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        enabled: false,
        oauthToken: null,
      },
      models: {
        ...makeSettings().models!,
        thinkingFallback: 'model:openai/gpt-5.5',
      },
      backgroundFallback: 'model:openai/gpt-5.5',
    });

    const plan = planProviderSwitch({
      to: 'anthropic',
      settings,
      codexConnected: false,
    });

    expect(plan.updates.models?.thinkingFallback).toBeUndefined();
    expect(plan.updates.backgroundFallback).toBeUndefined();
    expect(plan.clearedSlots).toEqual([
      {
        label: 'Thinking fallback',
        previousValue: 'model:openai/gpt-5.5',
        reason: 'no-openrouter-credentials',
      },
      {
        label: 'Background fallback',
        previousValue: 'model:openai/gpt-5.5',
        reason: 'no-openrouter-credentials',
      },
    ]);
  });

  it('returns an empty plan when switching to the already-active provider', () => {
    const settings = makeSettings({ activeProvider: 'anthropic' });

    const plan = planProviderSwitch({
      to: 'anthropic',
      settings,
      codexConnected: false,
    });

    expect(plan).toEqual({
      updates: {},
      clearedSlots: [],
      preservedSlots: [],
    });
  });

  it('clears Codex-tagged profile fallbacks when Codex is disconnected (even if providerKeys.openai is set)', () => {
    const base = makeSettings({
      activeProvider: 'codex',
      providerKeys: { openai: 'fake-openai' },
    });
    const codexDefaults = applyCodexModelDefaults(base);
    const settings = makeSettings({
      ...base,
      localModel: codexDefaults.localModel,
      providerKeys: { openai: 'fake-openai' },
      models: {
        ...base.models!,
        thinkingFallback: `profile:${CODEX_WORKING_PROFILE_ID}`,
      },
    });

    const plan = planProviderSwitch({
      to: 'anthropic',
      settings,
      codexConnected: false,
    });

    expect(plan.preservedSlots).toEqual([]);
    expect(plan.clearedSlots).toContainEqual({
      label: 'Thinking fallback',
      previousValue: `profile:${CODEX_WORKING_PROFILE_ID}`,
      reason: 'codex-disconnected',
    });
  });

  it('clears bare gpt-* overrides when switching Codex → Anthropic even if providerKeys.openai is set', () => {
    const settings = makeSettings({
      activeProvider: 'codex',
      providerKeys: { openai: 'fake-openai' },
      behindTheScenesOverrides: { safety: 'gpt-5.4-mini' },
    });

    const plan = planProviderSwitch({
      to: 'anthropic',
      settings,
      codexConnected: true,
    });

    expect(plan.updates.behindTheScenesOverrides).toBeUndefined();
    expect(plan.clearedSlots).toContainEqual({
      label: 'Background override (safety)',
      previousValue: 'gpt-5.4-mini',
      reason: 'no-bts-openai-routing',
    });
  });

  it('preserves bare gpt-* overrides when switching Codex → OpenRouter because OR proxy routes them', () => {
    const settings = makeSettings({
      activeProvider: 'codex',
      providerKeys: { openrouter: 'or-key' },
      openRouter: {
        ...DEFAULT_OPENROUTER_SETTINGS,
        oauthToken: 'or-token',
      },
      behindTheScenesOverrides: { safety: 'gpt-5.4-mini' },
    });

    const plan = planProviderSwitch({
      to: 'openrouter',
      settings,
      codexConnected: true,
    });

    expect(plan.updates.behindTheScenesOverrides?.safety).toBe('gpt-5.4-mini');
    expect(plan.clearedSlots).not.toContainEqual(
      expect.objectContaining({ previousValue: 'gpt-5.4-mini' }),
    );
  });

  it('preserves Codex profile override when switching to Codex and Codex is connected', () => {
    const base = makeSettings({
      activeProvider: 'anthropic',
      providerKeys: { openai: 'fake-openai' },
    });
    const codexDefaults = applyCodexModelDefaults(base);
    const settings = makeSettings({
      ...base,
      localModel: codexDefaults.localModel,
      providerKeys: { openai: 'fake-openai' },
      behindTheScenesOverrides: { safety: `profile:${CODEX_BTS_PROFILE_ID}` },
    });

    const plan = planProviderSwitch({
      to: 'codex',
      settings,
      codexConnected: true,
    });

    expect(plan.updates.behindTheScenesOverrides?.safety).toBe(`profile:${CODEX_BTS_PROFILE_ID}`);
    expect(plan.preservedSlots).toContainEqual({
      label: 'Background override (safety)',
      value: `profile:${CODEX_BTS_PROFILE_ID}`,
    });
  });

  it('clears Codex profile override when switching from Codex to Anthropic with Codex disconnected', () => {
    const base = makeSettings({
      activeProvider: 'codex',
      providerKeys: { openai: 'fake-openai' },
    });
    const codexDefaults = applyCodexModelDefaults(base);
    const settings = makeSettings({
      ...base,
      localModel: codexDefaults.localModel,
      providerKeys: { openai: 'fake-openai' },
      behindTheScenesOverrides: { safety: `profile:${CODEX_BTS_PROFILE_ID}` },
    });

    const plan = planProviderSwitch({
      to: 'anthropic',
      settings,
      codexConnected: false,
    });

    expect(plan.updates.behindTheScenesOverrides).toBeUndefined();
    expect(plan.clearedSlots).toContainEqual({
      label: 'Background override (safety)',
      previousValue: `profile:${CODEX_BTS_PROFILE_ID}`,
      reason: 'codex-disconnected',
    });
  });

  it('clears bare gpt-* in thinkingFallback when switching Codex → Anthropic and no OR credentials', () => {
    const settings = makeSettings({
      activeProvider: 'codex',
      providerKeys: { openai: 'fake-openai' },
      models: {
        ...makeSettings().models!,
        thinkingFallback: 'gpt-5.4-mini',
      },
    });

    const plan = planProviderSwitch({
      to: 'anthropic',
      settings,
      codexConnected: true,
    });

    expect(plan.updates.models?.thinkingFallback).toBeUndefined();
    expect(plan.clearedSlots).toContainEqual({
      label: 'Thinking fallback',
      previousValue: 'gpt-5.4-mini',
      reason: 'no-bts-openai-routing',
    });
  });
});

describe('planProviderSwitch — managed-source transition matrix', () => {
  type TransitionCase = {
    name: string;
    from: AppSettings['activeProvider'];
    to: NonNullable<AppSettings['activeProvider']>;
    sourceModels: {
      model: string;
      thinkingModel?: string;
      behindTheScenesModel: string;
    };
    expectedPatch: {
      model?: string;
      thinkingModel?: string;
      behindTheScenesModel?: string;
      managedProviderDeactivated?: boolean;
    };
    codexConnected?: boolean;
  };

  const cases: TransitionCase[] = [
    {
      name: 'mindstone → openrouter resets managed-seeded OpenRouter-format primary slots to OpenRouter defaults',
      from: 'mindstone',
      to: 'openrouter',
      sourceModels: {
        model: 'anthropic/claude-sonnet-4-6',
        thinkingModel: 'anthropic/claude-opus-4.7',
        behindTheScenesModel: 'google/gemini-3.1-pro-preview',
      },
      expectedPatch: {
        model: OR_DEFAULT_WORKING_MODEL,
        thinkingModel: OR_DEFAULT_THINKING_MODEL,
        behindTheScenesModel: OR_DEFAULT_BTS_MODEL,
        managedProviderDeactivated: true,
      },
    },
    {
      name: 'mindstone → anthropic resets managed-seeded primary slots to direct-Anthropic defaults',
      from: 'mindstone',
      to: 'anthropic',
      sourceModels: {
        model: 'anthropic/claude-sonnet-4-6',
        thinkingModel: 'anthropic/claude-opus-4.7',
        behindTheScenesModel: 'google/gemini-3.1-pro-preview',
      },
      expectedPatch: {
        model: DEFAULT_MODEL,
        thinkingModel: undefined,
        behindTheScenesModel: DEFAULT_AUXILIARY_MODEL,
        managedProviderDeactivated: true,
      },
    },
    {
      name: 'codex → openrouter resets subscription-seeded primary slots to OpenRouter defaults',
      from: 'codex',
      to: 'openrouter',
      sourceModels: {
        model: CODEX_DEFAULT_MODEL,
        thinkingModel: 'anthropic/claude-opus-4.7',
        behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
      },
      expectedPatch: {
        model: OR_DEFAULT_WORKING_MODEL,
        thinkingModel: OR_DEFAULT_THINKING_MODEL,
        behindTheScenesModel: OR_DEFAULT_BTS_MODEL,
        managedProviderDeactivated: true,
      },
      codexConnected: true,
    },
    {
      name: 'BYOK openrouter → anthropic preserves user-picked direct-Anthropic primary slots',
      from: 'openrouter',
      to: 'anthropic',
      sourceModels: {
        model: 'claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-7',
        behindTheScenesModel: 'claude-haiku-4-5',
      },
      expectedPatch: {
        model: undefined,
        thinkingModel: undefined,
        behindTheScenesModel: undefined,
        managedProviderDeactivated: true,
      },
    },
  ];

  describe.each(cases)('$name', (testCase) => {
    it('returns the expected settings patch', () => {
      const settings = makeSettings({
        activeProvider: testCase.from,
        models: {
          ...makeSettings().models!,
          model: testCase.sourceModels.model,
          thinkingModel: testCase.sourceModels.thinkingModel,
          workingProfileId: undefined,
          thinkingProfileId: undefined,
        },
        behindTheScenesModel: testCase.sourceModels.behindTheScenesModel,
        openRouter: {
          ...DEFAULT_OPENROUTER_SETTINGS,
          enabled: testCase.from === 'openrouter',
          oauthToken: 'or-token',
        },
      });

      const plan = planProviderSwitch({
        to: testCase.to,
        settings,
        codexConnected: testCase.codexConnected ?? false,
      });

      expect(plan.updates.activeProvider).toBe(testCase.to);
      expect(plan.updates.models?.model).toBe(testCase.expectedPatch.model);
      expect(plan.updates.models?.thinkingModel).toBe(testCase.expectedPatch.thinkingModel);
      expect(plan.updates.behindTheScenesModel).toBe(testCase.expectedPatch.behindTheScenesModel);
      expect(plan.updates.managedProviderDeactivated).toBe(testCase.expectedPatch.managedProviderDeactivated);
    });
  });
});

describe('pickFallbackProvider', () => {
  it('falls back to codex when disconnecting OpenRouter and codex is connected', () => {
    expect(pickFallbackProvider({
      disconnecting: 'openrouter',
      hasAnthropicKey: true,
      hasOpenRouterToken: false,
      codexConnected: true,
    })).toBe('codex');
  });

  it('falls back to anthropic when disconnecting OpenRouter and only anthropic key exists', () => {
    expect(pickFallbackProvider({
      disconnecting: 'openrouter',
      hasAnthropicKey: true,
      hasOpenRouterToken: false,
      codexConnected: false,
    })).toBe('anthropic');
  });

  it('falls back to openrouter when disconnecting Codex and openrouter token exists', () => {
    expect(pickFallbackProvider({
      disconnecting: 'codex',
      hasAnthropicKey: true,
      hasOpenRouterToken: true,
      codexConnected: false,
    })).toBe('openrouter');
  });

  it('falls back to anthropic when disconnecting Codex and only anthropic key exists', () => {
    expect(pickFallbackProvider({
      disconnecting: 'codex',
      hasAnthropicKey: true,
      hasOpenRouterToken: false,
      codexConnected: false,
    })).toBe('anthropic');
  });

  it('falls back to codex when disconnecting Anthropic and codex is connected', () => {
    expect(pickFallbackProvider({
      disconnecting: 'anthropic',
      hasAnthropicKey: false,
      hasOpenRouterToken: false,
      codexConnected: true,
    })).toBe('codex');
  });

  it('falls back to openrouter when disconnecting Anthropic and openrouter token exists', () => {
    expect(pickFallbackProvider({
      disconnecting: 'anthropic',
      hasAnthropicKey: false,
      hasOpenRouterToken: true,
      codexConnected: false,
    })).toBe('openrouter');
  });

  it('returns undefined when disconnecting the only connected provider', () => {
    expect(pickFallbackProvider({
      disconnecting: 'anthropic',
      hasAnthropicKey: false,
      hasOpenRouterToken: false,
      codexConnected: false,
    })).toBeUndefined();
  });

  it('respects priority order when all three are connected', () => {
    expect(pickFallbackProvider({
      disconnecting: 'anthropic',
      hasAnthropicKey: false,
      hasOpenRouterToken: true,
      codexConnected: true,
    })).toBe('codex');
  });

  it('never returns mindstone as a fallback provider', () => {
    expect(pickFallbackProvider({
      disconnecting: 'anthropic',
      hasAnthropicKey: false,
      hasOpenRouterToken: false,
      codexConnected: false,
    })).not.toBe('mindstone');

    expect(pickFallbackProvider({
      disconnecting: 'codex',
      hasAnthropicKey: true,
      hasOpenRouterToken: true,
      codexConnected: false,
    })).not.toBe('mindstone');
  });
});

describe('formatActiveProviderLabel', () => {
  it('returns ChatGPT Pro for codex', () => {
    expect(formatActiveProviderLabel('codex')).toBe('ChatGPT Pro');
  });

  it('returns Mindstone for mindstone', () => {
    expect(formatActiveProviderLabel('mindstone')).toBe('Mindstone');
  });

  it('returns OpenRouter for openrouter', () => {
    expect(formatActiveProviderLabel('openrouter')).toBe('OpenRouter');
  });

  it('returns Anthropic for anthropic', () => {
    expect(formatActiveProviderLabel('anthropic')).toBe('Anthropic');
  });

  it('returns a non-empty user-facing label for every ActiveProvider value', () => {
    // TS strict mode + the exhaustive switch in formatActiveProviderLabel are
    // the real safety net (a missing case is a compile error). This loop is a
    // belt-and-braces runtime sanity check that no branch returns an empty or
    // non-string value.
    const providers = ['codex', 'mindstone', 'openrouter', 'anthropic'] as const;
    for (const provider of providers) {
      const label = formatActiveProviderLabel(provider);
      expect(label).toBeTruthy();
      expect(typeof label).toBe('string');
    }
  });
});

describe('planProviderSwitch — managedProviderDeactivated opt-out marker', () => {
  // The marker is what stops the /api/config reconcile from re-activating
  // Mindstone after a deliberate switch away (the "can't leave Mindstone" bug).
  it('sets the opt-out marker when switching AWAY from mindstone', () => {
    const settings = makeSettings({ activeProvider: 'mindstone' });
    const plan = planProviderSwitch({ to: 'anthropic', settings, codexConnected: false });
    expect(plan.updates.activeProvider).toBe('anthropic');
    expect(plan.updates.managedProviderDeactivated).toBe(true);
  });

  it('sets the opt-out marker for any non-mindstone target (e.g. openrouter)', () => {
    const settings = makeSettings({ activeProvider: 'mindstone' });
    const plan = planProviderSwitch({ to: 'openrouter', settings, codexConnected: false });
    expect(plan.updates.managedProviderDeactivated).toBe(true);
  });

  it('clears the opt-out marker when switching TO mindstone', () => {
    const settings = makeSettings({ activeProvider: 'anthropic', managedProviderDeactivated: true });
    const plan = planProviderSwitch({ to: 'mindstone', settings, codexConnected: false });
    expect(plan.updates.activeProvider).toBe('mindstone');
    expect(plan.updates.managedProviderDeactivated).toBe(false);
  });

  it('no-op switch (same provider) returns empty updates and does not touch the marker', () => {
    const settings = makeSettings({ activeProvider: 'anthropic', managedProviderDeactivated: true });
    const plan = planProviderSwitch({ to: 'anthropic', settings, codexConnected: false });
    expect(plan.updates).toEqual({});
    expect('managedProviderDeactivated' in plan.updates).toBe(false);
  });
});
