import type { AgentEvent } from '@shared/types';
import type { ConversationStateShape } from '@shared/utils/conversationState';
import { safeParseDetailRecord } from '@shared/utils/safeParseDetail';
import type { ContributionTurnIndexWindow } from './contributionTypes';

export type TaskEvent = {
  toolUseId: string;
  subagentType: string;
  prompt: string;
  description?: string;
  turnIndex: number;
  completedAtTurnIndex?: number;
  resultStatus: 'pending' | 'success' | 'error' | 'cancelled';
};

export type DetectionInput = {
  taskEvents: TaskEvent[];
  contributionSessionId: string;
  contributionTurnIndexWindow: ContributionTurnIndexWindow;
};

export type DetectionResult =
  | {
      found: true;
      taskSubagentTypes: string[];
      observedAt: { sessionId: string; turnIndex: number };
    }
  | {
      found: false;
      reason:
        | 'no_se_subagent_task_in_window'
        | 'se_task_in_window_but_not_completed'
        | 'no_tasks_in_window'
        | 'window_session_mismatch';
    };

type ContributionWindowState = {
  id: string;
  turnIndexWindow?: ContributionTurnIndexWindow;
};

const SOFTWARE_ENGINEER_SUBAGENT_PREFIXES = [
  'software-engineer',
  'se-planner',
  'se-implementer',
  'se-reviewer',
] as const;

function normalizeSubagentType(input: string): string {
  return input.trim().toLowerCase();
}

