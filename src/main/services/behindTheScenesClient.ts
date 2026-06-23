/**
 * Desktop (main-process) wrapper over the core Behind-The-Scenes client: the
 * central hub for non-user-facing LLM calls, adding per-call managed-key
 * injection and registering the managed-OpenRouter fallback provider.
 *
 * @see docs/project/LLM_CALL_SITES.md — central BTS call hub and call-site map
 * @see docs/project/MODEL_ROLES_AND_THINKING.md — Background/BTS + fast-runtime roles
 * @see docs/project/LOCAL_MODEL_SUPPORT.md — BTS routing and fallback behaviour
 */
import {
  callBehindTheScenes as callBehindTheScenesCore,
  callBehindTheScenesWithAuth as callBehindTheScenesWithAuthCore,
  callWithModelAuthAware as callWithModelAuthAwareCore,
  registerManagedKeyAvailability,
} from '@core/services/behindTheScenesClient';
import type { AppSettings } from '@shared/types';
import type { CodexConnectivity } from '@core/rebelCore/providerRouteDecision';
import type {
  BehindTheScenesRequestOptions,
  BehindTheScenesResponse,
  TrackingOptions,
} from '@core/services/behindTheScenesClient';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';
import { hasManagedOpenRouterKey } from './openRouterTokenStorage';

// Core BTS callers in src/core/* bypass this desktop wrapper. Keep wrapper-level
// per-call injection for defence-in-depth, and register this fallback provider
// so core-resident callers still get managed-key routing context.
registerManagedKeyAvailability(() => hasManagedOpenRouterKey());

export {
  callWithModel,
  extractJsonFromStructuredResponse,
  getEffectiveModelName,
  getProxyAuth,
  getProxyUrl,
  getWorkingProfileFallback,
  isTransientNetworkError,
  registerBtsProxyProviders,
  declareNoBtsProxy,
  registerPreOAuthCallHook,
  resolveProfileFromModel,
  stripThinkingBlocks,
} from '@core/services/behindTheScenesClient';
export type {
  BehindTheScenesRequestOptions,
  BehindTheScenesResponse,
  TrackingOptions,
} from '@core/services/behindTheScenesClient';

type DesktopBehindTheScenesRequestOptions =
  Omit<BehindTheScenesRequestOptions, 'codexConnectivity'>
  & { codexConnectivity?: CodexConnectivity };

function withDesktopCodexContext(options: DesktopBehindTheScenesRequestOptions): BehindTheScenesRequestOptions {
  return {
    ...options,
    codexConnectivity: options.codexConnectivity ?? resolveCodexConnectivity(),
  };
}

/** Inject desktop-only managed-key presence so provider routing resolves 'mindstone' correctly for BTS calls. */
function withManagedKeyContext(settings: AppSettings): AppSettings {
  return { ...settings, hasManagedKey: hasManagedOpenRouterKey() } as AppSettings;
}

export async function callBehindTheScenesWithAuth(
  settings: AppSettings,
  options: DesktopBehindTheScenesRequestOptions,
  tracking?: TrackingOptions
): Promise<BehindTheScenesResponse> {
  return callBehindTheScenesWithAuthCore(withManagedKeyContext(settings), withDesktopCodexContext(options), tracking);
}

export async function callBehindTheScenes(
  settings: AppSettings,
  options: DesktopBehindTheScenesRequestOptions,
  tracking?: TrackingOptions
): Promise<BehindTheScenesResponse> {
  return callBehindTheScenesCore(withManagedKeyContext(settings), withDesktopCodexContext(options), tracking);
}

export async function callWithModelAuthAware(
  settings: AppSettings,
  model: string | undefined,
  options: DesktopBehindTheScenesRequestOptions,
  tracking?: TrackingOptions
): Promise<BehindTheScenesResponse> {
  return callWithModelAuthAwareCore(withManagedKeyContext(settings), model, withDesktopCodexContext(options), tracking);
}
