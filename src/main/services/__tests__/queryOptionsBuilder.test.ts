import { describe, expect, it } from 'vitest';
import { brandRouteWireModel } from '@shared/utils/wireModelId';
import { buildSdkQueryOptions, type QueryOptionsContext } from '../queryOptionsBuilder';
import { extractProxyConfig } from '@core/rebelCore/queryRouter';
import type { DispatchableRoutePlan, ProviderRoutePlan } from '@core/rebelCore/providerRoutePlan';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal valid QueryOptionsContext with sensible defaults.
 * Override individual fields by spreading partial overrides.
 */
function makePlan(overrides: Partial<DispatchableRoutePlan> = {}): DispatchableRoutePlan {
  return {
    decision: {
      kind: 'dispatchable',
      provider: 'anthropic',
      transport: 'anthropic-direct',
      dispatchPath: 'direct-provider',
      modelDialect: 'anthropic-native',
      role: 'execution',
      routeScope: 'normal-turn',
      routedModel: null,
      canonicalModelId: 'claude-sonnet-4-5',
      wireModelId: brandRouteWireModel('claude-sonnet-4-5'),
      profileId: null,
      resolvedFrom: 'settings',
      codexConnectivity: 'unsupported',
      fallbackHint: null,
      credentialSource: 'anthropic-api-key',
      invalidReason: 'none',
    },
    auth: {
      kind: 'api-key',
      resolvedAuthLabel: 'api-key',
      credentialSource: 'anthropic-api-key',
      credentialStatus: 'available',
      apiKey: 'test-key-123',
      env: [['ANTHROPIC_API_KEY', 'test-key-123']],
    },
    headers: [],
    proxyBaseURL: null,
    resolvedAuthLabel: 'api-key',
    proxyRequired: false,
    invalidReason: null,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<QueryOptionsContext> = {}): QueryOptionsContext {
  return {
    turnId: 'turn-test-001',
    coreDirectory: '/workspace/project',
    effectivePath: '/usr/bin:/usr/local/bin',
    effectiveThinkingEffort: 'medium',
    modelConfig: { model: 'claude-sonnet-4-5' },
    getEffectiveModel: () => 'claude-sonnet-4-5',
    plan: makePlan(),
    rawSystemPrompt: 'You are Rebel, a helpful AI assistant.',
    finalSystemPrompt: 'You are Rebel, a helpful AI assistant.\n\n[Council active]',
    turnHooks: { PreToolUse: [], SubagentStart: [], PostToolUse: [], Stop: [], SubagentStop: [] },
    mcpServers: undefined,
    capabilityResolution: { disallowedTools: [], promptGuidance: [], activeCapabilities: [] },
    agentMcpSpecs: undefined,
    councilConfig: null,
    adHocConfig: null,
    claudeSubagentConfig: null,
    getProviderKeyEnv: () => ({}),
    permissionMode: 'bypassPermissions',
    knowledgeWorkerAgentName: 'Rebel',
    knowledgeWorkerAgentDescription: 'Knowledge worker assistant',
    // Use a controlled processEnv so tests don't leak real env
    processEnv: { HOME: '/home/test', PATH: '/usr/bin' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSdkQueryOptions', () => {
  // -------------------------------------------------------------------------
  // Test 1: Basic field assembly
  // -------------------------------------------------------------------------
  it('assembles all required fields in output', () => {
    const ctx = makeCtx();
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.cwd).toBe('/workspace/project');
    expect(opts.model).toBe('claude-sonnet-4-5');
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.systemPrompt).toBe('You are Rebel, a helpful AI assistant.\n\n[Council active]');
    expect('pathToClaudeCodeExecutable' in opts).toBe(false);
    expect(opts.hooks).toBe(ctx.turnHooks);
    expect(opts.env).toBeDefined();
    expect(opts.env!.PATH).toBe('/usr/bin:/usr/local/bin');
    expect(opts.env!.CLAUDE_CODE_PATH).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 2: resume field removed (SDK-only, no longer in TurnParams)
  // -------------------------------------------------------------------------
  it('does not include resume field (SDK-only, removed)', () => {
    const opts = buildSdkQueryOptions(makeCtx());
    expect('resume' in opts).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 4: mcpServers included when defined, omitted when undefined
  // -------------------------------------------------------------------------
  it('includes mcpServers when defined', () => {
    const servers = {
      'my-server': { type: 'stdio' as const, command: 'npx', args: ['mcp-server'] },
    };
    const ctx = makeCtx({ mcpServers: servers });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.mcpServers).toBe(servers);
  });

  it('omits mcpServers when undefined', () => {
    const ctx = makeCtx({ mcpServers: undefined });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.mcpServers).toBeUndefined();
    expect('mcpServers' in opts).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 5: disallowedTools → suppressedBuiltins (applied in rebelCoreQuery, not SDK opts)
  // Capability suppression now happens via TurnParams.suppressedBuiltins in rebelCoreQuery.ts.
  // The builder maps capabilityResolution.disallowedTools to suppressedBuiltins when mcpServers is truthy.
  // -------------------------------------------------------------------------
  it('does not include disallowedTools directly (mapped to suppressedBuiltins instead)', () => {
    const ctx = makeCtx({
      capabilityResolution: {
        disallowedTools: ['WebSearch', 'WebFetch'],
        promptGuidance: ['Use MCP search instead'],
        activeCapabilities: [{ capabilityId: 'mcp-search', provider: 'test-mcp' }],
      },
    });
    const opts = buildSdkQueryOptions(ctx);

    expect('disallowedTools' in opts).toBe(false);
  });

  it('maps disallowedTools to suppressedBuiltins when mcpServers is truthy', () => {
    const ctx = makeCtx({
      mcpServers: { 'my-server': { type: 'stdio' as const, command: 'npx', args: ['mcp-server'] } },
      capabilityResolution: {
        disallowedTools: ['WebSearch'],
        promptGuidance: ['Use MCP search instead'],
        activeCapabilities: [{ capabilityId: 'mcp-search', provider: 'test-mcp' }],
      },
    });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.suppressedBuiltins).toEqual(['WebSearch']);
  });

  it('omits suppressedBuiltins when mcpServers is undefined (MCP degraded)', () => {
    const ctx = makeCtx({
      mcpServers: undefined,
      capabilityResolution: {
        disallowedTools: ['WebSearch'],
        promptGuidance: [],
        activeCapabilities: [],
      },
    });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.suppressedBuiltins).toBeUndefined();
  });

  it('omits suppressedBuiltins when disallowedTools is empty', () => {
    const ctx = makeCtx({
      mcpServers: { 'my-server': { type: 'stdio' as const, command: 'npx', args: ['mcp-server'] } },
      capabilityResolution: {
        disallowedTools: [],
        promptGuidance: [],
        activeCapabilities: [],
      },
    });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.suppressedBuiltins).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 6: CLAUDE_CODE_ENABLE_TASKS removed (SDK-only env var)
  // -------------------------------------------------------------------------
  it('does not include CLAUDE_CODE_ENABLE_TASKS (SDK-only env var removed)', () => {
    const ctx = makeCtx();
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.env?.CLAUDE_CODE_ENABLE_TASKS).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 7: CLAUDE_CODE_EFFORT_LEVEL set from effectiveThinkingEffort
  // -------------------------------------------------------------------------
  it('sets CLAUDE_CODE_EFFORT_LEVEL from effectiveThinkingEffort', () => {
    const ctx = makeCtx({ effectiveThinkingEffort: 'high' });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.env!.CLAUDE_CODE_EFFORT_LEVEL).toBe('high');
  });

  // -------------------------------------------------------------------------
  // Test 8: plan auth env is read from the current context on every build
  // -------------------------------------------------------------------------
  it('reads plan auth env on every invocation', () => {
    const ctx = makeCtx({
      plan: makePlan({
        auth: {
          kind: 'api-key',
          resolvedAuthLabel: 'api-key',
          credentialSource: 'anthropic-api-key',
          credentialStatus: 'available',
          apiKey: 'key-1',
          env: [['ANTHROPIC_API_KEY', 'key-1']],
        },
      }),
    });

    const opts1 = buildSdkQueryOptions(ctx);
    expect(opts1.env!.ANTHROPIC_API_KEY).toBe('key-1');

    ctx.plan = makePlan({
      auth: {
        kind: 'api-key',
        resolvedAuthLabel: 'api-key',
        credentialSource: 'anthropic-api-key',
        credentialStatus: 'available',
        apiKey: 'key-2',
        env: [['ANTHROPIC_API_KEY', 'key-2']],
      },
    });

    const opts2 = buildSdkQueryOptions(ctx);
    expect(opts2.env!.ANTHROPIC_API_KEY).toBe('key-2');
  });

  // -------------------------------------------------------------------------
  // Test 9: Council proxy env vars when councilConfig + councilProxyUrl set
  // -------------------------------------------------------------------------
  it('sets council proxy env vars when council is active', () => {
    const ctx = makeCtx({
      councilConfig: {
        agents: { alpha: { description: 'Alpha', prompt: 'be alpha', routedModel: 'alpha-model' } },
        routeTable: { routes: new Map() },
        systemPromptSuffix: '\n[Council]',
        leadModel: 'claude-sonnet-4-5',
      },
      plan: makePlan({
        proxyBaseURL: 'http://proxy.local:8080',
        headers: [['x-routed-turn-id', 'turn-test-001'], ['x-proxy-auth', 'council-token']],
        proxyRequired: true,
      }),
    });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.env!.ANTHROPIC_BASE_URL).toBe('http://proxy.local:8080');
    expect(opts.env!.ANTHROPIC_CUSTOM_HEADERS).toEqual(
      'x-routed-turn-id: turn-test-001\nx-proxy-auth: council-token',
    );
  });

  // -------------------------------------------------------------------------
  // Test 10: Google proxy env vars when googleWorkingProfile is google type
  // -------------------------------------------------------------------------
  it('sets Google proxy env vars when googleWorkingProfile is google', () => {
    const ctx = makeCtx({
      plan: makePlan({
        proxyBaseURL: 'http://proxy.local:7070',
        headers: [['x-proxy-auth', 'google-proxy-token']],
        proxyRequired: true,
      }),
    });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.env!.ANTHROPIC_BASE_URL).toBe('http://proxy.local:7070');
    expect(opts.env!.ANTHROPIC_CUSTOM_HEADERS).toEqual('x-proxy-auth: google-proxy-token');
  });

  // -------------------------------------------------------------------------
  // Test 11: Google proxy SKIPPED when council is active
  // -------------------------------------------------------------------------
  it('skips Google proxy when council is active', () => {
    const ctx = makeCtx({
      councilConfig: {
        agents: { alpha: { description: 'Alpha', prompt: 'be alpha', routedModel: 'alpha-model' } },
        routeTable: { routes: new Map() },
        systemPromptSuffix: '\n[Council]',
        leadModel: 'claude-sonnet-4-5',
      },
      plan: makePlan({
        proxyBaseURL: 'http://council-proxy.local:8080',
        headers: [['x-routed-turn-id', 'turn-test-001']],
        proxyRequired: true,
      }),
    });
    const opts = buildSdkQueryOptions(ctx);

    // Council proxy should win; Google proxy should be skipped
    expect(opts.env!.ANTHROPIC_BASE_URL).toBe('http://council-proxy.local:8080');
  });

  // -------------------------------------------------------------------------
  // Test 12: Knowledge-worker agent uses rawSystemPrompt, not finalSystemPrompt
  // -------------------------------------------------------------------------
  it('uses rawSystemPrompt for knowledge-worker agent prompt, finalSystemPrompt for top-level', () => {
    const ctx = makeCtx({
      rawSystemPrompt: 'Raw prompt without council',
      finalSystemPrompt: 'Raw prompt with council suffix appended',
    });
    const opts = buildSdkQueryOptions(ctx);

    // Top-level systemPrompt uses finalSystemPrompt
    expect(opts.systemPrompt).toBe('Raw prompt with council suffix appended');

    // Knowledge-worker agent uses rawSystemPrompt
    const agents = opts.agents as Record<string, { prompt: string }>;
    expect(agents).toBeDefined();
    expect(agents['Rebel'].prompt).toBe('Raw prompt without council');
  });

  // -------------------------------------------------------------------------
  // Test 13: Top-level systemPrompt uses finalSystemPrompt
  //          (complementary to Test 12; verifies the split is consistent)
  // -------------------------------------------------------------------------
  it('top-level systemPrompt uses finalSystemPrompt', () => {
    const finalPrompt = 'Final system prompt with all augmentations';
    const ctx = makeCtx({ finalSystemPrompt: finalPrompt });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.systemPrompt).toBe(finalPrompt);
  });

  // -------------------------------------------------------------------------
  // Test 14: Mutation test — update ctx.modelConfig, call again, verify new model
  // -------------------------------------------------------------------------
  it('reflects modelConfig mutations on subsequent calls', () => {
    const ctx = makeCtx({
      modelConfig: { model: 'claude-sonnet-4-5', envOverrides: { ENV_FOO: 'bar' } },
      getEffectiveModel: () => ctx.modelConfig.model,
    });

    const opts1 = buildSdkQueryOptions(ctx);
    expect(opts1.model).toBe('claude-sonnet-4-5');
    expect(opts1.env!.ENV_FOO).toBe('bar');

    // Simulate error recovery mutating the model config
    ctx.modelConfig = { model: 'claude-haiku-4-5', envOverrides: { ENV_FOO: 'baz' } };

    const opts2 = buildSdkQueryOptions(ctx);
    expect(opts2.model).toBe('claude-haiku-4-5');
    expect(opts2.env!.ENV_FOO).toBe('baz');
  });

  // -------------------------------------------------------------------------
  // Additional edge cases
  // -------------------------------------------------------------------------

  it('omits agents when rawSystemPrompt is empty', () => {
    const ctx = makeCtx({ rawSystemPrompt: '   ' });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.agents).toBeUndefined();
    expect('agents' in opts).toBe(false);
  });

  it('includes council and ad-hoc agents alongside knowledge-worker', () => {
    const ctx = makeCtx({
      councilConfig: {
        agents: { 'council-gpt': { description: 'GPT member', prompt: 'analyze', routedModel: 'gpt-5.5' } },
        routeTable: { routes: new Map() },
        systemPromptSuffix: '',
        leadModel: 'claude-sonnet-4-5',
      },
      adHocConfig: {
        agents: { 'adhoc-gemini': { description: 'Gemini', prompt: 'think', routedModel: 'gemini-2.5-pro' } },
        routeTable: { routes: new Map() },
        systemPromptHint: '',
        modelDisplayNames: new Map(),
      },
    });
    const opts = buildSdkQueryOptions(ctx);
    const agentNames = Object.keys(opts.agents ?? {});

    expect(agentNames).toContain('Rebel');
    expect(agentNames).toContain('council-gpt');
    expect(agentNames).toContain('adhoc-gemini');
  });

  it('includes getProviderKeyEnv output in env', () => {
    const ctx = makeCtx({
      getProviderKeyEnv: () => ({ OPENAI_API_KEY: 'fake-test-123' }),
      plan: makePlan({
        auth: {
          kind: 'api-key',
          resolvedAuthLabel: 'api-key',
          credentialSource: 'openai-api-key',
          credentialStatus: 'available',
          apiKey: 'fake-test-123',
          env: [['OPENAI_API_KEY', 'fake-test-123']],
        },
      }),
    });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.env!.OPENAI_API_KEY).toBe('fake-test-123');
  });

  it('uses processEnv override instead of real process.env', () => {
    const ctx = makeCtx({
      processEnv: { CUSTOM_VAR: 'custom-value' },
    });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.env!.CUSTOM_VAR).toBe('custom-value');
  });

  it('spreads envOverrides from modelConfig', () => {
    const ctx = makeCtx({
      modelConfig: {
        model: 'planner',
        envOverrides: {
          PLANNING_MODEL: 'claude-opus-4-7',
          ENV_EXECUTION_MODEL: 'claude-sonnet-4-5',
        },
      },
    });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.env!.PLANNING_MODEL).toBe('claude-opus-4-7');
    expect(opts.env!.ENV_EXECUTION_MODEL).toBe('claude-sonnet-4-5');
  });

  it('skips ad-hoc proxy when adHocConfig is null', () => {
    const ctx = makeCtx({
      adHocConfig: null,
    });
    const opts = buildSdkQueryOptions(ctx);

    // No proxy vars should be set from ad-hoc path
    expect(opts.env!.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('Google proxy skipped when adHocConfig is active', () => {
    const ctx = makeCtx({
      adHocConfig: {
        agents: { 'adhoc-model': { description: 'Model', prompt: 'work', routedModel: 'model-1' } },
        routeTable: { routes: new Map() },
        systemPromptHint: '',
        modelDisplayNames: new Map(),
      },
      plan: makePlan({
        proxyBaseURL: 'http://adhoc-proxy.local',
        headers: [['x-routed-turn-id', 'turn-test-001']],
        proxyRequired: true,
      }),
    });
    const opts = buildSdkQueryOptions(ctx);

    // Ad-hoc proxy should win; Google proxy should be skipped
    expect(opts.env!.ANTHROPIC_BASE_URL).toBe('http://adhoc-proxy.local');
  });

  // -------------------------------------------------------------------------
  // routingMode injection for council/ad-hoc agents
  // -------------------------------------------------------------------------

  it('stamps routingMode: council on council agent definitions', () => {
    const ctx = makeCtx({
      councilConfig: {
        agents: {
          'council-gpt': {
            description: 'GPT',
            prompt: 'review',
            model: 'working',
            routedModel: 'gpt-5.5',
          },
        },
        routeTable: { routes: new Map() },
        systemPromptSuffix: '',
        leadModel: 'claude-sonnet-4-20250514',
      },
      plan: makePlan({
        proxyBaseURL: 'http://council-proxy.local',
        headers: [['x-routed-turn-id', 'turn-test-001']],
        proxyRequired: true,
      }),
    });
    const opts = buildSdkQueryOptions(ctx);
    const councilAgent = (opts.agents as Record<string, { routingMode?: string }>)?.['council-gpt'];
    expect(councilAgent).toBeDefined();
    expect(councilAgent!.routingMode).toBe('council');
  });

  it('stamps routingMode: ad-hoc on ad-hoc agent definitions', () => {
    const ctx = makeCtx({
      adHocConfig: {
        agents: {
          'adhoc-deepseek': {
            description: 'DeepSeek',
            prompt: 'work',
            model: 'working',
            routedModel: 'deepseek-r1',
          },
        },
        routeTable: { routes: new Map() },
        systemPromptHint: '',
        modelDisplayNames: new Map(),
      },
      plan: makePlan({
        proxyBaseURL: 'http://adhoc-proxy.local',
        headers: [['x-routed-turn-id', 'turn-test-001']],
        proxyRequired: true,
      }),
    });
    const opts = buildSdkQueryOptions(ctx);
    const adHocAgent = (opts.agents as Record<string, { routingMode?: string }>)?.['adhoc-deepseek'];
    expect(adHocAgent).toBeDefined();
    expect(adHocAgent!.routingMode).toBe('ad-hoc');
  });

  it('throws when a council agent is missing routedModel', () => {
    const ctx = makeCtx({
      councilConfig: {
        agents: {
          'council-gpt': {
            description: 'GPT',
            prompt: 'review',
            model: 'working',
          },
        },
        routeTable: { routes: new Map() },
        systemPromptSuffix: '',
        leadModel: 'claude-sonnet-4-20250514',
      },
      plan: makePlan({
        proxyBaseURL: 'http://council-proxy.local',
        headers: [['x-routed-turn-id', 'turn-test-001']],
        proxyRequired: true,
      }),
    });

    expect(() => buildSdkQueryOptions(ctx)).toThrow(
      'Route-table agent definitions missing routedModel for council: council-gpt',
    );
  });

  // -------------------------------------------------------------------------
  // Provider-identity header preservation when ad-hoc / council is active
  //
  // CONTEXT: buildAdHocProxyEnv() and buildCouncilProxyEnv() are spread AFTER
  // buildOpenRouterProxyEnv() / buildCodexProxyEnv(), so they overwrite
  // ANTHROPIC_CUSTOM_HEADERS. Without re-emitting provider-identity headers,
  // clientFactory.ts cannot detect the proxy type and throws an auth error.
  //
  // The extractProxyConfig() assertion below proves the header survives
  // the full env → parsed headers pipeline (not just substring matching).
  //
  // See: docs-private/postmortems/260417_openrouter_adhoc_auth_failure_postmortem.md
  // -------------------------------------------------------------------------

  it('preserves x-openrouter-turn header in ad-hoc proxy env when OpenRouter is active', () => {
    const ctx = makeCtx({
      adHocConfig: {
        agents: { 'adhoc-gpt': { description: 'GPT', prompt: 'work', routedModel: 'gpt-5.5' } },
        routeTable: { routes: new Map() },
        systemPromptHint: '',
        modelDisplayNames: new Map(),
      },
      plan: makePlan({
        proxyBaseURL: 'http://adhoc-proxy.local',
        headers: [
          ['x-routed-turn-id', 'turn-test-001'],
          ['x-openrouter-turn', 'true'],
          ['x-proxy-auth', 'proxy-token'],
        ],
        proxyRequired: true,
      }),
    });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.env!.ANTHROPIC_BASE_URL).toBe('http://adhoc-proxy.local');
    expect(opts.env!.ANTHROPIC_CUSTOM_HEADERS).toEqual(
      'x-routed-turn-id: turn-test-001\nx-openrouter-turn: true\nx-proxy-auth: proxy-token',
    );

    // Verify the header survives queryRouter.extractProxyConfig() parsing
    const proxyConfig = extractProxyConfig(opts.env);
    expect(proxyConfig?.defaultHeaders?.['x-openrouter-turn']).toBe('true');
  });

  it('preserves x-openrouter-turn header in council proxy env when OpenRouter is active', () => {
    const ctx = makeCtx({
      councilConfig: {
        agents: { 'council-gpt': { description: 'GPT', prompt: 'review', routedModel: 'gpt-5.5' } },
        routeTable: { routes: new Map() },
        systemPromptSuffix: '',
        leadModel: 'claude-sonnet-4-20250514',
      },
      plan: makePlan({
        proxyBaseURL: 'http://council-proxy.local',
        headers: [
          ['x-routed-turn-id', 'turn-test-001'],
          ['x-openrouter-turn', 'true'],
          ['x-proxy-auth', 'proxy-token'],
        ],
        proxyRequired: true,
      }),
    });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.env!.ANTHROPIC_BASE_URL).toBe('http://council-proxy.local');
    expect(opts.env!.ANTHROPIC_CUSTOM_HEADERS).toEqual(
      'x-routed-turn-id: turn-test-001\nx-openrouter-turn: true\nx-proxy-auth: proxy-token',
    );
  });

  it('does NOT add x-openrouter-turn header when OpenRouter is not active', () => {
    const ctx = makeCtx({
      adHocConfig: {
        agents: { 'adhoc-gpt': { description: 'GPT', prompt: 'work', routedModel: 'gpt-5.5' } },
        routeTable: { routes: new Map() },
        systemPromptHint: '',
        modelDisplayNames: new Map(),
      },
      plan: makePlan({
        proxyBaseURL: 'http://adhoc-proxy.local',
        headers: [
          ['x-routed-turn-id', 'turn-test-001'],
          ['x-proxy-auth', 'proxy-token'],
        ],
        proxyRequired: true,
      }),
    });
    const opts = buildSdkQueryOptions(ctx);

    expect(opts.env!.ANTHROPIC_CUSTOM_HEADERS).toEqual(
      'x-routed-turn-id: turn-test-001\nx-proxy-auth: proxy-token',
    );
  });

  it('does NOT stamp routingMode on Claude native subagents', () => {
    const ctx = makeCtx({
      claudeSubagentConfig: {
        agents: {
          'claude-haiku': { description: 'Haiku', prompt: 'You are Haiku.', model: 'haiku' },
        },
        systemPromptHint: '',
        modelDisplayNames: new Map(),
      },
    });
    const opts = buildSdkQueryOptions(ctx);
    const claudeAgent = (opts.agents as Record<string, { routingMode?: string }>)?.['claude-haiku'];
    expect(claudeAgent).toBeDefined();
    expect(claudeAgent!.routingMode).toBeUndefined();
  });
});
