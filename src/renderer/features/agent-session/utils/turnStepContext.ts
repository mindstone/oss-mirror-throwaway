import type { AgentEvent, ToolAgentEvent } from '@shared/types';
import type { TaskRoutingMetadata as SharedTaskRoutingMetadata } from '@shared/routing/taskRoutingMetadata';
import { getAssistantStepDisplayText } from '@shared/utils/assistantNarration';
import {
  parseMissionFromDetail,
  parseTasksFromDetail,
  parseTodosFromDetail,
  TASK_SNAPSHOT_TOOL_NAMES,
  parseIndividualTaskIdFromDetail,
  computeTurnTaskDelta,
  type MissionContext,
  type TaskProgressItem as SharedTaskProgressItem,
  type PendingTodo as SharedPendingTodo,
  type TurnTaskDelta,
} from '@rebel/shared';
import { TURN_ID_FALLBACK } from '@renderer/constants';
import { summarizeFileOperations, type FileOperation } from '@renderer/utils/fileOperations';
import {
  buildAssistantSteps,
  buildFileOperationData,
  buildTechnicalEventsByStep
} from '../work-surface/utils/timelineBuilders';
import {
  formatParallelSubagentsBanner,
  parseParallelSubagentsStatus,
  type ParsedParallelSubagentsStatus,
} from '@core/rebelCore/parallelSubagentsStatus';
import type { FileOperationsByStep } from '../work-surface/types';
import { summarizeToolEvent, type StepToolSummary } from './toolChips';

type ToolSummaryByStep = Map<number, StepToolSummary[]>;

// Re-export shared types under renderer-local names for backwards compatibility.
export type PendingTodo = SharedPendingTodo;
export type MissionContextData = MissionContext;
export type TaskProgressItem = SharedTaskProgressItem;
export type { TurnTaskDelta } from '@rebel/shared';

// The per-task routing-metadata shape is defined once in `@shared` and shared
// with the core producer (`rebelCoreQuery.ts`) so the serialized
// `routing:tasks:` wire payload cannot drift between the two sides without a
// compile error. `TaskModelRoutingInfo` is kept as a renderer-local alias for
// backwards compatibility with existing call sites.
export type TaskModelRoutingInfo = SharedTaskRoutingMetadata;

/**
 * Extract mission context from the latest MissionSet end event in a turn.
 * Returns null if no MissionSet event exists or if parsing fails.
 */
export const extractMissionContext = (events: AgentEvent[]): MissionContextData | null => {
  // Take the last matching event — events are in chronological/insertion order,
  // and multiple events can share the same millisecond timestamp. Taking the
  // last element (rather than sort-desc + [0]) ensures we get the final state.
  const missionSetEvents = events.filter(
    (e): e is Extract<AgentEvent, { type: 'tool' }> =>
      e.type === 'tool' && e.toolName === 'MissionSet' && e.stage === 'end'
  );

  if (missionSetEvents.length === 0) return null;

  return parseMissionFromDetail(missionSetEvents[missionSetEvents.length - 1].detail);
};

/**
 * Extract all tasks (not just pending) from the latest task-snapshot event in a
 * turn. TaskList, TaskCreate, and TaskUpdate end events all carry a full `tasks`
 * snapshot. Falls back to TodoWrite for legacy compatibility.
 */
