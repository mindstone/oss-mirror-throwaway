import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  createInitialLiveTurnState,
  createStartedLiveTurnState,
  reduceLiveTurnState,
  shouldSuppressStatus,
  truncateToolDetail,
} from '../live';
import type { LiveTurnState, ReducerEnvelope } from '../types';

const env = (turnId: string | null = 'turn-1', now = 1_000): ReducerEnvelope => ({ sessionId: 'session-1', turnId, now });
const ev = (event: Record<string, unknown>): AgentEvent => event as unknown as AgentEvent;
const reduce = (state: LiveTurnState, event: AgentEvent, now = 1_000) =>
  reduceLiveTurnState(state, event, env(state.activeTurnId ?? 'turn-1', now));

describe('reduceLiveTurnState — dispatch by event type', () => {
  it.each([
    ['turn_started', ev({ type: 'turn_started', timestamp: 1 }), 'activeTurnId'],
    ['status', ev({ type: 'status', message: 'Working', timestamp: 1 }), 'statusText'],
    ['assistant_delta', ev({ type: 'assistant_delta', text: 'Hel', timestamp: 1 }), 'streamingText'],
    ['assistant', ev({ type: 'assistant', text: 'Hello', timestamp: 1 }), 'streamingText'],
    ['thinking_delta', ev({ type: 'thinking_delta', text: 'x', timestamp: 1 }), 'statusText'],
    ['tool-start', ev({ type: 'tool', stage: 'start', toolName: 'Search', detail: 'q', timestamp: 1 }), 'currentTool'],
    ['tool-end', ev({ type: 'tool', stage: 'end', toolName: 'Search', detail: 'ok', timestamp: 1 }), 'completedSteps'],
    ['result', ev({ type: 'result', text: 'Done', timestamp: 1 }), 'isSending'],
    ['error', ev({ type: 'error', error: 'Boom', timestamp: 1 }), 'error'],
    ['user_question', ev({ type: 'user_question', batchId: 'b1', question: 'Proceed?', options: [], timestamp: 1 }), 'userQuestionEventsByTurn'],
    ['user_question_answered', ev({ type: 'user_question_answered', batchId: 'b2', answer: 'yes', timestamp: 1 }), 'userQuestionEventsByTurn'],
    ['warning', ev({ type: 'warning', message: 'Careful', timestamp: 1 }), 'unchanged'],
    ['user_message', ev({ type: 'user_message', text: 'Hi', timestamp: 1 }), 'unchanged'],
    ['context_overflow', ev({ type: 'context_overflow', message: 'Too much', timestamp: 1 }), 'unchanged'],
    ['recovery:started', ev({ type: 'recovery:started', phase: 'post_activity', timestamp: 1 }), 'unchanged'],
    ['recovery:fallback_attempting', ev({ type: 'recovery:fallback_attempting', target: { kind: 'model', modelName: 'Opus' }, timestamp: 1 }), 'unchanged'],
    ['recovery:fallback_succeeded', ev({ type: 'recovery:fallback_succeeded', target: { kind: 'model', modelName: 'Opus' }, timestamp: 1 }), 'unchanged'],
    ['recovery:compacting', ev({ type: 'recovery:compacting', timestamp: 1 }), 'unchanged'],
    ['recovery:summary_ready', ev({ type: 'recovery:summary_ready', summary: 'Summary', timestamp: 1 }), 'unchanged'],
    ['recovery:retrying', ev({ type: 'recovery:retrying', timestamp: 1 }), 'unchanged'],
    ['recovery:skeleton_attempting', ev({ type: 'recovery:skeleton_attempting', timestamp: 1 }), 'unchanged'],
    ['recovery:depth4_attempting', ev({ type: 'recovery:depth4_attempting', profileId: 'profile-1', modelName: 'Opus', costEstimate: 'high', timestamp: 1 }), 'unchanged'],
    ['recovery:succeeded', ev({ type: 'recovery:succeeded', finalDepth: 3, totalDurationMs: 1000, timestamp: 1 }), 'unchanged'],
    ['recovery:failed', ev({ type: 'recovery:failed', error: 'Nope', exhaustedReason: 'depth_limit_reached', timestamp: 1 }), 'unchanged'],
    ['recovery:last_resort_skipped', ev({ type: 'recovery:last_resort_skipped', reason: 'no_qualifying_profile', userFacingTitle: 'No recovery model', userFacingMessage: 'Choose one.', action: 'Open settings', timestamp: 1 }), 'unchanged'],
  ])('handles %s', (_name, event, field) => {
    const initial = field === 'result' || field === 'error' ? createStartedLiveTurnState() : createInitialLiveTurnState();
    const { state } = reduceLiveTurnState(initial, event, env('turn-1', 10));
    if (field === 'activeTurnId') expect(state.activeTurnId).toBe('turn-1');
    if (field === 'statusText') expect(state.statusText).toBeTruthy();
    if (field === 'streamingText') expect(state.streamingText).toBeTruthy();
    if (field === 'currentTool') expect(state.currentTool?.toolName).toBe('Search');
    if (field === 'completedSteps') expect(state.completedSteps).toHaveLength(1);
    if (field === 'isSending') expect(state.isSending).toBe(false);
    if (field === 'error') expect(state.error).toBe('Boom');
    if (field === 'userQuestionEventsByTurn') expect(state.userQuestionEventsByTurn['turn-1']).toHaveLength(1);
    if (field === 'unchanged') expect(state).toBe(initial);
  });

  it('emits a log effect for unknown events without changing state', () => {
    const initial = createInitialLiveTurnState();
    const { state, effects } = reduceLiveTurnState(initial, { type: 'unknown_event', timestamp: 1 } as unknown as AgentEvent, env());
    expect(state).toBe(initial);
    expect(effects).toContainEqual(expect.objectContaining({ kind: 'log', level: 'debug' }));
  });
});

