import { describe, expect, it } from 'vitest';
import { scrubAppSettingsSecretsForBackup } from '../appSettingsSecretScrub';

describe('scrubAppSettingsSecretsForBackup', () => {
  it('blanks every secret-bearing field across the settings tree (F1)', () => {
    const settings = {
      // Previously-covered
      providerKeys: { openai: 'fake-openai-secret', anthropic: 'fake-ant-secret' },
      claude: {
        apiKey: 'fake-claude-secret',
        oauthToken: 'oauth-claude-token',
        oauthRefreshToken: 'oauth-claude-refresh',
        authMethod: 'api-key',
      },
      customProviders: [
        { name: 'p1', apiKey: 'fake-custom-1' },
        { name: 'p2', apiKey: 'fake-custom-2' },
      ],
      // Previously-LEAKED fields (the F1 gap):
      voice: {
        openaiApiKey: 'fake-voice-openai',
        elevenlabsApiKey: 'el-voice-key',
        customProfiles: [{ id: 'a', apiKey: 'fake-voice-profile' }],
      },
      models: {
        apiKey: 'fake-models-key',
        oauthToken: 'models-oauth',
        oauthRefreshToken: 'models-oauth-refresh',
      },
      openRouter: { oauthToken: 'or-oauth', oauthRefreshToken: 'or-refresh' },
      googleWorkspace: { clientSecret: 'gw-secret' },
      hubspot: { clientSecret: 'hs-secret' },
      salesforce: { clientSecret: 'sf-secret' },
      outreach: { clientSecret: 'or-client-secret' },
      gamma: { apiKey: 'gamma-key' },
      meetingBot: {
        firefliesApiKey: 'ff-key',
        fathomApiKey: 'fa-key',
        recallApiKey: 're-key',
      },
      localModel: { profiles: [{ id: 'x', apiKey: 'fake-local-profile' }] },
      cloudToken: 'cloud-token-secret',
    };

    const scrubbed = scrubAppSettingsSecretsForBackup(settings);
    const flat = JSON.stringify(scrubbed);

    // None of the secret values survive anywhere.
    const leakedValues = [
      'fake-openai-secret', 'fake-ant-secret', 'fake-claude-secret', 'oauth-claude-token',
      'oauth-claude-refresh', 'fake-custom-1', 'fake-custom-2', 'fake-voice-openai',
      'el-voice-key', 'fake-voice-profile', 'fake-models-key', 'models-oauth',
      'models-oauth-refresh', 'or-oauth', 'or-refresh', 'gw-secret', 'hs-secret',
      'sf-secret', 'or-client-secret', 'gamma-key', 'ff-key', 'fa-key', 're-key',
      'fake-local-profile', 'cloud-token-secret',
    ];
    for (const value of leakedValues) {
      expect(flat).not.toContain(value);
    }

    // Spot-check a few that the keys are blanked, not dropped.
    // `providerKeys` matches `^providerKeys$` so the whole map is blanked.
    expect(scrubbed.providerKeys).toBe('');
    expect(scrubbed.voice.openaiApiKey).toBe('');
    expect(scrubbed.voice.customProfiles[0].apiKey).toBe('');
    expect(scrubbed.models.oauthRefreshToken).toBe('');
    expect(scrubbed.meetingBot.firefliesApiKey).toBe('');
    expect(scrubbed.localModel.profiles[0].apiKey).toBe('');
    expect(scrubbed.cloudToken).toBe('');
  });

  it('preserves non-secret fields and nesting structure (no over-strip)', () => {
    const settings = {
      theme: 'dark',
      providerKeys: { openai: 'fake-secret' },
      claude: { apiKey: 'fake-secret', authMethod: 'api-key', model: 'opus' },
      voice: { enabled: true, customProfiles: [{ id: 'a', name: 'Voice A', apiKey: 's' }] },
      nested: { deep: { value: 42, list: [1, 2, 3] } },
      customProviders: [{ name: 'p1', baseUrl: 'https://x', apiKey: 'sk' }],
    };

    const scrubbed = scrubAppSettingsSecretsForBackup(settings);

    expect(scrubbed.theme).toBe('dark');
    expect(scrubbed.claude.authMethod).toBe('api-key');
    expect(scrubbed.claude.model).toBe('opus');
    expect(scrubbed.voice.enabled).toBe(true);
    expect(scrubbed.voice.customProfiles[0].id).toBe('a');
    expect(scrubbed.voice.customProfiles[0].name).toBe('Voice A');
    expect(scrubbed.nested).toEqual({ deep: { value: 42, list: [1, 2, 3] } });
    expect(scrubbed.customProviders[0].name).toBe('p1');
    expect(scrubbed.customProviders[0].baseUrl).toBe('https://x');
    // Original input is not mutated (operates on a deep clone).
    expect(settings.providerKeys.openai).toBe('fake-secret');
  });

  it('returns non-record inputs unchanged', () => {
    expect(scrubAppSettingsSecretsForBackup(null)).toBe(null);
    expect(scrubAppSettingsSecretsForBackup('x')).toBe('x');
    expect(scrubAppSettingsSecretsForBackup(5)).toBe(5);
  });
});
