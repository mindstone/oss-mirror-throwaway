/**
 * Computes the plan for switching the active model provider: which settings to
 * update, which credential slots to clear vs. preserve, and the fallback choice.
 * Switching away from the managed provider writes the `managedProviderDeactivated`
 * opt-out marker — the load-bearing half of the reconcile invariant.
 *
 * @see docs/project/MANAGED_PROVIDER_LIFECYCLE.md — opt-out marker + reconcile invariant
 * @see docs/project/BILLING_AND_SUBSCRIPTION_TIERS.md — provider/billing models
 */
import { type ManagedDefaultModels } from '../types/managedProvider';
import {
  DEFAULT_LOCAL_MODEL_SETTINGS,
  DEFAULT_OPENROUTER_SETTINGS,
  type ActiveProvider,
  type AppSettings,
  type ModelProfile,
} from '../types';
import {
  applyCodexModelDefaults,
  CODEX_BTS_PROFILE_ID,
  CODEX_DEFAULT_MODEL,
  CODEX_WORKING_PROFILE_ID,
} from './codexDefaults';
import {
  applyOpenRouterModelDefaults,
  OR_DEFAULT_BTS_MODEL,
  OR_DEFAULT_THINKING_MODEL,
  OR_DEFAULT_WORKING_MODEL,
} from './openRouterDefaults';

import { DEFAULT_AUXILIARY_MODEL, DEFAULT_MODEL } from './modelNormalization';
import {
  getProviderKey,
  isCodexSubscriptionProfile,
  normalizeApiKey,
  resolveProfileApiKey,
} from './providerKeys';
import { isLoopbackRoutableProfile } from './profileHelpers';
import { stripStoredModelPrefix } from './modelChoiceCodec';
import { resolveModelSettings } from './settingsUtils';
import { toProviderSwitchProvider } from './modelIdClassifier';

export type ProviderSwitchPlan = {
  updates: Partial<AppSettings>;
  clearedSlots: Array<{ label: string; previousValue: string; reason: string }>;
  preservedSlots: Array<{ label: string; value: string }>;
};

type FallbackAssessment =
  | { routable: true }
  | { routable: false; reason: string };

type ModelSettingsLike = Partial<NonNullable<AppSettings['models']>>;

function isUsingOpenRouter(settings: AppSettings): boolean {
  // Mindstone managed mode also routes through OpenRouter
  if (settings.activeProvider === 'mindstone') return true;
  return !!(settings.openRouter?.oauthToken
    && (settings.openRouter?.enabled || settings.activeProvider === 'openrouter'));
}

/**
 * Infer the primary provider from a model identifier using simple prefix rules.
 *
 * Returns lowercase provider keys to match existing call sites in this module.
 * Callers that need Title-Case display form (e.g., for user-facing copy via
 * `humanizeAgentError` / `dispatchAgentErrorEvent`'s `provider` field) should
 * map the result to their preferred casing — see `agentMessageHandler.ts`.
 *
 * Exported so that downstream error-classification paths (e.g., the runtime
 * result path in `agentMessageHandler.ts`) can reuse the same inference rules
 * when deriving a `providerOverride` from the turn's selected model.
 */
export function inferProviderFromModelId(
  modelId: string,
): 'anthropic' | 'openai' | 'openrouter' | undefined {
  return toProviderSwitchProvider(modelId);
}

function getProfileMap(settings: AppSettings): Map<string, ModelProfile> {
  return new Map((settings.localModel?.profiles ?? []).map(profile => [profile.id, profile]));
}

function getThinkingSelection(settings: AppSettings): string | undefined {
  const modelSettings = resolveModelSettings(settings);
  if (modelSettings.thinkingProfileId) {
    return `profile:${modelSettings.thinkingProfileId}`;
  }
  return modelSettings.thinkingModel;
}

function getWorkingSelection(settings: AppSettings): string | undefined {
  const modelSettings = resolveModelSettings(settings);
  if (modelSettings.workingProfileId) {
    return `profile:${modelSettings.workingProfileId}`;
  }
  return modelSettings.model;
}

