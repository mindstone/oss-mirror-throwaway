import { assertNever, type ProviderCredentialSource, type ProviderRouteDecision } from './providerRouteDecision';
import type { ProviderRoutePlan } from './providerRoutePlanTypes';
import { headersToAnthropicCustomHeaders } from './providerRouteHeaders';
import type {
  AuthCredentialStatus,
  ProviderAuthEnvTuple,
  ProviderAuthEnvTuples,
  ProviderAuthPlan,
  ResolvedAuthLabel,
} from './providerAuthPlanTypes';

export type {
  AuthCredentialStatus,
  ProviderAuthEnvTuple,
  ProviderAuthEnvTuples,
  ProviderAuthPlan,
  ResolvedAuthLabel,
};

const MANAGED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
] satisfies ReadonlyArray<string>;

function sortedEnv(entries: ProviderAuthEnvTuples): ProviderAuthEnvTuples {
  return [...entries].sort(([left], [right]) => left.localeCompare(right));
}

function statusForSource(source: ProviderCredentialSource): AuthCredentialStatus {
  switch (source) {
    case 'local-none':
      return 'not-required';
    case 'missing-anthropic':
    case 'missing-openrouter':
    case 'missing-codex':
    case 'missing-profile':
      return 'unavailable';
    case 'anthropic-api-key':
    case 'anthropic-oauth-token':
    case 'openrouter-oauth-token':
    case 'mindstone-managed-key':
    case 'codex-subscription':
    case 'profile-api-key':
    case 'openai-api-key':
      return 'available';
    case 'missing-mindstone':
      return 'unavailable';
    default:
      return assertNever(source, 'ProviderCredentialSource');
  }
}

function runtimeApiKeyForSource(
  source: ProviderCredentialSource,
  values: {
    anthropicApiKey?: string | null;
    openAIApiKey?: string | null;
    profileApiKey?: string | null;
  },
): { apiKey: string | null; envKey: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | null } {
  switch (source) {
    case 'anthropic-api-key':
      return { apiKey: values.anthropicApiKey ?? null, envKey: 'ANTHROPIC_API_KEY' };
    case 'profile-api-key':
      return { apiKey: values.profileApiKey ?? null, envKey: 'ANTHROPIC_API_KEY' };
    case 'openai-api-key':
      return { apiKey: values.openAIApiKey ?? values.profileApiKey ?? null, envKey: 'OPENAI_API_KEY' };
    case 'local-none':
    case 'missing-anthropic':
    case 'missing-openrouter':
    case 'missing-mindstone':
    case 'missing-codex':
    case 'missing-profile':
    case 'anthropic-oauth-token':
    case 'openrouter-oauth-token':
    case 'mindstone-managed-key':
    case 'codex-subscription':
      return { apiKey: null, envKey: null };
    default:
      return assertNever(source, 'ProviderCredentialSource');
  }
}

export function deriveAuthPlan(decision: ProviderRouteDecision): ProviderAuthPlan {
  const credentialStatus = statusForSource(decision.credentialSource);
  switch (decision.credentialSource) {
    case 'codex-subscription':
    case 'missing-codex':
      return {
        kind: 'codex-subscription',
        resolvedAuthLabel: 'codex-subscription',
        credentialSource: decision.credentialSource,
        credentialStatus,
        accessToken: null,
        accountId: null,
        env: sortedEnv([['ANTHROPIC_API_KEY', '']]),
      };
    case 'openrouter-oauth-token':
    case 'missing-openrouter':
    case 'mindstone-managed-key':
    case 'missing-mindstone':
      return {
        kind: 'openrouter',
        resolvedAuthLabel: decision.credentialSource === 'mindstone-managed-key' || decision.credentialSource === 'missing-mindstone'
          ? 'mindstone-managed' : 'openrouter',
        credentialSource: decision.credentialSource,
        credentialStatus,
        oauthToken: null,
        env: sortedEnv([['ANTHROPIC_API_KEY', '']]),
      };
    case 'anthropic-oauth-token':
      return {
        kind: 'oauth-token',
        resolvedAuthLabel: 'oauth-token',
        credentialSource: decision.credentialSource,
        credentialStatus,
        oauthToken: null,
        env: sortedEnv([]),
      };
    case 'anthropic-api-key':
    case 'profile-api-key':
    case 'openai-api-key':
    case 'local-none':
    case 'missing-anthropic':
    case 'missing-profile':
      return {
        kind: 'api-key',
        resolvedAuthLabel: 'api-key',
        credentialSource: decision.credentialSource,
        credentialStatus,
        apiKey: null,
        env: sortedEnv([]),
      };
    default:
      return assertNever(decision.credentialSource, 'ProviderCredentialSource');
  }
}

