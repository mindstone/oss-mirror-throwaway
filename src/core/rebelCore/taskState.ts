export type RebelCoreTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';
export type RebelCoreTaskKind = 'orchestration' | 'work';

export interface RebelCoreContextState {
  taskContext: { goals: string; constraints: string; requirements: string; };
  keyDecisions: Array<{ choice: string; rationale: string; rejectedAlternatives: string[]; }>;
  artifacts: Array<{ pathOrUrl: string; identifier: string; }>;
  constraints: string[];
  progressState: { accomplished: string[]; remaining: string[]; blockers: string[]; failedApproaches: string[]; };
  recentContextSummary: string;
}

export const createEmptyContextState = (): RebelCoreContextState => ({
  taskContext: { goals: '', constraints: '', requirements: '' },
  keyDecisions: [],
  artifacts: [],
  constraints: [],
  progressState: { accomplished: [], remaining: [], blockers: [], failedApproaches: [] },
  recentContextSummary: '',
});

export interface RebelCoreTaskCreateInput {
  title: string;
  description?: string;
  status?: RebelCoreTaskStatus;
  kind?: RebelCoreTaskKind;
  priority?: RebelCoreTask['priority'];
  blockers?: string[];
  parallelGroup?: string;
  activeForm?: string;
  notes?: string;
}

export interface RebelCoreTaskUpdateInput {
  title?: string;
  description?: string;
  status?: RebelCoreTaskStatus;
  kind?: RebelCoreTaskKind;
  priority?: RebelCoreTask['priority'];
  blockers?: string[];
  parallelGroup?: string;
  activeForm?: string;
  notes?: string;
}

export interface RebelCoreTodoInput {
  id?: string;
  content: string;
  status?: RebelCoreTaskStatus;
  priority?: RebelCoreTask['priority'];
}

export interface RebelCoreTask {
  id: string;
  title: string;
  description?: string;
  owner?: string;
  status: RebelCoreTaskStatus;
  kind?: RebelCoreTaskKind;
  priority?: 'high' | 'medium' | 'low';
  blockers?: string[];
  parallelGroup?: string;
  activeForm?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ArchivedTurn {
  turnNumber: number;
  tasks: RebelCoreTask[];
}

export interface RebelCoreTaskStore {
  createTask(input: RebelCoreTaskCreateInput): RebelCoreTask;
  listTasks(): RebelCoreTask[];
  getTask(taskId: string): RebelCoreTask | null;
  updateTask(taskId: string, updates: RebelCoreTaskUpdateInput): RebelCoreTask | null;
  replaceWithTodos(todos: RebelCoreTodoInput[]): RebelCoreTask[];
  getContextState(): RebelCoreContextState;
  updateContextState(updates: Partial<RebelCoreContextState>): void;
  getCompactionDeferred?(): boolean;
  setCompactionDeferred?(deferred: boolean): void;
}

export interface RebelCoreTaskStoreState {
  tasks: RebelCoreTask[];
  nextTaskId: number;
  contextState?: RebelCoreContextState;
  archivedTurns?: ArchivedTurn[];
  nextTurnNumber?: number;
}

/**
 * Internal task-store helpers used by scoped wrappers and persistence.
 */
export interface RebelCoreTaskStoreInternal extends RebelCoreTaskStore {
  _getRawTask(taskId: string): RebelCoreTask | undefined;
  _setRawTask(taskId: string, task: RebelCoreTask): void;
  _deleteTask(taskId: string): boolean;
  _getAllTasks(): Map<string, RebelCoreTask>;
  _getNextTaskId(): number;
  _setNextTaskId(nextTaskId: number): void;
  _refreshBlockedTasks(): void;
  archiveTurn(): void;
  getArchivedTurns(): ArchivedTurn[];
  exportState(): RebelCoreTaskStoreState;
  importState(state: RebelCoreTaskStoreState): void;
}

const MAIN_NAMESPACE = 'main';

type RebelCoreTaskCreateInputInternal = RebelCoreTaskCreateInput & { owner?: string };

type RebelCoreTaskUpdateInputInternal = RebelCoreTaskUpdateInput & { owner?: string };

const dedupeStrings = (values?: string[]): string[] | undefined => {
  if (!values || values.length === 0) {
    return undefined;
  }

  const deduped = Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  );

