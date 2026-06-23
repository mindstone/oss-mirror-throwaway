import { memo, useMemo, useState, useCallback } from 'react';
import { cn } from '@renderer/lib/utils';
import { Tooltip } from '@renderer/components/ui';
import { Bot, Check, ChevronRight } from 'lucide-react';
import type { MissionContextData, TaskModelRoutingInfo, TaskProgressItem } from '../utils/turnStepContext';
import type { SnapshotCounts } from '@rebel/shared';
import { simplifyTaskTitle } from '../utils/activityDerivation';
import { shortModelName } from '../utils/modelAgentLabels';
import styles from './MissionProgressCard.module.css';

const MAX_VISIBLE_TASKS = 8;

const STATUS_LABELS: Record<TaskProgressItem['status'], string> = {
  pending: 'Ready',
  in_progress: 'Working',
  completed: 'Done',
  blocked: 'Waiting'
};

/** Check if a task has expandable content (simplified title differs, has description/blockers, or is blocked). */
const hasExpandableContent = (task: TaskProgressItem): boolean => {
  if (task.status === 'blocked') return true;
  if (task.description || (task.blockers && task.blockers.length > 0)) return true;
  return simplifyTaskTitle(task.title) !== task.title;
};

/** Resolve a blocker ID to a task title. Returns null for unresolvable blockers. */
const resolveBlockerLabel = (blocker: string, tasks: TaskProgressItem[]): string | null => {
  const match = tasks.find(t => t.id === blocker);
  return match ? match.title : null;
};

type TaskRenderEntry =
  | { kind: 'single'; task: TaskProgressItem }
  | { kind: 'group'; groupId: string; tasks: TaskProgressItem[] };

const groupTasksByParallelRun = (tasks: TaskProgressItem[]): TaskRenderEntry[] => {
  const entries: TaskRenderEntry[] = [];
  let i = 0;
  while (i < tasks.length) {
    const task = tasks[i];
    const groupId = task.parallelGroup;
    if (!groupId) {
      entries.push({ kind: 'single', task });
      i += 1;
      continue;
    }
    let runEnd = i + 1;
    while (runEnd < tasks.length && tasks[runEnd].parallelGroup === groupId) {
      runEnd += 1;
    }
    const run = tasks.slice(i, runEnd);
    if (run.length >= 2) {
      entries.push({ kind: 'group', groupId, tasks: run });
    } else {
      entries.push({ kind: 'single', task });
    }
    i = runEnd;
  }
  return entries;
};

type TaskModelBadgeState = {
  info: TaskModelRoutingInfo;
  isContinuation: boolean;
};

const getSubAgentContextLabel = (context: TaskModelRoutingInfo['subAgentContext']): string | null => {
  if (context === 'scoped') return 'focused';
  if (context === 'contextual') return 'full context';
  return null;
};

const buildTaskModelBadgeStates = (
  tasks: TaskProgressItem[] | undefined,
  modelByTaskId: Map<string, TaskModelRoutingInfo> | undefined,
): Map<string, TaskModelBadgeState> => {
  const badgeStates = new Map<string, TaskModelBadgeState>();
  if (!tasks?.length || !modelByTaskId || modelByTaskId.size === 0) {
    return badgeStates;
  }

  let previousInfo: TaskModelRoutingInfo | undefined;
  for (const task of tasks) {
    const info = modelByTaskId.get(task.id);
    if (!info) {
      previousInfo = undefined;
      continue;
    }

    const isContinuation = Boolean(
      previousInfo &&
        previousInfo.model === info.model &&
        !previousInfo.isSubAgent &&
        !info.isSubAgent
    );

    badgeStates.set(task.id, { info, isContinuation });
    previousInfo = info;
  }

  return badgeStates;
};

