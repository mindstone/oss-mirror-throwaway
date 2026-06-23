import { useState, useEffect, useMemo, memo, useId, type KeyboardEvent, type MouseEvent } from 'react';
import { Info, ChevronDown, ChevronRight, Copy, Check, AlertTriangle, RefreshCw, Bot } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { formatDurationShort, createMessageSnippet } from '@renderer/utils/formatters';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { MessageMarkdown } from '@renderer/components/MessageMarkdown';
import { useSettingsSafe } from '@renderer/features/settings';
import type { SubAgentTimelineItem, SubAgentStepRange } from '../utils/subAgentTimeline';
import type { StepToolSummary } from '../utils/toolChips';
import type { TaskProgressItem } from '../utils/turnStepContext';
import { FRIENDLY_LABELS, MCP_LABEL_SEPARATOR } from '../utils/activityDerivation';
import { resolveModelAgentInfo, shortModelName } from '../utils/modelAgentLabels';
import { getBackgroundAgentQuip } from '../work-surface/utils/personaQuips';
import { useIntervalRef } from '@renderer/hooks/useIntervalRef';
import styles from './SubAgentPill.module.css';

const humanizeLabel = (label: string): string => {
  const mcpParts = label.split(MCP_LABEL_SEPARATOR);
  const raw = mcpParts.length >= 2 ? mcpParts[mcpParts.length - 1] : label;
  return FRIENDLY_LABELS[raw.toLowerCase()] ?? raw;
};

const humanizeToolDisplay = (tool: StepToolSummary): string => {
  const rawAction = (tool.label.split(MCP_LABEL_SEPARATOR).pop() ?? tool.label).toLowerCase();
  const friendly = FRIENDLY_LABELS[rawAction];
  if (!friendly) return humanizeLabel(tool.label);
  if (tool.fullPath) {
    const parts = tool.fullPath.replace(/\\/g, '/').split('/');
    const filename = parts[parts.length - 1];
    if (filename?.includes('.')) return `${friendly} \u2014 ${filename}`;
  }
  return friendly;
};

const ToolStatusIcon = ({ status }: { status?: string }) => {
  if (!status || status === 'success') {
    return <Check className={cn(styles.toolStatusIcon, styles.toolStatusSuccess)} aria-label="Completed" />;
  }
  if (status === 'error') {
    return <AlertTriangle className={cn(styles.toolStatusIcon, styles.toolStatusError)} aria-label="Error" />;
  }
  return <RefreshCw className={cn(styles.toolStatusIcon, styles.toolStatusRunning)} aria-label="Running" />;
};

const TASK_MISSION_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TodoWrite', 'MissionSet', 'SummarizeResult', 'GetMissionContext']);

const STATUS_LABELS: Record<TaskProgressItem['status'], string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  blocked: 'Blocked',
};

const MAX_VISIBLE_TASKS = 6;

type TaskRenderEntry =
  | { kind: 'single'; task: TaskProgressItem }
  | { kind: 'parallel'; groupId: string; tasks: TaskProgressItem[] };

/**
 * Walks visibleTasks in order and clusters runs of contiguous tasks sharing the
 * same `parallelGroup` into a single render entry. Singletons (group-of-one or
 * tasks without a group) render flat. A group split by a non-member in between
 * renders as two separate clusters — acceptable, and a useful signal that the
 * sort order has separated them (e.g. one finished while siblings still run).
 */
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
      entries.push({ kind: 'parallel', groupId, tasks: run });
    } else {
      entries.push({ kind: 'single', task });
    }
    i = runEnd;
  }
  return entries;
};

type SubAgentPillProps = {
  item: SubAgentTimelineItem;
  toolChips?: StepToolSummary[];
  onFocus?: (range: SubAgentStepRange | null) => void;
  onOpenConversation?: (sessionId: string) => void;
};

const TIMER_INTERVAL_MS = 1000;
const QUIP_ROTATION_INTERVAL_MS = 8000;

