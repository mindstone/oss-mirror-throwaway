import { humanizeToolActivity } from '@rebel/shared';
import type { CompletedStep } from '../hooks/useAgentTurn';
import type { ImageContentBlock, ImageRef, SessionToolEvent } from '../types';
import {
  computeTaskDisplayProps,
  computeTurnTaskDelta,
  extractMissionFromEvents,
  extractTasksFromEvents,
  extractTurnTaskDeltaFromEvents,
  TASK_MISSION_TOOL_NAMES,
  type MissionContext,
  type SnapshotCounts,
  type TaskProgressItem,
} from '../utils/missionTaskExtraction';
import {
  extractSubAgentItems,
  formatSubAgentName,
  isSubAgentToolName,
  type SubAgentItem,
} from '../utils/subAgentExtraction';
import { buildToolLabel } from '../utils/toolLabels';

export type MobileActivityState = 'active' | 'completed' | 'paused' | 'stalled' | 'error';

export type MobileAssistantDisplayItem = {
  id: string;
  roleLabel: string;
  activityLabel: string;
  status: 'running' | 'completed';
  elapsedLabel?: string;
  durationLabel?: string;
  isBackground?: boolean;
  summary?: string;
  modelLabel?: string;
};

export type MobileActivityStep = {
  key: string;
  label: string;
  shortDetail?: string;
  status: 'running' | 'completed' | 'error';
  imageContent?: ImageContentBlock[];
  imageRef?: (ImageRef | null)[];
};

export type MobileActivityViewModel = {
  state: MobileActivityState;
  headlineFallback?: string;
  runningToolLabel?: string;
  elapsedLabel?: string;
  durationLabel?: string;
  mission: MissionContext | null;
  tasks: TaskProgressItem[];
  displayTasks: TaskProgressItem[];
  snapshotCounts?: SnapshotCounts;
  currentTask?: TaskProgressItem;
  nextTask?: TaskProgressItem;
  assistants: MobileAssistantDisplayItem[];
  steps: MobileActivityStep[];
  hasMissionSet: boolean;
  touchedTaskIds: string[];
  errorCount: number;
  owningSessionId?: string;
  summary: {
    stepCount: number;
    assistantCount: number;
    taskCount: number;
    completedTaskCount: number;
  };
};

type BuildActiveActivityViewModelArgs = {
  headline: string;
  completedSteps: CompletedStep[];
  missionContext?: MissionContext | null;
  taskProgress?: TaskProgressItem[];
  subAgentItems?: SubAgentItem[];
  hasMissionSet?: boolean;
  touchedTaskIds?: string[];
  elapsedMs: number;
  isStalled: boolean;
  isError: boolean;
};

type BuildCompletedActivityViewModelArgs = {
  events?: SessionToolEvent[];
  fallbackSteps?: CompletedStep[];
  missionContext?: MissionContext | null;
  taskProgress?: TaskProgressItem[];
  subAgentItems?: SubAgentItem[];
  hasMissionSet?: boolean;
  touchedTaskIds?: string[];
  durationMs?: number;
  errorCount?: number;
  owningSessionId?: string;
};

type DeriveActivityHeaderResult = {
  state: MobileActivityState;
  headline: string;
  subheadline?: string;
  elapsedLabel?: string;
  progressLabel?: string;
};

type NormalizedAssistantItem = MobileAssistantDisplayItem & {
  sortTimestamp: number;
};

type StepWithToolName = MobileActivityStep & {
  toolName?: string;
  sortTimestamp: number;
  sortIndex: number;
};

const RUNNING_TOOL_PATTERN = /^Using\s+(.+?)\.\.\.$/i;
const MAX_ASSISTANT_SUMMARY = 120;

const MODEL_NAME_PATTERN = /\b(?:gpt(?:-[\w.]+)?|claude(?:-[\w.]+)?|gemini(?:-[\w.]+)?|llama(?:-[\w.]+)?|mistral(?:-[\w.]+)?|o\d(?:-[\w.]+)?|sonnet|opus|haiku)\b/i;

