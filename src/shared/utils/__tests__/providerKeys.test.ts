import { describe, it, expect } from 'vitest';
import { getProviderKey, isCodexSubscriptionProfile, normalizeApiKey, resolveProfileApiKey } from '../providerKeys';
import { CODEX_BTS_PROFILE_ID, CODEX_WORKING_PROFILE_ID } from '../codexDefaults';
import type { AppSettings, ModelProfile, ProviderKeys } from '../../types';

describe('normalizeApiKey', () => {
  it('should return null for null input', () => {
    expect(normalizeApiKey(null)).toBeNull();
  });

  it('should return null for undefined input', () => {
    expect(normalizeApiKey(undefined)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(normalizeApiKey('')).toBeNull();
  });

  it('should return null for whitespace-only string', () => {
    expect(normalizeApiKey('   ')).toBeNull();
  });

  it('should trim whitespace and return the key', () => {
    expect(normalizeApiKey('  fake-test-key  ')).toBe('fake-test-key');
  });

  it('should return the key as-is when no trimming is needed', () => {
    expect(normalizeApiKey('fake-test-key')).toBe('fake-test-key');
  });
});

describe('getProviderKey', () => {
  const createSettings = (overrides: {
    providerKeys?: AppSettings['providerKeys'];
    voiceOpenaiApiKey?: string | null;
  } = {}): Pick<AppSettings, 'providerKeys' | 'voice'> => ({
    providerKeys: overrides.providerKeys,
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: overrides.voiceOpenaiApiKey ?? null,
      elevenlabsApiKey: null,
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      ttsVoice: 'nova',
      activationHotkey: null,
      activationHotkeyVoiceMode: true,
    },
  });

  describe('openai provider', () => {
    it('should return providerKeys.openai when set', () => {
      const settings = createSettings({ providerKeys: { openai: 'fake-provider-key' } });
      expect(getProviderKey(settings, 'openai')).toBe('fake-provider-key');
    });

    it('should fall back to voice.openaiApiKey when providerKeys.openai is absent', () => {
      const settings = createSettings({ voiceOpenaiApiKey: 'fake-voice-key' });
      expect(getProviderKey(settings, 'openai')).toBe('fake-voice-key');
    });

    it('should fall back to voice.openaiApiKey when providerKeys.openai is null', () => {
      const settings = createSettings({
        providerKeys: { openai: null },
        voiceOpenaiApiKey: 'fake-voice-key',
      });
      expect(getProviderKey(settings, 'openai')).toBe('fake-voice-key');
    });

    it('should fall back to voice.openaiApiKey when providerKeys.openai is whitespace', () => {
      const settings = createSettings({
        providerKeys: { openai: '   ' },
        voiceOpenaiApiKey: 'fake-voice-key',
      });
      expect(getProviderKey(settings, 'openai')).toBe('fake-voice-key');
    });

    it('should prefer providerKeys.openai over voice.openaiApiKey', () => {
      const settings = createSettings({
        providerKeys: { openai: 'fake-provider-key' },
        voiceOpenaiApiKey: 'fake-voice-key',
      });
      expect(getProviderKey(settings, 'openai')).toBe('fake-provider-key');
    });

    it('should return null when neither source has a key', () => {
      const settings = createSettings({});
      expect(getProviderKey(settings, 'openai')).toBeNull();
    });

    it('should trim providerKeys.openai', () => {
      const settings = createSettings({ providerKeys: { openai: '  fake-trimmed  ' } });
      expect(getProviderKey(settings, 'openai')).toBe('fake-trimmed');
    });
  });

  describe('google provider', () => {
    it('should return providerKeys.google when set', () => {
      const settings = createSettings({ providerKeys: { google: 'AIzaTestKey123' } });
      expect(getProviderKey(settings, 'google')).toBe('AIzaTestKey123');
    });

    it('should return null when providerKeys.google is absent (no legacy fallback)', () => {
      const settings = createSettings({});
      expect(getProviderKey(settings, 'google')).toBeNull();
    });

    it('should return null when providerKeys.google is null', () => {
      const settings = createSettings({ providerKeys: { google: null } });
      expect(getProviderKey(settings, 'google')).toBeNull();
    });

    it('should return null when providerKeys.google is empty string', () => {
      const settings = createSettings({ providerKeys: { google: '' } });
      expect(getProviderKey(settings, 'google')).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle undefined providerKeys gracefully', () => {
      const settings = createSettings({ providerKeys: undefined });
      expect(getProviderKey(settings, 'openai')).toBeNull();
      expect(getProviderKey(settings, 'google')).toBeNull();
    });

    it('should handle empty providerKeys object', () => {
      const settings = createSettings({ providerKeys: {} });
      expect(getProviderKey(settings, 'openai')).toBeNull();
      expect(getProviderKey(settings, 'google')).toBeNull();
    });
  });
});

