import { describe, expect, it } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import { getRoutingEligibleProfiles } from '../routingProfiles';

/**
 * Builds a fully routing-eligible profile (passes every filter in
 * {@link getRoutingEligibleProfiles}). Tests override one field at a time to
 * assert each filter excludes in isolation.
 *
 * Defaults: anthropic profiles are always `isProfileSelectable` (no serverUrl
 * needed), so the baseline avoids depending on serverUrl semantics.
 */
function makeEligibleProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'eligible',
    name: 'Eligible profile',
    providerType: 'anthropic',
    serverUrl: '',
    model: 'claude-sonnet-4-6',
    createdAt: 1,
    routingEligible: true,
    ...overrides,
  } as ModelProfile;
}

function makeSettings(profiles: ModelProfile[]): AppSettings {
  return {
    coreDirectory: '/tmp/rebel',
    localModel: { activeProfileId: null, profiles },
  } as AppSettings;
}

describe('getRoutingEligibleProfiles', () => {
  it('includes a fully-eligible profile', () => {
    const profile = makeEligibleProfile({ id: 'ok' });
    const result = getRoutingEligibleProfiles(makeSettings([profile]));
    expect(result.map((p) => p.id)).toEqual(['ok']);
  });

  it('excludes a profile with routingEligible === false', () => {
    const profile = makeEligibleProfile({ id: 'not-eligible', routingEligible: false });
    expect(getRoutingEligibleProfiles(makeSettings([profile]))).toEqual([]);
  });

  it('excludes a profile with routingEligible missing', () => {
    const profile = makeEligibleProfile({ id: 'missing-flag' });
    delete (profile as Partial<ModelProfile>).routingEligible;
    expect(getRoutingEligibleProfiles(makeSettings([profile]))).toEqual([]);
  });

  it('excludes a profile with enabled === false', () => {
    const profile = makeEligibleProfile({ id: 'disabled', enabled: false });
    expect(getRoutingEligibleProfiles(makeSettings([profile]))).toEqual([]);
  });

  it('includes a profile with enabled === true (only enabled === false excludes)', () => {
    const profile = makeEligibleProfile({ id: 'enabled-true', enabled: true });
    expect(getRoutingEligibleProfiles(makeSettings([profile])).map((p) => p.id)).toEqual([
      'enabled-true',
    ]);
  });

  it('excludes a profile with a missing model', () => {
    const profile = makeEligibleProfile({ id: 'no-model', model: '' });
    expect(getRoutingEligibleProfiles(makeSettings([profile]))).toEqual([]);
  });

  it('excludes a non-anthropic profile that is not selectable (no serverUrl)', () => {
    // isProfileSelectable: non-anthropic requires a non-empty serverUrl.
    const profile = makeEligibleProfile({
      id: 'not-selectable',
      providerType: 'openrouter',
      serverUrl: '',
    });
    expect(getRoutingEligibleProfiles(makeSettings([profile]))).toEqual([]);
  });

  it('includes a non-anthropic profile once it is selectable (serverUrl set)', () => {
    const profile = makeEligibleProfile({
      id: 'selectable',
      providerType: 'openrouter',
      serverUrl: 'https://example.com/v1',
    });
    expect(getRoutingEligibleProfiles(makeSettings([profile])).map((p) => p.id)).toEqual([
      'selectable',
    ]);
  });

  it('returns an empty list when there are no profiles', () => {
    expect(getRoutingEligibleProfiles(makeSettings([]))).toEqual([]);
  });

  it('keeps only the eligible profiles from a mixed list', () => {
    const profiles = [
      makeEligibleProfile({ id: 'keep-a' }),
      makeEligibleProfile({ id: 'drop-disabled', enabled: false }),
      makeEligibleProfile({ id: 'drop-no-model', model: '' }),
      makeEligibleProfile({ id: 'keep-b' }),
    ];
    expect(getRoutingEligibleProfiles(makeSettings(profiles)).map((p) => p.id)).toEqual([
      'keep-a',
      'keep-b',
    ]);
  });
});
