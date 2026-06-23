import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { UserTask, UserTasksState, UserTaskStatus } from '@shared/types';
import type { TodoistTask } from '@shared/ipc/channels/todoist';
import { DateTime } from 'luxon';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';

const TODOIST_STATUS_KEY = 'tasks:todoist-connected';
const TODOIST_TASKS_KEY = 'tasks:todoist-cache';
const LOCAL_TASKS_KEY = 'tasks:local-cache';

// Get cached connection status from localStorage
const getCachedTodoistStatus = (): boolean => {
  try {
    return localStorage.getItem(TODOIST_STATUS_KEY) === 'true';
  } catch {
    return false;
  }
};

// Cache connection status to localStorage
const setCachedTodoistStatus = (connected: boolean): void => {
  try {
    localStorage.setItem(TODOIST_STATUS_KEY, String(connected));
  } catch {
    // Ignore storage errors
  }
};

// Get cached Todoist tasks
const getCachedTodoistTasks = (): TodoistTask[] => {
  try {
    const cached = sessionStorage.getItem(TODOIST_TASKS_KEY);
    return cached ? JSON.parse(cached) : [];
  } catch {
    return [];
  }
};

// Cache Todoist tasks (use sessionStorage for freshness per session)
const setCachedTodoistTasks = (tasks: TodoistTask[]): void => {
  try {
    sessionStorage.setItem(TODOIST_TASKS_KEY, JSON.stringify(tasks));
  } catch {
    // Ignore storage errors
  }
};

