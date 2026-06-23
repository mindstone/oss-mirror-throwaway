// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@renderer/test-utils';
import type { CustomProvider, ModelProfile, ProviderKeys } from '@shared/types';
import type { ModelOption } from '@shared/data/modelProviderPresets';
import { useProfileWizard, type UseProfileWizardOptions } from '../useProfileWizard';

const GPT_5_4: ModelOption = {
  value: 'gpt-5.5',
  label: 'GPT-5.5',
  description: 'Latest frontier reasoning model',
};

const GPT_5_4_TURBO: ModelOption = {
  value: 'gpt-5.4-mini',
  label: 'GPT-5.4 mini',
};

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'p-1',
    name: 'OpenAI / GPT-5.5',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    apiKey: undefined,
    createdAt: 1_700_000_000_000,
    reasoningEffort: 'high',
    chatCompatibility: 'compatible',
    chatCompatibilityCheckedAt: '2026-04-24T00:00:00.000Z',
    ...overrides,
  };
}

function makeCustomProvider(overrides: Partial<CustomProvider> = {}): CustomProvider {
  return {
    id: 'cp-1',
    name: 'Acme Gateway',
    serverUrl: 'https://acme.example.com/v1',
    apiKey: 'cp-key',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function renderWizard(options: UseProfileWizardOptions = {}) {
  return renderHook(
    (props: UseProfileWizardOptions) => useProfileWizard(props),
    { initialProps: options },
  );
}

beforeEach(() => {
  // Silence the fail-closed warning in test output.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useProfileWizard — open / close', () => {
  it('starts closed with null state', () => {
    const { result } = renderWizard();
    const [view] = result.current;
    expect(view.state).toBeNull();
  });

  it('opens in add mode on the choose-path step', () => {
    const { result } = renderWizard();
    act(() => {
      const [, actions] = result.current;
      actions.open({ mode: 'add' });
    });
    const [view] = result.current;
    expect(view.state?.step).toBe('choose-path');
    expect(view.state?.mode).toBe('add');
  });

  it('preserves rolePreference when opened from a role-targeted CTA', () => {
    const { result } = renderWizard();
    act(() => {
      const [, actions] = result.current;
      actions.open({ mode: 'add', rolePreference: 'background' });
    });
    const [view] = result.current;
    expect(view.state?.step).toBe('choose-path');
    expect(view.state?.rolePreference).toBe('background');
  });

  it('close() returns state to null', () => {
    const { result } = renderWizard();
    act(() => result.current[1].open({ mode: 'add' }));
    act(() => result.current[1].close());
    expect(result.current[0].state).toBeNull();
  });
});

describe('useProfileWizard — add flow transitions', () => {
  it('selectCustomPath advances from choose-path to the provider step', () => {
    const { result } = renderWizard();
    act(() => result.current[1].open({ mode: 'add' }));
    act(() => result.current[1].selectCustomPath());
    expect(result.current[0].state?.step).toBe('provider');
  });

  it('selectProvider with OpenAI advances to the model step', () => {
    const { result } = renderWizard();
    act(() => result.current[1].open({ mode: 'add' }));
    act(() => result.current[1].selectProvider('openai'));

    const [view] = result.current;
    expect(view.state?.step).toBe('model');
    if (view.state?.step === 'model') {
      expect(view.state.providerType).toBe('openai');
    }
  });

  it('selectProvider with Together (no presets) skips directly to configure', () => {
    const { result } = renderWizard();
    act(() => result.current[1].open({ mode: 'add' }));
    act(() => result.current[1].selectProvider('together'));

    const [view] = result.current;
    expect(view.state?.step).toBe('configure');
    if (view.state?.step === 'configure') {
      expect(view.state.providerType).toBe('together');
      expect(view.state.form.selectedModel).toBeUndefined();
    }
  });

  it('selectProvider with a custom provider skips directly to configure', () => {
    const cp = makeCustomProvider();
    const { result } = renderWizard({ customProviders: [cp] });
    act(() => result.current[1].open({ mode: 'add' }));
    act(() => result.current[1].selectProvider('other', cp));

    const [view] = result.current;
    expect(view.state?.step).toBe('configure');
    if (view.state?.step === 'configure') {
      expect(view.state.customProvider?.id).toBe('cp-1');
      expect(view.state.providerType).toBe('other');
    }
  });

  it('selectProvider with "other" (no custom provider) goes to configure with a serverUrl default', () => {
    const { result } = renderWizard();
    act(() => result.current[1].open({ mode: 'add' }));
    act(() => result.current[1].selectProvider('other'));

    const [view] = result.current;
    expect(view.state?.step).toBe('configure');
    if (view.state?.step === 'configure') {
      expect(view.state.form.serverUrl).toBe('http://localhost:1234');
    }
  });

  it('selectModel advances from model step to configure with a derived name', () => {
    const { result } = renderWizard();
    act(() => result.current[1].open({ mode: 'add' }));
    act(() => result.current[1].selectProvider('openai'));
    act(() => result.current[1].selectModel(GPT_5_4));

    const [view] = result.current;
    expect(view.state?.step).toBe('configure');
    if (view.state?.step === 'configure') {
      expect(view.state.form.selectedModel?.value).toBe('gpt-5.5');
      expect(view.state.form.name).toContain('GPT-5.5');
      // Default reasoning effort seeded to 'medium' for reasoning models.
      expect(view.state.form.reasoningEffort).toBe('medium');
    }
  });

  it('selectTypeManually keeps us on configure with selectedModel undefined', () => {
    const { result } = renderWizard();
    act(() => result.current[1].open({ mode: 'add' }));
    act(() => result.current[1].selectProvider('openai'));
    act(() => result.current[1].selectTypeManually());

    const [view] = result.current;
    expect(view.state?.step).toBe('configure');
    if (view.state?.step === 'configure') {
      expect(view.state.form.selectedModel).toBeUndefined();
      expect(view.state.form.customModelName).toBe('');
    }
  });
});

describe('useProfileWizard — validationEpoch', () => {
  it('bumps validationEpoch on each transition that invalidates validation', () => {
    const { result } = renderWizard();
    act(() => result.current[1].open({ mode: 'add' }));
    const afterOpen = result.current[0].state?.validationEpoch ?? 0;
    act(() => result.current[1].selectProvider('openai'));
    const afterSelectProvider = result.current[0].state?.validationEpoch ?? 0;
    act(() => result.current[1].selectModel(GPT_5_4));
    const afterSelectModel = result.current[0].state?.validationEpoch ?? 0;
    expect(afterSelectProvider).toBeGreaterThan(afterOpen);
    expect(afterSelectModel).toBeGreaterThan(afterSelectProvider);
  });

  it('bumps validationEpoch on updateKey (key change invalidates any in-flight validation)', () => {
    const { result } = renderWizard();
    act(() => result.current[1].open({ mode: 'add' }));
    act(() => result.current[1].selectProvider('openai'));
    act(() => result.current[1].selectModel(GPT_5_4));
    const before = result.current[0].state?.validationEpoch ?? 0;
    act(() => result.current[1].updateKey({ apiKey: 'fake-new' }));
    const after = result.current[0].state?.validationEpoch ?? 0;
    expect(after).toBeGreaterThan(before);
  });
});

describe('useProfileWizard — canSave gating', () => {
  function prepOpenAIConfigure(): ReturnType<typeof renderWizard> {
    const hook = renderWizard();
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectProvider('openai'));
    act(() => hook.result.current[1].selectModel(GPT_5_4));
    return hook;
  }

  it('is false before OpenAI validation completes', () => {
    const hook = prepOpenAIConfigure();
    // Name is auto-filled by selectModel; no saved key; empty apiKey.
    act(() => hook.result.current[1].updateKey({ apiKey: 'fake-abc', usingSavedKey: false }));
    const [view] = hook.result.current;
    expect(view.canSave).toBe(false);
  });

  it('allows save once OpenAI validation returns ok and modelAccessible !== false', () => {
    const hook = prepOpenAIConfigure();
    act(() =>
      hook.result.current[1].updateKey({
        apiKey: 'fake-abc',
        usingSavedKey: false,
        showCustomKeyInput: true,
      }),
    );
    act(() =>
      hook.result.current[1].updateValidation({
        validating: false,
        validationOk: true,
        modelAccessible: true,
        validationMessage: 'Key valid for gpt-5.5.',
      }),
    );
    expect(hook.result.current[0].canSave).toBe(true);
  });

  it('blocks save when OpenAI validation says model is not accessible', () => {
    const hook = prepOpenAIConfigure();
    act(() =>
      hook.result.current[1].updateKey({
        apiKey: 'fake-abc',
        usingSavedKey: false,
        showCustomKeyInput: true,
      }),
    );
    act(() =>
      hook.result.current[1].updateValidation({
        validating: false,
        validationOk: true,
        modelAccessible: false,
        validationMessage: 'Key is valid but gpt-5.5 is not accessible.',
      }),
    );
    expect(hook.result.current[0].canSave).toBe(false);
  });

  it('blocks save for OpenAI + saved key until validation completes', () => {
    const providerKeys: ProviderKeys = { openai: 'fake-saved' };
    const hook = renderWizard({ providerKeys });
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectProvider('openai'));
    act(() => hook.result.current[1].selectModel(GPT_5_4));

    const [view] = hook.result.current;
    if (view.state?.step === 'configure') {
      expect(view.state.key.usingSavedKey).toBe(true);
    }
    // Saved key is present but validation hasn't run — Save is gated.
    expect(view.canSave).toBe(false);

    // Simulate the automatic mount-time validation completing OK.
    act(() =>
      hook.result.current[1].updateValidation({
        validating: false,
        validationOk: true,
        modelAccessible: true,
        validationMessage: 'Key valid for gpt-5.5.',
      }),
    );
    expect(hook.result.current[0].canSave).toBe(true);
  });

  it('requires a non-empty name', () => {
    const providerKeys: ProviderKeys = { openai: 'fake-saved' };
    const hook = renderWizard({ providerKeys });
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectProvider('openai'));
    act(() => hook.result.current[1].selectModel(GPT_5_4));
    // Simulate the auto-validation passing so the name gate is the only
    // remaining variable.
    act(() =>
      hook.result.current[1].updateValidation({
        validating: false,
        validationOk: true,
        modelAccessible: true,
        validationMessage: 'Key valid for gpt-5.5.',
      }),
    );
    expect(hook.result.current[0].canSave).toBe(true);
    act(() => hook.result.current[1].updateForm({ name: '   ' }));
    expect(hook.result.current[0].canSave).toBe(false);
  });

  it('requires a model (preset or manual text) to be selected', () => {
    const hook = renderWizard();
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectProvider('together'));
    // No model yet — not savable.
    expect(hook.result.current[0].canSave).toBe(false);
    act(() =>
      hook.result.current[1].updateForm({
        name: 'Together / Llama',
        customModelName: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      }),
    );
    act(() => hook.result.current[1].updateKey({ apiKey: 'tog-key' }));
    expect(hook.result.current[0].canSave).toBe(true);
  });
});