function getBackgroundSelection(settings: AppSettings): string | undefined {
  // NOTE: returns raw stored value (may be 'model:<id>'). Consumed only by
  // canUsePrimaryProvider / assessFallbackRoutability for write-time cleanup;
  // NOT a wire egress. Do NOT decode here — the routability judges need the
  // raw form to detect prefixed legacy storage. See
  // docs/plans/260518_bts_model_prefix_decoder_phase2a.md § Research Notes.
  return settings.behindTheScenesModel;
}

function isCodexPrimaryProfile(
  value: string,
  profileMap: Map<string, ModelProfile>,
): boolean {
  if (!value.startsWith('profile:')) {
    return false;
  }

  const profileId = value.slice('profile:'.length);
  const profile = profileMap.get(profileId);
  return !!profile && isCodexSubscriptionProfile(profile);
}

function canUsePrimaryProvider(
  value: string | undefined,
  to: ActiveProvider,
  profileMap: Map<string, ModelProfile>,
): boolean {
  if (!value) {
    return false;
  }

  switch (to) {
    case 'anthropic':
      return !value.startsWith('profile:') && value.startsWith('claude-');
    case 'openrouter':
      return !value.startsWith('profile:') && value.includes('/');
    case 'codex':
      return isCodexPrimaryProfile(value, profileMap) || (!value.startsWith('profile:') && value.startsWith('gpt-'));
    case 'mindstone':
      // Model selection for the Mindstone managed-subscription provider is
      // server-driven (the allowed catalog is delivered via /api/config).
      // Always force the mindstone defaults rather than reusing whatever the
      // user previously had configured for another provider.
      return false;
  }
}

function assessProfileRoutability(
  profile: ModelProfile | undefined,
  settings: AppSettings,
  codexConnected: boolean,
): FallbackAssessment {
  if (!profile) {
    return { routable: false, reason: 'missing-profile' };
  }

  if (isLoopbackRoutableProfile(profile)) {
    return { routable: true };
  }

  if (resolveProfileApiKey(profile, settings.providerKeys, settings.customProviders)) {
    return { routable: true };
  }

  if (profile.providerType === 'openrouter') {
    return settings.openRouter?.oauthToken
      ? { routable: true }
      : { routable: false, reason: 'no-openrouter-credentials' };
  }

  if (profile.providerType === 'openai') {
    if (isCodexSubscriptionProfile(profile)) {
      return codexConnected
        ? { routable: true }
        : { routable: false, reason: 'codex-disconnected' };
    }

    return getProviderKey(settings, 'openai')
      ? { routable: true }
      : { routable: false, reason: 'no-openai-credentials' };
  }

  return { routable: false, reason: 'no-profile-credentials' };
}

function assessFallbackRoutability(
  rawValue: string,
  settings: AppSettings,
  codexConnected: boolean,
  to: ActiveProvider,
  targetSettings: AppSettings,
  options?: { treatAsProfileId?: boolean },
): FallbackAssessment {
  const sourceProfileMap = getProfileMap(settings);
  const profileMap = getProfileMap(targetSettings);
  const profileId = options?.treatAsProfileId
    ? rawValue
    : rawValue.startsWith('profile:')
      ? rawValue.slice('profile:'.length)
      : undefined;

  if (profileId) {
    return assessProfileRoutability(
      profileMap.get(profileId) ?? sourceProfileMap.get(profileId),
      targetSettings,
      codexConnected,
    );
  }

  const modelId = stripStoredModelPrefix(rawValue) ?? rawValue;
  const provider = inferProviderFromModelId(modelId);

  if (provider === 'openrouter') {
    return targetSettings.openRouter?.oauthToken
      ? { routable: true }
      : { routable: false, reason: 'no-openrouter-credentials' };
  }

  if (provider === 'anthropic') {
    return normalizeApiKey(resolveModelSettings(targetSettings).apiKey)
      ? { routable: true }
      : { routable: false, reason: 'no-anthropic-credentials' };
  }

  if (provider === 'openai') {
    if (to === 'codex' && codexConnected) {
      return { routable: true };
    }
    if (isUsingOpenRouter(targetSettings)) {
      return { routable: true };
    }
    return { routable: false, reason: 'no-bts-openai-routing' };
  }

  return { routable: false, reason: 'no-route' };
}

