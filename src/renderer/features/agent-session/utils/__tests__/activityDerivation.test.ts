import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { TaskProgressItem } from '../turnStepContext';
import { buildTurnStepContextMap } from '../turnStepContext';
import {
  deriveCollapsedSummary,
  deriveCurrentActivity,
  deriveOperatorSetupAffordance,
  humanizeToolDisplay,
  isConcreteActivitySource,
  PERSONA_QUIP_LONG_WAIT_MS,
  shouldShowPersonaQuip,
  simplifyTaskTitle,
  toProgressivePhrase,
} from '../activityDerivation';
import type { StepToolSummary } from '../toolChips';
import type { SubAgentTimeline, SubAgentTimelineItem } from '../subAgentTimeline';

const makeSubAgentItem = (overrides: Partial<SubAgentTimelineItem> = {}): SubAgentTimelineItem => ({
  id: `sa-${Math.random().toString(36).slice(2, 8)}`,
  label: 'Researcher',
  status: 'running',
  isBackground: false,
  startedAt: Date.now() - 5000,
  toolSummaries: [],
  stepRange: null,
  ...overrides,
});

const makeTimeline = (items: SubAgentTimelineItem[]): SubAgentTimeline => ({
  items,
  summaryLabel: '',
  tooltip: '',
  totalCount: items.length,
  runningCount: items.filter(i => i.status === 'running').length,
  toolCount: 0,
});

describe('simplifyTaskTitle', () => {
  it('preserves verb and object — never strips down to bare noun', () => {
    expect(simplifyTaskTitle(
      'Read the full transcript file(s) to understand context, what was discussed, dynamics, asks, and unresolved threads',
    )).toMatch(/^Read the full transcript file/);
  });

  it('strips file paths while keeping surrounding text', () => {
    expect(simplifyTaskTitle(
      'Read the source-capture skill: rebel-system/skills/memory/source-capture/SKILL.md',
    )).toBe('Read the source-capture skill');
  });

  it('strips parenthetical technical refs', () => {
    expect(simplifyTaskTitle(
      'Read the existing Travis Wussow person file in full (work/mindstone/Exec/memory/topics/people/Travis-Wussow.md)',
    )).toBe('Read the existing Travis Wussow person file in full');
  });

  it('trims detail lists after colon when prefix is long enough', () => {
    expect(simplifyTaskTitle(
      'Identify all memory-worthy knowledge from the full conversation: the self-review findings, threshold compliance concerns',
    )).toBe('Identify all memory-worthy knowledge from the full…');
  });

  it('preserves em-dash ranges (e.g., A\u2013F)', () => {
    expect(simplifyTaskTitle('Run contradiction checks A\u2013F')).toBe('Run contradiction checks A\u2013F');
  });

  it('preserves short titles unchanged', () => {
    expect(simplifyTaskTitle('Update memory topics and source capture for Sasha meeting'))
      .toBe('Update memory topics and source capture for Sasha meeting');
  });

  it('preserves conjunctions and full meaning', () => {
    expect(simplifyTaskTitle('Create inbox item(s) and write meeting context to memory'))
      .toBe('Create inbox item and write meeting context to memory');
  });

  it('caps at ~60 chars with word-boundary ellipsis', () => {
    const result = simplifyTaskTitle(
      'Search for today\'s meeting with Aidan Gomez using rebel_search_sources and rebel_meetings_history filtered to 2026-04-29',
    );
    expect(result.length).toBeLessThanOrEqual(61);
    expect(result).toMatch(/\u2026$/);
  });

  it('cleans dangling prepositions from path stripping', () => {
    expect(simplifyTaskTitle(
      'Read the rebel-system memory-update skill at rebel-system/skills/memory/memory-update/SKILL.md to understand the procedure',
    )).toBe('Read the rebel-system memory-update skill to understand\u2026');
  });
});

describe('toProgressivePhrase', () => {
  it('converts imperative task titles into ongoing verbs', () => {
    expect(toProgressivePhrase('Search Rebel Community Discourse')).toBe('Searching Rebel Community Discourse');
    expect(toProgressivePhrase('Run the Rebel UX Auditor')).toBe('Running the Rebel UX Auditor');
  });

  it('keeps existing ongoing phrasing intact', () => {
    expect(toProgressivePhrase('Searching Rebel Community Discourse')).toBe('Searching Rebel Community Discourse');
  });

  it('leaves noun-based labels alone', () => {
    expect(toProgressivePhrase('Homepage analysis')).toBe('Homepage analysis');
  });
});

