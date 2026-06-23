import type { AppSettings, ModelProfile } from '@shared/types/settings';
import { getWorkingModelProfile } from '@shared/types/settings';
import { isLoopbackRoutableProfile } from '@shared/utils/profileHelpers';
import { resolveProfileApiKey } from '@shared/utils/providerKeys';
import { getApiKey } from '@core/rebelCore/settingsAccessors';
import type { AgentErrorKind } from '@shared/utils/agentErrorCatalog';

export type ProviderCredentialState =
  | { kind: 'anthropic'; status: 'valid'; apiKey: string }
  | { kind: 'anthropic'; status: 'missing' }
  | { kind: 'openrouter'; status: 'valid'; oauthToken: string }
  | { kind: 'openrouter'; status: 'missing' }
  | { kind: 'mindstone'; status: 'valid' }
  | { kind: 'codex'; status: 'connected'; profile: ModelProfile | null }
  | { kind: 'codex'; status: 'disconnected' }
  | { kind: 'local'; status: 'valid'; profile: ModelProfile };

/**
 * The not-connected / not-configured subset of {@link ProviderCredentialState}:
 * states where the provider was never reachable because no credential/connection
 * exists locally. These are the only states the admission gate fails closed on,
 * and — critically — none represents a *live server rejection*. (The genuine
 * 401 path is classified separately in `agentMessageHandler`.)
 */
export type UnconfiguredCredentialState = Extract<
  ProviderCredentialState,
  { status: 'missing' | 'disconnected' }
>;

/**
 * Pure, exhaustive map from a not-connected/not-configured credential state to
 * its user-facing `AgentErrorKind`.
 *
 * KILL-BY-CONSTRUCTION: the return type is the literal `'connection-not-configured'`
 * — a not-connected/missing state CANNOT be tagged `'auth'` ("rejected the
 * credentials"), because that lie was the incident
 * (docs/plans/260608_fix-disconnected-provider-toast). The `never` exhaustiveness
 * guard forces any future unconfigured state to make a deliberate classification
 * choice rather than silently inheriting the wrong label.
 */
export function credentialStateToErrorKind(
  state: UnconfiguredCredentialState,
): Extract<AgentErrorKind, 'connection-not-configured'> {
  switch (state.kind) {
    case 'anthropic':
    case 'openrouter':
    case 'codex':
      return 'connection-not-configured';
    default: {
      const _exhaustive: never = state;
      void _exhaustive;
      return 'connection-not-configured';
    }
  }
}

const sanitizeCredential = (value: string | null | undefined): string =>
  value?.replace(/\s/g, '') ?? '';

export function validateProviderCredentials(
  settings: AppSettings,
  codexConnected: boolean,
): ProviderCredentialState {
  const profile = getWorkingModelProfile(settings);

  if (profile && isLoopbackRoutableProfile(profile)) {
    return { kind: 'local', status: 'valid', profile };
  }

  switch (settings.activeProvider) {
    case 'codex':
      return codexConnected
        ? { kind: 'codex', status: 'connected', profile: profile ?? null }
        : { kind: 'codex', status: 'disconnected' };
    case 'openrouter': {
      const oauthToken = sanitizeCredential(settings.openRouter?.oauthToken);
      return oauthToken
        ? { kind: 'openrouter', status: 'valid', oauthToken }
        : { kind: 'openrouter', status: 'missing' };
    }
    case 'mindstone':
      // Mindstone managed subscription: credential validity is always true at
      // this level. Actual managed-key presence is checked fail-closed at
      // execution time (agentTurnExecutor + proxy).
      return { kind: 'mindstone', status: 'valid' };
    case 'anthropic':
    case undefined:
    default: {
      const directApiKey =
        sanitizeCredential(getApiKey(settings)) ||
        sanitizeCredential(process.env.ANTHROPIC_API_KEY) ||
        resolveProfileApiKey(profile ?? {}, settings.providerKeys, settings.customProviders) ||
        '';

      return directApiKey
        ? { kind: 'anthropic', status: 'valid', apiKey: directApiKey }
        : { kind: 'anthropic', status: 'missing' };
    }
  }
}
