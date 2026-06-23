/**
 * Council Service Unit Tests
 *
 * Tests the validation logic in buildCouncilConfig:
 * - Agent name uniqueness (slug collision detection)
 * - Duplicate model name detection
 * - Routed-model metadata injection
 * - Empty model filtering (via getCouncilProfiles)
 */

import { describe, it, expect, vi } from 'vitest';
import { buildCouncilConfig, getCouncilProfiles, resolveCouncilLeadModel } from '../councilService';
import type { AgentDefinition } from '@core/agentRuntimeTypes';
import type { AppSettings, ModelProfile } from '@shared/types';
import type { ModelConfig } from '@shared/utils/modelNormalization';

/** Helper to create a minimal ModelProfile */
function makeProfile(overrides: Partial<ModelProfile> & { id: string; name: string }): ModelProfile {
  return {
    serverUrl: 'http://localhost:1234',
    createdAt: Date.now(),
    councilEnabled: true,
    model: 'test-model',
    ...overrides,
  };
}

/** Helper to create minimal AppSettings with council profiles */
function makeSettings(profiles: ModelProfile[], overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    localModel: { profiles },
    ...overrides,
  } as AppSettings;
}

function makeAgent(modelName: string): AgentDefinition {
  return {
    description: `Consult ${modelName}`,
    prompt: 'You are a model.',
    model: 'working',
    routedModel: modelName,
  };
}

describe('getCouncilProfiles', () => {
  it('filters out profiles without a model field', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'Has model', model: 'deepseek-r1' }),
      makeProfile({ id: 'b', name: 'No model', model: undefined }),
      makeProfile({ id: 'c', name: 'Empty model', model: '' }),
    ];
    const result = getCouncilProfiles(makeSettings(profiles));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('filters out profiles where councilEnabled is false', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'Enabled', model: 'model-a', councilEnabled: true }),
      makeProfile({ id: 'b', name: 'Disabled', model: 'model-b', councilEnabled: false }),
    ];
    const result = getCouncilProfiles(makeSettings(profiles));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });
});

