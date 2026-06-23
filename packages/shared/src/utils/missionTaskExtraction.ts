/**
 * Mission/task extraction — shared pure parsers.
 *
 * Both the desktop renderer and cloud-client parse MissionSet / TaskList /
 * TaskCreate / TaskUpdate / TodoWrite tool-event details into the same domain
 * types. This module is the single source of truth for that parsing logic.
 * Platform-specific wrappers (e.g. filtering `AgentEvent[]` vs
 * `SessionToolEvent[]`) live in each consumer.
 *
 * TaskCreate and TaskUpdate results include a full `tasks` snapshot alongside
 * the individual `task`, so consumers can treat any task-mutating tool's end
 * event as a snapshot source — same as TaskList.
 */

import {
  safeParseDetail,
  MAX_STRUCTURED_DETAIL_PARSE_BYTES,
} from './safeParseDetail';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mission context extracted from a MissionSet tool event. */
export interface MissionContext {
  goal: string;
  doneCriteria?: string;
  constraints?: string;
}

/** A task or todo item with full lifecycle status. Includes optional `priority` (renderer). */
export interface TaskProgressItem {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority?: 'high' | 'medium' | 'low';
  description?: string;
  notes?: string;
  blockers?: string[];
  /**
   * Planner-assigned identifier marking tasks that may execute concurrently.
   * Two tasks sharing the same `parallelGroup` are members of the same parallel
   * wave; the planning panel uses this to render them as a single visual cluster.
   */
  parallelGroup?: string;
}

/** A pending-only todo item (subset used for inbox/progress display). */
export interface PendingTodo {
  id: string;
  content: string;
  priority?: 'high' | 'medium' | 'low';
}

/** Minimal shape a tool event must satisfy for the event-level helpers. */
export interface ToolEventLike {
  toolName: string;
  detail: string;
  stage?: string;
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const VALID_TASK_STATUSES = new Set<TaskProgressItem['status']>([
  'pending',
  'in_progress',
  'completed',
  'blocked',
]);

/** Tool names whose end events carry a `tasks` snapshot array. */
export const TASK_SNAPSHOT_TOOL_NAMES = new Set([
  'TaskList',
  'TaskCreate',
  'TaskUpdate',
]);

const parseJsonDetail = (detail: string): Record<string, unknown> | null => {
  if (!detail.trim()) return null;
  // BOUNDED via safeParseDetail at the structured budget (1 MiB): this feeds
  // visible mission/task progress UI, so we allow generous structured snapshots;
  // a malformed OR pathological >1MiB detail yields null (same as a parse
  // failure — the consumer renders no task rows for that event).
  const result = safeParseDetail(detail, { maxBytes: MAX_STRUCTURED_DETAIL_PARSE_BYTES });
  if (!result.ok) return null;
  const parsed = result.value;
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>)
    : null;
};

const getOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Extract a validated string array from an unknown value.
 * Returns undefined if the value is not an array or contains no string elements.
 * Filters out non-string elements silently.
 */
const getOptionalStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length > 0 ? strings : undefined;
};

const isTaskStatus = (value: unknown): value is TaskProgressItem['status'] =>
  typeof value === 'string' && VALID_TASK_STATUSES.has(value as TaskProgressItem['status']);

const isOrchestrationTask = (value: unknown): boolean => value === 'orchestration';

const toMissionContext = (value: unknown): MissionContext | null => {
  if (typeof value !== 'object' || value === null) return null;
  const mission = value as Record<string, unknown>;
  const goal = getOptionalString(mission.goal);
  if (!goal) return null;
  return {
    goal,
    doneCriteria: getOptionalString(mission.done_criteria),
    constraints: getOptionalString(mission.constraints),
  };
};

// ---------------------------------------------------------------------------
// TaskList / TodoWrite item extractors (shared between tasks + pending todos)
// ---------------------------------------------------------------------------

const resolveTaskListArray = (
  detail: Record<string, unknown>,
): unknown[] | null => {
  const directTasks = Array.isArray(detail.tasks) ? detail.tasks : null;
  const resultTasks =
    typeof detail.result === 'object' &&
    detail.result !== null &&
    Array.isArray((detail.result as Record<string, unknown>).tasks)
      ? ((detail.result as Record<string, unknown>).tasks as unknown[])
      : null;
  return directTasks ?? resultTasks;
};

/**
 * Parse a single task record from a TaskList payload into a TaskProgressItem.
 * Filters out mission-owned tasks and tasks with invalid statuses.
 */
const toTaskFromTaskList = (
  task: Record<string, unknown>,
  index: number,
): TaskProgressItem | null => {
  if (task.owner === 'mission' || isOrchestrationTask(task.kind) || !isTaskStatus(task.status)) return null;
  const title = getOptionalString(task.title) ?? getOptionalString(task.content);
  if (!title) return null;

  const item: TaskProgressItem = {
    id: getOptionalString(task.id) ?? `task-${index}`,
    title,
    status: task.status,
    priority: getOptionalString(task.priority) as TaskProgressItem['priority'],
  };

  // Optional detail fields — only include when present and non-empty
  const description = getOptionalString(task.description);
  if (description?.trim()) item.description = description;

  const notes = getOptionalString(task.notes);
  if (notes?.trim()) item.notes = notes;

  const blockers = getOptionalStringArray(task.blockers);
  if (blockers) item.blockers = blockers;

  const parallelGroup = getOptionalString(task.parallelGroup);
  if (parallelGroup?.trim()) item.parallelGroup = parallelGroup.trim();

  return item;
};

