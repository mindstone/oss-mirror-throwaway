/**
 * Provider Auth Plan — leaf type module.
 *
 * Contains `ProviderAuthPlan`, `ResolvedAuthLabel`, and supporting tuple
 * types only. No runtime code, no imports from `providerAuthPlan.ts` or
 * `providerRoutePlan.ts`, so downstream type-only consumers (notably
 * `providerRoutePlanTypes.ts`) can import without creating a runtime
 * circular dependency.
 *
 * Runtime helpers (`deriveAuthPlan`, `withRuntimeAuth`, `applyAuthPlanToEnv`)
 * live in `providerAuthPlan.ts` and re-export these types for backwards
 * compatibility with existing import sites.
 */

import type { ProviderCredentialSource } from './providerRouteDecision';

export type ResolvedAuthLabel = 'codex-subscription' | 'openrouter' | 'mindstone-managed' | 'api-key' | 'oauth-token';

export type AuthCredentialStatus = 'available' | 'unavailable' | 'not-required';

export type ProviderAuthEnvTuple = readonly [string, string];
export type ProviderAuthEnvTuples = ReadonlyArray<ProviderAuthEnvTuple>;

interface ProviderAuthPlanBase {
  resolvedAuthLabel: ResolvedAuthLabel;
  credentialSource: ProviderCredentialSource;
  credentialStatus: AuthCredentialStatus;
  env: ProviderAuthEnvTuples;
}

export type ProviderAuthPlan =
  | (ProviderAuthPlanBase & { kind: 'api-key'; apiKey: string | null })
  | (ProviderAuthPlanBase & { kind: 'oauth-token'; oauthToken: string | null })
  | (ProviderAuthPlanBase & { kind: 'openrouter'; oauthToken: string | null })
  | (ProviderAuthPlanBase & { kind: 'codex-subscription'; accessToken: string | null; accountId: string | null });
