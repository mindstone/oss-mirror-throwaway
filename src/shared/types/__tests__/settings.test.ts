import { describe, it, expect } from 'vitest';
import { getActiveVoiceProfile, type VoiceSettings } from '../settings';

describe('getActiveVoiceProfile', () => {
  const profileA = {
    id: 'profile-a',
    name: 'Profile A',
    sttBaseUrl: 'https://speech.a.example',
    sttModel: 'whisper-a',
    createdAt: 1,
  };

  const profileB = {
    id: 'profile-b',
    name: 'Profile B',
    sttBaseUrl: 'https://speech.b.example',
    sttModel: 'whisper-b',
    createdAt: 2,
  };

  const createSettings = (overrides: Partial<VoiceSettings> = {}): VoiceSettings => ({
    provider: 'custom-openai',
    openaiApiKey: null,
    elevenlabsApiKey: null,
    model: 'gpt-4o-mini-transcribe-2025-12-15',
    ttsVoice: 'nova',
    activationHotkey: 'CommandOrControl+Shift+Space',
    activationHotkeyVoiceMode: true,
    customProfiles: [profileA, profileB],
    activeCustomProfileId: 'profile-a',
    ...overrides,
  });

  it('returns null when settings are missing', () => {
    expect(getActiveVoiceProfile(undefined)).toBeNull();
  });

  it('returns null when activeCustomProfileId is missing', () => {
    const settings = createSettings({ activeCustomProfileId: null });
    expect(getActiveVoiceProfile(settings)).toBeNull();
  });

  it('returns null when activeCustomProfileId does not match any profile', () => {
    const settings = createSettings({ activeCustomProfileId: 'missing-profile' });
    expect(getActiveVoiceProfile(settings)).toBeNull();
  });

  it('returns the matching profile when activeCustomProfileId exists', () => {
    const settings = createSettings({ activeCustomProfileId: 'profile-b' });
    expect(getActiveVoiceProfile(settings)).toEqual(profileB);
  });

  it('returns null when customProfiles is empty or undefined', () => {
    const emptyProfiles = createSettings({ customProfiles: [], activeCustomProfileId: 'profile-a' });
    const undefinedProfiles = createSettings({ customProfiles: undefined, activeCustomProfileId: 'profile-a' });

    expect(getActiveVoiceProfile(emptyProfiles)).toBeNull();
    expect(getActiveVoiceProfile(undefinedProfiles)).toBeNull();
  });
});
