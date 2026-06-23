import type { AgentEvent } from '@shared/types';
import {
  parseIndividualTaskIdFromDetail,
  parseMissionFromDetail,
  parseTasksFromDetail,
} from './missionTask';
import {
  formatParallelSubagentsBanner,
  formatTaskRecoveryBanner,
  isParallelSubagentsStatusMessage,
  isTaskRecoveryStatusMessage,
  parseParallelSubagentsStatus,
  parseTaskRecoveryStatus,
} from '@core/rebelCore/parallelSubagentsStatus';
import {
  extractSubAgentMetadataFromRawDetail,
  isSubAgentToolName,
  type SubAgentItem,
} from './subAgents';
import type {
  CompletedStep,
  CurrentToolEvent,
  LiveTurnReducerResult,
  LiveTurnState,
  ReducerEnvelope,
  ReducerOptions,
  TurnReducerEffect,
} from './types';

export const MAX_TOOL_DETAIL_PREVIEW_CHARS = 500;

const MISSION_TASK_TOOL_NAMES = new Set(['MissionSet', 'TaskList', 'TaskCreate', 'TaskUpdate', 'TodoWrite'] as const);
type MissionTaskToolName = 'MissionSet' | 'TaskList' | 'TaskCreate' | 'TaskUpdate' | 'TodoWrite';

const SUPPRESSED_STATUS_PATTERNS: RegExp[] = [
  /^Agent initialized/,
  /^Context compacted/,
];

export function shouldSuppressStatus(message: string): boolean {
  return SUPPRESSED_STATUS_PATTERNS.some(pattern => pattern.test(message));
}

const toDisplayStatusText = (message: string): string | null => {
  if (isParallelSubagentsStatusMessage(message)) {
    return formatParallelSubagentsBanner(parseParallelSubagentsStatus(message));
  }

  if (isTaskRecoveryStatusMessage(message)) {
    return formatTaskRecoveryBanner(parseTaskRecoveryStatus(message));
  }

  return message;
};

export const truncateToolDetail = (detail: string | undefined): string | undefined => {
  if (typeof detail !== 'string') return undefined;
  return detail.length > MAX_TOOL_DETAIL_PREVIEW_CHARS ? detail.slice(0, MAX_TOOL_DETAIL_PREVIEW_CHARS) : detail;
};

const isMissionTaskToolName = (toolName: string | undefined): toolName is MissionTaskToolName =>
  typeof toolName === 'string' && MISSION_TASK_TOOL_NAMES.has(toolName as MissionTaskToolName);

export const createInitialLiveTurnState = (): LiveTurnState => ({
  isSending: false,
  streamingText: '',
  statusText: null,
  activeTurnId: null,
  currentTool: null,
  completedSteps: [],
  missionContext: null,
  taskProgress: [],
  subAgentItems: [],
  error: null,
  hasMissionSet: false,
  touchedTaskIds: [],
  userQuestionEventsByTurn: {},
  receivedTerminal: false,
  hasSeenTaskSnapshot: false,
});

export const createStartedLiveTurnState = (): LiveTurnState => ({
  ...createInitialLiveTurnState(),
  isSending: true,
});

type ToolLikeEvent = Extract<AgentEvent, { type: 'tool' }> & { turnId?: string };
type TurnIdEvent = AgentEvent & { turnId?: string };

const completedStepFromTool = (tool: CurrentToolEvent, now: number): CompletedStep => ({
  label: tool.toolName,
  timestamp: now,
  toolName: tool.toolName,
  detail: tool.detail,
  isError: tool.isError,
  toolUseId: tool.toolUseId,
});

const appendCompletedStep = (steps: CompletedStep[], step: CompletedStep): CompletedStep[] => [...steps, step];

