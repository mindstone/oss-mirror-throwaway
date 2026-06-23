import { describe, expect, it } from 'vitest';
import {
  parseIndividualTaskIdFromDetail,
  parseTasksFromDetail,
  parseTodosFromDetail,
  computeTurnTaskDelta,
  computeTaskDisplayProps,
} from '../missionTaskExtraction';
import type { TaskProgressItem, MissionContext } from '../missionTaskExtraction';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const task = (
  id: string,
  status: TaskProgressItem['status'] = 'pending',
  title = `Task ${id}`,
): TaskProgressItem => ({ id, title, status });

const mission: MissionContext = {
  goal: 'Ship the feature',
  doneCriteria: 'All tests pass',
  constraints: 'No breaking changes',
};

// ---------------------------------------------------------------------------
// parseIndividualTaskIdFromDetail
// ---------------------------------------------------------------------------

describe('parseIndividualTaskIdFromDetail', () => {
  it('extracts task id from valid detail', () => {
    const detail = JSON.stringify({
      summary: 'Task #1 created',
      task: { id: 'task-1', title: 'Do something', status: 'pending' },
      tasks: [{ id: 'task-1' }, { id: 'task-2' }],
    });
    expect(parseIndividualTaskIdFromDetail(detail)).toBe('task-1');
  });

  it('returns null when task field is missing', () => {
    const detail = JSON.stringify({ summary: 'no task here', tasks: [] });
    expect(parseIndividualTaskIdFromDetail(detail)).toBeNull();
  });

  it('returns null when task is not an object', () => {
    const detail = JSON.stringify({ task: 'not-an-object' });
    expect(parseIndividualTaskIdFromDetail(detail)).toBeNull();
  });

  it('returns null when task is null', () => {
    const detail = JSON.stringify({ task: null });
    expect(parseIndividualTaskIdFromDetail(detail)).toBeNull();
  });

  it('returns null when task.id is not a string (number)', () => {
    const detail = JSON.stringify({ task: { id: 42, title: 'Numbered' } });
    expect(parseIndividualTaskIdFromDetail(detail)).toBeNull();
  });

  it('returns null when task.id is empty string', () => {
    const detail = JSON.stringify({ task: { id: '', title: 'Empty ID' } });
    expect(parseIndividualTaskIdFromDetail(detail)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseIndividualTaskIdFromDetail('{bad json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseIndividualTaskIdFromDetail('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseTasksFromDetail — description, notes, blockers extraction
// ---------------------------------------------------------------------------

describe('parseTasksFromDetail: description, notes, blockers', () => {
  it('extracts all optional detail fields from TaskList', () => {
    const detail = JSON.stringify({
      tasks: [
        {
          id: 'task-1',
          title: 'Design the API',
          status: 'in_progress',
          description: 'Create REST endpoints for the user service',
          notes: 'Consider pagination for list endpoints',
          blockers: ['task-0'],
        },
      ],
    });
    const result = parseTasksFromDetail(detail, 'TaskList');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'task-1',
      title: 'Design the API',
      status: 'in_progress',
      priority: undefined,
      description: 'Create REST endpoints for the user service',
      notes: 'Consider pagination for list endpoints',
      blockers: ['task-0'],
    });
  });

  it('omits description/notes/blockers when missing', () => {
    const detail = JSON.stringify({
      tasks: [
        { id: 'task-1', title: 'Simple task', status: 'pending' },
      ],
    });
    const result = parseTasksFromDetail(detail, 'TaskList');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'task-1',
      title: 'Simple task',
      status: 'pending',
      priority: undefined,
    });
    expect('description' in result[0]).toBe(false);
    expect('notes' in result[0]).toBe(false);
    expect('blockers' in result[0]).toBe(false);
  });

  it('omits empty string description and notes', () => {
    const detail = JSON.stringify({
      tasks: [
        { id: 'task-1', title: 'Task', status: 'pending', description: '', notes: '  ' },
      ],
    });
    const result = parseTasksFromDetail(detail, 'TaskList');
    expect(result).toHaveLength(1);
    expect('description' in result[0]).toBe(false);
    expect('notes' in result[0]).toBe(false);
  });

  it('omits empty blockers array', () => {
    const detail = JSON.stringify({
      tasks: [
        { id: 'task-1', title: 'Task', status: 'pending', blockers: [] },
      ],
    });
    const result = parseTasksFromDetail(detail, 'TaskList');
    expect(result).toHaveLength(1);
    expect('blockers' in result[0]).toBe(false);
  });

  it('extracts parallelGroup from TaskList tasks', () => {
    const detail = JSON.stringify({
      tasks: [
        { id: 'r1', title: 'Lookup A', status: 'in_progress', parallelGroup: 'research_wave' },
        { id: 'r2', title: 'Lookup B', status: 'pending', parallelGroup: 'research_wave' },
        { id: 's1', title: 'Synthesise', status: 'pending' },
      ],
    });
    const result = parseTasksFromDetail(detail, 'TaskList');
    expect(result).toHaveLength(3);
    expect(result[0].parallelGroup).toBe('research_wave');
    expect(result[1].parallelGroup).toBe('research_wave');
    expect('parallelGroup' in result[2]).toBe(false);
  });

  it('omits empty/whitespace parallelGroup', () => {
    const detail = JSON.stringify({
      tasks: [
        { id: 'task-1', title: 'Task', status: 'pending', parallelGroup: '' },
        { id: 'task-2', title: 'Task', status: 'pending', parallelGroup: '   ' },
      ],
    });
    const result = parseTasksFromDetail(detail, 'TaskList');
    expect(result).toHaveLength(2);
    expect('parallelGroup' in result[0]).toBe(false);
    expect('parallelGroup' in result[1]).toBe(false);
  });

  it('filters non-string elements from blockers', () => {
    const detail = JSON.stringify({
      tasks: [
        { id: 'task-1', title: 'Task', status: 'blocked', blockers: ['task-0', 42, null, 'task-2', true] },
      ],
    });
    const result = parseTasksFromDetail(detail, 'TaskList');
    expect(result).toHaveLength(1);
    expect(result[0].blockers).toEqual(['task-0', 'task-2']);
  });

  it('omits blockers when all elements are non-string', () => {
    const detail = JSON.stringify({
      tasks: [
        { id: 'task-1', title: 'Task', status: 'blocked', blockers: [42, null, true] },
      ],
    });
    const result = parseTasksFromDetail(detail, 'TaskList');
    expect(result).toHaveLength(1);
    expect('blockers' in result[0]).toBe(false);
  });

  it('does not extract detail fields from TodoWrite events', () => {
    const detail = JSON.stringify({
      todos: [
        {
          id: 'todo-1',
          content: 'Write tests',
          status: 'pending',
          description: 'This should be ignored',
          notes: 'This too',
          blockers: ['something'],
        },
      ],
    });
    const result = parseTasksFromDetail(detail, 'TodoWrite');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'todo-1',
      title: 'Write tests',
      status: 'pending',
      priority: undefined,
    });
    expect('description' in result[0]).toBe(false);
    expect('notes' in result[0]).toBe(false);
    expect('blockers' in result[0]).toBe(false);
  });

  it('extracts detail fields from TaskCreate events (has tasks snapshot)', () => {
    const detail = JSON.stringify({
      task: { id: 'task-new', title: 'New task', status: 'pending' },
      tasks: [
        { id: 'task-1', title: 'Existing', status: 'completed', description: 'Done already' },
        { id: 'task-new', title: 'New task', status: 'pending', notes: 'Just created' },
      ],
    });
    const result = parseTasksFromDetail(detail, 'TaskCreate');
    expect(result).toHaveLength(2);
    expect(result[0].description).toBe('Done already');
    expect('notes' in result[0]).toBe(false);
    expect(result[1].notes).toBe('Just created');
    expect('description' in result[1]).toBe(false);
  });

  it('retains main-agent SummarizeResult tasks (no orchestration kind)', () => {
    const detail = JSON.stringify({
      tasks: [
        {
          id: 'task-main-summary',
          title: 'Result Summary',
          owner: 'main',
          status: 'completed',
          notes: 'Main agent summary should stay visible',
        },
      ],
    });

    const result = parseTasksFromDetail(detail, 'TaskList');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('task-main-summary');
    expect(result[0].title).toBe('Result Summary');
  });

  it('filters sub-agent SummarizeResult tasks tagged as orchestration', () => {
    const detail = JSON.stringify({
      tasks: [
        {
          id: 'task-sub-summary',
          title: 'Result Summary',
          owner: 'main/researcher',
          status: 'completed',
          kind: 'orchestration',
          notes: 'Should be hidden from user-facing task list',
        },
      ],
    });

    const result = parseTasksFromDetail(detail, 'TaskList');
    expect(result).toEqual([]);
  });

  it('filters delegation tracking tasks tagged as orchestration', () => {
    const detail = JSON.stringify({
      tasks: [
        {
          id: 'task-delegation',
          title: 'Delegated to Gemini 2.5 Pro: Investigate routing',
          owner: 'main/researcher',
          status: 'in_progress',
          kind: 'orchestration',
        },
      ],
    });

    const result = parseTasksFromDetail(detail, 'TaskList');
    expect(result).toEqual([]);
  });

  it('filters orchestration tasks from pending todos extraction', () => {
    const detail = JSON.stringify({
      tasks: [
        { id: 'task-work', title: 'User-visible task', status: 'pending' },
        {
          id: 'task-orch',
          title: 'Delegated to GPT-5.5: hidden tracker',
          status: 'pending',
          kind: 'orchestration',
        },
      ],
    });

    const todos = parseTodosFromDetail(detail, 'TaskList');
    expect(todos).toEqual([
      { id: 'task-work', content: 'User-visible task', priority: undefined },
    ]);
  });
});

