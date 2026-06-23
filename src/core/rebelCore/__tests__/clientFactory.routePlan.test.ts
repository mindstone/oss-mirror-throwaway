import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import { brandRouteWireModel } from '@shared/utils/wireModelId';

const clientMocks = vi.hoisted(() => {
  class CapturedAnthropicClient {
    readonly __clientKind = 'anthropic' as const;
    constructor(readonly config: Record<string, unknown>) {}
  }

  class CapturedOpenAIClient {
    readonly __clientKind = 'openai' as const;
    constructor(readonly config: Record<string, unknown>) {}
  }

  return { CapturedAnthropicClient, CapturedOpenAIClient };
});

vi.mock('../clients/anthropicClient', () => ({
  AnthropicClient: clientMocks.CapturedAnthropicClient,
}));

vi.mock('../clients/openaiClient', () => ({
  OpenAIClient: clientMocks.CapturedOpenAIClient,
}));

import { createClientForModel, createClientFromRoutePlan } from '../clientFactory';
import { PROXY_HANDLES_AUTH_SENTINEL } from '../proxyAuthContract';
import type { ProviderRouteRuntimeContext } from '../providerRoutePlan';
import { resolveProviderRoutePlan, type ProviderRoutePlanRequest } from '../providerRouting';
import { isTerminalRoutePlan, type DispatchableRoutePlan, type TerminalRoutePlan } from '../providerRoutePlanTypes';

const PROXY_BASE_URL = 'http://127.0.0.1:48999';

function modelSettings(
  overrides: Partial<NonNullable<AppSettings['models']>> = {},
): NonNullable<AppSettings['models']> {
  return {
    apiKey: 'anthropic-test-key',
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

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
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
      selectedModel: 'anthropic/claude-sonnet-4.6',
      ...overrides.openRouter,
    },
    activeProvider: overrides.activeProvider ?? 'anthropic',
    localModel: overrides.localModel ?? { activeProfileId: null, profiles: [] },
    providerKeys: overrides.providerKeys ?? {},
    customProviders: overrides.customProviders,
    experimental: overrides.experimental,
  } as unknown as AppSettings;
}

