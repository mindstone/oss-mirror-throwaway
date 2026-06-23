import { describe, expect, it } from 'vitest';

import type { AppSettings, ModelProfile } from '@shared/types';
import { cleanupOrphanedProfileReferences } from '../cleanupOrphanedProfileReferences';

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'kept',
    name: 'Kept profile',
    providerType: 'openai',
    serverUrl: 'https://example.test/v1',
    model: 'gpt-5.5',
    apiKey: 'fake-key',
    createdAt: 1,
    enabled: true,
    ...overrides,
  };
}

type SettingsOverrides = Omit<Partial<AppSettings>, 'models'> & {
  models?: Partial<NonNullable<AppSettings['models']>>;
};

function settings(overrides: SettingsOverrides = {}): AppSettings {
  return {
    models: {},
    ...overrides,
  } as AppSettings;
}

describe('cleanupOrphanedProfileReferences', () => {
  it.each([
    ['workingProfileId', { models: { workingProfileId: 'missing' } }, { models: { workingProfileId: undefined } }],
    ['thinkingProfileId', { models: { thinkingProfileId: 'missing' } }, { models: { thinkingProfileId: undefined } }],
    ['workingFallback', { models: { workingFallback: 'profile:missing' } }, { models: { workingFallback: undefined } }],
    ['thinkingFallback', { models: { thinkingFallback: 'profile:missing' } }, { models: { thinkingFallback: undefined } }],
    ['longContextFallbackProfileId', { models: { longContextFallbackProfileId: 'missing' } }, { models: { longContextFallbackProfileId: undefined } }],
    ['behindTheScenesModel', { behindTheScenesModel: 'profile:missing' }, { behindTheScenesModel: undefined }],
    ['backgroundFallback', { backgroundFallback: 'profile:missing' }, { backgroundFallback: undefined }],
    ['localInferenceCloudFallback', { localInferenceCloudFallback: 'profile:missing' }, { localInferenceCloudFallback: undefined }],
  ] as const)('clears orphaned %s', (_field, input, expected) => {
    expect(cleanupOrphanedProfileReferences(settings(input), [profile()])).toEqual(expected);
  });

  it('clears references to unselectable profiles', () => {
    expect(cleanupOrphanedProfileReferences(
      settings({ models: { workingProfileId: 'disabled' } }),
      [profile({ id: 'disabled', enabled: false })],
    )).toEqual({ models: { workingProfileId: undefined } });
  });

  it('keeps references to selectable profiles and model-prefixed fallbacks', () => {
    expect(cleanupOrphanedProfileReferences(
      settings({
        models: {
          workingProfileId: 'kept',
          thinkingProfileId: 'kept',
          workingFallback: 'model:claude-sonnet-4-6',
          thinkingFallback: 'profile:kept',
          longContextFallbackProfileId: 'kept',
        },
        behindTheScenesModel: 'profile:kept',
        backgroundFallback: 'profile:kept',
        localInferenceCloudFallback: 'profile:kept',
      }),
      [profile()],
    )).toEqual({});
  });
});
