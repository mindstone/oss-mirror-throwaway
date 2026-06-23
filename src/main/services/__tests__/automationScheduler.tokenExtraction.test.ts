import { describe, it, expect } from 'vitest';
import { extractTokenUsageFromEvents } from '../automationScheduler';
import { buildResultEvent, buildStatusEvent } from '@core/__tests__/builders/eventBuilder';

const makeToolMetrics = (totalToolCalls: number, failedToolCalls: number) => ({
  totalToolCalls,
  failedToolCalls,
  filesCreated: 0,
  filesEdited: 0,
  toolUsageByCategory: {},
  mcpServerUsage: {},
  totalToolOutputChars: 0,
  mcpToolOutputChars: 0,
  builtinToolOutputChars: 0,
});

describe('extractTokenUsageFromEvents', () => {
  it('returns null for undefined input', () => {
    expect(extractTokenUsageFromEvents(undefined)).toBeNull();
  });

  it('returns null when there are no result events', () => {
    const eventsByTurn = {
      'turn-1': [buildStatusEvent()],
    };
    expect(extractTokenUsageFromEvents(eventsByTurn)).toBeNull();
  });

  it('extracts metrics for a single turn', () => {
    const eventsByTurn = {
      'turn-1': [
        buildResultEvent({
          usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, costUsd: 0.01 },
          toolMetrics: makeToolMetrics(2, 0)
        })
      ]
    };
    const result = extractTokenUsageFromEvents(eventsByTurn);
    expect(result).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      costUsd: 0.01,
      toolCallCount: 2
    });
  });

  it('sums metrics across multiple turns', () => {
    const eventsByTurn = {
      'turn-1': [
        buildResultEvent({
          usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, costUsd: 0.01 },
          toolMetrics: makeToolMetrics(1, 0)
        })
      ],
      'turn-2': [
        buildStatusEvent(),
        buildResultEvent({
          usage: { inputTokens: 15, outputTokens: 25, cacheReadTokens: 10, costUsd: 0.02 },
          toolMetrics: makeToolMetrics(3, 1)
        })
      ]
    };
    const result = extractTokenUsageFromEvents(eventsByTurn);
    expect(result).toEqual({
      inputTokens: 25,
      outputTokens: 45,
      cacheReadTokens: 15,
      costUsd: 0.03,
      toolCallCount: 4
    });
  });

  it('handles events with null costUsd', () => {
    const eventsByTurn = {
      'turn-1': [
        buildResultEvent({
          usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, costUsd: null },
          toolMetrics: makeToolMetrics(1, 0)
        })
      ],
      'turn-2': [
        buildResultEvent({
          usage: { inputTokens: 15, outputTokens: 25, cacheReadTokens: 0, costUsd: 0.02 },
          toolMetrics: makeToolMetrics(0, 0)
        })
      ]
    };
    const result = extractTokenUsageFromEvents(eventsByTurn);
    expect(result).toEqual({
      inputTokens: 25,
      outputTokens: 45,
      cacheReadTokens: 5,
      costUsd: 0.02,
      toolCallCount: 1
    });
  });

  it('handles result events with missing toolMetrics', () => {
    const eventsByTurn = {
      'turn-1': [
        buildResultEvent({
          usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, costUsd: 0.01 },
        })
      ]
    };
    const result = extractTokenUsageFromEvents(eventsByTurn);
    expect(result).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      costUsd: 0.01,
      toolCallCount: 0
    });
  });
});
