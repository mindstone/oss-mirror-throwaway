import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCAL_MODEL_SETTINGS,
  DEFAULT_OPENROUTER_SETTINGS,
  type AppSettings,
  type ModelProfile,
  type ModelSettings,
} from '../../types';
import { CODEX_WORKING_PROFILE_ID } from '../codexDefaults';
import {
  billingSourceLabelSuffix,
  resolveBillingSourceForOption,
  resolveBillingSourceForProfile,
  type BillingSource,
} from '../billingSource';

function makeProfile(
  overrides: Partial<ModelProfile> & Pick<ModelProfile, 'id' | 'name'>
): ModelProfile {
  const { id, name, ...rest } = overrides;
  return {
    id,
    name,
    serverUrl: rest.serverUrl ?? 'https://api.example.com/v1',
    providerType: rest.providerType ?? 'openai',
    model: rest.model ?? 'gpt-4.1',
    createdAt: rest.createdAt ?? 0,
    ...rest,
  };
}

const codexProfile = makeProfile({
  id: CODEX_WORKING_PROFILE_ID,
  name: 'GPT-5.5 (ChatGPT Pro)',
  authSource: 'codex-subscription',
  providerType: 'openai',
  model: 'gpt-5.5',
  serverUrl: 'https://api.openai.com/v1',
});

const localProfile = makeProfile({
  id: 'local-ollama',
  name: 'Local Llama',
  providerType: 'local',
  model: 'llama3.2',
  serverUrl: 'http://127.0.0.1:11434/v1',
});

const openAiProfile = makeProfile({
  id: 'openai-direct',
  name: 'GPT-4.1',
  providerType: 'openai',
  model: 'gpt-4.1',
  serverUrl: 'https://api.openai.com/v1',
});

const anthropicProfile = makeProfile({
  id: 'claude-api',
  name: 'Claude Sonnet 4.6',
  providerType: 'other',
  model: 'claude-sonnet-4-6',
  serverUrl: 'https://api.anthropic.com/v1',
});

const openRouterProfile = makeProfile({
  id: 'openrouter-api',
  name: 'OpenRouter Llama',
  providerType: 'openrouter',
  model: 'meta-llama/llama-3',
  serverUrl: 'https://openrouter.ai/api/v1',
});

const byoLocalRouteSurfaceProfile = makeProfile({
  id: 'byo-local-route-surface',
  name: 'DS4 local route surface',
  providerType: 'other',
  routeSurface: 'local',
  model: 'deepseek-v4-flash',
  serverUrl: 'https://api.example.com/v1',
});

type SettingsOverrides = Partial<Omit<AppSettings, 'claude' | 'models' | 'openRouter' | 'localModel'>> & {
  claude?: Partial<ModelSettings>;
  models?: Partial<ModelSettings>;
  openRouter?: Partial<NonNullable<AppSettings['openRouter']>>;
  localModel?: Partial<NonNullable<AppSettings['localModel']>>;
};

function makeSettings(overrides: SettingsOverrides = {}): AppSettings {
  const {
    claude: claudeOverrides,
    models: modelsOverrides,
    openRouter: openRouterOverrides,
    localModel: localModelOverrides,
    ...rootOverrides
  } = overrides;
  const baseModels: ModelSettings = {
    apiKey: 'fake-anthropic',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-6',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
  };
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
    ...(claudeOverrides ? { claude: { ...baseModels, ...claudeOverrides } } : {}),
    models: { ...baseModels, ...(claudeOverrides ?? {}), ...(modelsOverrides ?? {}) },
    diagnostics: { debugBreadcrumbsUntil: null },
    openRouter: { ...DEFAULT_OPENROUTER_SETTINGS },
    localModel: {
      ...DEFAULT_LOCAL_MODEL_SETTINGS,
      profiles: [codexProfile, localProfile, openAiProfile, anthropicProfile, openRouterProfile],
    },
    providerKeys: {
      openai: 'fake-openai',
    },
  } as unknown as AppSettings;

  return {
    ...base,
    ...rootOverrides,
    openRouter:
      openRouterOverrides === undefined
        ? base.openRouter
        : {
            ...base.openRouter,
            ...openRouterOverrides,
          } as NonNullable<AppSettings['openRouter']>,
    localModel:
      localModelOverrides === undefined
        ? base.localModel
        : {
            ...base.localModel,
            ...localModelOverrides,
          } as NonNullable<AppSettings['localModel']>,
  };
}

