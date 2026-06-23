import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CODEX_AUXILIARY_MODEL_OPTIONS, CODEX_MAIN_MODEL_OPTIONS } from '@shared/data/codexModels';
import { PROVIDER_CATALOGS, type CatalogEntry } from '@shared/data/providerCatalogs';
import { OR_ALL_MODEL_OPTIONS, OR_AUXILIARY_MODEL_OPTIONS, OR_MAIN_MODEL_OPTIONS } from '@shared/data/openRouterModels';
import { DEFAULT_LOCAL_MODEL_SETTINGS, type ActiveProvider, type AppSettings, type ModelProfile } from '@shared/types';
import type { RoleId } from '@shared/types/modelChoice';
import { CODEX_DEFAULT_MODEL, mergeCodexProfiles } from '@shared/utils/codexDefaults';
import { modelSupportsExtendedContext, MODEL_OPTIONS } from '@shared/utils/modelNormalization';
import { isProfileSelectable } from '@shared/utils/profileHelpers';
import { dedupCatalogAgainstProfiles } from '../../components/models/dedupCatalog';
import {
  assertSameMainCatalog,
  buildModelChoiceOptions,
  resetAssertSameMainCatalogStateForTests,
  type ModelChoiceOptionGroup,
  type ModelChoiceOptions,
} from '../buildModelChoiceOptions';

type RoleUnderTest = Extract<RoleId, 'working' | 'thinking' | 'background'>;

const selectableProfile: ModelProfile = {
  id: 'selectable-profile',
  name: 'Research Gateway',
  providerType: 'openai',
  serverUrl: 'https://gateway.example.com/v1',
  model: 'gpt-5.5',
  createdAt: 1,
};

const blankModelProfile: ModelProfile = {
  id: 'blank-model-profile',
  name: 'Blank Gateway',
  providerType: 'openai',
  serverUrl: 'https://gateway.example.com/v1',
  model: '',
  createdAt: 2,
};

const jsonIncompatibleProfile: ModelProfile = {
  id: 'json-incompatible-profile',
  name: 'No JSON Gateway',
  providerType: 'openai',
  serverUrl: 'https://gateway.example.com/v1',
  model: 'minimax/minimax-m2.7',
  jsonCompatibility: 'incompatible',
  createdAt: 3,
};

function makeSettings(profiles: ModelProfile[] = []): AppSettings {
  return {
    localModel: {
      ...DEFAULT_LOCAL_MODEL_SETTINGS,
      profiles,
    },
    providerKeys: {
      google: 'gemini-key',
    },
    openRouter: {
      oauthToken: 'or-token',
    },
    models: {
      apiKey: 'anthropic-key',
    },
  } as AppSettings;
}

function expectedAnthropicOptions(kind: 'main' | 'auxiliary' | 'all' | 'long-context') {
  switch (kind) {
    case 'main':
      return MODEL_OPTIONS
        .filter((model) => model.isMainModel)
        .map((model) => ({ value: model.value, label: model.label }));
    case 'auxiliary':
      return MODEL_OPTIONS
        .filter((model) => model.isAuxiliaryModel)
        .map((model) => ({
          value: model.value,
          label: model.auxiliaryHint ? `${model.label} ${model.auxiliaryHint}` : model.label,
        }));
    case 'all':
      return MODEL_OPTIONS.map((model) => ({ value: model.value, label: model.label }));
    case 'long-context':
      return MODEL_OPTIONS
        .filter((model) => modelSupportsExtendedContext(model.value))
        .map((model) => ({ value: model.value, label: model.label }));
  }
}

function expectedActiveProviderOptions(
  activeProvider: ActiveProvider | undefined,
  kind: 'main' | 'auxiliary' | 'all' | 'long-context' | 'none',
) {
  if (kind === 'none') return [];
  if (kind === 'long-context') return expectedAnthropicOptions(kind);

  if (activeProvider === 'codex') {
    switch (kind) {
      case 'main':
        return CODEX_MAIN_MODEL_OPTIONS.map((model) => ({ value: model.value, label: model.label }));
      case 'auxiliary':
        return CODEX_AUXILIARY_MODEL_OPTIONS.map((model) => ({ value: model.value, label: model.label }));
      case 'all':
        return [...CODEX_MAIN_MODEL_OPTIONS, ...CODEX_AUXILIARY_MODEL_OPTIONS].map((model) => ({
          value: model.value,
          label: model.label,
        }));
    }
  }

  if (activeProvider === 'openrouter') {
    switch (kind) {
      case 'main':
        return OR_MAIN_MODEL_OPTIONS.map((model) => ({ value: model.value, label: model.label }));
      case 'auxiliary':
        return OR_AUXILIARY_MODEL_OPTIONS.map((model) => ({ value: model.value, label: model.label }));
      case 'all':
        return OR_ALL_MODEL_OPTIONS.map((model) => ({ value: model.value, label: model.label }));
    }
  }

  return expectedAnthropicOptions(kind);
}