function projectTargetSettings(
  settings: AppSettings,
  updates: Partial<AppSettings>,
): AppSettings {
  const currentModels = resolveModelSettings(settings);
  return {
    ...settings,
    ...updates,
    models: updates.models
      ? {
          ...currentModels,
          ...updates.models,
        } as AppSettings['models']
      // eslint-disable-next-line no-restricted-properties -- Provider-switch projection intentionally preserves the existing canonical models block when no model patch is present.
      : settings.models,
  };
}

function getAnthropicDefaults(settings: AppSettings): Partial<AppSettings> {
  const modelSettings = resolveModelSettings(settings);
  return {
    models: {
      ...modelSettings,
      model: DEFAULT_MODEL,
      thinkingModel: undefined,
      thinkingProfileId: undefined,
      workingProfileId: undefined,
    } as AppSettings['models'],
    behindTheScenesModel: DEFAULT_AUXILIARY_MODEL,
    localModel: settings.localModel?.activeProfileId
      ? {
          ...(settings.localModel ?? DEFAULT_LOCAL_MODEL_SETTINGS),
          activeProfileId: null,
        }
      : undefined,
  };
}

function buildBaseUpdates(to: ActiveProvider, settings: AppSettings): Partial<AppSettings> {
  const openRouter =
    to === 'openrouter'
      ? {
          ...(settings.openRouter ?? DEFAULT_OPENROUTER_SETTINGS),
          enabled: true,
          selectedModel: settings.openRouter?.selectedModel || DEFAULT_OPENROUTER_SETTINGS.selectedModel,
        }
      : settings.openRouter
        ? { ...settings.openRouter, enabled: false }
        : undefined;

  const updates: Partial<AppSettings> = {
    activeProvider: to,
    // Record the user's managed-provider intent so the /api/config reconcile
    // (extractManagedProviderInfo) doesn't auto-reactivate Mindstone after a
    // deliberate switch away — or keep it deactivated after switching back.
    // Switching TO mindstone clears the opt-out; switching to anything else sets it.
    managedProviderDeactivated: to !== 'mindstone',
    ...(openRouter ? { openRouter } : {}),
  };

  if (to === 'codex') {
    const codexDefaults = applyCodexModelDefaults(settings);
    if (codexDefaults.localModel) {
      updates.localModel = codexDefaults.localModel;
    }
    if (codexDefaults.providerKeys) {
      updates.providerKeys = codexDefaults.providerKeys;
    }
    return updates;
  }

  if (to === 'openrouter') {
    const openRouterDefaults = applyOpenRouterModelDefaults(settings);
    if (openRouterDefaults.localModel) {
      updates.localModel = openRouterDefaults.localModel;
    }
    return updates;
  }

  if (to === 'mindstone') {
    // Mindstone is a managed-subscription provider — billing is server-side
    // and the allowed-model catalog is delivered via /api/config. Clear any
    // local profile selection (mirroring codex which is also subscription-
    // backed) so the user's prior local-profile choice doesn't leak through.
    if (settings.localModel?.activeProfileId) {
      updates.localModel = {
        ...settings.localModel,
        activeProfileId: null,
      };
    }
    return updates;
  }

  const anthropicDefaults = getAnthropicDefaults(settings);
  if (anthropicDefaults.localModel) {
    updates.localModel = anthropicDefaults.localModel;
  }
  return updates;
}

