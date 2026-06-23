/**
 * User Tasks Store
 *
 * Persists user tasks for the Scratchpad tasks panel.
 * Designed for future sync with Linear and other external systems.
 */

import { randomUUID } from 'node:crypto';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import type { UserTask, UserTasksState, UserTaskStatus } from '@shared/types';
import { classifyLoadFailure, resolveConfStorePath } from '@core/utils/loadStoreSafely';

const log = createScopedLogger({ service: 'userTasksStore' });

const USER_TASKS_STORE_VERSION = 1;

type UserTasksStoreShape = Record<string, unknown> & UserTasksState;

const createDefaultState = (): UserTasksStoreShape => ({
  version: USER_TASKS_STORE_VERSION,
  tasks: [],
});

let _userTasksStore: KeyValueStore<UserTasksStoreShape> | null = null;
const getUserTasksStore = (): KeyValueStore<UserTasksStoreShape> => {
  if (!_userTasksStore) {
    _userTasksStore = createStore<UserTasksStoreShape>({
      name: 'user-tasks',
      defaults: createDefaultState(),
    });
  }
  return _userTasksStore;
};

// Load-failure read-only latch. Set true when a load fails on EXISTING data
// (corrupt/unreadable); blocks writes so they can't clobber the preserved file.
let userTasksReadOnlyMode = false;
let _userTasksLoadRan = false;

// Listener pattern for real-time updates
type UserTasksListener = (state: UserTasksState) => void;
const listeners = new Set<UserTasksListener>();

const emitUserTasksState = (state: UserTasksState): void => {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (error) {
      log.warn({ err: error }, 'User tasks listener failed');
    }
  }
};

