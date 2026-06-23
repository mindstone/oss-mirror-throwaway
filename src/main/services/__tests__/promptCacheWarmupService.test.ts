/**
 * Prompt Cache Warmup Service Tests
 *
 * Verifies that the warmup service produces API requests with the correct
 * cache prefix (tools, system prompt shape, cache_control, beta endpoint)
 * so that subsequent real agent turns get cache HITs.
 *
 * See: docs/plans/260412_fix_prompt_cache_warmup.md
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppSettings } from '@shared/types';

// ---- hoisted mocks ----
const { mockBetaCreate } = vi.hoisted(() => ({
  mockBetaCreate: vi.fn(),
}));

 
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { create: mockBetaCreate } };
    messages = { create: vi.fn() };
    constructor() { /* accept any config */ }
  }
  return { Anthropic: MockAnthropic };
});

 
vi.mock('../mcpService', () => ({
  resolveSystemPrompt: vi.fn().mockResolvedValue('You are a helpful assistant.'),
  buildConnectedPackages: vi.fn().mockResolvedValue([]),
}));

 
vi.mock('../superMcpHttpManager', () => ({
  superMcpHttpManager: {
    getState: vi.fn().mockReturnValue({ isRunning: true, url: 'http://localhost:9999' }),
  },
}));

 
vi.mock('@core/rebelCore/toolRegistry', () => ({
  listRegisteredTools: vi.fn().mockReturnValue([
    { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
  ]),
}));

 
vi.mock('@core/rebelCore/mcpClient', () => ({
  createMcpSession: vi.fn().mockResolvedValue({
    listTools: vi.fn().mockResolvedValue([
      { apiToolName: 'web_search', tool: { name: 'web_search', description: 'Search the web', input_schema: { type: 'object', properties: {} } } },
    ]),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

 
vi.mock('@core/rebelCore/agentTool', () => ({
  buildAgentToolDefinition: vi.fn().mockReturnValue({
    name: 'Agent',
    description: 'Delegate to agent',
    input_schema: { type: 'object', properties: {} },
  }),
}));

 
vi.mock('@core/rebelCore/builtinTools', () => ({
  MISSION_SET_TOOL_DEFINITION: { name: 'mission_set', description: 'Set mission', input_schema: { type: 'object', properties: {} } },
  GET_PREVIOUS_TASKS_TOOL_DEFINITION: { name: 'get_previous_tasks', description: 'Get tasks', input_schema: { type: 'object', properties: {} } },
}));

 
vi.mock('@core/rebelCore/foragerPrompt', () => ({
  FORAGER_AGENT_NAME: 'forager',
  buildForagerAgentDef: vi.fn().mockReturnValue({
    description: 'Forager agent',
    prompt: 'forage',
    tools: [],
  }),
}));

 
vi.mock('@core/services/capabilityResolutionService', () => ({
  resolveCapabilities: vi.fn().mockReturnValue({
    disallowedTools: [],
    promptGuidance: ['Use web search for current info'],
    activeCapabilities: [],
  }),
}));

 
vi.mock('@core/utils/authEnvUtils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@core/utils/authEnvUtils')>();
  return {
    ...original,
    hasValidAuth: vi.fn().mockReturnValue(true),
    getAuthForDirectUse: vi.fn().mockReturnValue({ apiKey: 'test-key' }),
  };
});

 
vi.mock('@shared/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@shared/types')>();
  return {
    ...original,
    getWorkingModelProfile: vi.fn().mockReturnValue({
      model: 'claude-sonnet-4-6',
      // No providerType = direct Anthropic (default)
    }),
  };
});

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

 
vi.mock('@core/constants', async (importOriginal) => {
  const original = await importOriginal<typeof import('@core/constants')>();
  return {
    ...original,
    KNOWLEDGE_WORKER_AGENT_NAME: 'knowledge-worker',
    KNOWLEDGE_WORKER_AGENT_DESCRIPTION: 'A knowledge worker agent',
  };
});

 
vi.mock('@shared/utils/modelNormalization', () => ({
  MODEL_OPTIONS: [],
  ENV_EXECUTION_MODEL: 'CLAUDE_CODE_USE_MODEL',
  normalizeModel: (model: string) => model,
  resolveModelConfig: vi.fn().mockReturnValue({
    model: 'claude-sonnet-4-6',
    envOverrides: {},
  }),
}));

 
vi.mock('../costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

 
vi.mock('@shared/utils/pricingCalculator', () => ({
  calculateCostOrWarn: vi.fn().mockReturnValue(0.02),
}));

import { warmPromptCache } from '../promptCacheWarmupService';
import { getWorkingModelProfile } from '@shared/types';
import { resolveSystemPrompt } from '../mcpService';
import { createMcpSession } from '@core/rebelCore/mcpClient';
import { getAuthForDirectUse } from '@core/utils/authEnvUtils';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';

// ---- helpers ----

function createMockSettings(overrides?: Partial<AppSettings>): AppSettings {
  return {
    coreDirectory: '/test/core',
    claude: { model: 'claude-sonnet-4-6' },
    ...overrides,
  } as unknown as AppSettings;
}

function setupSuccessResponse() {
  mockBetaCreate.mockResolvedValue({
    content: [{ type: 'text', text: 'ready' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 5000,
      output_tokens: 2,
      cache_creation_input_tokens: 4500,
      cache_read_input_tokens: 0,
    },
  });
}

// ---- tests ----

describe('promptCacheWarmupService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // vi.clearAllMocks() clears mock.calls/results but NOT queued
    // mockReturnValueOnce values. Some routing tests queue
    // mockReturnValueOnce on getAuthForDirectUse / getWorkingModelProfile
    // which can leak past their test when the active-provider guard
    // short-circuits before the mocked function is called. Reset and re-apply
    // the persistent defaults so each test starts from a known state.
    vi.mocked(getAuthForDirectUse).mockReset().mockReturnValue({ apiKey: 'test-key' });
    vi.mocked(getWorkingModelProfile).mockReset().mockReturnValue({
      model: 'claude-sonnet-4-6',
    } as any);
    setupSuccessResponse();
  });

  describe('cache prefix parity', () => {
    it('includes cache_control: { type: "ephemeral" } in the request', async () => {
      const settings = createMockSettings();
      await warmPromptCache(settings);

      expect(mockBetaCreate).toHaveBeenCalledTimes(1);
      const params = mockBetaCreate.mock.calls[0][0];
      expect(params.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('uses beta.messages.create (not messages.create)', async () => {
      const settings = createMockSettings();
      await warmPromptCache(settings);

      expect(mockBetaCreate).toHaveBeenCalledTimes(1);
    });

    it('includes tools in the correct order (builtins → MCP → agent → mission/task)', async () => {
      const settings = createMockSettings();
      await warmPromptCache(settings);

      const params = mockBetaCreate.mock.calls[0][0];
      expect(params.tools).toBeDefined();
      expect(params.tools.length).toBe(5);
      expect(params.tools[0].name).toBe('Read'); // builtin
      expect(params.tools[1].name).toBe('web_search'); // MCP
      expect(params.tools[2].name).toBe('Agent'); // agent tool
      expect(params.tools[3].name).toBe('mission_set'); // mission
      expect(params.tools[4].name).toBe('get_previous_tasks'); // task
    });

    it('filters out suppressed tools from the request', async () => {
      const { resolveCapabilities } = await import('@core/services/capabilityResolutionService');
      vi.mocked(resolveCapabilities).mockReturnValueOnce({
        disallowedTools: ['web_search'],
        promptGuidance: [],
        activeCapabilities: [],
      });

      const settings = createMockSettings();
      await warmPromptCache(settings);

      const params = mockBetaCreate.mock.calls[0][0];
      expect(params.tools).toBeDefined();
      expect(params.tools.some((t: any) => t.name === 'web_search')).toBe(false);
      expect(params.tools.some((t: any) => t.name === 'Read')).toBe(true);
    });

    it('does not flatten system prompt to string when it is an array', async () => {
      const textBlocks = [
        { type: 'text' as const, text: 'Block 1', cache_control: { type: 'ephemeral' as const } },
        { type: 'text' as const, text: 'Block 2' },
      ];
      vi.mocked(resolveSystemPrompt).mockResolvedValueOnce(textBlocks as any);

      const settings = createMockSettings();
      await warmPromptCache(settings);

      const params = mockBetaCreate.mock.calls[0][0];
      expect(Array.isArray(params.system)).toBe(true);
      expect(params.system).toEqual(textBlocks);
    });

    it('appends capability guidance when system prompt is a string', async () => {
      vi.mocked(resolveSystemPrompt).mockResolvedValueOnce('Base system prompt');

      const settings = createMockSettings();
      await warmPromptCache(settings);

      const params = mockBetaCreate.mock.calls[0][0];
      expect(typeof params.system).toBe('string');
      expect(params.system).toContain('Base system prompt');
      expect(params.system).toContain('**Active capability upgrades:**');
      expect(params.system).toContain('Use web search for current info');
    });
  });

  describe('provider routing', () => {
    it('skips warmup for OpenRouter', async () => {
      const settings = createMockSettings({
        activeProvider: 'openrouter',
        openRouter: { enabled: true, oauthToken: 'or-token' },
      } as any);
      const result = await warmPromptCache(settings);

      expect(result.success).toBe(true);
      expect(mockBetaCreate).not.toHaveBeenCalled();
    });

    it('skips warmup for OpenRouter even without a lingering Anthropic key', async () => {
      vi.mocked(getAuthForDirectUse).mockReturnValueOnce({});

      const settings = createMockSettings({
        activeProvider: 'openrouter',
        openRouter: { enabled: true, oauthToken: 'or-token' },
      } as any);
      const result = await warmPromptCache(settings);

      expect(result.success).toBe(true);
      expect(mockBetaCreate).not.toHaveBeenCalled();
    });

    it('skips warmup for non-Anthropic providers', async () => {
      vi.mocked(getWorkingModelProfile).mockReturnValueOnce({
        model: 'gpt-5.5',
        providerType: 'openai',
      } as any);

      const settings = createMockSettings();
      const result = await warmPromptCache(settings);

      expect(result.success).toBe(true);
      expect(mockBetaCreate).not.toHaveBeenCalled();
    });

    it('skips warmup for custom/other provider types (LiteLLM, Bedrock proxies)', async () => {
      vi.mocked(getWorkingModelProfile).mockReturnValueOnce({
        model: 'claude-sonnet-4-6',
        providerType: 'other',
      } as any);

      const settings = createMockSettings();
      const result = await warmPromptCache(settings);

      expect(result.success).toBe(true);
      expect(mockBetaCreate).not.toHaveBeenCalled();
    });

    // R4 (plan 260422): Codex-active users should not warm the Anthropic native
    // cache. Previously only OR was gated; Codex fell through and silently
    // misattributed warmup cost when a lingering claude.apiKey was present.
    it('skips warmup when provider route plan is not direct Anthropic (Codex active)', async () => {
      const settings = createMockSettings({ activeProvider: 'codex' } as any);
      const result = await warmPromptCache(settings);

      expect(result.success).toBe(true);
      expect(mockBetaCreate).not.toHaveBeenCalled();
    });

    // R4 (plan 260422): matrix row-19 parallel — lingering claude.apiKey must
    // not cross-provider-bypass the direct-Anthropic guard on the warmup path.
    it('skips warmup for Codex-active + lingering Anthropic key (row-19 parallel)', async () => {
      const settings = createMockSettings({
        activeProvider: 'codex',
        claude: { model: 'claude-sonnet-4-6', apiKey: 'fake-ant-lingering-key' },
      } as any);
      const result = await warmPromptCache(settings);

      expect(result.success).toBe(true);
      expect(mockBetaCreate).not.toHaveBeenCalled();
    });
  });

  describe('MCP session lifecycle', () => {
    it('closes MCP session after successful warmup', async () => {
      const settings = createMockSettings();
      await warmPromptCache(settings);

      const session = await vi.mocked(createMcpSession).mock.results[0].value;
      expect(session.close).toHaveBeenCalledTimes(1);
    });

    it('closes MCP session even if API call fails', async () => {
      mockBetaCreate.mockRejectedValueOnce(new Error('API error'));

      const settings = createMockSettings();
      await warmPromptCache(settings);

      const session = await vi.mocked(createMcpSession).mock.results[0].value;
      expect(session.close).toHaveBeenCalledTimes(1);
    });

    it('continues with builtin tools only if Super-MCP is not running', async () => {
      const { superMcpHttpManager } = await import('../superMcpHttpManager');
      vi.mocked(superMcpHttpManager.getState).mockReturnValueOnce({ isRunning: false, url: '' } as any);

      const settings = createMockSettings();
      await warmPromptCache(settings);

      expect(mockBetaCreate).toHaveBeenCalledTimes(1);
      const params = mockBetaCreate.mock.calls[0][0];
      // Should still have tools (builtins + agent + mission/task, but no MCP)
      expect(params.tools).toBeDefined();
      expect(params.tools.some((t: any) => t.name === 'Read')).toBe(true);
      expect(params.tools.some((t: any) => t.name === 'web_search')).toBe(false);
    });
  });

  describe('model resolution', () => {
    it('uses activeProfile model over settings.claude.model', async () => {
      vi.mocked(getWorkingModelProfile).mockReturnValueOnce({
        model: 'claude-opus-4-7',
        // No providerType = direct Anthropic
      } as any);

      const settings = createMockSettings({ claude: { model: 'claude-sonnet-4-6' } } as any);
      await warmPromptCache(settings);

      const params = mockBetaCreate.mock.calls[0][0];
      expect(params.model).toBe('claude-opus-4-7');
    });
  });

  // Stage 6 (260508) — F15: warmup must skip while any agent turn is active.
  describe('active-turn gate (Stage 6)', () => {
    const ACTIVE_TURN_ID = 'warmup-gate-test-turn-1';

    afterEach(() => {
      try { agentTurnRegistry.cleanupTurn(ACTIVE_TURN_ID); } catch { /* ignore */ }
    });

    it('skips warmup and returns failure result while a turn is active', async () => {
      const controller = new AbortController();
      agentTurnRegistry.setActiveTurnController(ACTIVE_TURN_ID, controller);

      const settings = createMockSettings();
      const result = await warmPromptCache(settings);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Active agent turn in flight');
      expect(mockBetaCreate).not.toHaveBeenCalled();
    });

    it('proceeds with warmup once the active-turn signal clears', async () => {
      const controller = new AbortController();
      agentTurnRegistry.setActiveTurnController(ACTIVE_TURN_ID, controller);

      const settings = createMockSettings();
      const blocked = await warmPromptCache(settings);
      expect(blocked.success).toBe(false);

      agentTurnRegistry.cleanupTurn(ACTIVE_TURN_ID);

      const allowed = await warmPromptCache(settings);
      expect(allowed.success).toBe(true);
      expect(mockBetaCreate).toHaveBeenCalledTimes(1);
    });

    /**
     * Stage 6 Phase 6 (260508): finding 3.1 — mid-call abort closure.
     *
     * The entry guard above only catches turns that are already active when
     * warmup starts. A turn that engages mid-call (during prompt assembly,
     * MCP tool resolution, or the Anthropic request) used to ride to
     * completion and compete with streaming. The fix subscribes to the
     * registry's turn-idle state change for the duration of `executeWarmup`
     * and aborts the in-flight SDK call when the active-turn signal goes
     * high. This test simulates that race by holding the SDK mock open and
     * registering a turn after warmup has already started.
     */
    it('aborts mid-call when a turn engages during the SDK request', async () => {
      let receivedSignal: AbortSignal | undefined;
      mockBetaCreate.mockImplementationOnce((_params: unknown, opts: { signal?: AbortSignal } = {}) => {
        receivedSignal = opts.signal;
        return new Promise((_, reject) => {
          if (opts.signal) {
            const onAbort = (): void => {
              const reason = opts.signal?.reason ?? 'aborted';
              reject(new Error(typeof reason === 'string' ? reason : 'aborted'));
            };
            if (opts.signal.aborted) onAbort();
            else opts.signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      });

      const settings = createMockSettings();
      const warmupPromise = warmPromptCache(settings);

      // Wait for warmup to progress past the entry guard and into the SDK
      // call before engaging a turn. We poll on `mockBetaCreate` being
      // invoked rather than using setTimeout so the test stays
      // determinism-friendly under fake timers.
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (mockBetaCreate.mock.calls.length > 0) {
            resolve();
          } else {
            setImmediate(check);
          }
        };
        check();
      });

      const turnController = new AbortController();
      agentTurnRegistry.setActiveTurnController(ACTIVE_TURN_ID, turnController);

      const result = await warmupPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Aborted');
      expect(receivedSignal).toBeDefined();
      expect(receivedSignal?.aborted).toBe(true);
    });
  });
});
