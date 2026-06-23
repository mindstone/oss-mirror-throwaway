import { describe, expect, it } from 'vitest';
import type { ModelProfile } from '@shared/types';
import {
  classifyProfile,
  findShadowingConnectionManagedSibling,
  isAutoProfileShadowedBySibling,
  isConnectionManagedProfile,
  isBundledOllamaProfile,
  isLoopbackRoutableProfile,
  isUserAddedProfile,
} from '../profileHelpers';
import {
  CODEX_BTS_PROFILE_ID,
  CODEX_WORKING_PROFILE_ID,
} from '../codexDefaults';

const baseProfile: ModelProfile = {
  id: 'profile-helper-fixture',
  name: 'Profile helper fixture',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
  createdAt: 1,
};

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return { ...baseProfile, ...overrides };
}

function makeLoopbackProfile(
  overrides: Partial<NonNullable<Parameters<typeof isLoopbackRoutableProfile>[0]>> = {},
): NonNullable<Parameters<typeof isLoopbackRoutableProfile>[0]> {
  return {
    providerType: 'other',
    routeSurface: 'api-key',
    serverUrl: 'https://api.openai.com/v1',
    ...overrides,
  };
}

describe('profile source helpers', () => {
  it.each([
    [makeProfile(), 'user'],
    [makeProfile({ profileSource: 'user' }), 'user'],
    [makeProfile({ profileSource: 'connection' }), 'connection'],
    [makeProfile({ profileSource: 'auto' }), 'auto'],
  ] as const)('classifies %s as %s', (profile, expected) => {
    expect(classifyProfile(profile)).toBe(expected);
  });

  it('identifies only connection-managed profiles', () => {
    expect(isConnectionManagedProfile(makeProfile({ profileSource: 'connection' }))).toBe(true);
    expect(isConnectionManagedProfile(makeProfile({ profileSource: 'user' }))).toBe(false);
    expect(isConnectionManagedProfile(makeProfile({ profileSource: 'auto' }))).toBe(false);
    expect(isConnectionManagedProfile(makeProfile())).toBe(false);
  });

  it('treats explicit user and legacy-undefined profiles as user-added only', () => {
    expect(isUserAddedProfile(makeProfile({ profileSource: 'user' }))).toBe(true);
    expect(isUserAddedProfile(makeProfile())).toBe(true);
    expect(isUserAddedProfile(makeProfile({ profileSource: 'connection' }))).toBe(false);
    expect(isUserAddedProfile(makeProfile({ profileSource: 'auto' }))).toBe(false);
  });
});

describe('isLoopbackRoutableProfile', () => {
  it('returns true when routeSurface is local even if provider/url are cloud-like', () => {
    expect(isLoopbackRoutableProfile(makeLoopbackProfile({
      routeSurface: 'local',
      providerType: 'other',
      serverUrl: 'https://api.openai.com/v1',
    }))).toBe(true);
  });

  it('returns true for bundled-Ollama shape (providerType local, no routeSurface/serverUrl)', () => {
    expect(isLoopbackRoutableProfile({
      providerType: 'local',
      routeSurface: undefined,
      serverUrl: undefined,
    })).toBe(true);
  });

  it.each([
    'http://127.0.0.1:11434/v1',
    'http://localhost:11434/v1',
    'http://0.0.0.0:11434/v1',
    'http://[::1]:11434/v1',
  ])('returns true for loopback server URL %s', (serverUrl) => {
    expect(isLoopbackRoutableProfile(makeLoopbackProfile({
      providerType: 'other',
      routeSurface: 'api-key',
      serverUrl,
    }))).toBe(true);
  });

  it('returns false for non-loopback cloud profile', () => {
    expect(isLoopbackRoutableProfile(makeLoopbackProfile({
      providerType: 'other',
      routeSurface: 'api-key',
      serverUrl: 'https://api.openai.com/v1',
    }))).toBe(false);
  });

  it('returns false for missing profile or non-local profile without URL', () => {
    expect(isLoopbackRoutableProfile(undefined)).toBe(false);
    expect(isLoopbackRoutableProfile({
      providerType: 'other',
      routeSurface: undefined,
      serverUrl: undefined,
    })).toBe(false);
  });

  it('returns true when multiple local signals are present simultaneously', () => {
    expect(isLoopbackRoutableProfile({
      providerType: 'local',
      routeSurface: 'local',
      serverUrl: 'http://127.0.0.1:11434/v1',
    })).toBe(true);
  });
});

describe('isBundledOllamaProfile', () => {
  it('returns true only for providerType local', () => {
    expect(isBundledOllamaProfile({ providerType: 'local' })).toBe(true);
    expect(isBundledOllamaProfile({ providerType: 'other' })).toBe(false);
    expect(isBundledOllamaProfile(undefined)).toBe(false);
  });
});