describe('deriveCurrentActivity', () => {
  it('uses thinkingHeadline when no tools are running', () => {
    expect(deriveCurrentActivity({
      toolSummariesByStep: new Map(),
      taskProgress: [],
      subAgentTimeline: null,
      thinkingHeadline: 'Looking at **Linear** issues',
    })).toMatchObject({
      statusLine: 'Looking at Linear issues',
      isActive: false,
      hasError: false,
    });
  });

  it('falls back to in-progress task title when no headline or tools', () => {
    const taskProgress: TaskProgressItem[] = [
      {
        id: 'task-1',
        title: 'Search Rebel Community Discourse for homepage issues',
        status: 'in_progress',
      } as TaskProgressItem,
    ];

    expect(deriveCurrentActivity({
      toolSummariesByStep: new Map(),
      taskProgress,
      subAgentTimeline: null,
    })).toMatchObject({
      statusLine: 'Searching Rebel Community Discourse for homepage issues',
      isActive: false,
      hasError: false,
    });
  });

  it('returns "Getting started" when nothing else is available', () => {
    expect(deriveCurrentActivity({
      toolSummariesByStep: new Map(),
      taskProgress: [],
      subAgentTimeline: null,
    })).toMatchObject({
      statusLine: 'Getting started',
      isActive: false,
      hasError: false,
    });
  });

  it('uses Ask copy for a running Operator consult', () => {
    const runningTool: StepToolSummary = {
      label: 'Rebel Operator Consult',
      status: 'running',
      toolName: 'rebel_operator__consult',
      detail: JSON.stringify({ operatorId: '/workspace/Chief-of-Staff::skeptical-engineer' }),
    } as StepToolSummary;
    const result = deriveCurrentActivity({
      toolSummariesByStep: new Map([[1, [runningTool]]]),
      taskProgress: [],
      subAgentTimeline: null,
    });
    expect(result.statusLine).toBe('Asking Skeptical Engineer');
  });

  it('uses friendly failure copy for Operator consult errors', () => {
    const errorTool: StepToolSummary = {
      label: 'Rebel Operator Consult',
      status: 'error',
      toolName: 'rebel_operator__consult',
      detail: JSON.stringify({ operatorName: 'Risk Critic' }),
    } as StepToolSummary;
    const result = deriveCurrentActivity({
      toolSummariesByStep: new Map([[1, [errorTool]]]),
      taskProgress: [],
      subAgentTimeline: null,
    });
    expect(result.statusLine).toBe("Couldn't ask Risk Critic — moving on");
    expect(result.hasError).toBe(true);
  });

  it('names the Operator from structured consult error payloads', () => {
    const errorPayload = {
      isError: true,
      errorCode: 'consult_failed',
      message: 'Consult with Investor View failed before it could return a perspective.',
      operatorId: '/workspace/Chief-of-Staff::investor-view',
      operatorName: 'Investor View',
    };
    const events: AgentEvent[] = [
      {
        type: 'assistant',
        text: '',
        timestamp: 1,
      } as AgentEvent,
      {
        type: 'tool',
        toolName: 'rebel_operator__consult',
        toolUseId: 'toolu-operator-error-1',
        detail: JSON.stringify({ operatorId: errorPayload.operatorId, focus: 'Pressure-test the plan' }),
        stage: 'start',
        timestamp: 2,
      } as AgentEvent,
      {
        type: 'tool',
        toolName: 'rebel_operator__consult',
        toolUseId: 'toolu-operator-error-1',
        detail: JSON.stringify({ result: { isError: true, message: errorPayload.message } }),
        stage: 'end',
        timestamp: 3,
        toolResult: {
          content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
        },
      } as AgentEvent,
    ];

    const context = buildTurnStepContextMap({ turn_1: events }).turn_1;
    const summary = context.toolSummariesByStep.get(1)?.[0];
    expect(summary?.resultPayload).toEqual(errorPayload);

    const result = deriveCurrentActivity({
      toolSummariesByStep: context.toolSummariesByStep,
      taskProgress: [],
      subAgentTimeline: null,
    });
    expect(result.statusLine).toBe("Couldn't ask Investor View — moving on");
    expect(result.hasError).toBe(true);
  });

  it('groups 2-3 parallel Operator consults into one activity line', () => {
    const tools: StepToolSummary[] = [
      {
        label: 'Rebel Operator Consult',
        status: 'success',
        toolName: 'rebel_operator__consult',
        detail: JSON.stringify({ result: { operatorName: 'Head of Marketing' } }),
      } as StepToolSummary,
      {
        label: 'Rebel Operator Consult',
        status: 'success',
        toolName: 'rebel_operator__consult',
        detail: JSON.stringify({ result: { operatorName: 'Brand Critic' } }),
      } as StepToolSummary,
      {
        label: 'Rebel Operator Consult',
        status: 'success',
        toolName: 'rebel_operator__consult',
        detail: JSON.stringify({ result: { operatorName: 'Skeptical Engineer' } }),
      } as StepToolSummary,
    ];
    const result = deriveCurrentActivity({
      toolSummariesByStep: new Map([[1, tools]]),
      taskProgress: [],
      subAgentTimeline: null,
    });
    expect(result.statusLine).toBe('Asked 3 Operators: Head of Marketing, Brand Critic, Skeptical Engineer');
  });

  it('does not group two sequential Operator consults from different steps', () => {
    const firstTool: StepToolSummary = {
      label: 'Rebel Operator Consult',
      status: 'success',
      toolName: 'rebel_operator__consult',
      detail: JSON.stringify({ result: { operatorName: 'Head of Marketing' } }),
    } as StepToolSummary;
    const secondTool: StepToolSummary = {
      label: 'Rebel Operator Consult',
      status: 'success',
      toolName: 'rebel_operator__consult',
      detail: JSON.stringify({ result: { operatorName: 'Brand Critic' } }),
    } as StepToolSummary;
    const result = deriveCurrentActivity({
      toolSummariesByStep: new Map([[1, [firstTool]], [2, [secondTool]]]),
      taskProgress: [],
      subAgentTimeline: null,
    });
    expect(result.statusLine).toBe('Asking Brand Critic');
  });

  it('does not group four same-step Operator consults', () => {
    const tools = ['Head of Marketing', 'Brand Critic', 'Skeptical Engineer', 'Finance Lead'].map((operatorName) => ({
      label: 'Rebel Operator Consult',
      status: 'success',
      toolName: 'rebel_operator__consult',
      detail: JSON.stringify({ result: { operatorName } }),
    } as StepToolSummary));
    const result = deriveCurrentActivity({
      toolSummariesByStep: new Map([[1, tools]]),
      taskProgress: [],
      subAgentTimeline: null,
    });
    expect(result.statusLine).toBe('Asking Finance Lead');
  });

  it('keeps single and zero Operator consult turns ungrouped', () => {
    const singleTool: StepToolSummary = {
      label: 'Rebel Operator Consult',
      status: 'success',
      toolName: 'rebel_operator__consult',
      detail: JSON.stringify({ result: { operatorName: 'Skeptical Engineer' } }),
    } as StepToolSummary;
    expect(deriveCurrentActivity({
      toolSummariesByStep: new Map([[1, [singleTool]]]),
      taskProgress: [],
      subAgentTimeline: null,
    }).statusLine).toBe('Asking Skeptical Engineer');

    expect(deriveCurrentActivity({
      toolSummariesByStep: new Map(),
      taskProgress: [],
      subAgentTimeline: null,
    }).statusLine).toBe('Getting started');
  });

  it('surfaces Set up affordance when Operator consult succeeds but needs setup', () => {
    const needsSetupTool: StepToolSummary = {
      label: 'Rebel Operator Consult',
      status: 'success',
      toolName: 'rebel_operator__consult',
      detail: 'Operator not set up for this Space yet',
      resultPayload: {
        isError: false,
        calibrated: false,
        errorCode: null,
        operatorId: '/workspace/Chief-of-Staff::brand-critic',
        operatorName: 'Brand Critic',
        message: 'Operator not set up for this Space yet',
      },
    } as StepToolSummary;

    const result = deriveCurrentActivity({
      toolSummariesByStep: new Map([[1, [needsSetupTool]]]),
      taskProgress: [],
      subAgentTimeline: null,
    });

    expect(result.statusLine).toBe('Set up Brand Critic');
    expect(result.operatorSetupAffordance).toEqual({
      operatorId: '/workspace/Chief-of-Staff::brand-critic',
      operatorName: 'Brand Critic',
      label: 'Set up Brand Critic',
      deepLink: `rebel://team/${encodeURIComponent('/workspace/Chief-of-Staff::brand-critic')}`,
    });
    expect(humanizeToolDisplay(needsSetupTool)).toBe('Set up Brand Critic');
    expect(deriveOperatorSetupAffordance(needsSetupTool)?.label).toBe('Set up Brand Critic');
  });

  it('renders calibrated Operator consult success normally without setup affordance', () => {
    const calibratedTool: StepToolSummary = {
      label: 'Rebel Operator Consult',
      status: 'success',
      toolName: 'rebel_operator__consult',
      detail: 'The message is trying too hard.',
      resultPayload: {
        isError: false,
        calibrated: true,
        errorCode: null,
        operatorId: '/workspace/Chief-of-Staff::brand-critic',
        operatorName: 'Brand Critic',
        perspective: 'The message is trying too hard.',
        evidenceCited: [],
        confidence: 0.8,
        diaryAppendFailed: false,
      },
    } as StepToolSummary;

    const result = deriveCurrentActivity({
      toolSummariesByStep: new Map([[1, [calibratedTool]]]),
      taskProgress: [],
      subAgentTimeline: null,
    });

    expect(result.statusLine).toBe('Asking Brand Critic');
    expect(result.operatorSetupAffordance).toBeUndefined();
    expect(deriveOperatorSetupAffordance(calibratedTool)).toBeNull();
  });

  it('preserves raw Operator consult result payload through turn-step context so setup affordance fires', () => {
    const resultPayload = {
      isError: false,
      calibrated: false,
      errorCode: null,
      operatorId: '/workspace/Chief-of-Staff::brand-critic',
      operatorName: 'Brand Critic',
      message: 'Operator not set up for this Space yet',
    };
    const events: AgentEvent[] = [
      {
        type: 'assistant',
        text: '',
        timestamp: 1,
      } as AgentEvent,
      {
        type: 'tool',
        toolName: 'rebel_operator__consult',
        toolUseId: 'toolu-operator-1',
        detail: JSON.stringify({ operatorId: resultPayload.operatorId, focus: 'Stress-test this claim' }),
        stage: 'start',
        timestamp: 2,
      } as AgentEvent,
      {
        type: 'tool',
        toolName: 'rebel_operator__consult',
        toolUseId: 'toolu-operator-1',
        detail: 'Operator not set up for this Space yet',
        stage: 'end',
        timestamp: 3,
        toolResult: {
          content: [{ type: 'text', text: JSON.stringify({ result: resultPayload }) }],
        },
      } as AgentEvent,
    ];

    const context = buildTurnStepContextMap({ turn_1: events }).turn_1;
    const summary = context.toolSummariesByStep.get(1)?.[0];
    expect(summary?.detail).toBe('Operator not set up for this Space yet');
    expect(summary?.resultPayload).toEqual(resultPayload);

    const activity = deriveCurrentActivity({
      toolSummariesByStep: context.toolSummariesByStep,
      taskProgress: [],
      subAgentTimeline: null,
    });
    expect(activity.operatorSetupAffordance?.label).toBe('Set up Brand Critic');
  });

  it('groups same-step Operator consults even when another tool shares the step', () => {
    const tools: StepToolSummary[] = [
      {
        label: 'Read file',
        status: 'success',
        toolName: 'read_file',
      } as StepToolSummary,
      {
        label: 'Rebel Operator Consult',
        status: 'success',
        toolName: 'rebel_operator__consult',
        detail: JSON.stringify({ result: { operatorName: 'Head of Marketing' } }),
      } as StepToolSummary,
      {
        label: 'Rebel Operator Consult',
        status: 'success',
        toolName: 'rebel_operator__consult',
        detail: JSON.stringify({ result: { operatorName: 'Brand Critic' } }),
      } as StepToolSummary,
    ];
    const result = deriveCurrentActivity({
      toolSummariesByStep: new Map([[1, tools]]),
      taskProgress: [],
      subAgentTimeline: null,
    });
    expect(result.statusLine).toBe('Asked 2 Operators: Head of Marketing, Brand Critic');
  });

  describe('mcpBuildActivity (connector build progress)', () => {
    it('shows "Building <name>" during the implementing subphase', () => {
      expect(deriveCurrentActivity({
        toolSummariesByStep: new Map(),
        taskProgress: [],
        subAgentTimeline: null,
        mcpBuildActivity: { subphase: 'implementing', connectorName: 'Zendesk' },
      })).toMatchObject({
        statusLine: 'Building Zendesk',
        isActive: true,
        hasError: false,
      });
    });

    it('shows "Trying out <name>" during the testing subphase', () => {
      expect(deriveCurrentActivity({
        toolSummariesByStep: new Map(),
        taskProgress: [],
        subAgentTimeline: null,
        mcpBuildActivity: { subphase: 'testing', connectorName: 'hello-world-mcp' },
      })).toMatchObject({
        statusLine: 'Trying out hello-world-mcp',
        isActive: true,
        hasError: false,
      });
    });

    it('wins over a running tool (build state is the higher-level intent)', () => {
      const runningTool: StepToolSummary = {
        label: 'Run command',
        status: 'running',
        toolName: 'run_command',
      } as StepToolSummary;
      const tools = new Map<number, StepToolSummary[]>([[0, [runningTool]]]);
      expect(deriveCurrentActivity({
        toolSummariesByStep: tools,
        taskProgress: [],
        subAgentTimeline: null,
        mcpBuildActivity: { subphase: 'testing', connectorName: 'Linear' },
      })).toMatchObject({
        statusLine: 'Trying out Linear',
        isActive: true,
        hasError: false,
      });
    });

    it('exposes the mcpBuild payload with verb, connector name, and helper text', () => {
      const result = deriveCurrentActivity({
        toolSummariesByStep: new Map(),
        taskProgress: [],
        subAgentTimeline: null,
        mcpBuildActivity: { subphase: 'testing', connectorName: 'Linear' },
      });
      expect(result.mcpBuild).toEqual({
        verb: 'Trying out',
        connectorName: 'Linear',
        helperText: expect.stringContaining('realistic examples'),
      });
    });

    it('uses the implementing helper text for the building subphase', () => {
      const result = deriveCurrentActivity({
        toolSummariesByStep: new Map(),
        taskProgress: [],
        subAgentTimeline: null,
        mcpBuildActivity: { subphase: 'implementing', connectorName: 'Zendesk' },
      });
      expect(result.mcpBuild).toEqual({
        verb: 'Building',
        connectorName: 'Zendesk',
        helperText: expect.stringContaining('putting the pieces together'),
      });
    });

    it('does not win over an errored tool (errors still surface)', () => {
      const erroredTool: StepToolSummary = {
        label: 'Run command',
        status: 'error',
        toolName: 'run_command',
      } as StepToolSummary;
      const tools = new Map<number, StepToolSummary[]>([[0, [erroredTool]]]);
      const result = deriveCurrentActivity({
        toolSummariesByStep: tools,
        taskProgress: [],
        subAgentTimeline: null,
        mcpBuildActivity: { subphase: 'testing', connectorName: 'Linear' },
      });
      expect(result.hasError).toBe(true);
      expect(result.statusLine).toMatch(/Had trouble/);
    });
  });

  describe('sub-agent activity (parallel assistants)', () => {
    it('shows "Assistant working" for a single running sub-agent with no activity', () => {
      const timeline = makeTimeline([makeSubAgentItem()]);
      const result = deriveCurrentActivity({
        toolSummariesByStep: new Map(),
        taskProgress: [],
        subAgentTimeline: timeline,
      });
      expect(result.statusLine).toBe('Assistant working');
      expect(result.subAgents).toMatchObject({
        runningCount: 1,
        totalCount: 1,
        completedCount: 0,
        badgeLabel: '1',
      });
    });

    it('shows count-aware text for multiple running sub-agents', () => {
      const timeline = makeTimeline([
        makeSubAgentItem({ id: 'sa-1' }),
        makeSubAgentItem({ id: 'sa-2' }),
        makeSubAgentItem({ id: 'sa-3' }),
        makeSubAgentItem({ id: 'sa-4' }),
      ]);
      const result = deriveCurrentActivity({
        toolSummariesByStep: new Map(),
        taskProgress: [],
        subAgentTimeline: timeline,
      });
      expect(result.statusLine).toBe('4 assistants working at once');
      expect(result.subAgents).toMatchObject({
        runningCount: 4,
        badgeLabel: '4',
      });
    });

    it('uses dominant activity when all agents share the same one', () => {
      const timeline = makeTimeline([
        makeSubAgentItem({ id: 'sa-1', currentActivity: 'Searching for sources' }),
        makeSubAgentItem({ id: 'sa-2', currentActivity: 'Searching for sources' }),
        makeSubAgentItem({ id: 'sa-3', currentActivity: 'Searching for sources' }),
      ]);
      const result = deriveCurrentActivity({
        toolSummariesByStep: new Map(),
        taskProgress: [],
        subAgentTimeline: timeline,
      });
      expect(result.statusLine).toBe('3 assistants searching for sources');
      expect(result.subAgents?.dominantActivity).toBe('Searching for sources');
    });

    it('shows "still working" when some agents have completed', () => {
      const timeline = makeTimeline([
        makeSubAgentItem({ id: 'sa-1', status: 'completed' }),
        makeSubAgentItem({ id: 'sa-2', status: 'completed' }),
        makeSubAgentItem({ id: 'sa-3', status: 'running' }),
        makeSubAgentItem({ id: 'sa-4', status: 'running' }),
      ]);
      const result = deriveCurrentActivity({
        toolSummariesByStep: new Map(),
        taskProgress: [],
        subAgentTimeline: timeline,
      });
      expect(result.statusLine).toBe('2 of 4 assistants still working');
      expect(result.subAgents).toMatchObject({
        runningCount: 2,
        totalCount: 4,
        completedCount: 2,
      });
    });

    it('shows "5+" badge for 5 or more running agents', () => {
      const items = Array.from({ length: 6 }, (_, i) => makeSubAgentItem({ id: `sa-${i}` }));
      const timeline = makeTimeline(items);
      const result = deriveCurrentActivity({
        toolSummariesByStep: new Map(),
        taskProgress: [],
        subAgentTimeline: timeline,
      });
      expect(result.subAgents?.badgeLabel).toBe('5+');
      expect(result.statusLine).toBe('6 assistants working at once');
    });

    it('populates subAgents even when a running tool wins the status line', () => {
      const runningTool: StepToolSummary = {
        label: 'Read file',
        status: 'running',
        toolName: 'read_file',
      } as StepToolSummary;
      const timeline = makeTimeline([
        makeSubAgentItem({ id: 'sa-1' }),
        makeSubAgentItem({ id: 'sa-2' }),
      ]);
      const result = deriveCurrentActivity({
        toolSummariesByStep: new Map([[1, [runningTool]]]),
        taskProgress: [],
        subAgentTimeline: timeline,
      });
      // Running tool wins the status line
      expect(result.statusLine).toMatch(/Reading/i);
      // But subAgents is still populated for the indicator
      expect(result.subAgents).toMatchObject({
        runningCount: 2,
        totalCount: 2,
      });
    });

    it('falls back to "working at once" when only some agents have known activity', () => {
      const timeline = makeTimeline([
        makeSubAgentItem({ id: 'sa-1', currentActivity: 'Searching for sources' }),
        makeSubAgentItem({ id: 'sa-2' }), // no activity yet
        makeSubAgentItem({ id: 'sa-3' }), // no activity yet
      ]);
      const result = deriveCurrentActivity({
        toolSummariesByStep: new Map(),
        taskProgress: [],
        subAgentTimeline: timeline,
      });
      expect(result.statusLine).toBe('3 assistants working at once');
      expect(result.subAgents?.dominantActivity).toBeUndefined();
    });

    it('returns no subAgents when all sub-agents are completed', () => {
      const timeline = makeTimeline([
        makeSubAgentItem({ id: 'sa-1', status: 'completed' }),
        makeSubAgentItem({ id: 'sa-2', status: 'completed' }),
      ]);
      const result = deriveCurrentActivity({
        toolSummariesByStep: new Map(),
        taskProgress: [],
        subAgentTimeline: timeline,
      });
      expect(result.subAgents).toBeUndefined();
    });
  });
});

