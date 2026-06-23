import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import type { InsightTurnSummary } from '../../../work-surface/types';
import {
  buildSessionSummary,
  classifyContextUtilization,
  describeContextTrend
} from '../buildSessionSummary';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const createMessage = (
  turnId: string,
  createdAt: number,
  text = `Message for ${turnId}`,
  role: 'user' | 'assistant' = 'user'
): AgentTurnMessage => ({
  id: `msg-${turnId}-${createdAt}`,
  turnId,
  role,
  text,
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

const createTurnSummary = (
  turnId: string,
  startedAt: number,
  lastTimestamp: number,
  label = `Turn ${turnId}`
): InsightTurnSummary => ({
  turnId,
  label,
  startedAt,
  lastTimestamp,
  status: 'complete'
});

// ---------------------------------------------------------------------------
// Tests: classifyContextUtilization
// ---------------------------------------------------------------------------

describe('classifyContextUtilization', () => {
  it('returns unknown for null/undefined', () => {
    expect(classifyContextUtilization(null)).toBe('unknown');
    expect(classifyContextUtilization(undefined)).toBe('unknown');
  });

  it('returns low for <33%', () => {
    expect(classifyContextUtilization(0)).toBe('low');
    expect(classifyContextUtilization(10)).toBe('low');
    expect(classifyContextUtilization(32)).toBe('low');
  });

  it('returns medium for 33-66%', () => {
    expect(classifyContextUtilization(33)).toBe('medium');
    expect(classifyContextUtilization(50)).toBe('medium');
    expect(classifyContextUtilization(66)).toBe('medium');
  });

  it('returns high for >66%', () => {
    expect(classifyContextUtilization(67)).toBe('high');
    expect(classifyContextUtilization(100)).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Tests: describeContextTrend
// ---------------------------------------------------------------------------

describe('describeContextTrend', () => {
  it('returns no-data message for all unknowns', () => {
    expect(describeContextTrend(['unknown', 'unknown'])).toBe(
      'No context utilization data available'
    );
  });

  it('returns stayed message for uniform trend', () => {
    expect(describeContextTrend(['medium', 'medium', 'medium'])).toBe(
      'Stayed medium throughout'
    );
  });

  it('describes growth', () => {
    expect(describeContextTrend(['low', 'medium', 'high'])).toBe('Went from low to high');
  });

  it('ignores unknown entries when describing trend', () => {
    expect(describeContextTrend(['unknown', 'low', 'unknown', 'high'])).toBe(
      'Went from low to high'
    );
  });

  it('returns no-data for empty array', () => {
    expect(describeContextTrend([])).toBe('No context utilization data available');
  });
});

// ---------------------------------------------------------------------------
// Tests: buildSessionSummary
// ---------------------------------------------------------------------------

describe('buildSessionSummary', () => {
  it('builds a correct summary for a normal multi-turn session', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        createToolEvent('start', 1000),
        createToolEvent('end', 2000),
        createResultEvent(5000, {
          model: 'claude-sonnet-4',
          usage: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheCreationTokens: 200,
            cacheReadTokens: 300,
            costUsd: 0.25,
            contextUtilization: 15,
            contextWindow: 200_000
          }
        })
      ],
      'turn-2': [
        createToolEvent('start', 6000),
        createToolEvent('end', 6500),
        createToolEvent('start', 7000),
        createToolEvent('end', 7500),
        createResultEvent(10_000, {
          model: 'claude-sonnet-4',
          usage: {
            inputTokens: 1500,
            outputTokens: 600,
            cacheCreationTokens: 100,
            cacheReadTokens: 400,
            costUsd: 0.35,
            contextUtilization: 45,
            contextWindow: 200_000
          }
        })
      ]
    };

    const messages = [
      createMessage('turn-1', 900, 'Write a hello world program'),
      createMessage('turn-2', 5900, 'Now add unit tests for that')
    ];

    const turnSummaries = [
      createTurnSummary('turn-1', 1000, 5000),
      createTurnSummary('turn-2', 6000, 10_000)
    ];

    const summary = buildSessionSummary(eventsByTurn, messages, turnSummaries);

    // Overview
    expect(summary.overview.turnCount).toBe(2);
    expect(summary.overview.totalDurationMs).toBe(9000); // 10000 - 1000
    expect(summary.overview.totalCostUsd).toBeCloseTo(0.6);

    // Turn digests
    expect(summary.turnDigests).toHaveLength(2);
    expect(summary.turnDigests[0].turnNumber).toBe(1);
    expect(summary.turnDigests[0].userMessageSnippet).toContain('Write a hello world');
    expect(summary.turnDigests[0].toolCallCount).toBe(1);
    expect(summary.turnDigests[0].durationMs).toBe(4000);
    expect(summary.turnDigests[0].costUsd).toBe(0.25);
    expect(summary.turnDigests[0].hasErrors).toBe(false);
    expect(summary.turnDigests[0].modelName).toBe('claude-sonnet-4');

    expect(summary.turnDigests[1].turnNumber).toBe(2);
    expect(summary.turnDigests[1].toolCallCount).toBe(2);
    expect(summary.turnDigests[1].durationMs).toBe(4000);
    expect(summary.turnDigests[1].costUsd).toBe(0.35);

    // Key findings
    expect(summary.keyFindings.mostExpensiveTurn).toEqual({ turnNumber: 2, costUsd: 0.35 });
    expect(summary.keyFindings.mostToolHeavyTurn).toEqual({ turnNumber: 2, toolCalls: 2 });
    expect(summary.keyFindings.totalErrors).toBe(0);
    expect(summary.keyFindings.hasFallbacks).toBe(false);
    expect(summary.keyFindings.hasCompaction).toBe(false);

    // Efficiency
    expect(summary.efficiency.contextUtilizationTrend).toEqual(['low', 'medium']);
    expect(summary.efficiency.cacheEfficiencyPercent).toBeGreaterThanOrEqual(0);
  });

  it('handles an empty session gracefully', () => {
    const summary = buildSessionSummary({}, [], []);

    expect(summary.overview.turnCount).toBe(0);
    expect(summary.overview.totalDurationMs).toBe(0);
    expect(summary.overview.totalCostUsd).toBe(0);
    expect(summary.turnDigests).toHaveLength(0);
    expect(summary.keyFindings.longestTurn).toBeNull();
    expect(summary.keyFindings.mostExpensiveTurn).toBeNull();
    expect(summary.keyFindings.mostToolHeavyTurn).toBeNull();
    expect(summary.keyFindings.totalErrors).toBe(0);
    expect(summary.keyFindings.hasFallbacks).toBe(false);
    expect(summary.keyFindings.hasCompaction).toBe(false);
    expect(summary.efficiency.cacheEfficiencyPercent).toBe(0);
    expect(summary.efficiency.contextUtilizationTrend).toEqual([]);
  });

  it('handles a single turn with no tools', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        createResultEvent(3000, {
          model: 'claude-sonnet-4',
          usage: {
            inputTokens: 500,
            outputTokens: 200,
            costUsd: 0.08,
            contextUtilization: 5
          }
        })
      ]
    };

    const messages = [createMessage('turn-1', 1000, 'What is the capital of France?')];
    const turnSummaries = [createTurnSummary('turn-1', 2000, 3000)];

    const summary = buildSessionSummary(eventsByTurn, messages, turnSummaries);

    expect(summary.overview.turnCount).toBe(1);
    expect(summary.turnDigests).toHaveLength(1);
    expect(summary.turnDigests[0].toolCallCount).toBe(0);
    expect(summary.turnDigests[0].costUsd).toBe(0.08);
    expect(summary.turnDigests[0].hasErrors).toBe(false);

    // Single turn — comparative findings suppressed.
    expect(summary.keyFindings.longestTurn).toBeNull();
    expect(summary.keyFindings.mostExpensiveTurn).toBeNull();
    expect(summary.keyFindings.mostToolHeavyTurn).toBeNull();

    expect(summary.efficiency.contextUtilizationTrend).toEqual(['low']);
  });

  it('detects errors and fallbacks', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        createErrorEvent(2000),
        createToolEvent('start', 2500),
        createToolEvent('end', 3000, '{"error":"fail"}', { isError: true }),
        createResultEvent(4000, {
          model: 'claude-sonnet-4',
          usage: {
            inputTokens: 800,
            outputTokens: 300,
            costUsd: 0.12
          },
          fallbacks: [{ type: 'auth', from: 'pro', to: 'free', reason: 'expired' }]
        })
      ],
      'turn-2': [
        createResultEvent(7000, {
          model: 'claude-sonnet-4',
          usage: {
            inputTokens: 600,
            outputTokens: 200,
            costUsd: 0.05
          }
        })
      ]
    };

    const messages = [
      createMessage('turn-1', 1000, 'Do something risky'),
      createMessage('turn-2', 5000, 'Try again')
    ];

    const turnSummaries = [
      createTurnSummary('turn-1', 1500, 4000),
      createTurnSummary('turn-2', 5500, 7000)
    ];

    const summary = buildSessionSummary(eventsByTurn, messages, turnSummaries);

    expect(summary.turnDigests[0].errorCount).toBe(2); // 1 error event + 1 tool error
    expect(summary.turnDigests[0].hasErrors).toBe(true);
    expect(summary.keyFindings.totalErrors).toBe(2);
    expect(summary.keyFindings.hasFallbacks).toBe(true);
  });

  it('detects compaction events', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        {
          type: 'compaction_started',
          depth: 1,
          sessionId: 'sess-1',
          timestamp: 3000
        } as AgentEvent,
        {
          type: 'compaction_completed',
          timestamp: 4000
        } as AgentEvent,
        createResultEvent(5000, {
          model: 'claude-sonnet-4',
          usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 }
        })
      ]
    };

    const messages = [createMessage('turn-1', 1000, 'Long conversation')];
    const turnSummaries = [createTurnSummary('turn-1', 2000, 5000)];

    const summary = buildSessionSummary(eventsByTurn, messages, turnSummaries);

    expect(summary.keyFindings.hasCompaction).toBe(true);
  });

  it('detects recovery events during the dual-write window', () => {
    const recoveryBase = {
      turnId: 'turn-1',
      sessionId: 'sess-1',
      originalSessionId: 'sess-1',
      depth: 1,
      attempt: 1,
      totalCalls: 2,
      timestamp: 3000
    };
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        {
          type: 'recovery:started',
          ...recoveryBase,
          phase: 'post_activity'
        } as AgentEvent,
        {
          type: 'recovery:succeeded',
          ...recoveryBase,
          finalDepth: 1,
          totalDurationMs: 1200,
          timestamp: 4000
        } as AgentEvent,
        createResultEvent(5000, {
          model: 'claude-sonnet-4',
          usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 }
        })
      ]
    };

    const messages = [createMessage('turn-1', 1000, 'Long conversation')];
    const turnSummaries = [createTurnSummary('turn-1', 2000, 5000)];

    const summary = buildSessionSummary(eventsByTurn, messages, turnSummaries);

    expect(summary.keyFindings.hasCompaction).toBe(true);
  });

  it('uses toolMetrics when available (compacted sessions)', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        // Compacted: tool events have empty detail
        createToolEvent('start', 1000),
        createToolEvent('end', 1200, ''),
        createResultEvent(3000, {
          model: 'claude-sonnet-4',
          usage: { inputTokens: 500, outputTokens: 100, costUsd: 0.04 },
          toolMetrics: {
            totalToolCalls: 5,
            failedToolCalls: 1,
            filesCreated: 2,
            filesEdited: 1,
            toolUsageByCategory: {},
            mcpServerUsage: {},
            totalToolOutputChars: 500,
            mcpToolOutputChars: 0,
            builtinToolOutputChars: 500
          }
        })
      ]
    };

    const messages = [createMessage('turn-1', 800)];
    const turnSummaries = [createTurnSummary('turn-1', 1000, 3000)];

    const summary = buildSessionSummary(eventsByTurn, messages, turnSummaries);

    // toolMetrics.totalToolCalls takes precedence over counting start events.
    expect(summary.turnDigests[0].toolCallCount).toBe(5);
  });

  it('classifies mixed context utilization levels', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        createResultEvent(2000, {
          usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01, contextUtilization: 10 }
        })
      ],
      'turn-2': [
        createResultEvent(4000, {
          usage: { inputTokens: 200, outputTokens: 80, costUsd: 0.02, contextUtilization: 50 }
        })
      ],
      'turn-3': [
        createResultEvent(6000, {
          usage: { inputTokens: 300, outputTokens: 120, costUsd: 0.03, contextUtilization: 80 }
        })
      ],
      'turn-4': [
        createResultEvent(8000, {
          usage: { inputTokens: 400, outputTokens: 150, costUsd: 0.04, contextUtilization: null }
        })
      ]
    };

    const messages = [
      createMessage('turn-1', 1000),
      createMessage('turn-2', 3000),
      createMessage('turn-3', 5000),
      createMessage('turn-4', 7000)
    ];

    const turnSummaries = [
      createTurnSummary('turn-1', 1500, 2000),
      createTurnSummary('turn-2', 3500, 4000),
      createTurnSummary('turn-3', 5500, 6000),
      createTurnSummary('turn-4', 7500, 8000)
    ];

    const summary = buildSessionSummary(eventsByTurn, messages, turnSummaries);

    expect(summary.efficiency.contextUtilizationTrend).toEqual([
      'low',
      'medium',
      'high',
      'unknown'
    ]);
  });

  it('filters out turns with the fallback turn ID', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      latest: [
        createResultEvent(2000, {
          usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 }
        })
      ],
      'turn-1': [
        createResultEvent(4000, {
          usage: { inputTokens: 200, outputTokens: 80, costUsd: 0.02 }
        })
      ]
    };

    const messages = [createMessage('turn-1', 3000)];
    const turnSummaries = [
      createTurnSummary('latest', 1000, 2000),
      createTurnSummary('turn-1', 3500, 4000)
    ];

    const summary = buildSessionSummary(eventsByTurn, messages, turnSummaries);

    // 'latest' turn should be filtered out.
    expect(summary.overview.turnCount).toBe(1);
    expect(summary.turnDigests).toHaveLength(1);
    expect(summary.turnDigests[0].turnId).toBe('turn-1');
  });

  it('shows "(no user message)" when message is missing for a turn', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        createResultEvent(3000, {
          usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 }
        })
      ]
    };

    // No matching user message for turn-1.
    const messages: AgentTurnMessage[] = [];
    const turnSummaries = [createTurnSummary('turn-1', 2000, 3000)];

    const summary = buildSessionSummary(eventsByTurn, messages, turnSummaries);

    expect(summary.turnDigests[0].userMessageSnippet).toBe('(no user message)');
  });
});