describe('useProfileWizard — edit mode', () => {
  it('opens in configure step directly with seeded values', () => {
    const profile = makeProfile();
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));

    const [view] = hook.result.current;
    expect(view.state?.step).toBe('configure');
    if (view.state?.step === 'configure') {
      expect(view.state.editingProfileId).toBe(profile.id);
      expect(view.state.form.name).toBe(profile.name);
      expect(view.state.form.selectedModel?.value).toBe('gpt-5.5');
      expect(view.state.form.reasoningEffort).toBe('high');
      // undefined apiKey on profile + saved key in providerKeys => usingSavedKey.
      expect(view.state.key.usingSavedKey).toBe(true);
    }
  });

  it('loads explicit modelNotes when editing a profile', () => {
    const profile = makeProfile({ modelNotes: 'Use for complex synthesis.' });
    const hook = renderWizard({ providerKeys: { openai: 'sk-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));

    const [view] = hook.result.current;
    if (view.state?.step === 'configure') {
      expect(view.state.form.modelNotes).toBe('Use for complex synthesis.');
    }
  });

  it('merges legacy strengths and weaknesses into modelNotes when editing', () => {
    const profile = makeProfile({
      strengths: 'Great at careful analysis',
      weaknesses: 'Avoid routine lookups',
    });
    const hook = renderWizard({ providerKeys: { openai: 'sk-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));

    const [view] = hook.result.current;
    if (view.state?.step === 'configure') {
      expect(view.state.form.modelNotes).toBe('Great at careful analysis. Avoid routine lookups');
    }
  });

  it('refuses to open for companyManaged profiles (fail-closed) and returns a reason', () => {
    const managed = makeProfile({ companyManaged: true });
    const hook = renderWizard();
    let result: { opened: boolean; reason?: string } | undefined;
    act(() => {
      result = hook.result.current[1].open({ mode: 'edit', profile: managed });
    });
    expect(result?.opened).toBe(false);
    expect(typeof result?.reason).toBe('string');
    expect(result?.reason).toContain(managed.id);
    expect(hook.result.current[0].state).toBeNull();
  });

  it('open() returns { opened: true } for normal profiles', () => {
    const profile = makeProfile();
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    let result: { opened: boolean; reason?: string } | undefined;
    act(() => {
      result = hook.result.current[1].open({ mode: 'edit', profile });
    });
    expect(result?.opened).toBe(true);
    expect(result?.reason).toBeUndefined();
  });

  it('opens at Provider step with orphaned banner when customProviderId is missing', () => {
    const profile = makeProfile({
      providerType: 'other',
      customProviderId: 'cp-deleted',
    });
    const hook = renderWizard({ customProviders: [] });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));

    const [view] = hook.result.current;
    expect(view.state?.step).toBe('provider');
    expect(view.state?.mode).toBe('edit');
    if (view.state?.step === 'provider') {
      expect(view.state.orphanedCustomProvider).toBe(true);
      // editingProfileId and originalProfile must ride along so the eventual
      // save targets the original profile rather than minting a new one.
      expect(view.state.editingProfileId).toBe(profile.id);
      expect(view.state.originalProfile?.id).toBe(profile.id);
    }
  });

  it('buildProfile on edit preserves the profile id', () => {
    const profile = makeProfile();
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));
    // Switch the model to gpt-5.4-mini
    act(() =>
      hook.result.current[1].updateForm({
        selectedModel: GPT_5_4_TURBO,
        customModelName: undefined,
      }),
    );
    const built = hook.result.current[1].buildProfile();
    expect(built?.id).toBe(profile.id);
    expect(built?.model).toBe('gpt-5.4-mini');
  });

  it('edit flow re-stamps routeSurface=local for local preset profiles', () => {
    const profile = makeProfile({
      providerType: 'other',
      routeSurface: 'subscription',
      presetKey: 'local:ds4',
      serverUrl: 'http://127.0.0.1:8000/v1',
      model: 'deepseek-v4-flash',
    });
    const hook = renderWizard();
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));

    const built = hook.result.current[1].buildProfile();
    expect(built).not.toBeNull();
    expect(built?.providerType).toBe('other');
    expect(built?.presetKey).toBe('local:ds4');
    expect(built?.routeSurface).toBe('local');
  });

  it('buildProfile saves trimmed modelNotes', () => {
    const profile = makeProfile();
    const hook = renderWizard({ providerKeys: { openai: 'sk-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));
    act(() => hook.result.current[1].updateForm({ modelNotes: '  Use for careful synthesis.  ' }));

    const built = hook.result.current[1].buildProfile();
    expect(built?.modelNotes).toBe('Use for careful synthesis.');
  });

  it('buildProfile returns null when the required model is missing', () => {
    const hook = renderWizard();
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectProvider('together'));
    // No model yet.
    expect(hook.result.current[1].buildProfile()).toBeNull();
  });

  it('buildProfile omits apiKey when using a saved provider key', () => {
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectProvider('openai'));
    act(() => hook.result.current[1].selectModel(GPT_5_4));
    const built = hook.result.current[1].buildProfile();
    expect(built?.apiKey).toBeUndefined();
    expect(built?.providerType).toBe('openai');
    expect(built?.model).toBe('gpt-5.5');
  });

  it('buildProfile omits apiKey for OpenRouter (OAuth-first provider)', () => {
    const hook = renderWizard();
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectProvider('openrouter'));
    act(() =>
      hook.result.current[1].selectModel({
        value: 'anthropic/claude-sonnet-4.6',
        label: 'Claude Sonnet 4.6',
      }),
    );
    const built = hook.result.current[1].buildProfile();
    expect(built?.apiKey).toBeUndefined();
    expect(built?.providerType).toBe('openrouter');
  });

  it('buildProfile for a custom provider sets customProviderId and omits apiKey', () => {
    const cp = makeCustomProvider();
    const hook = renderWizard({ customProviders: [cp] });
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectProvider('other', cp));
    act(() => hook.result.current[1].updateForm({ name: 'Acme / gpt-5.5', customModelName: 'gpt-5.5' }));
    const built = hook.result.current[1].buildProfile();
    expect(built?.customProviderId).toBe(cp.id);
    expect(built?.apiKey).toBeUndefined();
    expect(built?.serverUrl).toBe(cp.serverUrl);
    expect(built?.providerType).toBe('other');
  });
});

