import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeCatalogModelId,
  type CatalogEntry,
} from '@shared/data/providerCatalogs';
import type { ModelProfile } from '@shared/types';
import {
  findExistingManagedProfile,
  materializeCatalogProfile,
} from '../catalogMaterialization';

afterEach(() => {
  vi.restoreAllMocks();
});

function catalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    providerType: 'openai',
    routeSurface: 'subscription',
    model: 'gpt-5.5',
    label: 'GPT-5.5',
    isMainModel: true,
    isAuxiliaryModel: false,
    reasoning: true,
    jsonSupport: 'compatible',
    toolUseSupport: 'compatible',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    ...overrides,
  };
}

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'existing-connection',
    name: 'Existing connection profile',
    providerType: 'openai',
    routeSurface: 'subscription',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    createdAt: 1_700_000_000_000,
    profileSource: 'connection',
    ...overrides,
  };
}

describe('materializeCatalogProfile', () => {
  it('generates a connection-managed profile with catalog capabilities and expected defaults', () => {
    const result = materializeCatalogProfile(catalogEntry(), {
      id: 'profile-from-catalog',
      createdAt: 1_800_000_000_000,
    });

    expect(result).toMatchObject({
      id: 'profile-from-catalog',
      name: 'GPT-5.5',
      providerType: 'openai',
      routeSurface: 'subscription',
      authSource: 'codex-subscription',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
      createdAt: 1_800_000_000_000,
      profileSource: 'connection',
      routingEligible: true,
      enabled: true,
      chatCompatibility: 'compatible',
      jsonCompatibility: 'compatible',
      toolUseCompatibility: 'compatible',
      thinkingCompatibility: 'compatible',
      reasoningEffort: 'medium',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(result.councilEnabled).toBeUndefined();
    expect(result.apiKey).toBeUndefined();
  });

  it('honors display name, council membership, reasoning effort, and generated ID defaults', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);

    const result = materializeCatalogProfile(catalogEntry(), {
      displayName: '  ChatGPT Pro / GPT-5.5  ',
      councilEnabled: true,
      reasoningEffort: 'high',
    });

    expect(result.id).toMatch(/^profile-1900000000000-[a-z0-9]{1,}$/);
    expect(result.name).toBe('ChatGPT Pro / GPT-5.5');
    expect(result.createdAt).toBe(1_900_000_000_000);
    expect(result.councilEnabled).toBe(true);
    expect(result.reasoningEffort).toBe('high');
  });

  // Premium always-on-thinking rows (GPT stage-12 review F3): adding one to
  // the team must NOT silently enter it into Smart Picking — routingEligible
  // defaults OFF for the 2x-cost class (the user can still chip it on in
  // ModelTeamSection). New-materialization default only; persisted profiles
  // are untouched.
  describe('premium always-on routingEligible default', () => {
    it.each([
      ['direct Anthropic row', catalogEntry({ providerType: 'anthropic', routeSurface: 'api-key', model: 'claude-fable-5' })],
      ['OpenRouter row (flag via the sdkModel hop)', catalogEntry({ providerType: 'openrouter', routeSurface: 'pool', model: 'anthropic/claude-fable-5' })],
    ] as const)('defaults routingEligible to false for the %s', (_label, entry) => {
      const result = materializeCatalogProfile(entry, { id: 'profile-premium', createdAt: 1 });
      expect(result.routingEligible).toBe(false);
      // Everything else about the materialisation is unchanged.
      expect(result.enabled).toBe(true);
      expect(result.profileSource).toBe('connection');
    });

    it('an explicit routingEligible option still wins (chip-on stays possible)', () => {
      const entry = catalogEntry({ providerType: 'anthropic', routeSurface: 'api-key', model: 'claude-fable-5' });
      const result = materializeCatalogProfile(entry, { id: 'profile-premium', createdAt: 1, routingEligible: true });
      expect(result.routingEligible).toBe(true);
    });

    it('non-premium rows keep the default-on behavior', () => {
      const result = materializeCatalogProfile(
        catalogEntry({ providerType: 'anthropic', routeSurface: 'api-key', model: 'claude-opus-4-8' }),
        { id: 'profile-opus', createdAt: 1 },
      );
      expect(result.routingEligible).toBe(true);
    });
  });

  it.each([
    [
      'anthropic',
      catalogEntry({
        providerType: 'anthropic',
        routeSurface: 'api-key',
        model: 'claude-sonnet-4-6',
      }),
      {
        providerType: 'anthropic',
        routeSurface: 'api-key',
        serverUrl: 'https://api.anthropic.com/v1',
      },
    ],
    [
      'openrouter',
      catalogEntry({
        providerType: 'openrouter',
        routeSurface: 'pool',
        model: 'anthropic/claude-sonnet-4-6',
      }),
      {
        providerType: 'openrouter',
        routeSurface: 'pool',
        serverUrl: 'https://openrouter.ai/api/v1',
      },
    ],
    [
      'google',
      catalogEntry({
        providerType: 'google',
        routeSurface: 'api-key',
        model: 'gemini-2.5-pro',
      }),
      {
        providerType: 'google',
        routeSurface: 'api-key',
        serverUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      },
    ],
  ] as const)('materialises the %s provider tuple', (_name, entry, expected) => {
    const result = materializeCatalogProfile(entry, {
      id: `profile-${entry.providerType}`,
      createdAt: 1,
    });

    expect(result).toMatchObject(expected);
    expect(result.authSource).toBeUndefined();
  });

  it('throws on malformed catalog entries with an unknown providerType', () => {
    const malformedEntry = {
      ...catalogEntry(),
      providerType: 'mistral',
    } as unknown as CatalogEntry;

    expect(() => materializeCatalogProfile(malformedEntry)).toThrow(
      "materializeCatalogProfile: unknown providerType 'mistral'",
    );
  });

  it('returns an existing matching connection profile unchanged for idempotency', () => {
    const existing = profile({ name: 'Existing profile', routingEligible: false });
    const result = materializeCatalogProfile(
      catalogEntry({ model: ' GPT-5.5 ' }),
      { id: 'would-have-been-new', displayName: 'New name' },
      [existing],
    );

    expect(result).toBe(existing);
    expect(result).toEqual(existing);
  });

  it('generates a new profile when existing profiles do not match the composite key', () => {
    const nonMatching = profile({ id: 'other-route', routeSurface: 'api-key' });
    const result = materializeCatalogProfile(
      catalogEntry(),
      { id: 'new-profile', createdAt: 2 },
      [nonMatching],
    );

    expect(result).not.toBe(nonMatching);
    expect(result.id).toBe('new-profile');
    expect(result.profileSource).toBe('connection');
  });
});