describe('reduceLiveTurnState — tool lifecycle', () => {
  it('starts a tool and clears streaming text', () => {
    const initial = { ...createStartedLiveTurnState(), streamingText: 'partial' };
    const { state } = reduce(initial, ev({ type: 'tool', stage: 'start', toolName: 'Read', detail: 'abc', timestamp: 1 }));
    expect(state.currentTool).toMatchObject({ toolName: 'Read', detail: 'abc' });
    expect(state.streamingText).toBe('');
    expect(state.statusText).toBe('Using Read...');
  });

  it('ends the current tool into completedSteps', () => {
    const started = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'start', toolName: 'Read', detail: 'input', toolUseId: 't1', timestamp: 1 })).state;
    const { state } = reduce(started, ev({ type: 'tool', stage: 'end', toolName: 'Read', detail: 'output', toolUseId: 't1', timestamp: 2 }), 2_000);
    expect(state.currentTool).toBeNull();
    expect(state.completedSteps).toEqual([expect.objectContaining({ label: 'Read', detail: 'input', toolUseId: 't1', timestamp: 2_000 })]);
  });

  it('flushes an overlapping tool start', () => {
    const first = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'start', toolName: 'A', timestamp: 1 })).state;
    const second = reduce(first, ev({ type: 'tool', stage: 'start', toolName: 'B', timestamp: 2 }), 2_000).state;
    expect(second.completedSteps).toEqual([expect.objectContaining({ toolName: 'A' })]);
    expect(second.currentTool?.toolName).toBe('B');
  });

  it('handles an end without a prior start', () => {
    const { state } = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'end', toolName: 'NoStart', timestamp: 1 }));
    expect(state.completedSteps[0].toolName).toBe('NoStart');
  });

  it('keeps start detail over end detail', () => {
    const started = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'start', toolName: 'Read', detail: 'start-detail', timestamp: 1 })).state;
    const ended = reduce(started, ev({ type: 'tool', stage: 'end', toolName: 'Read', detail: 'end-detail', timestamp: 2 })).state;
    expect(ended.completedSteps[0].detail).toBe('start-detail');
  });

  it('preserves isError and toolUseId on completion', () => {
    const started = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'start', toolName: 'Run', isError: true, toolUseId: 'tool-1', timestamp: 1 })).state;
    const ended = reduce(started, ev({ type: 'tool', stage: 'end', toolName: 'Run', timestamp: 2 })).state;
    expect(ended.completedSteps[0]).toMatchObject({ isError: true, toolUseId: 'tool-1' });
  });

  it('truncates tool detail to the cloud preview length', () => {
    const long = 'x'.repeat(700);
    expect(truncateToolDetail(long)).toHaveLength(500);
    const { state } = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'start', toolName: 'Read', detail: long, timestamp: 1 }));
    expect(state.currentTool?.detail).toHaveLength(500);
  });

  it('emits no completed step for nameless tool end', () => {
    const { state } = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'end', timestamp: 1 }));
    expect(state.completedSteps).toHaveLength(0);
  });
});