describe('useProfileWizard — back navigation', () => {
  it('backToModel returns to the model step from configure in add mode', () => {
    const hook = renderWizard();
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectProvider('openai'));
    act(() => hook.result.current[1].selectModel(GPT_5_4));
    act(() => hook.result.current[1].backToModel());
    expect(hook.result.current[0].state?.step).toBe('model');
  });

  it('backToModel is a no-op for no-preset providers', () => {
    const hook = renderWizard();
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectProvider('together'));
    act(() => hook.result.current[1].backToModel());
    expect(hook.result.current[0].state?.step).toBe('configure');
  });

  it('backToModel is a no-op in edit mode', () => {
    const profile = makeProfile();
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));
    act(() => hook.result.current[1].backToModel());
    expect(hook.result.current[0].state?.step).toBe('configure');
  });

  it('backToProvider returns to the provider step from configure in add mode', () => {
    const hook = renderWizard();
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectProvider('together'));
    act(() => hook.result.current[1].backToProvider());
    expect(hook.result.current[0].state?.step).toBe('provider');
  });

  it('backToChoosePath returns to choose-path from provider in add mode', () => {
    const hook = renderWizard();
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectCustomPath());
    expect(hook.result.current[0].state?.step).toBe('provider');
    act(() => hook.result.current[1].backToChoosePath());
    expect(hook.result.current[0].state?.step).toBe('choose-path');
  });

  it('backToChoosePath is a no-op in edit mode', () => {
    const profile = makeProfile({ customProviderId: 'missing-provider', providerType: 'other' });
    const hook = renderWizard({ customProviders: [] });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));
    expect(hook.result.current[0].state?.step).toBe('provider');
    act(() => hook.result.current[1].backToChoosePath());
    expect(hook.result.current[0].state?.step).toBe('provider');
  });
});

