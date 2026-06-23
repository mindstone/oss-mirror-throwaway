import { describe, expect, it } from 'vitest';
import type { AppSettings, ModelProfile, ModelProfileSource, ModelProviderType, RouteSurface } from '@shared/types';
import {
  createProfileConnectivity,
  getFunctionalCouncilProfiles,
  getFunctionalRoutingProfiles,
  getProfileConnectivityStateFromSettings,
  isConnectionLive,
  type ProfileConnectivityState,
} from '../connectivityHelpers';

const providerCases: Array<{
  providerType: ModelProviderType;
  routeSurface: RouteSurface;
  liveState: ProfileConnectivityState;
  deadState: ProfileConnectivityState;
}> = [
  {
    providerType: 'openai',
    routeSurface: 'subscription',
    liveState: { codexConnected: true },
    deadState: { codexConnected: false },
  },
  {
    providerType: 'anthropic',
    routeSurface: 'api-key',
    liveState: { hasAnthropicAuth: true },
    deadState: { hasAnthropicAuth: false },
  },
  {
    providerType: 'google',
    routeSurface: 'api-key',
    liveState: { hasGeminiAuth: true },
    deadState: { hasGeminiAuth: false },
  },
  {
    providerType: 'openrouter',
    routeSurface: 'pool',
    liveState: { openRouterConnected: true },
    deadState: { openRouterConnected: false },
  },
];

function makeProfile(
  providerType: ModelProviderType,
  routeSurface: RouteSurface,
  profileSource: ModelProfileSource | undefined,
  overrides: Partial<ModelProfile> = {},
): ModelProfile {
  return {
    id: `${providerType}-${routeSurface}-${profileSource ?? 'legacy'}`,
    name: `${providerType} profile`,
    providerType,
    routeSurface,
    ...(routeSurface === 'subscription' ? { authSource: 'codex-subscription' as const } : {}),
    serverUrl: providerType === 'anthropic' ? '' : 'https://example.com/v1',
    model: `${providerType}-model`,
    createdAt: 1,
    routingEligible: true,
    councilEnabled: true,
    ...(profileSource ? { profileSource } : {}),
    ...overrides,
  };
}

function makeSettings(profiles: ModelProfile[]): AppSettings {
  return {
    coreDirectory: '/tmp/rebel',
    localModel: { activeProfileId: null, profiles },
  } as AppSettings;
}

describe('connectivity helpers', () => {
  it.each(
    providerCases.flatMap(({ providerType, routeSurface, liveState, deadState }) =>
      ([true, false] as const).flatMap((live) =>
        ([undefined, 'user', 'connection', 'auto'] as const).map((profileSource) => ({
          providerType,
          routeSurface,
          profileSource,
          live,
          state: live ? liveState : deadState,
        })),
      ),
    ),
  )(
    'reports $providerType/$routeSurface source=$profileSource live=$live',
    ({ providerType, routeSurface, profileSource, live, state }) => {
      const profile = makeProfile(providerType, routeSurface, profileSource);
      const connectivity = createProfileConnectivity(state);
      const expected = profileSource === 'connection' || profileSource === 'auto'
        ? live
        : true;

      expect(isConnectionLive(profile, connectivity)).toBe(expected);
    },
  );

  it('fails open when connectivity is absent', () => {
    const profile = makeProfile('openai', 'subscription', 'connection');
    expect(isConnectionLive(profile, undefined)).toBe(true);
  });

  it('filters disconnected connection-managed routing profiles', () => {
    const liveUser = makeProfile('anthropic', 'api-key', 'user', { id: 'user' });
    const liveConnection = makeProfile('openrouter', 'pool', 'connection', { id: 'openrouter-live' });
    const deadConnection = makeProfile('openai', 'subscription', 'connection', { id: 'codex-dead' });
    const settings = makeSettings([liveUser, liveConnection, deadConnection]);

    const result = getFunctionalRoutingProfiles(
      settings,
      createProfileConnectivity({
        hasAnthropicAuth: true,
        openRouterConnected: true,
        codexConnected: false,
      }),
    );

    expect(result.map((profile) => profile.id)).toEqual(['user', 'openrouter-live']);
  });

  it('filters disconnected connection-managed council profiles', () => {
    const liveConnection = makeProfile('google', 'api-key', 'connection', { id: 'gemini-live' });
    const deadConnection = makeProfile('openrouter', 'pool', 'auto', { id: 'openrouter-dead' });
    const disabled = makeProfile('anthropic', 'api-key', 'connection', {
      id: 'disabled',
      enabled: false,
    });
    const settings = makeSettings([liveConnection, deadConnection, disabled]);

    const result = getFunctionalCouncilProfiles(
      settings,
      createProfileConnectivity({
        hasGeminiAuth: true,
        openRouterConnected: false,
        hasAnthropicAuth: true,
      }),
    );

    expect(result.map((profile) => profile.id)).toEqual(['gemini-live']);
  });

  it('derives provider connectivity from settings in one place', () => {
    const state = getProfileConnectivityStateFromSettings({
      coreDirectory: '/tmp/rebel',
      models: { apiKey: ' fake-anthropic ' },
      localModel: { activeProfileId: null, profiles: [] },
      openRouter: { oauthToken: 'fake-or-token', enabled: true },
      providerKeys: {
        google: 'fake-google',
        openai: 'fake-openai',
      },
    } as unknown as AppSettings, { codexConnected: true });

    expect(state).toEqual({
      codexConnected: true,
      openRouterConnected: true,
      hasAnthropicAuth: true,
      hasGeminiAuth: true,
      hasOpenAiAuth: true,
    });
  });
});
