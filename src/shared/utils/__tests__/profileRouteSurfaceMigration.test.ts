import { describe, expect, it } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types/settings';
import { deriveRouteSurfaceForProfile, migrateProfileRouteSurfaces } from '../profileRouteSurfaceMigration';

const baseProfile = (overrides: Partial<ModelProfile>): ModelProfile => ({
  id: 'profile-id',
  name: 'Profile',
  model: 'claude-sonnet-4-6',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  createdAt: Date.now(),
  ...overrides,
});

describe('deriveRouteSurfaceForProfile', () => {
  it('maps local profiles to local route surface', () => {
    expect(deriveRouteSurfaceForProfile(baseProfile({ providerType: 'local' }))).toBe('local');
  });

  it('maps openrouter provider profiles to pool route surface', () => {
    expect(deriveRouteSurfaceForProfile(baseProfile({ providerType: 'openrouter' }))).toBe('pool');
  });

  it('maps codex subscription authSource to subscription route surface', () => {
    expect(
      deriveRouteSurfaceForProfile(baseProfile({ providerType: 'openai', authSource: 'codex-subscription' })),
    ).toBe('subscription');
  });

  it('defaults to api-key route surface for direct/byok profiles', () => {
    expect(deriveRouteSurfaceForProfile(baseProfile({ providerType: 'openai' }))).toBe('api-key');
  });
});

describe('migrateProfileRouteSurfaces', () => {
  it('adds missing routeSurface fields and reports changed=true', () => {
    const settings = {
      localModel: {
        profiles: [
          baseProfile({ id: 'p-local', providerType: 'local' }),
          baseProfile({ id: 'p-openrouter', providerType: 'openrouter' }),
          baseProfile({ id: 'p-codex', providerType: 'openai', authSource: 'codex-subscription' }),
          baseProfile({ id: 'p-openai', providerType: 'openai' }),
        ],
        activeProfileId: null,
      },
    } as AppSettings;

    const result = migrateProfileRouteSurfaces(settings);

    expect(result.changed).toBe(true);
    expect(result.profiles.map((p) => p.routeSurface)).toEqual(['local', 'pool', 'subscription', 'api-key']);
  });

  it('is idempotent when all profiles already have routeSurface', () => {
    const profiles = [
      baseProfile({ id: 'p1', routeSurface: 'api-key' }),
      baseProfile({ id: 'p2', providerType: 'openrouter', routeSurface: 'pool' }),
    ];
    const settings = {
      localModel: { profiles, activeProfileId: null },
    } as AppSettings;

    const result = migrateProfileRouteSurfaces(settings);
    expect(result.changed).toBe(false);
    expect(result.profiles).toBe(profiles);
  });
});
