import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AssistantAgentEvent } from '@shared/types';
import {
  buildTurnStepContextMap,
  extractMissionContext,
  extractTaskProgress,
  extractTurnTaskDelta,
  parseParallelSubagentsStatusMessage,
} from '../turnStepContext';
import type { TaskProgressItem } from '../turnStepContext';
import type { TaskRoutingMetadata as SharedTaskRoutingMetadata } from '@shared/routing/taskRoutingMetadata';

/** Helper to access text on assistant step events (avoids union narrowing noise in tests). */
const textOf = (event: AgentEvent) => (event as AssistantAgentEvent).text;

const createAssistantEvent = (timestamp: number, text: string): AgentEvent => ({
  type: 'assistant',
  text,
  timestamp
});

const makeToolEvent = (
  timestamp: number,
  stage: 'start' | 'end',
  toolName = 'Read',
  toolUseId?: string
): AgentEvent => ({
  type: 'tool',
  toolName,
  detail: '{}',
  stage,
  timestamp,
  ...(toolUseId ? { toolUseId } : {})
});

const makeResultEvent = (timestamp: number): AgentEvent => ({
  type: 'result',
  text: 'Done',
  timestamp
});

describe('buildTurnStepContextMap', () => {
  it('replaces narrated assistant step text with concise tool-derived labels', () => {
    const turnId = 'turn-verbose-summary';
    const eventsByTurn: Record<string, AgentEvent[]> = {
      [turnId]: [
        createAssistantEvent(
          1000,
          [
            'That error is from a PostHog query that failed in a previous turn.',
            'Let me check what I was doing and pick up from where things broke.',
            'Now I have full context so I can proceed through the remaining pipeline.',
          ].join(' ')
        ),
        makeToolEvent(1100, 'start', 'ReadFile', 'toolu_read_1'),
        makeToolEvent(1200, 'end', 'ReadFile', 'toolu_read_1'),
      ]
    };

    const contextMap = buildTurnStepContextMap(eventsByTurn);
    const context = contextMap[turnId];

    expect(context).toBeDefined();
    expect(context.assistantSteps).toHaveLength(1);
    expect(textOf(context.assistantSteps[0])).toContain('Read');
    expect(textOf(context.assistantSteps[0])).not.toContain('Let me check');
    expect(textOf(context.assistantSteps[0])).not.toContain('Now I have full context');
  });

  it('keeps short assistant text unchanged on turns without tool activity', () => {
    const turnId = 'turn-no-tools';
    const originalText = 'Here is the answer.';
    const eventsByTurn: Record<string, AgentEvent[]> = {
      [turnId]: [
        createAssistantEvent(1000, originalText)
      ]
    };

    const contextMap = buildTurnStepContextMap(eventsByTurn);
    const context = contextMap[turnId];

    expect(context).toBeDefined();
    expect(context.assistantSteps).toHaveLength(1);
    expect(textOf(context.assistantSteps[0])).toBe(originalText);
  });

  it('returns populated assistantSteps and toolSummariesByStep for normal turns', () => {
    const events: AgentEvent[] = [
      createAssistantEvent(1000, 'Looking at the file...'),
      makeToolEvent(1100, 'start', 'Read', 'tool-1'),
      makeToolEvent(1200, 'end', 'Read', 'tool-1'),
      makeResultEvent(1300)
    ];

    const result = buildTurnStepContextMap({ 'turn-1': events });

    expect(result['turn-1']).toBeDefined();
    expect(result['turn-1'].assistantSteps.length).toBeGreaterThan(0);
    expect(result['turn-1'].toolSummariesByStep.size).toBeGreaterThan(0);
  });

  it('injects synthetic step when no assistant events but tool events exist', () => {
    const toolEvents: AgentEvent[] = [
      makeToolEvent(1000, 'start', 'Read', 'tool-1'),
      makeToolEvent(1100, 'end', 'Read', 'tool-1'),
      makeToolEvent(1200, 'start', 'Edit', 'tool-2'),
      makeToolEvent(1300, 'end', 'Edit', 'tool-2'),
      makeResultEvent(1400)
    ];

    const result = buildTurnStepContextMap({ 'turn-1': toolEvents });

    const ctx = result['turn-1'];
    expect(ctx).toBeDefined();
    expect(ctx.assistantSteps).toHaveLength(1);
    expect(textOf(ctx.assistantSteps[0])).toContain('Read');
    expect(textOf(ctx.assistantSteps[0])).toContain('Edit');
    expect(ctx.toolSummariesByStep.size).toBeGreaterThan(0);
  });

  it('synthetic step timestamp matches first tool event', () => {
    const toolEvents: AgentEvent[] = [
      makeToolEvent(5000, 'start', 'Grep', 'tool-1'),
      makeToolEvent(5500, 'end', 'Grep', 'tool-1'),
      makeToolEvent(6000, 'start', 'Read', 'tool-2'),
      makeToolEvent(6500, 'end', 'Read', 'tool-2')
    ];

    const result = buildTurnStepContextMap({ 'turn-1': toolEvents });

    const ctx = result['turn-1'];
    expect(ctx.assistantSteps).toHaveLength(1);
    expect(ctx.assistantSteps[0].timestamp).toBe(5000);
  });

  it('returns empty context for turns with no events at all', () => {
    const result = buildTurnStepContextMap({ 'turn-1': [] });

    expect(result['turn-1']).toBeUndefined();
  });

  it('preserves normal behavior: completed single-message turn without tools has no steps', () => {
    const events: AgentEvent[] = [
      createAssistantEvent(1000, 'Here is the answer.'),
      makeResultEvent(1100)
    ];

    const result = buildTurnStepContextMap({ 'turn-1': events });

    const ctx = result['turn-1'];
    expect(ctx).toBeDefined();
    expect(ctx.assistantSteps).toHaveLength(0);
  });

  it('handles multiple turns independently', () => {
    const turn1Events: AgentEvent[] = [
      createAssistantEvent(1000, 'Step one'),
      makeToolEvent(1100, 'start', 'Read', 'tool-1'),
      makeToolEvent(1200, 'end', 'Read', 'tool-1'),
      makeResultEvent(1300)
    ];
    const turn2Events: AgentEvent[] = [
      makeToolEvent(2000, 'start', 'Edit', 'tool-2'),
      makeToolEvent(2100, 'end', 'Edit', 'tool-2'),
      makeResultEvent(2200)
    ];

    const result = buildTurnStepContextMap({
      'turn-1': turn1Events,
      'turn-2': turn2Events
    });

    expect(textOf(result['turn-1'].assistantSteps[0])).toContain('Read');
    expect(result['turn-2'].assistantSteps).toHaveLength(1);
    expect(textOf(result['turn-2'].assistantSteps[0])).toContain('Edit');
    expect(result['turn-2'].toolSummariesByStep.size).toBeGreaterThan(0);
  });

  it('correlates per-step model labels with the most recent routing model event by timestamp', () => {
    const turnId = 'turn-model-switches';
    const events: AgentEvent[] = [
      { type: 'status', message: 'routing:model:cheap-model', timestamp: 900 },
      createAssistantEvent(1000, 'Gathering inputs'),
      makeToolEvent(1100, 'start', 'Read', 'tool-1'),
      makeToolEvent(1200, 'end', 'Read', 'tool-1'),
      { type: 'status', message: 'routing:model:capable-model', timestamp: 1300 },
      createAssistantEvent(1400, 'Synthesizing'),
      makeToolEvent(1500, 'start', 'TaskUpdate', 'tool-2'),
      makeToolEvent(1600, 'end', 'TaskUpdate', 'tool-2'),
      { type: 'status', message: 'routing:model:cheap-model', timestamp: 1700 },
      createAssistantEvent(1800, 'Formatting final answer'),
      makeResultEvent(1900),
    ];

    const result = buildTurnStepContextMap({ [turnId]: events });

    expect(result[turnId].modelByStep.get(1)).toBe('cheap-model');
    expect(result[turnId].modelByStep.get(2)).toBe('capable-model');
    expect(result[turnId].modelByStep.get(3)).toBe('cheap-model');
  });

  it('falls back to the result event model when no routing model events exist', () => {
    const turnId = 'turn-result-model';
    const events: AgentEvent[] = [
      createAssistantEvent(1000, 'Reading'),
      makeToolEvent(1100, 'start', 'Read', 'tool-1'),
      makeToolEvent(1200, 'end', 'Read', 'tool-1'),
      { type: 'result', text: 'Done', model: 'result-model', timestamp: 1300 } as AgentEvent,
    ];

    const result = buildTurnStepContextMap({ [turnId]: events });

    expect(result[turnId].modelByStep.get(1)).toBe('result-model');
  });

  it('parses task-level adaptive routing metadata from routing:tasks status events', () => {
    const turnId = 'turn-task-routing';
    const events: AgentEvent[] = [
      {
        type: 'status',
        message: `routing:tasks:${JSON.stringify({
          'task-1': { model: 'gpt-5.5', effort: 'high' },
          'task-2': {
            model: 'claude-sonnet-4-6',
            effort: 'medium',
            isSubAgent: true,
            subAgentContext: 'scoped',
          },
        })}`,
        timestamp: 900,
      },
      createAssistantEvent(1000, 'Planning'),
      makeToolEvent(1100, 'start', 'TaskList', 'tool-1'),
      makeToolEvent(1200, 'end', 'TaskList', 'tool-1'),
      makeResultEvent(1300),
    ];

    const result = buildTurnStepContextMap({ [turnId]: events });

    expect(result[turnId].modelByTaskId?.get('task-1')).toEqual({
      model: 'gpt-5.5',
      effort: 'high',
    });
    expect(result[turnId].modelByTaskId?.get('task-2')).toEqual({
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      isSubAgent: true,
      subAgentContext: 'scoped',
    });
  });

  it('ignores malformed routing:tasks status events', () => {
    const turnId = 'turn-bad-task-routing';
    const events: AgentEvent[] = [
      { type: 'status', message: 'routing:tasks:{not-json', timestamp: 900 },
      createAssistantEvent(1000, 'Planning'),
      makeToolEvent(1100, 'start', 'TaskList', 'tool-1'),
      makeToolEvent(1200, 'end', 'TaskList', 'tool-1'),
      makeResultEvent(1300),
    ];

    const result = buildTurnStepContextMap({ [turnId]: events });

    expect(result[turnId].modelByTaskId).toBeUndefined();
  });

  it('uses the last routing:tasks event when the backend re-emits with new tasks', () => {
    const turnId = 'turn-task-routing-multi-emit';
    const events: AgentEvent[] = [
      {
        type: 'status',
        message: `routing:tasks:${JSON.stringify({
          'task-1': { model: 'gpt-5.5' },
        })}`,
        timestamp: 900,
      },
      createAssistantEvent(1000, 'Planning'),
      makeToolEvent(1100, 'start', 'TaskCreate', 'tool-1'),
      makeToolEvent(1200, 'end', 'TaskCreate', 'tool-1'),
      {
        type: 'status',
        message: `routing:tasks:${JSON.stringify({
          'task-1': { model: 'gpt-5.5' },
          'task-2': { model: 'gpt-5.5' },
          'task-3': {
            model: 'claude-sonnet-4-6',
            isSubAgent: true,
            subAgentContext: 'contextual',
          },
        })}`,
        timestamp: 1250,
      },
      makeResultEvent(1300),
    ];

    const result = buildTurnStepContextMap({ [turnId]: events });

    expect(result[turnId].modelByTaskId?.size).toBe(3);
    expect(result[turnId].modelByTaskId?.get('task-2')).toEqual({ model: 'gpt-5.5' });
    expect(result[turnId].modelByTaskId?.get('task-3')).toEqual({
      model: 'claude-sonnet-4-6',
      isSubAgent: true,
      subAgentContext: 'contextual',
    });
  });

  it('round-trips the shared TaskRoutingMetadata wire contract through serialize → parse (SA-F1 backstop)', () => {
    // The producer (core rebelCoreQuery) emits `routing:tasks:${JSON.stringify(map)}`
    // where `map: Record<string, TaskRoutingMetadata>`. This pins the wire
    // round-trip: every field the producer serializes must survive the renderer
    // parse unchanged. The `TaskRoutingMetadata` type is now SHARED between the
    // producer and the renderer parser (`@shared/routing/taskRoutingMetadata`),
    // so a field rename would already fail to compile; this test guards the
    // runtime serialize/parse value parity on top of that.
    const turnId = 'turn-wire-roundtrip';
    const producerMetadata: Record<string, SharedTaskRoutingMetadata> = {
      'task-parent': { model: 'claude-opus-4-20250514', effort: 'high' },
      'task-default': { model: 'claude-sonnet-4-20250514' },
      'task-subagent': {
        model: 'claude-haiku-4-5',
        effort: 'low',
        isSubAgent: true,
        subAgentContext: 'scoped',
      },
    };
    const events: AgentEvent[] = [
      {
        type: 'status',
        message: `routing:tasks:${JSON.stringify(producerMetadata)}`,
        timestamp: 900,
      },
      createAssistantEvent(1000, 'Planning'),
      makeToolEvent(1100, 'start', 'TaskList', 'tool-1'),
      makeToolEvent(1200, 'end', 'TaskList', 'tool-1'),
      makeResultEvent(1300),
    ];

    const result = buildTurnStepContextMap({ [turnId]: events });
    const parsed = result[turnId].modelByTaskId;

    expect(parsed?.size).toBe(3);
    for (const [taskId, expected] of Object.entries(producerMetadata)) {
      expect(parsed?.get(taskId)).toEqual(expected);
    }
  });
});

