import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import { computeSessionStats } from '../sessionDiagnostics';

const createMessage = (turnId: string, createdAt: number): AgentTurnMessage => ({
  id: `${turnId}-${createdAt}`,
  turnId,
  role: 'user',
  text: `Message for ${turnId}`,
  createdAt
});

const createResultEvent = (
  timestamp: number,
  overrides: Partial<Extract<AgentEvent, { type: 'result' }>> = {}
): AgentEvent => ({
  type: 'result',
  text: 'Done',
  timestamp,
  ...overrides
});

const createToolEvent = (
  stage: 'start' | 'end',
  timestamp: number,
  detail = '{}',
  overrides: Partial<Extract<AgentEvent, { type: 'tool' }>> = {}
): AgentEvent => ({
  type: 'tool',
  toolName: 'Read',
  stage,
  detail,
  timestamp,
  ...overrides
});

const createErrorEvent = (timestamp: number): AgentEvent => ({
  type: 'error',
  error: 'Something failed',
  timestamp
});

describe('computeSessionStats', () => {
  it('aggregates a normal multi-turn session with full data', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        createToolEvent('start', 1000),
        createResultEvent(5000, {
          model: 'claude-sonnet-4',
          usage: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheCreationTokens: 200,
            cacheReadTokens: 300,
            costUsd: 0.25,
            contextWindow: 200_000
          }
        })
      ],
      'turn-2': [
        createErrorEvent(7000),
        createToolEvent('end', 7500, '{"error":"boom"}', { isError: true }),
        createResultEvent(10_000, {
          model: 'claude-sonnet-4',
          usage: {
            inputTokens: 1500,
            outputTokens: 600,
            cacheCreationTokens: 100,
            cacheReadTokens: 400,
            costUsd: 0.35,
            contextWindow: 200_000
          }
        })
      ]
    };
    const messages = [createMessage('turn-1', 900), createMessage('turn-2', 6900)];

    const stats = computeSessionStats(eventsByTurn, messages);

    expect(stats).toEqual({
      turnCount: 2,
      totalDurationMs: 9000,
      totalCostUsd: 0.6,
      totalInputTokens: 2500,
      totalOutputTokens: 1100,
      totalCacheReadTokens: 700,
      totalCacheWriteTokens: 300,
      contextWindowMode: '200K',
      errorCount: 2,
      modelName: 'claude-sonnet-4',
      isCompacted: false,
      cacheEfficiencyPercent: 25
    });
  });

  it('returns zeroed defaults for an empty session', () => {
    const stats = computeSessionStats({}, []);

    expect(stats).toEqual({
      turnCount: 0,
      totalDurationMs: 0,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      contextWindowMode: '—',
      errorCount: 0,
      modelName: '—',
      isCompacted: false,
      cacheEfficiencyPercent: 0
    });
  });

  it('handles missing usage data and null usage fields', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        createResultEvent(5000, {
          model: 'claude-sonnet-4',
          usage: {
            inputTokens: null,
            outputTokens: null,
            cacheCreationTokens: null,
            cacheReadTokens: null,
            costUsd: null,
            contextWindow: null
          }
        })
      ],
      'turn-2': [
        createResultEvent(7000, {
          model: 'claude-sonnet-4'
        })
      ]
    };
    const messages = [createMessage('turn-1', 4000), createMessage('turn-2', 6000)];

    const stats = computeSessionStats(eventsByTurn, messages);

    expect(stats.turnCount).toBe(2);
    expect(stats.totalCostUsd).toBe(0);
    expect(stats.totalInputTokens).toBe(0);
    expect(stats.totalOutputTokens).toBe(0);
    expect(stats.totalCacheReadTokens).toBe(0);
    expect(stats.totalCacheWriteTokens).toBe(0);
    expect(stats.contextWindowMode).toBe('—');
    expect(stats.modelName).toBe('claude-sonnet-4');
    expect(stats.cacheEfficiencyPercent).toBe(0);
  });

  it('detects compacted sessions when tool end detail is empty', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        createToolEvent('start', 1000),
        createToolEvent('end', 1200, '')
      ]
    };
    const messages = [createMessage('turn-1', 900)];

    const stats = computeSessionStats(eventsByTurn, messages);

    expect(stats.isCompacted).toBe(true);
    expect(stats.turnCount).toBe(1);
  });

  it('returns Mixed for sessions with multiple models', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        createResultEvent(1000, {
          model: 'claude-sonnet-4',
          usage: { contextWindow: 200_000 }
        })
      ],
      'turn-2': [
        createResultEvent(2000, {
          model: 'gpt-5',
          usage: { contextWindow: 1_000_000 }
        })
      ]
    };
    const messages = [createMessage('turn-1', 900), createMessage('turn-2', 1900)];

    const stats = computeSessionStats(eventsByTurn, messages);

    expect(stats.modelName).toBe('Mixed');
    expect(stats.contextWindowMode).toBe('Mixed');
  });

  it('handles a single-turn session', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        { type: 'status', message: 'Starting', timestamp: 100 },
        createResultEvent(2100, {
          model: 'claude-sonnet-4',
          usage: {
            inputTokens: 120,
            outputTokens: 42,
            cacheCreationTokens: 8,
            cacheReadTokens: 30,
            costUsd: 0.03,
            contextWindow: 1_000_000
          }
        })
      ]
    };
    const messages = [createMessage('turn-1', 80)];

    const stats = computeSessionStats(eventsByTurn, messages);

    expect(stats.turnCount).toBe(1);
    expect(stats.totalDurationMs).toBe(2000);
    expect(stats.totalCostUsd).toBe(0.03);
    expect(stats.contextWindowMode).toBe('1M');
    expect(stats.modelName).toBe('claude-sonnet-4');
    expect(stats.isCompacted).toBe(false);
  });
});