describe('useProfileWizard — edit mode preserved fields', () => {
  it('buildProfile preserves enabled, chatCompatibility, createdAt on a name-only edit', () => {
    const profile = makeProfile({
      enabled: false,
      chatCompatibility: 'compatible',
      chatCompatibilityCheckedAt: '2026-04-24T00:00:00.000Z',
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      authSource: 'codex-subscription',
      councilEnabled: true,
      routingEligible: true,
      companyManaged: undefined,
    });
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));
    // Rename only — no connection-relevant change.
    act(() => hook.result.current[1].updateForm({ name: 'My renamed profile' }));
    const built = hook.result.current[1].buildProfile();
    expect(built).not.toBeNull();
    expect(built?.id).toBe(profile.id);
    expect(built?.name).toBe('My renamed profile');
    // Preserved fields from the original that the wizard never touches:
    expect(built?.enabled).toBe(false);
    expect(built?.chatCompatibility).toBe('compatible');
    expect(built?.chatCompatibilityCheckedAt).toBe('2026-04-24T00:00:00.000Z');
    expect(built?.contextWindow).toBe(128_000);
    expect(built?.maxOutputTokens).toBe(16_000);
    expect(built?.authSource).toBe('codex-subscription');
    // createdAt must NOT be reset to Date.now() on edit.
    expect(built?.createdAt).toBe(profile.createdAt);
    // Wizard-controlled field that the user did toggle stays under wizard control:
    expect(built?.councilEnabled).toBe(true);
    expect(built?.routingEligible).toBe(true);
  });

  it('orphaned-provider recovery carries editingProfileId through to buildProfile', () => {
    const profile = makeProfile({
      providerType: 'other',
      customProviderId: 'cp-deleted',
      enabled: true,
      chatCompatibility: 'incompatible',
    });
    const hook = renderWizard({ customProviders: [] });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));
    // We're on Provider step with orphanedCustomProvider === true.
    // User picks a new preset provider (Together — no model step).
    act(() => hook.result.current[1].selectProvider('together'));
    // Provide required fields for Save.
    act(() =>
      hook.result.current[1].updateForm({
        name: 'Together / Llama',
        customModelName: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      }),
    );
    act(() => hook.result.current[1].updateKey({ apiKey: 'tog-key' }));
    const built = hook.result.current[1].buildProfile();
    expect(built).not.toBeNull();
    // Profile ID must be the ORIGINAL id, not a freshly-minted one.
    expect(built?.id).toBe(profile.id);
    expect(built?.providerType).toBe('together');
    expect(built?.model).toBe('meta-llama/Llama-3.3-70B-Instruct-Turbo');
    // customProviderId must be cleared since the user picked a preset provider.
    expect(built?.customProviderId).toBeUndefined();
    // Preserved-from-original fields survive.
    expect(built?.enabled).toBe(true);
    // createdAt preserved from original (not reset).
    expect(built?.createdAt).toBe(profile.createdAt);
  });
});