describe('parallel sub-agent status parser', () => {
  it('parses parallel:subagents:start payloads into user-facing banner text', () => {
    const parsed = parseParallelSubagentsStatusMessage(
      'parallel:subagents:start:{"requested":6,"cap":4}',
    );

    expect(parsed).toEqual({
      kind: 'start',
      payload: {
        requested: 6,
        cap: 4,
      },
    });
  });

  it('returns invalid sentinel and warns for malformed parallel status payload JSON', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() =>
      parseParallelSubagentsStatusMessage('parallel:subagents:start:{not-json'),
    ).not.toThrow();
    expect(parseParallelSubagentsStatusMessage('parallel:subagents:start:{not-json')).toEqual({
      kind: 'invalid',
      prefix: 'parallel:subagents:start:',
      raw: 'parallel:subagents:start:{not-json',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[parallel-subagents-parser] invalid payload',
      expect.objectContaining({
        prefix: 'parallel:subagents:start:',
        reason: 'malformed JSON',
      }),
    );
    warnSpy.mockRestore();
  });

  it('injects the latest parallel sub-agent banner into tool summaries', () => {
    const turnId = 'turn-parallel-subagent-banner';
    const events: AgentEvent[] = [
      createAssistantEvent(1000, 'Delegating tasks'),
      { type: 'status', message: 'parallel:subagents:start:{"requested":2,"cap":2}', timestamp: 1010 },
      makeToolEvent(1015, 'start', 'Agent', 'tool-agent-1'),
      { type: 'status', message: 'parallel:subagents:progress:{"running":1,"succeeded":0,"failed":0,"pending":1}', timestamp: 1020 },
      makeToolEvent(1025, 'end', 'Agent', 'tool-agent-1'),
      { type: 'status', message: 'parallel:subagents:complete:{"requested":2,"succeeded":2,"failed":0,"aborted":0,"durationMs":42}', timestamp: 1030 },
      makeResultEvent(1040),
    ];

    const result = buildTurnStepContextMap({ [turnId]: events });
    const summaries = result[turnId].toolSummariesByStep.get(1) ?? [];
    expect(summaries.some((summary) => summary.label === 'Finished 2 of 2 parallel tasks.')).toBe(true);
  });

  it('does not render malformed machine status text in tool summaries', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rawMachineStatus = 'parallel:subagents:start:{not-json';
    const turnId = 'turn-parallel-subagent-banner-invalid';
    const events: AgentEvent[] = [
      createAssistantEvent(1000, 'Delegating tasks'),
      { type: 'status', message: rawMachineStatus, timestamp: 1010 },
      makeToolEvent(1015, 'start', 'Agent', 'tool-agent-1'),
      makeToolEvent(1025, 'end', 'Agent', 'tool-agent-1'),
      makeResultEvent(1040),
    ];

    const result = buildTurnStepContextMap({ [turnId]: events });
    const summaries = result[turnId].toolSummariesByStep.get(1) ?? [];
    expect(summaries.some((summary) => summary.label === rawMachineStatus)).toBe(false);
    warnSpy.mockRestore();
  });
});

