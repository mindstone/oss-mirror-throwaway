import { describe, expect, it } from 'vitest';
import { executeBuiltinTool, getBuiltinToolDefinitions, GET_PREVIOUS_TASKS_TOOL_DEFINITION } from '../builtinTools';
import { createTaskStore } from '../taskState';

describe('task tools', () => {
  it('creates, updates, and lists tasks with a single in-progress task', async () => {
    const taskStore = createTaskStore();
    const context = { taskStore };

    const createdFirst = await executeBuiltinTool('TaskCreate', {
      subject: 'Inspect runtime wiring',
      status: 'in_progress',
    }, context);
    const createdSecond = await executeBuiltinTool('TaskCreate', {
      subject: 'Add task tools',
      status: 'in_progress',
    }, context);

    expect(createdFirst.isError).toBe(false);
    expect(createdSecond.isError).toBe(false);

    const listAfterCreate = await executeBuiltinTool('TaskList', {}, context);
    const parsedAfterCreate = JSON.parse(listAfterCreate.output);

    expect(parsedAfterCreate.tasks).toHaveLength(2);
    expect(parsedAfterCreate.tasks[0].status).toBe('pending');
    expect(parsedAfterCreate.tasks[1].status).toBe('in_progress');

    const update = await executeBuiltinTool('TaskUpdate', {
      taskId: parsedAfterCreate.tasks[0].id,
      status: 'in_progress',
    }, context);

    expect(update.isError).toBe(false);

    const listAfterUpdate = await executeBuiltinTool('TaskList', {}, context);
    const parsedAfterUpdate = JSON.parse(listAfterUpdate.output);

    expect(parsedAfterUpdate.tasks[0].status).toBe('in_progress');
    expect(parsedAfterUpdate.tasks[1].status).toBe('pending');
  });

  it('supports legacy TodoWrite and TodoRead compatibility', async () => {
    const taskStore = createTaskStore();
    const context = { taskStore };

    const writeResult = await executeBuiltinTool('TodoWrite', {
      todos: [
        { content: 'Plan the change', status: 'completed' },
        { content: 'Implement the task tools', status: 'pending', priority: 'high' },
      ],
    }, context);

    expect(writeResult.isError).toBe(false);

    const taskList = await executeBuiltinTool('TaskList', {}, context);
    const parsedTaskList = JSON.parse(taskList.output);

    expect(parsedTaskList.tasks).toHaveLength(2);
    expect(parsedTaskList.tasks[1].title).toBe('Implement the task tools');
    expect(parsedTaskList.tasks[1].priority).toBe('high');

    const todoRead = await executeBuiltinTool('TodoRead', {}, context);
    const parsedTodoRead = JSON.parse(todoRead.output);

    expect(parsedTodoRead.todos).toEqual([
      { id: '1', content: 'Plan the change', status: 'completed' },
      { id: '2', content: 'Implement the task tools', status: 'pending', priority: 'high' },
    ]);
  });

  it('keeps blocked tasks blocked until dependencies complete, then unblocks them', async () => {
    const taskStore = createTaskStore();
    const context = { taskStore };

    await executeBuiltinTool('TaskCreate', {
      subject: 'Finish research',
      status: 'in_progress',
    }, context);

    await executeBuiltinTool('TaskCreate', {
      subject: 'Implement the mechanism',
      blocked_by: ['1'],
    }, context);

    let taskList = await executeBuiltinTool('TaskList', {}, context);
    let parsedTaskList = JSON.parse(taskList.output);

    expect(parsedTaskList.tasks[1].status).toBe('blocked');

    await executeBuiltinTool('TaskUpdate', {
      taskId: '1',
      status: 'completed',
    }, context);

    taskList = await executeBuiltinTool('TaskList', {}, context);
    parsedTaskList = JSON.parse(taskList.output);

    expect(parsedTaskList.tasks[1].status).toBe('pending');
  });

  it('includes full task snapshot in TaskCreate and TaskUpdate results', async () => {
    const taskStore = createTaskStore();
    const context = { taskStore };

    const created1 = await executeBuiltinTool('TaskCreate', {
      subject: 'First task',
      status: 'in_progress',
    }, context);
    const parsed1 = JSON.parse(created1.output);
    expect(parsed1.task.title).toBe('First task');
    expect(parsed1.tasks).toHaveLength(1);
    expect(parsed1.tasks[0].id).toBe(parsed1.task.id);

    const created2 = await executeBuiltinTool('TaskCreate', {
      subject: 'Second task',
    }, context);
    const parsed2 = JSON.parse(created2.output);
    expect(parsed2.tasks).toHaveLength(2);

    const updated = await executeBuiltinTool('TaskUpdate', {
      taskId: parsed2.tasks[0].id,
      status: 'completed',
    }, context);
    const parsedUpdate = JSON.parse(updated.output);
    expect(parsedUpdate.task.status).toBe('completed');
    expect(parsedUpdate.tasks).toHaveLength(2);
    expect(parsedUpdate.tasks.find((t: { id: string }) => t.id === parsedUpdate.task.id).status).toBe('completed');
  });
});

