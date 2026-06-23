import { describe, expect, it } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import { createProfileConnectivity } from '@shared/utils/connectivityHelpers';
import { resolveModelRoles } from '../useModelRoles';

function makeConnectionProfile(): ModelProfile {
  return {
    id: 'profile-codex',
    name: 'ChatGPT Pro GPT 5.5',
    providerType: 'openai',
    routeSurface: 'subscription',
    authSource: 'codex-subscription',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    createdAt: 1,
    enabled: true,
    profileSource: 'connection',
  };
}

describe('resolveModelRoles', () => {
  it('reports reconnect guidance for a disconnected connection-managed role without marking it active custom', () => {
    const profile = makeConnectionProfile();
    const settings = {
      coreDirectory: '/tmp/rebel',
      models: { workingProfileId: profile.id },
      localModel: { activeProfileId: null, profiles: [profile] },
    } as AppSettings;

    const roles = resolveModelRoles(
      settings,
      [profile],
      createProfileConnectivity({ codexConnected: false }),
    );

    expect(roles.working.modelName).toBe('Reconnect ChatGPT Pro to use this role.');
    expect(roles.working.isCustom).toBe(false);
    expect(roles.hasAnyCustom).toBe(false);
  });

  it('shows the active fallback model name when the selected working profile is unavailable', () => {
    const profile: ModelProfile = {
      id: 'broken-working',
      name: 'Broken working profile',
      providerType: 'openai',
      serverUrl: '',
      model: 'gpt-5.5',
      apiKey: 'fake',
      createdAt: 1,
      enabled: true,
    };
    const settings = {
      coreDirectory: '/tmp/rebel',
      activeProvider: 'anthropic',
      models: {
        model: 'claude-sonnet-4-6',
        workingProfileId: profile.id,
      },
      localModel: { activeProfileId: null, profiles: [profile] },
    } as AppSettings;

    const roles = resolveModelRoles(settings, [profile]);

    expect(roles.working.modelName).toBe('Sonnet 4.6');
    expect(roles.working.isCustom).toBe(false);
    expect(roles.hasAnyCustom).toBe(false);
  });
});