describe('resolveBillingSourceForOption', () => {
  const credentialStates = [
    {
      name: 'codex connected with Anthropic and OpenRouter configured',
      settings: makeSettings({
        claude: { ...makeSettings().models, apiKey: 'fake-anthropic' },
        openRouter: { ...DEFAULT_OPENROUTER_SETTINGS, oauthToken: 'or-token' },
      }),
      codexConnected: true,
    },
    {
      name: 'Anthropic only with Codex disconnected',
      settings: makeSettings({
        claude: { ...makeSettings().models, apiKey: 'fake-anthropic' },
        openRouter: { ...DEFAULT_OPENROUTER_SETTINGS, oauthToken: null },
      }),
      codexConnected: false,
    },
    {
      name: 'OpenRouter only with Codex disconnected',
      settings: makeSettings({
        claude: { ...makeSettings().models, apiKey: null },
        openRouter: { ...DEFAULT_OPENROUTER_SETTINGS, oauthToken: 'or-token' },
      }),
      codexConnected: false,
    },
    {
      name: 'Mindstone subscription active (BYOK token also present)',
      settings: makeSettings({
        activeProvider: 'mindstone',
        claude: { ...makeSettings().models, apiKey: null },
        openRouter: { ...DEFAULT_OPENROUTER_SETTINGS, oauthToken: 'or-token' },
      }),
      codexConnected: false,
    },
    {
      name: 'Mindstone subscription active (no BYOK token)',
      settings: makeSettings({
        activeProvider: 'mindstone',
        claude: { ...makeSettings().models, apiKey: null },
        openRouter: { ...DEFAULT_OPENROUTER_SETTINGS, oauthToken: null },
      }),
      codexConnected: false,
    },
  ] as const;

  const optionCases: Array<{
    label: string;
    value: string;
    expected: (state: (typeof credentialStates)[number]) => BillingSource;
  }> = [
    {
      label: 'profile:<id>',
      value: `profile:${CODEX_WORKING_PROFILE_ID}`,
      expected: (state) => (state.codexConnected ? 'subscription' : 'pay-per-use'),
    },
    {
      label: 'model:<id>',
      value: `model:${encodeURIComponent('gpt-5.5')}`,
      expected: (state) => (state.codexConnected ? 'subscription' : 'pay-per-use'),
    },
    {
      label: 'OpenRouter raw id',
      value: 'openai/gpt-5.5',
      expected: (state) => {
        if (state.settings.activeProvider === 'mindstone') {
          return 'subscription';
        }
        return state.settings.openRouter?.oauthToken ? 'pool' : 'pay-per-use';
      },
    },
    {
      label: 'Codex-offered gpt raw id',
      value: 'gpt-5.5',
      expected: (state) => (state.codexConnected ? 'subscription' : 'pay-per-use'),
    },
    {
      label: 'Claude raw id',
      value: 'claude-sonnet-4-6',
      expected: () => 'pay-per-use',
    },
    {
      label: 'Ollama-prefixed local id',
      value: 'ollama:llama3.2',
      expected: () => 'local',
    },
  ];

  for (const state of credentialStates) {
    for (const optionCase of optionCases) {
      it(`resolves ${optionCase.label} for ${state.name}`, () => {
        expect(resolveBillingSourceForOption(optionCase.value, state.settings, state.codexConnected))
          .toBe(optionCase.expected(state));
      });
    }
  }

  it('returns undefined for the empty same-as-working placeholder', () => {
    expect(resolveBillingSourceForOption('', makeSettings(), true)).toBeUndefined();
  });

  it('treats Codex-tagged profiles as pay-per-use when Codex is disconnected', () => {
    expect(resolveBillingSourceForOption(`profile:${CODEX_WORKING_PROFILE_ID}`, makeSettings(), false))
      .toBe('pay-per-use');
  });
});