const makeNamedToolEvent = (
  timestamp: number,
  stage: 'start' | 'end',
  toolName: string,
  detail: string,
  toolUseId?: string
): AgentEvent => ({
  type: 'tool',
  toolName,
  detail,
  stage,
  timestamp,
  ...(toolUseId ? { toolUseId } : {})
});

describe('parallel tool batches (multi-tool steps)', () => {
  it('retains individual entries for 3 concurrent tools in the same step', () => {
    const turnId = 'turn-parallel-3';
    const events: AgentEvent[] = [
      createAssistantEvent(1000, 'Let me check these files...'),
      // 3 tools dispatched concurrently in same step
      makeToolEvent(1100, 'start', 'Read', 'tool-a'),
      makeToolEvent(1100, 'start', 'Grep', 'tool-b'),
      makeToolEvent(1100, 'start', 'Glob', 'tool-c'),
      makeToolEvent(1200, 'end', 'Read', 'tool-a'),
      makeToolEvent(1250, 'end', 'Grep', 'tool-b'),
      makeToolEvent(1300, 'end', 'Glob', 'tool-c'),
      makeResultEvent(1400),
    ];

    const result = buildTurnStepContextMap({ [turnId]: events });
    const summaries = result[turnId].toolSummariesByStep.get(1) ?? [];

    expect(summaries).toHaveLength(3);
    // Each tool has count=1 (not merged)
    expect(summaries.every((s) => (s.count ?? 1) === 1)).toBe(true);
  });

  it('retains individual entries for same-label parallel tools (e.g. 3 Read calls)', () => {
    const turnId = 'turn-parallel-same-label';
    const events: AgentEvent[] = [
      createAssistantEvent(1000, 'Reading files...'),
      makeToolEvent(1100, 'start', 'Read', 'tool-r1'),
      makeToolEvent(1100, 'start', 'Read', 'tool-r2'),
      makeToolEvent(1100, 'start', 'Read', 'tool-r3'),
      makeToolEvent(1200, 'end', 'Read', 'tool-r1'),
      makeToolEvent(1250, 'end', 'Read', 'tool-r2'),
      makeToolEvent(1300, 'end', 'Read', 'tool-r3'),
      makeResultEvent(1400),
    ];

    const result = buildTurnStepContextMap({ [turnId]: events });
    const summaries = result[turnId].toolSummariesByStep.get(1) ?? [];

    // All 3 Read tools should be individual entries, not merged into count=3
    expect(summaries).toHaveLength(3);
    expect(summaries.every((s) => (s.count ?? 1) === 1)).toBe(true);
  });

  it('preserves merge behavior for single-tool-per-step (sequential tools)', () => {
    const turnId = 'turn-sequential-merge';
    const events: AgentEvent[] = [
      createAssistantEvent(1000, 'Reading...'),
      // Only 1 tool in step 1
      makeToolEvent(1100, 'start', 'Read', 'tool-1'),
      makeToolEvent(1200, 'end', 'Read', 'tool-1'),
      // New step, only 1 tool
      createAssistantEvent(1300, 'More reading...'),
      makeToolEvent(1400, 'start', 'Read', 'tool-2'),
      makeToolEvent(1500, 'end', 'Read', 'tool-2'),
      makeResultEvent(1600),
    ];

    const result = buildTurnStepContextMap({ [turnId]: events });

    // Each step has exactly 1 tool — merge behavior is unchanged (no multi-tool detection)
    const step1Summaries = result[turnId].toolSummariesByStep.get(1) ?? [];
    const step2Summaries = result[turnId].toolSummariesByStep.get(2) ?? [];
    expect(step1Summaries).toHaveLength(1);
    expect(step2Summaries).toHaveLength(1);
  });

  it('handles mixed steps: step 1 sequential (1 tool), step 2 parallel (3 tools)', () => {
    const turnId = 'turn-mixed';
    const events: AgentEvent[] = [
      // Step 1: single tool (sequential)
      createAssistantEvent(1000, 'First step...'),
      makeToolEvent(1100, 'start', 'Read', 'tool-1'),
      makeToolEvent(1200, 'end', 'Read', 'tool-1'),
      // Step 2: 3 tools (parallel batch)
      createAssistantEvent(1300, 'Now in parallel...'),
      makeToolEvent(1400, 'start', 'Read', 'tool-a'),
      makeToolEvent(1400, 'start', 'Grep', 'tool-b'),
      makeToolEvent(1400, 'start', 'Glob', 'tool-c'),
      makeToolEvent(1500, 'end', 'Read', 'tool-a'),
      makeToolEvent(1550, 'end', 'Grep', 'tool-b'),
      makeToolEvent(1600, 'end', 'Glob', 'tool-c'),
      makeResultEvent(1700),
    ];

    const result = buildTurnStepContextMap({ [turnId]: events });

    // Step 1: single tool — normal merge rules apply
    const step1Summaries = result[turnId].toolSummariesByStep.get(1) ?? [];
    expect(step1Summaries).toHaveLength(1);

    // Step 2: 3 parallel tools — all individual
    const step2Summaries = result[turnId].toolSummariesByStep.get(2) ?? [];
    expect(step2Summaries).toHaveLength(3);
    expect(step2Summaries.every((s) => (s.count ?? 1) === 1)).toBe(true);
  });

  it('shows all in-progress tools individually in a multi-tool step', () => {
    const turnId = 'turn-in-progress';
    const events: AgentEvent[] = [
      createAssistantEvent(1000, 'Working...'),
      // 3 tools started, none completed yet
      makeToolEvent(1100, 'start', 'Read', 'tool-x'),
      makeToolEvent(1100, 'start', 'Grep', 'tool-y'),
      makeToolEvent(1100, 'start', 'Glob', 'tool-z'),
    ];

    const result = buildTurnStepContextMap({ [turnId]: events });
    const summaries = result[turnId].toolSummariesByStep.get(1) ?? [];

    // All 3 in-progress tools should be individually visible
    expect(summaries).toHaveLength(3);
    expect(summaries.every((s) => (s.count ?? 1) === 1)).toBe(true);
  });
});