const renderTaskModelBadge = (badgeState: TaskModelBadgeState | undefined) => {
  if (!badgeState) return null;

  const { info, isContinuation } = badgeState;
  const modelLabel = shortModelName(info.model);
  const contextLabel = info.isSubAgent ? getSubAgentContextLabel(info.subAgentContext) : null;
  const fullLabel = [
    modelLabel,
    contextLabel,
  ].filter(Boolean).join(' · ');
  const tooltip = info.effort
    ? `${info.model} · ${info.effort}`
    : info.model;

  return (
    <Tooltip content={tooltip} placement="top" delayShow={300}>
      <span
        className={cn(
          styles.modelBadge,
          info.isSubAgent && styles.modelBadgeSubAgent,
          isContinuation && styles.modelContinuation,
        )}
        aria-label={isContinuation ? `Same model as previous task: ${fullLabel}` : `Model: ${fullLabel}`}
      >
        {isContinuation ? (
          '·'
        ) : (
          <>
            {info.isSubAgent && <Bot size={12} strokeWidth={2} className={styles.modelBadgeIcon} aria-hidden="true" />}
            <span>{fullLabel}</span>
          </>
        )}
      </span>
    </Tooltip>
  );
};

/** Build condensed tooltip preview for a task. */
const buildTooltipContent = (task: TaskProgressItem, allTasks: TaskProgressItem[]) => {
  const blockers = task.blockers ?? [];
  const resolvedBlockers = task.status === 'blocked' && blockers.length > 0
    ? blockers.map(b => resolveBlockerLabel(b, allTasks)).filter(Boolean) as string[]
    : [];
  return (
    <div className={styles.tooltipContent}>
      {task.description && (
        <p className={styles.tooltipDescription}>
          {task.description.length > 150 ? task.description.slice(0, 150) + '\u2026' : task.description}
        </p>
      )}
      {resolvedBlockers.length > 0 && (
        <div className={styles.tooltipBlockers}>
          <span>Waiting on:</span>
          <ul>
            {resolvedBlockers.map((label, i) => (
              <li key={i}>{label}</li>
            ))}
          </ul>
        </div>
      )}
      {task.status === 'blocked' && resolvedBlockers.length === 0 && blockers.length > 0 && (
        <p className={styles.tooltipDescription}>Waiting on earlier steps</p>
      )}
    </div>
  );
};

const summarizeMissionGoal = (goal: string): string => {
  let short = simplifyTaskTitle(goal);
  short = short.replace(/^Run\s+(the\s+)?/i, '');
  short = short.replace(/^Use\s+(the\s+)?/i, '');
  short = short.replace(/\s+/g, ' ').trim();

  if (short.length > 56) {
    const cut = short.slice(0, 56);
    const lastSpace = cut.lastIndexOf(' ');
    short = `${lastSpace > 32 ? cut.slice(0, lastSpace) : cut}\u2026`;
  }

  return short;
};

const getTaskFocusIndex = (tasks: TaskProgressItem[], completedCount: number): number => {
  const inProgressIndex = tasks.findIndex((task) => task.status === 'in_progress');
  if (inProgressIndex >= 0) return inProgressIndex;

  const blockedIndex = tasks.findIndex((task) => task.status === 'blocked');
  if (blockedIndex >= 0) return blockedIndex;

  const pendingIndex = tasks.findIndex((task) => task.status === 'pending');
  if (pendingIndex >= 0) return pendingIndex;

  return Math.max(0, Math.min(tasks.length - 1, completedCount - 1));
};

const getVisibleTaskWindow = (
  tasks: TaskProgressItem[],
  completedCount: number,
  showAllTasks: boolean,
) => {
  if (tasks.length <= MAX_VISIBLE_TASKS || showAllTasks) {
    return {
      start: 0,
      items: tasks,
      hiddenBefore: 0,
      hiddenAfter: 0,
    };
  }

  const focusIndex = getTaskFocusIndex(tasks, completedCount);

  // Start from 0 by default so step 1 is always visible.
  // Only shift the window if the focus task would fall outside it.
  let start = 0;
  if (focusIndex >= MAX_VISIBLE_TASKS) {
    const maxStart = Math.max(0, tasks.length - MAX_VISIBLE_TASKS);
    start = Math.min(focusIndex - MAX_VISIBLE_TASKS + 2, maxStart);
  }

  const items = tasks.slice(start, start + MAX_VISIBLE_TASKS);

  return {
    start,
    items,
    hiddenBefore: start,
    hiddenAfter: tasks.length - (start + items.length),
  };
};