describe('reduceLiveTurnState — mission and task tracking', () => {
  const taskSnapshot = JSON.stringify({ tasks: [{ id: 'task-1', title: 'Draft', status: 'pending' }] });

  it.each([
    ['MissionSet start', { type: 'tool', stage: 'start', toolName: 'MissionSet', detail: JSON.stringify({ goal: 'Ship' }), timestamp: 1 }, (state: LiveTurnState) => expect(state.missionContext?.goal).toBe('Ship')],
    ['MissionSet end', { type: 'tool', stage: 'end', toolName: 'MissionSet', detail: JSON.stringify({ mission: { goal: 'Land' } }), timestamp: 1 }, (state: LiveTurnState) => expect(state.missionContext?.goal).toBe('Land')],
    ['TaskList end', { type: 'tool', stage: 'end', toolName: 'TaskList', detail: taskSnapshot, timestamp: 1 }, (state: LiveTurnState) => expect(state.taskProgress).toHaveLength(1)],
    ['TaskCreate end', { type: 'tool', stage: 'end', toolName: 'TaskCreate', detail: JSON.stringify({ task: { id: 'task-2', title: 'Create', status: 'pending' }, tasks: [{ id: 'task-2', title: 'Create', status: 'pending' }] }), timestamp: 1 }, (state: LiveTurnState) => expect(state.touchedTaskIds).toEqual(['task-2'])],
    ['TaskUpdate end', { type: 'tool', stage: 'end', toolName: 'TaskUpdate', detail: JSON.stringify({ task: { id: 'task-3', title: 'Update', status: 'completed' }, tasks: [{ id: 'task-3', title: 'Update', status: 'completed' }] }), timestamp: 1 }, (state: LiveTurnState) => expect(state.touchedTaskIds).toEqual(['task-3'])],
    ['TodoWrite start', { type: 'tool', stage: 'start', toolName: 'TodoWrite', detail: JSON.stringify({ todos: [{ id: 'todo-1', content: 'Todo', status: 'in_progress' }] }), timestamp: 1 }, (state: LiveTurnState) => expect(state.taskProgress[0].id).toBe('todo-1')],
  ] as const)('%s updates live state', (_name, event, assertion) => {
    assertion(reduce(createStartedLiveTurnState(), ev(event)).state);
  });

  it('suppresses TodoWrite after TaskList snapshot', () => {
    const afterSnapshot = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'end', toolName: 'TaskList', detail: taskSnapshot, timestamp: 1 })).state;
    const afterTodo = reduce(afterSnapshot, ev({ type: 'tool', stage: 'start', toolName: 'TodoWrite', detail: JSON.stringify({ todos: [{ id: 'todo-2', content: 'Wrong', status: 'completed' }] }), timestamp: 2 })).state;
    expect(afterTodo.taskProgress).toBe(afterSnapshot.taskProgress);
  });

  it('deduplicates touched task IDs', () => {
    const event = ev({ type: 'tool', stage: 'end', toolName: 'TaskUpdate', detail: JSON.stringify({ task: { id: 'task-1' }, tasks: [{ id: 'task-1', title: 'A', status: 'pending' }] }), timestamp: 1 });
    const once = reduce(createStartedLiveTurnState(), event).state;
    const twice = reduce(once, event).state;
    expect(twice.touchedTaskIds).toEqual(['task-1']);
  });

  it('snapshots mission and tasks on result', () => {
    const withMission = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'start', toolName: 'MissionSet', detail: JSON.stringify({ goal: 'Ship' }), timestamp: 1 })).state;
    const { state, effects } = reduce(withMission, ev({ type: 'result', text: 'Done', timestamp: 2 }));
    expect(state.missionContext).toBeNull();
    expect(effects).toContainEqual(expect.objectContaining({ kind: 'snapshot-mission-task', hasMissionSet: true }));
  });

  it('clears task progress on terminal error', () => {
    const withTasks = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'end', toolName: 'TaskList', detail: taskSnapshot, timestamp: 1 })).state;
    const errored = reduce(withTasks, ev({ type: 'error', error: 'Boom', timestamp: 2 })).state;
    expect(errored.taskProgress).toEqual([]);
  });

  it('tracks all TodoWrite IDs as touched for delta display', () => {
    const detail = JSON.stringify({ todos: [{ id: 'a', content: 'A', status: 'pending' }, { id: 'b', content: 'B', status: 'in_progress' }] });
    const { state } = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'start', toolName: 'TodoWrite', detail, timestamp: 1 }));
    expect(state.touchedTaskIds).toEqual(['a', 'b']);
  });

  it('ignores unknown mission tool names', () => {
    const initial = createStartedLiveTurnState();
    const { state } = reduce(initial, ev({ type: 'tool', stage: 'start', toolName: 'Other', detail: JSON.stringify({ goal: 'Nope' }), timestamp: 1 }));
    expect(state.missionContext).toBeNull();
    expect(state.taskProgress).toBe(initial.taskProgress);
  });
});