describe('extractMissionContext', () => {
  it('extracts goal, done_criteria, and constraints from a valid MissionSet end event', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'MissionSet', JSON.stringify({
        summary: 'Mission set',
        mission: {
          goal: 'Build a todo app',
          done_criteria: 'All tests pass',
          constraints: 'Use React only'
        }
      }))
    ];

    const result = extractMissionContext(events);

    expect(result).toEqual({
      goal: 'Build a todo app',
      doneCriteria: 'All tests pass',
      constraints: 'Use React only'
    });
  });

  it('returns null for malformed JSON', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'MissionSet', 'not-json')
    ];

    expect(extractMissionContext(events)).toBeNull();
  });

  it('returns null when mission field is missing', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'MissionSet', JSON.stringify({ summary: 'oops' }))
    ];

    expect(extractMissionContext(events)).toBeNull();
  });

  it('returns null when goal is not a string', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'MissionSet', JSON.stringify({
        mission: { goal: 123 }
      }))
    ];

    expect(extractMissionContext(events)).toBeNull();
  });

  it('uses the latest MissionSet event when multiple exist', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'MissionSet', JSON.stringify({
        mission: { goal: 'Old goal' }
      })),
      makeNamedToolEvent(2000, 'end', 'MissionSet', JSON.stringify({
        mission: { goal: 'New goal', done_criteria: 'Ship it' }
      }))
    ];

    const result = extractMissionContext(events);

    expect(result).toEqual({
      goal: 'New goal',
      doneCriteria: 'Ship it',
      constraints: undefined
    });
  });

  it('ignores MissionSet start events', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'start', 'MissionSet', JSON.stringify({
        mission: { goal: 'Should be ignored' }
      }))
    ];

    expect(extractMissionContext(events)).toBeNull();
  });

  it('handles missing optional fields gracefully', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'MissionSet', JSON.stringify({
        mission: { goal: 'Just a goal' }
      }))
    ];

    const result = extractMissionContext(events);

    expect(result).toEqual({
      goal: 'Just a goal',
      doneCriteria: undefined,
      constraints: undefined
    });
  });

  it('returns null for empty events', () => {
    expect(extractMissionContext([])).toBeNull();
  });
});

