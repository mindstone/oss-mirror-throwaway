import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeAgentTool } from '../agentTool';
import * as agentLoopModule from '../agentLoop';
import { ModelError } from '../modelErrors';
import type { AgentToolContext } from '../types';

vi.mock('../agentLoop', () => ({
  runAgentLoop: vi.fn(),
}));

vi.mock('../clientFactory', () => ({
  createClientForModel: vi.fn().mockReturnValue({}),
  createClientFromRoutePlan: vi.fn().mockReturnValue({}),
  resolveTargetForModel: vi.fn().mockReturnValue({ kind: 'anthropic-direct', model: unsafeAssertRoutingModelId('claude-haiku-4-20250414'), resolvedFrom: 'model-string' }),
  targetNeedsProxy: vi.fn().mockReturnValue(false),
}));

describe('subAgentCostTracking in executeAgentTool', () => {
  let mockContext: AgentToolContext;

  beforeEach(() => {
    vi.resetAllMocks();
    
    mockContext = {
      agents: {
        forager: {
          description: 'A foraging agent',
          prompt: 'Find things',
          model: 'haiku',
          lightweight: true,
        },
      },
      client: {} as any,
      codexConnectivity: 'unknown',
      settings: {
        models: {
          apiKey: 'fake-ant-test',
          model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
        },
        behindTheScenesModel: 'claude-haiku-4-20250414',
        localModel: { profiles: [] },
      } as any,
      parentModel: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
      cwd: '/tmp',
      signal: new AbortController().signal,
      onSubAgentComplete: vi.fn(),
    };
  });

  it('calls onSubAgentComplete after successful execution', async () => {
    vi.mocked(agentLoopModule.runAgentLoop).mockImplementation(async (config, executor, onEvent) => {
      onEvent({
        type: 'turn:complete',
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: 'end_turn',
        model: unsafeAssertRoutingModelId('claude-haiku-4-20250414'),
      });
      return { totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 }, turns: 1, messageHistory: [] };
    });

    const result = await executeAgentTool({ agent: 'forager', prompt: 'Search' }, mockContext);
    
    expect(result.isError).toBe(false);
    expect(mockContext.onSubAgentComplete).toHaveBeenCalledOnce();
    
    const usageMap = vi.mocked(mockContext.onSubAgentComplete!).mock.calls[0][0];
    expect(usageMap.has('claude-haiku-4-20250414')).toBe(true);
    expect(usageMap.get('claude-haiku-4-20250414')).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      exactCostUsd: undefined,
      fulfillmentProvider: undefined,
      openRouterProvider: undefined,
      providersSeen: [],
    });
  });

  it('calls onSubAgentComplete with partial usage on non-abort error', async () => {
    vi.mocked(agentLoopModule.runAgentLoop).mockImplementation(async (config, executor, onEvent) => {
      onEvent({
        type: 'turn:complete',
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: 'tool_use',
        model: unsafeAssertRoutingModelId('claude-haiku-4-20250414'),
      });
      throw new Error('API failure');
    });

    const result = await executeAgentTool({ agent: 'forager', prompt: 'Search' }, mockContext);
    
    expect(result.isError).toBe(true);
    expect(mockContext.onSubAgentComplete).toHaveBeenCalledOnce();
    
    const usageMap = vi.mocked(mockContext.onSubAgentComplete!).mock.calls[0][0];
    expect(usageMap.get('claude-haiku-4-20250414')).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      exactCostUsd: undefined,
      fulfillmentProvider: undefined,
      openRouterProvider: undefined,
      providersSeen: [],
    });
  });

  it('calls onSubAgentComplete with partial usage on abort', async () => {
    vi.mocked(agentLoopModule.runAgentLoop).mockImplementation(async (config, executor, onEvent) => {
      onEvent({
        type: 'turn:complete',
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: 'tool_use',
        model: unsafeAssertRoutingModelId('claude-haiku-4-20250414'),
      });
      
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      throw abortError;
    });

    await expect(executeAgentTool({ agent: 'forager', prompt: 'Search' }, mockContext))
      .rejects.toThrow('Aborted');
      
    expect(mockContext.onSubAgentComplete).toHaveBeenCalledOnce();
    const usageMap = vi.mocked(mockContext.onSubAgentComplete!).mock.calls[0][0];
    expect(usageMap.get('claude-haiku-4-20250414')).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      exactCostUsd: undefined,
      fulfillmentProvider: undefined,
      openRouterProvider: undefined,
      providersSeen: [],
    });
  });
  
  it('calls onSubAgentComplete with partial usage on ModelError with isAbort', async () => {
    vi.mocked(agentLoopModule.runAgentLoop).mockImplementation(async (config, executor, onEvent) => {
      onEvent({
        type: 'turn:complete',
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: 'tool_use',
        model: unsafeAssertRoutingModelId('claude-haiku-4-20250414'),
      });
      
      const error = new ModelError('abort', 'Aborted from model error');
      throw error;
    });

    await expect(executeAgentTool({ agent: 'forager', prompt: 'Search' }, mockContext))
      .rejects.toThrow('Aborted from model error');
      
    expect(mockContext.onSubAgentComplete).toHaveBeenCalledOnce();
    const usageMap = vi.mocked(mockContext.onSubAgentComplete!).mock.calls[0][0];
    expect(usageMap.get('claude-haiku-4-20250414')).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      exactCostUsd: undefined,
      fulfillmentProvider: undefined,
      openRouterProvider: undefined,
      providersSeen: [],
    });
  });
});