const HEADER_COPY = {
  activeGeneric: 'Working on this',
  activeAssistants: (count: number) => `Coordinating ${count} assistants`,
  completed: 'Done',
  completedWithCounts: (summaryBits: string) => `Done — ${summaryBits}`,
  paused: 'Waiting for you',
  stalled: 'Taking longer than expected',
  stalledSubheadline: 'Still working. This one has layers.',
  error: 'Something tripped',
  errorSubheadline: 'Some details may be incomplete.',
  gettingStarted: 'Getting started',
} as const;

export function formatActivityElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
};

const looksLikeModelLabel = (value: string | undefined): boolean => {
  if (!value) return false;
  const normalized = value.trim();
  if (!normalized) return false;
  return MODEL_NAME_PATTERN.test(normalized);
};

const parseRunningToolName = (headline: string): string | null => {
  const trimmed = headline.trim();
  if (!trimmed) return null;
  const match = RUNNING_TOOL_PATTERN.exec(trimmed);
  return match?.[1]?.trim() || null;
};

const toStepFromTool = (
  key: string,
  toolName: string,
  detail: string | undefined,
  status: MobileActivityStep['status'],
  sortTimestamp: number,
  sortIndex: number,
  imageContent?: ImageContentBlock[],
  imageRef?: (ImageRef | null)[],
): StepWithToolName => {
  const fallbackToolName = toolName.trim() || 'tool';
  const toolLabel = buildToolLabel(fallbackToolName, detail);
  return {
    key,
    label: humanizeToolActivity(fallbackToolName, detail),
    shortDetail: toolLabel.shortDetail,
    status,
    imageContent,
    imageRef,
    toolName: fallbackToolName,
    sortTimestamp,
    sortIndex,
  };
};