// ── TaskItemRow sub-component ───────────────────────────────────

type TaskItemRowProps = {
  task: TaskProgressItem;
  allTasks: TaskProgressItem[];
  isExpanded: boolean;
  onToggleExpand: (taskId: string) => void;
  /** Override visual status (e.g., infer in_progress for the first pending task). */
  visualStatus?: TaskProgressItem['status'];
  modelBadgeState?: TaskModelBadgeState;
};

/** Single task row with simplified title and accordion for full details. */
const TaskItemRow = ({ task, allTasks, isExpanded, onToggleExpand, visualStatus, modelBadgeState }: TaskItemRowProps) => {
  const displayStatus = visualStatus ?? task.status;
  const expandable = hasExpandableContent(task);
  const shortTitle = useMemo(() => simplifyTaskTitle(task.title), [task.title]);
  const showFullTitle = shortTitle !== task.title;
  const isBlocked = displayStatus === 'blocked';
  const blockers = useMemo(() => task.blockers ?? [], [task.blockers]);
  const resolvedBlockerTitles = useMemo(
    () => isBlocked ? blockers.map(b => resolveBlockerLabel(b, allTasks)).filter((label): label is string => label != null) : [],
    [isBlocked, blockers, allTasks],
  );

  const handleClick = useCallback(() => {
    if (expandable) onToggleExpand(task.id);
  }, [expandable, onToggleExpand, task.id]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (expandable && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onToggleExpand(task.id);
    }
  }, [expandable, onToggleExpand, task.id]);

  const liProps = {
    className: cn(
      styles.task,
      styles[`task_${displayStatus}`],
      modelBadgeState?.info.isSubAgent && styles.taskSubAgent,
      expandable && styles.taskExpandable
    ),
    ...(expandable ? {
      onClick: handleClick,
      onKeyDown: handleKeyDown,
      role: 'button' as const,
      tabIndex: 0,
      'aria-expanded': isExpanded,
      'data-testid': `task-expand-${task.id}`,
    } : {}),
  };

  const taskContent = (
    <>
      <div className={styles.taskRow}>
        <span
          className={cn(styles.indicatorCircle, styles[`indicatorCircle_${displayStatus}`])}
          aria-hidden="true"
        >
          {displayStatus === 'completed' ? (
            <Check size={10} strokeWidth={2.4} className={styles.indicatorCheck} />
          ) : displayStatus === 'in_progress' ? (
            <span className={styles.indicatorDot} />
          ) : null}
        </span>
        <span className={styles.srOnly}>{STATUS_LABELS[displayStatus]}:</span>
        <span className={styles.taskTitle}>{shortTitle}</span>
        {renderTaskModelBadge(modelBadgeState)}
        {expandable && (
          <ChevronRight
            size={12}
            className={cn(styles.expandChevron, isExpanded && styles.expandChevronOpen)}
            aria-hidden="true"
          />
        )}
      </div>
      {isBlocked && !isExpanded && (
        <span className={styles.blockerInline} data-testid={`task-blocker-inline-${task.id}`}>
          {resolvedBlockerTitles.length === 0
            ? 'Waiting on earlier steps'
            : resolvedBlockerTitles.length === 1
              ? `Waiting on: ${resolvedBlockerTitles[0]}`
              : `Waiting on: ${resolvedBlockerTitles[0]} +${resolvedBlockerTitles.length - 1} more`}
        </span>
      )}
      {isExpanded && (
        <div className={styles.expandedContent} data-testid={`task-expanded-${task.id}`}>
          {showFullTitle && (
            <p className={styles.expandedDescription}>{task.title}</p>
          )}
          {task.description && (
            <p className={styles.expandedDescription}>{task.description}</p>
          )}
          {isBlocked && blockers.length > 0 && resolvedBlockerTitles.length === 0 && (
            <p className={styles.expandedDescription}>Waiting on earlier steps</p>
          )}
          {isBlocked && resolvedBlockerTitles.length > 0 && (
            <div className={styles.expandedBlockers}>
              <span className={styles.expandedLabel}>Waiting on:</span>
              <ul className={styles.blockerList}>
                {resolvedBlockerTitles.map((label, i) => (
                  <li key={i}>{label}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </>
  );

  if (expandable) {
    return (
      <Tooltip
        content={buildTooltipContent(task, allTasks)}
        disabled={isExpanded}
        interactive
        placement="right"
        delayShow={300}
      >
        <li {...liProps}>{taskContent}</li>
      </Tooltip>
    );
  }

  return <li {...liProps}>{taskContent}</li>;
};

// ── SwimlaneGroup sub-component ─────────────────────────────────

type SwimlaneGroupProps = {
  groupId: string;
  tasks: TaskProgressItem[];
  allTasks: TaskProgressItem[];
  expandedTaskId: string | null;
  onToggleExpand: (taskId: string) => void;
  inferredCurrentId: string | null;
  taskModelBadgeStates: Map<string, TaskModelBadgeState>;
};

const SwimlaneGroup = ({
  tasks,
  allTasks,
  expandedTaskId,
  onToggleExpand,
  inferredCurrentId,
  taskModelBadgeStates,
}: SwimlaneGroupProps) => {
  const allCompleted = tasks.every((t) => t.status === 'completed');
  const isLive = tasks.filter((t) => t.status === 'in_progress').length >= 2;
  return (
    <li
      className={cn(
        styles.swimlane,
        allCompleted && styles.swimlaneComplete,
        isLive && styles.swimlaneLive,
      )}
      aria-label={`At the same time: ${tasks.length} steps`}
      data-testid="swimlane"
    >
      <span className={styles.swimlaneCaption} aria-hidden="true">At the same time</span>
      <ul role="list" className={styles.swimlaneList}>
        {tasks.map((task) => (
          <TaskItemRow
            key={task.id}
            task={task}
            allTasks={allTasks}
            isExpanded={expandedTaskId === task.id}
            onToggleExpand={onToggleExpand}
            visualStatus={task.id === inferredCurrentId ? 'in_progress' : undefined}
            modelBadgeState={taskModelBadgeStates.get(task.id)}
          />
        ))}
      </ul>
    </li>
  );
};

// ── Main component ──────────────────────────────────────────────

type MissionProgressCardProps = {
  missionContext?: MissionContextData | null;
  taskProgress?: TaskProgressItem[];
  snapshotCounts?: SnapshotCounts;
  modelByTaskId?: Map<string, TaskModelRoutingInfo>;
  isThinking?: boolean;
  /** When true, strips card chrome (border, background) for embedding inside a parent card. */
  embedded?: boolean;
};

export const MissionProgressCard = memo(({
  missionContext,
  taskProgress,
  snapshotCounts,
  modelByTaskId,
  isThinking = false,
  embedded = false,
}: MissionProgressCardProps) => {
  const hasMission = missionContext != null;
  const tasks = taskProgress ?? [];
  const hasTasks = tasks.length > 0;
  const hasProgress = snapshotCounts != null && snapshotCounts.total > 0;

  const taskLen = taskProgress?.length ?? 0;
  const completedCount = snapshotCounts?.completed
    ?? (taskProgress?.filter((t) => t.status === 'completed').length ?? 0);
  // Use taskProgress.length as the total when tasks are available — snapshotCounts.total
  // can report the planned total before all task items are populated, creating a mismatch
  // (e.g., "2/11" but only 5 items rendered).
  const totalCount = taskLen > 0 ? taskLen : (snapshotCounts?.total ?? 0);
  const progressFraction = totalCount > 0 ? completedCount / totalCount : 0;
  const isCompact = !hasMission && (hasTasks || hasProgress);

  const [showAllTasks, setShowAllTasks] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  const handleToggleExpand = useCallback((taskId: string) => {
    setExpandedTaskId(prev => prev === taskId ? null : taskId);
  }, []);

  const taskModelBadgeStates = useMemo(
    () => buildTaskModelBadgeStates(taskProgress, modelByTaskId),
    [taskProgress, modelByTaskId],
  );

  if (!hasMission && !hasTasks && !hasProgress) return null;

  // Infer the "current" task: if no task is explicitly in_progress but some are
  // completed, the first pending task is likely being worked on right now.
  const hasExplicitInProgress = taskProgress?.some(t => t.status === 'in_progress') ?? false;
  const inferredCurrentId = (!hasExplicitInProgress && isThinking && completedCount > 0)
    ? taskProgress?.find(t => t.status === 'pending')?.id ?? null
    : null;

  const goalText = missionContext?.goal ?? '';
  const shortGoal = summarizeMissionGoal(goalText);
  const taskWindow = getVisibleTaskWindow(taskProgress ?? [], completedCount, showAllTasks);
  const hasHiddenTasks = taskWindow.hiddenBefore > 0 || taskWindow.hiddenAfter > 0;
  const visibleStart = taskWindow.start + 1;
  const visibleEnd = taskWindow.start + taskWindow.items.length;

  return (
    <div className={cn(
      styles.card,
      isThinking && styles.cardThinking,
      isCompact && styles.cardCompact,
      embedded && styles.cardEmbedded,
    )}>
      {hasMission && !embedded && (
        <div className={styles.missionHeader}>
          <p className={styles.goal}>
            {shortGoal}
          </p>
          {(hasTasks || hasProgress) && totalCount >= 2 && (
            <span className={styles.progress}>
              {completedCount}/{totalCount}
            </span>
          )}
        </div>
      )}
      {!embedded && isCompact && totalCount >= 2 && (
        <span className={styles.progress}>{completedCount}/{totalCount}</span>
      )}
      {!embedded && (hasTasks || hasProgress) && totalCount >= 2 && (
        <div
          className={styles.progressBar}
          role="progressbar"
          aria-valuenow={completedCount}
          aria-valuemin={0}
          aria-valuemax={totalCount}
          aria-label={`Task progress: ${completedCount} of ${totalCount} completed`}
        >
          <div
            className={cn(
              styles.progressFill,
              progressFraction === 1 && styles.progressFillComplete
            )}
            style={{ width: `${progressFraction * 100}%` }}
          />
        </div>
      )}
      {hasTasks && (
        <>
          <ul className={styles.taskList}>
            {groupTasksByParallelRun(taskWindow.items).map((entry, idx) => {
              if (entry.kind === 'single') {
                const task = entry.task;
                return (
                  <TaskItemRow
                    key={task.id}
                    task={task}
                    allTasks={tasks}
                    isExpanded={expandedTaskId === task.id}
                    onToggleExpand={handleToggleExpand}
                    visualStatus={task.id === inferredCurrentId ? 'in_progress' : undefined}
                    modelBadgeState={taskModelBadgeStates.get(task.id)}
                  />
                );
              }
              return (
                <SwimlaneGroup
                  key={`group-${entry.groupId}-${idx}`}
                  groupId={entry.groupId}
                  tasks={entry.tasks}
                  allTasks={tasks}
                  expandedTaskId={expandedTaskId}
                  onToggleExpand={handleToggleExpand}
                  inferredCurrentId={inferredCurrentId}
                  taskModelBadgeStates={taskModelBadgeStates}
                />
              );
            })}
          </ul>
          {hasHiddenTasks && (
            <div className={styles.taskWindowFooter}>
              <span className={styles.taskWindowMeta}>
                Showing steps {visibleStart}-{visibleEnd} of {tasks.length}
              </span>
              <button
                type="button"
                className={styles.moreButton}
                onClick={() => setShowAllTasks(prev => !prev)}
              >
                {showAllTasks ? 'Show less' : 'Show all steps'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
});

export const _testOnly = { groupTasksByParallelRun };
export type { TaskRenderEntry };
