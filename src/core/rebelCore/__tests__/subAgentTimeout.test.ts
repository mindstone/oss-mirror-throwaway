import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeAgentTool } from '../agentTool';
import * as agentLoopModule from '../agentLoop';
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

describe('executeAgentTool timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const getBaseCtx = (): AgentToolContext => ({
    agents: {
      test: {
        description: 'Test',
        prompt: 'test prompt',
        model: 'haiku',
      }
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
    parentModel: unsafeAssertRoutingModelId('test-parent'),
  });

  it('1. Sub-agent with maxDurationMs that completes before timeout -> normal result', async () => {
    const ctx = getBaseCtx();
    ctx.agents['test'].maxDurationMs = 1000;

    vi.mocked(agentLoopModule.runAgentLoop).mockImplementation(async (config, _executor, onEvent) => {
      onEvent?.({ type: 'assistant:text', text: 'success output' } as any);
      return { totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, turns: 1, messageHistory: [] };
    });

    const result = await executeAgentTool({ agent: 'test', prompt: 'do it' }, ctx);
    
    expect(result.isError).toBe(false);
    expect(result.output).toBe('success output');
  });

  it('2. Sub-agent that exceeds maxDurationMs -> throws AgentToolTimeoutError (caught by agentLoop)', async () => {
    vi.useFakeTimers();
    try {
      const ctx = getBaseCtx();
      ctx.agents['test'].maxDurationMs = 1000;

      vi.mocked(agentLoopModule.runAgentLoop).mockImplementation(async (config, _executor, _onEvent) => {
        return new Promise<any>((resolve, reject) => {
          config.signal?.addEventListener('abort', () => {
            const err = new Error('TimeoutError');
            err.name = 'TimeoutError';
            reject(err);
          });
        });
      });

      const promise = executeAgentTool({ agent: 'test', prompt: 'do it' }, ctx);
      
      vi.advanceTimersByTime(1100);
      
      await expect(promise).rejects.toThrow('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('3. Parent abort during sub-agent with timeout -> re-throws', async () => {
    const ctx = getBaseCtx();
    ctx.agents['test'].maxDurationMs = 1000;
    
    const parentController = new AbortController();
    ctx.signal = parentController.signal;

    vi.mocked(agentLoopModule.runAgentLoop).mockImplementation(async (config, _executor, _onEvent) => {
      return new Promise<any>((resolve, reject) => {
        config.signal?.addEventListener('abort', () => {
          const err = new Error('AbortError');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const promise = executeAgentTool({ agent: 'test', prompt: 'do it' }, ctx);
    
    parentController.abort();
    
    await expect(promise).rejects.toThrow('AbortError');
  });

  it('4. No maxDurationMs -> uses parent signal only', async () => {
    const ctx = getBaseCtx();
    const parentController = new AbortController();
    ctx.signal = parentController.signal;

    vi.mocked(agentLoopModule.runAgentLoop).mockImplementation(async (config) => {
      expect(config.signal).toBe(parentController.signal);
      return { totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, turns: 1, messageHistory: [] };
    });

    await executeAgentTool({ agent: 'test', prompt: 'do it' }, ctx);
  });

  it('5. onSubAgentComplete called with partial usage on timeout', async () => {
    vi.useFakeTimers();
    try {
      const ctx = getBaseCtx();
      ctx.agents['test'].maxDurationMs = 1000;
      ctx.onSubAgentComplete = vi.fn();

      vi.mocked(agentLoopModule.runAgentLoop).mockImplementation(async (config, _executor, onEvent) => {
        onEvent?.({
          type: 'turn:complete',
          usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
          stopReason: 'tool_use'
        } as any);

        return new Promise<any>((resolve, reject) => {
          config.signal?.addEventListener('abort', () => {
            const err = new Error('TimeoutError');
            err.name = 'TimeoutError';
            reject(err);
          });
        });
      });

      const promise = executeAgentTool({ agent: 'test', prompt: 'do it' }, ctx);
      
      vi.advanceTimersByTime(1100);
      
      await expect(promise).rejects.toThrow('timed out');
      expect(ctx.onSubAgentComplete).toHaveBeenCalled();
      const usageMap = vi.mocked(ctx.onSubAgentComplete).mock.calls[0][0];
      const usage = usageMap.get('claude-haiku-4-20250414'); // Because haiku alias resolves to default behindTheScenesModel
      expect(usage?.inputTokens).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });
});
