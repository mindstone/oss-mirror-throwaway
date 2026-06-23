import type { ProviderRouteDecision } from './providerRouteDecision';
import type { ProviderRoutePlan } from './providerRoutePlan';

export type DirectAnthropicCapabilityResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'non-direct-provider'
        | 'proxy-dialect-model'
        | 'codex-active'
        | 'no-credentials'
        | 'codex-disconnected'
        | 'local-provider';
    };

function getDecision(input: ProviderRouteDecision | ProviderRoutePlan): ProviderRouteDecision {
  return 'decision' in input ? input.decision : input;
}

export function ensureDirectAnthropicCapable(
  input: ProviderRouteDecision | ProviderRoutePlan,
): DirectAnthropicCapabilityResult {
  const decision = getDecision(input);
  if (decision.provider === 'codex') {
    return decision.codexConnectivity === 'connected'
      ? { ok: false, reason: 'codex-active' }
      : { ok: false, reason: 'codex-disconnected' };
  }
  if (decision.provider === 'local') return { ok: false, reason: 'local-provider' };
  if (decision.transport === 'no-credentials' || decision.transport === 'fail-closed-codex-disconnected') {
    return { ok: false, reason: 'no-credentials' };
  }
  if (decision.transport !== 'anthropic-direct') return { ok: false, reason: 'non-direct-provider' };
  if (decision.modelDialect !== 'anthropic-native' || decision.wireModelId.includes('/')) {
    return { ok: false, reason: 'proxy-dialect-model' };
  }
  return { ok: true };
}