describe('useProfileWizard — model change invalidates validation', () => {
  it('updateForm with a new selectedModel bumps validationEpoch and clears validation', () => {
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectProvider('openai'));
    act(() => hook.result.current[1].selectModel(GPT_5_4));
    // Simulate that a validation has already passed for the current (key, model).
    act(() =>
      hook.result.current[1].updateValidation({
        validating: false,
        validationOk: true,
        modelAccessible: true,
        validationMessage: 'Key valid for gpt-5.5.',
      }),
    );
    const epochBefore = hook.result.current[0].state?.validationEpoch ?? 0;
    // User swaps to gpt-5.4-mini via the Configure dropdown.
    act(() =>
      hook.result.current[1].updateForm({
        selectedModel: GPT_5_4_TURBO,
        customModelName: undefined,
      }),
    );
    const after = hook.result.current[0].state;
    expect(after?.validationEpoch ?? 0).toBeGreaterThan(epochBefore);
    if (after?.step === 'configure') {
      expect(after.validation.validationOk).toBeNull();
      expect(after.validation.modelAccessible).toBeNull();
      expect(after.validation.validating).toBe(false);
      expect(after.validation.validationMessage).toBeNull();
    }
    // canSave must now be false — old validation no longer applies to new model.
    expect(hook.result.current[0].canSave).toBe(false);
  });

  it('updateForm with a new customModelName also bumps epoch + clears validation', () => {
    const hook = renderWizard();
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectProvider('openai'));
    act(() => hook.result.current[1].selectTypeManually());
    act(() =>
      hook.result.current[1].updateForm({
        customModelName: 'gpt-5.4-mini',
      }),
    );
    act(() =>
      hook.result.current[1].updateKey({ apiKey: 'fake-new' }),
    );
    act(() =>
      hook.result.current[1].updateValidation({
        validating: false,
        validationOk: true,
        modelAccessible: true,
      }),
    );
    const epochBefore = hook.result.current[0].state?.validationEpoch ?? 0;
    act(() =>
      hook.result.current[1].updateForm({
        customModelName: 'gpt-5.5-pro',
      }),
    );
    const after = hook.result.current[0].state;
    expect(after?.validationEpoch ?? 0).toBeGreaterThan(epochBefore);
    if (after?.step === 'configure') {
      expect(after.validation.validationOk).toBeNull();
    }
  });

  it('updateForm with a non-model change (e.g. reasoningEffort) does NOT touch validation', () => {
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'add' }));
    act(() => hook.result.current[1].selectProvider('openai'));
    act(() => hook.result.current[1].selectModel(GPT_5_4));
    act(() =>
      hook.result.current[1].updateValidation({
        validating: false,
        validationOk: true,
        modelAccessible: true,
        validationMessage: 'ok',
      }),
    );
    const epochBefore = hook.result.current[0].state?.validationEpoch ?? 0;
    act(() =>
      hook.result.current[1].updateForm({
        reasoningEffort: 'high',
      }),
    );
    const after = hook.result.current[0].state;
    expect(after?.validationEpoch ?? 0).toBe(epochBefore);
    if (after?.step === 'configure') {
      expect(after.validation.validationOk).toBe(true);
    }
  });
});

