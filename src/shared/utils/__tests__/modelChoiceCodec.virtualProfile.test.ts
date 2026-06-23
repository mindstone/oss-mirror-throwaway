import { describe, it, expect } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import { decodeRoleChoice } from '../modelChoiceCodec';

const DECODE_OPTIONS = {
  defaultWorkingModel: 'claude-sonnet-4-6',
  defaultBackgroundModel: 'claude-haiku-4-5',
};

function virtualProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: '__virtual-thinking',
    name: 'Claude (Thinking)',
    providerType: 'anthropic',
    serverUrl: '',
    model: 'claude-opus-4-7',
    enabled: true,
    isVirtual: true,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function realProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'p-1',
    name: 'My GPT 5.5',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    apiKey: 'fake',
    enabled: true,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('decodeRoleChoice — virtual profile unwrap', () => {
  it('unwraps __virtual-thinking back to a model choice for the thinking role', () => {
    const settings: Partial<AppSettings> = {
      models: {
        thinkingProfileId: '__virtual-thinking',
        workingProfileId: 'p-1',
      } as AppSettings['models'],
      localModel: {
        activeProfileId: null,
        profiles: [realProfile(), virtualProfile()],
      },
    };

    const choice = decodeRoleChoice('thinking', settings, DECODE_OPTIONS);
    expect(choice).toEqual({ kind: 'model', modelId: 'claude-opus-4-7' });
  });

  it('unwraps __virtual-working back to a model choice for the working role', () => {
    const settings: Partial<AppSettings> = {
      models: {
        workingProfileId: '__virtual-working',
      } as AppSettings['models'],
      localModel: {
        activeProfileId: null,
        profiles: [
          virtualProfile({ id: '__virtual-working', name: 'Claude (Working)', model: 'claude-sonnet-4-6' }),
        ],
      },
    };

    const choice = decodeRoleChoice('working', settings, DECODE_OPTIONS);
    expect(choice).toEqual({ kind: 'model', modelId: 'claude-sonnet-4-6' });
  });

  it('keeps real (non-virtual) profile choices untouched', () => {
    const settings: Partial<AppSettings> = {
      models: {
        thinkingProfileId: 'p-1',
      } as AppSettings['models'],
      localModel: {
        activeProfileId: null,
        profiles: [realProfile()],
      },
    };

    const choice = decodeRoleChoice('thinking', settings, DECODE_OPTIONS);
    expect(choice).toEqual({ kind: 'profile', profileId: 'p-1' });
  });

  it('falls back to a profile choice when the virtual profile has no model id', () => {
    const settings: Partial<AppSettings> = {
      models: {
        thinkingProfileId: '__virtual-thinking',
      } as AppSettings['models'],
      localModel: {
        activeProfileId: null,
        profiles: [virtualProfile({ model: '' })],
      },
    };

    const choice = decodeRoleChoice('thinking', settings, DECODE_OPTIONS);
    expect(choice).toEqual({ kind: 'profile', profileId: '__virtual-thinking' });
  });

  it('keeps the profile choice when the referenced profile is missing entirely', () => {
    const settings: Partial<AppSettings> = {
      models: {
        thinkingProfileId: '__virtual-thinking',
      } as AppSettings['models'],
      localModel: {
        activeProfileId: null,
        profiles: [],
      },
    };

    const choice = decodeRoleChoice('thinking', settings, DECODE_OPTIONS);
    expect(choice).toEqual({ kind: 'profile', profileId: '__virtual-thinking' });
  });

  it('unwraps the virtual profile when working role uses legacy activeProfileId', () => {
    const settings: Partial<AppSettings> = {
      models: {} as AppSettings['models'],
      localModel: {
        activeProfileId: '__virtual-working',
        profiles: [
          virtualProfile({ id: '__virtual-working', name: 'Claude (Working)', model: 'claude-sonnet-4-6' }),
        ],
      },
    };

    const choice = decodeRoleChoice('working', settings, DECODE_OPTIONS);
    expect(choice).toEqual({ kind: 'model', modelId: 'claude-sonnet-4-6' });
  });
});