function profile(overrides: Partial<ModelProfile>): ModelProfile {
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

async function dispatchablePlan(
  request: ProviderRoutePlanRequest,
  runtimeContext: ProviderRouteRuntimeContext = {},
): Promise<DispatchableRoutePlan> {
  const plan = await resolveProviderRoutePlan(request, runtimeContext);
  if (isTerminalRoutePlan(plan)) {
    throw new Error(`Expected dispatchable plan, got ${plan.decision.invalidReason}`);
  }
  return plan;
}

function expectAnthropicClient(client: unknown): InstanceType<typeof clientMocks.CapturedAnthropicClient> {
  expect(client).toBeInstanceOf(clientMocks.CapturedAnthropicClient);
  if (!(client instanceof clientMocks.CapturedAnthropicClient)) {
    throw new Error('Expected captured Anthropic client');
  }
  return client;
}

function expectOpenAIClient(client: unknown): InstanceType<typeof clientMocks.CapturedOpenAIClient> {
  expect(client).toBeInstanceOf(clientMocks.CapturedOpenAIClient);
  if (!(client instanceof clientMocks.CapturedOpenAIClient)) {
    throw new Error('Expected captured OpenAI client');
  }
  return client;
}

describe('createClientFromRoutePlan', () => {
  it('constructs codex-proxy through the proxy sentinel path', async () => {
    const appSettings = settings({
      activeProvider: 'codex',
      claude: modelSettings({ apiKey: null }),
    });
    const plan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: 'gpt-5.5',
        codexConnectivity: 'connected',
      },
    }, { proxyBaseURL: PROXY_BASE_URL, proxyAuthToken: 'proxy-token' });

    expect(plan.decision.transport).toBe('codex-proxy');
    const client = expectAnthropicClient(createClientFromRoutePlan(plan, appSettings));
    expect(client.config.apiKey).toBe(PROXY_HANDLES_AUTH_SENTINEL);
    expect(client.config.baseURL).toBe(PROXY_BASE_URL);
    expect(client.config.defaultHeaders).toMatchObject({ 'x-codex-turn': 'true' });
    expect(client.config.maxRetries).toBe(0);
  });

  it('constructs openrouter-proxy through the proxy sentinel path', async () => {
    const appSettings = settings({
      activeProvider: 'openrouter',
      claude: modelSettings({ apiKey: null }),
      openRouter: {
        enabled: true,
        oauthToken: 'openrouter-test-token',
        selectedModel: 'anthropic/claude-opus-4.7',
      },
    });
    const plan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: 'anthropic/claude-opus-4.7',
        codexConnectivity: 'unknown',
      },
    }, { proxyBaseURL: PROXY_BASE_URL, proxyAuthToken: 'proxy-token' });

    expect(plan.decision.transport).toBe('openrouter-proxy');
    const client = expectAnthropicClient(createClientFromRoutePlan(plan, appSettings));
    expect(client.config.apiKey).toBe(PROXY_HANDLES_AUTH_SENTINEL);
    expect(client.config.baseURL).toBe(PROXY_BASE_URL);
    expect(client.config.defaultHeaders).toMatchObject({ 'x-openrouter-turn': 'true' });
    expect(client.config.provider).toBe('OpenRouter');
  });

  it('constructs council route-table dispatch through the proxy sentinel path and strips provider identity headers', async () => {
    const appSettings = settings({
      activeProvider: 'openrouter',
      claude: modelSettings({ apiKey: null }),
      openRouter: {
        enabled: true,
        oauthToken: 'openrouter-test-token',
        selectedModel: 'anthropic/claude-opus-4.7',
      },
    });
    const plan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: 'working',
        routedModel: 'anthropic/claude-opus-4.7',
        routeScope: 'council',
        codexConnectivity: 'unknown',
      },
    }, {
      proxyBaseURL: PROXY_BASE_URL,
      proxyAuthToken: 'proxy-token',
      turnId: 'turn-council',
      routedModel: 'anthropic/claude-opus-4.7',
    });
    const pollutedPlan: DispatchableRoutePlan = {
      ...plan,
      headers: [...plan.headers, ['x-openrouter-turn', 'true']],
    };

    expect(pollutedPlan.decision.dispatchPath).toBe('local-proxy-route-table');
    const client = expectAnthropicClient(createClientFromRoutePlan(pollutedPlan, appSettings));
    expect(client.config.apiKey).toBe(PROXY_HANDLES_AUTH_SENTINEL);
    expect(client.config.baseURL).toBe(PROXY_BASE_URL);
    expect(client.config.defaultHeaders).toMatchObject({
      'x-routed-turn-id': 'turn-council',
      'x-routed-model': 'anthropic/claude-opus-4.7',
      'x-proxy-auth': 'proxy-token',
    });
    expect(client.config.defaultHeaders).not.toHaveProperty('x-openrouter-turn');
  });

  it('constructs ad-hoc route-table dispatch through the same proxy sentinel path', async () => {
    const appSettings = settings();
    const plan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: 'working',
        routedModel: 'claude-sonnet-4-20250514',
        routeScope: 'ad-hoc',
        codexConnectivity: 'unknown',
      },
    }, {
      proxyBaseURL: PROXY_BASE_URL,
      proxyAuthToken: 'proxy-token',
      turnId: 'turn-ad-hoc',
      routedModel: 'claude-sonnet-4-20250514',
    });

    expect(plan.decision.dispatchPath).toBe('local-proxy-route-table');
    const client = expectAnthropicClient(createClientFromRoutePlan(plan, appSettings));
    expect(client.config.apiKey).toBe(PROXY_HANDLES_AUTH_SENTINEL);
    expect(client.config.defaultHeaders).toMatchObject({
      'x-routed-turn-id': 'turn-ad-hoc',
      'x-routed-model': 'claude-sonnet-4-20250514',
      'x-proxy-auth': 'proxy-token',
    });
  });

  // WS1b non-equivalence guard (GPT-5.5 cross-family review): a route-table
  // dispatch can be materialized with a `proxyBaseURL` but NO `proxyAuthToken`
  // (the two runtime-context fields are orthogonal in materializePlanRuntime), so
  // `deriveHeaders`/`appendProxyIdentityHeaders` emit NEITHER `x-proxy-auth` nor
  // `x-routed-turn-id`. The OLD header-sniff (`!!x-routed-turn-id && !!x-proxy-auth`)
  // was therefore FALSE here → real Anthropic auth, not the proxy sentinel. The
  // verdict-derived path must mirror that exactly (NOT flip to the sentinel just
  // because dispatchPath is route-table). This pins the equivalence.
  it('route-table dispatch WITHOUT a proxy-auth token uses real Anthropic auth (no sentinel), matching the old header-sniff', async () => {
    const appSettings = settings(); // carries a real Anthropic key (anthropic-test-key)
    const plan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: 'working',
        routedModel: 'claude-sonnet-4-20250514',
        routeScope: 'ad-hoc',
        codexConnectivity: 'unknown',
      },
    }, {
      // proxyBaseURL set, but proxyAuthToken deliberately omitted → no route-table
      // identity headers are emitted (the representable "malformed" combo).
      proxyBaseURL: PROXY_BASE_URL,
      turnId: 'turn-no-auth',
      routedModel: 'claude-sonnet-4-20250514',
    });

    expect(plan.decision.dispatchPath).toBe('local-proxy-route-table');
    expect(plan.proxyBaseURL).toBe(PROXY_BASE_URL);
    // No proxy-auth headers were emitted (mirrors deriveHeaders' gate on proxyAuthToken).
    const headerKeys = plan.headers.map(([key]) => key);
    expect(headerKeys).not.toContain('x-proxy-auth');
    expect(headerKeys).not.toContain('x-routed-turn-id');

    const client = expectAnthropicClient(createClientFromRoutePlan(plan, appSettings));
    // OLD behaviour: proxyHandlesAuth=false → getAnthropicAuth → the real key,
    // NOT the proxy sentinel. The fixed verdict-derived path preserves this.
    expect(client.config.apiKey).not.toBe(PROXY_HANDLES_AUTH_SENTINEL);
    expect(client.config.apiKey).toBe('anthropic-test-key');
  });

  it('constructs cloud profile plans as OpenAI-compatible clients', async () => {
    const cloudProfile = profile({
      id: 'cloud-profile',
      name: 'Together',
      providerType: 'together',
      serverUrl: 'https://api.together.xyz/v1',
      model: 'deepseek-chat',
      apiKey: 'together-test-key',
    });
    const appSettings = settings({
      localModel: { activeProfileId: null, profiles: [cloudProfile] },
    });
    const plan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: 'deepseek-chat',
        profile: cloudProfile,
        codexConnectivity: 'unknown',
      },
    });

    expect(plan.decision.transport).toBe('openai-compatible-http');
    const client = expectOpenAIClient(createClientFromRoutePlan(plan, appSettings, { routeProfile: cloudProfile }));
    expect(client.config.baseURL).toBe('https://api.together.xyz/v1');
    expect(client.config.apiKey).toBe('together-test-key');
    expect(client.config.providerType).toBe('together');
  });

  it('constructs local profile plans as local OpenAI-compatible clients without remote auth', async () => {
    const localProfile = profile({
      id: 'local-profile',
      name: 'Local profile',
      providerType: 'local',
      serverUrl: 'http://localhost:11434/v1',
      model: 'llama-3.1-local',
      apiKey: undefined,
    });
    const appSettings = settings({
      claude: modelSettings({ apiKey: null }),
      localModel: { activeProfileId: null, profiles: [localProfile] },
    });
    const plan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: 'llama-3.1-local',
        profile: localProfile,
        codexConnectivity: 'unknown',
      },
    });

    expect(plan.decision.transport).toBe('local-openai-compatible-http');
    const client = expectOpenAIClient(createClientFromRoutePlan(plan, appSettings, { routeProfile: localProfile }));
    expect(client.config.baseURL).toBe('http://localhost:11434/v1');
    expect(client.config.apiKey).toBeUndefined();
  });

  // BILLING-CORRECTNESS (260621): the in-turn reroute sites (planning / adaptive
  // route / escalate / context-overflow fallback) reuse the ORIGINAL turn's
  // proxyConfig as the override while resolving a FRESH plan for a DIFFERENT route.
  // The override carries the PRIOR plan's `x-route-id` + `x-route-facts` together
  // (they self-consistently match), so a wholesale-override replay would PASS the
  // proxy's route-id binding and have it consume STALE billing facts (a personal
  // request charged to managed, or vice-versa). The fresh plan can't re-mint the
  // carrier authoritatively (createClientForModel lacks managed-key context), so the
  // stale carrier family MUST be DROPPED → the proxy re-derives (its fail-safe). The
  // dispatch markers (which pick the proxy handler) ARE refreshed from the fresh plan.
  it('DROPS the stale route-facts carrier when an override is reused (proxy re-derives; does NOT replay prior x-route-id/x-route-facts)', async () => {
    const appSettings = settings({
      activeProvider: 'openrouter',
      claude: modelSettings({ apiKey: null }),
      openRouter: {
        enabled: true,
        oauthToken: 'openrouter-test-token',
        selectedModel: 'anthropic/claude-opus-4.7',
      },
    });
    // PRIOR plan (a different route — different turn/routeId AND wire model). Its
    // headers stand in for the original turn's reused proxyConfig override.
    const priorPlan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: 'anthropic/claude-opus-4.7',
        codexConnectivity: 'unknown',
      },
    }, { proxyBaseURL: PROXY_BASE_URL, proxyAuthToken: 'proxy-token', turnId: 'turn-PRIOR', openRouterOAuthToken: 'openrouter-test-token' });
    const staleOverride = {
      baseURL: PROXY_BASE_URL,
      defaultHeaders: Object.fromEntries(priorPlan.headers),
    };
    expect(staleOverride.defaultHeaders['x-route-id']).toBe('turn-PRIOR');
    expect(staleOverride.defaultHeaders['x-route-facts']).toBeTruthy();

    // FRESH plan for a DIFFERENT route (different turn id → different routeId, and
    // a different wire model → different facts/digest).
    const freshPlan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: 'anthropic/claude-sonnet-4.6',
        codexConnectivity: 'unknown',
      },
    }, { proxyBaseURL: PROXY_BASE_URL, proxyAuthToken: 'proxy-token', turnId: 'turn-FRESH', openRouterOAuthToken: 'openrouter-test-token' });

    const client = expectAnthropicClient(
      createClientFromRoutePlan(freshPlan, appSettings, { proxyConfigOverride: staleOverride }),
    );
    const headers = client.config.defaultHeaders as Record<string, string>;
    expect(client.config.baseURL).toBe(PROXY_BASE_URL);
    // The stale route-facts CARRIER family is DROPPED (the proxy will re-derive
    // billing — its existing fail-safe — instead of consuming the stale facts).
    expect(headers).not.toHaveProperty('x-route-id');
    expect(headers).not.toHaveProperty('x-route-facts');
    expect(headers).not.toHaveProperty('x-route-wire-model');
    expect(headers).not.toHaveProperty('x-route-tag');
    // The dispatch markers are REFRESHED from the fresh plan (both are openrouter
    // passthrough here → x-openrouter-turn present and current).
    expect(headers['x-openrouter-turn']).toBe('true');
    // Transport/auth preserved from the override verbatim.
    expect(client.config.apiKey).toBe(PROXY_HANDLES_AUTH_SENTINEL);
    expect(headers['x-proxy-auth']).toBe('proxy-token');
  });

  // A reroute that CHANGES the dispatch class (passthrough → route-table) must drop
  // the stale passthrough marker (`x-openrouter-turn`) and adopt the route-table
  // markers — proving the marker REFRESH (not just the carrier drop) works.
  it('refreshes dispatch markers on override reuse: passthrough override → route-table fresh plan drops x-openrouter-turn', async () => {
    const appSettings = settings({
      activeProvider: 'openrouter',
      claude: modelSettings({ apiKey: null }),
      openRouter: {
        enabled: true,
        oauthToken: 'openrouter-test-token',
        selectedModel: 'anthropic/claude-opus-4.7',
      },
    });
    // Override from a passthrough route (carries x-openrouter-turn).
    const passthroughPlan = await dispatchablePlan({
      kind: 'forSubagent',
      input: { settings: appSettings, model: 'anthropic/claude-opus-4.7', codexConnectivity: 'unknown' },
    }, { proxyBaseURL: PROXY_BASE_URL, proxyAuthToken: 'proxy-token', turnId: 'turn-PT', openRouterOAuthToken: 'openrouter-test-token' });
    const override = { baseURL: PROXY_BASE_URL, defaultHeaders: Object.fromEntries(passthroughPlan.headers) };
    expect(override.defaultHeaders['x-openrouter-turn']).toBe('true');

    // Fresh plan is a route-table dispatch (council scope) — strips passthrough markers,
    // adds x-routed-turn-id/x-routed-model.
    const routeTablePlan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: 'working',
        routedModel: 'anthropic/claude-opus-4.7',
        routeScope: 'council',
        codexConnectivity: 'unknown',
      },
    }, { proxyBaseURL: PROXY_BASE_URL, proxyAuthToken: 'proxy-token', turnId: 'turn-RT', routedModel: 'anthropic/claude-opus-4.7', openRouterOAuthToken: 'openrouter-test-token' });
    expect(routeTablePlan.decision.dispatchPath).toBe('local-proxy-route-table');

    const client = expectAnthropicClient(
      createClientFromRoutePlan(routeTablePlan, appSettings, { proxyConfigOverride: override }),
    );
    const headers = client.config.defaultHeaders as Record<string, string>;
    // Stale passthrough marker dropped; route-table markers adopted from fresh plan.
    expect(headers).not.toHaveProperty('x-openrouter-turn');
    expect(headers['x-routed-turn-id']).toBe('turn-RT');
    expect(headers['x-routed-model']).toBe('anthropic/claude-opus-4.7');
    // Carrier still dropped.
    expect(headers).not.toHaveProperty('x-route-facts');
    expect(headers['x-proxy-auth']).toBe('proxy-token');
  });

  it('preserves direct Anthropic slash-dialect failure', async () => {
    const appSettings = settings();
    const plan: DispatchableRoutePlan = {
      decision: {
        kind: 'dispatchable',
        provider: 'anthropic',
        transport: 'anthropic-direct',
        dispatchPath: 'direct-provider',
        modelDialect: 'anthropic-native',
        role: 'subagent',
        routeScope: 'normal-turn',
        canonicalModelId: 'anthropic/claude-opus-4.7',
        wireModelId: brandRouteWireModel('anthropic/claude-opus-4.7'),
        profileId: null,
        resolvedFrom: 'settings',
        codexConnectivity: 'unknown',
        fallbackHint: null,
        credentialSource: 'anthropic-api-key',
        invalidReason: 'none',
      },
      auth: {
        kind: 'api-key',
        resolvedAuthLabel: 'api-key',
        credentialSource: 'anthropic-api-key',
        credentialStatus: 'available',
        apiKey: 'anthropic-test-key',
        env: [],
      },
      headers: [],
      proxyBaseURL: null,
      resolvedAuthLabel: 'api-key',
      proxyRequired: false,
      invalidReason: null,
    };

    // Stage 3 class-killer (memory-BTS route mismatch): a slash body model on a
    // non-passthrough Anthropic transport (here `anthropic-direct`) now fails closed
    // at the shared client-build SEAM with a CLASSIFIED routing error
    // (`__agentErrorKind:'routing'`), front-running the older `createDirectAnthropicClient`
    // wire-level `/non-native model ID/` throw. The fail-closed contract is preserved
    // (still throws before any wire request); the attribution is now correct/actionable.
    expect(() => createClientFromRoutePlan(plan, appSettings)).toThrow(/routing mismatch/);
    try {
      createClientFromRoutePlan(plan, appSettings);
      throw new Error('expected createClientFromRoutePlan to throw');
    } catch (err) {
      const e = err as Error & { __agentErrorKind?: string; __routingCause?: string };
      expect(e.__agentErrorKind).toBe('routing');
      expect(e.__routingCause).toBe('non-passthrough-anthropic-slash-body');
    }
  });
});

