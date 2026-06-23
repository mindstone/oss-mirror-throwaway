import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@shared/types';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import {
  __markProfileChatIncompatibleForTesting,
  __markProfileJsonIncompatibleForTesting,
} from '../behindTheScenesClient';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makeSettings(profile: AppSettings['localModel'] extends { profiles?: Array<infer P> | undefined } ? P : never): AppSettings {
  return {
    claude: { apiKey: 'fake-test' },
    localModel: { profiles: [profile], activeProfileId: null },
  } as unknown as AppSettings;
}

describe('behindTheScenesClient marker guards (260521 BTS Haiku-fallback A0)', () => {
  let settings: AppSettings;
  beforeEach(() => {
    vi.clearAllMocks();
    settings = {} as AppSettings;
    setSettingsStoreAdapter({
      getSettings: () => settings,
      updateSettings: (partial) => {
        settings = { ...settings, ...partial };
      },
      updateSettingsAtomic: (updater) => {
        settings = { ...settings, ...updater(settings) };
      },
    });
  });

  it('SKIPS jsonCompatibility marker on Codex auto-managed profiles (id starts with codex-)', () => {
    settings = makeSettings({
      id: 'codex-gpt-5.4-mini',
      name: 'GPT-5.4 mini (ChatGPT Pro)',
      providerType: 'openai',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      profileSource: 'auto',
      authSource: 'codex-subscription',
      createdAt: Date.now(),
    } as never);

    __markProfileJsonIncompatibleForTesting('codex-gpt-5.4-mini');

    expect(settings.localModel?.profiles?.[0]?.jsonCompatibility).toBeUndefined();
    expect(settings.localModel?.profiles?.[0]?.jsonCompatibilityCheckedAt).toBeUndefined();
  });

  it('SKIPS chatCompatibility marker on Codex auto-managed profiles (id starts with codex-)', () => {
    settings = makeSettings({
      id: 'codex-gpt-5.4-mini',
      name: 'GPT-5.4 mini (ChatGPT Pro)',
      providerType: 'openai',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      profileSource: 'auto',
      authSource: 'codex-subscription',
      createdAt: Date.now(),
    } as never);

    __markProfileChatIncompatibleForTesting('codex-gpt-5.4-mini');

    expect(settings.localModel?.profiles?.[0]?.chatCompatibility).toBeUndefined();
  });

  it('STILL marks user / connection-managed profiles (regression guard)', () => {
    settings = makeSettings({
      id: 'profile-user-1',
      name: 'My Profile',
      providerType: 'openai',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      createdAt: Date.now(),
    } as never);

    __markProfileJsonIncompatibleForTesting('profile-user-1');

    expect(settings.localModel?.profiles?.[0]?.jsonCompatibility).toBe('incompatible');
    expect(settings.localModel?.profiles?.[0]?.jsonCompatibilityCheckedAt).toBeTruthy();
  });

  it('STILL marks chatCompatibility on user profiles (regression guard)', () => {
    settings = makeSettings({
      id: 'profile-user-1',
      name: 'My Profile',
      providerType: 'openai',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      createdAt: Date.now(),
    } as never);

    __markProfileChatIncompatibleForTesting('profile-user-1');

    expect(settings.localModel?.profiles?.[0]?.chatCompatibility).toBe('incompatible');
  });
});
