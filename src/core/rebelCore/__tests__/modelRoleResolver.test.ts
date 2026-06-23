import { describe, expect, it } from 'vitest';
import type { ModelProfile } from '@shared/types';
import {
  makeRoleNotConfiguredStatusMessage,
  parseRoleNotConfiguredStatusMessage,
  parseRoleResolutionFailureFromRawError,
  resolveDefaultModelForRole,
  serializeRoleResolutionFailureRawError,
  type ModelRoleResolverSettings,
  type RoleResolutionFailure,
} from '../modelRoleResolver';

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'p-1',
    name: 'OpenAI / GPT-5.5',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    apiKey: 'fake-openai-key',
    enabled: true,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeSettings(
  overrides: Partial<ModelRoleResolverSettings> & { claude?: unknown } = {},
): ModelRoleResolverSettings {
  return {
    models: {
      model: 'claude-sonnet-4-6',
      thinkingModel: 'claude-opus-4-7',
      thinkingProfileId: undefined,
      workingProfileId: undefined,
    },
    localModel: { activeProfileId: null },
    behindTheScenesModel: undefined,
    ...overrides,
  };
}

describe('resolveDefaultModelForRole', () => {
  it('returns profile source when a role-bound profile is selectable', () => {
    const profiles = [makeProfile({ id: 'thinking-1', model: 'o4-mini' })];
    const settings = makeSettings({
      models: {
        model: 'claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-7',
        thinkingProfileId: 'thinking-1',
      },
    });

    expect(resolveDefaultModelForRole('thinking', settings, profiles)).toEqual({
      ok: true,
      role: 'thinking',
      source: 'profile',
      model: 'o4-mini',
      profileId: 'thinking-1',
    });
  });

  it('falls through to settings when role-bound profile is not selectable', () => {
    const profiles = [makeProfile({ id: 'thinking-1', serverUrl: '', model: 'o4-mini' })];
    const settings = makeSettings({
      models: {
        model: 'claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-7',
        thinkingProfileId: 'thinking-1',
      },
    });

    expect(resolveDefaultModelForRole('thinking', settings, profiles)).toEqual({
      ok: true,
      role: 'thinking',
      source: 'setting',
      model: 'claude-opus-4-7',
    });
  });

  it('returns no-profile-and-no-setting when nothing is configured', () => {
    const settings = makeSettings({
      models: {
        model: '',
        thinkingModel: '',
      },
    });

    expect(resolveDefaultModelForRole('thinking', settings, [])).toEqual({
      ok: false,
      role: 'thinking',
      reason: 'no-profile-and-no-setting-for-role',
    });
  });

  it('returns unknown-profile when thinkingProfileId points to a deleted profile', () => {
    const settings = makeSettings({
      models: {
        model: 'claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-7',
        thinkingProfileId: 'deleted-profile',
      },
    });

    expect(resolveDefaultModelForRole('thinking', settings, [])).toEqual({
      ok: false,
      role: 'thinking',
      reason: 'role-key-references-unknown-profile',
      profileId: 'deleted-profile',
    });
  });

  it('resolves working from setting when active profile is unusable', () => {
    const profiles = [makeProfile({ id: 'active', serverUrl: '', model: 'gpt-5.5' })];
    const settings = makeSettings({
      models: { model: 'claude-sonnet-4-6' },
      localModel: { activeProfileId: 'active' },
    });

    expect(resolveDefaultModelForRole('working', settings, profiles)).toEqual({
      ok: true,
      role: 'working',
      source: 'setting',
      model: 'claude-sonnet-4-6',
    });
  });

  it('returns profile-disabled-or-incomplete when working profile is unusable and no setting exists', () => {
    const profiles = [makeProfile({ id: 'working-1', serverUrl: '' })];
    const settings = makeSettings({
      models: {
        model: '',
        workingProfileId: 'working-1',
      },
    });

    expect(resolveDefaultModelForRole('working', settings, profiles)).toEqual({
      ok: false,
      role: 'working',
      reason: 'profile-disabled-or-incomplete',
      profileId: 'working-1',
    });
  });

  it('resolves fast from profile: prefix when the profile is selectable', () => {
    const profiles = [makeProfile({ id: 'fast-1', model: 'gpt-4.1-mini' })];
    const settings = makeSettings({
      behindTheScenesModel: 'profile:fast-1',
    });

    expect(resolveDefaultModelForRole('background', settings, profiles)).toEqual({
      ok: true,
      role: 'background',
      source: 'profile',
      model: 'gpt-4.1-mini',
      profileId: 'fast-1',
    });
  });

  it('returns unknown-profile when fast references a deleted profile', () => {
    const settings = makeSettings({ behindTheScenesModel: 'profile:missing' });
    expect(resolveDefaultModelForRole('background', settings, [])).toEqual({
      ok: false,
      role: 'background',
      reason: 'role-key-references-unknown-profile',
      profileId: 'missing',
    });
  });

  it('falls back to DEFAULT_AUXILIARY_MODEL when fast has no configuration (legacy-settings recovery)', () => {
    const settings = makeSettings({ behindTheScenesModel: '' });
    expect(resolveDefaultModelForRole('background', settings, [])).toEqual({
      ok: true,
      role: 'background',
      source: 'setting',
      model: 'claude-haiku-4-5',
    });
  });

  it.each([
    { name: 'null', models: null as ModelRoleResolverSettings['models'] },
    { name: 'undefined', models: undefined as ModelRoleResolverSettings['models'] },
  ])('ignores legacy claude when models is $name', ({ models }) => {
    const withLegacy = makeSettings({
      models,
      claude: { thinkingModel: 'claude-opus-4-7' },
    });
    expect(resolveDefaultModelForRole('thinking', withLegacy, [])).toEqual({
      ok: false,
      role: 'thinking',
      reason: 'no-profile-and-no-setting-for-role',
    });

    const withoutLegacy = makeSettings({
      models,
    });
    expect(resolveDefaultModelForRole('thinking', withoutLegacy, [])).toEqual({
      ok: false,
      role: 'thinking',
      reason: 'no-profile-and-no-setting-for-role',
    });
  });

  it('does not resurrect stale claude.thinkingProfileId when models namespace exists without role key', () => {
    const settings = makeSettings({
      models: {},
      claude: {
        thinkingProfileId: 'stale-legacy-profile',
        thinkingModel: 'claude-opus-4-7',
      },
    });

    expect(resolveDefaultModelForRole('thinking', settings, [])).toEqual({
      ok: false,
      role: 'thinking',
      reason: 'no-profile-and-no-setting-for-role',
    });
  });

  it('returns unknown-profile when fast uses an empty profile: prefix', () => {
    const settings = makeSettings({ behindTheScenesModel: 'profile:' });
    expect(resolveDefaultModelForRole('background', settings, [])).toEqual({
      ok: false,
      role: 'background',
      reason: 'role-key-references-unknown-profile',
    });
  });

  it('returns unknown-profile when fast uses a whitespace-only profile id', () => {
    const settings = makeSettings({ behindTheScenesModel: 'profile: ' });
    expect(resolveDefaultModelForRole('background', settings, [])).toEqual({
      ok: false,
      role: 'background',
      reason: 'role-key-references-unknown-profile',
    });
  });

  it('handles undefined localModel.profiles at call sites without crashing', () => {
    const settings = makeSettings({
      models: { model: 'claude-sonnet-4-6' },
      localModel: { activeProfileId: 'missing', profiles: undefined },
    });

    expect(resolveDefaultModelForRole('working', settings, settings.localModel?.profiles ?? [])).toEqual({
      ok: true,
      role: 'working',
      source: 'setting',
      model: 'claude-sonnet-4-6',
    });
  });

  it('snapshots ambient role resolver outputs for thinking, working, and fast callers', () => {
    // CHARACTERIZATION: documents current behavior, not necessarily desired.
    const profiles = [
      makeProfile({ id: 'working-profile', model: 'gpt-5.5' }),
      makeProfile({ id: 'fast-profile', model: 'gpt-4.1-mini' }),
      makeProfile({ id: 'disabled-thinking', model: 'o4-mini', enabled: false }),
    ];
    const settings = makeSettings({
      models: {
        model: 'claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-7',
        thinkingProfileId: 'disabled-thinking',
        workingProfileId: 'working-profile',
      },
      behindTheScenesModel: 'profile:fast-profile',
      localModel: { activeProfileId: null, profiles },
    });

    expect((['thinking', 'working', 'background'] as const).map((role) => ({
      role,
      resolution: resolveDefaultModelForRole(role, settings, profiles),
    }))).toMatchInlineSnapshot(`
      [
        {
          "resolution": {
            "model": "claude-opus-4-7",
            "ok": true,
            "role": "thinking",
            "source": "setting",
          },
          "role": "thinking",
        },
        {
          "resolution": {
            "model": "gpt-5.5",
            "ok": true,
            "profileId": "working-profile",
            "role": "working",
            "source": "profile",
          },
          "role": "working",
        },
        {
          "resolution": {
            "model": "gpt-4.1-mini",
            "ok": true,
            "profileId": "fast-profile",
            "role": "background",
            "source": "profile",
          },
          "role": "background",
        },
      ]
    `);
  });
});

describe('role-resolution metadata helpers', () => {
  it('serializes and parses roleResolutionFailure payloads in raw errors', () => {
    const failure: RoleResolutionFailure = {
      ok: false,
      role: 'working',
      reason: 'profile-disabled-or-incomplete',
      profileId: 'broken-working',
    };
    const raw = serializeRoleResolutionFailureRawError(failure, 'Working model needs setup');
    expect(parseRoleResolutionFailureFromRawError(raw)).toEqual(failure);
  });

  it('encodes and parses fast-role status messages', () => {
    const message = makeRoleNotConfiguredStatusMessage('background');
    expect(parseRoleNotConfiguredStatusMessage(message)).toBe('background');
    expect(parseRoleNotConfiguredStatusMessage('status:ok')).toBeNull();
  });
});
