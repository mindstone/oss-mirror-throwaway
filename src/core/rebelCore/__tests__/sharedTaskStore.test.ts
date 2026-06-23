import { describe, expect, it } from 'vitest';
import { executeBuiltinTool } from '../builtinTools';
import { createScopedTaskStore, createTaskStore } from '../taskState';
import type { BuiltinToolContext } from '../types';

// ---------------------------------------------------------------------------
// 1. Scoped Task Store — Namespace Enforcement
// ---------------------------------------------------------------------------

describe('createScopedTaskStore', () => {
  it('scoped store reads all tasks from base store', () => {
    const base = createTaskStore();
    base.createTask({ title: 'Task A' });
    base.createTask({ title: 'Task B' });

    const scoped = createScopedTaskStore(base, 'researcher', 1);
    const tasks = scoped.listTasks();

    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.title)).toEqual(['Task A', 'Task B']);
  });

  it('scoped store sets owner on created tasks', () => {
    const base = createTaskStore();
    const scoped = createScopedTaskStore(base, 'researcher', 1);

    scoped.createTask({ title: 'My task' });

    const tasks = base.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].owner).toBe('researcher');
  });

  it('scoped store rejects writes to other namespaces', () => {
    const base = createTaskStore();

    // Create a task owned by agent-a directly via base store internals
    const now = Date.now();
    base._setRawTask('1', {
      id: '1',
      title: 'Agent A task',
      owner: 'agent-a',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    base._setNextTaskId(2);

    const scopedB = createScopedTaskStore(base, 'agent-b', 1);

    expect(() => scopedB.updateTask('1', { status: 'completed' })).toThrow(
      /Cannot update task 1 owned by namespace "agent-a" from namespace "agent-b"/,
    );
  });

  it('depth 0 store can write to any namespace', () => {
    const base = createTaskStore();

    const now = Date.now();
    base._setRawTask('1', {
      id: '1',
      title: 'Agent A task',
      owner: 'agent-a',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    base._setNextTaskId(2);

    const scopedRoot = createScopedTaskStore(base, 'main', 0);
    const updated = scopedRoot.updateTask('1', { status: 'completed' });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('completed');
  });

  it('parent namespace can write to child namespace', () => {
    const base = createTaskStore();

    const now = Date.now();
    base._setRawTask('1', {
      id: '1',
      title: 'Child task',
      owner: 'researcher/web-search',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    base._setNextTaskId(2);

    const scopedParent = createScopedTaskStore(base, 'researcher', 1);
    const updated = scopedParent.updateTask('1', { status: 'in_progress' });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('in_progress');
  });

  it('child namespace cannot write to parent namespace', () => {
    const base = createTaskStore();

    const now = Date.now();
    base._setRawTask('1', {
      id: '1',
      title: 'Parent task',
      owner: 'researcher',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    base._setNextTaskId(2);

    const scopedChild = createScopedTaskStore(base, 'researcher/web-search', 2);

    expect(() => scopedChild.updateTask('1', { status: 'completed' })).toThrow(
      /Cannot update task 1/,
    );
  });

  it('getTask returns task from any namespace', () => {
    const base = createTaskStore();

    const now = Date.now();
    base._setRawTask('1', {
      id: '1',
      title: 'Other agent task',
      owner: 'agent-a',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    base._setNextTaskId(2);

    const scopedB = createScopedTaskStore(base, 'agent-b', 1);
    const task = scopedB.getTask('1');

    expect(task).not.toBeNull();
    expect(task!.title).toBe('Other agent task');
  });
});

// ---------------------------------------------------------------------------
// 2. Scoped In-Progress Demotion
// ---------------------------------------------------------------------------

describe('scoped in-progress demotion', () => {
  it('only demotes in-progress tasks within same namespace', () => {
    const base = createTaskStore();

    // Create task owned by agent-a as in_progress
    const now = Date.now();
    base._setRawTask('1', {
      id: '1',
      title: 'Agent A active task',
      owner: 'agent-a',
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    });
    base._setNextTaskId(2);

    // Scoped store for agent-b creates an in_progress task
    const scopedB = createScopedTaskStore(base, 'agent-b', 1);
    scopedB.createTask({ title: 'Agent B active task', status: 'in_progress' });

    // agent-a's task should STILL be in_progress (not demoted)
    const taskA = base.getTask('1');
    expect(taskA!.status).toBe('in_progress');

    // agent-b's task should be in_progress
    const tasks = base.listTasks();
    const taskB = tasks.find((t) => t.owner === 'agent-b');
    expect(taskB!.status).toBe('in_progress');
  });

  it('demotes within same namespace when creating new in_progress task', () => {
    const base = createTaskStore();
    const scoped = createScopedTaskStore(base, 'agent-a', 1);

    scoped.createTask({ title: 'First active', status: 'in_progress' });
    scoped.createTask({ title: 'Second active', status: 'in_progress' });

    const tasks = scoped.listTasks().filter((t) => t.owner === 'agent-a');
    expect(tasks[0].status).toBe('pending'); // first was demoted
    expect(tasks[1].status).toBe('in_progress'); // second is active
  });

  it('base store demotes all in-progress tasks globally', () => {
    const base = createTaskStore();
    base.createTask({ title: 'Task A', status: 'in_progress' });
    base.createTask({ title: 'Task B', status: 'in_progress' });

    const tasks = base.listTasks();
    expect(tasks[0].status).toBe('pending'); // first was demoted
    expect(tasks[1].status).toBe('in_progress'); // second is active
  });

  it('scoped update to in_progress demotes only within namespace', () => {
    const base = createTaskStore();

    const now = Date.now();
    base._setRawTask('1', {
      id: '1',
      title: 'Agent A task 1',
      owner: 'agent-a',
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    });
    base._setRawTask('2', {
      id: '2',
      title: 'Agent A task 2',
      owner: 'agent-a',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    base._setRawTask('3', {
      id: '3',
      title: 'Agent B task',
      owner: 'agent-b',
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    });
    base._setNextTaskId(4);

    const scopedA = createScopedTaskStore(base, 'agent-a', 1);
    scopedA.updateTask('2', { status: 'in_progress' });

    // agent-a task 1 demoted (same namespace)
    expect(base.getTask('1')!.status).toBe('pending');
    // agent-a task 2 now in_progress
    expect(base.getTask('2')!.status).toBe('in_progress');
    // agent-b task NOT demoted (different namespace)
    expect(base.getTask('3')!.status).toBe('in_progress');
  });
});

// ---------------------------------------------------------------------------
// 3. Parallel-Group Sibling Exception
// ---------------------------------------------------------------------------

describe('parallel-group sibling exception', () => {
  it('base store: two parallel siblings remain in_progress simultaneously', () => {
    const base = createTaskStore();
    const sibling1 = base.createTask({ title: 'Sibling 1', parallelGroup: 'g1' });
    const sibling2 = base.createTask({ title: 'Sibling 2', parallelGroup: 'g1' });

    base.updateTask(sibling1.id, { status: 'in_progress' });
    base.updateTask(sibling2.id, { status: 'in_progress' });

    expect(base.getTask(sibling1.id)?.status).toBe('in_progress');
    expect(base.getTask(sibling2.id)?.status).toBe('in_progress');
  });

  it('base store: three parallel siblings co-active', () => {
    const base = createTaskStore();
    const sibling1 = base.createTask({ title: 'Sibling 1', parallelGroup: 'g1' });
    const sibling2 = base.createTask({ title: 'Sibling 2', parallelGroup: 'g1' });
    const sibling3 = base.createTask({ title: 'Sibling 3', parallelGroup: 'g1' });

    base.updateTask(sibling1.id, { status: 'in_progress' });
    base.updateTask(sibling2.id, { status: 'in_progress' });
    base.updateTask(sibling3.id, { status: 'in_progress' });

    expect(base.getTask(sibling1.id)?.status).toBe('in_progress');
    expect(base.getTask(sibling2.id)?.status).toBe('in_progress');
    expect(base.getTask(sibling3.id)?.status).toBe('in_progress');
  });

  it('base store: parallel siblings vs. unrelated singleton — singleton demotes correctly', () => {
    const base = createTaskStore();
    const sibling1 = base.createTask({ title: 'Sibling 1', parallelGroup: 'g1' });
    const sibling2 = base.createTask({ title: 'Sibling 2', parallelGroup: 'g1' });
    base.createTask({ title: 'Sibling 3', parallelGroup: 'g1' });
    const singleton = base.createTask({ title: 'Singleton' });

    base.updateTask(sibling1.id, { status: 'in_progress' });
    base.updateTask(singleton.id, { status: 'in_progress' });
    base.updateTask(sibling1.id, { status: 'in_progress' });
    base.updateTask(sibling2.id, { status: 'in_progress' });

    expect(base.getTask(sibling1.id)?.status).toBe('in_progress');
    expect(base.getTask(sibling2.id)?.status).toBe('in_progress');
    expect(base.getTask(singleton.id)?.status).toBe('pending');
  });

  it('base store: tasks in different parallel groups demote each other', () => {
    const base = createTaskStore();
    const group1 = base.createTask({ title: 'Group 1 task', parallelGroup: 'g1' });
    const group2 = base.createTask({ title: 'Group 2 task', parallelGroup: 'g2' });

    base.updateTask(group1.id, { status: 'in_progress' });
    base.updateTask(group2.id, { status: 'in_progress' });

    expect(base.getTask(group1.id)?.status).toBe('pending');
    expect(base.getTask(group2.id)?.status).toBe('in_progress');
  });

  it('scoped store: same-namespace parallel siblings co-active', () => {
    const base = createTaskStore();
    const scoped = createScopedTaskStore(base, 'agent-a', 1);
    const sibling1 = scoped.createTask({ title: 'Sibling 1', parallelGroup: 'g1' });
    const sibling2 = scoped.createTask({ title: 'Sibling 2', parallelGroup: 'g1' });
    const sibling3 = scoped.createTask({ title: 'Sibling 3', parallelGroup: 'g1' });

    scoped.updateTask(sibling1.id, { status: 'in_progress' });
    scoped.updateTask(sibling2.id, { status: 'in_progress' });
    scoped.updateTask(sibling3.id, { status: 'in_progress' });

    expect(base.getTask(sibling1.id)?.status).toBe('in_progress');
    expect(base.getTask(sibling2.id)?.status).toBe('in_progress');
    expect(base.getTask(sibling3.id)?.status).toBe('in_progress');
  });

  it('scoped store: cross-namespace parallel siblings co-active', () => {
    const base = createTaskStore();
    const scopedA = createScopedTaskStore(base, 'agent-a', 1);
    const scopedB = createScopedTaskStore(base, 'agent-b', 1);
    const taskA = scopedA.createTask({ title: 'Agent A sibling', parallelGroup: 'g1' });
    const taskB = scopedB.createTask({ title: 'Agent B sibling', parallelGroup: 'g1' });

    scopedA.updateTask(taskA.id, { status: 'in_progress' });
    scopedB.updateTask(taskB.id, { status: 'in_progress' });

    expect(base.getTask(taskA.id)?.status).toBe('in_progress');
    expect(base.getTask(taskB.id)?.status).toBe('in_progress');
  });

  it('base store: createTask with in_progress + parallelGroup co-exists with sibling already in_progress', () => {
    const base = createTaskStore();
    const sibling1 = base.createTask({
      title: 'Sibling 1',
      parallelGroup: 'g1',
      status: 'in_progress',
    });
    const sibling2 = base.createTask({
      title: 'Sibling 2',
      parallelGroup: 'g1',
      status: 'in_progress',
    });

    expect(base.getTask(sibling1.id)?.status).toBe('in_progress');
    expect(base.getTask(sibling2.id)?.status).toBe('in_progress');
  });

  it('scoped store: createTask with in_progress + parallelGroup co-exists with sibling already in_progress', () => {
    const base = createTaskStore();
    const scoped = createScopedTaskStore(base, 'agent-a', 1);
    const sibling1 = scoped.createTask({
      title: 'Sibling 1',
      parallelGroup: 'g1',
      status: 'in_progress',
    });
    const sibling2 = scoped.createTask({
      title: 'Sibling 2',
      parallelGroup: 'g1',
      status: 'in_progress',
    });

    expect(base.getTask(sibling1.id)?.status).toBe('in_progress');
    expect(base.getTask(sibling2.id)?.status).toBe('in_progress');
  });
});

// ---------------------------------------------------------------------------
// 4. Scoped replaceWithTodos
// ---------------------------------------------------------------------------

describe('scoped replaceWithTodos', () => {
  it('only clears tasks in calling namespace', () => {
    const base = createTaskStore();

    const now = Date.now();
    base._setRawTask('1', {
      id: '1',
      title: 'Agent A task',
      owner: 'agent-a',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    base._setRawTask('2', {
      id: '2',
      title: 'Agent B task',
      owner: 'agent-b',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    base._setNextTaskId(3);

    const scopedA = createScopedTaskStore(base, 'agent-a', 1);
    scopedA.replaceWithTodos([{ content: 'New task for A' }]);

    const tasks = base.listTasks();
    const agentBTasks = tasks.filter((t) => t.owner === 'agent-b');
    const agentATasks = tasks.filter((t) => t.owner === 'agent-a');

    // agent-b's task still exists
    expect(agentBTasks).toHaveLength(1);
    expect(agentBTasks[0].title).toBe('Agent B task');

    // agent-a's old task replaced with new one
    expect(agentATasks).toHaveLength(1);
    expect(agentATasks[0].title).toBe('New task for A');
  });

  it('preserves global task ID counter', () => {
    const base = createTaskStore();
    base.createTask({ title: 'Task 1' });
    base.createTask({ title: 'Task 2' });
    base.createTask({ title: 'Task 3' });

    // IDs 1, 2, 3 used; nextTaskId should be 4
    expect(base._getNextTaskId()).toBe(4);

    const scoped = createScopedTaskStore(base, 'agent-a', 1);
    scoped.replaceWithTodos([{ content: 'Replacement task' }]);

    // New task should have ID >= 4 (not reset to 1)
    const tasks = base.listTasks();
    const agentATasks = tasks.filter((t) => t.owner === 'agent-a');
    expect(agentATasks).toHaveLength(1);
    expect(Number(agentATasks[0].id)).toBeGreaterThanOrEqual(4);
  });

  it('replaceWithTodos with empty array clears only namespace tasks', () => {
    const base = createTaskStore();

    const now = Date.now();
    base._setRawTask('1', {
      id: '1',
      title: 'Agent A task',
      owner: 'agent-a',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    base._setRawTask('2', {
      id: '2',
      title: 'Other task',
      owner: 'agent-b',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    base._setNextTaskId(3);

    const scopedA = createScopedTaskStore(base, 'agent-a', 1);
    scopedA.replaceWithTodos([]);

    const tasks = base.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].owner).toBe('agent-b');
  });
});

// ---------------------------------------------------------------------------
// 4. Cross-Namespace Blockers
// ---------------------------------------------------------------------------

describe('cross-namespace blockers', () => {
  it('task in namespace A can be blocked by task in namespace B', () => {
    const base = createTaskStore();

    const now = Date.now();
    base._setRawTask('1', {
      id: '1',
      title: 'Blocker task',
      owner: 'agent-b',
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    });
    base._setRawTask('2', {
      id: '2',
      title: 'Blocked task',
      owner: 'agent-a',
      status: 'pending',
      blockers: ['1'],
      createdAt: now,
      updatedAt: now,
    });
    base._setNextTaskId(3);

    base._refreshBlockedTasks();

    const blockedTask = base.getTask('2');
    expect(blockedTask!.status).toBe('blocked');
  });

  it('completing a blocker in namespace B unblocks task in namespace A', () => {
    const base = createTaskStore();

    const now = Date.now();
    base._setRawTask('1', {
      id: '1',
      title: 'Blocker task',
      owner: 'agent-b',
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    });
    base._setRawTask('2', {
      id: '2',
      title: 'Blocked task',
      owner: 'agent-a',
      status: 'pending',
      blockers: ['1'],
      createdAt: now,
      updatedAt: now,
    });
    base._setNextTaskId(3);

    base._refreshBlockedTasks();
    expect(base.getTask('2')!.status).toBe('blocked');

    // Complete the blocker
    base.updateTask('1', { status: 'completed' });

    // updateTask calls refreshBlockedTasks internally
    expect(base.getTask('2')!.status).toBe('pending');
  });

  it('scoped store can create tasks with cross-namespace blockers', () => {
    const base = createTaskStore();

    const now = Date.now();
    base._setRawTask('1', {
      id: '1',
      title: 'Blocker in agent-b',
      owner: 'agent-b',
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    });
    base._setNextTaskId(2);

    const scopedA = createScopedTaskStore(base, 'agent-a', 1);
    const task = scopedA.createTask({
      title: 'Depends on agent-b',
      blockers: ['1'],
    });

    expect(task.status).toBe('blocked');
    expect(task.owner).toBe('agent-a');
  });
});

// ---------------------------------------------------------------------------
// 5. Export/Import State
// ---------------------------------------------------------------------------

describe('exportState and importState', () => {
  it('round-trips task store state', () => {
    const base = createTaskStore();
    base.createTask({ title: 'Task A', status: 'completed' });
    base.createTask({ title: 'Task B', status: 'in_progress', priority: 'high' });
    base.createTask({ title: 'Task C', notes: 'Some notes' });

    const exported = base.exportState();
    expect(exported.tasks).toHaveLength(3);

    const restored = createTaskStore();
    restored.importState(exported);

    const restoredTasks = restored.listTasks();
    expect(restoredTasks).toHaveLength(3);
    expect(restoredTasks[0].title).toBe('Task A');
    expect(restoredTasks[0].status).toBe('completed');
    expect(restoredTasks[1].title).toBe('Task B');
    expect(restoredTasks[1].status).toBe('in_progress');
    expect(restoredTasks[1].priority).toBe('high');
    expect(restoredTasks[2].title).toBe('Task C');
    expect(restoredTasks[2].notes).toBe('Some notes');
  });

  it('importState preserves task IDs and sets nextTaskId correctly', () => {
    const base = createTaskStore();

    const now = Date.now();
    const state = {
      tasks: [
        { id: '5', title: 'Task 5', status: 'pending' as const, createdAt: now, updatedAt: now },
        { id: '10', title: 'Task 10', status: 'pending' as const, createdAt: now, updatedAt: now },
        { id: '15', title: 'Task 15', status: 'pending' as const, createdAt: now, updatedAt: now },
      ],
      nextTaskId: 16,
    };

    base.importState(state);

    expect(base._getNextTaskId()).toBeGreaterThanOrEqual(16);

    // New task should get ID > 15
    const newTask = base.createTask({ title: 'New task' });
    expect(Number(newTask.id)).toBeGreaterThan(15);
  });

  it('importState handles empty state', () => {
    const base = createTaskStore();
    base.createTask({ title: 'Existing' });

    base.importState({ tasks: [], nextTaskId: 1 });

    expect(base.listTasks()).toHaveLength(0);
    expect(base._getNextTaskId()).toBe(1);
  });

  it('importState handles nextTaskId lower than max existing ID', () => {
    const base = createTaskStore();
    const now = Date.now();

    base.importState({
      tasks: [
        { id: '20', title: 'Task 20', status: 'pending' as const, createdAt: now, updatedAt: now },
      ],
      nextTaskId: 5, // lower than max ID
    });

    // Should be at least 21 (max ID + 1)
    expect(base._getNextTaskId()).toBeGreaterThanOrEqual(21);
  });

  it('exportState includes owner field', () => {
    const base = createTaskStore();
    const scoped = createScopedTaskStore(base, 'researcher', 1);
    scoped.createTask({ title: 'Research task' });

    const exported = base.exportState();
    expect(exported.tasks[0].owner).toBe('researcher');
  });
});

// ---------------------------------------------------------------------------
// 6. Mission Tools
// ---------------------------------------------------------------------------

describe('MissionSet tool', () => {
  it('creates mission tasks with correct owner', async () => {
    const base = createTaskStore();
    const context: BuiltinToolContext = {
      taskStore: base,
      taskStoreInternal: base,
      depth: 0,
    };

    const result = await executeBuiltinTool('MissionSet', {
      goal: 'Build a shared task store',
      done_criteria: 'All tests pass',
    }, context);

    expect(result.isError).toBe(false);

    const tasks = base.listTasks();
    const missionTasks = tasks.filter((t) => t.owner === 'mission');
    expect(missionTasks.length).toBeGreaterThanOrEqual(2);

    const goalTask = missionTasks.find((t) => t.notes === 'goal');
    expect(goalTask).toBeDefined();
    expect(goalTask!.title).toBe('Build a shared task store');

    const criteriaTask = missionTasks.find((t) => t.notes === 'done_criteria');
    expect(criteriaTask).toBeDefined();
    expect(criteriaTask!.title).toBe('All tests pass');
  });

  it('rejects calls from depth > 0', async () => {
    const base = createTaskStore();
    const context: BuiltinToolContext = {
      taskStore: base,
      taskStoreInternal: base,
      depth: 1,
    };

    const result = await executeBuiltinTool('MissionSet', {
      goal: 'Should fail',
    }, context);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('only available to the main agent');
  });

  it('updates existing mission goal', async () => {
    const base = createTaskStore();
    const context: BuiltinToolContext = {
      taskStore: base,
      taskStoreInternal: base,
      depth: 0,
    };

    await executeBuiltinTool('MissionSet', {
      goal: 'Original goal',
    }, context);

    await executeBuiltinTool('MissionSet', {
      goal: 'Updated goal',
    }, context);

    const tasks = base.listTasks();
    const goalTasks = tasks.filter((t) => t.owner === 'mission' && t.notes === 'goal');
    expect(goalTasks).toHaveLength(1);
    expect(goalTasks[0].title).toBe('Updated goal');
  });

  it('sets constraints when provided', async () => {
    const base = createTaskStore();
    const context: BuiltinToolContext = {
      taskStore: base,
      taskStoreInternal: base,
      depth: 0,
    };

    const result = await executeBuiltinTool('MissionSet', {
      goal: 'Build feature',
      constraints: 'Must be backward compatible',
    }, context);

    expect(result.isError).toBe(false);

    const tasks = base.listTasks();
    const constraintTask = tasks.find((t) => t.owner === 'mission' && t.notes === 'constraints');
    expect(constraintTask).toBeDefined();
    expect(constraintTask!.title).toBe('Must be backward compatible');
  });

  it('requires goal field', async () => {
    const base = createTaskStore();
    const context: BuiltinToolContext = {
      taskStore: base,
      taskStoreInternal: base,
      depth: 0,
    };

    const result = await executeBuiltinTool('MissionSet', {
      done_criteria: 'No goal provided',
    }, context);

    expect(result.isError).toBe(true);
  });
});

describe('GetMissionContext tool', () => {
  it('returns structured mission context and full task board', async () => {
    const base = createTaskStore();
    const context: BuiltinToolContext = {
      taskStore: base,
      taskStoreInternal: base,
      depth: 0,
    };

    // Set mission
    await executeBuiltinTool('MissionSet', {
      goal: 'Implement feature X',
      done_criteria: 'All tests pass',
    }, context);

    // Add a regular task
    base.createTask({ title: 'Regular task' });

    const result = await executeBuiltinTool('GetMissionContext', {}, context);
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.output);
    expect(parsed.mission.goal).toBe('Implement feature X');
    expect(parsed.mission.done_criteria).toBe('All tests pass');
    expect(parsed.tasks.length).toBeGreaterThanOrEqual(3); // 2 mission + 1 regular
  });

  it('returns empty mission when none set', async () => {
    const base = createTaskStore();
    const context: BuiltinToolContext = { taskStore: base };

    const result = await executeBuiltinTool('GetMissionContext', {}, context);
    expect(result.isError).toBe(false);

    const parsed = JSON.parse(result.output);
    expect(parsed.mission.goal).toBeUndefined();
    expect(parsed.mission.done_criteria).toBeUndefined();
    expect(parsed.tasks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. SummarizeResult Tool
// ---------------------------------------------------------------------------

describe('SummarizeResult tool', () => {
  it('creates a completed result task in agent namespace', async () => {
    const base = createTaskStore();
    const scoped = createScopedTaskStore(base, 'researcher', 1);
    const context: BuiltinToolContext = {
      taskStore: scoped,
      depth: 1,
      agentNamespace: 'main/researcher',
    };

    const result = await executeBuiltinTool('SummarizeResult', {
      summary: 'Found 3 key insights about the topic.',
    }, context);

    expect(result.isError).toBe(false);

    const tasks = base.listTasks();
    const resultTask = tasks.find((t) => t.title === 'Result Summary');
    expect(resultTask).toBeDefined();
    expect(resultTask!.notes).toBe('Found 3 key insights about the topic.');
    expect(resultTask!.owner).toBe('researcher');
    expect(resultTask!.status).toBe('completed');
    expect(resultTask!.kind).toBe('orchestration');
  });

  it('requires summary field', async () => {
    const base = createTaskStore();
    const context: BuiltinToolContext = { taskStore: base };

    const result = await executeBuiltinTool('SummarizeResult', {}, context);
    expect(result.isError).toBe(true);
  });

  it('works with base store (no scoping)', async () => {
    const base = createTaskStore();
    const context: BuiltinToolContext = {
      taskStore: base,
      depth: 0,
      agentNamespace: 'main',
    };

    const result = await executeBuiltinTool('SummarizeResult', {
      summary: 'Summary from main agent',
    }, context);

    expect(result.isError).toBe(false);

    const tasks = base.listTasks();
    const resultTask = tasks.find((t) => t.title === 'Result Summary');
    expect(resultTask).toBeDefined();
    expect(resultTask!.notes).toBe('Summary from main agent');
    expect(resultTask!.status).toBe('completed');
    expect(resultTask!.kind).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Integration: Multiple Scoped Stores on Same Base
// ---------------------------------------------------------------------------

describe('multi-agent shared store integration', () => {
  it('two scoped stores share the same base and see each others tasks', () => {
    const base = createTaskStore();
    const scopedA = createScopedTaskStore(base, 'agent-a', 1);
    const scopedB = createScopedTaskStore(base, 'agent-b', 1);

    scopedA.createTask({ title: 'Task from A' });
    scopedB.createTask({ title: 'Task from B' });

    // Both can see all tasks
    expect(scopedA.listTasks()).toHaveLength(2);
    expect(scopedB.listTasks()).toHaveLength(2);
    expect(base.listTasks()).toHaveLength(2);

    // Owners are correct
    const tasks = base.listTasks();
    expect(tasks.find((t) => t.title === 'Task from A')!.owner).toBe('agent-a');
    expect(tasks.find((t) => t.title === 'Task from B')!.owner).toBe('agent-b');
  });

  it('scoped replaceWithTodos does not interfere across namespaces', () => {
    const base = createTaskStore();
    const scopedA = createScopedTaskStore(base, 'agent-a', 1);
    const scopedB = createScopedTaskStore(base, 'agent-b', 1);

    scopedA.createTask({ title: 'A1' });
    scopedA.createTask({ title: 'A2' });
    scopedB.createTask({ title: 'B1' });

    // Replace agent-a's tasks
    scopedA.replaceWithTodos([{ content: 'A-new' }]);

    const tasks = base.listTasks();
    expect(tasks.filter((t) => t.owner === 'agent-a')).toHaveLength(1);
    expect(tasks.filter((t) => t.owner === 'agent-a')[0].title).toBe('A-new');
    expect(tasks.filter((t) => t.owner === 'agent-b')).toHaveLength(1);
    expect(tasks.filter((t) => t.owner === 'agent-b')[0].title).toBe('B1');
  });

  it('mission tools work alongside scoped agent tasks', async () => {
    const base = createTaskStore();
    const scoped = createScopedTaskStore(base, 'researcher', 1);

    // Set mission via base context
    const context: BuiltinToolContext = {
      taskStore: base,
      taskStoreInternal: base,
      depth: 0,
    };
    await executeBuiltinTool('MissionSet', { goal: 'Research topic X' }, context);

    // Agent creates tasks via scoped store
    scoped.createTask({ title: 'Search databases' });
    scoped.createTask({ title: 'Analyze results' });

    // All visible from scoped store
    const tasks = scoped.listTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(3); // mission + 2 agent tasks

    // Mission context readable via GetMissionContext
    const missionResult = await executeBuiltinTool('GetMissionContext', {}, { taskStore: scoped });
    const parsed = JSON.parse(missionResult.output);
    expect(parsed.mission.goal).toBe('Research topic X');
  });

  it('task ID counter is globally consistent across scoped stores', () => {
    const base = createTaskStore();
    const scopedA = createScopedTaskStore(base, 'agent-a', 1);
    const scopedB = createScopedTaskStore(base, 'agent-b', 1);

    const t1 = scopedA.createTask({ title: 'A1' });
    const t2 = scopedB.createTask({ title: 'B1' });
    const t3 = scopedA.createTask({ title: 'A2' });

    // IDs should be sequential and unique
    expect(Number(t1.id)).toBeLessThan(Number(t2.id));
    expect(Number(t2.id)).toBeLessThan(Number(t3.id));
  });
});

// ---------------------------------------------------------------------------
// 9. Turn Archive
// ---------------------------------------------------------------------------

describe('archiveTurn', () => {
  it('creates archive entry, clears active store, preserves nextTaskId', () => {
    const store = createTaskStore();
    store.createTask({ title: 'Task A' });
    store.createTask({ title: 'Task B' });
    store.createTask({ title: 'Task C' });

    const nextIdBefore = store._getNextTaskId();
    expect(nextIdBefore).toBe(4);

    store.archiveTurn();

    // Active store is now empty
    expect(store.listTasks()).toHaveLength(0);

    // nextTaskId is preserved (not reset)
    expect(store._getNextTaskId()).toBe(4);

    // Archive contains the tasks
    const archived = store.getArchivedTurns();
    expect(archived).toHaveLength(1);
    expect(archived[0].turnNumber).toBe(1);
    expect(archived[0].tasks).toHaveLength(3);
    expect(archived[0].tasks.map((t) => t.title)).toEqual(['Task A', 'Task B', 'Task C']);
  });

  it('is a no-op when active store is empty (no phantom turns)', () => {
    const store = createTaskStore();

    store.archiveTurn();

    expect(store.getArchivedTurns()).toHaveLength(0);

    // Double archive on empty store should also be no-op
    store.archiveTurn();
    expect(store.getArchivedTurns()).toHaveLength(0);
  });

  it('multiple archive cycles accumulate correctly', () => {
    const store = createTaskStore();

    // Turn 1: create 2 tasks
    store.createTask({ title: 'Turn 1 - Task A' });
    store.createTask({ title: 'Turn 1 - Task B' });
    store.archiveTurn();

    // Turn 2: create 3 tasks (IDs continue from 3)
    const t3 = store.createTask({ title: 'Turn 2 - Task C' });
    store.createTask({ title: 'Turn 2 - Task D' });
    store.createTask({ title: 'Turn 2 - Task E' });
    expect(Number(t3.id)).toBe(3);
    store.archiveTurn();

    // Turn 3: create 1 task (ID continues from 6)
    const t6 = store.createTask({ title: 'Turn 3 - Task F' });
    expect(Number(t6.id)).toBe(6);

    // Archive has 2 entries (most recent first)
    const archived = store.getArchivedTurns();
    expect(archived).toHaveLength(2);
    expect(archived[0].turnNumber).toBe(2);
    expect(archived[0].tasks).toHaveLength(3);
    expect(archived[1].turnNumber).toBe(1);
    expect(archived[1].tasks).toHaveLength(2);

    // Active store has only current turn's task
    expect(store.listTasks()).toHaveLength(1);
    expect(store.listTasks()[0].title).toBe('Turn 3 - Task F');
  });

  it('nextTaskId monotonicity is preserved across archives', () => {
    const store = createTaskStore();

    store.createTask({ title: 'Task 1' });
    store.createTask({ title: 'Task 2' });
    expect(store._getNextTaskId()).toBe(3);

    store.archiveTurn();
    expect(store._getNextTaskId()).toBe(3);

    const newTask = store.createTask({ title: 'Task 3' });
    expect(newTask.id).toBe('3');
    expect(store._getNextTaskId()).toBe(4);
  });

  it('archive on empty after prior archive does not create phantom entry', () => {
    const store = createTaskStore();

    store.createTask({ title: 'Task 1' });
    store.archiveTurn();
    expect(store.getArchivedTurns()).toHaveLength(1);

    // Active store is empty now — second archive should be no-op
    store.archiveTurn();
    expect(store.getArchivedTurns()).toHaveLength(1);
  });

  it('archived tasks are deep clones (mutations do not leak)', () => {
    const store = createTaskStore();
    store.createTask({ title: 'Original', blockers: ['999'] });
    store.archiveTurn();

    const archived = store.getArchivedTurns();
    archived[0].tasks[0].title = 'Mutated';
    archived[0].tasks[0].blockers!.push('888');

    // Original archive should be unchanged
    const fresh = store.getArchivedTurns();
    expect(fresh[0].tasks[0].title).toBe('Original');
    expect(fresh[0].tasks[0].blockers).toEqual(['999']);
  });
});

// ---------------------------------------------------------------------------
// 10. Missing Blocker IDs (treated as resolved)
// ---------------------------------------------------------------------------

describe('missing blocker IDs treated as resolved', () => {
  it('task with missing blocker ID is not trapped in blocked state', () => {
    const store = createTaskStore();

    const now = Date.now();
    // Create a task blocked by a non-existent ID (e.g., from archived turn)
    store._setRawTask('5', {
      id: '5',
      title: 'Depends on archived task',
      status: 'pending',
      blockers: ['999'], // task 999 does not exist
      createdAt: now,
      updatedAt: now,
    });
    store._setNextTaskId(6);

    store._refreshBlockedTasks();

    // Should NOT be blocked — missing blocker is treated as resolved
    expect(store.getTask('5')!.status).toBe('pending');
  });

  it('task with mix of existing incomplete and missing blockers stays blocked', () => {
    const store = createTaskStore();

    const now = Date.now();
    store._setRawTask('1', {
      id: '1',
      title: 'Existing blocker',
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    });
    store._setRawTask('2', {
      id: '2',
      title: 'Blocked task',
      status: 'pending',
      blockers: ['1', '999'], // 1 exists and is incomplete, 999 is missing
      createdAt: now,
      updatedAt: now,
    });
    store._setNextTaskId(3);

    store._refreshBlockedTasks();

    // Should be blocked — blocker 1 exists and is incomplete
    expect(store.getTask('2')!.status).toBe('blocked');
  });

  it('task unblocks when only existing blockers are completed', () => {
    const store = createTaskStore();

    const now = Date.now();
    store._setRawTask('1', {
      id: '1',
      title: 'Existing blocker',
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    });
    store._setRawTask('2', {
      id: '2',
      title: 'Blocked task',
      status: 'pending',
      blockers: ['1', '999'],
      createdAt: now,
      updatedAt: now,
    });
    store._setNextTaskId(3);

    store._refreshBlockedTasks();
    expect(store.getTask('2')!.status).toBe('blocked');

    // Complete the existing blocker
    store.updateTask('1', { status: 'completed' });

    // Should now be unblocked — 999 is missing (resolved), 1 is completed
    expect(store.getTask('2')!.status).toBe('pending');
  });

  it('creating a task with only missing blockers does not set blocked status', () => {
    const store = createTaskStore();

    const task = store.createTask({
      title: 'New task',
      blockers: ['999', '888'], // both non-existent
    });

    // Should be pending, not blocked
    expect(task.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// 11. replaceWithTodos nextTaskId Guard
// ---------------------------------------------------------------------------

describe('replaceWithTodos nextTaskId guard', () => {
  it('does not decrease nextTaskId after replacement', () => {
    const store = createTaskStore();

    // Create tasks to advance the counter
    store.createTask({ title: 'Task 1' });
    store.createTask({ title: 'Task 2' });
    store.createTask({ title: 'Task 3' });
    expect(store._getNextTaskId()).toBe(4);

    // Replace with fewer, lower-numbered todos
    store.replaceWithTodos([{ content: 'Todo A' }]);

    // nextTaskId should still be >= 4 (not reset to 2)
    expect(store._getNextTaskId()).toBeGreaterThanOrEqual(4);
  });

  it('nextTaskId guard works after archive + replaceWithTodos', () => {
    const store = createTaskStore();

    // Turn 1: create tasks to ID 5
    for (let i = 0; i < 5; i++) {
      store.createTask({ title: `Task ${i + 1}` });
    }
    expect(store._getNextTaskId()).toBe(6);

    // Archive
    store.archiveTurn();
    expect(store._getNextTaskId()).toBe(6);

    // Replace with single todo — should not reset counter
    store.replaceWithTodos([{ content: 'Fresh todo' }]);
    expect(store._getNextTaskId()).toBeGreaterThanOrEqual(6);
  });

  it('replaceWithTodos with explicit high IDs can still increase counter', () => {
    const store = createTaskStore();
    store.createTask({ title: 'Task 1' });
    expect(store._getNextTaskId()).toBe(2);

    store.replaceWithTodos([{ id: '100', content: 'High ID todo' }]);

    // Counter should be at least 101
    expect(store._getNextTaskId()).toBeGreaterThanOrEqual(101);
  });
});

// ---------------------------------------------------------------------------
// 12. Export/Import with Archive
// ---------------------------------------------------------------------------

describe('exportState/importState with archive', () => {
  it('round-trips task store state including archive', () => {
    const store = createTaskStore();

    // Turn 1
    store.createTask({ title: 'Turn 1 - A', status: 'completed' });
    store.createTask({ title: 'Turn 1 - B', status: 'completed' });
    store.archiveTurn();

    // Turn 2
    store.createTask({ title: 'Turn 2 - C', status: 'in_progress' });

    const exported = store.exportState();

    // Verify export structure
    expect(exported.archivedTurns).toHaveLength(1);
    expect(exported.archivedTurns![0].turnNumber).toBe(1);
    expect(exported.archivedTurns![0].tasks).toHaveLength(2);
    expect(exported.nextTurnNumber).toBe(2);
    expect(exported.tasks).toHaveLength(1);

    // Import into fresh store
    const restored = createTaskStore();
    restored.importState(exported);

    // Active tasks restored
    expect(restored.listTasks()).toHaveLength(1);
    expect(restored.listTasks()[0].title).toBe('Turn 2 - C');

    // Archive restored
    const restoredArchive = restored.getArchivedTurns();
    expect(restoredArchive).toHaveLength(1);
    expect(restoredArchive[0].turnNumber).toBe(1);
    expect(restoredArchive[0].tasks).toHaveLength(2);

    // nextTaskId continues correctly
    const newTask = restored.createTask({ title: 'New after restore' });
    expect(Number(newTask.id)).toBeGreaterThanOrEqual(4);
  });

  it('importState without archivedTurns (backward compatibility)', () => {
    const store = createTaskStore();
    const now = Date.now();

    // Import v1-style state (no archive fields)
    store.importState({
      tasks: [
        { id: '1', title: 'Old task', status: 'completed' as const, createdAt: now, updatedAt: now },
      ],
      nextTaskId: 2,
    });

    // Active tasks loaded
    expect(store.listTasks()).toHaveLength(1);
    expect(store.listTasks()[0].title).toBe('Old task');

    // Archive is empty
    expect(store.getArchivedTurns()).toHaveLength(0);

    // nextTaskId correct
    expect(store._getNextTaskId()).toBe(2);

    // Turn number starts at 1
    const exported = store.exportState();
    expect(exported.nextTurnNumber).toBe(1);
  });

  it('importState recomputes nextTaskId from archived task IDs', () => {
    const store = createTaskStore();
    const now = Date.now();

    store.importState({
      tasks: [
        { id: '3', title: 'Active', status: 'pending' as const, createdAt: now, updatedAt: now },
      ],
      nextTaskId: 4,
      archivedTurns: [
        {
          turnNumber: 1,
          tasks: [
            { id: '50', title: 'Archived high ID', status: 'completed' as const, createdAt: now, updatedAt: now },
          ],
        },
      ],
      nextTurnNumber: 2,
    });

    // nextTaskId should be at least 51 (max across active '3' and archived '50')
    expect(store._getNextTaskId()).toBeGreaterThanOrEqual(51);

    // New task gets ID >= 51
    const newTask = store.createTask({ title: 'After import' });
    expect(Number(newTask.id)).toBeGreaterThanOrEqual(51);
  });

  it('importState restores nextTurnNumber from state', () => {
    const store = createTaskStore();

    store.importState({
      tasks: [],
      nextTaskId: 1,
      archivedTurns: [
        { turnNumber: 1, tasks: [] },
        { turnNumber: 2, tasks: [] },
      ],
      nextTurnNumber: 5,
    });

    // Should use the explicit nextTurnNumber from state
    const exported = store.exportState();
    expect(exported.nextTurnNumber).toBe(5);
  });

  it('importState computes nextTurnNumber when missing', () => {
    const store = createTaskStore();
    const now = Date.now();

    store.importState({
      tasks: [],
      nextTaskId: 1,
      archivedTurns: [
        {
          turnNumber: 3,
          tasks: [
            { id: '1', title: 'T', status: 'completed' as const, createdAt: now, updatedAt: now },
          ],
        },
      ],
      // nextTurnNumber is missing — should be computed as max(turnNumbers) + 1 = 4
    });

    const exported = store.exportState();
    expect(exported.nextTurnNumber).toBe(4);
  });

  it('archive survives multiple import/export cycles', () => {
    const store = createTaskStore();

    // Build up multi-turn history
    store.createTask({ title: 'T1' });
    store.archiveTurn();
    store.createTask({ title: 'T2' });
    store.archiveTurn();
    store.createTask({ title: 'T3' });

    // Cycle 1
    const exported1 = store.exportState();
    const store2 = createTaskStore();
    store2.importState(exported1);

    // Cycle 2
    const exported2 = store2.exportState();
    const store3 = createTaskStore();
    store3.importState(exported2);

    // Verify final state
    expect(store3.listTasks()).toHaveLength(1);
    expect(store3.listTasks()[0].title).toBe('T3');
    expect(store3.getArchivedTurns()).toHaveLength(2);
    expect(store3._getNextTaskId()).toBeGreaterThanOrEqual(4);
  });
});