describe('resolveProfileApiKey', () => {
  const makeProfile = (
    overrides: Partial<Pick<ModelProfile, 'apiKey' | 'providerType' | 'customProviderId'> & { id?: string }> = {}
  ): Pick<ModelProfile, 'apiKey' | 'providerType' | 'customProviderId'> & { id?: string } => ({
    id: overrides.id,
    apiKey: overrides.apiKey,
    providerType: overrides.providerType ?? 'openai',
    customProviderId: overrides.customProviderId,
  });

  describe('profile.apiKey takes precedence', () => {
    it('should return profile.apiKey when set', () => {
      const profile = makeProfile({ apiKey: 'fake-profile-key', providerType: 'openai' });
      const providerKeys: ProviderKeys = { openai: 'fake-provider-key' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBe('fake-profile-key');
    });

    it('should trim whitespace from profile.apiKey', () => {
      const profile = makeProfile({ apiKey: '  fake-trimmed  ', providerType: 'openai' });
      expect(resolveProfileApiKey(profile, undefined)).toBe('fake-trimmed');
    });
  });

  describe('falls back to provider key', () => {
    it('should use providerKeys.openai when profile.apiKey is empty', () => {
      const profile = makeProfile({ apiKey: '', providerType: 'openai' });
      const providerKeys: ProviderKeys = { openai: 'fake-provider-key' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBe('fake-provider-key');
    });

    it('should use providerKeys.openai when profile.apiKey is null-ish', () => {
      const profile = makeProfile({ apiKey: undefined, providerType: 'openai' });
      const providerKeys: ProviderKeys = { openai: 'fake-provider-key' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBe('fake-provider-key');
    });

    it('should use providerKeys.google for google profiles', () => {
      const profile = makeProfile({ providerType: 'google' });
      const providerKeys: ProviderKeys = { google: 'AIza-google-key' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBe('AIza-google-key');
    });

    it('should use providerKeys.together for together profiles', () => {
      const profile = makeProfile({ providerType: 'together' });
      const providerKeys: ProviderKeys = { together: 'tog-key-123' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBe('tog-key-123');
    });

    it('should use providerKeys.cerebras for cerebras profiles', () => {
      const profile = makeProfile({ providerType: 'cerebras' });
      const providerKeys: ProviderKeys = { cerebras: 'csk-key-456' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBe('csk-key-456');
    });
  });

  describe('Codex profile behavior', () => {
    it('should ignore shared provider key for Codex working profile', () => {
      const profile = makeProfile({ id: CODEX_WORKING_PROFILE_ID, providerType: 'openai' });
      const providerKeys: ProviderKeys = { openai: 'fake-provider-key' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBeNull();
    });

    it('should ignore shared provider key for Codex BTS profile', () => {
      const profile = makeProfile({ id: CODEX_BTS_PROFILE_ID, providerType: 'openai' });
      const providerKeys: ProviderKeys = { openai: 'fake-provider-key' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBeNull();
    });

    it('should allow explicit profile.apiKey for Codex profiles', () => {
      const profile = makeProfile({ id: CODEX_WORKING_PROFILE_ID, apiKey: 'fake-profile-key', providerType: 'openai' });
      const providerKeys: ProviderKeys = { openai: 'fake-provider-key' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBe('fake-profile-key');
    });

    it('should not block non-Codex OpenAI profiles from shared key', () => {
      const profile = makeProfile({ id: 'my-custom-openai-profile', providerType: 'openai' });
      const providerKeys: ProviderKeys = { openai: 'fake-provider-key' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBe('fake-provider-key');
    });

    it('returns null for Codex-subscription profile with non-legacy ID (authSource classification path)', () => {
      const profile: ModelProfile = {
        id: 'future-codex-id-abc',
        name: 'Future Codex Profile',
        authSource: 'codex-subscription',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.5',
        createdAt: 0,
      };

      const result = resolveProfileApiKey(profile, { openai: 'fake-openai' });

      expect(result).toBeNull();
    });
  });

  describe('returns null when no key available', () => {
    it('should return null when neither profile.apiKey nor providerKey exists', () => {
      const profile = makeProfile({ providerType: 'openai' });
      expect(resolveProfileApiKey(profile, {})).toBeNull();
    });

    it('should return null for OpenRouter profiles with empty apiKey when provider key is absent', () => {
      const profile = makeProfile({ providerType: 'openrouter', apiKey: '' });
      expect(resolveProfileApiKey(profile, {})).toBeNull();
    });

    it('should return null when providerKeys is undefined', () => {
      const profile = makeProfile({ providerType: 'openai' });
      expect(resolveProfileApiKey(profile, undefined)).toBeNull();
    });

    it('should return null for "other" providerType (no provider key lookup)', () => {
      const profile = makeProfile({ providerType: 'other' });
      const providerKeys: ProviderKeys = { openai: 'fake-key' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBeNull();
    });

    it('should return null when providerType is undefined', () => {
      const profile: Pick<ModelProfile, 'apiKey' | 'providerType'> = {
        apiKey: undefined,
        providerType: undefined,
      };
      const providerKeys: ProviderKeys = { openai: 'fake-key' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle whitespace-only profile.apiKey as empty (falls through)', () => {
      const profile = makeProfile({ apiKey: '   ', providerType: 'openai' });
      const providerKeys: ProviderKeys = { openai: 'fake-provider-key' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBe('fake-provider-key');
    });

    it('should normalize provider key (trim whitespace)', () => {
      const profile = makeProfile({ providerType: 'together' });
      const providerKeys: ProviderKeys = { together: '  tok-spaced  ' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBe('tok-spaced');
    });

    it('should return null when provider key is whitespace-only', () => {
      const profile = makeProfile({ providerType: 'openai' });
      const providerKeys: ProviderKeys = { openai: '   ' };
      expect(resolveProfileApiKey(profile, providerKeys)).toBeNull();
    });
  });
});

describe('isCodexSubscriptionProfile', () => {
  const makeProfile = (
    overrides: Partial<Pick<ModelProfile, 'id' | 'authSource' | 'providerType' | 'apiKey' | 'customProviderId'>> = {}
  ): Pick<ModelProfile, 'id' | 'authSource' | 'providerType' | 'apiKey' | 'customProviderId'> => ({
    id: 'openai-profile',
    authSource: undefined,
    providerType: 'openai',
    apiKey: undefined,
    customProviderId: undefined,
    ...overrides,
  });

  it('returns true for profiles explicitly tagged with codex authSource', () => {
    expect(isCodexSubscriptionProfile(makeProfile({ authSource: 'codex-subscription' }))).toBe(true);
  });

  it('returns true for profiles explicitly tagged with codex authSource even when apiKey is also set', () => {
    expect(
      isCodexSubscriptionProfile(makeProfile({ authSource: 'codex-subscription', apiKey: 'fake-direct-key' }))
    ).toBe(true);
  });

  it('returns true for legacy working Codex profiles without apiKey or custom provider', () => {
    expect(isCodexSubscriptionProfile(makeProfile({ id: CODEX_WORKING_PROFILE_ID }))).toBe(true);
  });

  it('returns true for legacy BTS Codex profiles without apiKey or custom provider', () => {
    expect(isCodexSubscriptionProfile(makeProfile({ id: CODEX_BTS_PROFILE_ID }))).toBe(true);
  });

  it('returns false for legacy Codex IDs when an explicit profile apiKey is present', () => {
    expect(
      isCodexSubscriptionProfile(makeProfile({ id: CODEX_WORKING_PROFILE_ID, apiKey: 'fake-direct-key' }))
    ).toBe(false);
  });

  it('returns false for legacy Codex IDs when a custom provider is attached', () => {
    expect(
      isCodexSubscriptionProfile(makeProfile({ id: CODEX_BTS_PROFILE_ID, customProviderId: 'custom-openai' }))
    ).toBe(false);
  });

  it('returns false for unrelated OpenAI profiles', () => {
    expect(isCodexSubscriptionProfile(makeProfile({ id: 'my-openai-profile' }))).toBe(false);
  });
});
