import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { FileOperation } from '@renderer/utils/fileOperations';
import type { StepToolSummary } from '../toolChips';
import type { TurnStepContext } from '../turnStepContext';
import { buildSubAgentTimeline, formatSubAgentName, SUB_AGENT_TOOL_NAME, AGENT_TOOL_NAME, AGENT_OUTPUT_TOOL_NAME } from '../subAgentTimeline';
import { MAX_DETAIL_PARSE_BYTES } from '../safeParseDetail';

const createTaskEvent = (overrides: Partial<Extract<AgentEvent, { type: 'tool' }>>): AgentEvent => ({
  type: 'tool',
  toolName: SUB_AGENT_TOOL_NAME,
  detail: JSON.stringify({ subagent_type: 'general_helper', description: 'Work on files' }),
  stage: 'start',
  timestamp: 1,
  ...overrides
});

const createAssistantEvent = (timestamp: number, text: string): AgentEvent => ({
  type: 'assistant',
  text,
  timestamp
});

const createAgentOutputToolEvent = (
  stage: 'start' | 'end',
  timestamp: number,
  detail: string,
  toolUseId?: string
): AgentEvent => ({
  type: 'tool',
  toolName: AGENT_OUTPUT_TOOL_NAME,
  stage,
  detail,
  timestamp,
  toolUseId
});