describe('buildCouncilConfig', () => {
  it('returns null when no profiles are configured', () => {
    const result = buildCouncilConfig(makeSettings([]), '');
    expect(result).toBeNull();
  });

  it('builds config for valid profiles', () => {
    const profiles = [
      makeProfile({ id: 'abc123', name: 'DeepSeek', model: 'deepseek-r1' }),
      makeProfile({ id: 'def456', name: 'GPT-5', model: 'gpt-5' }),
    ];
    const result = buildCouncilConfig(makeSettings(profiles), '');
    expect(result).not.toBeNull();
    expect(Object.keys(result!.agents)).toHaveLength(2);
    expect(result!.routeTable.routes.size).toBe(2);
  });

  it('sets model: "working" — semantic alias for user\'s working-tier Claude model', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'DeepSeek', model: 'deepseek-r1' }),
    ];
    const result = buildCouncilConfig(makeSettings(profiles), '');
    expect(result).not.toBeNull();
    const agent = result!.agents['council-deepseek'];
    expect(agent.model).toBe('working');
  });

  it('sets routedModel metadata on council agent definitions', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'DeepSeek', model: 'deepseek-r1' }),
    ];
    const result = buildCouncilConfig(makeSettings(profiles), '');
    expect(result).not.toBeNull();
    const agent = result!.agents['council-deepseek'];
    expect(agent.routedModel).toBe('deepseek-r1');
  });

  it('skips duplicate model names (first wins)', () => {
    const profiles = [
      makeProfile({ id: 'first', name: 'First DeepSeek', model: 'deepseek-r1' }),
      makeProfile({ id: 'second', name: 'Second DeepSeek', model: 'deepseek-r1' }),
    ];
    const result = buildCouncilConfig(makeSettings(profiles), '');
    expect(result).not.toBeNull();
    expect(Object.keys(result!.agents)).toHaveLength(1);
    // The first profile should be the one registered
    expect(result!.routeTable.routes.get('deepseek-r1')?.id).toBe('first');
  });

  it('generates unique agent names for profiles with colliding slugs', () => {
    // "GPT-5" and "GPT 5" both slugify to "council-gpt-5"
    const profiles = [
      makeProfile({ id: 'aaaa1111', name: 'GPT-5', model: 'gpt-5-turbo' }),
      makeProfile({ id: 'bbbb2222', name: 'GPT 5', model: 'gpt-5-standard' }),
    ];
    const result = buildCouncilConfig(makeSettings(profiles), '');
    expect(result).not.toBeNull();
    const agentNames = Object.keys(result!.agents);
    expect(agentNames).toHaveLength(2);
    // First gets the clean name, second gets the id-suffixed name
    expect(agentNames[0]).toBe('council-gpt-5');
    expect(agentNames[1]).toBe('council-gpt-5-bbbb2222');
  });

  it('system prompt includes all surviving agent names', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'DeepSeek', model: 'deepseek-r1' }),
      makeProfile({ id: 'b', name: 'Gemini', model: 'gemini-2.5-pro' }),
    ];
    const result = buildCouncilConfig(makeSettings(profiles), '');
    expect(result).not.toBeNull();
    expect(result!.systemPromptSuffix).toContain('council-deepseek');
    expect(result!.systemPromptSuffix).toContain('council-gemini');
    expect(result!.systemPromptSuffix).toContain('COUNCIL MODE IS ACTIVE');
  });

  it('supports more than 3 council members (no alias slot cap)', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'DeepSeek', model: 'deepseek-r1' }),
      makeProfile({ id: 'b', name: 'GPT-5', model: 'gpt-5' }),
      makeProfile({ id: 'c', name: 'Gemini', model: 'gemini-3-flash' }),
      makeProfile({ id: 'd', name: 'Llama', model: 'llama-3.3-70b' }),
      makeProfile({ id: 'e', name: 'Mistral', model: 'mistral-large' }),
    ];
    const result = buildCouncilConfig(makeSettings(profiles), '');
    expect(result).not.toBeNull();
    expect(Object.keys(result!.agents)).toHaveLength(5);
    expect(result!.routeTable.routes.size).toBe(5);

    // All agents use model: 'working'
    for (const agent of Object.values(result!.agents)) {
      expect(agent.model).toBe('working');
    }

    // Each agent has routedModel metadata with the correct model
    const agents = Object.values(result!.agents);
    expect(agents[0].routedModel).toBe('deepseek-r1');
    expect(agents[1].routedModel).toBe('gpt-5');
    expect(agents[2].routedModel).toBe('gemini-3-flash');
    expect(agents[3].routedModel).toBe('llama-3.3-70b');
    expect(agents[4].routedModel).toBe('mistral-large');
  });

  it('includes base system prompt context in agent prompts when provided', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'DeepSeek', model: 'deepseek-r1' }),
    ];
    const basePrompt = '# Rebel\n\n## [CONTEXT]\nSpaces and env here.\n\n## [TOOL_USE]\nMCP routing info.';
    const result = buildCouncilConfig(makeSettings(profiles), basePrompt);
    expect(result).not.toBeNull();
    const agent = result!.agents['council-deepseek'];
    expect(agent.prompt).toContain('Spaces and env here.');
    expect(agent.prompt).toContain('MCP routing info.');
    // Council-specific prompt still present
    expect(agent.prompt).toContain('You are a council member');
    expect(agent.routedModel).toBe('deepseek-r1');
  });

  it('excludes sections marked with <!-- council: exclude --> from agent prompts', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'DeepSeek', model: 'deepseek-r1' }),
    ];
    const basePrompt = [
      '## [CONTEXT]\nSpaces info.',
      '## [AGENT_USE] <!-- council: exclude -->\nSubagent instructions.',
      '## [TOOL_USE]\nMCP tools.',
    ].join('\n\n');
    const result = buildCouncilConfig(makeSettings(profiles), basePrompt);
    expect(result).not.toBeNull();
    const agent = result!.agents['council-deepseek'];
    expect(agent.prompt).toContain('Spaces info.');
    expect(agent.prompt).toContain('MCP tools.');
    expect(agent.prompt).not.toContain('Subagent instructions.');
    expect(agent.prompt).not.toContain('AGENT_USE');
  });
});

describe('resolveCouncilLeadModel — ambient thinking-tier characterization', () => {
  it('snapshots provider-dependent lead model resolution', () => {
    // CHARACTERIZATION: documents current behavior, not necessarily desired.
    const modelConfig = { model: 'openai/gpt-5.5' } as ModelConfig;

    expect((['anthropic', 'openrouter', 'codex', 'mindstone'] as const).map((activeProvider) => ({
      activeProvider,
      leadModel: resolveCouncilLeadModel(modelConfig, makeSettings([], {
        activeProvider,
        models: { model: 'claude-sonnet-4-6' } as AppSettings['models'],
      })),
    }))).toMatchInlineSnapshot(`
      [
        {
          "activeProvider": "anthropic",
          "leadModel": "claude-sonnet-4-6[1m]",
        },
        {
          "activeProvider": "openrouter",
          "leadModel": "anthropic/claude-opus-4-8",
        },
        {
          "activeProvider": "codex",
          "leadModel": "gpt-5.5",
        },
        {
          "activeProvider": "mindstone",
          "leadModel": "openai/gpt-5.5",
        },
      ]
    `);
  });
});

describe('buildCouncilConfig MCP inheritance', () => {
  it('propagates full MCP server configs to all council agent definitions', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'DeepSeek', model: 'deepseek-r1' }),
      makeProfile({ id: 'b', name: 'GPT-5', model: 'gpt-5' }),
    ];
    const mcpSpecs = [{ 'hubspot': { type: 'http' as const, url: 'http://localhost:3200/mcp' }, 'slack': { type: 'http' as const, url: 'http://localhost:3201/mcp' } }];
    const result = buildCouncilConfig(makeSettings(profiles), '', undefined, mcpSpecs);
    expect(result).not.toBeNull();
    for (const agent of Object.values(result!.agents)) {
      expect(agent.mcpServers).toEqual(mcpSpecs);
    }
  });

  it('omits mcpServers when mcpServerSpecs is undefined', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'DeepSeek', model: 'deepseek-r1' }),
    ];
    const result = buildCouncilConfig(makeSettings(profiles), '');
    expect(result).not.toBeNull();
    const agent = Object.values(result!.agents)[0];
    expect(agent.mcpServers).toBeUndefined();
  });
});