/**
 * Parse a single todo record from a TodoWrite payload into a TaskProgressItem.
 * TodoWrite items use `content` (not `title`) as the display text.
 */
const toTaskFromTodoWrite = (
  todo: Record<string, unknown>,
  index: number,
): TaskProgressItem | null => {
  if (!isTaskStatus(todo.status)) return null;
  const content = getOptionalString(todo.content);
  if (!content) return null;
  return {
    id: getOptionalString(todo.id) ?? `todo-${index}`,
    title: content,
    status: todo.status,
    priority: getOptionalString(todo.priority) as TaskProgressItem['priority'],
  };
};

// ---------------------------------------------------------------------------
// Pure parsers — no event-type dependencies
// ---------------------------------------------------------------------------

/**
 * Parse mission context from a MissionSet tool event's `detail` JSON string.
 * Handles both result format (`{ mission: { goal, ... } }`) and input format
 * (`{ goal, ... }` at the top level).
 */
export const parseMissionFromDetail = (detail: string): MissionContext | null => {
  const parsed = parseJsonDetail(detail);
  if (!parsed) return null;
  return toMissionContext(parsed.mission) ?? toMissionContext(parsed);
};

/**
 * Parse tasks from a TaskList or TodoWrite tool event's `detail` JSON string.
 * Returns all tasks with full lifecycle status (pending, in_progress, completed, blocked).
 *
 * @param detail  - Raw JSON string from the tool event
 * @param toolName - `'TaskList'` or `'TodoWrite'`
 */
export const parseTasksFromDetail = (
  detail: string,
  toolName: string,
): TaskProgressItem[] => {
  const parsed = parseJsonDetail(detail);
  if (!parsed) return [];

  if (TASK_SNAPSHOT_TOOL_NAMES.has(toolName)) {
    const tasks = resolveTaskListArray(parsed);
    if (!tasks) return [];
    return tasks.flatMap((task, index) => {
      if (typeof task !== 'object' || task === null) return [];
      const item = toTaskFromTaskList(task as Record<string, unknown>, index);
      return item ? [item] : [];
    });
  }

  if (toolName === 'TodoWrite') {
    if (!Array.isArray(parsed.todos)) return [];
    return parsed.todos.flatMap((todo, index) => {
      if (typeof todo !== 'object' || todo === null) return [];
      const item = toTaskFromTodoWrite(todo as Record<string, unknown>, index);
      return item ? [item] : [];
    });
  }

  return [];
};

/**
 * Parse *pending* tasks/todos from a TaskList or TodoWrite tool event's
 * `detail` JSON string. Returns only items with `status === 'pending'` as
 * `PendingTodo` objects.
 *
 * @param detail   - Raw JSON string from the tool event
 * @param toolName - `'TaskList'` or `'TodoWrite'`
 */
export const parseTodosFromDetail = (
  detail: string,
  toolName: string,
): PendingTodo[] => {
  const parsed = parseJsonDetail(detail);
  if (!parsed) return [];

  if (TASK_SNAPSHOT_TOOL_NAMES.has(toolName)) {
    const tasks = resolveTaskListArray(parsed);
    if (!tasks) return [];
    return tasks.flatMap((task, index) => {
      if (typeof task !== 'object' || task === null) return [];
      const t = task as Record<string, unknown>;
      if (t.owner === 'mission' || isOrchestrationTask(t.kind) || t.status !== 'pending') return [];
      const title = getOptionalString(t.title) ?? getOptionalString(t.content);
      if (!title) return [];
      return [
        {
          id: getOptionalString(t.id) ?? `task-${index}`,
          content: title,
          priority: getOptionalString(t.priority) as PendingTodo['priority'],
        },
      ];
    });
  }

  if (toolName === 'TodoWrite') {
    if (!Array.isArray(parsed.todos)) return [];
    return parsed.todos.flatMap((todo, index) => {
      if (typeof todo !== 'object' || todo === null) return [];
      const t = todo as Record<string, unknown>;
      if (t.status !== 'pending') return [];
      const content = getOptionalString(t.content);
      if (!content) return [];
      return [
        {
          id: getOptionalString(t.id) ?? `todo-${index}`,
          content,
          priority: getOptionalString(t.priority) as PendingTodo['priority'],
        },
      ];
    });
  }

  return [];
};

// ---------------------------------------------------------------------------
// Per-turn task delta types
// ---------------------------------------------------------------------------