export const extractTaskProgress = (events: AgentEvent[]): TaskProgressItem[] => {
  // Take the last matching event — events are in chronological/insertion order,
  // and multiple events can share the same millisecond timestamp (rapid-fire
  // TaskUpdate calls). Taking the last element ensures we get the final snapshot.
  const snapshotEvents = events.filter(
    (e): e is Extract<AgentEvent, { type: 'tool' }> =>
      e.type === 'tool' && TASK_SNAPSHOT_TOOL_NAMES.has(e.toolName) && e.stage === 'end'
  );

  if (snapshotEvents.length > 0) {
    const latest = snapshotEvents[snapshotEvents.length - 1];
    const tasks = parseTasksFromDetail(latest.detail, latest.toolName);
    if (tasks.length > 0) return tasks;
  }

  // Fallback to legacy TodoWrite events
  const todoWriteEvents = events.filter(
    (e): e is Extract<AgentEvent, { type: 'tool' }> =>
      e.type === 'tool' && e.toolName === 'TodoWrite' && e.stage === 'start'
  );

  if (todoWriteEvents.length === 0) return [];
  const latestTodo = todoWriteEvents[todoWriteEvents.length - 1];
  return parseTasksFromDetail(latestTodo.detail, 'TodoWrite');
};

/**
 * Extract per-turn task delta from a turn's events.
 * Uses the cumulative snapshot (from extractTaskProgress) and identifies
 * which specific tasks were created/updated in this turn.
 */
export const extractTurnTaskDelta = (events: AgentEvent[], taskProgress: TaskProgressItem[]): TurnTaskDelta => {
  const hasMissionSet = events.some(
    (e): e is Extract<AgentEvent, { type: 'tool' }> =>
      e.type === 'tool' && e.toolName === 'MissionSet'
  );

  // Find TaskCreate/TaskUpdate end events and extract individual task IDs
  const taskMutationEndEvents = events
    .filter(
      (e): e is Extract<AgentEvent, { type: 'tool' }> =>
        e.type === 'tool' &&
        (e.toolName === 'TaskCreate' || e.toolName === 'TaskUpdate') &&
        e.stage === 'end'
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  const touchedTaskIds: string[] = [];
  for (const event of taskMutationEndEvents) {
    const taskId = parseIndividualTaskIdFromDetail(event.detail);
    if (taskId) {
      touchedTaskIds.push(taskId);
    }
  }

  // TodoWrite fallback: if no TaskCreate/TaskUpdate events but TodoWrite exists,
  // treat all snapshot tasks as the delta (wholesale replacement)
  if (touchedTaskIds.length === 0 && taskProgress.length > 0) {
    const hasTodoWrite = events.some(
      (e): e is Extract<AgentEvent, { type: 'tool' }> =>
        e.type === 'tool' && e.toolName === 'TodoWrite'
    );
    if (hasTodoWrite) {
      return computeTurnTaskDelta(
        taskProgress,
        taskProgress.map(t => t.id),
        hasMissionSet,
      );
    }
  }

  return computeTurnTaskDelta(taskProgress, touchedTaskIds, hasMissionSet);
};

const TOOL_ID_PATTERN = /^toolu[_\s]/i;
const ROUTING_TASKS_PREFIX = 'routing:tasks:';
export const parseParallelSubagentsStatusMessage = (message: string): ParsedParallelSubagentsStatus | null =>
  parseParallelSubagentsStatus(message);

const parseModelByTaskId = (events: AgentEvent[]): Map<string, TaskModelRoutingInfo> | undefined => {
  // Backend re-emits routing:tasks: when metadata changes (new tasks via
  // TaskCreate / MissionSet / Agent), so consume the LAST occurrence to
  // pick up the final per-turn snapshot. Manual reverse iteration because
  // the renderer tsconfig's lib doesn't expose Array.prototype.findLast.
  // Single-event turns still work the same way — first match found is also
  // the only match.
  let routingTasksEvent: (AgentEvent & { type: 'status'; message: string }) | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const candidate = events[i];
    if (
      candidate.type === 'status' &&
      typeof (candidate as { message?: unknown }).message === 'string' &&
      ((candidate as { message: string }).message).startsWith(ROUTING_TASKS_PREFIX)
    ) {
      routingTasksEvent = candidate as AgentEvent & { type: 'status'; message: string };
      break;
    }
  }

  if (!routingTasksEvent) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(routingTasksEvent.message.slice(ROUTING_TASKS_PREFIX.length));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }

    const modelByTaskId = new Map<string, TaskModelRoutingInfo>();
    for (const [taskId, rawInfo] of Object.entries(parsed)) {
      if (!rawInfo || typeof rawInfo !== 'object' || Array.isArray(rawInfo)) {
        continue;
      }
      const info = rawInfo as Record<string, unknown>;
      const model = typeof info.model === 'string' ? info.model.trim() : '';
      if (!model) {
        continue;
      }
      const effort = typeof info.effort === 'string' && info.effort.trim()
        ? info.effort
        : undefined;
      const isSubAgent = info.isSubAgent === true;
      const subAgentContext = info.subAgentContext === 'scoped' || info.subAgentContext === 'contextual'
        ? info.subAgentContext
        : undefined;
      modelByTaskId.set(taskId, {
        model,
        ...(effort ? { effort } : {}),
        ...(isSubAgent ? { isSubAgent: true } : {}),
        ...(subAgentContext ? { subAgentContext } : {}),
      });
    }

    return modelByTaskId.size > 0 ? modelByTaskId : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Extract pending tasks from the latest TaskList event in a turn.
 * The agent may call TaskList multiple times as it updates its plan,
 * so we use the most recent one.
 *
 * Also supports legacy TodoWrite events for backwards compatibility.
 */