describe('findShadowingConnectionManagedSibling / isAutoProfileShadowedBySibling', () => {
  const codexAutoProfile: ModelProfile = {
    id: CODEX_BTS_PROFILE_ID,
    name: 'GPT-5.4 mini (ChatGPT Pro)',
    authSource: 'codex-subscription',
    model: 'gpt-5.4-mini',
    providerType: 'openai',
    profileSource: 'auto',
    serverUrl: 'https://api.openai.com/v1',
    createdAt: 0,
  };

  const legacyCodexAutoProfileWithoutSource: ModelProfile = {
    // Reproduces the exact bug-report shape: ID is the auto id, but no
    // profileSource field. The DA's challenge: A0 must be ID-based, not
    // profileSource-based.
    id: CODEX_BTS_PROFILE_ID,
    name: 'GPT-5.4 mini (ChatGPT Pro)',
    authSource: 'codex-subscription',
    model: 'gpt-5.4-mini',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    createdAt: 0,
    jsonCompatibility: 'incompatible',
  };

  const baseConnectionSibling: ModelProfile = {
    id: 'profile-1778574304032-z4z40hq',
    name: 'GPT-5.4 mini',
    authSource: 'codex-subscription',
    model: 'gpt-5.4-mini',
    providerType: 'openai',
    profileSource: 'connection',
    routeSurface: 'subscription',
    serverUrl: 'https://api.openai.com/v1',
    jsonCompatibility: 'compatible',
    chatCompatibility: 'compatible',
    toolUseCompatibility: 'compatible',
    createdAt: 1_700_000_000_000,
  };

  it('returns the connection-managed sibling when route identity matches and sibling is healthy', () => {
    const sibling = findShadowingConnectionManagedSibling(codexAutoProfile, [
      codexAutoProfile,
      baseConnectionSibling,
    ]);
    expect(sibling?.id).toBe(baseConnectionSibling.id);
  });

  it('returns null when sibling is disabled', () => {
    const sibling = findShadowingConnectionManagedSibling(codexAutoProfile, [
      codexAutoProfile,
      { ...baseConnectionSibling, enabled: false },
    ]);
    expect(sibling).toBeNull();
  });

  it('returns null when sibling is JSON-incompatible', () => {
    const sibling = findShadowingConnectionManagedSibling(codexAutoProfile, [
      codexAutoProfile,
      { ...baseConnectionSibling, jsonCompatibility: 'incompatible' },
    ]);
    expect(sibling).toBeNull();
  });

  it('returns null when sibling is chat-incompatible', () => {
    const sibling = findShadowingConnectionManagedSibling(codexAutoProfile, [
      codexAutoProfile,
      { ...baseConnectionSibling, chatCompatibility: 'incompatible' },
    ]);
    expect(sibling).toBeNull();
  });

  it('returns null when sibling has blank serverUrl (not selectable)', () => {
    const sibling = findShadowingConnectionManagedSibling(codexAutoProfile, [
      codexAutoProfile,
      { ...baseConnectionSibling, serverUrl: '' },
    ]);
    expect(sibling).toBeNull();
  });

  it('returns null when sibling has different model id', () => {
    const sibling = findShadowingConnectionManagedSibling(codexAutoProfile, [
      codexAutoProfile,
      { ...baseConnectionSibling, model: 'gpt-5.5' },
    ]);
    expect(sibling).toBeNull();
  });

  it('infers route surface for connection sibling when omitted (codex-subscription auth)', () => {
    const sibling = findShadowingConnectionManagedSibling(codexAutoProfile, [
      codexAutoProfile,
      { ...baseConnectionSibling, routeSurface: undefined },
    ]);
    expect(sibling?.id).toBe(baseConnectionSibling.id);
  });

  it('handles legacy auto profile without profileSource via the canonical id (the bug-report shape)', () => {
    const sibling = findShadowingConnectionManagedSibling(legacyCodexAutoProfileWithoutSource, [
      legacyCodexAutoProfileWithoutSource,
      baseConnectionSibling,
    ]);
    expect(sibling?.id).toBe(baseConnectionSibling.id);
  });

  it('isAutoProfileShadowedBySibling returns true for legacy auto profile + healthy sibling', () => {
    expect(
      isAutoProfileShadowedBySibling(legacyCodexAutoProfileWithoutSource, [
        legacyCodexAutoProfileWithoutSource,
        baseConnectionSibling,
      ]),
    ).toBe(true);
  });

  it('isAutoProfileShadowedBySibling returns false when sibling is unsuitable', () => {
    expect(
      isAutoProfileShadowedBySibling(codexAutoProfile, [
        codexAutoProfile,
        { ...baseConnectionSibling, enabled: false },
      ]),
    ).toBe(false);
  });

  it('isAutoProfileShadowedBySibling returns false for non-auto profiles', () => {
    const userProfile: ModelProfile = {
      id: 'user-profile-1',
      name: 'My OpenAI key',
      providerType: 'openai',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      createdAt: 1_700_000_000_000,
    };
    expect(
      isAutoProfileShadowedBySibling(userProfile, [userProfile, baseConnectionSibling]),
    ).toBe(false);
  });

  it('handles working-profile auto + sibling', () => {
    const workingAuto: ModelProfile = {
      id: CODEX_WORKING_PROFILE_ID,
      name: 'GPT-5.5 (ChatGPT Pro)',
      authSource: 'codex-subscription',
      model: 'gpt-5.5',
      providerType: 'openai',
      profileSource: 'auto',
      serverUrl: 'https://api.openai.com/v1',
      createdAt: 0,
    };
    const workingSibling: ModelProfile = {
      ...baseConnectionSibling,
      id: 'profile-working-sibling',
      name: 'GPT-5.5',
      model: 'gpt-5.5',
    };
    expect(findShadowingConnectionManagedSibling(workingAuto, [workingAuto, workingSibling])?.id)
      .toBe(workingSibling.id);
  });
});
