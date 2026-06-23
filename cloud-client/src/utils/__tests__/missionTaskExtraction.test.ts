import { describe, expect, it } from 'vitest';
import type { SessionToolEvent } from '../../types';
import {
  extractMissionFromEvents,
  extractTasksFromEvents,
  extractTurnTaskDeltaFromEvents,
  parseMissionFromDetail,
  parseTasksFromDetail,
} from '../missionTaskExtraction';

const createToolEvent = (overrides: Partial<SessionToolEvent>): SessionToolEvent => ({
  type: 'tool',
  toolName: 'Read',
  detail: '{}',
  stage: 'start',
  timestamp: 1,
  ...overrides,
});

describe('missionTaskExtraction', () => {
  it('parses mission context from MissionSet result format detail', () => {
    expect(
      parseMissionFromDetail(
        JSON.stringify({
          mission: {
            goal: 'Ship the feature',
            done_criteria: 'Tests pass',
            constraints: 'Keep changes small',
          },
        }),
      ),
    ).toEqual({
      goal: 'Ship the feature',
      doneCriteria: 'Tests pass',
      constraints: 'Keep changes small',
    });
  });

  it('falls back to MissionSet input format detail when mission wrapper is absent', () => {
    expect(
      parseMissionFromDetail(
        JSON.stringify({
          goal: 'Prepare the launch',
          done_criteria: 'Checklist complete',
          constraints: 'No scope creep',
        }),
      ),
    ).toEqual({
      goal: 'Prepare the launch',
      doneCriteria: 'Checklist complete',
      constraints: 'No scope creep',
    });
  });

  it('parses TaskList detail and filters mission-owned and invalid-status tasks', () => {
    expect(
      parseTasksFromDetail(
        JSON.stringify({
          result: {
            tasks: [
              { id: 'task-1', title: 'Keep me', status: 'in_progress' },
              { id: 'task-2', title: 'Hide me', status: 'completed', owner: 'mission' },
              { id: 'task-3', title: 'Also hide me', status: 'queued' },
              { content: 'Fallback title', status: 'completed' },
            ],
          },
        }),
        'TaskList',
      ),
    ).toEqual([
      { id: 'task-1', title: 'Keep me', status: 'in_progress' },
      { id: 'task-3', title: 'Fallback title', status: 'completed' },
    ]);
  });

  it('parses tasks from TaskCreate detail (snapshot in tasks array)', () => {
    expect(
      parseTasksFromDetail(
        JSON.stringify({
          summary: 'Task #1 created successfully',
          task: { id: '1', title: 'First task', status: 'in_progress' },
          tasks: [
            { id: '1', title: 'First task', status: 'in_progress' },
            { id: '2', title: 'Second task', status: 'pending' },
          ],
        }),
        'TaskCreate',
      ),
    ).toEqual([
      { id: '1', title: 'First task', status: 'in_progress' },
      { id: '2', title: 'Second task', status: 'pending' },
    ]);
  });

  it('parses tasks from TaskUpdate detail (snapshot in tasks array)', () => {
    expect(
      parseTasksFromDetail(
        JSON.stringify({
          summary: 'Updated task #1',
          task: { id: '1', title: 'First task', status: 'completed' },
          tasks: [
            { id: '1', title: 'First task', status: 'completed' },
            { id: '2', title: 'Second task', status: 'in_progress' },
          ],
        }),
        'TaskUpdate',
      ),
    ).toEqual([
      { id: '1', title: 'First task', status: 'completed' },
      { id: '2', title: 'Second task', status: 'in_progress' },
    ]);
  });

  it('parses TodoWrite detail and maps content to title', () => {
    expect(
      parseTasksFromDetail(
        JSON.stringify({
          todos: [
            { id: 'todo-explicit', content: 'Draft the note', status: 'pending' },
            { content: 'Send the email', status: 'completed' },
          ],
        }),
        'TodoWrite',
      ),
    ).toEqual([
      { id: 'todo-explicit', title: 'Draft the note', status: 'pending' },
      { id: 'todo-1', title: 'Send the email', status: 'completed' },
    ]);
  });

  it('returns null or empty arrays for malformed and truncated JSON details', () => {
    expect(parseMissionFromDetail('{"mission":{"goal":"Broken"')).toBeNull();
    expect(parseTasksFromDetail('{"tasks":[{"id":"task-1"', 'TaskList')).toEqual([]);
  });

  it('returns null or empty arrays when no relevant events exist', () => {
    expect(extractMissionFromEvents([])).toBeNull();
    expect(extractTasksFromEvents([])).toEqual([]);
  });

  it('extracts mission from the latest MissionSet end event before falling back to start events', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'MissionSet',
        stage: 'start',
        timestamp: 1,
        detail: JSON.stringify({ goal: 'Old start goal' }),
      }),
      createToolEvent({
        toolName: 'MissionSet',
        stage: 'end',
        timestamp: 2,
        detail: JSON.stringify({ mission: { goal: 'Older end goal' } }),
      }),
      createToolEvent({
        toolName: 'MissionSet',
        stage: 'start',
        timestamp: 3,
        detail: JSON.stringify({ goal: 'Newest start goal' }),
      }),
      createToolEvent({
        toolName: 'MissionSet',
        stage: 'end',
        timestamp: 4,
        detail: JSON.stringify({ mission: { goal: 'Newest end goal' } }),
      }),
    ];

    expect(extractMissionFromEvents(events)).toEqual({ goal: 'Newest end goal' });
  });

  it('falls back to the latest MissionSet start event when no end event exists', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'MissionSet',
        stage: 'start',
        timestamp: 1,
        detail: JSON.stringify({ goal: 'Earlier preview' }),
      }),
      createToolEvent({
        toolName: 'MissionSet',
        stage: 'start',
        timestamp: 2,
        detail: JSON.stringify({ goal: 'Latest preview' }),
      }),
    ];

    expect(extractMissionFromEvents(events)).toEqual({ goal: 'Latest preview' });
  });

  it('extracts tasks from the latest TaskList end event by timestamp', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'TaskList',
        stage: 'end',
        timestamp: 1,
        detail: JSON.stringify({
          tasks: [{ id: 'old', title: 'Old task', status: 'pending' }],
        }),
      }),
      createToolEvent({
        toolName: 'TaskList',
        stage: 'end',
        timestamp: 2,
        detail: JSON.stringify({
          tasks: [{ id: 'new', title: 'New task', status: 'completed' }],
        }),
      }),
    ];

    expect(extractTasksFromEvents(events)).toEqual([
      { id: 'new', title: 'New task', status: 'completed' },
    ]);
  });

  it('falls back to TodoWrite start events when no TaskList end event exists', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'TodoWrite',
        stage: 'start',
        timestamp: 1,
        detail: JSON.stringify({
          todos: [{ id: 'todo-1', content: 'Legacy task', status: 'blocked' }],
        }),
      }),
    ];

    expect(extractTasksFromEvents(events)).toEqual([
      { id: 'todo-1', title: 'Legacy task', status: 'blocked' },
    ]);
  });

  it('extracts tasks from TaskCreate end events when no TaskList exists', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'TaskCreate',
        stage: 'end',
        timestamp: 1,
        detail: JSON.stringify({
          summary: 'Task #1 created',
          task: { id: '1', title: 'First', status: 'in_progress' },
          tasks: [{ id: '1', title: 'First', status: 'in_progress' }],
        }),
      }),
      createToolEvent({
        toolName: 'TaskCreate',
        stage: 'end',
        timestamp: 2,
        detail: JSON.stringify({
          summary: 'Task #2 created',
          task: { id: '2', title: 'Second', status: 'pending' },
          tasks: [
            { id: '1', title: 'First', status: 'in_progress' },
            { id: '2', title: 'Second', status: 'pending' },
          ],
        }),
      }),
    ];

    expect(extractTasksFromEvents(events)).toEqual([
      { id: '1', title: 'First', status: 'in_progress' },
      { id: '2', title: 'Second', status: 'pending' },
    ]);
  });

  it('uses latest TaskUpdate snapshot over earlier TaskCreate snapshots', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'TaskCreate',
        stage: 'end',
        timestamp: 1,
        detail: JSON.stringify({
          tasks: [{ id: '1', title: 'Task A', status: 'pending' }],
        }),
      }),
      createToolEvent({
        toolName: 'TaskUpdate',
        stage: 'end',
        timestamp: 3,
        detail: JSON.stringify({
          tasks: [{ id: '1', title: 'Task A', status: 'completed' }],
        }),
      }),
    ];

    expect(extractTasksFromEvents(events)).toEqual([
      { id: '1', title: 'Task A', status: 'completed' },
    ]);
  });

  it('prefers TaskList end events over TodoWrite start events when both are present', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'TodoWrite',
        stage: 'start',
        timestamp: 5,
        detail: JSON.stringify({
          todos: [{ id: 'todo-1', content: 'Legacy task', status: 'pending' }],
        }),
      }),
      createToolEvent({
        toolName: 'TaskList',
        stage: 'end',
        timestamp: 2,
        detail: JSON.stringify({
          tasks: [{ id: 'task-1', title: 'Modern task', status: 'completed' }],
        }),
      }),
    ];

    expect(extractTasksFromEvents(events)).toEqual([
      { id: 'task-1', title: 'Modern task', status: 'completed' },
    ]);
  });

  it('falls back to TodoWrite when the latest task-snapshot end event parses to an empty array', () => {
    // When the latest snapshot end event yields [] (e.g. all tasks filtered out as mission-owned),
    // extractTasksFromEvents should fall back to the latest TodoWrite start event.
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'TodoWrite',
        stage: 'start',
        timestamp: 1,
        detail: JSON.stringify({
          todos: [
            { id: 'todo-1', content: 'Fallback task A', status: 'in_progress' },
            { id: 'todo-2', content: 'Fallback task B', status: 'pending' },
          ],
        }),
      }),
      createToolEvent({
        toolName: 'TaskList',
        stage: 'end',
        timestamp: 5,
        detail: JSON.stringify({
          tasks: [
            // All tasks are mission-owned → filtered out → empty result
            { id: 'task-1', title: 'Mission task', status: 'completed', owner: 'mission' },
          ],
        }),
      }),
    ];

    expect(extractTasksFromEvents(events)).toEqual([
      { id: 'todo-1', title: 'Fallback task A', status: 'in_progress' },
      { id: 'todo-2', title: 'Fallback task B', status: 'pending' },
    ]);
  });
});

