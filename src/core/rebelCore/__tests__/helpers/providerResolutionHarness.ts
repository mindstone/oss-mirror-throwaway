import type { AppSettings, ModelProfile } from '@shared/types';
import type {
  CodexConnectivity,
  DispatchPath,
  ProviderCredentialSource,
  ProviderFallbackHint,
  ProviderRouteHeaderTuples,
  ProviderRouteProvider,
  ProviderRouteRole,
  ProviderRouteScope,
} from '../../providerRouteDecision';
import type { ProviderRouteRuntimeContext } from '../../providerRoutePlan';
import type { ProviderRoutePlanRequest } from '../../providerRouting';
import type { ProviderRoutePlan } from '../../providerRoutePlanTypes';
import { PROXY_HANDLES_AUTH_SENTINEL } from '../../proxyAuthContract';

export const PROXY_BASE_URL = 'http://127.0.0.1:48999';
export const PROXY_AUTH_TOKEN = 'proxy-auth-token';
export const CODEX_ACCESS_TOKEN = 'codex-access-token';
export const OPENROUTER_TOKEN = 'openrouter-test-token';
export const ANTHROPIC_KEY = 'anthropic-test-key';

export type CapturedClient = {
  readonly __clientKind: 'anthropic' | 'openai';
  readonly config: Record<string, unknown>;
};

export type AuthShape = 'proxy-sentinel' | 'real-key' | 'no-key';
export type ObservationStatus = 'client' | 'error';
export type MessageClass =
  | 'none'
  | 'missing-anthropic-credentials'
  | 'missing-anthropic-credentials-for-claude-model'
  | 'missing-openrouter-credentials'
  | 'missing-mindstone-credentials'
  | 'missing-codex-connection'
  | 'missing-profile-credentials'
  | 'codex-disconnected-bts-blocked'
  | 'codex-unsupported-model'
  | 'proxy-dialect-in-direct-anthropic'
  | 'unexpected-error';

export interface ObservableClientConfig {
  status: ObservationStatus;
  clientKind: 'anthropic' | 'openai' | 'none';
  routeProvider: ProviderRouteProvider | 'unknown';
  providerLabel: string | null;
  providerTypeLabel: string | null;
  credentialSource: ProviderCredentialSource | 'unknown';
  resolvedAuthLabel: string | null;
  authShape: AuthShape;
  baseURL: string | null;
  proxyBaseURL: string | null;
  endpointURL: string | null;
  defaultHeaders: Record<string, string>;
  wireModelId: string;
  dispatchPath: DispatchPath;
  maxRetries: number | null;
  enableContextManagement: boolean | null;
  enableCompact: boolean | null;
  errorKind: string | null;
  messageClass: MessageClass;
}

export interface RawCell {
  name: string;
  // 'dispatchable' = route-plan engine builds a client and snapshots the observation.
  // 'terminal'     = route-plan engine fails closed; assert terminal shape plus snapshot.
  // 'new-oracle'   = production already runs the route-plan path for this case; snapshot is the oracle.
  mode: 'dispatchable' | 'terminal' | 'new-oracle';
  kind?: ProviderRoutePlanRequest['kind'];
  settings: AppSettings;
  model?: string | null;
  role?: ProviderRouteRole;
  profile?: ModelProfile | null;
  routedModel?: string | null;
  routeScope?: ProviderRouteScope;
  codexConnectivity?: CodexConnectivity;
  category?: string | null;
  fallback?: {
    hint: ProviderFallbackHint;
    inFlightPlan: ProviderRoutePlan;
    routeProfile?: ModelProfile | null;
  };
  runtimeContext?: ProviderRouteRuntimeContext;
}

export type SettingsOverrides = Partial<AppSettings> & {
  hasManagedKey?: boolean;
  models?: Partial<NonNullable<AppSettings['models']>>;
};