const extractPendingTodos = (events: AgentEvent[]): PendingTodo[] => {
  // Take the last matching event (same rationale as extractTaskProgress).
  const snapshotEvents = events.filter(
    (e): e is Extract<AgentEvent, { type: 'tool' }> =>
      e.type === 'tool' && TASK_SNAPSHOT_TOOL_NAMES.has(e.toolName) && e.stage === 'end'
  );

  if (snapshotEvents.length > 0) {
    const latest = snapshotEvents[snapshotEvents.length - 1];
    const todos = parseTodosFromDetail(latest.detail, latest.toolName);
    if (todos.length > 0) return todos;
  }

  // Fallback to legacy TodoWrite events
  const todoWriteEvents = events.filter(
    (e): e is Extract<AgentEvent, { type: 'tool' }> =>
      e.type === 'tool' && e.toolName === 'TodoWrite' && e.stage === 'start'
  );

  if (todoWriteEvents.length === 0) return [];
  const latestTodo = todoWriteEvents[todoWriteEvents.length - 1];
  return parseTodosFromDetail(latestTodo.detail, 'TodoWrite');
};

const sanitizeToolSummary = (
  summary: StepToolSummary,
  fileSummary?: string | null,
  fallbackText?: string
): StepToolSummary => {
  const label = summary.label.trim();
  const count = summary.count ?? 1;
  const emphasis = summary.emphasis ?? 'primary';
  const status = summary.status;
  const parentToolUseId = summary.parentToolUseId;
  const emissionIndex = summary.emissionIndex;
  const emissionTimestamp = summary.emissionTimestamp;
  const isOpaque = TOOL_ID_PATTERN.test(label.toLowerCase()) || label.toLowerCase() === 'tool';
  if (!isOpaque) {
    return { ...summary, count } satisfies StepToolSummary;
  }

  if (fileSummary) {
    return {
      ...summary,
      label: fileSummary,
      detail: summary.detail ?? fallbackText ?? undefined,
      icon: '📄',
      tone: 'files',
      count,
      emphasis,
      status,
      parentToolUseId,
      emissionIndex,
      emissionTimestamp
    } satisfies StepToolSummary;
  }

  if (fallbackText) {
    return {
      ...summary,
      label: fallbackText,
      detail: summary.detail ?? undefined,
      icon: '🧠',
      tone: 'planning',
      count,
      emphasis,
      status,
      parentToolUseId,
      emissionIndex,
      emissionTimestamp
    } satisfies StepToolSummary;
  }

  return {
    ...summary,
    label: 'Tool call',
    detail: summary.detail ?? undefined,
    icon: '⚙️',
    tone: 'default',
    count,
    emphasis,
    status,
    parentToolUseId,
    emissionIndex,
    emissionTimestamp
  } satisfies StepToolSummary;
};

