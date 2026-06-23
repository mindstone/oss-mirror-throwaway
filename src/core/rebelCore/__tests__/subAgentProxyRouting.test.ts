import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { brandRouteWireModel } from '@shared/utils/wireModelId';
/**
 * Sub-Agent Proxy Routing Tests
 *
 * Verifies that executeAgentTool correctly materializes plan-backed proxy config
 * for council/ad-hoc routed subagents based on the routingMode field
 * (set by queryOptionsBuilder at the type boundary).
 *
 * Proxy-routed agents use model: 'working' (resolves to user's working-tier
 * Claude model via resolveModelAlias). The actual target model/provider is
 * carried via routed-model metadata + headers.
 *
 * See: docs/plans/260407_explicit_routing_metadata_for_agent_defs.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentToolContext } from '../types';
import type { AppSettings } from '@shared/types';

// ---- hoisted mocks ----
// We need the real route planner, but spy on createClientFromRoutePlan to capture
// the dispatchable plan that sub-agent dispatch receives.
const { mockRunAgentLoop, mockCreateClientFromRoutePlan } = vi.hoisted(() => ({
  mockRunAgentLoop: vi.fn(),
  mockCreateClientFromRoutePlan: vi.fn().mockReturnValue({}),
}));

vi.mock('../agentLoop', () => ({
  runAgentLoop: mockRunAgentLoop,
}));

vi.mock('../hookPipeline', () => ({
  runSubagentStartHooks: vi.fn().mockResolvedValue(undefined),
  runSubagentStopHooks: vi.fn().mockResolvedValue(undefined),
  createHookAwareToolExecutor: vi.fn().mockImplementation((base: unknown) => base),
}));

vi.mock('../builtinTools', () => ({
  getBuiltinToolDefinitions: vi.fn().mockReturnValue([]),
  isBuiltinToolName: vi.fn().mockReturnValue(false),
  executeBuiltinTool: vi.fn(),
  GET_MISSION_CONTEXT_TOOL_DEFINITION: {
    name: 'GetMissionContext',
    description: 'Get mission context',
    input_schema: { type: 'object', properties: {} },
  },
  SUMMARIZE_RESULT_TOOL_DEFINITION: {
    name: 'SummarizeResult',
    description: 'Summarize result',
    input_schema: { type: 'object', properties: {} },
  },
}));

vi.mock('../mcpClient', () => ({
  isMcpToolName: vi.fn().mockReturnValue(false),
}));

vi.mock('../taskState', () => ({
  createScopedTaskStore: vi.fn().mockReturnValue({
    listTasks: vi.fn().mockReturnValue([]),
    createTask: vi.fn(),
  }),
  createTaskStore: vi.fn().mockReturnValue({
    listTasks: vi.fn().mockReturnValue([]),
    createTask: vi.fn(),
  }),
}));

vi.mock('../modelLimits', () => ({
  shouldSuppressProfileReasoning: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => profile?.thinkingCompatibility === 'incompatible',
  resolveProfileReasoningEffort: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => (profile?.thinkingCompatibility === 'incompatible' ? undefined : profile?.reasoningEffort),
  resolveThinkingConfig: vi.fn().mockReturnValue({ type: 'disabled' }),
  resolveEffortForApi: vi.fn().mockReturnValue(undefined),
  resolveModelLimits: vi.fn().mockReturnValue({ contextWindow: 200_000, maxOutputTokens: 64_000 }),
}));

// Partial mock: real routing functions, spy on createClientFromRoutePlan
vi.mock('../clientFactory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../clientFactory')>();
  return {
    ...actual,
    createClientFromRoutePlan: mockCreateClientFromRoutePlan,
  };
});

// Import after mocks
import { executeAgentTool } from '../agentTool';
import type { SubAgentDispatchDescriptor } from '../agentTool';
import { ProviderRouter } from '../providerRouting';
import type { DispatchableRouteDecision, TerminalRouteDecision } from '../providerRouteDecision';
import type { DispatchableRoutePlan } from '../providerRoutePlanTypes';

if (false) {
  type RouteTablePlan = DispatchableRoutePlan & { readonly __planBinding: 'route-table' };
  type OpenRouterPlan = DispatchableRoutePlan & { readonly __planBinding: 'openrouter' };
  const routeTableDispatch = null as unknown as SubAgentDispatchDescriptor<RouteTablePlan>;
  const openRouterDispatch = null as unknown as SubAgentDispatchDescriptor<OpenRouterPlan>;

  const samePlanDispatch: SubAgentDispatchDescriptor<RouteTablePlan> = {
    ...routeTableDispatch,
    bodyModel: routeTableDispatch.bodyModel,
  };
  void samePlanDispatch;

  const divergentDispatch: SubAgentDispatchDescriptor<RouteTablePlan> = {
    ...routeTableDispatch,
    // @ts-expect-error client/bodyModel must carry the same DispatchableRoutePlan binding.
    bodyModel: openRouterDispatch.bodyModel,
  };
  void divergentDispatch;
}

// ---- helpers ----

function makeMinimalSettings(): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    models: {
      apiKey: 'fake-ant-test',
      oauthToken: null,
      authMethod: 'api-key' as const,
      model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
      permissionMode: 'plan' as const,
      executablePath: null,
      planMode: true,
      extendedContext: false,
      thinkingModel: undefined,
      workingProfileId: null,
      thinkingProfileId: null,
      behindTheScenesModel: undefined,
    },
    diagnostics: { enabled: false },
    localModel: { profiles: [], activeProfileId: null },
  } as unknown as AppSettings;
}

function makeOpenRouterSettings(): AppSettings {
  return {
    ...makeMinimalSettings(),
    activeProvider: 'openrouter',
    openRouter: {
      enabled: true,
      oauthToken: 'or-oauth-test',
      selectedModel: 'anthropic/claude-sonnet-4.5',
    },
  } as unknown as AppSettings;
}

function makeCodexSettings(): AppSettings {
  return {
    ...makeMinimalSettings(),
    activeProvider: 'codex',
  } as unknown as AppSettings;
}

function makeNoCredentialSettings(): AppSettings {
  const base = makeMinimalSettings();
  return {
    ...base,
    models: {
      ...base.models,
      apiKey: null,
      oauthToken: null,
      authMethod: 'api-key',
    },
  } as unknown as AppSettings;
}

function capturedPlan(): DispatchableRoutePlan {
  return mockCreateClientFromRoutePlan.mock.calls[0][0];
}

// The body model agentTool streams to the client (runAgentLoop config.model).
function capturedRunAgentLoopModel(): string {
  return mockRunAgentLoop.mock.calls[0][0].model as string;
}

function capturedRunAgentLoopClient(): unknown {
  return mockRunAgentLoop.mock.calls[0][0].client;
}

function capturedCreatedClient(): unknown {
  return mockCreateClientFromRoutePlan.mock.results[0]?.value;
}

function expectRunAgentLoopUsesCreatedClient(): void {
  expect(capturedRunAgentLoopClient()).toBe(capturedCreatedClient());
}

function makeOpenRouterForeignSettings(): AppSettings {
  return {
    ...makeMinimalSettings(),
    activeProvider: 'openrouter',
    openRouter: {
      enabled: true,
      oauthToken: 'or-oauth-test',
      selectedModel: 'openai/gpt-5.5',
    },
  } as unknown as AppSettings;
}

function makeMindstoneForeignSettings(): AppSettings {
  return {
    ...makeMinimalSettings(),
    activeProvider: 'mindstone',
    // Managed-key availability is injected at call time (not persisted); set it
    // so selectProviderMode's mindstone arm resolves to mindstone-managed-key
    // instead of failing closed on missing-mindstone.
    hasManagedKey: true,
    openRouter: {
      enabled: true,
      oauthToken: 'or-oauth-test',
      selectedModel: 'openai/gpt-5.5',
    },
  } as unknown as AppSettings;
}

function capturedHeaders(plan: DispatchableRoutePlan): Record<string, string> {
  return Object.fromEntries(plan.headers);
}

function makeTerminalSubagentDecision(
  overrides: Partial<TerminalRouteDecision> = {},
): TerminalRouteDecision {
  return {
    kind: 'terminal',
    provider: 'anthropic',
    transport: 'no-credentials',
    dispatchPath: 'none',
    modelDialect: 'anthropic-native',
    role: 'subagent',
    routeScope: 'council',
    routedModel: null,
    canonicalModelId: 'claude-sonnet-4-20250514',
    wireModelId: brandRouteWireModel('claude-sonnet-4-20250514'),
    profileId: null,
    resolvedFrom: 'settings',
    codexConnectivity: 'unknown',
    fallbackHint: null,
    credentialSource: 'missing-anthropic',
    invalidReason: 'missing-anthropic-credentials',
    ...overrides,
  };
}

function makeRouteTableDispatchableDecision(
  overrides: Partial<DispatchableRouteDecision> = {},
): DispatchableRouteDecision {
  return {
    kind: 'dispatchable',
    provider: 'anthropic',
    transport: 'anthropic-compatible-local-proxy',
    dispatchPath: 'local-proxy-route-table',
    modelDialect: 'anthropic-native',
    role: 'subagent',
    routeScope: 'ad-hoc',
    routedModel: 'openai/gpt-5.5',
    canonicalModelId: 'working',
    wireModelId: brandRouteWireModel('working'),
    profileId: null,
    resolvedFrom: 'settings',
    codexConnectivity: 'unknown',
    fallbackHint: null,
    credentialSource: 'anthropic-api-key',
    invalidReason: 'none',
    ...overrides,
  };
}

const COUNCIL_ROUTE_PROMPT = `You are a GPT-5.5 High Thinking reviewer.
Review the following code changes for correctness.`;

const STANDARD_PROMPT = 'You are a code reviewer.\nFollow best practices.';

function makeCtx(overrides: {
  agentPrompt?: string;
  agentModel?: string;
  agentRoutedModel?: string;
  routingMode?: 'council' | 'ad-hoc' | 'subagent';
  proxyConfig?: AgentToolContext['proxyConfig'];
  settings?: AppSettings;
  turnId?: string;
  codexConnectivity?: AgentToolContext['codexConnectivity'];
  trackingTaskId?: string;
  onTaskRoutingMetadataUpdate?: AgentToolContext['onTaskRoutingMetadataUpdate'];
} = {}): AgentToolContext {
  return {
    agents: {
      reviewer: {
        description: 'Reviews code',
        prompt: overrides.agentPrompt ?? STANDARD_PROMPT,
        model: (overrides.agentModel ?? 'working') as 'working',
        ...(overrides.agentRoutedModel ? { routedModel: overrides.agentRoutedModel } : {}),
        ...(overrides.routingMode ? { routingMode: overrides.routingMode } : {}),
      },
    },
    client: {} as AgentToolContext['client'],
    settings: overrides.settings ?? makeMinimalSettings(),
    parentModel: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
    depth: 0,
    proxyConfig: overrides.proxyConfig,
    turnId: overrides.turnId ?? 'turn-abc',
    codexConnectivity: overrides.codexConnectivity ?? 'unknown',
    ...(overrides.onTaskRoutingMetadataUpdate
      ? { onTaskRoutingMetadataUpdate: overrides.onTaskRoutingMetadataUpdate }
      : {}),
  } as AgentToolContext;
}

describe('Sub-agent proxy routing for council/ad-hoc routed subagents', () => {
  beforeEach(() => {
    mockRunAgentLoop.mockReset();
    mockCreateClientFromRoutePlan.mockReset();
    mockRunAgentLoop.mockResolvedValue(undefined);
    mockCreateClientFromRoutePlan.mockReturnValue({});
  });

  it('council-routed subagent: forwards full proxyConfig including baseURL and defaultHeaders', async () => {
    const proxyConfig = {
      baseURL: 'http://localhost:12345',
      defaultHeaders: { 'x-routed-turn-id': 'turn-abc', 'x-proxy-auth': 'proxy-token' },
    };
    const ctx = makeCtx({
      agentPrompt: COUNCIL_ROUTE_PROMPT,
      agentModel: 'working',
      routingMode: 'council',
      proxyConfig,
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    const plan = capturedPlan();
    expect(plan.decision).toMatchObject({
      kind: 'dispatchable',
      transport: 'anthropic-compatible-local-proxy',
      dispatchPath: 'local-proxy-route-table',
    });
    expect(plan.proxyBaseURL).toBe('http://localhost:12345');
    expect(capturedHeaders(plan)).toMatchObject({
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-routed-turn-id': 'turn-abc',
      'x-routed-model': 'claude-sonnet-4-20250514',
      'x-proxy-auth': 'proxy-token',
    });
  });

  it('ad-hoc-routed subagent: forwards plan-backed proxyConfig with routingMode ad-hoc', async () => {
    const proxyConfig = {
      baseURL: 'http://localhost:12345',
      defaultHeaders: { 'x-proxy-auth': 'proxy-token' },
    };
    const adHocPrompt = `You are an ad-hoc OpenAI model runner.
Execute the given task.`;
    const ctx = makeCtx({
      agentPrompt: adHocPrompt,
      agentModel: 'working',
      routingMode: 'ad-hoc',
      proxyConfig,
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Do research' }, ctx);

    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    const plan = capturedPlan();
    expect(plan.proxyBaseURL).toBe('http://localhost:12345');
    expect(capturedHeaders(plan)).toEqual({
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-routed-turn-id': 'turn-abc',
      'x-routed-model': 'claude-sonnet-4-20250514',
      'x-proxy-auth': 'proxy-token',
      // WS1b-2 proxy integrity-gate headers (additive). routeId = turnId on the
      // route-table path; x-route-wire-model = the decision's wireModelId.
      'x-route-id': 'turn-abc',
      'x-route-tag': 'rt1.621b3fde58aafb73edd0c526710459fd62ce6693d5d3adbc10f96c54fb7f3e3e',
      'x-route-wire-model': 'working',
      // WS4a signed fact-carrier (additive). HMAC-signed over the 8 RouteTagFacts,
      // keyed on the shared x-proxy-auth secret ('proxy-token'); emitted because a
      // proxyAuthToken is present on this proxy route.
      'x-route-facts': 'rf1.eyJyb3V0ZUlkIjoidHVybi1hYmMiLCJwcm92aWRlciI6ImFudGhyb3BpYyIsInRyYW5zcG9ydCI6ImFudGhyb3BpYy1jb21wYXRpYmxlLWxvY2FsLXByb3h5Iiwid2lyZU1vZGVsSWQiOiJ3b3JraW5nIiwiY3JlZGVudGlhbFNvdXJjZSI6ImFudGhyb3BpYy1hcGkta2V5IiwiYmlsbGluZ1NvdXJjZSI6InBheS1wZXItdXNlIiwicm9sZSI6InN1YmFnZW50IiwicHJvZmlsZUlkIjpudWxsfQ.YNTQkN9haOpCSqE9CDCah9i95MP2Dzl_msNet2Q9eDc',
    });
  });

  it('non-routed subagent with "working" alias: uses standard plan routing', async () => {
    const proxyConfig = {
      baseURL: 'http://localhost:12345',
      defaultHeaders: { 'x-routed-turn-id': 'turn-abc' },
    };
    const ctx = makeCtx({
      agentPrompt: STANDARD_PROMPT,
      agentModel: 'working',
      // No routingMode → standard routing
      proxyConfig,
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    const plan = capturedPlan();
    // Without council/ad-hoc routingMode, the ProviderRoutePlan decides whether
    // this sub-agent needs a proxy. Anthropic-native working-tier subagents do not.
    expect(plan.decision.transport).toBe('anthropic-direct');
  });

  it('missing proxy config: route-table dispatch fails closed', async () => {
    const ctx = makeCtx({
      agentPrompt: COUNCIL_ROUTE_PROMPT,
      agentModel: 'working',
      routingMode: 'council',
      proxyConfig: undefined,
    });
    mockCreateClientFromRoutePlan.mockImplementationOnce(() => {
      throw new Error('Sub-agent route resolved to anthropic-compatible-local-proxy, but the local model proxy is not available.');
    });

    const result = await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('failed to initialize');
  });

  it('council-routed but empty baseURL: route-table dispatch fails closed', async () => {
    const proxyConfig = {
      baseURL: '',  // Empty baseURL
      defaultHeaders: { 'x-routed-turn-id': 'turn-abc' },
    };
    const ctx = makeCtx({
      agentPrompt: COUNCIL_ROUTE_PROMPT,
      agentModel: 'working',
      routingMode: 'council',
      proxyConfig,
    });
    mockCreateClientFromRoutePlan.mockImplementationOnce(() => {
      throw new Error('Sub-agent route resolved to anthropic-compatible-local-proxy, but the local model proxy is not available.');
    });

    const result = await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('failed to initialize');
  });

  it('normal-turn terminal no-credentials surfaces descriptive sub-agent error', async () => {
    const ctx = makeCtx({
      agentPrompt: STANDARD_PROMPT,
      agentModel: 'working',
      settings: makeNoCredentialSettings(),
    });

    const result = await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Rebel needs an Anthropic API key. Please add one in Settings.');
    expect(result.output).not.toContain('Dispatch path "none" is terminal');
  });

  it('route-table council terminal no-credentials maps to user-friendly sub-agent error', async () => {
    const forSubagentSpy = vi.spyOn(ProviderRouter, 'forSubagent').mockReturnValue(
      makeTerminalSubagentDecision({
        routeScope: 'council',
        transport: 'no-credentials',
        invalidReason: 'missing-anthropic-credentials',
      }),
    );
    const ctx = makeCtx({
      agentPrompt: COUNCIL_ROUTE_PROMPT,
      agentModel: 'working',
      routingMode: 'council',
    });

    try {
      const result = await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

      expect(forSubagentSpy).toHaveBeenCalledWith(expect.objectContaining({ routeScope: 'council' }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain('Rebel needs an Anthropic API key. Please add one in Settings.');
      expect(result.output).not.toContain('Dispatch path "none" is terminal');
    } finally {
      forSubagentSpy.mockRestore();
    }
  });

  it('route-table ad-hoc terminal fail-closed-codex-disconnected maps to user-friendly sub-agent error', async () => {
    const forSubagentSpy = vi.spyOn(ProviderRouter, 'forSubagent').mockReturnValue(
      makeTerminalSubagentDecision({
        provider: 'codex',
        transport: 'fail-closed-codex-disconnected',
        dispatchPath: 'none',
        modelDialect: 'openai-compatible',
        routeScope: 'ad-hoc',
        canonicalModelId: 'gpt-5.5-high',
        wireModelId: brandRouteWireModel('gpt-5.5-high'),
        codexConnectivity: 'disconnected',
        credentialSource: 'missing-codex',
        invalidReason: 'codex-disconnected-bts-blocked',
      }),
    );
    const ctx = makeCtx({
      agentPrompt: STANDARD_PROMPT,
      agentModel: 'working',
      routingMode: 'ad-hoc',
    });

    try {
      const result = await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

      expect(forSubagentSpy).toHaveBeenCalledWith(expect.objectContaining({ routeScope: 'ad-hoc' }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain('ChatGPT Pro is not connected. Reconnect ChatGPT Pro in Settings or choose a different model for this sub-agent.');
      expect(result.output).not.toContain('Dispatch path "none" is terminal');
    } finally {
      forSubagentSpy.mockRestore();
    }
  });

  // --- routingMode is the canonical routing signal ---

  it('routingMode: council → forwards plan-backed proxy config without prompt-route tags', async () => {
    const proxyConfig = {
      baseURL: 'http://localhost:9999',
      defaultHeaders: { 'x-test': '1', 'x-proxy-auth': 'proxy-token' },
    };
    const ctx = makeCtx({
      agentPrompt: STANDARD_PROMPT,
      agentModel: 'working',
      routingMode: 'council',
      proxyConfig,
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    const plan = capturedPlan();
    expect(plan.proxyBaseURL).toBe('http://localhost:9999');
    expect(capturedHeaders(plan)).toMatchObject({
      'x-routed-turn-id': 'turn-abc',
      'x-proxy-auth': 'proxy-token',
    });
  });

  it('routingMode: council forwards proxy when routed by metadata', async () => {
    const proxyConfig = { baseURL: 'http://localhost:9999', defaultHeaders: { 'x-test': '1' } };
    const ctx = makeCtx({
      agentPrompt: COUNCIL_ROUTE_PROMPT,
      agentModel: 'working',
      routingMode: 'council',
      proxyConfig,
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    const plan = capturedPlan();
    expect(plan.proxyBaseURL).toBe('http://localhost:9999');
  });

  it('council-routed agent: client model preserves the semantic wire alias', async () => {
    const proxyConfig = { baseURL: 'http://localhost:9999', defaultHeaders: {} };
    const ctx = makeCtx({
      agentPrompt: COUNCIL_ROUTE_PROMPT,
      agentModel: 'working',
      routingMode: 'council',
      proxyConfig,
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    const plan = capturedPlan();
    // Route-table agents preserve the semantic wire alias in the plan.
    expect(plan.decision.wireModelId).toBe('working');
  });

  it('council route + OpenRouter-active parent strips x-openrouter-turn but keeps routed turn id', async () => {
    const proxyConfig = {
      baseURL: 'http://localhost:9999',
      defaultHeaders: {
        'x-openrouter-turn': 'true',
        'x-proxy-auth': 'proxy-token',
      },
    };
    const ctx = makeCtx({
      agentPrompt: COUNCIL_ROUTE_PROMPT,
      agentModel: 'working',
      routingMode: 'council',
      proxyConfig,
      settings: makeOpenRouterSettings(),
      turnId: 'turn-or',
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    const plan = capturedPlan();
    const headers = capturedHeaders(plan);
    expect(headers).not.toHaveProperty('x-openrouter-turn');
    expect(headers).toMatchObject({
      'x-routed-turn-id': 'turn-or',
      'x-proxy-auth': 'proxy-token',
    });
  });

  it('council route + Codex-active parent strips x-codex-turn but keeps routed turn id', async () => {
    const proxyConfig = {
      baseURL: 'http://localhost:9999',
      defaultHeaders: {
        'x-codex-turn': 'true',
        'x-proxy-auth': 'proxy-token',
      },
    };
    const ctx = makeCtx({
      agentPrompt: COUNCIL_ROUTE_PROMPT,
      agentModel: 'working',
      routingMode: 'council',
      proxyConfig,
      settings: makeCodexSettings(),
      turnId: 'turn-codex',
      codexConnectivity: 'connected',
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    const plan = capturedPlan();
    const headers = capturedHeaders(plan);
    expect(headers).not.toHaveProperty('x-codex-turn');
    expect(headers).toMatchObject({
      'x-routed-turn-id': 'turn-codex',
      'x-proxy-auth': 'proxy-token',
    });
  });

  it('normal-turn subagent + OpenRouter-active parent keeps x-openrouter-turn', async () => {
    const proxyConfig = {
      baseURL: 'http://localhost:9999',
      defaultHeaders: {
        'x-openrouter-turn': 'true',
        'x-proxy-auth': 'proxy-token',
      },
    };
    const ctx = makeCtx({
      agentPrompt: STANDARD_PROMPT,
      agentModel: 'working',
      proxyConfig,
      settings: makeOpenRouterSettings(),
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    const plan = capturedPlan();
    expect(capturedHeaders(plan)).toMatchObject({
      'x-openrouter-turn': 'true',
      'x-proxy-auth': 'proxy-token',
    });
  });

  it('documents that route-table scopes force proxy even for Anthropic direct transport', async () => {
    const proxyConfig = {
      baseURL: 'http://localhost:9999',
      defaultHeaders: { 'x-proxy-auth': 'proxy-token' },
    };
    const ctx = makeCtx({
      agentPrompt: COUNCIL_ROUTE_PROMPT,
      agentModel: 'working',
      agentRoutedModel: 'claude-sonnet-4-20250514',
      routingMode: 'council',
      proxyConfig,
    });

    const forSubagentSpy = vi.spyOn(ProviderRouter, 'forSubagent');
    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);
    const decision = forSubagentSpy.mock.results.at(-1)?.value;
    forSubagentSpy.mockRestore();

    expect(mockCreateClientFromRoutePlan).toHaveBeenCalledTimes(1);
    const plan = capturedPlan();
    expect(decision?.kind).toBe('dispatchable');
    expect(decision?.dispatchPath).toBe('local-proxy-route-table');
    expect(decision?.transport).toBe('anthropic-compatible-local-proxy');
    expect(plan.decision).toMatchObject({
      kind: 'dispatchable',
      transport: 'anthropic-compatible-local-proxy',
      dispatchPath: 'local-proxy-route-table',
    });
    expect(plan.proxyBaseURL).toBe('http://localhost:9999');
    expect(capturedHeaders(plan)).toMatchObject({
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-routed-turn-id': 'turn-abc',
      'x-routed-model': 'claude-sonnet-4-20250514',
      'x-proxy-auth': 'proxy-token',
    });
  });
});

// REBEL-5N8 (Stage 2 + Stage 4): seam-contract tests pinning WHICH model string
// agentTool streams to runAgentLoop (= client.stream's body model). The fix
// streams the route-table-safe `dispatchablePlan.decision.wireModelId` (bare) on
// route-table scope, while the resolved concrete backend rides only in
// `x-routed-model`. Outside route-table scope the streamed model is unchanged
// (the resolved model). This is the backstop for the diagnosis F4 coverage gap:
// the chokepoint guard only scans providerRouting.ts, not this agentTool seam.
describe('Sub-agent body-model contract at the runAgentLoop seam (REBEL-5N8)', () => {
  const PROXY_CONFIG = {
    baseURL: 'http://localhost:12345',
    defaultHeaders: { 'x-proxy-auth': 'proxy-token' },
  };

  beforeEach(() => {
    mockRunAgentLoop.mockReset();
    mockCreateClientFromRoutePlan.mockReset();
    mockRunAgentLoop.mockResolvedValue(undefined);
    mockCreateClientFromRoutePlan.mockReturnValue({});
  });

  it('(a) route-table ad-hoc, foreign working-tier: streams route-table-safe body model; foreign slug rides x-routed-model', async () => {
    const ctx = makeCtx({
      agentPrompt: STANDARD_PROMPT,
      agentModel: 'working',
      agentRoutedModel: 'openai/gpt-5.5',
      routingMode: 'ad-hoc',
      proxyConfig: PROXY_CONFIG,
      settings: makeOpenRouterForeignSettings(),
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Do research' }, ctx);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    expectRunAgentLoopUsesCreatedClient();
    // The body model the client speaks is route-table-safe (bare, no slash).
    const bodyModel = capturedRunAgentLoopModel();
    expect(bodyModel).not.toContain('/');
    expect(bodyModel).toBe('working');

    // The plan was built for the local-proxy route-table transport, and the
    // concrete foreign backend is carried in x-routed-model — NOT the body model.
    const plan = capturedPlan();
    expect(plan.decision).toMatchObject({
      kind: 'dispatchable',
      transport: 'anthropic-compatible-local-proxy',
      dispatchPath: 'local-proxy-route-table',
    });
    expect(plan.decision.wireModelId).toBe('working');
    expect(capturedHeaders(plan)).toMatchObject({
      'x-routed-model': 'openai/gpt-5.5',
    });
  });

  it('(b) route-table council, foreign working-tier: behaves identically', async () => {
    const ctx = makeCtx({
      agentPrompt: COUNCIL_ROUTE_PROMPT,
      agentModel: 'working',
      agentRoutedModel: 'openai/gpt-5.5',
      routingMode: 'council',
      proxyConfig: PROXY_CONFIG,
      settings: makeOpenRouterForeignSettings(),
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    expectRunAgentLoopUsesCreatedClient();
    expect(capturedRunAgentLoopModel()).toBe('working');
    const plan = capturedPlan();
    expect(plan.decision.dispatchPath).toBe('local-proxy-route-table');
    expect(capturedHeaders(plan)).toMatchObject({ 'x-routed-model': 'openai/gpt-5.5' });
  });

  it('(c) native-Claude route-table case still works (regression guard for the masking path)', async () => {
    const ctx = makeCtx({
      agentPrompt: COUNCIL_ROUTE_PROMPT,
      agentModel: 'working',
      agentRoutedModel: 'claude-sonnet-4-20250514',
      routingMode: 'council',
      proxyConfig: PROXY_CONFIG,
      settings: makeOpenRouterSettings(), // selectedModel = anthropic/claude-sonnet-4.5 (native)
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    expectRunAgentLoopUsesCreatedClient();
    // Body model stays the route-table-safe alias; no throw on the native path either.
    expect(capturedRunAgentLoopModel()).toBe('working');
    const plan = capturedPlan();
    expect(plan.decision.dispatchPath).toBe('local-proxy-route-table');
  });

  it('(d) no-op proof: non-route-table profile delegation streams the RESOLVED model', async () => {
    // No routingMode → standard (non-route-table) routing. The Anthropic-native
    // working-tier resolves to a direct-provider dispatch; the streamed model is
    // the resolved concrete model, NOT a route-table alias.
    const ctx = makeCtx({
      agentPrompt: STANDARD_PROMPT,
      agentModel: 'working',
      proxyConfig: PROXY_CONFIG,
      settings: makeOpenRouterSettings(), // working → anthropic/claude-sonnet-4.5 (native, direct)
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    expectRunAgentLoopUsesCreatedClient();
    const plan = capturedPlan();
    // Non-route-table: the change is a no-op — streamed model equals the plan's
    // wireModelId equals the resolved concrete model (NOT the bare 'working' alias).
    expect(plan.decision.dispatchPath).not.toBe('local-proxy-route-table');
    expect(capturedRunAgentLoopModel()).toBe(plan.decision.wireModelId);
    expect(capturedRunAgentLoopModel()).not.toBe('working');
  });

  it('(e) route-table: resolved foreign model is preserved for the resolved-model consumers (x-routed-model) while body model is route-table-safe', async () => {
    const ctx = makeCtx({
      agentPrompt: STANDARD_PROMPT,
      agentModel: 'working',
      agentRoutedModel: 'openai/gpt-5.5',
      routingMode: 'ad-hoc',
      proxyConfig: PROXY_CONFIG,
      settings: makeOpenRouterForeignSettings(),
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Do research' }, ctx);

    const plan = capturedPlan();
    expectRunAgentLoopUsesCreatedClient();
    // The concrete (resolved) foreign backend is what the resolved-model
    // consumers (cost/limits/badge/mismatch) see — confirmed via x-routed-model
    // carrying the foreign slug while the body model stays the bare alias.
    expect(capturedHeaders(plan)['x-routed-model']).toBe('openai/gpt-5.5');
    expect(capturedRunAgentLoopModel()).toBe('working');
  });

  // Stage 4 — mindstone-managed provider variant. activeProvider=mindstone with a
  // foreign working-tier slug resolves through selectProviderMode's
  // mindstone→openrouter arm into the SAME route-table coercion, so the fix covers
  // the managed-key path (the original Sentry user) too.
  it('(Stage 4) mindstone-managed, foreign working-tier route-table: streams route-table-safe body model', async () => {
    const ctx = makeCtx({
      agentPrompt: STANDARD_PROMPT,
      agentModel: 'working',
      agentRoutedModel: 'openai/gpt-5.5',
      routingMode: 'ad-hoc',
      proxyConfig: PROXY_CONFIG,
      settings: makeMindstoneForeignSettings(),
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Do research' }, ctx);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    expectRunAgentLoopUsesCreatedClient();
    const bodyModel = capturedRunAgentLoopModel();
    expect(bodyModel).not.toContain('/');
    expect(bodyModel).toBe('working');
    const plan = capturedPlan();
    expect(plan.decision.dispatchPath).toBe('local-proxy-route-table');
    expect(capturedHeaders(plan)).toMatchObject({ 'x-routed-model': 'openai/gpt-5.5' });
  });

  // Stage 3 — fail-closed seam backstop. If a future regression (or an unmapped
  // route-table arm) ever resolves a route-table proxy dispatch whose wireModelId
  // carries a foreign slash slug, agentTool must fail closed at the seam with a
  // clearly-labelled routing error (tagged area=sub-agent-dispatch by the catch),
  // NOT let the proxy AnthropicClient throw the confusing wire-level invalid_request.
  it('(Stage 3) route-table proxy dispatch with a foreign (slash) body model fails closed at the seam', async () => {
    const forSubagentSpy = vi.spyOn(ProviderRouter, 'forSubagent').mockReturnValue(
      // Route-table local-proxy dispatch but wireModelId is a foreign slash slug
      // (the regression shape) — Stage 1 would stream this as the body model.
      makeRouteTableDispatchableDecision({
        wireModelId: brandRouteWireModel('openai/gpt-5.5'),
      }),
    );
    const ctx = makeCtx({
      agentPrompt: STANDARD_PROMPT,
      agentModel: 'working',
      agentRoutedModel: 'openai/gpt-5.5',
      routingMode: 'ad-hoc',
      proxyConfig: PROXY_CONFIG,
      settings: makeOpenRouterForeignSettings(),
    });

    try {
      const result = await executeAgentTool({ agent: 'reviewer', prompt: 'Do research' }, ctx);

      // The backstop throws before runAgentLoop; the client must NOT be streamed.
      expect(mockRunAgentLoop).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.output).toContain('routing mismatch');
      expect(result.output).toContain('foreign body model');
    } finally {
      forSubagentSpy.mockRestore();
    }
  });

  // Stage 5 — broaden the seam backstop to the F1 sibling class. The backstop now
  // discriminates on transport === 'anthropic-compatible-local-proxy' (the only
  // transport whose AnthropicClient is built non-passthrough), so it covers BOTH
  // the route-table case (above) AND the NON-route-table local-proxy-passthrough
  // path (the F1 Google direct-provider-misconfig path: a slash id hand-typed
  // into a Google profile). A slash body model on a non-passthrough local-proxy
  // Anthropic client is genuinely invalid → fail closed at the seam with the
  // classified routing error rather than the raw wire-level invalid_request.
  it('(Stage 5) non-route-table local-proxy-passthrough dispatch with a foreign (slash) body model fails closed at the broadened seam backstop', async () => {
    const forSubagentSpy = vi.spyOn(ProviderRouter, 'forSubagent').mockReturnValue(
      // Non-route-table (normal-turn) anthropic-compatible-local-proxy dispatch,
      // dispatchPath local-proxy-passthrough — the F1 Google shape. Stage 1's
      // body-model swap is GATED to route-table scope, so bodyModel here stays
      // the resolved `model` (a foreign slash slug under foreign working-tier
      // settings). The OLD (route-table-only) backstop would NOT fire on this
      // path; the broadened transport-discriminant one does.
      makeRouteTableDispatchableDecision({
        routeScope: 'normal-turn',
        dispatchPath: 'local-proxy-passthrough',
        modelDialect: 'openai-compatible',
        canonicalModelId: 'openai/gpt-5.5',
        wireModelId: brandRouteWireModel('openai/gpt-5.5'),
      }),
    );
    const ctx = makeCtx({
      agentPrompt: STANDARD_PROMPT,
      // Explicit slash-form model id (the F1 misconfig shape: a foreign slash id
      // hand-typed into a direct-provider profile). No routingMode → non-route-table
      // scope, so Stage 1's body-model swap does NOT run and bodyModel stays this
      // resolved slash slug.
      agentModel: 'openai/gpt-5.5',
      proxyConfig: PROXY_CONFIG,
      settings: makeOpenRouterForeignSettings(),
    });

    try {
      const result = await executeAgentTool({ agent: 'reviewer', prompt: 'Do research' }, ctx);

      // Broadened backstop fires before runAgentLoop; the client must NOT be streamed.
      expect(mockRunAgentLoop).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      // Classified seam routing error (createSubagentRoutingError), NOT the raw
      // resolveAnthropicWireModel wire message.
      expect(result.output).toContain('routing mismatch');
      // Stage 3 broadened the wording: "non-passthrough Anthropic dispatch
      // (transport ...)" now covers all non-passthrough Anthropic transports, not
      // just the local-proxy one. Still classified, still cites the foreign body model.
      expect(result.output).toContain('non-passthrough Anthropic dispatch');
      expect(result.output).toContain('foreign body model');
      // Distinct from the wire-level message the AnthropicClient would have thrown.
      expect(result.output).not.toContain('Direct-Anthropic client received non-Anthropic');
    } finally {
      forSubagentSpy.mockRestore();
    }
  });

  // Stage 5 — gate-enforcement: the isRouteTableScope gate on the bodyModel swap
  // (agentTool.ts) is what keeps NON-route-table delegations streaming the
  // RESOLVED `model` rather than the plan's `wireModelId`. For a legacy-OpenRouter
  // id, `wireModelId` (via resolveInputModel→normalizeOrModelId→LEGACY_OR_MODEL_REMAP)
  // diverges from the resolved `model` (decodeRoutingModelId, no remap). This test
  // pins that divergence and asserts the streamed body model is the resolved
  // `model`, NOT the remapped `wireModelId`. Deleting the isRouteTableScope gate
  // (making the swap unconditional) would stream `wireModelId` here → RED.
  it('(Stage 5 gate) non-route-table legacy-OpenRouter-id delegation streams the RESOLVED model, not the remapped plan wireModelId', async () => {
    // deepseek/deepseek-chat-v3-0324 is a LEGACY_OR_MODEL_REMAP key → remaps to
    // its current replacement id (deepseek/deepseek-v3.2). The resolved streamed
    // model keeps the legacy form; only wireModelId remaps.
    const ctx = makeCtx({
      agentPrompt: STANDARD_PROMPT,
      agentModel: 'deepseek/deepseek-chat-v3-0324',
      // No routingMode → non-route-table.
      proxyConfig: PROXY_CONFIG,
      settings: {
        ...makeOpenRouterSettings(),
        openRouter: {
          enabled: true,
          oauthToken: 'or-oauth-test',
          selectedModel: 'deepseek/deepseek-chat-v3-0324',
        },
      } as unknown as AppSettings,
    });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this' }, ctx);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    expectRunAgentLoopUsesCreatedClient();
    const plan = capturedPlan();
    // Precondition: this is a real non-route-table divergence (wireModelId remapped).
    expect(plan.decision.dispatchPath).not.toBe('local-proxy-route-table');
    expect(plan.decision.wireModelId).toBe('deepseek/deepseek-v3.2');
    // The gate keeps the streamed body model on the RESOLVED model (legacy form),
    // NOT the remapped wireModelId. Removing the gate would flip this to the latter.
    expect(capturedRunAgentLoopModel()).toBe('deepseek/deepseek-chat-v3-0324');
    expect(capturedRunAgentLoopModel()).not.toBe(plan.decision.wireModelId);
  });
});