  return deduped.length > 0 ? deduped : undefined;
};

const normalizeOptionalTaskText = (value?: string): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const cloneTask = (task: RebelCoreTask): RebelCoreTask => ({
  ...task,
  ...(task.blockers ? { blockers: [...task.blockers] } : {}),
});

const normalizeStatus = (status?: string): RebelCoreTaskStatus => {
  if (status === 'in_progress' || status === 'completed' || status === 'blocked') {
    return status;
  }
  return 'pending';
};

const normalizeOwner = (owner?: string): string => owner ?? MAIN_NAMESPACE;

export const tasksAreParallelSiblings = (a: RebelCoreTask, b: RebelCoreTask): boolean => {
  if (a.id === b.id) return false;
  const groupA = a.parallelGroup?.trim();
  const groupB = b.parallelGroup?.trim();
  return Boolean(groupA) && groupA === groupB;
};

/**
 * Checks whether any blocker tasks are still incomplete.
 *
 * Missing blocker IDs are skipped (treated as resolved). With per-turn task
 * stores, a missing blocker ID means the blocking task was from a previous turn
 * where it was completed and then archived. Treating missing IDs as incomplete
 * would permanently trap tasks in a 'blocked' state with no way to unblock them.
 */
const hasIncompleteBlockers = (
  tasks: Map<string, RebelCoreTask>,
  blockers?: string[],
): boolean => {
  if (!blockers || blockers.length === 0) {
    return false;
  }

  return blockers.some((blockerId) => {
    const blocker = tasks.get(blockerId);
    return blocker !== undefined && blocker.status !== 'completed';
  });
};

const resolveStatus = (
  tasks: Map<string, RebelCoreTask>,
  requestedStatus: RebelCoreTaskStatus | undefined,
  blockers?: string[],
): RebelCoreTaskStatus => {
  if (!hasIncompleteBlockers(tasks, blockers)) {
    return normalizeStatus(requestedStatus);
  }

  if (requestedStatus === 'completed') {
    return 'completed';
  }

  if (requestedStatus === 'in_progress') {
    throw new Error('Cannot mark a task in progress while blockers remain incomplete');
  }

  return 'blocked';
};

const demoteInProgressTasks = (
  tasks: Map<string, RebelCoreTask>,
  activeTask: RebelCoreTask,
  shouldDemote: (task: RebelCoreTask) => boolean,
): void => {
  const now = Date.now();
  for (const [taskId, task] of tasks.entries()) {
    if (
      taskId !== activeTask.id
      && task.status === 'in_progress'
      && !tasksAreParallelSiblings(activeTask, task)
      && shouldDemote(task)
    ) {
      tasks.set(taskId, {
        ...task,
        status: 'pending',
        updatedAt: now,
      });
    }
  }
};

const refreshBlockedTasks = (tasks: Map<string, RebelCoreTask>): void => {
  const now = Date.now();
  for (const [taskId, task] of tasks.entries()) {
    if (!task.blockers || task.blockers.length === 0 || task.status === 'completed') {
      continue;
    }

    const nextStatus = hasIncompleteBlockers(tasks, task.blockers) ? 'blocked' : 'pending';
    if (task.status !== nextStatus) {
      tasks.set(taskId, {
        ...task,
        status: nextStatus,
        updatedAt: now,
      });
    }
  }
};

const sortTasks = (tasks: Map<string, RebelCoreTask>): RebelCoreTask[] =>
  Array.from(tasks.values())
    .sort((left, right) => left.createdAt - right.createdAt)
    .map(cloneTask);