describe('createClientForModel legacy turn-router precedence is unaffected by the re-mint fix', () => {
  // The `x-openrouter-turn` legacy path (caller proxyConfig + no profile + Claude-ish
  // model) returns BEFORE the route-plan resolver — it never reaches
  // `requireProxyConfigFromRoutePlan` / `composeProxyConfigFromRoutePlan`, so the
  // re-mint fix must NOT touch it. The raw caller proxyConfig (with its
  // `x-openrouter-turn` identity) is passed through verbatim.
  it('x-openrouter-turn legacy path passes the caller proxyConfig headers through verbatim', async () => {
    const appSettings = settings({
      activeProvider: 'openrouter',
      claude: modelSettings({ apiKey: null }),
      openRouter: { enabled: true, oauthToken: 'openrouter-test-token', selectedModel: 'anthropic/claude-opus-4.7' },
    });
    const callerProxyConfig = {
      baseURL: PROXY_BASE_URL,
      defaultHeaders: {
        'x-openrouter-turn': 'true',
        'x-proxy-auth': 'proxy-token',
        'x-route-id': 'turn-legacy',
        'x-route-facts': 'rf1.legacy.facts',
      },
    };
    const client = expectAnthropicClient(
      await createClientForModel({
        model: 'anthropic/claude-opus-4.7', // Claude-ish → native-claude legacy arm
        settings: appSettings, // no profile → legacy precedence applies
        proxyConfig: callerProxyConfig,
        context: 'execution',
      }),
    );
    // Legacy path returns early: the raw caller headers (incl. x-openrouter-turn) are
    // used verbatim — NOT re-minted (no fresh plan exists on this branch).
    expect(client.config.defaultHeaders).toEqual(callerProxyConfig.defaultHeaders);
    expect(client.config.apiKey).toBe(PROXY_HANDLES_AUTH_SENTINEL);
  });
});

function routePlanCompileTimeContract(
  terminalPlan: TerminalRoutePlan,
  appSettings: AppSettings,
): void {
  // @ts-expect-error createClientFromRoutePlan only accepts dispatchable plans.
  createClientFromRoutePlan(terminalPlan, appSettings);
}

void routePlanCompileTimeContract;