describe('buildAvailableModelsPrompt', () => {
  it('logs a structured warning when a council model has no pricing but still returns prompt text', async () => {
    vi.resetModules();

    const loggerModule = await import('@core/logger');
    const warn = vi.fn();
    const createScopedLoggerSpy = vi.spyOn(loggerModule, 'createScopedLogger').mockReturnValue({
      info: vi.fn(),
      warn,
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as ReturnType<typeof loggerModule.createScopedLogger>);

    const { buildAvailableModelsPrompt } = await import('../councilService');

    const agents = { 'model-custom-a1b2c3d4': makeAgent('my-custom-llm') };
    const profiles = [makeProfile({ id: 'profile-custom', name: 'Custom Council', model: 'my-custom-llm' })];

    const result = buildAvailableModelsPrompt(agents, profiles);

    expect(result).toContain('<available_models>');
    expect(result).toContain('**Custom Council**');
    expect(result).toContain('subagent_type: "model-custom-a1b2c3d4"');
    expect(createScopedLoggerSpy).toHaveBeenCalledWith({ service: 'councilService' });
    expect(warn).toHaveBeenCalledWith(
      { modelName: 'my-custom-llm', profileId: 'profile-custom', profileName: 'Custom Council' },
      'Council model has no pricing in MODEL_CATALOG — cost tier unavailable for routing decisions',
    );
  });

  it('includes profile override cost tier in available models prompt', async () => {
    vi.resetModules();
    const { buildAvailableModelsPrompt } = await import('../councilService');

    const agents = { 'model-gpt-oss-a1b2c3d4': makeAgent('gpt-oss-120b') };
    const profiles = [
      makeProfile({
        id: 'profile-override',
        name: 'Override Council',
        model: 'gpt-oss-120b',
        providerType: 'openai',
        costTier: 'premium',
      }),
    ];

    const result = buildAvailableModelsPrompt(agents, profiles);
    const modelLine = result.split('\n').find(line => line.includes('**Override Council**'));
    expect(modelLine).toBeDefined();
    expect(modelLine).toContain('premium');
    expect(modelLine).not.toContain('| economy |');
  });

  it("resolves 'economy' for local profile in available models prompt", async () => {
    vi.resetModules();
    const { buildAvailableModelsPrompt } = await import('../councilService');

    const agents = { 'model-local-a1b2c3d4': makeAgent('my-local-llm') };
    const profiles = [
      makeProfile({
        id: 'profile-local',
        name: 'Local Council',
        model: 'my-local-llm',
        providerType: 'local',
      }),
    ];

    const result = buildAvailableModelsPrompt(agents, profiles);
    const modelLine = result.split('\n').find(line => line.includes('**Local Council**'));
    expect(modelLine).toBeDefined();
    expect(modelLine).toContain('economy');
  });
});

describe('resolveCouncilLeadModel (REBEL-655 — non-Claude lead support)', () => {
  // MA2: with the Stage-2 fix, ENV_THINKING_MODEL can carry a non-Claude thinking
  // model for a non-Claude thinking profile under council. resolveCouncilLeadModel
  // reads it FIRST (after the working==Claude short-circuit), so the council lead
  // can legitimately be a non-Claude model. This is a SUPPORTED path — buildCouncilConfig's
  // own fallback already returns a non-Claude lead for non-Anthropic providers — so it
  // must NOT be guarded back to Claude. This test locks that contract.
  function makeConfig(model: string, planningModel?: string): ModelConfig {
    return {
      model,
      envOverrides: planningModel ? { PLANNING_MODEL: planningModel } : undefined,
    };
  }
  function makeNonAnthropicSettings(): AppSettings {
    return {
      activeProvider: 'codex',
      localModel: { profiles: [], activeProfileId: null },
    } as unknown as AppSettings;
  }

  it('returns the non-Claude thinking model from ENV_THINKING_MODEL when working model is not Claude', () => {
    // Plan-mode alias as the working model + a non-Claude PLANNING_MODEL (the real
    // proxy-backed thinking model) → lead resolves to that non-Claude model.
    const config = makeConfig('planner', 'gpt-5.5');
    const lead = resolveCouncilLeadModel(config, makeNonAnthropicSettings());
    expect(lead).toBe('gpt-5.5');
    expect(lead.startsWith('claude-')).toBe(false);
  });

  it('still returns the working Claude model unchanged when it is already Claude', () => {
    const config = makeConfig('claude-sonnet-4-6', 'claude-opus-4-8');
    const lead = resolveCouncilLeadModel(config, makeNonAnthropicSettings());
    expect(lead).toBe('claude-sonnet-4-6');
  });
});