describe('buildSubAgentTimeline', () => {
  it('returns null when no sub-agent invocations are present', () => {
    const events: AgentEvent[] = [
      createTaskEvent({ toolName: 'Grep', stage: 'start', timestamp: 1000 })
    ];
    const timeline = buildSubAgentTimeline(events);
    expect(timeline).toBeNull();
  });

  it('keeps a helper running until its own Task end event arrives', () => {
    const events: AgentEvent[] = [
      createTaskEvent({ timestamp: 1000 }),
      {
        type: 'tool',
        toolName: 'read_file',
        detail: '{}',
        stage: 'start',
        timestamp: 1100
      },
      {
        type: 'tool',
        toolName: 'read_file',
        detail: '{}',
        stage: 'end',
        timestamp: 1200
      }
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items[0].status).toBe('running');
    expect(timeline?.items[0].completedAt).toBeUndefined();
  });

  it('keeps async sub-agent running after "Async agent launched" acknowledgment', () => {
    const toolUseId = 'toolu_async_123';
    const events: AgentEvent[] = [
      createTaskEvent({ timestamp: 1000, toolUseId }),
      createTaskEvent({
        stage: 'end',
        timestamp: 1100,
        toolUseId,
        detail: 'Async agent launched successfully.\nagentId: abc12345 (This is an internal ID)'
      })
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items[0].status).toBe('running');
    expect(timeline?.items[0].completedAt).toBeUndefined();
    expect(timeline?.items[0].isBackground).toBe(true);
    expect(timeline?.runningCount).toBe(1);
  });

  it('marks synchronous sub-agent as not background', () => {
    const toolUseId = 'toolu_sync_123';
    const events: AgentEvent[] = [
      createTaskEvent({ timestamp: 1000, toolUseId }),
      createTaskEvent({
        stage: 'end',
        timestamp: 2000,
        toolUseId,
        detail: 'Task completed successfully with results'
      })
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items[0].status).toBe('completed');
    expect(timeline?.items[0].isBackground).toBe(false);
  });

  it('tracks namespaced Task tool names', () => {
    const toolUseId = 'toolu_namespaced_001';
    const toolName = 'mcp__delegation/Task';
    const events: AgentEvent[] = [
      createTaskEvent({ timestamp: 1000, toolUseId, toolName }),
      createTaskEvent({
        stage: 'end',
        timestamp: 2000,
        toolUseId,
        toolName,
        detail: 'Task completed successfully with results'
      })
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items).toHaveLength(1);
    expect(timeline?.items[0].status).toBe('completed');
  });

  it('marks async sub-agent as completed when AgentOutputTool returns success', () => {
    const toolUseId = 'toolu_async_456';
    const agentId = 'def67890';
    const events: AgentEvent[] = [
      createTaskEvent({ timestamp: 1000, toolUseId }),
      createTaskEvent({
        stage: 'end',
        timestamp: 1100,
        toolUseId,
        detail: `Async agent launched successfully.\nagentId: ${agentId} (This is an internal ID)`
      }),
      createAgentOutputToolEvent(
        'start',
        2000,
        JSON.stringify({ agentId, block: true }),
        'toolu_output_1'
      ),
      createAgentOutputToolEvent(
        'end',
        3000,
        JSON.stringify({
          retrieval_status: 'success',
          agents: { [agentId]: { status: 'completed', description: 'Task done' } }
        }),
        'toolu_output_1'
      )
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items[0].status).toBe('completed');
    expect(timeline?.items[0].completedAt).toBe(3000);
    expect(timeline?.runningCount).toBe(0);
  });

  it('keeps async sub-agent running when AgentOutputTool returns timeout/running status', () => {
    const toolUseId = 'toolu_async_789';
    const agentId = 'ghi11111';
    const events: AgentEvent[] = [
      createTaskEvent({ timestamp: 1000, toolUseId }),
      createTaskEvent({
        stage: 'end',
        timestamp: 1100,
        toolUseId,
        detail: `Async agent launched successfully.\nagentId: ${agentId} (This is an internal ID)`
      }),
      createAgentOutputToolEvent(
        'end',
        2000,
        JSON.stringify({
          retrieval_status: 'timeout',
          agents: { [agentId]: { status: 'running', description: 'Still working' } }
        }),
        'toolu_output_poll'
      )
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items[0].status).toBe('running');
    expect(timeline?.items[0].completedAt).toBeUndefined();
    expect(timeline?.runningCount).toBe(1);
  });

  it('extracts non-hex async agent IDs and marks completion from AgentOutputTool', () => {
    const toolUseId = 'toolu_async_non_hex_001';
    const agentId = 'AGENT-XYZ_123';
    const events: AgentEvent[] = [
      createTaskEvent({ timestamp: 1000, toolUseId }),
      createTaskEvent({
        stage: 'end',
        timestamp: 1100,
        toolUseId,
        detail: `Async agent launched successfully.\nagentId: ${agentId} (This is an internal ID)`
      }),
      createAgentOutputToolEvent(
        'end',
        2000,
        JSON.stringify({
          retrieval_status: 'success',
          agents: { [agentId]: { status: 'completed', description: 'Task done' } }
        }),
        'toolu_output_non_hex'
      )
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items).toHaveLength(1);
    expect(timeline?.items[0].status).toBe('completed');
    expect(timeline?.runningCount).toBe(0);
  });

  it('handles multiple async sub-agents with independent completions', () => {
    const agentIdA = 'aaa11111';
    const agentIdB = 'bbb22222';
    const events: AgentEvent[] = [
      createTaskEvent({ timestamp: 1000, toolUseId: 'toolu_1' }),
      createTaskEvent({
        stage: 'end',
        timestamp: 1100,
        toolUseId: 'toolu_1',
        detail: `Async agent launched successfully.\nagentId: ${agentIdA} (internal)`
      }),
      createTaskEvent({ timestamp: 1200, toolUseId: 'toolu_2' }),
      createTaskEvent({
        stage: 'end',
        timestamp: 1300,
        toolUseId: 'toolu_2',
        detail: `Async agent launched successfully.\nagentId: ${agentIdB} (internal)`
      }),
      // Only agentIdA completes
      createAgentOutputToolEvent(
        'end',
        2000,
        JSON.stringify({
          retrieval_status: 'success',
          agents: { [agentIdA]: { status: 'completed' } }
        }),
        'toolu_output'
      )
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items).toHaveLength(2);
    expect(timeline?.items[0].status).toBe('completed');
    expect(timeline?.items[1].status).toBe('running');
    expect(timeline?.runningCount).toBe(1);
  });

  it('creates fallback invocation when Task start detail is empty', () => {
    const toolUseId = 'toolu_empty_detail_001';
    const events: AgentEvent[] = [
      createTaskEvent({
        stage: 'start',
        timestamp: 1000,
        toolUseId,
        detail: ''
      }),
      createTaskEvent({
        stage: 'end',
        timestamp: 2000,
        toolUseId,
        detail: ''
      })
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items).toHaveLength(1);
    expect(timeline?.items[0].label).toBe('Sub-agent');
    expect(timeline?.items[0].subagentType).toBeUndefined();
    expect(timeline?.items[0].status).toBe('completed');
  });

  it('groups child tools under fallback pill when Task start detail is empty', () => {
    const toolUseId = 'toolu_empty_detail_002';
    const events: AgentEvent[] = [
      createAssistantEvent(900, 'Starting work'),
      createTaskEvent({
        stage: 'start',
        timestamp: 1000,
        toolUseId,
        detail: ''
      }),
      createTaskEvent({
        stage: 'end',
        timestamp: 3000,
        toolUseId,
        detail: ''
      })
    ];

    const toolSummariesByStep = new Map<number, StepToolSummary[]>([
      [1, [
        { label: 'WebSearch', icon: '🌐', tone: 'network', parentToolUseId: toolUseId },
        { label: 'WebSearch', icon: '🌐', tone: 'network', parentToolUseId: toolUseId },
        { label: 'Read', icon: '📄', tone: 'files', parentToolUseId: toolUseId }
      ]]
    ]);

    const context: TurnStepContext = {
      assistantSteps: [createAssistantEvent(900, 'Starting work')],
      fileOperationsByStep: new Map(),
      flattenedFileOperations: [],
      toolSummariesByStep,
      technicalEvents: [],
      technicalEventsByStep: new Map(),
      pendingTodos: [],
      missionContext: null,
      taskProgress: [],
      turnTaskDelta: {
        hasMissionSet: false,
        snapshot: [],
        touchedTaskIds: [],
        deltaTasks: [],
      },
      modelByStep: new Map(),
    };

    const timeline = buildSubAgentTimeline(events, context);
    expect(timeline).not.toBeNull();
    expect(timeline?.items[0].toolSummaries).toHaveLength(3);
    expect(timeline?.toolCount).toBe(3);
  });

  it('extracts sub-agent metadata from malformed/truncated Task start detail', () => {
    const toolUseId = 'toolu_truncated_meta_001';
    const malformedStartDetail = `{
  "subagent_type": "general-purpose",
  "description": "Classify inbox items 1-100 for cleanup",
  "prompt": "Item 1\\nItem 2\\nItem 3
... [truncated, 123 chars omitted]`;

    const events: AgentEvent[] = [
      createTaskEvent({
        stage: 'start',
        timestamp: 1000,
        toolUseId,
        detail: malformedStartDetail
      }),
      createTaskEvent({
        stage: 'end',
        timestamp: 2000,
        toolUseId,
        detail: 'Classification complete'
      })
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items).toHaveLength(1);
    expect(timeline?.items[0].label).toBe('General Purpose');
    expect(timeline?.items[0].summary).toBe('Classify inbox items 1-100 for cleanup');
    expect(timeline?.items[0].status).toBe('completed');
  });

  it('extracts escaped quotes and backslashes from malformed Task start detail', () => {
    const malformedStartDetail = `{
  "subagent_type": "general-purpose",
  "description": "Investigate \\\"quoted\\\" paths like C:\\\\Temp\\\\foo",
  "prompt": "Line 1\nLine 2
... [truncated, 456 chars omitted]`;

    const events: AgentEvent[] = [
      createTaskEvent({
        stage: 'start',
        timestamp: 1000,
        toolUseId: 'toolu_truncated_escapes_001',
        detail: malformedStartDetail
      })
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items).toHaveLength(1);
    expect(timeline?.items[0].label).toBe('General Purpose');
    expect(timeline?.items[0].summary).toBe('Investigate "quoted" paths like C:\\Temp\\foo');
  });

  it('maps invocations to step ranges with tool and file summaries', () => {
    const toolUseId = 'toolu_test_123';
    const events: AgentEvent[] = [
      createTaskEvent({ timestamp: 1000, toolUseId }),
      createTaskEvent({ stage: 'end', timestamp: 3200, toolUseId })
    ];

    const assistantSteps = [
      createAssistantEvent(900, 'Thinking about the plan'),
      createAssistantEvent(2000, 'Editing files'),
      createAssistantEvent(4000, 'Wrapping up')
    ];

    const toolSummariesByStep = new Map<number, StepToolSummary[]>([
      [
        1,
        [
          {
            label: 'Read',
            icon: '📄',
            tone: 'files',
            parentToolUseId: toolUseId
          }
        ]
      ],
      [
        2,
        [
          {
            label: 'Plan',
            icon: '🧠',
            tone: 'planning',
            parentToolUseId: toolUseId
          }
        ]
      ]
    ]);

    const fileOperationsByStep = new Map<number, FileOperation[]>([
      [
        1,
        [
          {
            toolName: 'Read',
            operation: 'read',
            filePath: '/tmp/demo.txt',
            timestamp: 1500,
            stage: 'end',
            detail: '{}'
          }
        ]
      ]
    ]);

    const context: TurnStepContext = {
      assistantSteps,
      fileOperationsByStep,
      flattenedFileOperations: [],
      toolSummariesByStep,
      technicalEvents: [],
      technicalEventsByStep: new Map(),
      pendingTodos: [],
      missionContext: null,
      taskProgress: [],
      turnTaskDelta: {
        hasMissionSet: false,
        snapshot: [],
        touchedTaskIds: [],
        deltaTasks: [],
      },
      modelByStep: new Map(),
    };

    const timeline = buildSubAgentTimeline(events, context);
    expect(timeline).not.toBeNull();
    expect(timeline?.items).toHaveLength(1);
    const item = timeline?.items[0];
    expect(item?.stepRange).toEqual({ start: 1, end: 2 });
    expect(item?.toolSummaries.length).toBe(2);
    expect(item?.fileSummary).toContain('demo.txt');
    expect(timeline?.summaryLabel).toContain('General Helper');
  });

  it('stores result from synchronous Task end event detail', () => {
    const toolUseId = 'toolu_result_001';
    const events: AgentEvent[] = [
      createTaskEvent({
        timestamp: 1000,
        toolUseId,
        detail: JSON.stringify({ subagent_type: 'researcher', description: 'Investigate the issue' })
      }),
      createTaskEvent({
        stage: 'end',
        timestamp: 2000,
        toolUseId,
        detail: 'Here is the sub-agent result text'
      })
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items[0].result).toBe('Here is the sub-agent result text');
  });

  it('does NOT store result for background Task acknowledgment', () => {
    const toolUseId = 'toolu_bg_result_001';
    const events: AgentEvent[] = [
      createTaskEvent({ timestamp: 1000, toolUseId }),
      createTaskEvent({
        stage: 'end',
        timestamp: 1100,
        toolUseId,
        detail: 'Async agent launched successfully.\nagentId: abc12345 (This is an internal ID)'
      })
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items[0].result).toBeUndefined();
  });

  it('extracts prompt from start event JSON', () => {
    const events: AgentEvent[] = [
      createTaskEvent({
        timestamp: 1000,
        detail: JSON.stringify({
          subagent_type: 'researcher',
          description: 'Research something',
          prompt: 'Please investigate the codebase...'
        })
      })
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items[0].prompt).toBe('Please investigate the codebase...');
    expect(timeline?.items[0].summary).toBe('Research something');
  });

  it('normalizes whitespace-only prompts to undefined', () => {
    const events: AgentEvent[] = [
      createTaskEvent({
        timestamp: 1000,
        detail: JSON.stringify({
          subagent_type: 'researcher',
          description: '   ',
          prompt: '   '
        })
      })
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline?.items[0].prompt).toBeUndefined();
    expect(timeline?.items[0].summary).toBeUndefined();
  });

  it('includes both prompt and result fields on a completed timeline item', () => {
    const toolUseId = 'toolu_full_001';
    const events: AgentEvent[] = [
      createTaskEvent({
        timestamp: 1000,
        toolUseId,
        detail: JSON.stringify({
          subagent_type: 'planner',
          description: 'Create a plan',
          prompt: 'Analyze the requirements and create a staged plan...'
        })
      }),
      createTaskEvent({
        stage: 'end',
        timestamp: 3000,
        toolUseId,
        detail: 'The plan has been created with 4 stages covering data model, UI, styles, and tests.'
      })
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    const item = timeline?.items[0];
    expect(item?.prompt).toBe('Analyze the requirements and create a staged plan...');
    expect(item?.result).toBe('The plan has been created with 4 stages covering data model, UI, styles, and tests.');
    expect(item?.status).toBe('completed');
  });

  // --- Agent tool format tests ---

  it('recognizes Agent tool as a subagent invocation', () => {
    const toolUseId = 'toolu_agent_001';
    const events: AgentEvent[] = [
      {
        type: 'tool',
        toolName: AGENT_TOOL_NAME,
        detail: JSON.stringify({ agent: 'knowledge-worker', prompt: 'Retrieve the last 3 emails' }),
        stage: 'start',
        timestamp: 1000,
        toolUseId
      },
      {
        type: 'tool',
        toolName: AGENT_TOOL_NAME,
        detail: 'Here are the 3 most recent emails...',
        stage: 'end',
        timestamp: 5000,
        toolUseId
      }
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline!.totalCount).toBe(1);
    const item = timeline!.items[0];
    expect(item.label).toBe('Knowledge Worker');
    expect(item.subagentType).toBe('knowledge-worker');
    expect(item.status).toBe('completed');
    expect(item.result).toBe('Here are the 3 most recent emails...');
  });

  it('populates sub-agent model from routing metadata in event detail', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool',
        toolName: AGENT_TOOL_NAME,
        detail: JSON.stringify({
          agent: 'researcher',
          prompt: 'Investigate routing',
          _routingMeta: {
            model: 'gpt-5.5',
            contextMode: 'contextual',
            effort: 'medium',
          },
        }),
        stage: 'start',
        timestamp: 1000,
        toolUseId: 'toolu_agent_routing_model',
      },
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline!.items[0].model).toBe('gpt-5.5');
    expect(timeline!.items[0].routingEffort).toBe('medium');
  });

  it('populates sub-agent context mode from routing metadata in event detail', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool',
        toolName: AGENT_TOOL_NAME,
        detail: JSON.stringify({
          agent: 'researcher',
          prompt: 'Investigate routing',
          _routingMeta: {
            model: 'claude-sonnet-4-20250514',
            contextMode: 'scoped',
          },
        }),
        stage: 'start',
        timestamp: 1000,
        toolUseId: 'toolu_agent_routing_context',
      },
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline!.items[0].contextMode).toBe('scoped');
  });

  it('populates routing metadata from a parent toolUseId keyed status event', () => {
    const toolUseId = 'toolu_agent_status_routing';
    const events: AgentEvent[] = [
      {
        type: 'status',
        message: `routing:subagent:${toolUseId}:gpt-5.5:contextual:high`,
        timestamp: 900,
      },
      {
        type: 'tool',
        toolName: AGENT_TOOL_NAME,
        detail: JSON.stringify({ agent: 'researcher', prompt: 'Investigate routing' }),
        stage: 'start',
        timestamp: 1000,
        toolUseId,
      },
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline!.items[0].model).toBe('gpt-5.5');
    expect(timeline!.items[0].contextMode).toBe('contextual');
    expect(timeline!.items[0].routingEffort).toBe('high');
  });

  it('leaves routing metadata undefined when _routingMeta is absent', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool',
        toolName: AGENT_TOOL_NAME,
        detail: JSON.stringify({ agent: 'researcher', prompt: 'Investigate routing' }),
        stage: 'start',
        timestamp: 1000,
        toolUseId: 'toolu_agent_no_routing_meta',
      },
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline!.items[0].model).toBeUndefined();
    expect(timeline!.items[0].contextMode).toBeUndefined();
  });

  it('extracts Agent metadata from raw detail string via regex fallback', () => {
    const toolUseId = 'toolu_agent_raw_001';
    const events: AgentEvent[] = [
      {
        type: 'tool',
        toolName: AGENT_TOOL_NAME,
        detail: '{"agent": "knowledge-worker", "prompt": "Do something useful"}',
        stage: 'start',
        timestamp: 1000,
        toolUseId
      }
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline!.items[0].label).toBe('Knowledge Worker');
    expect(timeline!.items[0].subagentType).toBe('knowledge-worker');
  });

  it('creates fallback invocation when Agent start detail is empty', () => {
    const toolUseId = 'toolu_agent_empty_001';
    const events: AgentEvent[] = [
      {
        type: 'tool',
        toolName: AGENT_TOOL_NAME,
        detail: '',
        stage: 'start',
        timestamp: 1000,
        toolUseId
      }
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline!.items[0].label).toBe('Sub-agent');
    expect(timeline!.items[0].subagentType).toBeUndefined();
  });

  it('handles parallel Agent tool calls', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool',
        toolName: AGENT_TOOL_NAME,
        detail: JSON.stringify({ agent: 'knowledge-worker', prompt: 'Get emails' }),
        stage: 'start',
        timestamp: 1000,
        toolUseId: 'toolu_agent_a'
      },
      {
        type: 'tool',
        toolName: AGENT_TOOL_NAME,
        detail: JSON.stringify({ agent: 'knowledge-worker', prompt: 'Get slacks' }),
        stage: 'start',
        timestamp: 1000,
        toolUseId: 'toolu_agent_b'
      },
      {
        type: 'tool',
        toolName: AGENT_TOOL_NAME,
        detail: 'Email results...',
        stage: 'end',
        timestamp: 4000,
        toolUseId: 'toolu_agent_a'
      },
      {
        type: 'tool',
        toolName: AGENT_TOOL_NAME,
        detail: 'Slack results...',
        stage: 'end',
        timestamp: 5000,
        toolUseId: 'toolu_agent_b'
      }
    ];

    const timeline = buildSubAgentTimeline(events);
    expect(timeline).not.toBeNull();
    expect(timeline!.totalCount).toBe(2);
    expect(timeline!.items[0].status).toBe('completed');
    expect(timeline!.items[1].status).toBe('completed');
    expect(timeline!.summaryLabel).toBe('Knowledge Worker ×2');
  });

  describe('orphaned end events (missing start)', () => {
    it('creates a retroactive invocation from an Agent end event with no start', () => {
      const events: AgentEvent[] = [
        // Child tools with parentToolUseId pointing to the Agent
        {
          type: 'tool',
          toolName: 'Read',
          detail: '{}',
          stage: 'start',
          timestamp: 2000,
          toolUseId: 'child-tu-1',
          parentToolUseId: 'agent-tu-orphan',
        },
        {
          type: 'tool',
          toolName: 'Read',
          detail: 'file contents',
          stage: 'end',
          timestamp: 2500,
          toolUseId: 'child-tu-1',
          parentToolUseId: 'agent-tu-orphan',
        },
        // Agent end event with no matching start
        {
          type: 'tool',
          toolName: AGENT_TOOL_NAME,
          detail: 'Research results...',
          stage: 'end',
          timestamp: 3000,
          toolUseId: 'agent-tu-orphan',
        },
      ];

      const timeline = buildSubAgentTimeline(events);
      expect(timeline).not.toBeNull();
      expect(timeline!.totalCount).toBe(1);
      expect(timeline!.items[0].status).toBe('completed');
      expect(timeline!.items[0].label).toBe('Agent');
      expect(timeline!.items[0].result).toBe('Research results...');
      // Start time inferred from earliest child event
      expect(timeline!.items[0].startedAt).toBe(2000);
      expect(timeline!.items[0].completedAt).toBe(3000);
    });

    it('uses end timestamp as start when no child events exist', () => {
      const events: AgentEvent[] = [
        {
          type: 'tool',
          toolName: AGENT_TOOL_NAME,
          detail: 'Some result',
          stage: 'end',
          timestamp: 5000,
          toolUseId: 'agent-tu-solo',
        },
      ];

      const timeline = buildSubAgentTimeline(events);
      expect(timeline).not.toBeNull();
      expect(timeline!.items[0].startedAt).toBe(5000);
      expect(timeline!.items[0].completedAt).toBe(5000);
    });

    it('creates retroactive invocation for Task tool orphaned end', () => {
      const events: AgentEvent[] = [
        {
          type: 'tool',
          toolName: SUB_AGENT_TOOL_NAME,
          detail: 'Task completed',
          stage: 'end',
          timestamp: 4000,
          toolUseId: 'task-tu-orphan',
        },
      ];

      const timeline = buildSubAgentTimeline(events);
      expect(timeline).not.toBeNull();
      expect(timeline!.totalCount).toBe(1);
      expect(timeline!.items[0].status).toBe('completed');
      expect(timeline!.items[0].label).toBe('Task');
    });
  });

  describe('over-budget detail fallback is bounded (Stage 1 F1)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('does NOT JSON.parse a huge captured prompt field, yet still derives small metadata', () => {
      // Build an over-budget detail (> MAX_DETAIL_PARSE_BYTES) so safeParseDetail
      // declines it and the regex fallback runs. The prompt field is enormous —
      // the old fallback would JSON.parse(`"<huge>"`) and allocate a large copy.
      const hugePrompt = 'x'.repeat(MAX_DETAIL_PARSE_BYTES + 10_000);
      const detail = JSON.stringify({
        subagent_type: 'general_helper',
        description: 'Short description',
        prompt: hugePrompt,
      });
      expect(detail.length).toBeGreaterThan(MAX_DETAIL_PARSE_BYTES);

      const parseSpy = vi.spyOn(JSON, 'parse');

      const events: AgentEvent[] = [
        createTaskEvent({ detail, toolUseId: 't1', timestamp: 1000 }),
      ];
      const timeline = buildSubAgentTimeline(events);

      // The whole over-budget detail was never handed to JSON.parse, and the
      // bounded fallback only ever parses SMALL captured fields — never the
      // huge prompt. (Small scalar fields like subagent_type/description are
      // legitimately parsed; that is the point of the bounded fallback.)
      for (const call of parseSpy.mock.calls) {
        const arg = call[0];
        expect(typeof arg).toBe('string');
        // No call carries the over-budget detail or the huge decoded prompt.
        expect((arg as string).length).toBeLessThanOrEqual(MAX_DETAIL_PARSE_BYTES);
        expect(arg).not.toBe(detail);
      }

      // The small metadata it CAN derive bounded-ly is still present.
      expect(timeline).not.toBeNull();
      expect(timeline!.items[0].label).toBe(formatSubAgentName('general_helper'));
      expect(timeline!.items[0].summary).toBe('Short description');
      // The huge prompt was skipped, not decoded.
      expect(timeline!.items[0].prompt).toBeUndefined();
    });
  });
});