export function withRuntimeAuth(
  auth: ProviderAuthPlan,
  values: {
    anthropicApiKey?: string | null;
    anthropicOAuthToken?: string | null;
    openRouterOAuthToken?: string | null;
    managedOpenRouterKey?: string | null;
    openAIApiKey?: string | null;
    profileApiKey?: string | null;
    codexAccessToken?: string | null;
    codexAccountId?: string | null;
  },
): ProviderAuthPlan {
  switch (auth.kind) {
    case 'api-key': {
      const { apiKey, envKey } = runtimeApiKeyForSource(auth.credentialSource, values);
      return {
        ...auth,
        apiKey,
        credentialStatus: apiKey ? 'available' : auth.credentialStatus,
        env: apiKey && envKey ? sortedEnv([[envKey, apiKey]]) : sortedEnv([]),
      };
    }
    case 'oauth-token': {
      const oauthToken = auth.credentialSource === 'anthropic-oauth-token' ? values.anthropicOAuthToken ?? null : null;
      return {
        ...auth,
        oauthToken,
        credentialStatus: oauthToken ? 'available' : auth.credentialStatus,
        env: oauthToken ? sortedEnv([['CLAUDE_CODE_OAUTH_TOKEN', oauthToken]]) : sortedEnv([]),
      };
    }
    case 'openrouter': {
      // Resolve the appropriate key based on credential source:
      // - Personal: use openRouterOAuthToken
      // - Managed (mindstone): use managedOpenRouterKey (fail-closed, never fall back to personal)
      const isManagedSource = auth.credentialSource === 'mindstone-managed-key' || auth.credentialSource === 'missing-mindstone';
      const oauthToken = isManagedSource
        ? (values.managedOpenRouterKey ?? null)
        : (auth.credentialSource === 'openrouter-oauth-token' ? values.openRouterOAuthToken ?? null : null);
      const env = oauthToken
        ? sortedEnv([['ANTHROPIC_API_KEY', ''], ['OPENROUTER_API_KEY', oauthToken]])
        : sortedEnv([]);
      return {
        ...auth,
        oauthToken,
        credentialStatus: oauthToken ? 'available' : auth.credentialStatus,
        env,
      };
    }
    case 'codex-subscription': {
      const accessToken = auth.credentialSource === 'codex-subscription' ? values.codexAccessToken ?? null : null;
      const accountId = auth.credentialSource === 'codex-subscription' ? values.codexAccountId ?? null : null;
      const env = accessToken
        ? sortedEnv([['ANTHROPIC_API_KEY', ''], ['CODEX_ACCESS_TOKEN', accessToken]])
        : sortedEnv([]);
      return {
        ...auth,
        accessToken,
        accountId,
        credentialStatus: accessToken ? 'available' : auth.credentialStatus,
        env,
      };
    }
    default:
      return assertNever(auth, 'ProviderAuthPlan');
  }
}

export function deriveResolvedAuthLabel(plan: ProviderAuthPlan | { auth: ProviderAuthPlan }): ResolvedAuthLabel {
  const auth = 'auth' in plan ? plan.auth : plan;
  return auth.resolvedAuthLabel;
}

function isManagedEnvKey(key: string): boolean {
  if (key.startsWith('CODEX_')) return true;
  return MANAGED_ENV_KEYS.includes(key);
}

export function applyAuthPlanToEnv(
  plan: ProviderRoutePlan,
  baseEnv: Record<string, string>,
): Record<string, string> {
  const nextEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!isManagedEnvKey(key)) {
      nextEnv[key] = value;
    }
  }
  for (const [key, value] of plan.auth.env) {
    nextEnv[key] = value;
  }
  if (plan.proxyBaseURL) {
    nextEnv.ANTHROPIC_BASE_URL = plan.proxyBaseURL;
  }
  if (plan.headers.length > 0) {
    nextEnv.ANTHROPIC_CUSTOM_HEADERS = headersToAnthropicCustomHeaders(plan.headers);
  }
  return nextEnv;
}