describe('reduceLiveTurnState — sub-agent tracking', () => {
  it('adds a Task sub-agent on start', () => {
    const { state } = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'start', toolName: 'Task', toolUseId: 'sa1', detail: JSON.stringify({ subagent_type: 'reviewer-gpt5.5-high', description: 'Review it' }), timestamp: 1 }));
    expect(state.subAgentItems[0]).toMatchObject({ toolUseId: 'sa1', label: 'Reviewer Gpt5.5 High', status: 'running', isBackground: false });
  });

  it('adds an Agent sub-agent on start', () => {
    const { state } = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'start', toolName: 'Agent', toolUseId: 'sa2', detail: JSON.stringify({ agent: 'background-worker', prompt: 'Do work' }), timestamp: 1 }));
    expect(state.subAgentItems[0]).toMatchObject({ label: 'Background Worker', subagentType: 'background-worker' });
  });

  it('supports MCP-namespaced sub-agent tools', () => {
    const { state } = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'start', toolName: 'mcp_server/Task', toolUseId: 'sa3', detail: '{}', timestamp: 1 }));
    expect(state.subAgentItems).toHaveLength(1);
  });

  it('marks sub-agent completed on end', () => {
    const started = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'start', toolName: 'Task', toolUseId: 'sa4', timestamp: 1 }), 1_000).state;
    const ended = reduce(started, ev({ type: 'tool', stage: 'end', toolName: 'Task', toolUseId: 'sa4', detail: 'Done', timestamp: 2 }), 2_500).state;
    expect(ended.subAgentItems[0]).toMatchObject({ status: 'completed', result: 'Done', durationMs: 1_500 });
  });

  it.each(['Async agent launched successfully', 'Agent is working in the background'])('marks background ack: %s', (detail) => {
    const started = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'start', toolName: 'Agent', toolUseId: 'bg', timestamp: 1 })).state;
    const ended = reduce(started, ev({ type: 'tool', stage: 'end', toolName: 'Agent', toolUseId: 'bg', detail, timestamp: 2 })).state;
    expect(ended.subAgentItems[0]).toMatchObject({ status: 'running', isBackground: true });
    expect(ended.subAgentItems[0].completedAt).toBeUndefined();
  });

  it('tracks concurrent agents independently', () => {
    const first = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'start', toolName: 'Task', toolUseId: 'a', detail: JSON.stringify({ subagent_type: 'planner' }), timestamp: 1 })).state;
    const second = reduce(first, ev({ type: 'tool', stage: 'start', toolName: 'Task', toolUseId: 'b', detail: JSON.stringify({ subagent_type: 'implementer' }), timestamp: 2 })).state;
    const ended = reduce(second, ev({ type: 'tool', stage: 'end', toolName: 'Task', toolUseId: 'a', detail: 'done', timestamp: 3 })).state;
    expect(ended.subAgentItems.map(item => item.status)).toEqual(['completed', 'running']);
  });

  it('preserves sub-agents after result', () => {
    const started = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'start', toolName: 'Task', toolUseId: 'sa', timestamp: 1 })).state;
    const { state } = reduce(started, ev({ type: 'result', text: 'Done', timestamp: 2 }));
    expect(state.subAgentItems).toBe(started.subAgentItems);
  });
});

