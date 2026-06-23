import { describe, expect, it } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import {
  assessCouncilEligibility,
  filterCouncilProfilesForManagedMode,
  getCouncilProfiles,
  isCouncilReviewAvailable,
  type ManagedAllowListState,
} from '../councilProfiles';

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'profile-default',
    name: 'Profile Default',
    serverUrl: 'https://example.com/v1',
    model: 'openai/gpt-5.5',
    providerType: 'openai',
    createdAt: 1,
    councilEnabled: true,
    routingEligible: true,
    enabled: true,
    ...overrides,
  };
}

function makeSettings(
  overrides: Partial<Omit<AppSettings, 'localModel'>> & {
    localModel?: Partial<AppSettings['localModel']>;
  } = {},
): AppSettings {
  const { localModel, ...rest } = overrides;
  return {
    activeProvider: 'mindstone',
    models: { apiKey: null } as AppSettings['models'],
    claude: { apiKey: null } as AppSettings['claude'],
    ...rest,
    localModel: {
      activeProfileId: null,
      profiles: [],
      ...(localModel ?? {}),
    } as AppSettings['localModel'],
  } as AppSettings;
}

describe('councilProfiles managed eligibility', () => {
  it('keeps managed profile when model is in allow-list', () => {
    const settings = makeSettings({
      localModel: { profiles: [makeProfile({ model: 'openai/gpt-5.5' })] },
    });
    const profiles = getCouncilProfiles(settings);

    const result = assessCouncilEligibility(profiles, settings, {
      kind: 'ready',
      allowed: ['openai/gpt-5.5'],
    });

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.kept).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('keeps anthropic-routed profile via BYOK when not in allow-list', () => {
    const settings = makeSettings({
      models: { apiKey: 'fake-anthropic-personal-key' } as AppSettings['models'],
      localModel: {
        profiles: [makeProfile({ providerType: 'anthropic', model: 'claude-sonnet-4-5' })],
      },
    });
    const profiles = getCouncilProfiles(settings);

    const result = assessCouncilEligibility(profiles, settings, {
      kind: 'ready',
      allowed: ['openai/gpt-5.5'],
    });

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.kept).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('skips anthropic-routed profile with no BYOK key when not in allow-list', () => {
    const settings = makeSettings({
      models: { apiKey: null } as AppSettings['models'],
      localModel: {
        profiles: [makeProfile({ providerType: 'anthropic', model: 'claude-sonnet-4-5' })],
      },
    });
    const profiles = getCouncilProfiles(settings);

    const result = filterCouncilProfilesForManagedMode(profiles, settings, {
      kind: 'ready',
      allowed: ['openai/gpt-5.5'],
    });

    expect(result.kept).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('no-byok-credential');
  });

  it('skips OpenRouter-routed profile even with OpenRouter OAuth token when not in allow-list', () => {
    const settings = makeSettings({
      openRouter: { oauthToken: 'or-oauth-token' } as AppSettings['openRouter'],
      localModel: {
        profiles: [makeProfile({ providerType: 'openrouter', model: 'openai/gpt-5.5' })],
      },
    });
    const profiles = getCouncilProfiles(settings);

    const result = filterCouncilProfilesForManagedMode(profiles, settings, {
      kind: 'ready',
      allowed: ['openai/gpt-5.2'],
    });

    expect(result.kept).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('not-in-managed-allowlist');
  });

  it('blocks council when managed allow-list is empty and no member survives', () => {
    const settings = makeSettings({
      localModel: { profiles: [makeProfile({ providerType: 'openai', model: 'openai/gpt-5.5' })] },
    });
    const profiles = getCouncilProfiles(settings);
    const allowList: ManagedAllowListState = { kind: 'empty' };

    const result = assessCouncilEligibility(profiles, settings, allowList);

    expect(result).toEqual({
      kind: 'blocked',
      reason: 'no-eligible-members',
      candidateCount: 1,
      hadAnthropicKey: false,
    });
  });

  it('passes through council profiles when managed allow-list is unavailable', () => {
    const settings = makeSettings({
      localModel: { profiles: [makeProfile({ model: 'openai/gpt-5.5' })] },
    });
    const profiles = getCouncilProfiles(settings);

    const result = assessCouncilEligibility(profiles, settings, { kind: 'unavailable' });

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.kept).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('passes through council profiles for non-managed providers regardless of allow-list', () => {
    const settings = makeSettings({
      activeProvider: 'openrouter',
      localModel: { profiles: [makeProfile({ model: 'openai/gpt-5.5' })] },
    });
    const profiles = getCouncilProfiles(settings);

    const result = assessCouncilEligibility(profiles, settings, {
      kind: 'ready',
      allowed: ['openai/gpt-5.2'],
    });

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.kept).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('reports council unavailable when no council profiles are configured', () => {
    const settings = makeSettings({
      localModel: { profiles: [makeProfile({ councilEnabled: false })] },
    });

    expect(isCouncilReviewAvailable(settings)).toBe(false);
  });
});