const dedupeAndFilterSteps = (
  steps: StepWithToolName[],
  hasMissionOrTasks: boolean,
  hasAssistants: boolean,
): MobileActivityStep[] => {
  let filtered = steps;
  if (hasMissionOrTasks || hasAssistants) {
    filtered = filtered.filter((step) => {
      const toolName = step.toolName ?? '';
      if (hasMissionOrTasks && TASK_MISSION_TOOL_NAMES.has(toolName)) return false;
      if (hasAssistants && isSubAgentToolName(toolName)) return false;
      return true;
    });
  }

  filtered.sort((a, b) => {
    if (a.sortTimestamp === b.sortTimestamp) {
      return a.sortIndex - b.sortIndex;
    }
    return a.sortTimestamp - b.sortTimestamp;
  });

  const seen = new Set<string>();
  return filtered.filter((step) => {
    if (step.status === 'running') return true;
    const key = `${step.label}::${step.shortDetail ?? ''}::${step.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((step) => ({
    key: step.key,
    label: step.label,
    shortDetail: step.shortDetail,
    status: step.status,
    imageContent: step.imageContent,
    imageRef: step.imageRef,
  }));
};

const deriveSnapshotCounts = (tasks: TaskProgressItem[]): SnapshotCounts | undefined => {
  if (tasks.length === 0) return undefined;
  return {
    total: tasks.length,
    completed: tasks.filter((task) => task.status === 'completed').length,
  };
};

const findCurrentTask = (tasks: TaskProgressItem[]): TaskProgressItem | undefined =>
  tasks.find((task) => task.status === 'in_progress')
  ?? tasks.find((task) => task.status === 'pending')
  ?? tasks[0];

const findNextTask = (
  tasks: TaskProgressItem[],
  currentTask?: TaskProgressItem,
): TaskProgressItem | undefined => {
  if (!currentTask) return undefined;
  const currentIndex = tasks.findIndex((task) => task.id === currentTask.id);
  if (currentIndex === -1) return undefined;
  return tasks
    .slice(currentIndex + 1)
    .find((task) => task.status === 'pending' || task.status === 'in_progress');
};

const normalizeAssistantSummary = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return truncate(trimmed, MAX_ASSISTANT_SUMMARY);
};

const deriveRoleLabel = (item: SubAgentItem): { roleLabel: string; modelLabel?: string } => {
  const typeLabel = item.subagentType?.trim();
  const candidateRole = typeLabel ? formatSubAgentName(typeLabel) : item.label.trim() || 'Assistant';
  const candidateModel = typeLabel && looksLikeModelLabel(typeLabel)
    ? typeLabel
    : looksLikeModelLabel(item.label) ? item.label : undefined;

  if (looksLikeModelLabel(candidateRole)) {
    return {
      roleLabel: 'Assistant',
      modelLabel: candidateModel ?? candidateRole,
    };
  }

  return {
    roleLabel: candidateRole || 'Assistant',
    modelLabel: candidateModel,
  };
};

const deriveAssistantActivityLabel = (item: SubAgentItem, roleLabel: string): string => {
  const summary = normalizeAssistantSummary(item.summary);
  if (summary && !looksLikeModelLabel(summary)) return summary;

  const result = normalizeAssistantSummary(item.result);
  if (result && !looksLikeModelLabel(result)) return result;

  if (item.subagentType && !looksLikeModelLabel(item.subagentType)) {
    return humanizeToolActivity('Task', JSON.stringify({ subagent_type: item.subagentType }));
  }

  const toolLikeLabel = buildToolLabel(item.label || 'Task').label;
  if (!looksLikeModelLabel(toolLikeLabel)) {
    return humanizeToolActivity(toolLikeLabel);
  }

  return roleLabel === 'Assistant' ? HEADER_COPY.activeGeneric : `Working as ${roleLabel}`;
};

export function deriveAssistantDisplayItems(subAgentItems: SubAgentItem[]): MobileAssistantDisplayItem[] {
  if (subAgentItems.length === 0) return [];

  const now = Date.now();
  const normalizedItems: NormalizedAssistantItem[] = subAgentItems.map((item, index) => {
    const { roleLabel, modelLabel } = deriveRoleLabel(item);
    const status: MobileAssistantDisplayItem['status'] = item.status === 'running' ? 'running' : 'completed';
    const elapsedMs = Math.max(0, (item.durationMs ?? 0) || (now - item.startedAt));
    const durationMs = Math.max(
      0,
      item.durationMs
      ?? (item.completedAt != null ? item.completedAt - item.startedAt : 0),
    );

    return {
      id: item.id || `assistant-${index}`,
      roleLabel,
      activityLabel: deriveAssistantActivityLabel(item, roleLabel),
      status,
      elapsedLabel: status === 'running' ? formatActivityElapsed(elapsedMs) : undefined,
      durationLabel: status === 'completed' ? formatActivityElapsed(durationMs) : undefined,
      isBackground: item.isBackground,
      summary: normalizeAssistantSummary(item.summary),
      modelLabel,
      sortTimestamp: item.startedAt,
    };
  });

  const grouped = new Map<string, NormalizedAssistantItem[]>();
  normalizedItems.forEach((item) => {
    const key = [
      item.roleLabel,
      item.activityLabel,
      item.status,
      item.isBackground ? '1' : '0',
      item.summary ?? '',
      item.modelLabel ?? '',
    ].join('::');
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  });

  return Array.from(grouped.values())
    .map((group) => {
      const first = group[0];
      if (group.length === 1) {
        return {
          id: first.id,
          roleLabel: first.roleLabel,
          activityLabel: first.activityLabel,
          status: first.status,
          elapsedLabel: first.elapsedLabel,
          durationLabel: first.durationLabel,
          isBackground: first.isBackground,
          summary: first.summary,
          modelLabel: first.modelLabel,
        };
      }

      const elapsedMsValues = group
        .map((item) => item.elapsedLabel)
        .filter((label): label is string => Boolean(label));
      const durationMsValues = group
        .map((item) => item.durationLabel)
        .filter((label): label is string => Boolean(label));

      return {
        id: group.map((item) => item.id).join(','),
        roleLabel: `${first.roleLabel} ×${group.length}`,
        activityLabel: first.activityLabel,
        status: first.status,
        elapsedLabel: elapsedMsValues[0],
        durationLabel: durationMsValues[0],
        isBackground: first.isBackground,
        summary: first.summary,
        modelLabel: first.modelLabel,
      };
    })
    .sort((a, b) => {
      if (a.status === b.status) return 0;
      return a.status === 'running' ? -1 : 1;
    });
}

const mapEventsToSteps = (events: SessionToolEvent[]): StepWithToolName[] => {
  type Pair = {
    start?: SessionToolEvent;
    end?: SessionToolEvent;
    firstTimestamp: number;
    firstIndex: number;
  };

  const pairedByToolUseId = new Map<string, Pair>();
  const standaloneEvents: Array<{ event: SessionToolEvent; index: number }> = [];

  events.forEach((event, index) => {
    if (event.mcpAppUiMeta?.presentation === 'primary') return;

    const toolUseId = event.toolUseId?.trim();
    if (!toolUseId) {
      standaloneEvents.push({ event, index });
      return;
    }

    const existing = pairedByToolUseId.get(toolUseId);
    const pair = existing ?? {
      firstTimestamp: event.timestamp,
      firstIndex: index,
    };

    if (
      event.timestamp < pair.firstTimestamp
      || (event.timestamp === pair.firstTimestamp && index < pair.firstIndex)
    ) {
      pair.firstTimestamp = event.timestamp;
      pair.firstIndex = index;
    }

    if (event.stage === 'start') {
      pair.start = event;
    } else if (event.stage === 'end') {
      pair.end = event;
    }

    pairedByToolUseId.set(toolUseId, pair);
  });

  const steps: StepWithToolName[] = [];

  pairedByToolUseId.forEach((pair, toolUseId) => {
    const source = pair.start ?? pair.end;
    if (!source) return;
    const detail = pair.start?.detail ?? pair.end?.detail;
    const status: MobileActivityStep['status'] = pair.start && !pair.end
      ? 'running'
      : pair.end?.isError ? 'error' : 'completed';
    steps.push(
      toStepFromTool(
        `event-${toolUseId}`,
        source.toolName,
        detail,
        status,
        pair.firstTimestamp,
        pair.firstIndex,
        pair.end?.imageContent,
        pair.end?.imageRef,
      ),
    );
  });

  standaloneEvents.forEach(({ event, index }) => {
    const status: MobileActivityStep['status'] = event.stage === 'start'
      ? 'running'
      : event.isError ? 'error' : 'completed';
    steps.push(
      toStepFromTool(
        `event-${event.timestamp}-${index}`,
        event.toolName,
        event.detail,
        status,
        event.timestamp,
        index,
        event.stage === 'end' ? event.imageContent : undefined,
        event.stage === 'end' ? event.imageRef : undefined,
      ),
    );
  });

  return steps;
};

const mapFallbackSteps = (fallbackSteps: CompletedStep[]): StepWithToolName[] =>
  fallbackSteps.map((step, index) => {
    const fallbackToolName = step.toolName?.trim() || step.label?.trim() || 'tool';
    return toStepFromTool(
      step.toolUseId ? `step-${step.toolUseId}` : `step-${step.timestamp}-${index}`,
      fallbackToolName,
      step.detail,
      step.isError ? 'error' : 'completed',
      step.timestamp,
      index,
    );
  });

export function buildActiveActivityViewModel({
  headline,
  completedSteps,
  missionContext,
  taskProgress,
  subAgentItems,
  hasMissionSet,
  touchedTaskIds,
  elapsedMs,
  isStalled,
  isError,
}: BuildActiveActivityViewModelArgs): MobileActivityViewModel {
  const safeHeadline = headline.trim();
  const mission = missionContext ?? null;
  const tasks = taskProgress ?? [];
  const assistants = deriveAssistantDisplayItems(subAgentItems ?? []);

  const turnDelta = tasks.length > 0
    ? computeTurnTaskDelta(tasks, touchedTaskIds ?? [], hasMissionSet ?? false)
    : null;
  const displayProps = computeTaskDisplayProps(turnDelta, mission, true);
  const displayTasks = displayProps?.displayTasks ?? tasks;
  const snapshotCounts = displayProps?.snapshotCounts ?? deriveSnapshotCounts(tasks);
  const currentTask = findCurrentTask(displayTasks);
  const nextTask = findNextTask(displayTasks, currentTask);

  const runningToolName = parseRunningToolName(safeHeadline);
  const runningToolLabel = runningToolName ? humanizeToolActivity(runningToolName) : undefined;

  const allSteps: StepWithToolName[] = completedSteps.map((step, index) => {
    const fallbackToolName = step.toolName?.trim() || step.label?.trim() || 'tool';
    return toStepFromTool(
      step.toolUseId ? `step-${step.toolUseId}` : `step-${step.timestamp}-${index}`,
      fallbackToolName,
      step.detail,
      step.isError ? 'error' : 'completed',
      step.timestamp,
      index,
    );
  });

  if (runningToolName) {
    allSteps.push(
      toStepFromTool(
        `running-${runningToolName}`,
        runningToolName,
        undefined,
        'running',
        Date.now(),
        Number.MAX_SAFE_INTEGER,
      ),
    );
  }

  const hasMissionOrTasks = Boolean(displayProps || mission || tasks.length > 0);
  const steps = dedupeAndFilterSteps(allSteps, hasMissionOrTasks, assistants.length > 0);
  const resolvedState: MobileActivityState = isError
    ? 'error'
    : isStalled ? 'stalled' : 'active';
  const errorCount = steps.filter((step) => step.status === 'error').length + (isError ? 1 : 0);

  return {
    state: resolvedState,
    headlineFallback: safeHeadline || undefined,
    runningToolLabel,
    elapsedLabel: formatActivityElapsed(elapsedMs),
    mission,
    tasks,
    displayTasks,
    snapshotCounts,
    currentTask,
    nextTask,
    assistants,
    steps,
    hasMissionSet: hasMissionSet ?? false,
    touchedTaskIds: touchedTaskIds ?? [],
    errorCount,
    summary: {
      stepCount: steps.length,
      assistantCount: assistants.length,
      taskCount: snapshotCounts?.total ?? 0,
      completedTaskCount: snapshotCounts?.completed ?? 0,
    },
  };
}

export function buildCompletedActivityViewModel({
  events,
  fallbackSteps,
  missionContext,
  taskProgress,
  subAgentItems,
  hasMissionSet,
  touchedTaskIds,
  durationMs,
  errorCount,
  owningSessionId,
}: BuildCompletedActivityViewModelArgs): MobileActivityViewModel {
  const sourceEvents = events ?? [];

  const mission = missionContext !== undefined
    ? missionContext
    : (sourceEvents.length > 0 ? extractMissionFromEvents(sourceEvents) : null);
  const tasks = taskProgress !== undefined
    ? taskProgress
    : (sourceEvents.length > 0 ? extractTasksFromEvents(sourceEvents) : []);
  const assistants = deriveAssistantDisplayItems(
    subAgentItems !== undefined
      ? subAgentItems
      : (sourceEvents.length > 0 ? extractSubAgentItems(sourceEvents) : []),
  );

  const turnDelta = tasks.length > 0 && (hasMissionSet !== undefined || touchedTaskIds !== undefined)
    ? computeTurnTaskDelta(tasks, touchedTaskIds ?? [], hasMissionSet ?? false)
    : (sourceEvents.length > 0 ? extractTurnTaskDeltaFromEvents(sourceEvents) : null);
  const displayProps = computeTaskDisplayProps(turnDelta, mission ?? null, false);
  const displayTasks = displayProps?.displayTasks ?? tasks;
  const snapshotCounts = displayProps?.snapshotCounts ?? deriveSnapshotCounts(tasks);
  const currentTask = findCurrentTask(displayTasks);
  const nextTask = findNextTask(displayTasks, currentTask);

  const allSteps = sourceEvents.length > 0
    ? mapEventsToSteps(sourceEvents)
    : mapFallbackSteps(fallbackSteps ?? []);
  const hasMissionOrTasks = Boolean(displayProps || mission || tasks.length > 0);
  const steps = dedupeAndFilterSteps(allSteps, hasMissionOrTasks, assistants.length > 0);

  const derivedErrorCount = errorCount
    ?? steps.filter((step) => step.status === 'error').length;
  const resolvedState: MobileActivityState = derivedErrorCount > 0 ? 'error' : 'completed';

  return {
    state: resolvedState,
    durationLabel: durationMs != null ? formatActivityElapsed(durationMs) : undefined,
    mission: mission ?? null,
    tasks,
    displayTasks,
    snapshotCounts,
    currentTask,
    nextTask,
    assistants,
    steps,
    hasMissionSet: hasMissionSet ?? turnDelta?.hasMissionSet ?? false,
    touchedTaskIds: touchedTaskIds ?? turnDelta?.touchedTaskIds ?? [],
    errorCount: derivedErrorCount,
    owningSessionId,
    summary: {
      stepCount: steps.length,
      assistantCount: assistants.length,
      taskCount: snapshotCounts?.total ?? 0,
      completedTaskCount: snapshotCounts?.completed ?? 0,
    },
  };
}

const buildCompletedHeadline = (viewModel: MobileActivityViewModel): string => {
  const summaryBits: string[] = [];
  if (viewModel.summary.stepCount > 0) {
    summaryBits.push(`${viewModel.summary.stepCount} step${viewModel.summary.stepCount === 1 ? '' : 's'}`);
  }
  if (viewModel.summary.assistantCount > 0) {
    summaryBits.push(`${viewModel.summary.assistantCount} assistant${viewModel.summary.assistantCount === 1 ? '' : 's'}`);
  }

  if (summaryBits.length === 0) {
    return HEADER_COPY.completed;
  }

  return HEADER_COPY.completedWithCounts(summaryBits.join(', '));
};

export function deriveActivityHeader(viewModel: MobileActivityViewModel): DeriveActivityHeaderResult {
  const progressLabel = viewModel.summary.taskCount > 0
    ? `${viewModel.summary.completedTaskCount}/${viewModel.summary.taskCount} tasks`
    : undefined;
  const elapsedLabel = viewModel.elapsedLabel ?? viewModel.durationLabel;

  if (viewModel.state === 'error') {
    return {
      state: 'error',
      headline: HEADER_COPY.error,
      subheadline: HEADER_COPY.errorSubheadline,
      elapsedLabel,
      progressLabel,
    };
  }

  if (viewModel.state === 'stalled') {
    return {
      state: 'stalled',
      headline: HEADER_COPY.stalled,
      subheadline: HEADER_COPY.stalledSubheadline,
      elapsedLabel,
      progressLabel,
    };
  }

  if (viewModel.state === 'paused') {
    return {
      state: 'paused',
      headline: HEADER_COPY.paused,
      elapsedLabel,
      progressLabel,
    };
  }

  if (viewModel.state === 'completed') {
    return {
      state: 'completed',
      headline: buildCompletedHeadline(viewModel),
      elapsedLabel,
      progressLabel,
    };
  }

  if (viewModel.runningToolLabel) {
    return {
      state: 'active',
      headline: viewModel.runningToolLabel,
      elapsedLabel,
      progressLabel,
    };
  }

  if (viewModel.assistants.length > 0) {
    if (viewModel.assistants.length >= 2) {
      return {
        state: 'active',
        headline: HEADER_COPY.activeAssistants(viewModel.assistants.length),
        elapsedLabel,
        progressLabel,
      };
    }
    const firstAssistant = viewModel.assistants[0];
    return {
      state: 'active',
      headline: firstAssistant.activityLabel || firstAssistant.roleLabel,
      elapsedLabel,
      progressLabel,
    };
  }

  if (viewModel.currentTask?.title) {
    return {
      state: 'active',
      headline: viewModel.currentTask.title,
      elapsedLabel,
      progressLabel,
    };
  }

  if (viewModel.headlineFallback) {
    return {
      state: 'active',
      headline: viewModel.headlineFallback,
      elapsedLabel,
      progressLabel,
    };
  }

  const hasContext = viewModel.steps.length > 0
    || viewModel.summary.taskCount > 0
    || viewModel.assistants.length > 0
    || Boolean(viewModel.mission);

  return {
    state: 'active',
    headline: hasContext ? HEADER_COPY.activeGeneric : HEADER_COPY.gettingStarted,
    elapsedLabel,
    progressLabel,
  };
}