describe('reduceLiveTurnState — terminal events', () => {
  it('result clears active turn state and emits terminal refresh', () => {
    const started = { ...createStartedLiveTurnState(), activeTurnId: 'turn-1', statusText: 'Working' };
    const { state, effects } = reduceLiveTurnState(started, ev({ type: 'result', text: 'Done', timestamp: 1 }), env('turn-1'));
    expect(state).toMatchObject({ isSending: false, activeTurnId: null, statusText: null, receivedTerminal: true });
    expect(effects).toContainEqual(expect.objectContaining({ kind: 'terminal-refresh', sessionId: 'session-1' }));
  });

  it('error clears active turn state and stores raw message', () => {
    const started = { ...createStartedLiveTurnState(), activeTurnId: 'turn-1', statusText: 'Working' };
    const { state } = reduceLiveTurnState(started, ev({ type: 'error', error: 'Nope', timestamp: 1 }), env('turn-1'));
    expect(state).toMatchObject({ isSending: false, activeTurnId: null, statusText: null, error: 'Nope' });
  });

  it('uses fallback error copy for empty error strings', () => {
    const { state } = reduceLiveTurnState(createStartedLiveTurnState(), ev({ type: 'error', error: '', timestamp: 1 }), env('turn-1'));
    expect(state.error).toBe('Something went wrong');
  });

  it('delegates error humanization when supplied', () => {
    const { state } = reduceLiveTurnState(createStartedLiveTurnState(), ev({ type: 'error', error: 'raw', errorKind: 'rate_limit', timestamp: 1 }), env('turn-1'), { humanizeError: ({ errorKind }) => `human:${errorKind}` });
    expect(state.error).toBe('human:rate_limit');
  });

  it('late result for old turn does not clear the new active turn', () => {
    const current = { ...createStartedLiveTurnState(), activeTurnId: 'turn-2' };
    const { state } = reduceLiveTurnState(current, ev({ type: 'result', text: 'Old done', turnId: 'turn-1', timestamp: 1 }), env('turn-2'));
    expect(state.activeTurnId).toBe('turn-2');
    expect(state.isSending).toBe(true);
  });

  it('late error for old turn does not clear the new active turn', () => {
    const current = { ...createStartedLiveTurnState(), activeTurnId: 'turn-2' };
    const { state } = reduceLiveTurnState(current, ev({ type: 'error', error: 'old', turnId: 'turn-1', timestamp: 1 }), env('turn-2'));
    expect(state.activeTurnId).toBe('turn-2');
    expect(state.isSending).toBe(true);
    expect(state.error).toBe('old');
  });

  it('snapshots completed steps before terminal refresh', () => {
    const withStep = reduce(createStartedLiveTurnState(), ev({ type: 'tool', stage: 'end', toolName: 'Read', timestamp: 1 })).state;
    const { effects } = reduce(withStep, ev({ type: 'result', text: 'Done', timestamp: 2 }));
    expect(effects.map(effect => effect.kind)).toEqual(expect.arrayContaining(['snapshot-completed-steps', 'terminal-refresh']));
    expect(effects.findIndex(effect => effect.kind === 'snapshot-completed-steps')).toBeLessThan(effects.findIndex(effect => effect.kind === 'terminal-refresh'));
  });

  it('does not snapshot empty completed steps', () => {
    const { effects } = reduce(createStartedLiveTurnState(), ev({ type: 'result', text: 'Done', timestamp: 1 }));
    expect(effects.some(effect => effect.kind === 'snapshot-completed-steps')).toBe(false);
  });
});

