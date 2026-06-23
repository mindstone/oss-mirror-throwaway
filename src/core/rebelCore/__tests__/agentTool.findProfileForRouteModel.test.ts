/**
 * Selectability gate coverage for `findSelectableProfileForModel`.
 *
 * Stage 2 (260503_unify_learned_limits_into_profiles.md) — Phase 6 cycle 3,
 * DO-NOW 3. The explicit `profile:<id>` branch must apply the same
 * `isProfileSelectable` + enabled gates as the model-string branch so an
 * incomplete auto-learned stub (no serverUrl) is never routed to.
 */
import { describe, expect, it } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import { findSelectableProfileForModel } from '../agentTool';

function withProfiles(profiles: ModelProfile[]): AppSettings {
  return {
    coreDirectory: null,
    localModel: { profiles, activeProfileId: null },
  } as unknown as AppSettings;
}

const baseProfile: Omit<ModelProfile, 'id'> = {
  name: 'P',
  model: 'gpt-test',
  providerType: 'other',
  serverUrl: 'https://example.test',
  enabled: true,
  routingEligible: true,
  createdAt: 1,
};

describe('findSelectableProfileForModel — selectability gate (DO-NOW 3, cycle 3)', () => {
  it('skips an incomplete auto stub on explicit profile:<id> lookup', () => {
    const stub: ModelProfile = {
      ...baseProfile,
      id: 'profile-x',
      serverUrl: '', // incomplete — auto-created stub
    };
    const settings = withProfiles([stub]);
    expect(findSelectableProfileForModel(settings, 'profile:profile-x')).toBeNull();
  });

  it('skips a disabled profile on explicit profile:<id> lookup', () => {
    const profile: ModelProfile = {
      ...baseProfile,
      id: 'profile-x',
      enabled: false,
    };
    const settings = withProfiles([profile]);
    expect(findSelectableProfileForModel(settings, 'profile:profile-x')).toBeNull();
  });

  it('returns a selectable enabled profile on explicit profile:<id> lookup', () => {
    const profile: ModelProfile = {
      ...baseProfile,
      id: 'profile-x',
    };
    const settings = withProfiles([profile]);
    expect(findSelectableProfileForModel(settings, 'profile:profile-x')).toBe(profile);
  });

  it('skips an incomplete profile on model-string lookup (existing gate, regression check)', () => {
    const stub: ModelProfile = {
      ...baseProfile,
      id: 'profile-x',
      serverUrl: '',
    };
    const settings = withProfiles([stub]);
    expect(findSelectableProfileForModel(settings, 'gpt-test')).toBeNull();
  });
});