type ParallelSubagentsRendererState = {
  running: number;
  succeeded: number;
  failed: number;
  aborted: number;
  pending: number;
  latestBanner?: {
    text: string;
    status: 'running' | 'success';
    timestamp: number;
  };
};

const buildParallelSubagentsRendererState = (events: AgentEvent[]): ParallelSubagentsRendererState | null => {
  let state: ParallelSubagentsRendererState | null = null;

  for (const event of events) {
    if (event.type !== 'status' || typeof event.message !== 'string') {
      continue;
    }
    const parsed = parseParallelSubagentsStatusMessage(event.message);
    if (!parsed || parsed.kind === 'invalid') {
      continue;
    }

    if (!state) {
      state = {
        running: 0,
        succeeded: 0,
        failed: 0,
        aborted: 0,
        pending: 0,
      };
    }

    if (parsed.kind === 'start') {
      state.running = 0;
      state.succeeded = 0;
      state.failed = 0;
      state.aborted = 0;
      state.pending = parsed.payload.requested;
      const banner = formatParallelSubagentsBanner(parsed);
      if (banner) {
        state.latestBanner = {
          text: banner,
          status: 'running',
          timestamp: event.timestamp,
        };
      }
      continue;
    }

    if (parsed.kind === 'progress') {
      state.running = parsed.payload.running;
      state.succeeded = parsed.payload.succeeded;
      state.failed = parsed.payload.failed;
      state.pending = parsed.payload.pending;
      continue;
    }

    state.running = 0;
    state.succeeded = parsed.payload.succeeded;
    state.failed = parsed.payload.failed;
    state.aborted = parsed.payload.aborted;
    state.pending = Math.max(
      parsed.payload.requested - parsed.payload.succeeded - parsed.payload.failed - parsed.payload.aborted,
      0,
    );
    const banner = formatParallelSubagentsBanner(parsed);
    if (banner) {
      state.latestBanner = {
        text: banner,
        status: 'success',
        timestamp: event.timestamp,
      };
    }
  }

  return state;
};

type ToolEmissionInfo = {
  emissionIndex: number;
  timestamp: number;
};

const buildToolEmissionInfoByToolUseId = (events: AgentEvent[]): Map<string, ToolEmissionInfo> => {
  const infoByToolUseId = new Map<string, ToolEmissionInfo>();
  let nextEmissionIndex = 0;

  events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'tool')
    .sort((a, b) => {
      const aSeq = a.event.seq ?? Number.POSITIVE_INFINITY;
      const bSeq = b.event.seq ?? Number.POSITIVE_INFINITY;
      if (aSeq !== bSeq) return aSeq - bSeq;
      return a.index - b.index;
    })
    .forEach(({ event }) => {
      if (event.type !== 'tool') {
        return;
      }
      const toolUseId = event.toolUseId?.trim();
      if (!toolUseId || infoByToolUseId.has(toolUseId)) {
        return;
      }
      infoByToolUseId.set(toolUseId, {
        // First-observed event order is the closest renderer-side proxy for the
        // model's tool_use emission order. Completion timestamps are deliberately
        // not used for lead-primary selection.
        emissionIndex: nextEmissionIndex,
        timestamp: event.timestamp,
      });
      nextEmissionIndex += 1;
    });

  return infoByToolUseId;
};