describe('useProfileWizard — testKey uniqueness', () => {
  it('mints a fresh testKey on each open (no cross-wizard bleed)', () => {
    const hook = renderWizard();
    act(() => hook.result.current[1].open({ mode: 'add' }));
    const firstKey = hook.result.current[0].state?.testKey;
    expect(firstKey).toBeDefined();
    expect(firstKey).toMatch(/^wizard-draft:/);
    act(() => hook.result.current[1].close());
    act(() => hook.result.current[1].open({ mode: 'add' }));
    const secondKey = hook.result.current[0].state?.testKey;
    expect(secondKey).toBeDefined();
    expect(secondKey).not.toBe(firstKey);
  });

  it('preserves the testKey across step transitions within one open session', () => {
    const hook = renderWizard();
    act(() => hook.result.current[1].open({ mode: 'add' }));
    const keyAtOpen = hook.result.current[0].state?.testKey;
    act(() => hook.result.current[1].selectProvider('openai'));
    expect(hook.result.current[0].state?.testKey).toBe(keyAtOpen);
    act(() => hook.result.current[1].selectModel(GPT_5_4));
    expect(hook.result.current[0].state?.testKey).toBe(keyAtOpen);
    act(() => hook.result.current[1].backToModel());
    expect(hook.result.current[0].state?.testKey).toBe(keyAtOpen);
    act(() => hook.result.current[1].backToProvider());
    expect(hook.result.current[0].state?.testKey).toBe(keyAtOpen);
  });
});