describe('reduceLiveTurnState — status and streaming', () => {
  it('filters suppressed status messages', () => {
    expect(shouldSuppressStatus('Agent initialized with model x')).toBe(true);
    const initial = createStartedLiveTurnState();
    expect(reduce(initial, ev({ type: 'status', message: 'Agent initialized with model x', timestamp: 1 })).state).toBe(initial);
  });

  it('allows ordinary status messages', () => {
    const { state } = reduce(createStartedLiveTurnState(), ev({ type: 'status', message: 'Processing', timestamp: 1 }));
    expect(state.statusText).toBe('Processing');
  });

  it('translates machine-encoded parallel status banners for display', () => {
    const { state } = reduce(
      createStartedLiveTurnState(),
      ev({ type: 'status', message: 'parallel:subagents:start:{"requested":6,"cap":4}', timestamp: 1 }),
    );
    expect(state.statusText).toBe('Running 6 parallel tasks (cap 4)…');
  });

  it('translates parallel:subagents:progress for display', () => {
    const withStartBanner = reduce(
      createStartedLiveTurnState(),
      ev({ type: 'status', message: 'parallel:subagents:start:{"requested":6,"cap":4}', timestamp: 1 }),
    ).state;

    const { state } = reduce(
      withStartBanner,
      ev({
        type: 'status',
        message: 'parallel:subagents:progress:{"running":3,"succeeded":2,"failed":1,"pending":0}',
        timestamp: 2,
      }),
      2_000,
    );

    expect(state.statusText).toBe('Running 6 parallel tasks (cap 4)…');
  });

  it('translates parallel:subagents:complete for display', () => {
    const { state } = reduce(
      createStartedLiveTurnState(),
      ev({
        type: 'status',
        message: 'parallel:subagents:complete:{"requested":6,"succeeded":4,"failed":1,"aborted":1,"durationMs":2300}',
        timestamp: 1,
      }),
    );
    expect(state.statusText).toBe('Finished 5 of 6 parallel tasks (1 failed, 1 aborted).');
  });

  it('suppresses malformed machine-encoded parallel statuses instead of showing raw payloads', () => {
    const initial = createStartedLiveTurnState();
    const { state } = reduce(
      initial,
      ev({ type: 'status', message: 'parallel:subagents:start:{not-json', timestamp: 1 }),
    );
    expect(state).toBe(initial);
  });

  it('translates task recovery status banners for display', () => {
    const { state } = reduce(
      createStartedLiveTurnState(),
      ev({ type: 'status', message: 'task:recovery:orphans-marked:{"count":2}', timestamp: 1 }),
    );
    expect(state.statusText).toBe('Recovered 2 interrupted tasks.');
  });

  it('appends assistant deltas in order', () => {
    const a = reduce(createStartedLiveTurnState(), ev({ type: 'assistant_delta', text: 'Hel', timestamp: 1 })).state;
    const b = reduce(a, ev({ type: 'assistant_delta', text: 'lo', timestamp: 2 })).state;
    expect(b.streamingText).toBe('Hello');
  });

  it('assistant replaces streaming text', () => {
    const initial = { ...createStartedLiveTurnState(), streamingText: 'partial' };
    const { state } = reduce(initial, ev({ type: 'assistant', text: 'full', timestamp: 1 }));
    expect(state.streamingText).toBe('full');
  });

  it('thinking delta sets a thinking status', () => {
    expect(reduce(createStartedLiveTurnState(), ev({ type: 'thinking_delta', text: 'x', timestamp: 1 })).state.statusText).toBe('Thinking...');
  });

  it('assistant delta clears status', () => {
    const initial = { ...createStartedLiveTurnState(), statusText: 'Working' };
    expect(reduce(initial, ev({ type: 'assistant_delta', text: 'x', timestamp: 1 })).state.statusText).toBeNull();
  });
});

describe('reduceLiveTurnState — user questions', () => {
  it('appends user question by envelope turn id', () => {
    const { state } = reduce(createStartedLiveTurnState(), ev({ type: 'user_question', batchId: 'b1', question: 'Q?', options: [], timestamp: 1 }));
    expect(state.userQuestionEventsByTurn['turn-1']).toHaveLength(1);
  });

  it('appends user question answered by event turn id fallback', () => {
    const { state } = reduceLiveTurnState(createStartedLiveTurnState(), ev({ type: 'user_question_answered', batchId: 'b2', answer: 'A', turnId: 'turn-x', timestamp: 1 }), env(null));
    expect(state.userQuestionEventsByTurn['turn-x']).toHaveLength(1);
  });

  it('deduplicates user questions by batch id and type', () => {
    const question = ev({ type: 'user_question', batchId: 'b1', question: 'Q?', options: [], timestamp: 1 });
    const once = reduce(createStartedLiveTurnState(), question).state;
    const twice = reduce(once, question).state;
    expect(twice.userQuestionEventsByTurn).toBe(once.userQuestionEventsByTurn);
  });

  it('ignores user question events without a turn id', () => {
    const initial = createStartedLiveTurnState();
    const { state } = reduceLiveTurnState(initial, ev({ type: 'user_question', batchId: 'b1', question: 'Q?', options: [], timestamp: 1 }), env(null));
    expect(state).toBe(initial);
  });
});