describe('extractTurnTaskDeltaFromEvents', () => {
  it('returns hasMissionSet=true and all tasks as delta when MissionSet event present', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'MissionSet',
        stage: 'end',
        timestamp: 1,
        detail: JSON.stringify({ mission: { goal: 'Ship it' } }),
      }),
      createToolEvent({
        toolName: 'TaskCreate',
        stage: 'end',
        timestamp: 2,
        detail: JSON.stringify({
          task: { id: '1', title: 'Task A', status: 'pending' },
          tasks: [{ id: '1', title: 'Task A', status: 'pending' }],
        }),
      }),
      createToolEvent({
        toolName: 'TaskCreate',
        stage: 'end',
        timestamp: 3,
        detail: JSON.stringify({
          task: { id: '2', title: 'Task B', status: 'pending' },
          tasks: [
            { id: '1', title: 'Task A', status: 'pending' },
            { id: '2', title: 'Task B', status: 'pending' },
          ],
        }),
      }),
    ];

    const delta = extractTurnTaskDeltaFromEvents(events);
    expect(delta.hasMissionSet).toBe(true);
    expect(delta.snapshot).toHaveLength(2);
    expect(delta.deltaTasks).toHaveLength(2);
    expect(delta.deltaTasks).toEqual(delta.snapshot);
  });

  it('returns only touched tasks as delta for TaskCreate/TaskUpdate events', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'TaskUpdate',
        stage: 'end',
        timestamp: 1,
        detail: JSON.stringify({
          task: { id: '2', title: 'Task B', status: 'in_progress' },
          tasks: [
            { id: '1', title: 'Task A', status: 'completed' },
            { id: '2', title: 'Task B', status: 'in_progress' },
            { id: '3', title: 'Task C', status: 'pending' },
          ],
        }),
      }),
      createToolEvent({
        toolName: 'TaskUpdate',
        stage: 'end',
        timestamp: 2,
        detail: JSON.stringify({
          task: { id: '3', title: 'Task C', status: 'in_progress' },
          tasks: [
            { id: '1', title: 'Task A', status: 'completed' },
            { id: '2', title: 'Task B', status: 'in_progress' },
            { id: '3', title: 'Task C', status: 'in_progress' },
          ],
        }),
      }),
    ];

    const delta = extractTurnTaskDeltaFromEvents(events);
    expect(delta.hasMissionSet).toBe(false);
    expect(delta.snapshot).toHaveLength(3);
    expect(delta.deltaTasks).toHaveLength(2);
    expect(delta.deltaTasks[0].id).toBe('2');
    expect(delta.deltaTasks[1].id).toBe('3');
    expect(delta.touchedTaskIds).toEqual(['2', '3']);
  });

  it('returns empty delta for events with only TaskList (no changes)', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'TaskList',
        stage: 'end',
        timestamp: 1,
        detail: JSON.stringify({
          tasks: [
            { id: '1', title: 'Task A', status: 'completed' },
            { id: '2', title: 'Task B', status: 'in_progress' },
          ],
        }),
      }),
    ];

    const delta = extractTurnTaskDeltaFromEvents(events);
    expect(delta.hasMissionSet).toBe(false);
    expect(delta.snapshot).toHaveLength(2);
    expect(delta.deltaTasks).toHaveLength(0);
    expect(delta.touchedTaskIds).toHaveLength(0);
  });

  it('falls back to all tasks as delta for TodoWrite events', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'TodoWrite',
        stage: 'start',
        timestamp: 1,
        detail: JSON.stringify({
          todos: [
            { id: 'todo-1', content: 'Do X', status: 'in_progress' },
            { id: 'todo-2', content: 'Do Y', status: 'pending' },
          ],
        }),
      }),
    ];

    const delta = extractTurnTaskDeltaFromEvents(events);
    expect(delta.hasMissionSet).toBe(false);
    expect(delta.snapshot).toHaveLength(2);
    expect(delta.deltaTasks).toHaveLength(2);
    expect(delta.touchedTaskIds).toEqual(['todo-1', 'todo-2']);
  });

  it('preserves touch order from event timestamps', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'TaskCreate',
        stage: 'end',
        timestamp: 5,
        detail: JSON.stringify({
          task: { id: 'B', title: 'Second created', status: 'pending' },
          tasks: [
            { id: 'A', title: 'First created', status: 'in_progress' },
            { id: 'B', title: 'Second created', status: 'pending' },
          ],
        }),
      }),
      createToolEvent({
        toolName: 'TaskCreate',
        stage: 'end',
        timestamp: 3,
        detail: JSON.stringify({
          task: { id: 'A', title: 'First created', status: 'in_progress' },
          tasks: [{ id: 'A', title: 'First created', status: 'in_progress' }],
        }),
      }),
    ];

    const delta = extractTurnTaskDeltaFromEvents(events);
    // Events are sorted by timestamp, so A (ts=3) comes before B (ts=5)
    expect(delta.touchedTaskIds).toEqual(['A', 'B']);
    expect(delta.deltaTasks[0].id).toBe('A');
    expect(delta.deltaTasks[1].id).toBe('B');
  });

  it('returns empty delta for empty events', () => {
    const delta = extractTurnTaskDeltaFromEvents([]);
    expect(delta.hasMissionSet).toBe(false);
    expect(delta.snapshot).toHaveLength(0);
    expect(delta.deltaTasks).toHaveLength(0);
    expect(delta.touchedTaskIds).toHaveLength(0);
  });

  it('ignores TaskCreate/TaskUpdate start events (only end events have snapshots)', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'TaskCreate',
        stage: 'start',
        timestamp: 1,
        detail: JSON.stringify({ title: 'New task', status: 'pending' }),
      }),
      createToolEvent({
        toolName: 'TaskCreate',
        stage: 'end',
        timestamp: 2,
        detail: JSON.stringify({
          task: { id: '1', title: 'New task', status: 'pending' },
          tasks: [{ id: '1', title: 'New task', status: 'pending' }],
        }),
      }),
    ];

    const delta = extractTurnTaskDeltaFromEvents(events);
    // Only the end event's task ID should be collected
    expect(delta.touchedTaskIds).toEqual(['1']);
    expect(delta.deltaTasks).toHaveLength(1);
  });
});

