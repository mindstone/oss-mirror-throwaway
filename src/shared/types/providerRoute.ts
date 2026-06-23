/**
 * Shared provider-route identity axes.
 *
 * These are type-only vocabulary for routing decisions and dormant Phase-B
 * model routing config. Runtime route planning still lives in
 * `src/core/rebelCore/providerRouteDecision.ts`.
 */

export const PROVIDER_ROUTE_PROVIDERS = [
  'anthropic',
  'openrouter',
  'codex',
  'profile',
  'local',
] as const;

export type ProviderRouteProvider = typeof PROVIDER_ROUTE_PROVIDERS[number];

export type ProviderRouteTransport =
  | 'anthropic-direct'
  | 'anthropic-compatible-local-proxy'
  | 'openai-compatible-http'
  | 'local-openai-compatible-http'
  | 'codex-proxy'
  | 'openrouter-proxy'
  | 'no-credentials'
  | 'fail-closed-codex-disconnected';

export type DispatchableTransport = Exclude<
  ProviderRouteTransport,
  'no-credentials' | 'fail-closed-codex-disconnected'
>;

export type TerminalTransport = Extract<
  ProviderRouteTransport,
  'no-credentials' | 'fail-closed-codex-disconnected'
>;

export type ProviderModelDialect =
  | 'anthropic-native'
  | 'openrouter-prefixed'
  | 'openai-compatible'
  | 'profile-ref'
  | 'local-openai-compatible';

export const PROVIDER_CREDENTIAL_SOURCES = [
  'anthropic-api-key',
  'anthropic-oauth-token',
  'openrouter-oauth-token',
  'mindstone-managed-key',
  'codex-subscription',
  'profile-api-key',
  'openai-api-key',
  'local-none',
  'missing-anthropic',
  'missing-openrouter',
  'missing-mindstone',
  'missing-codex',
  'missing-profile',
] as const;

export type ProviderCredentialSource = typeof PROVIDER_CREDENTIAL_SOURCES[number];