const createRawTask = (
  tasks: Map<string, RebelCoreTask>,
  nextTaskId: number,
  input: RebelCoreTaskCreateInputInternal,
): { task: RebelCoreTask; nextTaskId: number } => {
  const id = String(nextTaskId);
  const now = Date.now();
  const blockers = dedupeStrings(input.blockers);
  const parallelGroup = normalizeOptionalTaskText(input.parallelGroup);
  const status = resolveStatus(tasks, input.status, blockers);
  const task: RebelCoreTask = {
    id,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
    status,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    ...(blockers ? { blockers } : {}),
    ...(parallelGroup ? { parallelGroup } : {}),
    ...(input.activeForm ? { activeForm: input.activeForm } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    createdAt: now,
    updatedAt: now,
  };

  tasks.set(id, task);
  return { task, nextTaskId: nextTaskId + 1 };
};

const updateRawTask = (
  tasks: Map<string, RebelCoreTask>,
  taskId: string,
  updates: RebelCoreTaskUpdateInputInternal,
): RebelCoreTask | null => {
  const existing = tasks.get(taskId);
  if (!existing) {
    return null;
  }

  const blockers = updates.blockers !== undefined
    ? dedupeStrings(updates.blockers)
    : existing.blockers;
  const parallelGroup = updates.parallelGroup !== undefined
    ? normalizeOptionalTaskText(updates.parallelGroup)
    : existing.parallelGroup;
  const status = updates.status !== undefined
    ? resolveStatus(tasks, updates.status, blockers)
    : resolveStatus(tasks, existing.status, blockers);
  const baseTask = updates.parallelGroup !== undefined
    ? (() => {
        const { parallelGroup: _ignoredParallelGroup, ...rest } = existing;
        return rest;
      })()
    : existing;

  const updated: RebelCoreTask = {
    ...baseTask,
    ...(updates.title ? { title: updates.title } : {}),
    ...(updates.description !== undefined ? { description: updates.description } : {}),
    ...(updates.owner !== undefined ? { owner: updates.owner } : {}),
    status,
    ...(updates.kind !== undefined ? { kind: updates.kind } : {}),
    ...(updates.priority !== undefined ? { priority: updates.priority } : {}),
    ...(updates.blockers !== undefined ? { blockers } : {}),
    ...(parallelGroup ? { parallelGroup } : {}),
    ...(updates.activeForm !== undefined ? { activeForm: updates.activeForm } : {}),
    ...(updates.notes !== undefined ? { notes: updates.notes } : {}),
    updatedAt: Date.now(),
  };

  tasks.set(taskId, updated);
  return updated;
};

const toPositiveInteger = (value: number, fallback = 1): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
};

const canWriteToOwner = (taskOwner: string | undefined, callerNamespace: string, callerDepth: number): boolean => {
  if (callerDepth === 0) {
    return true;
  }

  const normalizedTaskOwner = normalizeOwner(taskOwner);
  return normalizedTaskOwner === callerNamespace
    || normalizedTaskOwner.startsWith(`${callerNamespace}/`);
};