const applyMissionTaskToolEvent = (
  state: LiveTurnState,
  event: Pick<ToolLikeEvent, 'stage' | 'toolName' | 'detail'>,
  resolvedToolName?: string,
): Pick<LiveTurnState, 'missionContext' | 'taskProgress' | 'hasMissionSet' | 'touchedTaskIds' | 'hasSeenTaskSnapshot'> => {
  const toolName = event.stage === 'end' ? resolvedToolName : event.toolName;
  if (!isMissionTaskToolName(toolName) || typeof event.detail !== 'string') {
    return state;
  }

  if (event.stage === 'start') {
    if (toolName === 'MissionSet') {
      return {
        ...state,
        missionContext: parseMissionFromDetail(event.detail),
        hasMissionSet: true,
      };
    }

    if (toolName === 'TodoWrite' && !state.hasSeenTaskSnapshot) {
      const todos = parseTasksFromDetail(event.detail, toolName);
      const allIds = todos.map(t => t.id);
      return {
        ...state,
        taskProgress: todos,
        touchedTaskIds: allIds.length > 0 ? allIds : state.touchedTaskIds,
      };
    }

    return state;
  }

  if (toolName === 'MissionSet') {
    return {
      ...state,
      missionContext: parseMissionFromDetail(event.detail),
      hasMissionSet: true,
    };
  }

  if (toolName === 'TaskList') {
    return {
      ...state,
      hasSeenTaskSnapshot: true,
      taskProgress: parseTasksFromDetail(event.detail, toolName),
    };
  }

  if (toolName === 'TaskCreate' || toolName === 'TaskUpdate') {
    const taskId = parseIndividualTaskIdFromDetail(event.detail);
    return {
      ...state,
      hasSeenTaskSnapshot: true,
      taskProgress: parseTasksFromDetail(event.detail, toolName),
      touchedTaskIds: taskId && !state.touchedTaskIds.includes(taskId)
        ? [...state.touchedTaskIds, taskId]
        : state.touchedTaskIds,
    };
  }

  return state;
};

const updateSubAgentStart = (items: SubAgentItem[], event: ToolLikeEvent, now: number): SubAgentItem[] => {
  if (!event.toolName || !isSubAgentToolName(event.toolName)) return items;
  const metadata = event.detail ? extractSubAgentMetadataFromRawDetail(event.detail) : null;
  return [
    ...items,
    {
      id: event.toolUseId ?? `subagent-${now}`,
      toolUseId: event.toolUseId,
      label: metadata?.label ?? 'Sub-agent',
      subagentType: metadata?.subagentType,
      summary: metadata?.summary,
      status: 'running',
      isBackground: false,
      startedAt: now,
    },
  ];
};

const updateSubAgentEnd = (
  items: SubAgentItem[],
  event: ToolLikeEvent,
  resolvedToolName: string | undefined,
  now: number,
): SubAgentItem[] => {
  if (!resolvedToolName || !isSubAgentToolName(resolvedToolName) || !event.toolUseId) return items;

  let changed = false;
  const isBackgroundAck =
    event.detail?.includes('Async agent launched successfully') ||
    event.detail?.includes('working in the background');

  const next = items.map((item) => {
    if (item.toolUseId !== event.toolUseId) return item;
    changed = true;
    if (isBackgroundAck) {
      return item.isBackground ? item : { ...item, isBackground: true };
    }
    return {
      ...item,
      status: 'completed' as const,
      completedAt: now,
      durationMs: now - item.startedAt,
      result: event.detail || undefined,
    };
  });

  return changed ? next : items;
};

const getErrorMessage = (event: Extract<AgentEvent, { type: 'error' }>, options: ReducerOptions): string => {
  const rawMessage = event.error || 'Something went wrong';
  return options.humanizeError
    ? options.humanizeError({
      errorKind: event.errorKind,
      billingMeta: event.billingMeta,
      rateLimitMeta: event.rateLimitMeta,
      provider: event.provider,
      rawMessage,
    })
    : rawMessage;
};

const getEventTurnId = (event: AgentEvent): string | undefined => (event as TurnIdEvent).turnId;