describe('extractTaskProgress', () => {
  it('extracts all tasks with mixed statuses from TaskList', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'TaskList', JSON.stringify({
        tasks: [
          { id: 't1', title: 'Setup', status: 'completed', priority: 'high' },
          { id: 't2', title: 'Implement', status: 'in_progress' },
          { id: 't3', title: 'Test', status: 'pending', priority: 'medium' },
          { id: 't4', title: 'Deploy', status: 'blocked' }
        ]
      }))
    ];

    const result = extractTaskProgress(events);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ id: 't1', title: 'Setup', status: 'completed', priority: 'high' });
    expect(result[1]).toEqual({ id: 't2', title: 'Implement', status: 'in_progress', priority: undefined });
    expect(result[2]).toEqual({ id: 't3', title: 'Test', status: 'pending', priority: 'medium' });
    expect(result[3]).toEqual({ id: 't4', title: 'Deploy', status: 'blocked', priority: undefined });
  });

  it('filters out mission-owner tasks', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'TaskList', JSON.stringify({
        tasks: [
          { id: 't1', title: 'Real task', status: 'pending' },
          { id: 'm1', title: 'Goal task', status: 'pending', owner: 'mission' },
          { id: 't2', title: 'Another task', status: 'in_progress' }
        ]
      }))
    ];

    const result = extractTaskProgress(events);

    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('includes blocked status', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'TaskList', JSON.stringify({
        tasks: [
          { id: 't1', title: 'Blocked task', status: 'blocked' }
        ]
      }))
    ];

    const result = extractTaskProgress(events);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('blocked');
  });

  it('falls back to TodoWrite for legacy compatibility', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'start', 'TodoWrite', JSON.stringify({
        todos: [
          { id: 'td1', content: 'Write tests', status: 'pending' },
          { id: 'td2', content: 'Fix bugs', status: 'completed' },
          { id: 'td3', content: 'Ship it', status: 'in_progress' }
        ]
      }))
    ];

    const result = extractTaskProgress(events);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ id: 'td1', title: 'Write tests', status: 'pending', priority: undefined });
    expect(result[1]).toEqual({ id: 'td2', title: 'Fix bugs', status: 'completed', priority: undefined });
    expect(result[2]).toEqual({ id: 'td3', title: 'Ship it', status: 'in_progress', priority: undefined });
  });

  it('returns empty array for empty events', () => {
    expect(extractTaskProgress([])).toEqual([]);
  });

  it('returns empty array for malformed TaskList JSON', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'TaskList', 'not-json')
    ];

    expect(extractTaskProgress(events)).toEqual([]);
  });

  it('uses the latest TaskList event', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'TaskList', JSON.stringify({
        tasks: [{ id: 't1', title: 'Old task', status: 'pending' }]
      })),
      makeNamedToolEvent(2000, 'end', 'TaskList', JSON.stringify({
        tasks: [
          { id: 't1', title: 'Updated task', status: 'completed' },
          { id: 't2', title: 'New task', status: 'pending' }
        ]
      }))
    ];

    const result = extractTaskProgress(events);

    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Updated task');
    expect(result[0].status).toBe('completed');
  });

  it('uses content field as fallback for title', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'TaskList', JSON.stringify({
        tasks: [{ id: 't1', content: 'Legacy content field', status: 'pending' }]
      }))
    ];

    const result = extractTaskProgress(events);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Legacy content field');
  });

  it('filters out tasks with invalid status', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'TaskList', JSON.stringify({
        tasks: [
          { id: 't1', title: 'Valid', status: 'pending' },
          { id: 't2', title: 'Invalid', status: 'unknown_status' },
          { id: 't3', title: 'Also valid', status: 'completed' }
        ]
      }))
    ];

    const result = extractTaskProgress(events);

    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toEqual(['t1', 't3']);
  });

  it('picks the final snapshot when multiple TaskUpdate events share the same timestamp', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'TaskUpdate', JSON.stringify({
        task: { id: 't1', title: 'Task 1', status: 'completed' },
        tasks: [
          { id: 't1', title: 'Task 1', status: 'completed' },
          { id: 't2', title: 'Task 2', status: 'in_progress' },
          { id: 't3', title: 'Task 3', status: 'pending' },
        ]
      })),
      makeNamedToolEvent(1000, 'end', 'TaskUpdate', JSON.stringify({
        task: { id: 't2', title: 'Task 2', status: 'completed' },
        tasks: [
          { id: 't1', title: 'Task 1', status: 'completed' },
          { id: 't2', title: 'Task 2', status: 'completed' },
          { id: 't3', title: 'Task 3', status: 'in_progress' },
        ]
      })),
      makeNamedToolEvent(1000, 'end', 'TaskUpdate', JSON.stringify({
        task: { id: 't3', title: 'Task 3', status: 'completed' },
        tasks: [
          { id: 't1', title: 'Task 1', status: 'completed' },
          { id: 't2', title: 'Task 2', status: 'completed' },
          { id: 't3', title: 'Task 3', status: 'completed' },
        ]
      })),
    ];

    const result = extractTaskProgress(events);

    expect(result).toHaveLength(3);
    expect(result.every(t => t.status === 'completed')).toBe(true);
  });

  it('picks the final MissionSet when multiple share the same timestamp', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(5000, 'end', 'MissionSet', JSON.stringify({
        mission: { goal: 'Intermediate goal', done_criteria: 'Partial' }
      })),
      makeNamedToolEvent(5000, 'end', 'MissionSet', JSON.stringify({
        mission: { goal: 'Final goal', done_criteria: 'All done' }
      })),
    ];

    const result = extractMissionContext(events);

    expect(result).toEqual({
      goal: 'Final goal',
      doneCriteria: 'All done',
      constraints: undefined
    });
  });
});

