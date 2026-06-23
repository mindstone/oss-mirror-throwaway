import { describe, expect, it } from 'vitest';
import { settingsChannels } from '../../channels/settings';
import type { AppSettings } from '@shared/types';

function makeSettings(profile: Record<string, unknown>): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
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
    claude: {
      apiKey: null,
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: true,
      thinkingEffort: 'high',
    },
    models: {
      apiKey: null,
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: true,
      thinkingEffort: 'high',
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    localModel: {
      activeProfileId: null,
      profiles: [
        {
          id: 'connection-anthropic',
          name: 'Anthropic / Claude Sonnet',
          providerType: 'anthropic',
          serverUrl: 'https://api.anthropic.com/v1',
          model: 'claude-sonnet-4-6',
          createdAt: 1,
          ...profile,
        },
      ],
    },
  } as AppSettings;
}

describe('settings:update ModelProfile profileSource schema', () => {
  it('round-trips connection profileSource and forward-compatible profile fields', () => {
    const parsed = settingsChannels['settings:update'].request.parse(
      makeSettings({
        profileSource: 'connection',
        futureProfileField: 'kept-by-passthrough',
      }),
    );

    const profile = parsed.localModel?.profiles[0] as NonNullable<AppSettings['localModel']>['profiles'][number] & {
      futureProfileField?: unknown;
    };
    expect(profile.providerType).toBe('anthropic');
    expect(profile.profileSource).toBe('connection');
    expect(profile.futureProfileField).toBe('kept-by-passthrough');
  });

  it('accepts legacy profiles without profileSource and does not default it during parse', () => {
    const parsed = settingsChannels['settings:update'].request.parse(makeSettings({}));

    const profile = parsed.localModel?.profiles[0];
    expect(profile?.providerType).toBe('anthropic');
    expect(profile?.profileSource).toBeUndefined();
  });

  it.each([
    ['invalid enum value', 'invalid_value'],
    ['empty string', ''],
    ['null', null],
  ] as const)('rejects %s profileSource values', (_label, profileSource) => {
    const result = settingsChannels['settings:update'].request.safeParse(
      makeSettings({ profileSource }),
    );

    expect(result.success).toBe(false);
  });
});