function isSoftwareEngineerSubagentType(input: string): boolean {
  const normalized = normalizeSubagentType(input);
  return SOFTWARE_ENGINEER_SUBAGENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function inWindow(turnIndex: number, startTurn: number, endTurn: number): boolean {
  return turnIndex >= startTurn && turnIndex <= endTurn;
}

function deriveWindowEnd(window: ContributionTurnIndexWindow): number {
  return window.endTurn ?? Number.POSITIVE_INFINITY;
}

function getTaskEventsOverlappingWindow(
  taskEvents: TaskEvent[],
  window: ContributionTurnIndexWindow,
): TaskEvent[] {
  const endTurn = deriveWindowEnd(window);
  return taskEvents.filter((event) => {
    const dispatchInWindow = inWindow(event.turnIndex, window.startTurn, endTurn);
    const completionInWindow =
      typeof event.completedAtTurnIndex === 'number'
      && inWindow(event.completedAtTurnIndex, window.startTurn, endTurn);
    return dispatchInWindow || completionInWindow;
  });
}

function getSuccessfulCompletionTurnIndex(taskEvent: TaskEvent): number | undefined {
  if (taskEvent.resultStatus !== 'success') return undefined;
  if (typeof taskEvent.completedAtTurnIndex !== 'number') return undefined;
  return taskEvent.completedAtTurnIndex;
}

export function detectSoftwareEngineerTaskCompletion(
  input: DetectionInput,
): DetectionResult {
  const { taskEvents, contributionSessionId, contributionTurnIndexWindow } = input;

  if (contributionTurnIndexWindow.sessionId !== contributionSessionId) {
    return { found: false, reason: 'window_session_mismatch' };
  }

  if (
    contributionTurnIndexWindow.endTurn !== null
    && contributionTurnIndexWindow.endTurn < contributionTurnIndexWindow.startTurn
  ) {
    return { found: false, reason: 'no_tasks_in_window' };
  }

  const overlappingTasks = getTaskEventsOverlappingWindow(taskEvents, contributionTurnIndexWindow);
  if (overlappingTasks.length === 0) {
    return { found: false, reason: 'no_tasks_in_window' };
  }

  const seTasks = overlappingTasks.filter((event) => isSoftwareEngineerSubagentType(event.subagentType));
  if (seTasks.length === 0) {
    return { found: false, reason: 'no_se_subagent_task_in_window' };
  }

  const endTurn = deriveWindowEnd(contributionTurnIndexWindow);
  const successfulTasks = seTasks
    .map((event) => ({
      event,
      completedAtTurnIndex: getSuccessfulCompletionTurnIndex(event),
    }))
    .filter(
      (candidate): candidate is { event: TaskEvent; completedAtTurnIndex: number } =>
        typeof candidate.completedAtTurnIndex === 'number'
        && inWindow(
          candidate.completedAtTurnIndex,
          contributionTurnIndexWindow.startTurn,
          endTurn,
        ),
    );

  if (successfulTasks.length === 0) {
    return { found: false, reason: 'se_task_in_window_but_not_completed' };
  }

  const observedTurnIndex = Math.max(...successfulTasks.map((candidate) => candidate.completedAtTurnIndex));
  const taskSubagentTypes = Array.from(
    new Set(
      successfulTasks
        .map((candidate) => candidate.event.subagentType.trim())
        .filter((subagentType) => subagentType.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));

  return {
    found: true,
    taskSubagentTypes,
    observedAt: {
      sessionId: contributionSessionId,
      turnIndex: observedTurnIndex,
    },
  };
}

export function applySingleActiveBuildInvariant<T extends ContributionWindowState>(
  state: readonly T[],
  args: {
    sessionId: string;
    newPathLockTurn: number;
    newContributionId: string;
  },
): T[] {
  let changed = false;
  const nextState = state.map((contribution) => {
    let nextContribution = contribution;
    const window = contribution.turnIndexWindow;

    if (
      contribution.id !== args.newContributionId
      && window?.sessionId === args.sessionId
      && window.endTurn === null
    ) {
      nextContribution = {
        ...nextContribution,
        turnIndexWindow: {
          ...window,
          endTurn: args.newPathLockTurn - 1,
        },
      };
      changed = true;
    }

    if (contribution.id === args.newContributionId) {
      if (window?.sessionId === args.sessionId && window.endTurn === null) {
        return nextContribution;
      }
      const replacementWindow: ContributionTurnIndexWindow = {
        sessionId: args.sessionId,
        startTurn: args.newPathLockTurn,
        endTurn: null,
      };
      const sameWindow =
        window?.sessionId === replacementWindow.sessionId
        && window.startTurn === replacementWindow.startTurn
        && window.endTurn === replacementWindow.endTurn;
      if (!sameWindow) {
        nextContribution = {
          ...nextContribution,
          turnIndexWindow: replacementWindow,
        };
        changed = true;
      }
    }

    return nextContribution;
  });

  return changed ? nextState : [...state];
}

function tryParseTaskInput(detail: string): {
  subagentType?: string;
  prompt?: string;
  description?: string;
} {
  // BOUNDED via safeParseDetailRecord: an over-budget, malformed, OR non-object
  // valid JSON detail yields the same empty fallback — matching the
  // pre-migration try/catch behaviour for ≤budget input.
  const result = safeParseDetailRecord(detail);
  if (!result.ok) {
    return {};
  }
  const parsed = result.value;
  const subagentType =
    typeof parsed.subagent_type === 'string'
      ? parsed.subagent_type
      : typeof parsed.agent === 'string'
        ? parsed.agent
        : undefined;
  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : undefined;
  const description = typeof parsed.description === 'string' ? parsed.description : undefined;
  return { subagentType, prompt, description };
}

function isTaskToolStart(event: AgentEvent): event is Extract<AgentEvent, { type: 'tool' }> {
  if (event.type !== 'tool') return false;
  if (event.stage !== 'start') return false;
  if (event.toolName !== 'Task' && event.toolName !== 'Agent') return false;
  return typeof event.toolUseId === 'string' && event.toolUseId.trim() !== '';
}

function isTaskToolEnd(event: AgentEvent): event is Extract<AgentEvent, { type: 'tool' }> {
  if (event.type !== 'tool') return false;
  if (event.stage !== 'end') return false;
  return typeof event.toolUseId === 'string' && event.toolUseId.trim() !== '';
}

function classifyEndStatus(event: Extract<AgentEvent, { type: 'tool' }>): TaskEvent['resultStatus'] {
  if (event.isError !== true) {
    return 'success';
  }
  const detail = event.detail.toLowerCase();
  if (detail.includes('cancelled') || detail.includes('canceled')) {
    return 'cancelled';
  }
  return 'error';
}

function deriveTurnOrder(
  eventsByTurn: Record<string, AgentEvent[]>,
): string[] {
  const entries = Object.entries(eventsByTurn);
  return entries
    .map(([turnId, events], insertionOrder) => {
      const timestamps = events
        .map((event) => event.timestamp)
        .filter((timestamp): timestamp is number => typeof timestamp === 'number');
      const firstTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : Number.POSITIVE_INFINITY;
      return { turnId, insertionOrder, firstTimestamp };
    })
    .sort((a, b) => {
      if (a.firstTimestamp === b.firstTimestamp) {
        return a.insertionOrder - b.insertionOrder;
      }
      return a.firstTimestamp - b.firstTimestamp;
    })
    .map((entry) => entry.turnId);
}

function extractTaskEventsFromEventsByTurn(
  eventsByTurn: Record<string, AgentEvent[]>,
): TaskEvent[] {
  const turnOrder = deriveTurnOrder(eventsByTurn);
  const turnIndexByTurnId = new Map<string, number>(
    turnOrder.map((turnId, index) => [turnId, index]),
  );

  const byToolUseId = new Map<string, TaskEvent>();

  for (const turnId of turnOrder) {
    const turnIndex = turnIndexByTurnId.get(turnId);
    if (typeof turnIndex !== 'number') continue;
    const events = eventsByTurn[turnId] ?? [];

    for (const event of events) {
      if (!isTaskToolStart(event)) continue;
      const parsed = tryParseTaskInput(event.detail);
      const existing = byToolUseId.get(event.toolUseId as string);
      if (existing) continue;
      byToolUseId.set(event.toolUseId as string, {
        toolUseId: event.toolUseId as string,
        subagentType: parsed.subagentType?.trim() ?? '',
        prompt: parsed.prompt?.trim() ?? '',
        ...(parsed.description?.trim() ? { description: parsed.description.trim() } : {}),
        turnIndex,
        resultStatus: 'pending',
      });
    }
  }

  for (const turnId of turnOrder) {
    const turnIndex = turnIndexByTurnId.get(turnId);
    if (typeof turnIndex !== 'number') continue;
    const events = eventsByTurn[turnId] ?? [];

    for (const event of events) {
      if (!isTaskToolEnd(event)) continue;
      const key = event.toolUseId as string;
      const current = byToolUseId.get(key);
      if (!current) continue;

      const status = classifyEndStatus(event);
      const next: TaskEvent = {
        ...current,
        resultStatus: status,
      };
      if (status === 'success') {
        next.completedAtTurnIndex = turnIndex;
      }
      byToolUseId.set(key, next);
    }
  }

  return Array.from(byToolUseId.values()).sort((a, b) => {
    if (a.turnIndex !== b.turnIndex) {
      return a.turnIndex - b.turnIndex;
    }
    return a.toolUseId.localeCompare(b.toolUseId);
  });
}

export function extractTaskEventsFromConversationShape(
  shape: ConversationStateShape | undefined,
): TaskEvent[] {
  if (!shape) return [];
  return extractTaskEventsFromEventsByTurn(shape.eventsByTurn ?? {});
}

export function extractTaskEventsFromPersistedEvents(
  eventsByTurn: Record<string, AgentEvent[]> | undefined,
): TaskEvent[] {
  if (!eventsByTurn) return [];
  return extractTaskEventsFromEventsByTurn(eventsByTurn);
}