const buildToolSummariesByStep = (
  assistantSteps: AgentEvent[],
  toolEvents: ToolAgentEvent[],
  allTurnEvents: AgentEvent[],
  fileOperationsByStep: FileOperationsByStep
): ToolSummaryByStep => {
  const toolSummariesByStep: ToolSummaryByStep = new Map();
  if (assistantSteps.length === 0) {
    return toolSummariesByStep;
  }

  const emissionInfoByToolUseId = buildToolEmissionInfoByToolUseId(allTurnEvents);

  const fileSummariesByStep = new Map<number, string | null>();
  fileOperationsByStep.forEach((operations, stepNumber) => {
    const endStageOps = operations.filter((operation) => operation.stage === 'end');
    const preferredOps = endStageOps.length > 0 ? endStageOps : operations;
    fileSummariesByStep.set(stepNumber, summarizeFileOperations(preferredOps));
  });

  const windows = assistantSteps.map((step, index) => ({
    stepNumber: index + 1,
    start: step.timestamp,
    end: index < assistantSteps.length - 1 ? assistantSteps[index + 1].timestamp : Number.POSITIVE_INFINITY
  }));

  const resolveStepNumber = (timestamp: number): number | null => {
    const match = windows.find((window) => timestamp >= window.start && timestamp < window.end);
    if (match) {
      return match.stepNumber;
    }
    if (timestamp < windows[0].start) {
      return windows[0].stepNumber;
    }
    return null;
  };

  if (toolEvents.length > 0) {
    // Build a map of start events by toolUseId for proper pairing
    // (FIFO pairing breaks when tools run concurrently or out of order)
    const startEventsByToolUseId = new Map<string, ToolAgentEvent>();
    const pairedEvents: Array<{ event: ToolAgentEvent; source?: ToolAgentEvent }> = [];

    toolEvents.forEach((event) => {
      if (event.stage === 'start') {
        if (event.toolUseId) {
          startEventsByToolUseId.set(event.toolUseId, event);
        }
      } else {
        // Match end event to its corresponding start event by toolUseId
        const source = event.toolUseId ? startEventsByToolUseId.get(event.toolUseId) : undefined;
        pairedEvents.push({ event, source });
        // Clean up to avoid memory growth
        if (event.toolUseId) {
          startEventsByToolUseId.delete(event.toolUseId);
        }
      }
    });

    // Add in-progress tools (start events without matching end events) so they're visible during execution
    startEventsByToolUseId.forEach((startEvent) => {
      pairedEvents.push({ event: startEvent });
    });

    const eventsForSummary: Array<{ event: ToolAgentEvent; source?: ToolAgentEvent }> =
      pairedEvents.length > 0 ? pairedEvents : toolEvents.map((event) => ({ event }));

    // Detect multi-tool steps (parallel batches) — these should not merge tools
    // so each parallel tool retains individual identity and status.
    const toolCountByStep = new Map<number, number>();
    for (const { event } of eventsForSummary) {
      const stepNum = resolveStepNumber(event.timestamp);
      if (stepNum) toolCountByStep.set(stepNum, (toolCountByStep.get(stepNum) ?? 0) + 1);
    }
    const multiToolSteps = new Set<number>();
    for (const [step, count] of toolCountByStep) {
      if (count > 1) multiToolSteps.add(step);
    }

    eventsForSummary.forEach(({ event, source }) => {
      const stepNumber = resolveStepNumber(event.timestamp);
      if (!stepNumber) {
        return;
      }
      const stepEvent = assistantSteps[stepNumber - 1];
      const fallbackText = stepEvent && 'text' in stepEvent ? stepEvent.text : undefined;
      const fileSummary = fileSummariesByStep.get(stepNumber) ?? null;
      const emissionInfo = event.toolUseId
        ? emissionInfoByToolUseId.get(event.toolUseId)
        : undefined;
      const summarizedEntry = summarizeToolEvent(event, {
          sourceToolName: source?.toolName,
          sourceDetail: source?.detail,
          fallbackLabel: fallbackText,
          fileSummary: fileSummary ?? undefined,
          fallbackDetail: fallbackText
        });
      const entry = sanitizeToolSummary(
        {
          ...summarizedEntry,
          emissionIndex: emissionInfo?.emissionIndex,
          emissionTimestamp: emissionInfo?.timestamp ?? source?.timestamp ?? event.timestamp,
        },
        fileSummary,
        fallbackText
      );
      const existing = toolSummariesByStep.get(stepNumber) ?? [];
      const lastEntry = existing[existing.length - 1];
      const isContinuation = !multiToolSteps.has(stepNumber) && Boolean(
        lastEntry &&
          lastEntry.label === entry.label &&
          lastEntry.tone === entry.tone &&
          (lastEntry.detail ?? '') === (entry.detail ?? '') &&
          (lastEntry.status ?? null) === (entry.status ?? null) &&
          (lastEntry.emphasis ?? 'primary') === (entry.emphasis ?? 'primary')
      );
      if (isContinuation && lastEntry) {
        const updatedLast: StepToolSummary = {
          ...lastEntry,
          count: (lastEntry.count ?? 1) + (entry.count ?? 1)
        };
        toolSummariesByStep.set(stepNumber, [...existing.slice(0, -1), updatedLast]);
      } else {
        toolSummariesByStep.set(stepNumber, [...existing, { ...entry, count: entry.count ?? 1 }]);
      }
    });
  }

  const parallelSubagentsState = buildParallelSubagentsRendererState(allTurnEvents);
  if (parallelSubagentsState?.latestBanner) {
    const stepNumber = resolveStepNumber(parallelSubagentsState.latestBanner.timestamp)
      ?? (assistantSteps.length > 0 ? assistantSteps.length : null);
    if (stepNumber) {
      const existing = toolSummariesByStep.get(stepNumber) ?? [];
      toolSummariesByStep.set(stepNumber, [
        ...existing,
        {
          label: parallelSubagentsState.latestBanner.text,
          icon: '⚡',
          tone: 'planning',
          status: parallelSubagentsState.latestBanner.status,
          emphasis: 'subtle',
        },
      ]);
    }
  }

  return toolSummariesByStep;
};

