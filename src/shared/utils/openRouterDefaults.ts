/**
 * OpenRouter Default Model Settings
 *
 * Provides default model configuration when a user selects OpenRouter as their
 * provider. Sets up the recommended thinking, working, and background task models.
 * Follows the same pattern as codexDefaults.ts for consistency.
 *
 * @see docs/plans/260414_openrouter_default_model_update.md
 */

import type { AppSettings, LocalModelSettings } from '../types';
import { resolveModelSettings } from './modelSettingsResolver';
import {
  OR_DEFAULT_THINKING_MODEL,
  OR_DEFAULT_WORKING_MODEL,
  OR_DEFAULT_BTS_MODEL,
} from './providerDefaultConstants';

export { OR_DEFAULT_THINKING_MODEL, OR_DEFAULT_WORKING_MODEL, OR_DEFAULT_BTS_MODEL };

/**
 * Returns a partial settings object with OpenRouter-appropriate model defaults.
 *
 * IMPORTANT: Does NOT include the `openRouter` object to avoid overwriting
 * the OAuth token via dirty-key preservation during settings refresh races.
 * Callers must set `openRouter.enabled` and `openRouter.selectedModel`
 * separately (e.g. via individual updateDraft calls).
 */
export function applyOpenRouterModelDefaults(settings: AppSettings): Partial<AppSettings> {
  const currentModels = resolveModelSettings(settings);
  return {
    activeProvider: 'openrouter',
    // Setting a non-mindstone provider is an explicit opt-out from the managed
    // provider, so the /api/config reconcile (extractManagedProviderInfo) must
    // not re-activate Mindstone over it. This helper is the shared OpenRouter-
    // activation path: it's spread whole into updateSettings by the OpenRouter
    // connect flow (openRouterSetupService) and the provider-heal migration
    // (settingsStore.applyOpenRouterProviderHeal), so the marker covers both.
    // (planProviderSwitch.buildBaseUpdates only consumes this fn's `localModel`
    // and sets its own marker, so it is unaffected.)
    managedProviderDeactivated: true,
    models: {
      ...currentModels,
      model: OR_DEFAULT_WORKING_MODEL,
      thinkingModel: OR_DEFAULT_THINKING_MODEL,
      thinkingProfileId: undefined,
      workingProfileId: undefined,
    } as AppSettings['models'],
    behindTheScenesModel: OR_DEFAULT_BTS_MODEL,
    localModel: {
      ...(settings.localModel ?? { profiles: [], activeProfileId: null }),
      activeProfileId: null,
    } as LocalModelSettings,
  };
}