const appendUserQuestionEvent = (
  prev: Record<string, AgentEvent[]>,
  turnIdKey: string,
  event: AgentEvent,
): Record<string, AgentEvent[]> => {
  const previous = prev[turnIdKey] ?? [];
  const eventBatchId = (event as { batchId?: string }).batchId;
  if (eventBatchId) {
    const alreadyPresent = previous.some((existing) => {
      if (existing.type !== event.type) return false;
      const existingBatchId = (existing as unknown as { batchId?: string }).batchId;
      return existingBatchId === eventBatchId;
    });
    if (alreadyPresent) return prev;
  }

  return {
    ...prev,
    // eslint-disable-next-line no-restricted-syntax -- TODO(R2-Stage3-ingress-parse): Cloud-client receives user-question events from the cross-surface stream boundary. R2 Stage 3 must validate envelope routing (sessionId, batchId, toolUseId) at ingress; cloud-client cannot import the Zod-bearing manifest, so the validator must be generated/Zod-free and live in cloud-client or be invoked via a worker boundary.
    [turnIdKey]: [...previous, event as unknown as AgentEvent],
  };
};

export const reduceLiveTurnState = (
  prev: LiveTurnState,
  event: AgentEvent,
  envelope: ReducerEnvelope,
  options: ReducerOptions = {},
): LiveTurnReducerResult => {
  const effects: TurnReducerEffect[] = [];
  const suppressStatus = options.shouldSuppressStatus ?? shouldSuppressStatus;
  const truncateDetail = options.truncateToolDetail ?? truncateToolDetail;

  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- AgentEvent is open at runtime (events arrive over IPC/stream); this reducer handles a subset and the tolerant default logs-and-passthrough (forward-compat contract asserted in live.test.ts) — an exhaustive assertNever would crash a live turn on any unknown/future event.
  switch (event.type) {
    case 'turn_started': {
      const turnId = getEventTurnId(event) ?? envelope.turnId;
      if (!turnId) return { state: prev, effects };
      effects.push({ kind: 'log', level: 'info', message: 'turn_started', context: { turnId } });
      return {
        state: prev.activeTurnId === turnId ? prev : { ...prev, activeTurnId: turnId },
        effects,
      };
    }

    case 'status': {
      if (!event.message) {
        return { state: prev, effects };
      }
      const statusText = toDisplayStatusText(event.message);
      if (!statusText || suppressStatus(statusText) || prev.statusText === statusText) {
        return { state: prev, effects };
      }
      return { state: { ...prev, statusText }, effects };
    }

    case 'assistant_delta': {
      const streamingText = event.text ? prev.streamingText + event.text : prev.streamingText;
      if (streamingText === prev.streamingText && prev.statusText === null) return { state: prev, effects };
      return { state: { ...prev, streamingText, statusText: null }, effects };
    }

    case 'assistant': {
      effects.push({ kind: 'log', level: 'info', message: 'assistant (full)', context: { textLen: event.text?.length ?? 0 } });
      const streamingText = event.text || prev.streamingText;
      if (streamingText === prev.streamingText && prev.statusText === null) return { state: prev, effects };
      return { state: { ...prev, streamingText, statusText: null }, effects };
    }

    case 'thinking_delta': {
      if (prev.statusText === 'Thinking...') return { state: prev, effects };
      return { state: { ...prev, statusText: 'Thinking...' }, effects };
    }

    case 'tool': {
      const ev = event as ToolLikeEvent;
      if (ev.stage === 'start' && ev.toolName) {
        let completedSteps = prev.completedSteps;
        if (prev.currentTool) {
          completedSteps = appendCompletedStep(completedSteps, completedStepFromTool(prev.currentTool, envelope.now));
        }
        const currentTool: CurrentToolEvent = {
          toolName: ev.toolName,
          detail: truncateDetail(ev.detail),
          isError: ev.isError,
          toolUseId: ev.toolUseId,
        };
        const missionTask = applyMissionTaskToolEvent(prev, ev);
        const subAgentItems = updateSubAgentStart(prev.subAgentItems, ev, envelope.now);
        return {
          state: {
            ...prev,
            ...missionTask,
            completedSteps,
            currentTool,
            statusText: `Using ${ev.toolName}...`,
            streamingText: '',
            subAgentItems,
          },
          effects,
        };
      }

      if (ev.stage === 'end') {
        const toolName = prev.currentTool?.toolName || ev.toolName;
        const completedSteps = toolName
          ? appendCompletedStep(prev.completedSteps, {
            label: toolName,
            timestamp: envelope.now,
            toolName,
            detail: truncateDetail(prev.currentTool?.detail ?? ev.detail),
            isError: ev.isError ?? prev.currentTool?.isError,
            toolUseId: ev.toolUseId ?? prev.currentTool?.toolUseId,
          })
          : prev.completedSteps;
        const missionTask = applyMissionTaskToolEvent(prev, ev, toolName);
        const subAgentItems = updateSubAgentEnd(prev.subAgentItems, ev, toolName ?? ev.toolName, envelope.now);
        return {
          state: {
            ...prev,
            ...missionTask,
            completedSteps,
            currentTool: null,
            statusText: null,
            subAgentItems,
          },
          effects,
        };
      }

      return { state: prev, effects };
    }

    case 'result': {
      effects.push({ kind: 'log', level: 'info', message: 'turn result received' });
      const terminalTurnId = getEventTurnId(event) ?? envelope.turnId;
      if (terminalTurnId) {
        if (prev.completedSteps.length > 0) {
          effects.push({ kind: 'snapshot-completed-steps', turnId: terminalTurnId, steps: prev.completedSteps });
        }
        if (prev.missionContext || prev.taskProgress.length > 0) {
          effects.push({
            kind: 'snapshot-mission-task',
            turnId: terminalTurnId,
            mission: prev.missionContext,
            tasks: prev.taskProgress,
            hasMissionSet: prev.hasMissionSet,
            touchedTaskIds: prev.touchedTaskIds,
          });
        }
      }
      effects.push({ kind: 'terminal-refresh', sessionId: envelope.sessionId, clearOptimisticMessagesIfStable: true });

      if (prev.activeTurnId && terminalTurnId && prev.activeTurnId !== terminalTurnId) {
        return { state: { ...prev, receivedTerminal: true }, effects };
      }

      return {
        state: {
          ...prev,
          isSending: false,
          activeTurnId: null,
          statusText: null,
          currentTool: null,
          missionContext: null,
          taskProgress: prev.taskProgress.length === 0 ? prev.taskProgress : [],
          receivedTerminal: true,
        },
        effects,
      };
    }

    case 'error': {
      effects.push({ kind: 'log', level: 'error', message: 'turn error', context: { error: event.error, errorKind: event.errorKind } });
      const terminalTurnId = getEventTurnId(event) ?? envelope.turnId;
      effects.push({ kind: 'terminal-refresh', sessionId: envelope.sessionId, clearOptimisticMessagesIfStable: true });

      if (prev.activeTurnId && terminalTurnId && prev.activeTurnId !== terminalTurnId) {
        return { state: { ...prev, error: getErrorMessage(event, options), receivedTerminal: true }, effects };
      }

      return {
        state: {
          ...prev,
          error: getErrorMessage(event, options),
          isSending: false,
          activeTurnId: null,
          statusText: null,
          currentTool: null,
          missionContext: null,
          taskProgress: prev.taskProgress.length === 0 ? prev.taskProgress : [],
          receivedTerminal: true,
        },
        effects,
      };
    }

    case 'user_question':
    case 'user_question_answered': {
      const turnIdKey = envelope.turnId || getEventTurnId(event);
      if (!turnIdKey) return { state: prev, effects };
      const userQuestionEventsByTurn = appendUserQuestionEvent(prev.userQuestionEventsByTurn, turnIdKey, event);
      if (userQuestionEventsByTurn === prev.userQuestionEventsByTurn) return { state: prev, effects };
      return { state: { ...prev, userQuestionEventsByTurn }, effects };
    }

    // AgentEvent is OPEN at runtime: events arrive over IPC/stream, so values
    // outside the declared union legitimately appear here. This reducer handles a
    // subset and the forward-compat contract (asserted in live.test.ts) is
    // log-and-passthrough for everything else — an exhaustive assertNever would
    // crash a live turn on any new/unknown event type. (Guard suppressed at the
    // switch above — exhaustiveness does not apply to an open-at-runtime union.)
    default:
      effects.push({ kind: 'log', level: 'debug', message: 'unhandled event type', context: { type: event.type } });
      return { state: prev, effects };
  }
};