export function createTaskStore(): RebelCoreTaskStoreInternal {
  const tasks = new Map<string, RebelCoreTask>();
  let nextTaskId = 1;
  let contextState = createEmptyContextState();
  let compactionDeferred = false;
  const archivedTurns: ArchivedTurn[] = [];
  let nextTurnNumber = 1;

  return {
    createTask(input) {
      const { task, nextTaskId: nextId } = createRawTask(tasks, nextTaskId, input);
      nextTaskId = nextId;
      if (task.status === 'in_progress') {
        demoteInProgressTasks(tasks, task, () => true);
      }
      refreshBlockedTasks(tasks);
      return cloneTask(task);
    },

    listTasks() {
      return sortTasks(tasks);
    },

    getTask(taskId) {
      const task = tasks.get(taskId);
      return task ? cloneTask(task) : null;
    },

    updateTask(taskId, updates) {
      const updated = updateRawTask(tasks, taskId, updates);
      if (!updated) {
        return null;
      }

      if (updated.status === 'in_progress') {
        demoteInProgressTasks(tasks, updated, () => true);
      }
      refreshBlockedTasks(tasks);
      return cloneTask(updated);
    },

    replaceWithTodos(todos) {
      // Guard: save current counter so it never decreases (prevents ID reuse after archiving)
      const previousNextTaskId = nextTaskId;
      tasks.clear();
      nextTaskId = 1;

      todos.forEach((todo) => {
        const created = this.createTask({
          title: todo.content,
          status: normalizeStatus(todo.status),
          priority: todo.priority,
        });

        if (todo.id && todo.id !== created.id) {
          const current = tasks.get(created.id);
          if (current) {
            tasks.delete(created.id);
            tasks.set(todo.id, {
              ...current,
              id: todo.id,
            });
            nextTaskId = Math.max(nextTaskId, Number(todo.id) + 1 || nextTaskId);
          }
        }
      });

      nextTaskId = Math.max(nextTaskId, previousNextTaskId);

      return sortTasks(tasks);
    },

    getContextState() {
      return structuredClone(contextState);
    },

    updateContextState(updates) {
      contextState = structuredClone({ ...contextState, ...updates });
    },

    getCompactionDeferred() {
      return compactionDeferred;
    },

    setCompactionDeferred(deferred: boolean) {
      compactionDeferred = deferred;
    },

    _getRawTask(taskId) {
      return tasks.get(taskId);
    },

    _setRawTask(taskId, task) {
      tasks.set(taskId, task);
    },

    _deleteTask(taskId) {
      return tasks.delete(taskId);
    },

    _getAllTasks() {
      return tasks;
    },

    _getNextTaskId() {
      return nextTaskId;
    },

    _setNextTaskId(value) {
      nextTaskId = toPositiveInteger(value, nextTaskId);
    },

    _refreshBlockedTasks() {
      refreshBlockedTasks(tasks);
    },

    archiveTurn() {
      // No-op when active store is empty — prevents phantom empty archived turns
      if (tasks.size === 0) {
        return;
      }

      archivedTurns.push({
        turnNumber: nextTurnNumber,
        tasks: sortTasks(tasks),
      });
      nextTurnNumber++;
      tasks.clear();
      // nextTaskId is NOT reset — continues monotonically across turns
    },

    getArchivedTurns() {
      // Return most recent first
      return [...archivedTurns].reverse().map((turn) => ({
        turnNumber: turn.turnNumber,
        tasks: turn.tasks.map(cloneTask),
      }));
    },

    exportState() {
      return {
        tasks: sortTasks(tasks),
        nextTaskId,
        contextState: structuredClone(contextState),
        archivedTurns: archivedTurns.map((turn) => ({
          turnNumber: turn.turnNumber,
          tasks: turn.tasks.map(cloneTask),
        })),
        nextTurnNumber,
      };
    },

    importState(state) {
      tasks.clear();
      for (const task of state.tasks) {
        tasks.set(task.id, cloneTask(task));
      }

      if (state.contextState) {
        contextState = structuredClone(state.contextState);
      } else {
        contextState = createEmptyContextState();
      }

      // Load archived turns (with fallback for v1 data that has no archive)
      archivedTurns.length = 0;
      if (state.archivedTurns) {
        for (const turn of state.archivedTurns) {
          archivedTurns.push({
            turnNumber: turn.turnNumber,
            tasks: turn.tasks.map(cloneTask),
          });
        }
      }

      // Set nextTurnNumber from state, or compute from archive length
      nextTurnNumber = state.nextTurnNumber
        ?? (archivedTurns.length > 0
          ? Math.max(...archivedTurns.map((t) => t.turnNumber)) + 1
          : 1);

      // Recompute nextTaskId as max across active + archived tasks to prevent ID reuse
      let maxId = 0;
      for (const taskId of tasks.keys()) {
        const parsed = Number(taskId);
        if (Number.isFinite(parsed) && parsed > maxId) {
          maxId = parsed;
        }
      }
      for (const turn of archivedTurns) {
        for (const task of turn.tasks) {
          const parsed = Number(task.id);
          if (Number.isFinite(parsed) && parsed > maxId) {
            maxId = parsed;
          }
        }
      }

      nextTaskId = Math.max(
        toPositiveInteger(state.nextTaskId),
        maxId + 1,
      );
    },
  };
}