describe('deriveCollapsedSummary', () => {
  it('returns paused copy when waiting for approval', () => {
    expect(deriveCollapsedSummary({
      taskProgress: [],
      currentActivity: 'Running a background task',
      isThinking: false,
      isComplete: false,
      isPaused: true,
    })).toBe('Paused — needs your approval');
  });

  it('prefers complete copy over paused copy', () => {
    expect(deriveCollapsedSummary({
      taskProgress: [],
      currentActivity: 'Running a background task',
      isThinking: false,
      isComplete: true,
      isPaused: true,
    })).toBe('Done — Running a background task');
  });

  it('returns "Connection dropped — X/Y steps completed" when transient_error wins over isComplete', () => {
    expect(deriveCollapsedSummary({
      taskProgress: [{ id: 't1', title: 'Do a thing', status: 'in_progress' } as TaskProgressItem],
      currentActivity: 'Working on it',
      isThinking: false,
      isComplete: true,
      endedWith: 'transient_error',
    })).toBe('Connection dropped — 0/1 steps completed');
  });

  it('returns bare "Connection dropped" when transient_error fires with no tasks', () => {
    expect(deriveCollapsedSummary({
      taskProgress: [],
      currentActivity: 'Working on it',
      isThinking: false,
      isComplete: true,
      endedWith: 'transient_error',
    })).toBe('Connection dropped');
  });

  it('still says "Connection dropped — X/Y steps completed" even when all tasks are completed', () => {
    expect(deriveCollapsedSummary({
      taskProgress: [
        { id: 't1', title: 'a', status: 'completed' } as TaskProgressItem,
        { id: 't2', title: 'b', status: 'completed' } as TaskProgressItem,
      ],
      currentActivity: 'Working on it',
      isThinking: false,
      isComplete: true,
      endedWith: 'transient_error',
    })).toBe('Connection dropped — 2/2 steps completed');
  });

  it('falls through to existing complete copy for endedWith="superseded"', () => {
    expect(deriveCollapsedSummary({
      taskProgress: [
        { id: 't1', title: 'a', status: 'completed' } as TaskProgressItem,
        { id: 't2', title: 'b', status: 'completed' } as TaskProgressItem,
      ],
      currentActivity: 'Working on it',
      isThinking: false,
      isComplete: true,
      endedWith: 'superseded',
    })).toBe('Done — 2/2 steps completed');
  });

  it('regression: existing branches still fire when endedWith is undefined', () => {
    expect(deriveCollapsedSummary({
      taskProgress: [
        { id: 't1', title: 'a', status: 'completed' } as TaskProgressItem,
        { id: 't2', title: 'b', status: 'in_progress' } as TaskProgressItem,
      ],
      currentActivity: 'Reading through your content',
      isThinking: true,
      isComplete: false,
    })).toBe('1/2 · Reading through your content');

    expect(deriveCollapsedSummary({
      taskProgress: [],
      currentActivity: 'Reading through your content',
      isThinking: false,
      isComplete: true,
    })).toBe('Done — Reading through your content');
  });
});