describe('GetPreviousTasks tool', () => {
  it('returns empty result when archive is empty', async () => {
    const taskStore = createTaskStore();
    const context = { taskStoreInternal: taskStore };

    const result = await executeBuiltinTool('GetPreviousTasks', {}, context);
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.output);
    expect(parsed.previous_turns).toEqual([]);
    expect(parsed.total_archived_turns).toBe(0);
    expect(parsed.showing).toBe(0);
  });

  it('returns archived turns with correct grouping after archiving 2 turns', async () => {
    const taskStore = createTaskStore();
    const context = { taskStoreInternal: taskStore };

    // Turn 1: create tasks and archive
    taskStore.createTask({ title: 'Research topic', status: 'completed' });
    taskStore.createTask({ title: 'Write outline', status: 'completed' });
    taskStore.archiveTurn();

    // Turn 2: create tasks and archive
    taskStore.createTask({ title: 'Draft document', status: 'completed' });
    taskStore.createTask({ title: 'Review draft', status: 'in_progress' });
    taskStore.archiveTurn();

    const result = await executeBuiltinTool('GetPreviousTasks', {}, context);
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.output);
    expect(parsed.total_archived_turns).toBe(2);
    expect(parsed.showing).toBe(2);
    expect(parsed.previous_turns).toHaveLength(2);

    // Most recent turn first (turn 2)
    expect(parsed.previous_turns[0].turn_number).toBe(2);
    expect(parsed.previous_turns[0].tasks).toHaveLength(2);
    expect(parsed.previous_turns[0].tasks[0].title).toBe('Draft document');
    expect(parsed.previous_turns[0].tasks[1].title).toBe('Review draft');

    // Older turn second (turn 1)
    expect(parsed.previous_turns[1].turn_number).toBe(1);
    expect(parsed.previous_turns[1].tasks).toHaveLength(2);
    expect(parsed.previous_turns[1].tasks[0].title).toBe('Research topic');
    expect(parsed.previous_turns[1].tasks[1].title).toBe('Write outline');
  });

  it('limits output with max_turns parameter', async () => {
    const taskStore = createTaskStore();
    const context = { taskStoreInternal: taskStore };

    // Archive 5 turns
    for (let i = 1; i <= 5; i++) {
      taskStore.createTask({ title: `Task from turn ${i}`, status: 'completed' });
      taskStore.archiveTurn();
    }

    const result = await executeBuiltinTool('GetPreviousTasks', { max_turns: 2 }, context);
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.output);
    expect(parsed.total_archived_turns).toBe(5);
    expect(parsed.showing).toBe(2);
    expect(parsed.previous_turns).toHaveLength(2);

    // Most recent turns only
    expect(parsed.previous_turns[0].turn_number).toBe(5);
    expect(parsed.previous_turns[1].turn_number).toBe(4);
  });

  it('defaults to 3 turns when max_turns is not provided', async () => {
    const taskStore = createTaskStore();
    const context = { taskStoreInternal: taskStore };

    // Archive 5 turns
    for (let i = 1; i <= 5; i++) {
      taskStore.createTask({ title: `Task from turn ${i}`, status: 'completed' });
      taskStore.archiveTurn();
    }

    const result = await executeBuiltinTool('GetPreviousTasks', {}, context);
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.output);
    expect(parsed.total_archived_turns).toBe(5);
    expect(parsed.showing).toBe(3);
    expect(parsed.previous_turns).toHaveLength(3);
    expect(parsed.previous_turns[0].turn_number).toBe(5);
    expect(parsed.previous_turns[1].turn_number).toBe(4);
    expect(parsed.previous_turns[2].turn_number).toBe(3);
  });

  it('extracts mission context per turn and excludes mission tasks from display', async () => {
    const taskStore = createTaskStore();
    const context = { taskStoreInternal: taskStore };

    // Turn 1: mission + work tasks
    const now = Date.now();
    taskStore._setRawTask('1', {
      id: '1', title: 'Write a comprehensive report', owner: 'mission',
      status: 'pending', notes: 'goal', createdAt: now, updatedAt: now,
    });
    taskStore._setRawTask('2', {
      id: '2', title: 'Report is accurate and complete', owner: 'mission',
      status: 'pending', notes: 'done_criteria', createdAt: now, updatedAt: now,
    });
    taskStore._setRawTask('3', {
      id: '3', title: 'Gather data', owner: undefined,
      status: 'completed', createdAt: now, updatedAt: now,
    });
    taskStore._setRawTask('4', {
      id: '4', title: 'Analyze results', owner: undefined,
      status: 'completed', createdAt: now, updatedAt: now,
    });
    taskStore._setNextTaskId(5);
    taskStore.archiveTurn();

    const result = await executeBuiltinTool('GetPreviousTasks', {}, context);
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.output);
    expect(parsed.previous_turns).toHaveLength(1);

    const turn = parsed.previous_turns[0];

    // Mission context extracted from mission-owned tasks
    expect(turn.mission.goal).toBe('Write a comprehensive report');
    expect(turn.mission.done_criteria).toBe('Report is accurate and complete');
    expect(turn.mission.constraints).toBeUndefined();

    // Only non-mission tasks in the tasks array
    expect(turn.tasks).toHaveLength(2);
    expect(turn.tasks[0].title).toBe('Gather data');
    expect(turn.tasks[1].title).toBe('Analyze results');
  });

  it('is not included in default builtin tool definitions (depth > 0 exclusion)', () => {
    const defaultTools = getBuiltinToolDefinitions();
    const hasGetPreviousTasks = defaultTools.some((t) => t.name === 'GetPreviousTasks');
    expect(hasGetPreviousTasks).toBe(false);
  });

  it('has a valid tool definition export', () => {
    expect(GET_PREVIOUS_TASKS_TOOL_DEFINITION.name).toBe('GetPreviousTasks');
    expect(GET_PREVIOUS_TASKS_TOOL_DEFINITION.input_schema.properties).toHaveProperty('max_turns');
  });

  it('fails gracefully when taskStoreInternal is not available', async () => {
    const result = await executeBuiltinTool('GetPreviousTasks', {}, {});
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Internal task store is not available');
  });
});