// Get cached local tasks
const getCachedLocalTasks = (): UserTasksState | null => {
  try {
    const cached = sessionStorage.getItem(LOCAL_TASKS_KEY);
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
};

// Cache local tasks
const setCachedLocalTasks = (state: UserTasksState): void => {
  try {
    sessionStorage.setItem(LOCAL_TASKS_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
};

interface UseTasksOptions {
  enabled?: boolean;
  showToast?: (options: { title: string }) => void;
}

interface UseTasksReturn {
  tasks: UserTask[];
  upcomingTasks: UserTask[];
  loading: boolean;
  error: string | null;
  todoistConnected: boolean;
  refresh: () => Promise<void>;
  addTask: (title: string, dueDate?: number | null) => Promise<void>;
  completeTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  updateTask: (taskId: string, patch: Partial<Pick<UserTask, 'title' | 'status' | 'dueDate'>>) => Promise<void>;
}

// Priority order: urgent > high > medium > low > none/undefined
const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

const getPriorityScore = (priority?: string): number => {
  return priority ? (PRIORITY_ORDER[priority] ?? 4) : 4;
};

const sortTasks = (tasks: UserTask[]): UserTask[] => {
  return [...tasks].sort((a, b) => {
    // Tasks with due dates first, sorted by due date
    if (a.dueDate && b.dueDate) {
      const dateDiff = a.dueDate - b.dueDate;
      if (dateDiff !== 0) return dateDiff;
      // Same date: sort by priority
      return getPriorityScore(a.priority) - getPriorityScore(b.priority);
    }
    if (a.dueDate && !b.dueDate) return -1;
    if (!a.dueDate && b.dueDate) return 1;
    // No due dates: sort by priority, then creation date
    const priorityDiff = getPriorityScore(a.priority) - getPriorityScore(b.priority);
    if (priorityDiff !== 0) return priorityDiff;
    return a.createdAt - b.createdAt;
  });
};

// Map Todoist priority (1=urgent, 4=none) to UserTask priority
const mapTodoistPriority = (priority: 1 | 2 | 3 | 4): UserTask['priority'] => {
  switch (priority) {
    case 1: return 'urgent';
    case 2: return 'high';
    case 3: return 'medium';
    case 4: return 'none';
    default: return 'none';
  }
};

// Convert Todoist task to our UserTask format
const todoistToUserTask = (t: TodoistTask): UserTask => ({
  id: t.id,
  title: t.content,
  status: t.is_completed ? 'done' : 'todo',
  priority: mapTodoistPriority(t.priority as 1 | 2 | 3 | 4),
  dueDate: t.due?.datetime 
    ? DateTime.fromISO(t.due.datetime).toMillis()
    : t.due?.date 
      ? DateTime.fromISO(t.due.date).endOf('day').toMillis()
      : null,
  createdAt: DateTime.fromISO(t.created_at).toMillis(),
  updatedAt: DateTime.fromISO(t.created_at).toMillis(),
});

export const useTasks = (options: UseTasksOptions = {}): UseTasksReturn => {
  const { enabled = true, showToast } = options;
  // Initialize with cached data to avoid loading flash
  const [localState, setLocalState] = useState<UserTasksState | null>(getCachedLocalTasks);
  const [todoistTasks, setTodoistTasks] = useState<TodoistTask[]>(getCachedTodoistTasks);
  const [todoistConnected, setTodoistConnected] = useState(getCachedTodoistStatus);
  // Only show loading if we have no cached data
  const hasCachedData = getCachedTodoistStatus() ? getCachedTodoistTasks().length > 0 : getCachedLocalTasks() !== null;
  const [loading, setLoading] = useState(!hasCachedData);
  const [error, setError] = useState<string | null>(null);
  const initialLoadDone = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    
    // Only show loading if we have no data yet
    const hasData = todoistConnected ? todoistTasks.length > 0 : localState !== null;
    if (!hasData && !initialLoadDone.current) {
      setLoading(true);
    }
    
    try {
      setError(null);
      
      // Check Todoist connection
      const status = await window.todoistApi.checkConnection();
      const connected = status.connected;
      
      // Update and cache connection status
      setTodoistConnected(connected);
      setCachedTodoistStatus(connected);
      
      if (connected) {
        // Fetch from Todoist
        const tasks = await window.todoistApi.getTasks();
        setTodoistTasks(tasks);
        setCachedTodoistTasks(tasks);
      } else {
        // Fall back to local storage
        const result = await window.userTasksApi.load();
        setLocalState(result);
        setCachedLocalTasks(result);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      // On error, clear cached status so we don't show stale UI
      setTodoistConnected(false);
      setCachedTodoistStatus(false);
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, [enabled, todoistConnected, todoistTasks.length, localState]);

  // Initial load - refresh in background
  useEffect(() => {
    if (enabled) {
      void refresh();
    }
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps -- intentional: omitting refresh so initial background load is triggered only when enabled changes

  // Subscribe to local task updates (only when not using Todoist)
  useIpcEvent(
    !enabled || todoistConnected ? undefined : window.api.onUserTasksUpdate,
    (nextState) => {
      setLocalState(nextState);
    },
    [enabled, todoistConnected],
  );

  // Get tasks based on source
  const tasks = useMemo(() => {
    if (todoistConnected) {
      return todoistTasks.map(todoistToUserTask);
    }
    return localState?.tasks ?? [];
  }, [todoistConnected, todoistTasks, localState]);

  // Get upcoming tasks (todo status only, max 5, sorted by due date then creation)
  const upcomingTasks = useMemo(() => {
    const todoTasks = tasks.filter((t) => t.status === 'todo');
    return sortTasks(todoTasks).slice(0, 5);
  }, [tasks]);

  const addTask = useCallback(
    async (title: string, dueDate?: number | null) => {
      try {
        if (todoistConnected) {
          // Add to Todoist Inbox
          const formattedDueDate = dueDate ? DateTime.fromMillis(dueDate).toISODate() ?? undefined : undefined;
          await window.todoistApi.createTask({ content: title, due_date: formattedDueDate });
          // Refresh to get updated list
          const tasks = await window.todoistApi.getTasks();
          setTodoistTasks(tasks);
        } else {
          // Add to local storage
          const result = await window.userTasksApi.add({ title, dueDate });
          setLocalState(result);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast?.({ title: `Failed to add task: ${message}` });
        throw err;
      }
    },
    [todoistConnected, showToast]
  );

  const completeTask = useCallback(
    async (taskId: string) => {
      try {
        if (todoistConnected) {
          await window.todoistApi.completeTask({ taskId });
          // Remove from local state immediately for responsiveness
          setTodoistTasks(prev => prev.filter(t => t.id !== taskId));
        } else {
          const result = await window.userTasksApi.update({
            id: taskId,
            patch: { status: 'done' as UserTaskStatus },
          });
          setLocalState(result);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast?.({ title: `Failed to complete task: ${message}` });
        throw err;
      }
    },
    [todoistConnected, showToast]
  );

  const deleteTask = useCallback(
    async (taskId: string) => {
      try {
        if (todoistConnected) {
          await window.todoistApi.deleteTask({ taskId });
          setTodoistTasks(prev => prev.filter(t => t.id !== taskId));
        } else {
          const result = await window.userTasksApi.delete(taskId);
          setLocalState(result);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast?.({ title: `Failed to delete task: ${message}` });
        throw err;
      }
    },
    [todoistConnected, showToast]
  );

  const updateTask = useCallback(
    async (taskId: string, patch: Partial<Pick<UserTask, 'title' | 'status' | 'dueDate'>>) => {
      try {
        if (todoistConnected) {
          // Todoist update not implemented yet - just refresh
          showToast?.({ title: 'Task update not yet supported for Todoist' });
        } else {
          const result = await window.userTasksApi.update({ id: taskId, patch });
          setLocalState(result);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast?.({ title: `Failed to update task: ${message}` });
        throw err;
      }
    },
    [todoistConnected, showToast]
  );

  return {
    tasks,
    upcomingTasks,
    loading,
    error,
    todoistConnected,
    refresh,
    addTask,
    completeTask,
    deleteTask,
    updateTask,
  };
};