const BACKGROUND_TOOLTIP = "Working autonomously. No live feed, but I'll debrief you when there's something to report.";

const buildRoutingTooltip = (item: SubAgentTimelineItem): string | null => {
  if (!item.model) return null;

  const contextLabel = item.contextMode === 'scoped'
    ? 'focused task'
    : item.contextMode === 'contextual'
      ? 'full context'
      : null;

  return [
    `Model: ${item.model}`,
    contextLabel ? `Context: ${contextLabel}` : null,
    item.routingEffort ? `Effort: ${item.routingEffort}` : null,
  ].filter(Boolean).join('\n');
};

export const SubAgentPill = memo(function SubAgentPill({
  item,
  toolChips = [],
  onFocus,
  onOpenConversation,
}: SubAgentPillProps) {
  const settingsContext = useSettingsSafe();
  const profiles = settingsContext?.settings?.localModel?.profiles;
  const modelAgentInfo = useMemo(
    () => (item.subagentType ? resolveModelAgentInfo(item.subagentType, profiles) : null),
    [item.subagentType, profiles]
  );
  const displayLabel = modelAgentInfo?.isModelAgent ? modelAgentInfo.label : item.label;
  const providerLabel = modelAgentInfo?.isModelAgent ? modelAgentInfo.provider : undefined;

  const isRunning = item.status === 'running';
  const isBackgroundAndRunning = item.isBackground && isRunning;
  const [liveElapsedMs, setLiveElapsedMs] = useState(() =>
    isRunning ? Math.max(Date.now() - item.startedAt, 0) : 0
  );
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);
  const [copiedBrief, setCopiedBrief] = useState(false);
  const [quipIndex, setQuipIndex] = useState(0);
  const timerInterval = useIntervalRef();
  const quipInterval = useIntervalRef();
  const detailSectionId = useId();
  const briefSectionId = useId();

  useEffect(() => {
    if (!isRunning) {
      timerInterval.clear();
      return;
    }
    const tick = () => {
      setLiveElapsedMs(Math.max(Date.now() - item.startedAt, 0));
    };
    tick();
    timerInterval.set(tick, TIMER_INTERVAL_MS);
  }, [isRunning, item.startedAt, timerInterval]);

  // Rotate quips for running agents (both foreground and background)
  useEffect(() => {
    if (!isRunning) {
      quipInterval.clear();
      return;
    }
    const rotateQuip = () => {
      setQuipIndex((prev) => prev + 1);
    };
    quipInterval.set(rotateQuip, QUIP_ROTATION_INTERVAL_MS);
  }, [isRunning, quipInterval]);

  const durationMs = item.durationMs ?? liveElapsedMs;
  const durationLabel = formatDurationShort(durationMs);
  const goalSnippet = item.summary ? createMessageSnippet(item.summary, 80) : null;
  const runningQuip = useMemo(() => getBackgroundAgentQuip(quipIndex), [quipIndex]);
  const routingTooltip = useMemo(() => buildRoutingTooltip(item), [item]);
  const routingContextLabel = item.contextMode === 'scoped'
    ? 'focused'
    : item.contextMode === 'contextual'
      ? 'full context'
      : null;
  const routingBadgeLabel = item.model
    ? `${shortModelName(item.model)}${routingContextLabel ? ` · ${routingContextLabel}` : ''}`
    : null;

  const hasDetailLocal = Boolean(
    item.prompt || 
    item.result || 
    (item.taskProgress && item.taskProgress.length > 0) || 
    (toolChips.filter((chip) => !chip.toolName || !TASK_MISSION_TOOL_NAMES.has(chip.toolName)).length > 0 && !item.isBackground)
  );

  const handleHeaderClick = () => {
    if (hasDetailLocal) {
      setIsExpanded((prev) => {
        const next = !prev;
        // Auto-highlight associated steps when expanding
        if (next) {
          onFocus?.(item.stepRange);
        }
        return next;
      });
    } else {
      onFocus?.(item.stepRange);
    }
  };

  const handleHeaderKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleHeaderClick();
    }
  };

  const handleToggleTools = (event: MouseEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    setToolsExpanded((prev) => !prev);
  };

  const handleToggleToolsKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      setToolsExpanded((prev) => !prev);
    }
  };

  const handleCopyReport = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(item.result || '');
      setCopiedReport(true);
      setTimeout(() => setCopiedReport(false), 2000);
    } catch { /* silently ignore */ }
  };

  const handleCopyBrief = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(item.prompt || '');
      setCopiedBrief(true);
      setTimeout(() => setCopiedBrief(false), 2000);
    } catch { /* silently ignore */ }
  };

  const handleToggleBrief = (e: MouseEvent) => {
    e.stopPropagation();
    setBriefOpen((prev) => !prev);
  };

  // Filter out task/mission tools from the tool list (they're shown in the task section)
  const filteredTools = useMemo(() =>
    toolChips.filter((chip) => !chip.toolName || !TASK_MISSION_TOOL_NAMES.has(chip.toolName)),
    [toolChips]
  );
  const hasToolItems = filteredTools.length > 0 && !item.isBackground;
  const visibleTools = toolsExpanded ? filteredTools : filteredTools.slice(0, 5);
  const hasToolOverflow = filteredTools.length > 5;

  // Task progress
  const taskProgress = item.taskProgress;
  const hasTasks = taskProgress != null && taskProgress.length > 0;
  const visibleTasks = useMemo(() => {
    if (!taskProgress || taskProgress.length === 0) return [];
    if (taskProgress.length <= MAX_VISIBLE_TASKS) return taskProgress;
    const inProgress = taskProgress.filter((t) => t.status === 'in_progress');
    const pending = taskProgress.filter((t) => t.status === 'pending');
    const rest = taskProgress.filter((t) => t.status !== 'in_progress' && t.status !== 'pending');
    return [...inProgress, ...pending, ...rest].slice(0, MAX_VISIBLE_TASKS);
  }, [taskProgress]);
  const hiddenTaskCount = (taskProgress?.length ?? 0) - visibleTasks.length;
  const completedCount = taskProgress?.filter((t) => t.status === 'completed').length ?? 0;
  const totalCount = taskProgress?.length ?? 0;
  const progressFraction = totalCount > 0 ? completedCount / totalCount : 0;

  const hasDetail = Boolean(item.prompt || item.result || hasTasks || hasToolItems);
  const expandIcon = hasDetail ? (isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null;

  const statusClass = styles[item.status as keyof typeof styles] as string | undefined;

  // Determine report content for expanded view
  const reportContent = (() => {
    if (item.status === 'completed' && item.result) {
      return { type: 'result' as const, text: item.result };
    }
    if (isRunning && !item.isBackground) {
      return { type: 'quip' as const, text: item.currentActivity || runningQuip };
    }
    if (item.isBackground && isRunning) {
      return { type: 'placeholder' as const, text: item.currentActivity || "Working. I'll debrief shortly." };
    }
    return null;
  })();

  return (
    <div
      role="group"
      aria-label={`${displayLabel}${providerLabel ? ` via ${providerLabel}` : ''}${routingBadgeLabel ? `, ${routingBadgeLabel}` : ''}: ${goalSnippet || (isRunning ? 'Running' : 'Completed')}`}
      className={cn(styles.pill, statusClass, styles.expanded, item.isBackground && styles.background)}
    >
      <button
        type="button"
        className={styles.headerButton}
        onClick={handleHeaderClick}
        onKeyDown={handleHeaderKeyDown}
        title={item.summary || displayLabel}
        aria-expanded={hasDetail ? isExpanded : undefined}
        aria-controls={hasDetail ? detailSectionId : undefined}
      >
        <div className={styles.header}>
          <Bot className={styles.statusIcon} size={12} aria-hidden="true" />
          {goalSnippet ? (
            <span className={styles.label}>{goalSnippet}</span>
          ) : (
            <span className={styles.label}>{displayLabel}</span>
          )}
          {routingBadgeLabel ? (
            <Tooltip content={routingTooltip} placement="top" delayShow={300} maxWidth="360px">
              <span className={cn(styles.routingBadge, item.contextMode === 'scoped' && styles.routingBadgeFocused)}>
                {routingBadgeLabel}
              </span>
            </Tooltip>
          ) : null}
          <span className={styles.duration}>{durationLabel}</span>
          {expandIcon ? (
            <span className={styles.expandIcon} aria-hidden>{expandIcon}</span>
          ) : null}
        </div>
      </button>

      {/* Interactive elements outside header button to avoid nested interactive content */}
      {item.isBackground ? (
        <div className={cn(styles.header, styles.headerIndented)}>
          <Tooltip content={BACKGROUND_TOOLTIP} placement="top">
            <span 
              className={styles.infoIcon} 
              role="button"
              tabIndex={0}
              aria-label="Learn more about background tasks"
            >
              <Info size={14} />
            </span>
          </Tooltip>
        </div>
      ) : null}
      {isBackgroundAndRunning ? (
        <div className={styles.backgroundStatus}>{item.currentActivity || runningQuip}</div>
      ) : isRunning && item.currentActivity ? (
        <div className={styles.backgroundStatus}>{item.currentActivity}</div>
      ) : null}
      {/* Expandable detail section — lazy-mounted for performance */}
      {isExpanded && hasDetail ? (
        <>
        {/* Task progress section */}
        {hasTasks ? (
          <div className={styles.taskSection}>
            {totalCount >= 2 ? (
              <div
                className={styles.taskProgressBar}
                role="progressbar"
                aria-valuenow={completedCount}
                aria-valuemin={0}
                aria-valuemax={totalCount}
                aria-label={`Task progress: ${completedCount} of ${totalCount} completed`}
              >
                <div
                  className={cn(
                    styles.taskProgressFill,
                    progressFraction === 1 && styles.taskProgressComplete,
                  )}
                  style={{ width: `${progressFraction * 100}%` }}
                />
              </div>
            ) : null}
            <div role="list" className={styles.taskList}>
              {groupTasksByParallelRun(visibleTasks).map((entry) => {
                if (entry.kind === 'single') {
                  const task = entry.task;
                  return (
                    <div
                      role="listitem"
                      key={task.id}
                      className={cn(styles.taskItem, styles[`taskItem_${task.status}`])}
                    >
                      <span className={cn(styles.taskIndicator, styles[`taskIndicator_${task.status}`])} aria-hidden="true">
                        {task.status === 'pending' && '\u25CB'}
                        {task.status === 'in_progress' && '\u25D1'}
                        {task.status === 'completed' && '\u2713'}
                        {task.status === 'blocked' && '\u2298'}
                      </span>
                      <span className={styles.srOnly}>{STATUS_LABELS[task.status]}:</span>
                      <span className={styles.taskTitle}>{task.title}</span>
                    </div>
                  );
                }
                const groupLabel = `Running ${entry.tasks.length} in parallel`;
                return (
                  <div
                    role="group"
                    key={`parallel-${entry.groupId}-${entry.tasks[0].id}`}
                    className={styles.parallelBatch}
                    aria-label={groupLabel}
                  >
                    <span className={styles.parallelLabel} aria-hidden="true">{groupLabel}</span>
                    {entry.tasks.map((task) => (
                      <div
                        role="listitem"
                        key={task.id}
                        className={cn(styles.taskItem, styles[`taskItem_${task.status}`])}
                      >
                        <span className={cn(styles.taskIndicator, styles[`taskIndicator_${task.status}`])} aria-hidden="true">
                          {task.status === 'pending' && '\u25CB'}
                          {task.status === 'in_progress' && '\u25D1'}
                          {task.status === 'completed' && '\u2713'}
                          {task.status === 'blocked' && '\u2298'}
                        </span>
                        <span className={styles.srOnly}>{STATUS_LABELS[task.status]}:</span>
                        <span className={styles.taskTitle}>{task.title}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            {hiddenTaskCount > 0 ? (
              <span className={styles.taskMore}>+{hiddenTaskCount} more</span>
            ) : null}
          </div>
        ) : null}

        {/* Friendly tool list */}
        {!isBackgroundAndRunning && hasToolItems ? (
          <div className={styles.tools}>
            {visibleTools.map((tool, toolIndex) => {
              const isLast = toolIndex === visibleTools.length - 1;
              const showDots = tool.status === 'running' || tool.status === 'pending'
                || (isRunning && isLast);
              return (
                <div
                  key={`${tool.label}-${toolIndex}`}
                  className={cn(
                    styles.toolItem,
                    tool.emphasis === 'subtle' && styles.toolItemSubtle,
                    tool.status === 'error' && styles.toolItemError,
                  )}
                >
                  {showDots
                    ? <span className={styles.toolStatusSpacer} />
                    : <ToolStatusIcon status={tool.status} />}
                  <Tooltip
                    content={tool.fullCommand || tool.fullPath || tool.fullUrl || tool.detail || tool.label}
                    maxWidth="400px"
                    delayShow={300}
                  >
                    <span className={styles.toolLabel}>
                      {humanizeToolDisplay(tool)}
                      {showDots ? (
                        <span className={styles.toolDots} aria-hidden>
                          <span>.</span><span>.</span><span>.</span>
                        </span>
                      ) : null}
                    </span>
                  </Tooltip>
                </div>
              );
            })}
            {hasToolOverflow ? (
              <span
                role="button"
                tabIndex={0}
                className={styles.toolOverflow}
                onClick={handleToggleTools}
                onKeyDown={handleToggleToolsKeyDown}
                aria-expanded={toolsExpanded}
                aria-label={toolsExpanded ? 'Show fewer tools' : `Show ${filteredTools.length - 5} more tools`}
              >
                {toolsExpanded ? 'Less' : `+${filteredTools.length - 5}`}
              </span>
            ) : null}
          </div>
        ) : null}
        <div id={detailSectionId} className={styles.detailSection} onClick={(e) => e.stopPropagation()}>
          {/* Report section */}
          {reportContent ? (
            <div className={styles.reportSection}>
              <div className={styles.sectionHeader}>
                <span>Report</span>
                {reportContent.type === 'result' ? (
                  <button
                    type="button"
                    className={cn(styles.copyButton, copiedReport && styles.copyButtonDone)}
                    onClick={handleCopyReport}
                    aria-label={copiedReport ? 'Copied' : 'Copy report'}
                  >
                    {copiedReport ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                ) : null}
              </div>
              {reportContent.type === 'result' ? (
                <div className={styles.reportContent}>
                  <MessageMarkdown
                    content={reportContent.text}
                    onOpenConversation={onOpenConversation}
                  />
                </div>
              ) : (
                <div className={styles.reportPlaceholder}>{reportContent.text}</div>
              )}
            </div>
          ) : null}

          {/* Brief section — disclosure toggle, collapsed by default */}
          {item.prompt ? (
            <div className={styles.briefSection}>
              <div className={styles.sectionHeader}>
                <button
                  type="button"
                  className={styles.briefToggle}
                  onClick={handleToggleBrief}
                  aria-expanded={briefOpen}
                  aria-controls={briefSectionId}
                >
                  <span>{briefOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                  <span>Brief</span>
                </button>
                {briefOpen ? (
                  <button
                    type="button"
                    className={cn(styles.copyButton, copiedBrief && styles.copyButtonDone)}
                    onClick={handleCopyBrief}
                    aria-label={copiedBrief ? 'Copied' : 'Copy brief'}
                  >
                    {copiedBrief ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                ) : null}
              </div>
              {briefOpen ? (
                <div id={briefSectionId} className={styles.briefContent}>
                  <MessageMarkdown
                    content={item.prompt}
                    onOpenConversation={onOpenConversation}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        </>
      ) : null}
    </div>
  );
});