describe('per-turn store: all tasks from current turn', () => {
  it('returns all tasks as delta when all TaskCreate events are from this turn', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'MissionSet',
        stage: 'end',
        timestamp: 1,
        detail: JSON.stringify({ mission: { goal: 'Turn 2 goal' } }),
      }),
      createToolEvent({
        toolName: 'TaskCreate',
        stage: 'end',
        timestamp: 2,
        detail: JSON.stringify({
          task: { id: '11', title: 'First task', status: 'in_progress' },
          tasks: [{ id: '11', title: 'First task', status: 'in_progress' }],
        }),
      }),
      createToolEvent({
        toolName: 'TaskCreate',
        stage: 'end',
        timestamp: 3,
        detail: JSON.stringify({
          task: { id: '12', title: 'Second task', status: 'pending' },
          tasks: [
            { id: '11', title: 'First task', status: 'in_progress' },
            { id: '12', title: 'Second task', status: 'pending' },
          ],
        }),
      }),
    ];

    const delta = extractTurnTaskDeltaFromEvents(events);
    expect(delta.hasMissionSet).toBe(true);
    expect(delta.snapshot).toHaveLength(2);
    expect(delta.deltaTasks).toHaveLength(2);
    expect(delta.touchedTaskIds).toEqual(['11', '12']);
  });

  it('per-turn without MissionSet: delta equals snapshot', () => {
    const events: SessionToolEvent[] = [
      createToolEvent({
        toolName: 'TaskCreate',
        stage: 'end',
        timestamp: 1,
        detail: JSON.stringify({
          task: { id: '5', title: 'Quick task', status: 'completed' },
          tasks: [{ id: '5', title: 'Quick task', status: 'completed' }],
        }),
      }),
    ];

    const delta = extractTurnTaskDeltaFromEvents(events);
    expect(delta.hasMissionSet).toBe(false);
    expect(delta.deltaTasks).toHaveLength(1);
    expect(delta.deltaTasks[0].id).toBe('5');
  });
});
