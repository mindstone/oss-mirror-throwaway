import { describe, expect, it } from 'vitest';

import type { CatalogEntry } from '@shared/data/providerCatalogs';
import type { ModelProfile, ModelProviderType, RouteSurface } from '@shared/types';
import { dedupCatalogAgainstProfiles } from '../dedupCatalog';

function catalogEntry(overrides: Partial<CatalogEntry>): CatalogEntry {
  return {
    providerType: 'anthropic',
    routeSurface: 'api-key',
    model: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    isMainModel: true,
    isAuxiliaryModel: false,
    ...overrides,
  };
}

function profile(overrides: {
  id: string;
  providerType: ModelProviderType;
  routeSurface?: RouteSurface;
  model: string;
  enabled?: boolean;
  profileSource?: ModelProfile['profileSource'];
}): ModelProfile {
  return {
    id: overrides.id,
    name: overrides.id,
    providerType: overrides.providerType,
    routeSurface: overrides.routeSurface,
    model: overrides.model,
    serverUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    createdAt: 1_700_000_000_000,
    enabled: overrides.enabled,
    profileSource: overrides.profileSource,
  };
}

describe('dedupCatalogAgainstProfiles', () => {
  it('keeps Codex subscription catalog rows when the user has the same OpenAI model via direct API key', () => {
    const catalog = [
      catalogEntry({
        providerType: 'openai',
        routeSurface: 'subscription',
        model: 'gpt-5.6',
        label: 'GPT-5.6',
      }),
    ];
    const userProfiles = [
      profile({
        id: 'direct-openai',
        providerType: 'openai',
        routeSurface: 'api-key',
        model: 'gpt-5.6',
      }),
    ];

    expect(dedupCatalogAgainstProfiles(catalog, userProfiles)).toEqual(catalog);
  });

  it('suppresses an Anthropic catalog row when a user profile owns the same composite key', () => {
    const catalog = [
      catalogEntry({
        providerType: 'anthropic',
        routeSurface: 'api-key',
        model: 'claude-sonnet-4-6',
      }),
    ];
    const userProfiles = [
      profile({
        id: 'custom-claude',
        providerType: 'anthropic',
        routeSurface: 'api-key',
        model: 'claude-sonnet-4-6',
      }),
    ];

    expect(dedupCatalogAgainstProfiles(catalog, userProfiles)).toEqual([]);
  });

  it('suppresses an OpenRouter catalog row with a matching slash-qualified model', () => {
    const catalog = [
      catalogEntry({
        providerType: 'openrouter',
        routeSurface: 'pool',
        model: 'anthropic/claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
      }),
    ];
    const userProfiles = [
      profile({
        id: 'or-claude',
        providerType: 'openrouter',
        routeSurface: 'pool',
        model: 'anthropic/claude-sonnet-4-6',
      }),
    ];

    expect(dedupCatalogAgainstProfiles(catalog, userProfiles)).toEqual([]);
  });

  it('keeps custom Gemini variants that differ from the curated model ID', () => {
    const catalog = [
      catalogEntry({
        providerType: 'google',
        routeSurface: 'api-key',
        model: 'gemini-2.5-pro',
        label: 'Gemini 2.5 Pro',
      }),
    ];
    const userProfiles = [
      profile({
        id: 'gemini-experimental',
        providerType: 'google',
        routeSurface: 'api-key',
        model: 'gemini-2.5-pro-experimental',
      }),
    ];

    expect(dedupCatalogAgainstProfiles(catalog, userProfiles)).toEqual(catalog);
  });

  it('suppresses catalog rows when a disabled user profile owns the same composite key (LocalModelSection default — disabled profiles still render in "Available")', () => {
    const catalog = [
      catalogEntry({
        providerType: 'anthropic',
        routeSurface: 'api-key',
        model: 'claude-sonnet-4-6',
      }),
    ];
    const userProfiles = [
      profile({
        id: 'disabled-claude',
        providerType: 'anthropic',
        routeSurface: 'api-key',
        model: 'claude-sonnet-4-6',
        enabled: false,
      }),
    ];

    expect(dedupCatalogAgainstProfiles(catalog, userProfiles)).toEqual([]);
  });

  it('keeps catalog rows visible when a disabled user profile owns the key but the caller opts into picker semantics (260603 opus-4-8 working-dropdown fix)', () => {
    const catalog = [
      catalogEntry({
        providerType: 'anthropic',
        routeSurface: 'api-key',
        model: 'claude-sonnet-4-6',
      }),
    ];
    const userProfiles = [
      profile({
        id: 'disabled-claude',
        providerType: 'anthropic',
        routeSurface: 'api-key',
        model: 'claude-sonnet-4-6',
        enabled: false,
      }),
    ];

    expect(
      dedupCatalogAgainstProfiles(catalog, userProfiles, { excludeDisabledFromSuppression: true }),
    ).toEqual(catalog);
  });

  it('keeps catalog rows visible when only a virtual profile claims the same composite key (260603 opus-4-8 working-dropdown fix)', () => {
    const catalog = [
      catalogEntry({
        providerType: 'anthropic',
        routeSurface: 'api-key',
        model: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
      }),
    ];
    const userProfiles: ModelProfile[] = [
      {
        id: '__virtual-thinking',
        name: 'Default thinking model',
        providerType: 'anthropic',
        routeSurface: 'api-key',
        serverUrl: '',
        model: 'claude-opus-4-8',
        isVirtual: true,
        enabled: true,
        createdAt: 1,
      },
    ];

    expect(dedupCatalogAgainstProfiles(catalog, userProfiles)).toEqual(catalog);
  });

  it('keeps catalog rows visible when only a profileSource:"auto" non-virtual profile claims the same composite key', () => {
    const catalog = [
      catalogEntry({
        providerType: 'anthropic',
        routeSurface: 'api-key',
        model: 'claude-opus-4-8',
        label: 'Claude Opus 4.8',
      }),
    ];
    const userProfiles = [
      profile({
        id: 'auto-managed-opus',
        providerType: 'anthropic',
        routeSurface: 'api-key',
        model: 'claude-opus-4-8',
        profileSource: 'auto',
      }),
    ];

    expect(dedupCatalogAgainstProfiles(catalog, userProfiles)).toEqual(catalog);
  });

  it('keeps Codex catalog rows when a Codex auto-profile would otherwise collide', () => {
    const catalog = [
      catalogEntry({
        providerType: 'openai',
        routeSurface: 'subscription',
        model: 'gpt-5.5',
        label: 'GPT-5.5',
      }),
      catalogEntry({
        providerType: 'openai',
        routeSurface: 'subscription',
        model: 'gpt-5.4-mini',
        label: 'GPT-5.4 mini',
      }),
    ];
    const codexAutoProfiles: ModelProfile[] = [
      {
        id: 'codex-gpt-5.5',
        name: 'GPT-5.5 (ChatGPT Pro)',
        authSource: 'codex-subscription',
        model: 'gpt-5.5',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        createdAt: 0,
      },
      {
        id: 'codex-gpt-5.4-mini',
        name: 'GPT-5.4 mini (ChatGPT Pro)',
        authSource: 'codex-subscription',
        model: 'gpt-5.4-mini',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        createdAt: 0,
      },
    ];

    expect(dedupCatalogAgainstProfiles(catalog, codexAutoProfiles)).toEqual(catalog);
  });

  it('still suppresses catalog rows when a non-auto Codex-subscription user profile collides', () => {
    const catalog = [
      catalogEntry({
        providerType: 'openai',
        routeSurface: 'subscription',
        model: 'gpt-5.5',
        label: 'GPT-5.5',
      }),
    ];
    const userProfiles: ModelProfile[] = [
      {
        id: 'user-defined-codex-clone',
        name: 'My custom GPT-5.5',
        authSource: 'codex-subscription',
        model: 'gpt-5.5',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        createdAt: 0,
      },
    ];

    expect(dedupCatalogAgainstProfiles(catalog, userProfiles)).toEqual([]);
  });

  it('keeps catalog rows visible when only a connection-managed profile owns that composite key', () => {
    const codexCatalogEntry = catalogEntry({
      providerType: 'openai',
      routeSurface: 'subscription',
      model: 'gpt-5.5',
      label: 'GPT-5.5 (ChatGPT Pro)',
    });
    const openAiApiKeyCatalogEntry = catalogEntry({
      providerType: 'openai',
      routeSurface: 'api-key',
      model: 'gpt-5.5',
      label: 'GPT-5.5 (OpenAI API)',
    });
    const catalog = [codexCatalogEntry, openAiApiKeyCatalogEntry];
    const profiles = [
      profile({
        id: 'direct-openai',
        providerType: 'openai',
        routeSurface: 'api-key',
        model: 'gpt-5.5',
        profileSource: 'user',
      }),
      profile({
        id: 'connection-codex',
        providerType: 'openai',
        routeSurface: 'subscription',
        model: 'gpt-5.5',
        profileSource: 'connection',
      }),
    ];

    expect(dedupCatalogAgainstProfiles(catalog, profiles)).toEqual([codexCatalogEntry]);
  });
});