function getDefaultValues(
  to: ActiveProvider,
  managedDefaults?: ManagedDefaultModels,
): {
  thinking: { thinkingModel?: string; thinkingProfileId?: string };
  working: { model: string; workingProfileId?: string };
  background: { behindTheScenesModel: string };
} {
  if (to === 'codex') {
    return {
      thinking: {
        thinkingModel: undefined,
        thinkingProfileId: undefined,
      },
      working: {
        model: CODEX_DEFAULT_MODEL,
        workingProfileId: CODEX_WORKING_PROFILE_ID,
      },
      background: {
        behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}`,
      },
    };
  }

  if (to === 'openrouter') {
    return {
      thinking: {
        thinkingModel: OR_DEFAULT_THINKING_MODEL,
        thinkingProfileId: undefined,
      },
      working: {
        model: OR_DEFAULT_WORKING_MODEL,
        workingProfileId: undefined,
      },
      background: {
        behindTheScenesModel: OR_DEFAULT_BTS_MODEL,
      },
    };
  }

  if (to === 'mindstone') {
    // Mindstone routes through OpenRouter. When the server has delivered
    // tier-specific defaults via /api/config (managedDefaults), prefer them
    // per role; otherwise fall back to the same OR defaults the BYO
    // OpenRouter path uses. Partial managedDefaults (e.g. working+thinking
    // but no bts) is supported — each role falls through independently.
    return {
      thinking: {
        thinkingModel: managedDefaults?.thinking ?? OR_DEFAULT_THINKING_MODEL,
        thinkingProfileId: undefined,
      },
      working: {
        model: managedDefaults?.working ?? OR_DEFAULT_WORKING_MODEL,
        workingProfileId: undefined,
      },
      background: {
        behindTheScenesModel: managedDefaults?.bts ?? OR_DEFAULT_BTS_MODEL,
      },
    };
  }

  return {
    thinking: {
      thinkingModel: undefined,
      thinkingProfileId: undefined,
    },
    working: {
      model: DEFAULT_MODEL,
      workingProfileId: undefined,
    },
    background: {
      behindTheScenesModel: DEFAULT_AUXILIARY_MODEL,
    },
  };
}

export function planProviderSwitch(args: {
  to: ActiveProvider;
  settings: AppSettings;
  codexConnected: boolean;
  managedDefaults?: ManagedDefaultModels;
}): ProviderSwitchPlan {
  const { to, settings, codexConnected, managedDefaults } = args;

  if (settings.activeProvider === to) {
    return {
      updates: {},
      clearedSlots: [],
      preservedSlots: [],
    };
  }

  const profileMap = getProfileMap(settings);
  const updates = buildBaseUpdates(to, settings);
  const targetSettings = projectTargetSettings(settings, updates);
  const defaultValues = getDefaultValues(to, managedDefaults);
  // Managed-subscription providers write server-selected defaults into primary
  // slots, so those values should not be carried to a different provider.
  const sourceIsManagedSubscriptionProvider =
    settings.activeProvider === 'mindstone' || settings.activeProvider === 'codex';
  const shouldReusePrimarySelection = (value: string | undefined): boolean =>
    !sourceIsManagedSubscriptionProvider && canUsePrimaryProvider(value, to, profileMap);
  const modelUpdates: ModelSettingsLike = {};
  let hasModelUpdates = false;

  const setModelUpdates = (next: ModelSettingsLike): void => {
    Object.assign(modelUpdates, next);
    hasModelUpdates = true;
  };

  if (!shouldReusePrimarySelection(getThinkingSelection(settings))) {
    setModelUpdates(defaultValues.thinking);
  }

  if (!shouldReusePrimarySelection(getWorkingSelection(settings))) {
    setModelUpdates(defaultValues.working);
  }

  if (!shouldReusePrimarySelection(getBackgroundSelection(settings))) {
    updates.behindTheScenesModel = defaultValues.background.behindTheScenesModel;
  }

  const clearedSlots: ProviderSwitchPlan['clearedSlots'] = [];
  const preservedSlots: ProviderSwitchPlan['preservedSlots'] = [];

  const handleFallback = (
    label: string,
    value: string | undefined,
    applyClear: () => void,
    options?: { treatAsProfileId?: boolean },
  ): void => {
    if (!value) {
      return;
    }

    const assessment = assessFallbackRoutability(
      value,
      settings,
      codexConnected,
      to,
      targetSettings,
      options,
    );
    if (assessment.routable) {
      preservedSlots.push({ label, value });
      return;
    }

    applyClear();
    clearedSlots.push({
      label,
      previousValue: value,
      reason: assessment.reason,
    });
  };

  const modelSettings = resolveModelSettings(settings);
  handleFallback('Thinking fallback', modelSettings.thinkingFallback, () => {
    setModelUpdates({ thinkingFallback: undefined });
  });
  handleFallback('Working fallback', modelSettings.workingFallback, () => {
    setModelUpdates({ workingFallback: undefined });
  });
  handleFallback('Background fallback', settings.backgroundFallback, () => {
    updates.backgroundFallback = undefined;
  });
  handleFallback('Local inference cloud fallback', settings.localInferenceCloudFallback, () => {
    updates.localInferenceCloudFallback = undefined;
  });
  handleFallback('Long-context fallback model', modelSettings.longContextFallbackModel, () => {
    setModelUpdates({ longContextFallbackModel: undefined });
  });
  handleFallback(
    'Long-context fallback profile',
    modelSettings.longContextFallbackProfileId,
    () => {
      setModelUpdates({ longContextFallbackProfileId: undefined });
    },
    { treatAsProfileId: true },
  );

  if (settings.behindTheScenesOverrides) {
    const nextOverrides: NonNullable<AppSettings['behindTheScenesOverrides']> = {};
    for (const [group, value] of Object.entries(settings.behindTheScenesOverrides)) {
      if (!value) continue;
      const assessment = assessFallbackRoutability(
        value,
        settings,
        codexConnected,
        to,
        targetSettings,
      );
      if (assessment.routable) {
        nextOverrides[group as keyof typeof nextOverrides] = value;
        preservedSlots.push({ label: `Background override (${group})`, value });
        continue;
      }

      clearedSlots.push({
        label: `Background override (${group})`,
        previousValue: value,
        reason: assessment.reason,
      });
    }

    const nextKeys = Object.keys(nextOverrides);
    updates.behindTheScenesOverrides = nextKeys.length > 0 ? nextOverrides : undefined;
  }

  if (hasModelUpdates) {
    updates.models = {
      ...modelSettings,
      ...modelUpdates,
    } as AppSettings['models'];
  }

  return {
    updates,
    clearedSlots,
    preservedSlots,
  };
}

/**
 * Short-form provider label for the provider-switch confirmation toast and
 * other equally short surfaces ("Switched to X.", "Now using X.").
 *
 * Returns subscription product brand for ChatGPT (`ChatGPT Pro`), bare
 * `Mindstone` for Mindstone-managed routing, and company/platform name for BYO providers (`OpenRouter`,
 * `Anthropic`) — keeping symmetry with the rest of the renderer, which
 * consistently uses `'Anthropic'` (not `'Claude'`) for direct API key access.
 *
 * Note: this helper is intentionally tier-agnostic. Surfaces that need a
 * tier-aware label (e.g., "Mindstone Rogue") render the tier separately —
 * see `AgentsTab.tsx`'s `activeProviderLabel`.
 */
export function formatActiveProviderLabel(provider: ActiveProvider): string {
  switch (provider) {
    case 'codex':
      return 'ChatGPT Pro';
    case 'mindstone':
      return 'Mindstone';
    case 'openrouter':
      return 'OpenRouter';
    case 'anthropic':
      return 'Anthropic';
  }
}

/**
 * Pick the best available provider after disconnecting the given one.
 * Returns undefined if no provider remains connected.
 *
 * Priority: codex > openrouter > anthropic
 * (matches the recommended-first card order in Settings UI)
 */
export function pickFallbackProvider(args: {
  disconnecting: ActiveProvider;
  hasAnthropicKey: boolean;
  hasOpenRouterToken: boolean;
  codexConnected: boolean;
}): ActiveProvider | undefined {
  const candidates: Array<{ provider: ActiveProvider; connected: boolean }> = [
    { provider: 'codex', connected: args.codexConnected },
    { provider: 'openrouter', connected: args.hasOpenRouterToken },
    { provider: 'anthropic', connected: args.hasAnthropicKey },
  ];
  return candidates
    .filter(c => c.provider !== args.disconnecting && c.connected)
    .map(c => c.provider)[0];
}