describe('useProfileWizard — learned context window provenance', () => {
  it('seeds form contextWindow / maxOutputTokens from the profile on edit', () => {
    const profile = makeProfile({
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      contextWindowSource: 'auto',
      lastLearnedContextWindow: 128_000,
      contextWindowOverflowCount: 3,
      contextWindowLearnedAt: 1_700_000_500_000,
    });
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));
    const view = hook.result.current[0];
    if (view.state?.step !== 'configure') throw new Error('expected configure step');
    expect(view.state.form.contextWindow).toBe(128_000);
    expect(view.state.form.maxOutputTokens).toBe(16_000);
    expect(view.state.form.contextWindowTouched).toBe(false);
    expect(view.state.form.maxOutputTokensTouched).toBe(false);
  });

  it('untouched name-only edit preserves auto provenance on contextWindow', () => {
    const profile = makeProfile({
      contextWindow: 128_000,
      contextWindowSource: 'auto',
      lastLearnedContextWindow: 128_000,
      contextWindowOverflowCount: 2,
    });
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));
    act(() => hook.result.current[1].updateForm({ name: 'New name' }));
    const built = hook.result.current[1].buildProfile();
    expect(built).not.toBeNull();
    expect(built?.contextWindow).toBe(128_000);
    expect(built?.contextWindowSource).toBe('auto');
    expect(built?.lastLearnedContextWindow).toBe(128_000);
    expect(built?.contextWindowOverflowCount).toBe(2);
  });

  it('user-touched contextWindow stamps source=user and preserves learned sidecar', () => {
    const profile = makeProfile({
      contextWindow: 128_000,
      contextWindowSource: 'auto',
      lastLearnedContextWindow: 128_000,
      contextWindowOverflowCount: 2,
      contextWindowLearnedAt: 1_700_000_500_000,
    });
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));
    act(() => hook.result.current[1].updateForm({ contextWindow: 200_000 }));
    const built = hook.result.current[1].buildProfile();
    expect(built?.contextWindow).toBe(200_000);
    expect(built?.contextWindowSource).toBe('user');
    expect(built?.lastLearnedContextWindow).toBe(128_000);
    expect(built?.contextWindowOverflowCount).toBe(2);
    expect(built?.contextWindowLearnedAt).toBe(1_700_000_500_000);
  });

  it('useLearnedContextWindow restores auto provenance from lastLearnedContextWindow', () => {
    const profile = makeProfile({
      contextWindow: 64_000,
      contextWindowSource: 'user',
      lastLearnedContextWindow: 128_000,
      contextWindowOverflowCount: 5,
      contextWindowLearnedAt: 1_700_000_500_000,
    });
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));
    act(() => hook.result.current[1].useLearnedContextWindow());
    const view = hook.result.current[0];
    if (view.state?.step !== 'configure') throw new Error('expected configure step');
    expect(view.state.form.contextWindow).toBe(128_000);
    expect(view.state.form.useLearnedRequested).toBe(true);
    expect(view.state.form.contextWindowTouched).toBe(false);
    const built = hook.result.current[1].buildProfile();
    expect(built?.contextWindow).toBe(128_000);
    expect(built?.contextWindowSource).toBe('auto');
    expect(built?.contextWindowOverflowCount).toBe(5);
  });

  it('touching contextWindow after useLearnedContextWindow re-stamps source=user', () => {
    const profile = makeProfile({
      contextWindow: 64_000,
      contextWindowSource: 'user',
      lastLearnedContextWindow: 128_000,
      contextWindowOverflowCount: 5,
    });
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));
    act(() => hook.result.current[1].useLearnedContextWindow());
    act(() => hook.result.current[1].updateForm({ contextWindow: 256_000 }));
    const built = hook.result.current[1].buildProfile();
    expect(built?.contextWindow).toBe(256_000);
    expect(built?.contextWindowSource).toBe('user');
  });

  it('clearing contextWindow drops both value AND source while preserving sidecar', () => {
    // Phase 6 Refinement Cycle 1, Bug 1: clearing the field must not leave
    // contextWindowSource: 'user' on a profile whose contextWindow is undefined
    // — that mismatch would tell the resolver "treat unset as user-supplied".
    const profile = makeProfile({
      contextWindow: 200_000,
      contextWindowSource: 'auto',
      lastLearnedContextWindow: 200_000,
      contextWindowOverflowCount: 2,
      contextWindowLearnedAt: 1_700_000_500_000,
    });
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));
    act(() => hook.result.current[1].updateForm({ contextWindow: null }));
    const built = hook.result.current[1].buildProfile();
    expect(built?.contextWindow).toBeUndefined();
    expect(built?.contextWindowSource).toBeUndefined();
    expect(built?.lastLearnedContextWindow).toBe(200_000);
    expect(built?.contextWindowOverflowCount).toBe(2);
    expect(built?.contextWindowLearnedAt).toBe(1_700_000_500_000);
  });
});