// ---------------------------------------------------------------------------
// Stage 4 — activity `source` discriminator + persona-quip fallback gating
// ---------------------------------------------------------------------------

describe('deriveCurrentActivity source discriminator (Stage 4)', () => {
  const readTool: StepToolSummary = {
    label: 'Read file',
    icon: '📄',
    tone: 'files',
    status: 'running',
    toolName: 'read_file',
  } as StepToolSummary;

  it('marks a running tool as a concrete source', () => {
    const result = deriveCurrentActivity({
      toolSummariesByStep: new Map([[1, [readTool]]]),
      taskProgress: [],
      subAgentTimeline: null,
    });
    expect(result.source).toBe('tool');
    expect(isConcreteActivitySource(result.source)).toBe(true);
  });

  it('marks the thinkingHeadline gap-filler as a NON-concrete source', () => {
    const result = deriveCurrentActivity({
      toolSummariesByStep: new Map(),
      taskProgress: [],
      subAgentTimeline: null,
      thinkingHeadline: 'Skimming your brief like a seasoned editor.',
    });
    expect(result.source).toBe('thinkingHeadline');
    expect(isConcreteActivitySource(result.source)).toBe(false);
  });

  it('marks the bare "Getting started" fallback as idle (non-concrete)', () => {
    const result = deriveCurrentActivity({
      toolSummariesByStep: new Map(),
      taskProgress: [],
      subAgentTimeline: null,
    });
    expect(result.statusLine).toBe('Getting started');
    expect(result.source).toBe('idle');
    expect(isConcreteActivitySource(result.source)).toBe(false);
  });

  it('marks an in-progress task line as a concrete source', () => {
    const taskProgress: TaskProgressItem[] = [
      { id: 't1', title: 'Draft the briefing', status: 'in_progress' } as TaskProgressItem,
    ];
    const result = deriveCurrentActivity({
      toolSummariesByStep: new Map(),
      taskProgress,
      subAgentTimeline: null,
    });
    expect(result.source).toBe('task');
    expect(isConcreteActivitySource(result.source)).toBe(true);
  });

  it('marks an errored tool as a concrete error source', () => {
    const errored: StepToolSummary = { ...readTool, status: 'error' };
    const result = deriveCurrentActivity({
      toolSummariesByStep: new Map([[1, [errored]]]),
      taskProgress: [],
      subAgentTimeline: null,
    });
    expect(result.source).toBe('error');
    expect(isConcreteActivitySource(result.source)).toBe(true);
  });
});

