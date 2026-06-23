import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import type { ArchivedTurn, RebelCoreTaskStoreInternal, RebelCoreTaskStoreState } from './taskState';

const log = createScopedLogger({ service: 'taskStatePersistence' });

const TASK_BOARDS_DIR = 'sessions/task-boards';
const CURRENT_VERSION = 2;
const INTERRUPTION_NOTE = 'Interrupted by restart';

interface PersistedTaskBoard {
  version: number;
  lastUpdated: number;
  state: RebelCoreTaskStoreState;
}

function getTaskBoardPath(sessionId: string): string {
  return path.join(getDataPath(), TASK_BOARDS_DIR, `${sessionId}.json`);
}

function isTaskStoreState(value: unknown): value is RebelCoreTaskStoreState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<RebelCoreTaskStoreState>;
  return Array.isArray(candidate.tasks) && typeof candidate.nextTaskId === 'number';
}

/**
 * Validates that archivedTurns is a well-formed array of ArchivedTurn objects.
 * Each turn must have a numeric turnNumber and an array of tasks.
 */
function isValidArchivedTurns(value: unknown): value is ArchivedTurn[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (turn) =>
      turn &&
      typeof turn === 'object' &&
      typeof (turn as ArchivedTurn).turnNumber === 'number' &&
      Array.isArray((turn as ArchivedTurn).tasks),
  );
}

const isRecoverableSubAgentOwner = (owner?: string): owner is string => {
  if (typeof owner !== 'string') {
    return false;
  }

  const trimmed = owner.trim();
  return /^main\/[^/\s]+/.test(trimmed);
};

const appendInterruptionNote = (notes?: string): string => {
  const existing = typeof notes === 'string' ? notes.trim() : '';
  if (!existing) {
    return INTERRUPTION_NOTE;
  }
  const lines = existing.split(/\r?\n/);
  if (lines.some((line) => line.trim() === INTERRUPTION_NOTE)) {
    return existing;
  }
  return `${existing}\n${INTERRUPTION_NOTE}`;
};

const extractParentTurnIds = (namespaces: string[]): string[] => Array.from(
  new Set(
    namespaces.flatMap((namespace) => {
      const match = namespace.match(/turn-[^/]+/g);
      return match ? [match[match.length - 1]] : [];
    }),
  ),
);

const recoverOrphanedInProgressSubAgentTasks = (
  sessionId: string,
  store: RebelCoreTaskStoreInternal,
): number => {
  const orphanedTasks = store.listTasks().filter((task) =>
    task.status === 'in_progress' && isRecoverableSubAgentOwner(task.owner),
  );

  if (orphanedTasks.length === 0) {
    return 0;
  }

  for (const task of orphanedTasks) {
    store.updateTask(task.id, {
      status: 'blocked',
      notes: appendInterruptionNote(task.notes),
    });
  }

  const namespaces = Array.from(
    new Set(orphanedTasks.flatMap((task) => (task.owner ? [task.owner] : []))),
  );
  const parentTurnIds = extractParentTurnIds(namespaces);
  log.info(
    {
      sessionId,
      count: orphanedTasks.length,
      taskIds: orphanedTasks.map((task) => task.id),
      namespaces,
      parentTurnIds,
    },
    'task:recovery:orphans-marked',
  );

  return orphanedTasks.length;
};

/**
 * Load a persisted task board and import it into the given store.
 * Returns `{ loaded, recoveredCount }` where `recoveredCount` is the number
 * of orphaned in-progress sub-agent tasks marked as blocked during load.
 *
 * Handles version migration:
 * - v1: tasks imported then archived (active store starts clean)
 * - v2: full state loaded including archive
 * - Future versions: skipped to avoid data loss
 * - Corrupt files: logged and skipped (start fresh)
 */
export async function loadTaskBoard(
  sessionId: string,
  store: RebelCoreTaskStoreInternal,
): Promise<{ loaded: boolean; recoveredCount: number }> {
  const filePath = getTaskBoardPath(sessionId);
  const notLoaded = { loaded: false, recoveredCount: 0 };

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object') {
      log.warn({ sessionId }, 'Task board state is malformed — starting fresh');
      return notLoaded;
    }

    const data = parsed as Partial<PersistedTaskBoard>;

    // Future version — skip loading to avoid data loss
    if (typeof data.version === 'number' && data.version > CURRENT_VERSION) {
      log.warn(
        { sessionId, version: data.version },
        'Task board was saved by a newer version — skipping load to avoid data loss',
      );
      return notLoaded;
    }

    // v1 → v2 migration: import tasks then archive them so active store starts clean
    if (data.version === 1) {
      if (!isTaskStoreState(data.state)) {
        log.warn({ sessionId }, 'Task board v1 state is malformed — starting fresh');
        return notLoaded;
      }
      store.importState(data.state);
      const recoveredCount = recoverOrphanedInProgressSubAgentTasks(sessionId, store);
      store.archiveTurn();
      log.info(
        { sessionId, taskCount: data.state.tasks.length },
        'Migrated v1 task board to v2 — previous tasks archived',
      );
      return { loaded: true, recoveredCount };
    }

    // v2 — current version
    if (data.version === CURRENT_VERSION) {
      if (!isTaskStoreState(data.state)) {
        log.warn({ sessionId }, 'Task board state is malformed — starting fresh');
        return notLoaded;
      }

      // Validate archivedTurns — discard archive if malformed, keep active tasks
      if (data.state.archivedTurns !== undefined && !isValidArchivedTurns(data.state.archivedTurns)) {
        log.warn({ sessionId }, 'Task board has malformed archivedTurns — discarding archive, keeping active tasks');
        store.importState({
          tasks: data.state.tasks,
          nextTaskId: data.state.nextTaskId,
        });
        const recoveredCount = recoverOrphanedInProgressSubAgentTasks(sessionId, store);
        return { loaded: true, recoveredCount };
      }

      store.importState(data.state);
      const recoveredCount = recoverOrphanedInProgressSubAgentTasks(sessionId, store);
      log.info({ sessionId, taskCount: data.state.tasks.length }, 'Loaded persisted task board');
      return { loaded: true, recoveredCount };
    }

    // Unrecognized version (0, negative, missing, etc.)
    log.warn({ sessionId, version: data.version }, 'Task board has unrecognized version — starting fresh');
    return notLoaded;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return notLoaded; // No file — first turn
    }

    const err = error instanceof Error ? error.message : String(error);
    log.warn({ sessionId, err }, 'Failed to read task board — starting fresh');
    return notLoaded;
  }
}

/**
 * Save the current task store state to disk.
 * Creates the task-boards directory lazily on first write.
 * Uses atomic writes (write-temp-rename) to prevent corruption from mid-write crashes.
 */
export async function saveTaskBoard(
  sessionId: string,
  store: RebelCoreTaskStoreInternal,
): Promise<void> {
  const filePath = getTaskBoardPath(sessionId);
  const state = store.exportState();

  const data: PersistedTaskBoard = {
    version: CURRENT_VERSION,
    lastUpdated: Date.now(),
    state,
  };

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmpPath, filePath);
    log.info({ sessionId, taskCount: state.tasks.length }, 'Saved task board');
  } catch (error: unknown) {
    const err = error instanceof Error ? error.message : String(error);
    log.warn({ sessionId, err }, 'Failed to save task board');
  }
}