// ---------------------------------------------------------------------------
// computeTurnTaskDelta
// ---------------------------------------------------------------------------

describe('computeTurnTaskDelta', () => {
  const snapshot: TaskProgressItem[] = [
    task('task-1', 'completed'),
    task('task-2', 'in_progress'),
    task('task-3', 'pending'),
    task('task-4', 'pending'),
    task('task-5', 'blocked'),
  ];

  it('returns full snapshot as deltaTasks when hasMissionSet=true', () => {
    const result = computeTurnTaskDelta(snapshot, ['task-2'], true);
    expect(result.hasMissionSet).toBe(true);
    expect(result.deltaTasks).toEqual(snapshot);
    expect(result.snapshot).toBe(snapshot);
    expect(result.touchedTaskIds).toEqual(['task-2']);
  });

  it('filters snapshot to touched tasks (subset)', () => {
    const result = computeTurnTaskDelta(snapshot, ['task-2', 'task-3'], false);
    expect(result.deltaTasks).toEqual([
      task('task-2', 'in_progress'),
      task('task-3', 'pending'),
    ]);
    expect(result.hasMissionSet).toBe(false);
  });

  it('returns empty deltaTasks when touchedTaskIds is empty', () => {
    const result = computeTurnTaskDelta(snapshot, [], false);
    expect(result.deltaTasks).toEqual([]);
    expect(result.touchedTaskIds).toEqual([]);
  });

  it('preserves touch order (not snapshot order)', () => {
    const result = computeTurnTaskDelta(snapshot, ['task-3', 'task-1'], false);
    expect(result.deltaTasks).toEqual([
      task('task-3', 'pending'),
      task('task-1', 'completed'),
    ]);
  });

  it('gracefully skips task IDs not in snapshot', () => {
    const result = computeTurnTaskDelta(snapshot, ['nonexistent', 'task-2'], false);
    expect(result.deltaTasks).toEqual([task('task-2', 'in_progress')]);
    expect(result.touchedTaskIds).toEqual(['nonexistent', 'task-2']);
  });

  it('deduplicates touchedTaskIds (first-touch wins)', () => {
    const result = computeTurnTaskDelta(snapshot, ['task-1', 'task-2', 'task-1'], false);
    expect(result.touchedTaskIds).toEqual(['task-1', 'task-2']);
    expect(result.deltaTasks).toEqual([
      task('task-1', 'completed'),
      task('task-2', 'in_progress'),
    ]);
  });

  it('works with empty snapshot', () => {
    const result = computeTurnTaskDelta([], ['task-1'], false);
    expect(result.deltaTasks).toEqual([]);
    expect(result.snapshot).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeTaskDisplayProps
// ---------------------------------------------------------------------------

describe('computeTaskDisplayProps', () => {
  const snapshot: TaskProgressItem[] = [
    task('task-1', 'completed'),
    task('task-2', 'in_progress'),
    task('task-3', 'pending'),
  ];

  it('returns null when turnDelta is null and no mission', () => {
    expect(computeTaskDisplayProps(null, null, false)).toBeNull();
  });

  it('returns full mode with mission when turnDelta is null but mission present', () => {
    const result = computeTaskDisplayProps(null, mission, false);
    expect(result).toEqual({
      mode: 'full',
      displayTasks: [],
      displayMission: mission,
      snapshotCounts: undefined,
    });
  });

  it('returns full mode when hasMissionSet=true', () => {
    const delta = computeTurnTaskDelta(snapshot, ['task-2'], true);
    const result = computeTaskDisplayProps(delta, mission, false);
    expect(result).toEqual({
      mode: 'full',
      displayTasks: snapshot,
      displayMission: mission,
      snapshotCounts: { completed: 1, total: 3 },
    });
  });

  it('returns active mode when isActiveThinking=true and no MissionSet', () => {
    const delta = computeTurnTaskDelta(snapshot, ['task-2'], false);
    const result = computeTaskDisplayProps(delta, null, true);
    expect(result).toEqual({
      mode: 'active',
      displayTasks: [task('task-2', 'in_progress'), task('task-3', 'pending')],
      displayMission: null,
      snapshotCounts: { completed: 1, total: 3 },
    });
  });

  it('returns compact mode for completed turn with delta', () => {
    const delta = computeTurnTaskDelta(snapshot, ['task-2', 'task-3'], false);
    const result = computeTaskDisplayProps(delta, null, false);
    expect(result).toEqual({
      mode: 'compact',
      displayTasks: [task('task-2', 'in_progress'), task('task-3', 'pending')],
      displayMission: null,
      snapshotCounts: { completed: 1, total: 3 },
    });
  });

  it('returns compact mode with empty deltaTasks when no tasks touched', () => {
    const delta = computeTurnTaskDelta(snapshot, [], false);
    const result = computeTaskDisplayProps(delta, null, false);
    expect(result).toEqual({
      mode: 'compact',
      displayTasks: [],
      displayMission: null,
      snapshotCounts: { completed: 1, total: 3 },
    });
  });

  it('computes snapshotCounts correctly', () => {
    const mixedSnapshot: TaskProgressItem[] = [
      task('t1', 'completed'),
      task('t2', 'completed'),
      task('t3', 'in_progress'),
      task('t4', 'pending'),
      task('t5', 'blocked'),
    ];
    const delta = computeTurnTaskDelta(mixedSnapshot, ['t3'], false);
    const result = computeTaskDisplayProps(delta, null, false);
    expect(result?.snapshotCounts).toEqual({ completed: 2, total: 5 });
  });

  it('returns null when snapshot is empty and no mission', () => {
    const delta = computeTurnTaskDelta([], [], false);
    const result = computeTaskDisplayProps(delta, null, false);
    expect(result).toBeNull();
  });

  it('returns full mode with mission when snapshot is empty but mission present', () => {
    const delta = computeTurnTaskDelta([], [], false);
    const result = computeTaskDisplayProps(delta, mission, false);
    expect(result).toEqual({
      mode: 'full',
      displayTasks: [],
      displayMission: mission,
      snapshotCounts: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// Per-turn task store scenarios
// ---------------------------------------------------------------------------

describe('per-turn store: snapshot === delta', () => {
  it('computeTurnTaskDelta returns all tasks as delta when all are touched', () => {
    const snapshot = [task('1', 'in_progress'), task('2', 'pending'), task('3', 'completed')];
    const touchedIds = ['1', '2', '3'];
    const delta = computeTurnTaskDelta(snapshot, touchedIds, false);

    expect(delta.deltaTasks).toHaveLength(3);
    expect(delta.deltaTasks.map(t => t.id)).toEqual(['1', '2', '3']);
    expect(delta.snapshot).toBe(snapshot);
    expect(delta.hasMissionSet).toBe(false);
  });

  it('computeTurnTaskDelta with MissionSet returns full snapshot as delta', () => {
    const snapshot = [task('1', 'completed'), task('2', 'in_progress')];
    const touchedIds = ['1', '2'];
    const delta = computeTurnTaskDelta(snapshot, touchedIds, true);

    expect(delta.deltaTasks).toEqual(snapshot);
    expect(delta.hasMissionSet).toBe(true);
  });

  it('computeTaskDisplayProps: per-turn with MissionSet → full mode, all tasks', () => {
    const snapshot = [task('1', 'in_progress'), task('2', 'pending')];
    const delta = computeTurnTaskDelta(snapshot, ['1', '2'], true);
    const result = computeTaskDisplayProps(delta, mission, false);

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('full');
    expect(result!.displayTasks).toEqual(snapshot);
    expect(result!.displayMission).toBe(mission);
    expect(result!.snapshotCounts).toEqual({ completed: 0, total: 2 });
  });

  it('computeTaskDisplayProps: per-turn compact → delta equals snapshot', () => {
    const snapshot = [task('1', 'completed'), task('2', 'in_progress')];
    const delta = computeTurnTaskDelta(snapshot, ['1', '2'], false);
    const result = computeTaskDisplayProps(delta, null, false);

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('compact');
    expect(result!.displayTasks).toEqual(snapshot);
    expect(result!.snapshotCounts).toEqual({ completed: 1, total: 2 });
  });

  it('computeTaskDisplayProps: per-turn active thinking → shows in_progress + pending', () => {
    const snapshot = [task('1', 'completed'), task('2', 'in_progress'), task('3', 'pending')];
    const delta = computeTurnTaskDelta(snapshot, ['1', '2', '3'], false);
    const result = computeTaskDisplayProps(delta, null, true);

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('active');
    expect(result!.displayTasks.map(t => t.id)).toEqual(['2', '3']);
  });
});
