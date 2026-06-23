import { describe, expect, it } from 'vitest';
import type { CustomProvider, ModelProfile } from '@shared/types';
import type { ModelOption } from '@shared/data/modelProviderPresets';
import {
  deriveProfileName,
  getProviderDisplayLabel,
  saveProfileWithResetGuard,
  THINKING_LEVELS,
} from '../profileHelpers';

const BASE_PROFILE: ModelProfile = {
  id: 'p-1',
  name: 'OpenAI / GPT-5.5',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
  apiKey: 'fake-abc',
  createdAt: 1_700_000_000_000,
  chatCompatibility: 'compatible',
  chatCompatibilityCheckedAt: '2026-04-24T00:00:00.000Z',
};

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return { ...BASE_PROFILE, ...overrides };
}

describe('THINKING_LEVELS', () => {
  it('exposes the canonical low/medium/high/xhigh set', () => {
    expect(THINKING_LEVELS.map((entry) => entry.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });
});

describe('saveProfileWithResetGuard', () => {
  it('never resets in add mode', () => {
    const incoming = makeProfile({ id: 'new-1', model: 'different-model' });
    const result = saveProfileWithResetGuard('add', incoming, [BASE_PROFILE]);
    expect(result.chatCompatibility).toBe('compatible');
    expect(result.chatCompatibilityCheckedAt).toBe('2026-04-24T00:00:00.000Z');
  });

  it('preserves verdict when only the name changes in edit mode', () => {
    const incoming = makeProfile({ name: 'Renamed' });
    const result = saveProfileWithResetGuard('edit', incoming, [BASE_PROFILE]);
    expect(result.chatCompatibility).toBe('compatible');
    expect(result.chatCompatibilityCheckedAt).toBe('2026-04-24T00:00:00.000Z');
  });

  it('clears verdict when the model changes', () => {
    const incoming = makeProfile({ model: 'gpt-5.5-turbo' });
    const result = saveProfileWithResetGuard('edit', incoming, [BASE_PROFILE]);
    expect(result.chatCompatibility).toBeUndefined();
    expect(result.chatCompatibilityCheckedAt).toBeUndefined();
  });

  it('clears verdict when the serverUrl changes', () => {
    const incoming = makeProfile({ serverUrl: 'https://proxy.example.com/v1' });
    const result = saveProfileWithResetGuard('edit', incoming, [BASE_PROFILE]);
    expect(result.chatCompatibility).toBeUndefined();
    expect(result.chatCompatibilityCheckedAt).toBeUndefined();
  });

  it('clears verdict when the apiKey changes', () => {
    const incoming = makeProfile({ apiKey: 'fake-new-rotation' });
    const result = saveProfileWithResetGuard('edit', incoming, [BASE_PROFILE]);
    expect(result.chatCompatibility).toBeUndefined();
    expect(result.chatCompatibilityCheckedAt).toBeUndefined();
  });

  it('clears verdict when the providerType changes', () => {
    const incoming = makeProfile({ providerType: 'google' });
    const result = saveProfileWithResetGuard('edit', incoming, [BASE_PROFILE]);
    expect(result.chatCompatibility).toBeUndefined();
    expect(result.chatCompatibilityCheckedAt).toBeUndefined();
  });

  it('clears verdict when the customProviderId changes', () => {
    const base = makeProfile({
      providerType: 'other',
      customProviderId: 'cp-old',
    });
    const incoming = { ...base, customProviderId: 'cp-new' };
    const result = saveProfileWithResetGuard('edit', incoming, [base]);
    expect(result.chatCompatibility).toBeUndefined();
    expect(result.chatCompatibilityCheckedAt).toBeUndefined();
  });

  it('returns incoming unchanged when the existing profile is not found', () => {
    const incoming = makeProfile({ id: 'missing-id' });
    const result = saveProfileWithResetGuard('edit', incoming, [BASE_PROFILE]);
    expect(result).toBe(incoming);
  });
});

describe('getProviderDisplayLabel', () => {
  const customProviders: CustomProvider[] = [
    {
      id: 'cp-known',
      name: 'Acme Gateway',
      serverUrl: 'https://acme.example.com/v1',
      createdAt: 1,
    },
  ];

  it('returns the preset label for known cloud providers', () => {
    expect(
      getProviderDisplayLabel(makeProfile({ providerType: 'openai' }), customProviders),
    ).toBe('OpenAI');
    expect(
      getProviderDisplayLabel(makeProfile({ providerType: 'google' }), customProviders),
    ).toBe('Google Gemini');
    expect(
      getProviderDisplayLabel(makeProfile({ providerType: 'together' }), customProviders),
    ).toBe('Together AI');
    expect(
      getProviderDisplayLabel(makeProfile({ providerType: 'openrouter' }), customProviders),
    ).toBe('OpenRouter');
  });

  it('returns the custom provider name when resolved', () => {
    const profile = makeProfile({
      providerType: 'other',
      customProviderId: 'cp-known',
    });
    expect(getProviderDisplayLabel(profile, customProviders)).toBe('Acme Gateway');
  });

  it('returns "Provider removed" for orphaned customProviderId', () => {
    const profile = makeProfile({
      providerType: 'other',
      customProviderId: 'cp-deleted',
    });
    expect(getProviderDisplayLabel(profile, customProviders)).toBe('Provider removed');
  });

  it('falls back to serverUrl for plain "other" providers', () => {
    const profile = makeProfile({
      providerType: 'other',
      customProviderId: undefined,
      serverUrl: 'http://localhost:1234',
    });
    expect(getProviderDisplayLabel(profile, customProviders)).toBe('http://localhost:1234');
  });

  it('labels local profiles as "Local"', () => {
    const profile = makeProfile({ providerType: 'local', customProviderId: undefined });
    expect(getProviderDisplayLabel(profile, customProviders)).toBe('Local');
  });
});

describe('deriveProfileName', () => {
  const gpt55: ModelOption = {
    value: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'Latest frontier reasoning model',
  };
  const gpt41: ModelOption = {
    value: 'gpt-4.1',
    label: 'GPT-4.1',
    reasoning: false,
  };

  it('returns "{Provider} / {Model} — {Effort} Thinking" for preset providers with reasoning', () => {
    const name = deriveProfileName('openai', gpt55, undefined, {
      reasoningEffort: 'high',
    });
    expect(name).toBe('OpenAI / GPT-5.5 \u2014 High Thinking');
  });

  it('omits the effort suffix when the model does not support reasoning', () => {
    const name = deriveProfileName('openai', gpt41, undefined, {
      reasoningEffort: 'high',
    });
    expect(name).toBe('OpenAI / GPT-4.1');
  });

  it('omits the effort suffix when no reasoningEffort is passed', () => {
    const name = deriveProfileName('openai', gpt55);
    expect(name).toBe('OpenAI / GPT-5.5');
  });

  it('preserves the manually-typed model name when no preset is selected', () => {
    const name = deriveProfileName('together', undefined, 'meta-llama/Llama-3.3-70B', {
      providerLabel: 'Together AI',
      reasoningEffort: 'medium',
    });
    expect(name).toBe('Together AI / meta-llama/Llama-3.3-70B \u2014 Medium Thinking');
  });

  it('falls back to "Custom / {Model}" for "other" providers with no providerLabel', () => {
    const name = deriveProfileName('other', undefined, 'custom-model');
    expect(name).toBe('Custom / custom-model');
  });

  it('returns an empty string when no model is supplied', () => {
    expect(deriveProfileName('openai', undefined, undefined)).toBe('');
    expect(deriveProfileName('openai', undefined, '   ')).toBe('');
  });
});
