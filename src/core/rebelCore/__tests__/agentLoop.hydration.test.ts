import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runAgentLoop } from '../agentLoop';
import { TurnScopedHydrationCache } from '@core/services/imageHydrationCache';
import type { ModelClient } from '../modelClient';

const mockClear = vi.fn();
 
vi.mock('@core/services/imageHydrationCache', () => {
  return {
    TurnScopedHydrationCache: vi.fn(function() {
      return { clear: mockClear };
    })
  };
});

describe('runAgentLoop hydration lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('instantiates cache, passes it to client, and clears it on turn end', async () => {
    const mockStream = vi.fn().mockResolvedValue({
      content: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 },
      model: unsafeAssertRoutingModelId('test-model')
    });

    const mockClient = {
      stream: mockStream,
      capabilities: { supportsImageContent: () => true }
    } as unknown as ModelClient;

    await runAgentLoop(
      {
        client: mockClient,
        messages: [{ role: 'user', content: 'test' }],
        model: unsafeAssertRoutingModelId('test-model'),
        systemPrompt: 'sys',
        maxTurns: 1,
        sessionId: 'session-123'
      },
      vi.fn(),
      vi.fn()
    );

    // Assert cache was instantiated
    expect(TurnScopedHydrationCache).toHaveBeenCalledTimes(1);
    
    // Assert cache was passed to stream
    expect(mockStream).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-123',
        hydrationCache: expect.anything()
      }),
      expect.any(Function)
    );

    // Assert cache was cleared
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  it('clears cache even if turn throws an error', async () => {
    const mockStream = vi.fn().mockRejectedValue(new Error('Simulated failure'));

    const mockClient = {
      stream: mockStream,
      capabilities: { supportsImageContent: () => true }
    } as unknown as ModelClient;

    await expect(runAgentLoop(
      {
        client: mockClient,
        messages: [{ role: 'user', content: 'test' }],
        model: unsafeAssertRoutingModelId('test-model'),
        systemPrompt: 'sys',
        maxTurns: 1,
        sessionId: 'session-123'
      },
      vi.fn(),
      vi.fn()
    )).rejects.toThrow('Simulated failure');

    // Assert cache was cleared in finally block
    expect(mockClear).toHaveBeenCalledTimes(1);
  });
});
