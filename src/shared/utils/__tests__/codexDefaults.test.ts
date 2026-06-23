import { describe, expect, it } from 'vitest';
import {
  applyCodexModelDefaults,
  CODEX_BTS_PROFILE_ID,
  CODEX_DEFAULT_MODEL,
  CODEX_WORKING_PROFILE_ID,
  isCodexAutoProfile,
  isCodexAutoProfileValue,
  mergeCodexProfiles,
  resolveStaleModelHintText,
} from '../codexDefaults';
import type { AppSettings, ModelProfile, ModelSettings } from '../../types';

type SettingsOverrides = Partial<Omit<AppSettings, 'claude' | 'models'>> & {
  claude?: Partial<ModelSettings>;
  models?: Partial<ModelSettings>;
};

const makeSettings = (overrides: SettingsOverrides = {}): AppSettings => {
  const { claude: claudeOverrides, models: modelsOverrides, ...rootOverrides } = overrides;
  const baseModels: ModelSettings = {
    apiKey: null,
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-6',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
  };

  return {
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
    ...rootOverrides,
  };
};

describe('applyCodexModelDefaults', () => {
  it('tags both generated Codex profiles with codex-subscription authSource', () => {
    const result = applyCodexModelDefaults(makeSettings());
    const profiles = result.localModel?.profiles ?? [];

    expect(profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: CODEX_WORKING_PROFILE_ID,
          authSource: 'codex-subscription',
          providerType: 'openai',
          profileSource: 'auto',
        }),
        expect.objectContaining({
          id: CODEX_BTS_PROFILE_ID,
          authSource: 'codex-subscription',
          providerType: 'openai',
          profileSource: 'auto',
        }),
      ]),
    );
  });

  it('keeps Codex auto-profile stamping idempotent on rerun', () => {
    const first = applyCodexModelDefaults(makeSettings());
    const second = applyCodexModelDefaults(makeSettings(first));
    const profiles = second.localModel?.profiles ?? [];

    expect(profiles.filter((profile) => profile.id === CODEX_WORKING_PROFILE_ID)).toHaveLength(1);
    expect(profiles.filter((profile) => profile.id === CODEX_BTS_PROFILE_ID)).toHaveLength(1);
    expect(profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: CODEX_WORKING_PROFILE_ID, profileSource: 'auto' }),
        expect.objectContaining({ id: CODEX_BTS_PROFILE_ID, profileSource: 'auto' }),
      ]),
    );
  });

  it('does not stamp non-Codex-ID profiles that share the Codex provider tuple', () => {
    const sharedTupleUserProfile: ModelProfile = {
      id: 'user-codex-shared-tuple',
      name: 'User Codex tuple',
      authSource: 'codex-subscription',
      providerType: 'openai',
      model: CODEX_DEFAULT_MODEL,
      serverUrl: 'https://api.openai.com/v1',
      createdAt: 123,
    };

    const profiles = mergeCodexProfiles([sharedTupleUserProfile]);
    const preservedProfile = profiles.find((profile) => profile.id === sharedTupleUserProfile.id);

    expect(preservedProfile).toMatchObject(sharedTupleUserProfile);
    expect(preservedProfile?.profileSource).toBeUndefined();
  });

  it('strips persisted capability flags from auto profiles when merging (A4)', () => {
    const staleAutoProfile: ModelProfile = {
      id: CODEX_BTS_PROFILE_ID,
      name: 'GPT-5.4 mini (ChatGPT Pro)',
      authSource: 'codex-subscription',
      providerType: 'openai',
      model: 'gpt-5.4-mini',
      serverUrl: 'https://api.openai.com/v1',
      createdAt: 0,
      jsonCompatibility: 'incompatible',
      jsonCompatibilityCheckedAt: '2026-05-07T18:14:41.861Z',
      chatCompatibility: 'incompatible',
      toolUseCompatibility: 'incompatible',
    };

    const profiles = mergeCodexProfiles([staleAutoProfile]);
    const merged = profiles.find((profile) => profile.id === CODEX_BTS_PROFILE_ID);

    expect(merged).toBeDefined();
    expect(merged?.jsonCompatibility).toBeUndefined();
    expect(merged?.jsonCompatibilityCheckedAt).toBeUndefined();
    expect(merged?.chatCompatibility).toBeUndefined();
    expect(merged?.toolUseCompatibility).toBeUndefined();
  });

  it('preserves capability flags on non-auto user / connection profiles when merging', () => {
    const userProfile: ModelProfile = {
      id: 'user-1',
      name: 'My local model',
      providerType: 'local',
      profileSource: 'user',
      model: 'mistral-small',
      serverUrl: 'http://localhost:11434',
      createdAt: 1_700_000_000_000,
      jsonCompatibility: 'incompatible',
    };

    const profiles = mergeCodexProfiles([userProfile]);
    const userAfter = profiles.find((profile) => profile.id === 'user-1');

    expect(userAfter?.jsonCompatibility).toBe('incompatible');
  });

  it('exports the default Codex working model for migration callers', () => {
    expect(CODEX_DEFAULT_MODEL).toBe('gpt-5.5');
  });

  it('returns only Codex structural fields and leaves tier defaults to providerSwitch', () => {
    const result = applyCodexModelDefaults(makeSettings());

    expect(result.claude).toBeUndefined();
    expect(result.activeProvider).toBeUndefined();
    expect(result.behindTheScenesModel).toBeUndefined();
    expect(result.openRouter).toBeUndefined();
  });
});

describe('isCodexAutoProfile', () => {
  it('returns true for CODEX_WORKING_PROFILE_ID', () => {
    expect(isCodexAutoProfile({ id: CODEX_WORKING_PROFILE_ID })).toBe(true);
  });

  it('returns true for CODEX_BTS_PROFILE_ID', () => {
    expect(isCodexAutoProfile({ id: CODEX_BTS_PROFILE_ID })).toBe(true);
  });

  it('returns false for unrelated profile IDs', () => {
    expect(isCodexAutoProfile({ id: 'custom-openai-profile' })).toBe(false);
  });
});

describe('isCodexAutoProfileValue', () => {
  it('returns true for profile:<CODEX_WORKING_PROFILE_ID>', () => {
    expect(isCodexAutoProfileValue(`profile:${CODEX_WORKING_PROFILE_ID}`)).toBe(true);
    expect(isCodexAutoProfileValue('profile:custom-abc')).toBe(false);
    expect(isCodexAutoProfileValue('gpt-5.5')).toBe(false);
    expect(isCodexAutoProfileValue('')).toBe(false);
  });
});

describe('resolveStaleModelHintText', () => {
  it('returns Codex copy for Codex auto-profile values', () => {
    expect(resolveStaleModelHintText(`profile:${CODEX_WORKING_PROFILE_ID}`)).toBe(
      'Previous model hidden — reconnect ChatGPT Pro or pick another'
    );
  });

  it('returns generic copy for non-Codex hidden values (OR-format, bare gpt-*)', () => {
    expect(resolveStaleModelHintText('openai/gpt-5.4-mini')).toBe(
      'Previous model no longer available for current provider'
    );
    expect(resolveStaleModelHintText('gpt-5.4-mini')).toBe(
      'Previous model no longer available for current provider'
    );
  });
});
