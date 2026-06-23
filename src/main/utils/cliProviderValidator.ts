import type { AppSettings } from '@shared/types';
import type { ActiveProvider } from '@shared/types/settings';
import { validateProviderCredentials } from '@core/utils/validateProviderCredentials';
import { buildSettingsWithOverride } from '@main/services/turnPipeline/turnAdmission';

type ProviderValidationResult = { ok: true } | { ok: false; reason: string };

export function validateProviderFlag(args: {
  provider: ActiveProvider;
  rawSettings: AppSettings;
  codexConnected: boolean;
}): ProviderValidationResult {
  const settings = buildSettingsWithOverride(args.rawSettings, args.provider);
  const credentialState = validateProviderCredentials(settings, args.codexConnected);

  switch (credentialState.kind) {
    case 'anthropic':
      return credentialState.status === 'valid'
        ? { ok: true }
        : {
            ok: false,
            reason:
              'Anthropic is disconnected. Add an API key in Settings → AI & Models, or choose another provider.',
          };
    case 'openrouter':
      return credentialState.status === 'valid'
        ? { ok: true }
        : {
            ok: false,
            reason:
              'OpenRouter is disconnected. Reconnect it in Settings → AI & Models, or choose another provider.',
          };
    case 'codex':
      return credentialState.status === 'connected'
        ? { ok: true }
        : {
            ok: false,
            reason:
              'ChatGPT Pro is disconnected. Reconnect it in Settings → AI & Models, or choose another provider.',
          };
    case 'local':
      return { ok: true };
    case 'mindstone':
      return { ok: true };
    default: {
      const _exhaustive: never = credentialState;
      return {
        ok: false,
        reason: `Unsupported provider state. Check Settings → AI & Models. (${JSON.stringify(_exhaustive)})`,
      };
    }
  }
}
