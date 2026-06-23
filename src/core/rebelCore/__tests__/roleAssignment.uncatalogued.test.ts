import { describe, expect, it } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import { resolveRoleAssignment } from '../roleAssignment';

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'profile-1',
    name: 'Profile 1',
    providerType: 'openai',
    routeSurface: 'api-key',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    apiKey: 'fake',
    enabled: true,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProvider: 'anthropic',
    models: {
      apiKey: 'fake-anthropic-key',
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypassPermissions',
      planMode: true,
      thinkingEffort: 'high',
      extendedContext: false,
    } as AppSettings['models'],
    localModel: { profiles: [], activeProfileId: null },
    ...overrides,
  } as AppSettings;
}

describe('resolveRoleAssignment — uncatalogued bare model detection', () => {
  it('marks a bare id absent from catalogs and profiles as uncatalogued', () => {
    const assignment = resolveRoleAssignment('working', makeSettings({
      models: {
        apiKey: 'fake-anthropic-key',
        authMethod: 'api-key',
        model: 'future-private-model',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
    }));

    expect(assignment.primary).toEqual({ kind: 'model', modelId: 'future-private-model' });
    expect(assignment.isUncatalogued).toBe(true);
  });

  it('does not mark a bare id present in the active-provider catalog', () => {
    const assignment = resolveRoleAssignment('working', makeSettings());

    expect(assignment.primary).toEqual({ kind: 'model', modelId: 'claude-sonnet-4-6' });
    expect(assignment.isUncatalogued).toBe(false);
  });

  it('does not mark a bare id present in additional Claude fallback groups', () => {
    const assignment = resolveRoleAssignment('working', makeSettings({
      activeProvider: 'codex',
      models: {
        apiKey: 'fake-anthropic-key',
        authMethod: 'api-key',
        model: 'claude-sonnet-4-6',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
    }));

    expect(assignment.primary).toEqual({ kind: 'model', modelId: 'claude-sonnet-4-6' });
    expect(assignment.isUncatalogued).toBe(false);
  });

  it("does not mark a bare id matching a profile's model field", () => {
    const profile = makeProfile({ model: 'future-private-model' });
    const assignment = resolveRoleAssignment('working', makeSettings({
      models: {
        apiKey: 'fake-anthropic-key',
        authMethod: 'api-key',
        model: 'future-private-model',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
      localModel: { profiles: [profile], activeProfileId: null },
    }));

    expect(assignment.primary).toEqual({ kind: 'model', modelId: 'future-private-model' });
    expect(assignment.isUncatalogued).toBe(false);
  });

  it('does not catalog-check profile choices', () => {
    const profile = makeProfile({ id: 'working-profile', model: 'future-private-model' });
    const assignment = resolveRoleAssignment('working', makeSettings({
      models: {
        apiKey: 'fake-anthropic-key',
        authMethod: 'api-key',
        model: 'claude-sonnet-4-6',
        workingProfileId: 'working-profile',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
      localModel: { profiles: [profile], activeProfileId: null },
    }));

    expect(assignment.primary).toEqual({ kind: 'profile', profileId: 'working-profile' });
    expect(assignment.isUncatalogued).toBe(false);
  });

  it('does not catalog-check auto choices', () => {
    const assignment = resolveRoleAssignment('recovery', makeSettings());

    expect(assignment.primary).toEqual({ kind: 'auto' });
    expect(assignment.isUncatalogued).toBe(false);
  });

  it('does not catalog-check off choices', () => {
    const assignment = resolveRoleAssignment('thinking', makeSettings());

    expect(assignment.primary).toEqual({ kind: 'off' });
    expect(assignment.isUncatalogued).toBe(false);
  });
});