export type TurnStepContext = {
  assistantSteps: AgentEvent[];
  fileOperationsByStep: FileOperationsByStep;
  flattenedFileOperations: FileOperation[];
  toolSummariesByStep: ToolSummaryByStep;
  technicalEvents: AgentEvent[];
  technicalEventsByStep: Map<number, AgentEvent[]>;
  pendingTodos: PendingTodo[];
  missionContext: MissionContextData | null;
  taskProgress: TaskProgressItem[];
  turnTaskDelta: TurnTaskDelta;
  /** Model ID per step (1-indexed), derived from turn:complete events. Used for routing indicators. */
  modelByStep: Map<number, string>;
  /** Model routing metadata keyed by task ID, emitted by adaptive routing planning. */
  modelByTaskId?: Map<string, TaskModelRoutingInfo>;
};

export const buildTurnStepContextMap = (
  eventsByTurn: Record<string, AgentEvent[]>
): Record<string, TurnStepContext> => {
  const map: Record<string, TurnStepContext> = {};

  for (const [turnId, turnEvents] of Object.entries(eventsByTurn)) {
    if (!turnEvents || turnEvents.length === 0 || turnId === TURN_ID_FALLBACK) {
      continue;
    }

    const assistantEvents = turnEvents.filter((event) => event.type === 'assistant');
    const hasResultEvent = turnEvents.some((event) => event.type === 'result');
    const toolEvents = turnEvents
      .filter((event): event is ToolAgentEvent => event.type === 'tool')
      .sort((a, b) => a.timestamp - b.timestamp);
    const hasToolEvents = toolEvents.length > 0;
    const rawAssistantSteps = buildAssistantSteps(assistantEvents, hasResultEvent, hasToolEvents);

    // When the model emits only tool_use blocks (no text), assistantSteps is empty and
    // all tool events become invisible. Inject a synthetic step so tools have a container.
    if (rawAssistantSteps.length === 0 && toolEvents.length > 0) {
      const syntheticAssistantStep = {
        type: 'assistant',
        text: '',
        timestamp: toolEvents[0].timestamp,
      } satisfies Extract<AgentEvent, { type: 'assistant' }>;
      rawAssistantSteps.push(syntheticAssistantStep);
    }

    const { fileOperationsByStep, flattenedFileOperations } = buildFileOperationData(toolEvents, rawAssistantSteps);

    const toolSummariesByStep = buildToolSummariesByStep(rawAssistantSteps, toolEvents, turnEvents, fileOperationsByStep);
    const assistantSteps = rawAssistantSteps.map((step, index) => {
      const stepNumber = index + 1;
      const toolLabels = (toolSummariesByStep.get(stepNumber) ?? []).map((entry) => entry.label);
      const fileSummary = summarizeFileOperations(fileOperationsByStep.get(stepNumber) ?? []);
      const stepText = 'text' in step ? step.text : '';
      const displayText = getAssistantStepDisplayText(stepText, {
        toolLabels,
        fileSummary,
        allowGenericFallback: hasToolEvents
      });

      if (displayText === stepText) {
        return step;
      }

      return {
        ...step,
        text: displayText
      };
    });

    const technicalEvents = turnEvents.filter((event) => event.type !== 'assistant' && event.type !== 'turn_started');
    const technicalEventsByStep = buildTechnicalEventsByStep(technicalEvents, assistantSteps);
    const missionContext = extractMissionContext(turnEvents);
    const taskProgress = extractTaskProgress(turnEvents);
    const pendingTodos = taskProgress.length > 0
      ? taskProgress
          .filter((t) => t.status === 'pending')
          .map((t) => ({ id: t.id, content: t.title, priority: t.priority }))
      : extractPendingTodos(turnEvents);

    const turnTaskDelta = extractTurnTaskDelta(turnEvents, taskProgress);
    const modelByTaskId = parseModelByTaskId(turnEvents);

    // Build modelByStep from routing status events. For multi-switch turns,
    // each assistant step inherits the most recent routing:model event at or
    // before that step's timestamp.
    const modelByStep = new Map<number, string>();
    const routingEvents = turnEvents
      .filter((event): event is AgentEvent & { type: 'status'; message: string } =>
        event.type === 'status' &&
        typeof event.message === 'string' &&
        event.message.startsWith('routing:model:'),
      )
      .map((event) => ({
        timestamp: event.timestamp,
        model: event.message.slice('routing:model:'.length),
      }))
      .filter((event) => event.model.trim().length > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (let i = 0; i < assistantSteps.length; i++) {
      const stepTimestamp = assistantSteps[i].timestamp;
      let activeModel: string | undefined;
      for (const routingEvent of routingEvents) {
        if (routingEvent.timestamp <= stepTimestamp) {
          activeModel = routingEvent.model;
        } else {
          break;
        }
      }
      if (activeModel) {
        modelByStep.set(i + 1, activeModel);
      }
    }

    // Fallback: turns without routing status events use the result event model.
    if (modelByStep.size === 0) {
      const resultEvent = turnEvents.find(
        (event): event is AgentEvent & { type: 'result'; model: string } =>
          event.type === 'result' && 'model' in event && typeof event.model === 'string',
      );
      if (resultEvent?.model && assistantSteps.length > 0) {
        for (let i = 0; i < assistantSteps.length; i++) {
          modelByStep.set(i + 1, resultEvent.model);
        }
      }
    }

    map[turnId] = {
      assistantSteps,
      fileOperationsByStep,
      flattenedFileOperations,
      toolSummariesByStep,
      technicalEvents,
      technicalEventsByStep,
      pendingTodos,
      missionContext,
      taskProgress,
      turnTaskDelta,
      modelByStep,
      ...(modelByTaskId ? { modelByTaskId } : {}),
    } satisfies TurnStepContext;
  }

  return map;
};