function expectedAdditionalGroups(
  activeProvider: ActiveProvider | undefined,
  hasClaudeFallback: boolean,
  kind: 'main' | 'auxiliary' | 'all' | 'long-context' | 'none',
): ModelChoiceOptionGroup[] {
  if (kind === 'none' || kind === 'long-context') return [];
  if (activeProvider === 'anthropic' || !hasClaudeFallback) return [];

  return [{
    label: 'Claude (API key)',
    options: expectedAnthropicOptions(kind),
  }];
}

function primaryKindForRole(role: RoleUnderTest): 'main' | 'auxiliary' {
  return role === 'background' ? 'auxiliary' : 'main';
}

function fallbackKindForRole(role: RoleUnderTest): 'all' | 'auxiliary' {
  return role === 'background' ? 'auxiliary' : 'all';
}

function connectedCatalogOptions(
  catalogs: Array<{ label: string; entries: readonly CatalogEntry[] }>,
  profiles: ModelProfile[],
) {
  return catalogs.flatMap((group) =>
    dedupCatalogAgainstProfiles(group.entries, profiles)
      .filter((entry) => entry.isMainModel)
      .map((entry) => ({
        value: entry.model,
        label: entry.label,
        group: group.label,
      })),
  );
}

describe('buildModelChoiceOptions', () => {
  // The role-symmetric invariant assertion (Stage 2-lite) keeps a
  // module-level cache of the most recent main-kind catalog per
  // (activeProvider, role). Reset between tests so cross-test divergence
  // doesn't bleed into the next test's helper invocation.
  beforeEach(() => {
    resetAssertSameMainCatalogStateForTests();
  });

  const activeProviderCases: Array<{
    providerName: string;
    activeProvider: ActiveProvider | undefined;
  }> = [
    { providerName: 'Codex active', activeProvider: 'codex' },
    { providerName: 'OpenRouter active', activeProvider: 'openrouter' },
    { providerName: 'Anthropic active', activeProvider: 'anthropic' },
    { providerName: 'no provider active', activeProvider: undefined },
  ];
  const fallbackCases = [
    { fallbackName: 'with Claude-via-fallback availability', hasClaudeFallback: true },
    { fallbackName: 'without Claude-via-fallback availability', hasClaudeFallback: false },
  ];
  const roles: RoleUnderTest[] = ['working', 'thinking', 'background'];

  it.each(
    activeProviderCases.flatMap((providerCase) =>
      roles.flatMap((role) =>
        fallbackCases.map((fallbackCase) => ({
          ...providerCase,
          ...fallbackCase,
          role,
        })),
      ),
    ),
  )(
    'matches legacy AgentsTab options for $providerName / $role / $fallbackName',
    ({ activeProvider, role, hasClaudeFallback }) => {
      const options = buildModelChoiceOptions({
        role,
        settings: makeSettings(),
        activeProvider,
        hasAnthropicCredentials: hasClaudeFallback,
        hasOpenRouterCredentials: false,
      });

      const primaryKind = primaryKindForRole(role);
      const fallbackKind = fallbackKindForRole(role);

      expect(options.catalogModels).toEqual(expectedActiveProviderOptions(activeProvider, primaryKind));
      expect(options.additionalModelGroups).toEqual(expectedAdditionalGroups(activeProvider, hasClaudeFallback, primaryKind));
      expect(options.fallbackCatalogModels).toEqual(expectedActiveProviderOptions(activeProvider, fallbackKind));
      expect(options.additionalFallbackGroups).toEqual(expectedAdditionalGroups(activeProvider, hasClaudeFallback, fallbackKind));
    },
  );

  it('preserves auxiliary-only fallback groups for background while working/thinking use all Claude fallback models', () => {
    const settings = makeSettings();
    const backgroundOptions = buildModelChoiceOptions({
      role: 'background',
      settings,
      activeProvider: 'codex',
      hasAnthropicCredentials: true,
      hasOpenRouterCredentials: false,
    });
    const workingOptions = buildModelChoiceOptions({
      role: 'working',
      settings,
      activeProvider: 'codex',
      hasAnthropicCredentials: true,
      hasOpenRouterCredentials: false,
    });

    const backgroundFallbackValues = backgroundOptions.additionalFallbackGroups?.[0]?.options.map((option) => option.value);
    const workingFallbackValues = workingOptions.additionalFallbackGroups?.[0]?.options.map((option) => option.value);

    expect(backgroundFallbackValues).toEqual(expectedAnthropicOptions('auxiliary').map((option) => option.value));
    expect(workingFallbackValues).toEqual(expectedAnthropicOptions('all').map((option) => option.value));
    expect(backgroundOptions.additionalFallbackGroups).not.toEqual(workingOptions.additionalFallbackGroups);
  });

  it('returns all profiles when AgentsTab-style consumers do not pass a profileFilter', () => {
    const profiles = [selectableProfile, blankModelProfile, jsonIncompatibleProfile];

    const options = buildModelChoiceOptions({
      role: 'working',
      settings: makeSettings(profiles),
      activeProvider: 'anthropic',
      hasAnthropicCredentials: true,
      hasOpenRouterCredentials: false,
    });

    expect(options.profiles.map((profile) => profile.id)).toEqual(profiles.map((profile) => profile.id));
  });

  it('applies a ConversationModelSelector-style routable profile filter without changing catalog dedup', () => {
    const profiles = [selectableProfile, blankModelProfile, jsonIncompatibleProfile];

    const options = buildModelChoiceOptions({
      role: 'working',
      settings: makeSettings(profiles),
      activeProvider: 'anthropic',
      hasAnthropicCredentials: true,
      hasOpenRouterCredentials: true,
      catalogMode: 'connected-providers',
      profileFilter: (profile) => !!profile.model?.trim() && isProfileSelectable(profile),
    });

    expect(options.profiles.map((profile) => profile.id)).toEqual([
      selectableProfile.id,
      jsonIncompatibleProfile.id,
    ]);
    expect(options.catalogModels).toEqual(connectedCatalogOptions([
      { label: 'OpenRouter', entries: PROVIDER_CATALOGS.openrouter },
      { label: 'Anthropic', entries: PROVIDER_CATALOGS.anthropic },
    ], profiles));
  });

  it('supports a BTS JSON-incompatibility profile filter for JSON-required task groups', () => {
    const options = buildModelChoiceOptions({
      role: 'background',
      taskGroup: 'safety',
      settings: makeSettings([selectableProfile, jsonIncompatibleProfile]),
      activeProvider: 'anthropic',
      hasAnthropicCredentials: true,
      hasOpenRouterCredentials: false,
      profileFilter: (profile) => profile.jsonCompatibility !== 'incompatible',
    });

    expect(options.catalogModels).toEqual(expectedAnthropicOptions('auxiliary'));
    expect(options.fallbackCatalogModels).toEqual(expectedAnthropicOptions('auxiliary'));
    expect(options.profiles.map((profile) => profile.id)).toEqual([selectableProfile.id]);
  });

  it('matches the legacy ConversationModelSelector connected-provider catalog order and labels', () => {
    const profiles = [selectableProfile];

    const options = buildModelChoiceOptions({
      role: 'working',
      settings: makeSettings(profiles),
      activeProvider: 'openrouter',
      hasCodexCredentials: true,
      hasOpenRouterCredentials: true,
      hasAnthropicCredentials: true,
      hasGeminiCredentials: true,
      catalogMode: 'connected-providers',
      profileFilter: (profile) => !!profile.model?.trim() && isProfileSelectable(profile),
    });

    expect(options.catalogModels).toEqual(connectedCatalogOptions([
      { label: 'ChatGPT Pro', entries: PROVIDER_CATALOGS.openai },
      { label: 'OpenRouter', entries: PROVIDER_CATALOGS.openrouter },
      { label: 'Anthropic', entries: PROVIDER_CATALOGS.anthropic },
      { label: 'Gemini', entries: PROVIDER_CATALOGS.google },
    ], profiles));
  });

  it('suppresses connected-provider catalog options when a materialised connection profile owns the same tuple', () => {
    const openRouterMainEntry = PROVIDER_CATALOGS.openrouter.find((entry) => entry.isMainModel);
    expect(openRouterMainEntry).toBeDefined();
    if (!openRouterMainEntry) throw new Error('Expected an OpenRouter main catalog entry');

    const materializedProfile: ModelProfile = {
      id: 'materialized-openrouter-profile',
      name: openRouterMainEntry.label,
      providerType: 'openrouter',
      routeSurface: 'pool',
      serverUrl: 'https://openrouter.ai/api/v1',
      model: openRouterMainEntry.model,
      createdAt: 1,
      enabled: true,
      profileSource: 'connection',
    };

    const options = buildModelChoiceOptions({
      role: 'working',
      settings: makeSettings([materializedProfile]),
      activeProvider: 'openrouter',
      hasOpenRouterCredentials: true,
      hasAnthropicCredentials: false,
      catalogMode: 'connected-providers',
      profileFilter: (profile) => !!profile.model?.trim() && isProfileSelectable(profile),
    });

    expect(options.profiles.map((profile) => profile.id)).toEqual([
      materializedProfile.id,
    ]);
    expect(
      options.catalogModels.find(
        (option) =>
          option.group === 'OpenRouter' &&
          option.value === openRouterMainEntry.model,
      ),
    ).toBeUndefined();
  });

  it('A2 dedup uses (providerType, routeSurface, model) — Codex catalog row hidden when a Codex-subscription profile shares the same key', () => {
    const codexAuxiliaryEntry = CODEX_AUXILIARY_MODEL_OPTIONS[0];
    expect(codexAuxiliaryEntry).toBeDefined();

    const codexProfile: ModelProfile = {
      id: 'codex-subscription-profile',
      name: 'Codex subscription mini',
      providerType: 'openai',
      routeSurface: 'subscription',
      authSource: 'codex-subscription',
      serverUrl: 'https://api.openai.com/v1',
      model: codexAuxiliaryEntry!.value,
      profileSource: 'connection',
      createdAt: 1,
    };

    const options = buildModelChoiceOptions({
      role: 'background',
      settings: makeSettings([codexProfile]),
      activeProvider: 'codex',
      hasAnthropicCredentials: false,
      hasOpenRouterCredentials: false,
    });

    expect(options.catalogModels.find((option) => option.value === codexAuxiliaryEntry!.value))
      .toBeUndefined();
  });

  it('A2 dedup uses (providerType, routeSurface, model) — Codex catalog row preserved when only an unrelated direct/custom OpenRouter profile shares the model id', () => {
    const codexAuxiliaryEntry = CODEX_AUXILIARY_MODEL_OPTIONS[0];
    expect(codexAuxiliaryEntry).toBeDefined();

    const unrelatedOpenRouterProfile: ModelProfile = {
      id: 'or-direct-profile',
      name: 'Direct OpenRouter route',
      providerType: 'openrouter',
      routeSurface: 'pool',
      serverUrl: 'https://openrouter.ai/api/v1',
      model: codexAuxiliaryEntry!.value,
      profileSource: 'user',
      createdAt: 1,
    };

    const options = buildModelChoiceOptions({
      role: 'background',
      settings: makeSettings([unrelatedOpenRouterProfile]),
      activeProvider: 'codex',
      hasAnthropicCredentials: false,
      hasOpenRouterCredentials: false,
    });

    expect(options.catalogModels.find((option) => option.value === codexAuxiliaryEntry!.value))
      .toBeDefined();
  });

  it('keeps recovery model options pinned to Claude extended-context models across active providers', () => {
    const settings = makeSettings();

    for (const activeProvider of ['codex', 'openrouter', 'anthropic', undefined] satisfies Array<ActiveProvider | undefined>) {
      const options = buildModelChoiceOptions({
        role: 'recovery',
        settings,
        activeProvider,
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: true,
      });

      expect(options.catalogModels).toEqual(expectedAnthropicOptions('long-context'));
      expect(options.fallbackCatalogModels).toEqual([]);
      expect(options.additionalModelGroups).toEqual([]);
      expect(options.additionalFallbackGroups).toEqual([]);
    }
  });

  // 260603 opus-4-8 working-dropdown bug: hidden settings-normalisation glue,
  // system-managed auto profiles, and disabled user profiles must NOT
  // suppress catalog rows — they don't render in the picker, so suppressing
  // would leave the model unreachable.
  describe('hidden / disabled / auto-managed profiles do not shadow catalog rows', () => {
    const OPUS_4_8 = 'claude-opus-4-8';

    const virtualThinkingProfile: ModelProfile = {
      id: '__virtual-thinking',
      name: 'Default thinking model',
      providerType: 'anthropic',
      serverUrl: '',
      model: OPUS_4_8,
      isVirtual: true,
      enabled: true,
      createdAt: 1,
    };

    const disabledOpusProfile: ModelProfile = {
      id: 'disabled-opus',
      name: 'My Opus',
      providerType: 'anthropic',
      serverUrl: '',
      model: OPUS_4_8,
      enabled: false,
      profileSource: 'user',
      createdAt: 2,
    };

    // Mirrors the auto-managed profile shape created by learnedLimitsMigration.ts
    // (non-virtual, profileSource: 'auto').
    const autoManagedOpusProfile: ModelProfile = {
      id: 'auto-managed-opus',
      name: 'Auto Opus',
      providerType: 'anthropic',
      serverUrl: '',
      model: OPUS_4_8,
      profileSource: 'auto',
      enabled: true,
      createdAt: 3,
    };

    const enabledConnectionManagedOpusProfile: ModelProfile = {
      id: 'connection-opus',
      name: 'Connection Opus',
      providerType: 'anthropic',
      routeSurface: 'api-key',
      serverUrl: '',
      model: OPUS_4_8,
      profileSource: 'connection',
      enabled: true,
      createdAt: 4,
    };

    it('Trigger A — virtual __virtual-thinking profile does NOT suppress opus-4-8 in working OR thinking', () => {
      const options = buildModelChoiceOptions({
        role: 'working',
        settings: makeSettings([virtualThinkingProfile]),
        activeProvider: 'anthropic',
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: false,
        profileFilter: (profile) => !profile.isVirtual,
      });
      const thinking = buildModelChoiceOptions({
        role: 'thinking',
        settings: makeSettings([virtualThinkingProfile]),
        activeProvider: 'anthropic',
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: false,
        profileFilter: (profile) => !profile.isVirtual,
      });

      expect(options.catalogModels.some((option) => option.value === OPUS_4_8)).toBe(true);
      expect(thinking.catalogModels.some((option) => option.value === OPUS_4_8)).toBe(true);
      expect(options.profiles.some((profile) => profile.id === virtualThinkingProfile.id)).toBe(false);
      expect(thinking.profiles.some((profile) => profile.id === virtualThinkingProfile.id)).toBe(false);
    });

    it('Trigger B — disabled user profile claiming opus-4-8 does NOT suppress catalog row', () => {
      const profileFilter = (profile: ModelProfile) => profile.enabled !== false;

      const working = buildModelChoiceOptions({
        role: 'working',
        settings: makeSettings([disabledOpusProfile]),
        activeProvider: 'anthropic',
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: false,
        profileFilter,
      });
      const thinking = buildModelChoiceOptions({
        role: 'thinking',
        settings: makeSettings([disabledOpusProfile]),
        activeProvider: 'anthropic',
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: false,
        profileFilter,
      });

      expect(working.catalogModels.some((option) => option.value === OPUS_4_8)).toBe(true);
      expect(thinking.catalogModels.some((option) => option.value === OPUS_4_8)).toBe(true);
      expect(working.profiles.some((profile) => profile.id === disabledOpusProfile.id)).toBe(false);
      expect(thinking.profiles.some((profile) => profile.id === disabledOpusProfile.id)).toBe(false);
    });

    it('Trigger C — connected-providers mode preserves opus-4-8 catalog row when only a virtual profile claims it', () => {
      const options = buildModelChoiceOptions({
        role: 'working',
        settings: makeSettings([virtualThinkingProfile]),
        activeProvider: 'anthropic',
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: false,
        catalogMode: 'connected-providers',
        profileFilter: (profile) =>
          !profile.isVirtual && !!profile.model?.trim() && isProfileSelectable(profile),
      });

      expect(
        options.catalogModels.find(
          (option) => option.group === 'Anthropic' && option.value === OPUS_4_8,
        ),
      ).toBeDefined();
      expect(options.profiles.some((profile) => profile.id === virtualThinkingProfile.id)).toBe(false);
    });

    it('Trigger C — connected-providers mode preserves opus-4-8 catalog row when only a disabled profile claims it', () => {
      const options = buildModelChoiceOptions({
        role: 'working',
        settings: makeSettings([disabledOpusProfile]),
        activeProvider: 'anthropic',
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: false,
        catalogMode: 'connected-providers',
        profileFilter: (profile) =>
          profile.enabled !== false && !!profile.model?.trim() && isProfileSelectable(profile),
      });

      expect(
        options.catalogModels.find(
          (option) => option.group === 'Anthropic' && option.value === OPUS_4_8,
        ),
      ).toBeDefined();
    });

    it('Trigger D — auto-managed (profileSource: "auto") non-virtual profile does NOT suppress catalog row', () => {
      const working = buildModelChoiceOptions({
        role: 'working',
        settings: makeSettings([autoManagedOpusProfile]),
        activeProvider: 'anthropic',
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: false,
      });
      const thinking = buildModelChoiceOptions({
        role: 'thinking',
        settings: makeSettings([autoManagedOpusProfile]),
        activeProvider: 'anthropic',
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: false,
      });

      expect(working.catalogModels.some((option) => option.value === OPUS_4_8)).toBe(true);
      expect(thinking.catalogModels.some((option) => option.value === OPUS_4_8)).toBe(true);
    });

    it('Trigger E — virtual Anthropic profile does not poison non-Anthropic active-provider catalogs (OpenRouter)', () => {
      const options = buildModelChoiceOptions({
        role: 'working',
        settings: makeSettings([virtualThinkingProfile]),
        activeProvider: 'openrouter',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: true,
      });

      expect(options.catalogModels).toEqual(expectedActiveProviderOptions('openrouter', 'main'));
    });

    it('Trigger E — virtual Anthropic profile does not poison non-Anthropic active-provider catalogs (Codex)', () => {
      const options = buildModelChoiceOptions({
        role: 'working',
        settings: makeSettings([virtualThinkingProfile]),
        activeProvider: 'codex',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexCredentials: true,
      });

      expect(options.catalogModels).toEqual(expectedActiveProviderOptions('codex', 'main'));
    });

    it('Non-regression — enabled connection-managed Anthropic profile STILL suppresses opus-4-8 catalog row (preserves 22ca6d90ce A2 fix)', () => {
      const options = buildModelChoiceOptions({
        role: 'working',
        settings: makeSettings([enabledConnectionManagedOpusProfile]),
        activeProvider: 'anthropic',
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: false,
      });

      expect(options.catalogModels.find((option) => option.value === OPUS_4_8)).toBeUndefined();
    });

    it('Trigger F — BTS task-group path: virtual profile does not suppress opus-4-8 in auxiliary catalog', () => {
      const options = buildModelChoiceOptions({
        role: 'background',
        taskGroup: 'safety',
        settings: makeSettings([virtualThinkingProfile]),
        activeProvider: 'anthropic',
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: false,
        profileFilter: (profile) => !profile.isVirtual,
      });

      expect(options.catalogModels.some((option) => option.value === OPUS_4_8)).toBe(true);
    });

    // 260604 refinement — Codex auto-profiles are intentionally user-visible
    // in the active-Codex picker when no connection-managed sibling exists.
    // The auto profile MUST shadow the matching ChatGPT Pro catalog row, or
    // the picker shows duplicate entries for the same model.
    it('Trigger G — Codex auto-profile (no connection-managed sibling) STILL suppresses the matching ChatGPT Pro catalog row when active', () => {
      const codexAutoProfiles = mergeCodexProfiles([]);

      const options = buildModelChoiceOptions({
        role: 'working',
        settings: makeSettings(codexAutoProfiles),
        activeProvider: 'codex',
        hasAnthropicCredentials: false,
        hasOpenRouterCredentials: false,
        hasCodexCredentials: true,
      });

      expect(
        options.catalogModels.find((option) => option.value === CODEX_DEFAULT_MODEL),
      ).toBeUndefined();
    });

    // 260604 refinement — caller-filtered profiles must not silently remove
    // catalog options. BTS task groups with `requiresJson: true` filter
    // `jsonCompatibility === 'incompatible'` profiles; before this fix the
    // suppression keyset still keyed off `allProfiles` and removed the
    // matching auxiliary catalog row, leaving the model unreachable.
    it('Trigger H — BTS JSON-required group: jsonCompatibility=incompatible profile does NOT suppress the auxiliary catalog row', () => {
      const jsonIncompatibleOpus: ModelProfile = {
        id: 'json-incompatible-opus',
        name: 'No JSON Opus',
        providerType: 'anthropic',
        routeSurface: 'api-key',
        serverUrl: '',
        model: OPUS_4_8,
        jsonCompatibility: 'incompatible',
        enabled: true,
        profileSource: 'user',
        createdAt: 5,
      };

      const options = buildModelChoiceOptions({
        role: 'background',
        taskGroup: 'safety',
        settings: makeSettings([jsonIncompatibleOpus]),
        activeProvider: 'anthropic',
        hasAnthropicCredentials: true,
        hasOpenRouterCredentials: false,
        profileFilter: (profile) => profile.jsonCompatibility !== 'incompatible',
      });

      expect(options.catalogModels.some((option) => option.value === OPUS_4_8)).toBe(true);
      expect(options.profiles.some((profile) => profile.id === jsonIncompatibleOpus.id)).toBe(false);
    });
  });

  // 260604 Stage 2-lite — recurrence backstop for the role-symmetric class of
  // bug. Working/Thinking share `catalogKindForRole === 'main'` for every
  // provider supported today, so divergent catalogModels between roles is
  // always a bug. The helper logs once per session per fingerprint so a
  // future regression surfaces in Sentry-captured renderer logs.
  describe('assertSameMainCatalog (role-symmetric invariant)', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    function buildResult(values: string[]): ModelChoiceOptions {
      return {
        catalogModels: values.map((value) => ({ value, label: value })),
        fallbackCatalogModels: [],
        profiles: [],
      };
    }

    beforeEach(() => {
      resetAssertSameMainCatalogStateForTests();
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('logs once when working and thinking diverge under the same provider+kind', () => {
      assertSameMainCatalog(buildResult(['claude-opus-4-8', 'claude-sonnet-4-6']), {
        activeProvider: 'anthropic',
        role: 'working',
      });
      assertSameMainCatalog(buildResult(['claude-sonnet-4-6']), {
        activeProvider: 'anthropic',
        role: 'thinking',
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[buildModelChoiceOptions] role-asymmetric catalog divergence',
        {
          workingOnly: ['claude-opus-4-8'],
          thinkingOnly: [],
          activeProvider: 'anthropic',
          kind: 'main',
        },
      );

      assertSameMainCatalog(buildResult(['claude-opus-4-8', 'claude-sonnet-4-6']), {
        activeProvider: 'anthropic',
        role: 'working',
      });
      assertSameMainCatalog(buildResult(['claude-sonnet-4-6']), {
        activeProvider: 'anthropic',
        role: 'thinking',
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('does not log when working and thinking are symmetric', () => {
      const symmetric = ['claude-opus-4-8', 'claude-sonnet-4-6'];
      assertSameMainCatalog(buildResult(symmetric), {
        activeProvider: 'anthropic',
        role: 'working',
      });
      assertSameMainCatalog(buildResult([...symmetric].reverse()), {
        activeProvider: 'anthropic',
        role: 'thinking',
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not log on a single-role call (only working ever produced)', () => {
      assertSameMainCatalog(buildResult(['claude-opus-4-8']), {
        activeProvider: 'anthropic',
        role: 'working',
      });
      assertSameMainCatalog(buildResult(['claude-sonnet-4-6']), {
        activeProvider: 'anthropic',
        role: 'working',
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('skips non-main kinds (background → kind=auxiliary, recovery → kind=long-context, role-only filter excludes both)', () => {
      assertSameMainCatalog(buildResult(['only-aux']), {
        activeProvider: 'anthropic',
        role: 'background',
      });
      assertSameMainCatalog(buildResult(['only-long']), {
        activeProvider: 'anthropic',
        role: 'recovery',
      });

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('logs separately for different (activeProvider, kind) fingerprints', () => {
      assertSameMainCatalog(buildResult(['anthropic-only']), {
        activeProvider: 'anthropic',
        role: 'working',
      });
      assertSameMainCatalog(buildResult([]), {
        activeProvider: 'anthropic',
        role: 'thinking',
      });
      assertSameMainCatalog(buildResult(['or-only']), {
        activeProvider: 'openrouter',
        role: 'working',
      });
      assertSameMainCatalog(buildResult([]), {
        activeProvider: 'openrouter',
        role: 'thinking',
      });

      expect(warnSpy).toHaveBeenCalledTimes(2);
      const calls = warnSpy.mock.calls.map((args: unknown[]) => (args[1] as { activeProvider: string }).activeProvider);
      expect(calls.sort()).toEqual(['anthropic', 'openrouter']);
    });
  });
});