describe('extractTurnTaskDelta', () => {
  const snapshotTasks: TaskProgressItem[] = [
    { id: 't1', title: 'Setup', status: 'completed', priority: 'high' },
    { id: 't2', title: 'Implement', status: 'in_progress', priority: undefined },
    { id: 't3', title: 'Test', status: 'pending', priority: 'medium' },
  ];

  it('returns hasMissionSet=true and all snapshot tasks as delta when MissionSet event exists', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'MissionSet', JSON.stringify({
        mission: { goal: 'Build app' }
      })),
      makeNamedToolEvent(1100, 'end', 'TaskList', JSON.stringify({
        tasks: [
          { id: 't1', title: 'Setup', status: 'completed', priority: 'high' },
          { id: 't2', title: 'Implement', status: 'in_progress' },
          { id: 't3', title: 'Test', status: 'pending', priority: 'medium' },
        ]
      })),
    ];

    const result = extractTurnTaskDelta(events, snapshotTasks);

    expect(result.hasMissionSet).toBe(true);
    expect(result.snapshot).toEqual(snapshotTasks);
    expect(result.deltaTasks).toEqual(snapshotTasks);
  });

  it('returns only touched tasks as delta when TaskCreate and TaskUpdate events exist', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'TaskCreate', JSON.stringify({
        task: { id: 't2', title: 'Implement', status: 'in_progress' },
        tasks: snapshotTasks,
      })),
      makeNamedToolEvent(1100, 'end', 'TaskUpdate', JSON.stringify({
        task: { id: 't3', title: 'Test', status: 'pending' },
        tasks: snapshotTasks,
      })),
      makeNamedToolEvent(1200, 'end', 'TaskList', JSON.stringify({
        tasks: snapshotTasks,
      })),
    ];

    const result = extractTurnTaskDelta(events, snapshotTasks);

    expect(result.hasMissionSet).toBe(false);
    expect(result.snapshot).toEqual(snapshotTasks);
    expect(result.touchedTaskIds).toEqual(['t2', 't3']);
    expect(result.deltaTasks).toHaveLength(2);
    expect(result.deltaTasks[0].id).toBe('t2');
    expect(result.deltaTasks[1].id).toBe('t3');
  });

  it('returns empty deltaTasks when turn has only TaskList (no mutations)', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'TaskList', JSON.stringify({
        tasks: snapshotTasks,
      })),
    ];

    const result = extractTurnTaskDelta(events, snapshotTasks);

    expect(result.hasMissionSet).toBe(false);
    expect(result.snapshot).toEqual(snapshotTasks);
    expect(result.touchedTaskIds).toEqual([]);
    expect(result.deltaTasks).toEqual([]);
  });

  it('treats all snapshot tasks as delta when TodoWrite is used (legacy fallback)', () => {
    const todoTasks: TaskProgressItem[] = [
      { id: 'td1', title: 'Write tests', status: 'pending', priority: undefined },
      { id: 'td2', title: 'Fix bugs', status: 'completed', priority: undefined },
    ];

    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'start', 'TodoWrite', JSON.stringify({
        todos: [
          { id: 'td1', content: 'Write tests', status: 'pending' },
          { id: 'td2', content: 'Fix bugs', status: 'completed' },
        ]
      })),
    ];

    const result = extractTurnTaskDelta(events, todoTasks);

    expect(result.hasMissionSet).toBe(false);
    expect(result.snapshot).toEqual(todoTasks);
    expect(result.touchedTaskIds).toEqual(['td1', 'td2']);
    expect(result.deltaTasks).toEqual(todoTasks);
  });

  it('preserves touch order from event timestamps', () => {
    const events: AgentEvent[] = [
      // t3 is touched first, then t1
      makeNamedToolEvent(1000, 'end', 'TaskUpdate', JSON.stringify({
        task: { id: 't3', title: 'Test', status: 'in_progress' },
        tasks: snapshotTasks,
      })),
      makeNamedToolEvent(1100, 'end', 'TaskCreate', JSON.stringify({
        task: { id: 't1', title: 'Setup', status: 'completed' },
        tasks: snapshotTasks,
      })),
    ];

    const result = extractTurnTaskDelta(events, snapshotTasks);

    expect(result.touchedTaskIds).toEqual(['t3', 't1']);
    expect(result.deltaTasks[0].id).toBe('t3');
    expect(result.deltaTasks[1].id).toBe('t1');
  });

  it('returns empty delta with empty snapshot for empty events', () => {
    const result = extractTurnTaskDelta([], []);

    expect(result.hasMissionSet).toBe(false);
    expect(result.snapshot).toEqual([]);
    expect(result.touchedTaskIds).toEqual([]);
    expect(result.deltaTasks).toEqual([]);
  });

  it('ignores TaskCreate/TaskUpdate start events (only end events carry task IDs)', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'start', 'TaskCreate', JSON.stringify({
        title: 'New task',
      })),
      makeNamedToolEvent(1100, 'end', 'TaskList', JSON.stringify({
        tasks: snapshotTasks,
      })),
    ];

    const result = extractTurnTaskDelta(events, snapshotTasks);

    expect(result.touchedTaskIds).toEqual([]);
    expect(result.deltaTasks).toEqual([]);
  });

  it('detects MissionSet from start events too (not just end)', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'start', 'MissionSet', JSON.stringify({
        goal: 'Build app',
      })),
      makeNamedToolEvent(1100, 'end', 'TaskList', JSON.stringify({
        tasks: snapshotTasks,
      })),
    ];

    const result = extractTurnTaskDelta(events, snapshotTasks);

    expect(result.hasMissionSet).toBe(true);
    expect(result.deltaTasks).toEqual(snapshotTasks);
  });

  it('gracefully skips task IDs not found in the snapshot', () => {
    const events: AgentEvent[] = [
      makeNamedToolEvent(1000, 'end', 'TaskCreate', JSON.stringify({
        task: { id: 'missing-id', title: 'Ghost task', status: 'pending' },
        tasks: snapshotTasks,
      })),
      makeNamedToolEvent(1100, 'end', 'TaskUpdate', JSON.stringify({
        task: { id: 't2', title: 'Implement', status: 'completed' },
        tasks: snapshotTasks,
      })),
    ];

    const result = extractTurnTaskDelta(events, snapshotTasks);

    // missing-id is skipped, only t2 appears in deltaTasks
    expect(result.touchedTaskIds).toEqual(['missing-id', 't2']);
    expect(result.deltaTasks).toHaveLength(1);
    expect(result.deltaTasks[0].id).toBe('t2');
  });

  it('includes turnTaskDelta in buildTurnStepContextMap output', () => {
    const turnId = 'turn-with-delta';
    const eventsByTurn: Record<string, AgentEvent[]> = {
      [turnId]: [
        createAssistantEvent(1000, 'Working on tasks...'),
        makeNamedToolEvent(1100, 'end', 'TaskCreate', JSON.stringify({
          task: { id: 't1', title: 'Setup', status: 'pending' },
          tasks: [{ id: 't1', title: 'Setup', status: 'pending' }],
        })),
        makeResultEvent(1200),
      ],
    };

    const contextMap = buildTurnStepContextMap(eventsByTurn);
    const context = contextMap[turnId];

    expect(context).toBeDefined();
    expect(context.turnTaskDelta).toBeDefined();
    expect(context.turnTaskDelta.hasMissionSet).toBe(false);
    expect(context.turnTaskDelta.touchedTaskIds).toEqual(['t1']);
    expect(context.turnTaskDelta.deltaTasks).toHaveLength(1);
    expect(context.turnTaskDelta.deltaTasks[0].id).toBe('t1');
  });
});
