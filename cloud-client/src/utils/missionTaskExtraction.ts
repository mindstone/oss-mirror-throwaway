/**
 * Mission/task extraction — cloud-client adapter.
 *
 * Core parsing logic lives in `@rebel/shared`. This module re-exports shared
 * types and parsers, and provides cloud-client-specific event-level wrappers
 * that operate on `SessionToolEvent[]`.
 */

import type { SessionToolEvent } from '../types';
import {
  parseMissionFromDetail,
  parseTasksFromDetail,
  parseIndividualTaskIdFromDetail,
  computeTurnTaskDelta,
  TASK_SNAPSHOT_TOOL_NAMES,
  BOOKKEEPING_TOOL_NAMES,
} from '@rebel/shared';

// Re-export shared types and parsers so existing cloud-client consumers
// (including tests and mobile via @rebel/cloud-client) don't need to change
// their import paths.
export { parseMissionFromDetail, parseTasksFromDetail, TASK_SNAPSHOT_TOOL_NAMES } from '@rebel/shared';
export { parseIndividualTaskIdFromDetail, computeTurnTaskDelta, computeTaskDisplayProps } from '@rebel/shared';
export type { MissionContext, TaskProgressItem } from '@rebel/shared';
export type { TurnTaskDelta, SnapshotCounts, TaskDisplayMode, TaskDisplayProps } from '@rebel/shared';

/**
 * Tool names associated with mission/task management.
 * Used by UI components to de-emphasize these tool rows when promoted
 * mission/task displays are visible.
 *
 * Aliased to the shared `BOOKKEEPING_TOOL_NAMES` — same set, UI-display
 * naming kept for backwards compatibility with existing consumers.
 */
export const TASK_MISSION_TOOL_NAMES = BOOKKEEPING_TOOL_NAMES;

// ---------------------------------------------------------------------------
// Event-level helpers (cloud-client–specific, operates on SessionToolEvent[])
// ---------------------------------------------------------------------------

const findLatestEvent = (
  events: SessionToolEvent[],
  toolName: SessionToolEvent['toolName'],
  stage: SessionToolEvent['stage'],
): SessionToolEvent | null =>
  events.reduce<SessionToolEvent | null>((latest, event) => {
    if (event.toolName !== toolName || event.stage !== stage) return latest;
    if (!latest || event.timestamp > latest.timestamp) return event;
    return latest;
  }, null);

export const extractMissionFromEvents = (
  events: SessionToolEvent[],
): ReturnType<typeof parseMissionFromDetail> => {
  const latestMissionEnd = findLatestEvent(events, 'MissionSet', 'end');
  if (latestMissionEnd) return parseMissionFromDetail(latestMissionEnd.detail);

  const latestMissionStart = findLatestEvent(events, 'MissionSet', 'start');
  return latestMissionStart ? parseMissionFromDetail(latestMissionStart.detail) : null;
};

export const extractTasksFromEvents = (
  events: SessionToolEvent[],
): ReturnType<typeof parseTasksFromDetail> => {
  // Find the latest end event from any task-snapshot tool (TaskList, TaskCreate, TaskUpdate)
  const latestSnapshotEnd = events.reduce<SessionToolEvent | null>((latest, event) => {
    if (!TASK_SNAPSHOT_TOOL_NAMES.has(event.toolName) || event.stage !== 'end') return latest;
    if (!latest || event.timestamp > latest.timestamp) return event;
    return latest;
  }, null);

  if (latestSnapshotEnd) {
    const tasks = parseTasksFromDetail(latestSnapshotEnd.detail, latestSnapshotEnd.toolName);
    if (tasks.length > 0) return tasks;
  }

  // Fallback to legacy TodoWrite events
  const latestTodoWriteStart = findLatestEvent(events, 'TodoWrite', 'start');
  return latestTodoWriteStart
    ? parseTasksFromDetail(latestTodoWriteStart.detail, latestTodoWriteStart.toolName)
    : [];
};

/**
 * Extract per-turn task delta from a completed turn's SessionToolEvent array.
 * Uses the cumulative snapshot and identifies tasks touched in this turn.
 */
export const extractTurnTaskDeltaFromEvents = (
  events: SessionToolEvent[],
): ReturnType<typeof computeTurnTaskDelta> => {
  // Get full cumulative snapshot via existing function
  const snapshot = extractTasksFromEvents(events);

  // Check for MissionSet events
  const hasMissionSet = events.some(e => e.toolName === 'MissionSet');

  // Find TaskCreate/TaskUpdate end events, extract individual task IDs
  const touchedTaskIds: string[] = [];
  const sortedEvents = [...events].sort((a, b) => a.timestamp - b.timestamp);
  for (const event of sortedEvents) {
    if (
      (event.toolName === 'TaskCreate' || event.toolName === 'TaskUpdate') &&
      event.stage === 'end'
    ) {
      const taskId = parseIndividualTaskIdFromDetail(event.detail);
      if (taskId) {
        touchedTaskIds.push(taskId);
      }
    }
  }

  // TodoWrite fallback: when no individual TaskCreate/TaskUpdate events exist
  // but snapshot has tasks via TodoWrite, treat all as touched (wholesale replacement)
  if (touchedTaskIds.length === 0 && snapshot.length > 0) {
    const hasTodoWrite = events.some(e => e.toolName === 'TodoWrite');
    if (hasTodoWrite) {
      return computeTurnTaskDelta(
        snapshot,
        snapshot.map(t => t.id),
        hasMissionSet,
      );
    }
  }

  return computeTurnTaskDelta(snapshot, touchedTaskIds, hasMissionSet);
};