export function modelSettings(
  overrides: Partial<NonNullable<AppSettings['models']>> = {},
): NonNullable<AppSettings['models']> {
  return {
    apiKey: ANTHROPIC_KEY,
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-20250514',
    permissionMode: 'plan',
    executablePath: null,
    planMode: true,
    extendedContext: false,
    thinkingEffort: 'high',
    ...overrides,
  };
}

export function settings(overrides: SettingsOverrides = {}): AppSettings {
  const models = modelSettings(overrides.models);
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    models,
    diagnostics: { debugBreadcrumbsUntil: null },
    openRouter: {
      enabled: overrides.activeProvider === 'openrouter' || overrides.activeProvider === 'mindstone',
      oauthToken: null,
      selectedModel: 'anthropic/claude-sonnet-4-6',
      ...overrides.openRouter,
    },
    activeProvider: overrides.activeProvider ?? 'anthropic',
    localModel: overrides.localModel ?? { activeProfileId: null, profiles: [] },
    providerKeys: overrides.providerKeys ?? {},
    customProviders: overrides.customProviders,
    experimental: overrides.experimental ?? { compactEnabled: false },
    hasManagedKey: overrides.hasManagedKey,
  } as unknown as AppSettings;
}

export function profile(overrides: Partial<ModelProfile>): ModelProfile {
  return {
    id: 'profile-1',
    name: 'Profile 1',
    providerType: 'other',
    serverUrl: 'https://example.test/v1',
    model: 'model-from-profile',
    apiKey: 'profile-test-key',
    enabled: true,
    createdAt: 1,
    ...overrides,
  };
}

export function headersObject(headers: ProviderRouteHeaderTuples): Record<string, string> {
  return Object.fromEntries([...headers].sort(([left], [right]) => left.localeCompare(right)));
}

export function commonProxyHeaders(): Record<string, string> {
  return {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
}

export function isCapturedClient(value: unknown): value is CapturedClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__clientKind' in value &&
    'config' in value
  );
}

export function authShapeFromConfig(config: Record<string, unknown>): AuthShape {
  if (config.apiKey === PROXY_HANDLES_AUTH_SENTINEL) return 'proxy-sentinel';
  if (typeof config.apiKey === 'string' && config.apiKey.length > 0) return 'real-key';
  if (typeof config.authToken === 'string' && config.authToken.length > 0) return 'real-key';
  if (config.codexMode) return 'real-key';
  return 'no-key';
}

export function classifyError(error: unknown): Pick<ObservableClientConfig, 'errorKind' | 'messageClass'> {
  const message = error instanceof Error ? error.message : String(error);
  const errorKind = typeof error === 'object' && error !== null && '__agentErrorKind' in error
    ? String((error as { __agentErrorKind?: unknown }).__agentErrorKind)
    : null;
  if (message.includes('No model provider configured') || message.includes('Anthropic API key')) {
    return { errorKind: errorKind ?? 'auth', messageClass: 'missing-anthropic-credentials' };
  }
  if (message.includes('requires an API key')) {
    return { errorKind: errorKind ?? 'auth', messageClass: 'missing-profile-credentials' };
  }
  if (message.includes('non-native model ID')) {
    return { errorKind: errorKind ?? 'routing', messageClass: 'proxy-dialect-in-direct-anthropic' };
  }
  return { errorKind, messageClass: 'unexpected-error' };
}

export function emptyObservation(overrides: Partial<ObservableClientConfig>): ObservableClientConfig {
  return {
    status: 'client',
    clientKind: 'none',
    routeProvider: 'unknown',
    providerLabel: null,
    providerTypeLabel: null,
    credentialSource: 'unknown',
    resolvedAuthLabel: null,
    authShape: 'no-key',
    baseURL: null,
    proxyBaseURL: null,
    endpointURL: null,
    defaultHeaders: {},
    wireModelId: '',
    dispatchPath: 'none',
    maxRetries: null,
    enableContextManagement: null,
    enableCompact: null,
    errorKind: null,
    messageClass: 'none',
    ...overrides,
  };
}