describe('useProfileWizard — token field validation gates canSave', () => {
  it('canSave is false when contextWindow is below MIN_TOKEN_FIELD_VALUE', () => {
    // Phase 6 Refinement Cycle 1, Bug 3: the inline-validation copy in the
    // Advanced disclosure must also gate Save — otherwise users could persist
    // a 999-token contextWindow that the runtime cannot honor.
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile: makeProfile() }));
    act(() => hook.result.current[1].updateForm({ contextWindow: 999 }));
    expect(hook.result.current[0].canSave).toBe(false);
  });

  it('canSave is false when contextWindow exceeds MAX_TOKEN_FIELD_VALUE', () => {
    const hook = renderWizard({ providerKeys: { openai: 'fake-saved' } });
    act(() => hook.result.current[1].open({ mode: 'edit', profile: makeProfile() }));
    act(() => hook.result.current[1].updateForm({ contextWindow: 10_000_001 }));
    expect(hook.result.current[0].canSave).toBe(false);
  });

  it('canSave is true at a sane in-range contextWindow value (non-OpenAI provider)', () => {
    // Use providerType='other' so canSave isn't gated on OpenAI validation;
    // we're isolating the token-range gate.
    const hook = renderWizard();
    act(() =>
      hook.result.current[1].open({
        mode: 'edit',
        profile: makeProfile({ providerType: 'other', serverUrl: 'http://x.example.com/v1' }),
      }),
    );
    act(() => hook.result.current[1].updateForm({ contextWindow: 1_500_000 }));
    expect(hook.result.current[0].canSave).toBe(true);
  });

  it('canSave is false when maxOutputTokens is out of range', () => {
    const hook = renderWizard();
    act(() =>
      hook.result.current[1].open({
        mode: 'edit',
        profile: makeProfile({ providerType: 'other', serverUrl: 'http://x.example.com/v1' }),
      }),
    );
    act(() => hook.result.current[1].updateForm({ maxOutputTokens: 500 }));
    expect(hook.result.current[0].canSave).toBe(false);
  });
});

describe('useProfileWizard — auto-only profiles can save without serverUrl', () => {
  it('canSave is true for auto:<id> profiles in incomplete state', () => {
    const profile = makeProfile({
      id: 'auto:gpt-5-future',
      providerType: 'other',
      serverUrl: '',
      apiKey: undefined,
      contextWindow: 128_000,
      contextWindowSource: 'auto',
      lastLearnedContextWindow: 128_000,
      enabled: false,
    });
    const hook = renderWizard();
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));
    act(() =>
      hook.result.current[1].updateForm({
        name: 'gpt-5-future',
        customModelName: 'gpt-5-future',
      }),
    );
    expect(hook.result.current[0].canSave).toBe(true);
  });

  it('canSave reverts to full validation once user enters a serverUrl', () => {
    const profile = makeProfile({
      id: 'auto:gpt-5-future',
      providerType: 'other',
      serverUrl: '',
      apiKey: undefined,
      contextWindow: 128_000,
      contextWindowSource: 'auto',
      lastLearnedContextWindow: 128_000,
      enabled: false,
    });
    const hook = renderWizard();
    act(() => hook.result.current[1].open({ mode: 'edit', profile }));
    act(() =>
      hook.result.current[1].updateForm({
        name: 'gpt-5-future',
        customModelName: 'gpt-5-future',
        serverUrl: 'http://example.com/v1',
      }),
    );
    // serverUrl is now non-empty so the auto-only relaxation no longer applies.
    // For providerType='other' that's enough to still pass (no apiKey required by default).
    expect(hook.result.current[0].canSave).toBe(true);
  });
});