/**
 * Creates a namespace-scoped task-store view over a shared base store.
 * Read operations remain global; writes are constrained by namespace ownership.
 */
export function createScopedTaskStore(
  baseStore: RebelCoreTaskStoreInternal,
  namespace: string,
  depth: number,
): RebelCoreTaskStore {
  const createScopedTask = (input: RebelCoreTaskCreateInput): RebelCoreTask => {
    const tasks = baseStore._getAllTasks();
    const { task, nextTaskId } = createRawTask(tasks, baseStore._getNextTaskId(), {
      ...input,
      owner: namespace,
    });

    baseStore._setNextTaskId(nextTaskId);

    if (task.status === 'in_progress') {
      const ownerNamespace = normalizeOwner(task.owner);
      demoteInProgressTasks(
        tasks,
        task,
        (candidate) => normalizeOwner(candidate.owner) === ownerNamespace,
      );
    }

    baseStore._refreshBlockedTasks();
    return cloneTask(task);
  };

  const updateScopedTask = (
    taskId: string,
    updates: RebelCoreTaskUpdateInput,
  ): RebelCoreTask | null => {
    const existing = baseStore._getRawTask(taskId);
    if (!existing) {
      return null;
    }

    if (!canWriteToOwner(existing.owner, namespace, depth)) {
      throw new Error(
        `Cannot update task ${taskId} owned by namespace "${normalizeOwner(existing.owner)}" from namespace "${namespace}"`,
      );
    }

    const tasks = baseStore._getAllTasks();
    const updated = updateRawTask(tasks, taskId, updates);
    if (!updated) {
      return null;
    }

    if (updated.status === 'in_progress') {
      const ownerNamespace = normalizeOwner(updated.owner);
      demoteInProgressTasks(
        tasks,
        updated,
        (candidate) => normalizeOwner(candidate.owner) === ownerNamespace,
      );
    }

    baseStore._refreshBlockedTasks();
    return cloneTask(updated);
  };

  const replaceScopedTodos = (todos: RebelCoreTodoInput[]): RebelCoreTask[] => {
    const tasks = baseStore._getAllTasks();
    for (const [taskId, task] of Array.from(tasks.entries())) {
      if (normalizeOwner(task.owner) === namespace) {
        baseStore._deleteTask(taskId);
      }
    }

    baseStore._refreshBlockedTasks();

    for (const todo of todos) {
      const created = createScopedTask({
        title: todo.content,
        status: normalizeStatus(todo.status),
        priority: todo.priority,
      });

      if (todo.id && todo.id !== created.id) {
        const current = baseStore._getRawTask(created.id);
        if (current) {
          baseStore._deleteTask(created.id);
          baseStore._setRawTask(todo.id, { ...current, id: todo.id });
          const parsed = Number(todo.id);
          if (Number.isFinite(parsed) && parsed > 0) {
            const currentNextId = baseStore._getNextTaskId();
            if (parsed >= currentNextId) {
              baseStore._setNextTaskId(parsed + 1);
            }
          }
        }
      }
    }

    return baseStore.listTasks();
  };

  return {
    createTask: createScopedTask,
    listTasks() {
      return baseStore.listTasks();
    },
    getTask(taskId) {
      return baseStore.getTask(taskId);
    },
    updateTask: updateScopedTask,
    replaceWithTodos: replaceScopedTodos,
    getContextState() {
      return baseStore.getContextState();
    },
    updateContextState(updates) {
      baseStore.updateContextState(updates);
    },
    getCompactionDeferred() {
      return baseStore.getCompactionDeferred?.() ?? false;
    },
    setCompactionDeferred(deferred: boolean) {
      baseStore.setCompactionDeferred?.(deferred);
    },
  };
}
