/**
 * Stage 0 characterization — profile-first resolution vs activeProvider (seam 3).
 *
 * `routeDecision` resolves a routable PROFILE first; when one is present it goes
 * through `profileDecision` and the `selectProviderMode`/`activeProvider` arm is
 * BYPASSED entirely. This pins "which input wins" so the Stage 1 restructure
 * (which moves the provider-choice point) cannot silently let `activeProvider`
 * override an explicit profile (or vice-versa).
 *
 * The integration matrix (providerRouting.routingPrecedence.test.ts) covers many
 * profile rows already; this file isolates the load-bearing INVARIANT — a
 * profile whose provider type CONFLICTS with `activeProvider` is routed by the
 * profile, not by `activeProvider` — and pins the resolution-order/precedence
 * inputs (`resolvedFrom`) that the restructure must keep.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ModelProfile } from '@shared/types';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ProviderRouter, type ProviderRouteSettings } from '../providerRouting';

function openAiProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'openai-profile',
    name: 'OpenAI profile',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    apiKey: 'fake-openai-key',
    enabled: true,
    createdAt: 1,
    ...overrides,
  } as ModelProfile;
}

describe('profile-first resolution vs activeProvider — Stage 0 characterization', () => {
  it('an explicit routable profile WINS over a conflicting activeProvider (profile routed, activeProvider bypassed)', () => {
    // activeProvider says anthropic, but the explicit profile is an OpenAI BYOK
    // profile. Current behaviour: the PROFILE wins; we route to provider
    // 'profile' via openai-compatible-http, NOT to anthropic-direct.
    const profile = openAiProfile();
    const settings: ProviderRouteSettings = {
      activeProvider: 'anthropic',
      models: { apiKey: 'fake-anthropic-key', authMethod: 'api-key', model: 'claude-sonnet-4-6' },
      localModel: { activeProfileId: null, profiles: [profile] },
      providerKeys: {},
    };

    const decision = ProviderRouter.forTurn({
      settings,
      model: `profile:${profile.id}`,
      profile,
      codexConnectivity: 'unknown',
      role: 'execution',
    });

    expect(decision.provider).toBe('profile');
    expect(decision.transport).toBe('openai-compatible-http');
    expect(decision.profileId).toBe(profile.id);
    expect(decision.resolvedFrom).toBe('explicit-profile');
  });

  it('a profile resolved from models.workingProfileId (no explicit model) wins over activeProvider', () => {
    const profile = openAiProfile({ id: 'working-openai-profile' });
    const settings: ProviderRouteSettings = {
      activeProvider: 'anthropic',
      models: {
        apiKey: 'fake-anthropic-key',
        authMethod: 'api-key',
        model: 'claude-sonnet-4-6',
        workingProfileId: profile.id,
      },
      localModel: { activeProfileId: null, profiles: [profile] },
      providerKeys: {},
    };

    const decision = ProviderRouter.forTurn({
      settings,
      model: null,
      codexConnectivity: 'unknown',
      role: 'execution',
    });

    expect(decision.provider).toBe('profile');
    expect(decision.profileId).toBe(profile.id);
    expect(decision.resolvedFrom).toBe('working-profile');
  });

  it('a NON-routable (disabled) profile is ignored → falls through to the activeProvider arm', () => {
    // Current behaviour: a disabled profile is not routable, so resolveProfile
    // returns no profile and routeDecision falls into selectProviderMode. With
    // activeProvider anthropic + a key + a native-Claude model, that is
    // anthropic-direct, resolvedFrom 'settings'.
    const profile = openAiProfile({ id: 'disabled-profile', enabled: false });
    const settings: ProviderRouteSettings = {
      activeProvider: 'anthropic',
      models: {
        apiKey: 'fake-anthropic-key',
        authMethod: 'api-key',
        model: 'claude-sonnet-4-6',
        workingProfileId: profile.id,
      },
      localModel: { activeProfileId: null, profiles: [profile] },
      providerKeys: {},
    };

    const decision = ProviderRouter.forTurn({
      settings,
      model: null,
      codexConnectivity: 'unknown',
      role: 'execution',
    });

    expect(decision.provider).toBe('anthropic');
    expect(decision.transport).toBe('anthropic-direct');
    expect(decision.profileId).toBeNull();
    expect(decision.resolvedFrom).toBe('settings');
  });

  it('explicit input.profile WINS over a conflicting model: profile:<other-id> reference (resolveProfile checks input.profile first)', () => {
    // resolveProfile checks `input.profile` FIRST (when routable), THEN
    // `profileReferenceId(input.model)` (providerRouting.ts:377-385). To pin the
    // ORDERING (not just "a profile resolves"), pass profile A as input.profile
    // while input.model references a DIFFERENT routable profile B. Current
    // behaviour: A wins. (F1 from GPT review — the earlier version used a bare
    // model string and so did not actually exercise this precedence.)
    const profileA = openAiProfile({ id: 'explicit-profile-A', model: 'gpt-5.5' });
    const profileB = openAiProfile({ id: 'model-ref-profile-B', model: 'gpt-4o-mini' });
    const settings: ProviderRouteSettings = {
      activeProvider: 'codex',
      models: { apiKey: null, model: 'gpt-5.5' },
      localModel: { activeProfileId: null, profiles: [profileA, profileB] },
      providerKeys: {},
    };

    const decision = ProviderRouter.forTurn({
      settings,
      model: `profile:${profileB.id}`,
      profile: profileA,
      codexConnectivity: 'connected',
      role: 'execution',
    });

    expect(decision.provider).toBe('profile');
    expect(decision.profileId).toBe(profileA.id);
    expect(decision.wireModelId).toBe('gpt-5.5');
    expect(decision.resolvedFrom).toBe('explicit-profile');
  });
});