describe('findExistingManagedProfile', () => {
  it('matches only the full provider, route-surface, and normalized-model composite key', () => {
    const entry = catalogEntry({ providerType: 'openai', routeSurface: 'subscription' });
    const sameModelDifferentRoute = profile({
      id: 'different-route',
      routeSurface: 'api-key',
    });
    const sameModelDifferentProvider = profile({
      id: 'different-provider',
      providerType: 'anthropic',
    });
    const match = profile({
      id: 'matching-profile',
      model: ' GPT-5.5 ',
    });

    expect(
      findExistingManagedProfile([sameModelDifferentRoute], entry),
    ).toBeUndefined();
    expect(
      findExistingManagedProfile([sameModelDifferentProvider], entry),
    ).toBeUndefined();
    expect(findExistingManagedProfile([sameModelDifferentRoute, match], entry)).toBe(match);
  });

  it('ignores user-added profiles even when the composite key matches', () => {
    const userAdded = profile({ profileSource: 'user' });

    expect(findExistingManagedProfile([userAdded], catalogEntry())).toBeUndefined();
  });

  it('matches auto profiles when the composite key matches', () => {
    const autoProfile = profile({ id: 'codex-gpt-5.5', profileSource: 'auto' });

    expect(findExistingManagedProfile([autoProfile], catalogEntry())).toBe(autoProfile);
  });

  it('does not collapse slash-qualified OpenRouter IDs to unqualified model IDs', () => {
    const slashQualifiedProfile = profile({
      id: 'openrouter-claude',
      providerType: 'openrouter',
      routeSurface: 'pool',
      model: 'anthropic/claude-3-opus',
    });

    expect(
      findExistingManagedProfile(
        [slashQualifiedProfile],
        catalogEntry({
          providerType: 'openrouter',
          routeSurface: 'pool',
          model: 'claude-3-opus',
        }),
      ),
    ).toBeUndefined();
    expect(
      findExistingManagedProfile(
        [slashQualifiedProfile],
        catalogEntry({
          providerType: 'openrouter',
          routeSurface: 'pool',
          model: ' Anthropic/Claude-3-Opus ',
        }),
      ),
    ).toBe(slashQualifiedProfile);
  });
});

describe('normalizeCatalogModelId', () => {
  it.each([
    [' GPT-5.5 ', 'gpt-5.5'],
    ['OpenAI:gpt-5.5', 'openai:gpt-5.5'],
    ['anthropic/claude-sonnet-4-6', 'anthropic/claude-sonnet-4-6'],
    ['meta-llama/llama-3-70b', 'meta-llama/llama-3-70b'],
    ['Claude-Sonnet-4-6', 'claude-sonnet-4-6'],
    [' claude-sonnet-4-6[1m] ', 'claude-sonnet-4-6'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeCatalogModelId(input)).toBe(expected);
  });
});