describe('reduceLiveTurnState — warning/user_message and late events', () => {
  it.each([
    ev({ type: 'warning', message: 'Careful', timestamp: 1 }),
    ev({ type: 'user_message', text: 'Hi', timestamp: 1 }),
    ev({ type: 'context_overflow', message: 'overflow', timestamp: 1 }),
    ev({ type: 'compaction_started', timestamp: 1 }),
    ev({ type: 'recovery:started', phase: 'post_activity', timestamp: 1 }),
    ev({ type: 'recovery:failed', error: 'Nope', exhaustedReason: 'depth_limit_reached', timestamp: 1 }),
  ])('does not mutate live state for %s', (event) => {
    const initial = createStartedLiveTurnState();
    expect(reduce(initial, event).state).toBe(initial);
  });

  it('late status after result does not restart sending', () => {
    const terminal = reduce(createStartedLiveTurnState(), ev({ type: 'result', text: 'Done', timestamp: 1 })).state;
    const next = reduce(terminal, ev({ type: 'status', message: 'late', timestamp: 2 })).state;
    expect(next.isSending).toBe(false);
  });

  it('double turn_started keeps the latest turn id', () => {
    const first = reduceLiveTurnState(createStartedLiveTurnState(), ev({ type: 'turn_started', turnId: 'a', timestamp: 1 }), env(null)).state;
    const second = reduceLiveTurnState(first, ev({ type: 'turn_started', turnId: 'b', timestamp: 2 }), env('a')).state;
    expect(second.activeTurnId).toBe('b');
  });
});

describe('reduceLiveTurnState — reference equality', () => {
  it.each([
    ['completedSteps on thinking_delta', 'completedSteps', ev({ type: 'thinking_delta', text: 'x', timestamp: 1 })],
    ['subAgentItems on status', 'subAgentItems', ev({ type: 'status', message: 'Working', timestamp: 1 })],
    ['taskProgress on assistant_delta', 'taskProgress', ev({ type: 'assistant_delta', text: 'x', timestamp: 1 })],
    ['missionContext on assistant_delta', 'missionContext', ev({ type: 'assistant_delta', text: 'x', timestamp: 1 })],
    ['touchedTaskIds on assistant', 'touchedTaskIds', ev({ type: 'assistant', text: 'Hello', timestamp: 1 })],
    ['userQuestionEventsByTurn on status', 'userQuestionEventsByTurn', ev({ type: 'status', message: 'Working', timestamp: 1 })],
    ['completedSteps on result', 'completedSteps', ev({ type: 'result', text: 'Done', timestamp: 1 })],
    ['subAgentItems on result', 'subAgentItems', ev({ type: 'result', text: 'Done', timestamp: 1 })],
    ['taskProgress empty array on result', 'taskProgress', ev({ type: 'result', text: 'Done', timestamp: 1 })],
    ['completedSteps on user_question', 'completedSteps', ev({ type: 'user_question', batchId: 'b', question: 'Q?', options: [], timestamp: 1 })],
    ['subAgentItems on user_question', 'subAgentItems', ev({ type: 'user_question', batchId: 'b', question: 'Q?', options: [], timestamp: 1 })],
  ] as const)('preserves %s', (_name, key, event) => {
    const previous = createStartedLiveTurnState();
    const { state } = reduce(previous, event);
    expect(state[key]).toBe(previous[key]);
  });
});

describe('shouldSuppressStatus', () => {
  it('does not suppress new watchdog judge status strings', () => {
    const strings = [
      'Still working on this — running a quick time check…',
      'Looks like genuine progress. Continuing for another 15 minutes.',
      'Continuing for another 15 minutes (automation budget: 45 minutes left).',
      'Time check didn\'t come back. Granting another 10 minutes anyway — you can stop at any time.',
      'This turn went silent for over 45 minutes and was stopped automatically. Try sending the message again.',
      'Couldn\'t reach the time check after several attempts. Stopping this turn — you can try sending the message again.',
      'Stopped that tool — continuing with your request.',
      'This tool kept getting stuck, so this turn was stopped automatically. Try sending the message again.',
      'This tool couldn\'t be stopped cleanly, so this turn was stopped automatically. Try sending the message again.',
      'Automation turn reached its 90-minute limit and was stopped.',
    ];
    for (const s of strings) {
      expect(shouldSuppressStatus(s)).toBe(false);
    }
  });
});

