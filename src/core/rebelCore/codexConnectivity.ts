import { getCodexAuthProvider } from '@core/codexAuth';
import type { CodexConnectivity } from './providerRouteDecision';

export const CODEX_CONNECTIVITY_UNKNOWN: CodexConnectivity = 'unknown';

export type ResolvedCodexConnectivity = Extract<CodexConnectivity, 'connected' | 'disconnected'>;

export function resolveCodexConnectivity(isConnected = getCodexAuthProvider().isConnected()): ResolvedCodexConnectivity {
  return isConnected ? 'connected' : 'disconnected';
}