describe('resolveBillingSourceForProfile', () => {
  const settings = makeSettings();

  it('returns local for local profiles', () => {
    expect(resolveBillingSourceForProfile(localProfile, settings, false)).toBe('local');
  });

  it('returns local when routeSurface is local even if providerType is other', () => {
    expect(resolveBillingSourceForProfile(byoLocalRouteSurfaceProfile, settings, false)).toBe('local');
  });

  it('returns subscription for Codex-tagged profiles when Codex is connected', () => {
    expect(resolveBillingSourceForProfile(codexProfile, settings, true)).toBe('subscription');
  });

  it('returns pay-per-use for Codex-tagged profiles when Codex is disconnected', () => {
    expect(resolveBillingSourceForProfile(codexProfile, settings, false)).toBe('pay-per-use');
  });

  it('returns pool for OpenRouter profiles regardless of token state when not on Mindstone', () => {
    // With token
    expect(resolveBillingSourceForProfile(openRouterProfile, makeSettings({
      openRouter: { ...DEFAULT_OPENROUTER_SETTINGS, oauthToken: 'token' }
    }), false)).toBe('pool');

    // Without token
    expect(resolveBillingSourceForProfile(openRouterProfile, makeSettings({
      openRouter: { ...DEFAULT_OPENROUTER_SETTINGS, oauthToken: null }
    }), false)).toBe('pool');
  });

  it('returns subscription for OpenRouter profiles when Mindstone is the active provider', () => {
    // BYOK token still present alongside Mindstone — should still be subscription
    expect(resolveBillingSourceForProfile(openRouterProfile, makeSettings({
      activeProvider: 'mindstone',
      openRouter: { ...DEFAULT_OPENROUTER_SETTINGS, oauthToken: 'token' }
    }), false)).toBe('subscription');

    // No BYOK token — managed Mindstone key
    expect(resolveBillingSourceForProfile(openRouterProfile, makeSettings({
      activeProvider: 'mindstone',
      openRouter: { ...DEFAULT_OPENROUTER_SETTINGS, oauthToken: null }
    }), false)).toBe('subscription');
  });

  it('returns pay-per-use for regular API-key profiles', () => {
    expect(resolveBillingSourceForProfile(openAiProfile, settings, false)).toBe('pay-per-use');
    expect(resolveBillingSourceForProfile(anthropicProfile, settings, false)).toBe('pay-per-use');
  });
});

describe('billingSourceLabelSuffix', () => {
  it('returns the expected suffix for each billing source', () => {
    expect(billingSourceLabelSuffix('subscription')).toBe(' — Subscription');
    expect(billingSourceLabelSuffix('pool')).toBe(' — Credits');
    expect(billingSourceLabelSuffix('pay-per-use')).toBe(' — Pay-per-use');
    expect(billingSourceLabelSuffix('local')).toBe(' — Local');
    expect(billingSourceLabelSuffix(undefined)).toBe('');
  });

  // The ModelChoicePicker renderer consumer composes its dropdown label as
  // `${option.label}${billingSourceLabelSuffix(resolveBillingSourceForOption(...))}`
  // (ModelChoicePicker.tsx withBillingSuffix). These assertions cover that exact
  // composed path so the renderer consumer of the DECISION-B refactor isn't
  // covered only indirectly via React rendering.
  it('composes a slash-id pool/subscription suffix the way ModelChoicePicker does', () => {
    // Personal OpenRouter token off-Mindstone => pool => " — Credits".
    const poolSuffix = billingSourceLabelSuffix(
      resolveBillingSourceForOption(
        'openai/gpt-5.5',
        makeSettings({
          openRouter: { ...DEFAULT_OPENROUTER_SETTINGS, oauthToken: 'or-token' },
        }),
        false
      )
    );
    expect(poolSuffix).toBe(' — Credits');

    // Mindstone active => subscription => " — Subscription".
    const subscriptionSuffix = billingSourceLabelSuffix(
      resolveBillingSourceForOption(
        'openai/gpt-5.5',
        makeSettings({
          activeProvider: 'mindstone',
          openRouter: { ...DEFAULT_OPENROUTER_SETTINGS, oauthToken: 'or-token' },
        }),
        false
      )
    );
    expect(subscriptionSuffix).toBe(' — Subscription');
  });

  it('composes a profile: suffix the way ModelChoicePicker does', () => {
    // Codex-tagged working profile, codex connected => subscription => " — Subscription".
    const connectedSuffix = billingSourceLabelSuffix(
      resolveBillingSourceForOption(`profile:${CODEX_WORKING_PROFILE_ID}`, makeSettings(), true)
    );
    expect(connectedSuffix).toBe(' — Subscription');

    // Same profile, codex disconnected => pay-per-use => " — Pay-per-use".
    const disconnectedSuffix = billingSourceLabelSuffix(
      resolveBillingSourceForOption(`profile:${CODEX_WORKING_PROFILE_ID}`, makeSettings(), false)
    );
    expect(disconnectedSuffix).toBe(' — Pay-per-use');
  });
});