export const onUserTasksStateChange = (listener: UserTasksListener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const normalizeTask = (task: unknown, fallbackTitle: string): UserTask | null => {
  if (!task || typeof task !== 'object') return null;
  
  const data = task as Record<string, unknown>;
  const title = isNonEmptyString(data.title) ? data.title.trim() : fallbackTitle;
  const id = isNonEmptyString(data.id) ? data.id : randomUUID();
  const status = ['todo', 'in_progress', 'done', 'cancelled'].includes(data.status as string)
    ? (data.status as UserTaskStatus)
    : 'todo';
  const now = Date.now();
  
  return {
    id,
    title,
    description: isNonEmptyString(data.description) ? data.description : undefined,
    status,
    dueDate: typeof data.dueDate === 'number' ? data.dueDate : null,
    priority: ['urgent', 'high', 'medium', 'low', 'none'].includes(data.priority as string)
      ? (data.priority as UserTask['priority'])
      : undefined,
    labels: Array.isArray(data.labels)
      ? data.labels.filter((l): l is string => typeof l === 'string')
      : undefined,
    externalId: isNonEmptyString(data.externalId) ? data.externalId : null,
    externalUrl: isNonEmptyString(data.externalUrl) ? data.externalUrl : null,
    syncSource: isNonEmptyString(data.syncSource) ? data.syncSource : null,
    syncedAt: typeof data.syncedAt === 'number' ? data.syncedAt : null,
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : now,
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : now,
    completedAt: typeof data.completedAt === 'number' ? data.completedAt : null,
  };
};

const loadUserTasksInternal = (): UserTasksState => {
  try {
    const stored = getUserTasksStore().store;
    const tasks = Array.isArray(stored.tasks)
      ? stored.tasks
          .map((t, i) => normalizeTask(t, `Task ${i + 1}`))
          .filter((t): t is UserTask => t !== null)
      : [];

    _userTasksLoadRan = true;
    return {
      version: USER_TASKS_STORE_VERSION,
      tasks,
    };
  } catch (error) {
    // NEVER reset+persist over real on-disk data. Classify ENOENT (fresh init)
    // vs existing-but-unreadable (preserve raw + back up + latch read-only).
    _userTasksLoadRan = true;
    const classified = classifyLoadFailure('user-tasks', resolveConfStorePath('user-tasks'), error);
    if (classified.outcome === 'load-failed') {
      userTasksReadOnlyMode = true;
    }
    return createDefaultState();
  }
};

/**
 * Read-only check that GUARANTEES load has run first. A writer that read the
 * bare flag as the FIRST touch (no prior read) would see a stale `false` and
 * could clobber a real, unreadable file with defaults. Use in EVERY writer.
 */
const isUserTasksReadOnly = (): boolean => {
  if (!_userTasksLoadRan) {
    loadUserTasksInternal();
  }
  return userTasksReadOnlyMode;
};

const saveUserTasksInternal = (state: UserTasksState): void => {
  // Load FIRST so the read-only latch is authoritative for a first-touch save
  // (no recursion — load never calls save). Blocks writes when the on-disk file
  // is preserved-but-unreadable, so we can't clobber it with defaults.
  if (isUserTasksReadOnly()) {
    log.warn('Skipping user tasks save - operating in read-only mode');
    return;
  }
  getUserTasksStore().store = {
    version: USER_TASKS_STORE_VERSION,
    tasks: state.tasks,
  };
};

export const getUserTasksState = (): UserTasksState => loadUserTasksInternal();

export const addUserTask = (input: { title: string; dueDate?: number | null }): UserTasksState => {
  if (!isNonEmptyString(input.title)) {
    throw new Error('Task title is required.');
  }

  const state = loadUserTasksInternal();
  const now = Date.now();
  
  const task: UserTask = {
    id: randomUUID(),
    title: input.title.trim(),
    status: 'todo',
    dueDate: input.dueDate ?? null,
    createdAt: now,
    updatedAt: now,
  };

  const nextState: UserTasksState = {
    version: USER_TASKS_STORE_VERSION,
    tasks: [task, ...state.tasks],
  };

  saveUserTasksInternal(nextState);
  emitUserTasksState(nextState);
  log.info({ taskId: task.id, title: task.title }, 'Added user task');
  return nextState;
};

export const updateUserTask = (
  taskId: string,
  patch: Partial<Pick<UserTask, 'title' | 'description' | 'status' | 'dueDate' | 'priority' | 'labels'>>
): UserTasksState => {
  const state = loadUserTasksInternal();
  const taskIndex = state.tasks.findIndex((t) => t.id === taskId);
  
  if (taskIndex === -1) {
    throw new Error('Task not found.');
  }

  const original = state.tasks[taskIndex];
  const now = Date.now();
  
  const updated: UserTask = {
    ...original,
    updatedAt: now,
  };

  if (patch.title !== undefined && isNonEmptyString(patch.title)) {
    updated.title = patch.title.trim();
  }
  if (patch.description !== undefined) {
    updated.description = isNonEmptyString(patch.description) ? patch.description : undefined;
  }
  if (patch.status !== undefined) {
    updated.status = patch.status;
    if (patch.status === 'done' && !updated.completedAt) {
      updated.completedAt = now;
    } else if (patch.status !== 'done') {
      updated.completedAt = null;
    }
  }
  if (patch.dueDate !== undefined) {
    updated.dueDate = patch.dueDate;
  }
  if (patch.priority !== undefined) {
    updated.priority = patch.priority;
  }
  if (patch.labels !== undefined) {
    updated.labels = patch.labels;
  }

  const nextTasks = [...state.tasks];
  nextTasks[taskIndex] = updated;

  const nextState: UserTasksState = {
    version: USER_TASKS_STORE_VERSION,
    tasks: nextTasks,
  };

  saveUserTasksInternal(nextState);
  emitUserTasksState(nextState);
  log.info({ taskId, patch: Object.keys(patch) }, 'Updated user task');
  return nextState;
};

export const deleteUserTask = (taskId: string): UserTasksState => {
  const state = loadUserTasksInternal();
  const nextState: UserTasksState = {
    version: USER_TASKS_STORE_VERSION,
    tasks: state.tasks.filter((t) => t.id !== taskId),
  };

  saveUserTasksInternal(nextState);
  emitUserTasksState(nextState);
  log.info({ taskId }, 'Deleted user task');
  return nextState;
};