/** Per-turn task delta — what tasks a specific turn contributed. */
export interface TurnTaskDelta {
  /** Full cumulative snapshot (for progress bar N/M) */
  snapshot: TaskProgressItem[];
  /** IDs of tasks created/updated in this specific turn, in touch order (first-touch dedup) */
  touchedTaskIds: string[];
  /** Tasks from snapshot that were touched in this turn (filtered, in touch order) */
  deltaTasks: TaskProgressItem[];
  /** Whether this turn contains a MissionSet event (controls full vs compact mode) */
  hasMissionSet: boolean;
}

/** Progress counts from the cumulative snapshot (for progress bar). */
export interface SnapshotCounts {
  completed: number;
  total: number;
}

/** Display mode for mission/task card per turn. */
export type TaskDisplayMode = 'full' | 'compact' | 'active';

/** Computed display properties for a turn's mission/task card. */
export interface TaskDisplayProps {
  mode: TaskDisplayMode;
  displayTasks: TaskProgressItem[];
  displayMission: MissionContext | null;
  snapshotCounts: SnapshotCounts | undefined;
}

// ---------------------------------------------------------------------------
// Per-turn task delta parsers
// ---------------------------------------------------------------------------

/**
 * Extract the individual task ID from a TaskCreate/TaskUpdate end event detail.
 * These end events contain `{ task: { id, ... }, tasks: [...] }` — we extract
 * just the `task.id` for delta identification.
 * Returns null if parsing fails or the detail doesn't contain a valid string task ID.
 */
export const parseIndividualTaskIdFromDetail = (detail: string): string | null => {
  const parsed = parseJsonDetail(detail);
  if (!parsed) return null;
  const task = parsed.task;
  if (typeof task !== 'object' || task === null) return null;
  const id = (task as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

/**
 * Compute per-turn task delta from event data.
 * Takes the full snapshot + list of individually touched task IDs + hasMissionSet.
 * Returns delta tasks filtered from the snapshot, preserving touch order.
 *
 * Dedup policy: first-touch wins — if a task ID appears multiple times in
 * touchedTaskIds, only the first occurrence determines its position.
 */
export const computeTurnTaskDelta = (
  snapshot: TaskProgressItem[],
  touchedTaskIds: string[],
  hasMissionSet: boolean,
): TurnTaskDelta => {
  // Build a lookup map for the snapshot by task ID
  const snapshotById = new Map<string, TaskProgressItem>();
  for (const task of snapshot) {
    snapshotById.set(task.id, task);
  }

  // If this turn set the mission, show everything (full mode)
  if (hasMissionSet) {
    return {
      snapshot,
      touchedTaskIds,
      deltaTasks: snapshot,
      hasMissionSet: true,
    };
  }

  // First-touch dedup: preserve order of first occurrence only
  const seen = new Set<string>();
  const dedupedIds: string[] = [];
  for (const id of touchedTaskIds) {
    if (!seen.has(id)) {
      seen.add(id);
      dedupedIds.push(id);
    }
  }

  // Filter snapshot to touched tasks, preserving touch order
  const deltaTasks: TaskProgressItem[] = [];
  for (const id of dedupedIds) {
    const task = snapshotById.get(id);
    if (task) {
      deltaTasks.push(task);
    }
  }

  return {
    snapshot,
    touchedTaskIds: dedupedIds,
    deltaTasks,
    hasMissionSet: false,
  };
};

/**
 * Compute display properties for a turn's mission/task card.
 * Pure function that determines display mode and filters tasks accordingly.
 *
 * @param turnDelta - Per-turn task delta (null if no task data for this turn)
 * @param missionContext - Mission context for this turn (null if no mission in this turn)
 * @param isActiveThinking - Whether this turn is currently being processed
 */
export const computeTaskDisplayProps = (
  turnDelta: TurnTaskDelta | null,
  missionContext: MissionContext | null,
  isActiveThinking: boolean,
): TaskDisplayProps | null => {
  if (!turnDelta || turnDelta.snapshot.length === 0) {
    // No task data — show mission card only if present, no task list
    if (missionContext) {
      return {
        mode: 'full',
        displayTasks: [],
        displayMission: missionContext,
        snapshotCounts: undefined,
      };
    }
    return null;
  }

  const snapshotCounts: SnapshotCounts = {
    completed: turnDelta.snapshot.filter(t => t.status === 'completed').length,
    total: turnDelta.snapshot.length,
  };

  if (turnDelta.hasMissionSet) {
    // Full mode: show everything — mission header + all tasks
    return {
      mode: 'full',
      displayTasks: turnDelta.snapshot,
      displayMission: missionContext,
      snapshotCounts,
    };
  }

  if (isActiveThinking) {
    // Active mode: show in_progress + pending from snapshot (current work view)
    const activeTasks = turnDelta.snapshot.filter(
      t => t.status === 'in_progress' || t.status === 'pending',
    );
    return {
      mode: 'active',
      displayTasks: activeTasks,
      displayMission: null, // Don't repeat mission on subsequent turns
      snapshotCounts,
    };
  }

  // Compact mode: show only delta tasks in touch order
  return {
    mode: 'compact',
    displayTasks: turnDelta.deltaTasks,
    displayMission: null, // Don't repeat mission on subsequent turns
    snapshotCounts,
  };
};