describe('shouldShowPersonaQuip (Stage 4 quip-fallback trigger)', () => {
  it('never shows when the turn is not thinking', () => {
    expect(shouldShowPersonaQuip({
      isThinking: false,
      activitySource: 'idle',
      activityStaticForMs: 999_999,
    })).toBe(false);
  });

  it('never shows while concrete activity is actively progressing (tool, not yet static)', () => {
    expect(shouldShowPersonaQuip({
      isThinking: true,
      activitySource: 'tool',
      activityStaticForMs: PERSONA_QUIP_LONG_WAIT_MS - 1,
    })).toBe(false);
  });

  it('never shows while sub-agents are actively progressing (not yet static)', () => {
    expect(shouldShowPersonaQuip({
      isThinking: true,
      activitySource: 'subAgents',
      activityStaticForMs: 0,
    })).toBe(false);
  });

  it('never shows while an in-progress task line is fresh (not yet static)', () => {
    expect(shouldShowPersonaQuip({
      isThinking: true,
      activitySource: 'task',
      activityStaticForMs: 5_000,
    })).toBe(false);
  });

  it('shows immediately in a genuine idle gap', () => {
    expect(shouldShowPersonaQuip({
      isThinking: true,
      activitySource: 'idle',
      activityStaticForMs: 0,
    })).toBe(true);
  });

  it('shows long-wait reassurance once a concrete line has been static past the threshold (DA SHOULD-4)', () => {
    expect(shouldShowPersonaQuip({
      isThinking: true,
      activitySource: 'tool',
      activityStaticForMs: PERSONA_QUIP_LONG_WAIT_MS,
    })).toBe(true);
  });

  it('does NOT show on a headline line until the long-wait threshold', () => {
    expect(shouldShowPersonaQuip({
      isThinking: true,
      activitySource: 'thinkingHeadline',
      activityStaticForMs: PERSONA_QUIP_LONG_WAIT_MS - 1,
    })).toBe(false);
  });

  it('shows on a headline line once it has been static past the threshold', () => {
    expect(shouldShowPersonaQuip({
      isThinking: true,
      activitySource: 'thinkingHeadline',
      activityStaticForMs: PERSONA_QUIP_LONG_WAIT_MS,
    })).toBe(true);
  });
});
