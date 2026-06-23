import { memo, useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { ChevronDown, ChevronRight, Check, AlertTriangle, RefreshCw, Brain, Zap, Search, Info } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { AgentEvent } from '@shared/types';
import { isTipContent } from '@shared/data/tips';
import { BOOKKEEPING_TOOL_NAMES } from '@rebel/shared';
import { createMessageSnippet } from '@renderer/utils/formatters';
import type { FileOperationsByStep } from '../work-surface';
import type { StepToolSummary, ToolChipStatus } from '../utils/toolChips';
import type { SubAgentStepRange, SubAgentTimeline, SubAgentTimelineItem } from '../utils/subAgentTimeline';
import type { MissionContextData, TaskProgressItem } from '../utils/turnStepContext';
import { resolveModelAgentInfo, shortModelName } from '../utils/modelAgentLabels';
import { humanizeToolDisplay, humanizeLabel } from '../utils/activityDerivation';
import { SubAgentPill } from './SubAgentPill';
import { ImageGrid } from './ImageGrid';
import { imageGridSourceFromEvent, type ImageGridItem } from './imageGridSource';
import { ToolResultContent } from './ToolResultContent';
import { Tooltip } from '@renderer/components/ui';
import { useSettingsSafe } from '@renderer/features/settings';
import { useSessionStore } from '../store/sessionStore';
import styles from './TurnStepsInline.module.css';
import loadingGif from '@renderer/assets/animations/loading.gif';

// Scroll behavior constants
const SCROLL_BOTTOM_THRESHOLD = 20; // px from bottom to consider "at bottom"

// Tool names that get de-emphasized when a task checklist is visible.
// Aliased to the shared bookkeeping set so all surfaces stay aligned.
const TASK_MISSION_TOOL_NAMES = BOOKKEEPING_TOOL_NAMES;

// Determine the router phase from the headline text for visual styling
type RouterPhase = 'evaluating' | 'direct' | 'research' | 'found' | 'default';

const getRouterPhase = (headline: string | undefined): RouterPhase => {
  if (!headline) return 'default';
  const lower = headline.toLowerCase();
  if (lower.includes('evaluating')) return 'evaluating';
  if (lower.includes('got it') || lower.includes('answering from')) return 'direct';
  if (lower.includes('deeper research') || lower.includes('needs research')) return 'research';
  if (lower.includes('found') && lower.includes('file')) return 'found';
  return 'default';
};

// Router phase icons for delightful visual feedback
const RouterPhaseIcon = ({ phase, className }: { phase: RouterPhase; className?: string }) => {
  switch (phase) {
    case 'evaluating':
      return <Brain className={cn(styles.routerIcon, styles.routerIconEvaluating, className)} aria-hidden />;
    case 'direct':
      return <Zap className={cn(styles.routerIcon, styles.routerIconDirect, className)} aria-hidden />;
    case 'research':
      return <Search className={cn(styles.routerIcon, styles.routerIconResearch, className)} aria-hidden />;
    case 'found':
      return <Check className={cn(styles.routerIcon, styles.routerIconFound, className)} aria-hidden />;
    default:
      return null;
  }
};

const getToolTooltipContent = (tool: StepToolSummary): string => {
  return tool.fullCommand || tool.fullPath || tool.fullUrl || tool.detail || tool.label;
};

// Safe renderer for headline text with **bold** markers (avoids XSS from dangerouslySetInnerHTML)
const HeadlineWithBold = ({ text }: { text: string }) => {
  // Split on **...** patterns, keeping the captured groups
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return (
    <>
      {parts.map((part, i) => 
        // Odd indices are the captured bold text
        i % 2 === 1 ? <strong key={i}>{part}</strong> : part
      )}
    </>
  );
};

// Status icon components for clear visual feedback
const StatusIcon = ({ status }: { status?: ToolChipStatus }) => {
  if (!status || status === 'success') {
    return <Check className={cn(styles.statusIcon, styles.statusIconSuccess)} aria-label="Completed" />;
  }
  if (status === 'error') {
    return <AlertTriangle className={cn(styles.statusIcon, styles.statusIconError)} aria-label="Error" />;
  }
  // running or pending
  return <RefreshCw className={cn(styles.statusIcon, styles.statusIconRunning)} aria-label="Running" />;
};

type TurnStepsInlineProps = {
  steps: AgentEvent[];
  fileOperationsByStep: FileOperationsByStep;
  toolSummariesByStep: Map<number, StepToolSummary[]>;
  /** Model ID per step (1-indexed). When present, shows model routing indicators. */
  modelByStep?: Map<number, string>;
  selectedStepNumber: number | null;
  highlightedRange?: SubAgentStepRange | null;
  subAgentTimeline?: SubAgentTimeline | null;
  /** Whether this turn is currently active/thinking (for auto-collapse behavior) */
  isThinking?: boolean;
  /** Headline text to show while thinking (e.g., "Translating bullet chaos...") */
  thinkingHeadline?: string;
  /** Elapsed time label while thinking (e.g., "10s") */
  thinkingElapsedLabel?: string;
  /** Mission context extracted from MissionSet events */
  missionContext?: MissionContextData | null;
  /** Task progress extracted from TaskList/TodoWrite events */
  taskProgress?: TaskProgressItem[];
  /** Owning session ID — used to resolve `imageRef` assets through `rebel-asset://`. */
  sessionId?: string;
  onOpenConversation?: (sessionId: string) => void;
  onSelectStep: (stepNumber: number | null) => void;
  onFocusSubAgentRange?: (range: SubAgentStepRange | null) => void;
  containerRef?: (element: HTMLElement | null) => void;
  /** When true, suppresses the header/toggle — parent controls visibility. */
  headless?: boolean;
};


export const TurnStepsInline = memo(({
  steps,
  fileOperationsByStep: _fileOperationsByStep,
  toolSummariesByStep,
  modelByStep,
  selectedStepNumber,
  highlightedRange,
  subAgentTimeline,
  isThinking = false,
  thinkingHeadline,
  thinkingElapsedLabel,
  missionContext,
  taskProgress,
  sessionId,
  onOpenConversation,
  onSelectStep,
  onFocusSubAgentRange,
  containerRef,
  headless = false,
}: TurnStepsInlineProps) => {
  const settingsContext = useSettingsSafe();
  const profiles = settingsContext?.settings?.localModel?.profiles;

  // Safety-eval progress: map keyed by toolUseId. Populated by
  // `tool-safety:evaluating` broadcasts, cleared by `-complete` (or
  // belt-and-braces cleanup when the tool's `stage: 'end'` event arrives).
  // Selector returns the whole map — Zustand re-renders on any change, which
  // is fine because this map is short-lived (one entry per in-flight eval).
  const safetyEvalInFlight = useSessionStore((s) => s.safetyEvalInFlight);

  // Section collapsed state: user can override, defaults based on isThinking
  const [userCollapsedOverride, setUserCollapsedOverride] = useState<boolean | null>(null);
  
  // Track if thinking was ever shown (to preserve collapsed state after single-step turns)
  const [hadThinkingActivity, setHadThinkingActivity] = useState(false);
  
  // Compute whether collapsed: user override takes precedence, otherwise collapse when not thinking
  // In headless mode, always expanded (parent controls visibility)
  const isCollapsed = headless ? false : (userCollapsedOverride !== null ? userCollapsedOverride : !isThinking);
  
  // Scroll state for fade effects
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState<'top' | 'middle' | 'bottom' | 'none'>('none');
  // Track if user has manually scrolled away from bottom (to avoid fighting their scroll)
  const userScrolledAwayRef = useRef(false);
  
  // Update fade effect state based on scroll position (does NOT track user scroll-away)
  const updateFadeState = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    
    const { scrollTop, scrollHeight, clientHeight } = el;
    const isScrollable = scrollHeight > clientHeight;
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - 10; // 10px threshold
    
    if (!isScrollable) {
      setScrollState('none');
    } else if (scrollTop <= 1) {
      setScrollState('top');
    } else if (isAtBottom) {
      setScrollState('bottom');
    } else {
      setScrollState('middle');
    }
  }, []);
  
  // Handle user scroll events - tracks scroll-away AND updates fade state
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    
    const { scrollTop, scrollHeight, clientHeight } = el;
    const isScrollable = scrollHeight > clientHeight;
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - SCROLL_BOTTOM_THRESHOLD;
    
    // Only track user scroll-away on actual scroll events
    userScrolledAwayRef.current = isScrollable && !isAtBottom;
    
    updateFadeState();
  }, [updateFadeState]);
  
  // Update fade state when content changes (but don't touch userScrolledAwayRef)
  useEffect(() => {
    updateFadeState();
  }, [steps.length, toolSummariesByStep.size, isCollapsed, updateFadeState]);
  
  // Auto-scroll to bottom when new content arrives while thinking
  // (but only if user hasn't manually scrolled away).
  // Uses instant scroll to avoid a race condition where smooth scrolling
  // mid-animation triggers handleScroll → userScrolledAwayRef=true, which
  // blocks subsequent auto-scrolls during rapid step updates.
  useEffect(() => {
    if (!isThinking || userScrolledAwayRef.current) return;

    const el = scrollContainerRef.current;
    if (!el) return;

    const rafId = requestAnimationFrame(() => {
      const currentEl = scrollContainerRef.current;
      if (!currentEl?.isConnected) return;

      const maxScroll = currentEl.scrollHeight - currentEl.clientHeight;
      if (maxScroll > 0 && currentEl.scrollTop < maxScroll) {
        currentEl.scrollTop = maxScroll;
      }
    });

    return () => cancelAnimationFrame(rafId);
  }, [steps.length, toolSummariesByStep.size, isThinking]);
  
  // Reset scroll tracking when a new turn starts
  useEffect(() => {
    if (isThinking) {
      userScrolledAwayRef.current = false;
    }
  }, [isThinking]);
  
  // Mark that we had thinking activity when isThinking becomes true
  useEffect(() => {
    if (isThinking) {
      setHadThinkingActivity(true);
    }
  }, [isThinking]);

  // Build set of SubAgent toolUseIds for filtering Task tool chips
  // (Task tools that spawned SubAgents should be hidden since SubAgentPill shows them)
  const subAgentToolUseIds = useMemo(() => {
    const ids = new Set<string>();
    if (subAgentTimeline) {
      for (const item of subAgentTimeline.items) {
        if (item.toolUseId) {
          ids.add(item.toolUseId);
        }
      }
    }
    return ids;
  }, [subAgentTimeline]);

  // Build set of step numbers owned by subagents (for filtering tools from main display)
  const subAgentOwnedSteps = useMemo(() => {
    const ownedSteps = new Set<number>();
    if (subAgentTimeline) {
      for (const item of subAgentTimeline.items) {
        if (item.stepRange) {
          for (let s = item.stepRange.start; s <= item.stepRange.end; s++) {
            ownedSteps.add(s);
          }
        }
      }
    }
    return ownedSteps;
  }, [subAgentTimeline]);

  const modelAgentCounts = useMemo(() => {
    const councilLabels = new Set<string>();
    const adHocLabels = new Set<string>();

    if (!subAgentTimeline?.items.length) {
      return { councilCount: 0, adHocCount: 0 };
    }

    for (const item of subAgentTimeline.items) {
      const modelInfo = resolveModelAgentInfo(item.subagentType, profiles);
      if (!modelInfo.isModelAgent) {
        continue;
      }

      const key = `${modelInfo.label}::${modelInfo.provider ?? ''}`;
      if (modelInfo.isCouncil) {
        councilLabels.add(key);
      } else {
        adHocLabels.add(key);
      }
    }

    return { councilCount: councilLabels.size, adHocCount: adHocLabels.size };
  }, [subAgentTimeline, profiles]);
  
  // Compute summary for collapsed state
  const collapsedSummary = useMemo(() => {
    const allChips: StepToolSummary[] = [];
    toolSummariesByStep.forEach((chips, stepNumber) => {
      // Skip tools from steps owned by subagents (they appear in SubAgentPill instead)
      if (subAgentOwnedSteps.has(stepNumber)) return;
      // Filter out Task tools that spawned SubAgents (shown as SubAgentPill)
      allChips.push(...chips.filter((c) => 
        !(c.toolUseId && subAgentToolUseIds.has(c.toolUseId))
      ));
    });

    const primaryChips = allChips.filter((chip) => chip.emphasis !== 'subtle');
    const toolCount = primaryChips.length;

    // Build unique activity labels in order of first appearance.
    // For MCP labels like "Google Calendar • List Events", keep the service part.
    const allActivityLabels: string[] = [];
    const seenLabels = new Set<string>();
    primaryChips.forEach((chip) => {
      const label = chip.label.split(' • ')[0]?.trim();
      if (!label || seenLabels.has(label)) return;
      seenLabels.add(label);
      allActivityLabels.push(label);
    });

    const maxActivityLabels = 3;
    const activityLabels = allActivityLabels.slice(0, maxActivityLabels);
    const hasMoreActivityLabels = allActivityLabels.length > maxActivityLabels;

    return {
      stepCount: steps.length,
      toolCount,
      activityLabels,
      hasMoreActivityLabels
    };
  }, [steps.length, toolSummariesByStep, subAgentToolUseIds, subAgentOwnedSteps]);

  const subAgentsByStep = useMemo(() => {
    const map = new Map<number, SubAgentTimelineItem[]>();
    if (!subAgentTimeline) return map;
    for (const item of subAgentTimeline.items) {
      const parentStep = item.stepRange?.start ?? 1;
      const existing = map.get(parentStep) ?? [];
      map.set(parentStep, [...existing, item]);
    }
    return map;
  }, [subAgentTimeline]);

  // Pre-pass: count raw label occurrences across the turn for repeat indicators.
  // When a label appears N>1 times, the first visible occurrence shows a subtle "×N".
  const turnLabelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    steps.forEach((step, si) => {
      const sn = si + 1;
      if (subAgentOwnedSteps.has(sn)) return;
      const allChips = toolSummariesByStep.get(sn) ?? [];
      const chips = allChips.filter(c => !(c.toolUseId && subAgentToolUseIds.has(c.toolUseId)));
      for (const chip of chips) {
        const label = humanizeToolDisplay(chip);
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      // Also count snippet labels for steps that have no tool chips
      if (chips.length === 0) {
        const rawText = 'text' in step ? (step as { text: string }).text : '';
        const rawSnippet = rawText.trim() ? createMessageSnippet(rawText, 120) : null;
        const snippetLabel = rawSnippet ? humanizeLabel(rawSnippet) : null;
        if (snippetLabel) counts.set(snippetLabel, (counts.get(snippetLabel) ?? 0) + 1);
      }
    });
    return counts;
  }, [steps, toolSummariesByStep, subAgentOwnedSteps, subAgentToolUseIds]);

  const hasSubAgents = subAgentTimeline && subAgentTimeline.items.length > 0;

  // Only show expand/collapse affordances when there is something to expand
  const hasExpandableContent = steps.length > 0 || Boolean(hasSubAgents);

  const orphanSubAgents = useMemo(() => {
    if (!subAgentTimeline) return [];
    if (steps.length === 0) return []; // Don't treat as orphans during live - we'll show in pending container
    return subAgentTimeline.items.filter(
      (item) => (item.stepRange?.start ?? 1) > steps.length
    );
  }, [subAgentTimeline, steps.length]);

  const isLiveWithPendingSubAgents = steps.length === 0 && hasSubAgents;

  // Show the component if there are steps, tools, sub-agents, actively thinking, OR had thinking activity
  // (hadThinkingActivity preserves the collapsed summary for single-step turns)
  const hasTools = toolSummariesByStep.size > 0;
  if (!steps.length && !hasTools && !hasSubAgents && !isThinking && !hadThinkingActivity) {
    return null;
  }

  const sectionClassName = cn(
    styles.steps,
    isCollapsed && styles.collapsed,
    isThinking && styles.thinking
  );

  const handleToggleCollapse = () => {
    setUserCollapsedOverride((prev) => (prev === null ? !isCollapsed : !prev));
  };

  // Build summary text
  const summaryParts: string[] = [];
  if (collapsedSummary.stepCount > 0) {
    summaryParts.push(`${collapsedSummary.stepCount} step${collapsedSummary.stepCount !== 1 ? 's' : ''}`);
  }
  if (collapsedSummary.activityLabels.length > 0) {
    const labelsText = collapsedSummary.activityLabels.join(' · ');
    // Use " ..." with space to distinguish from animated thinking dots
    summaryParts.push(labelsText + (collapsedSummary.hasMoreActivityLabels ? ' ...' : ''));
  } else if (collapsedSummary.toolCount > 0) {
    summaryParts.push(`${collapsedSummary.toolCount} tool${collapsedSummary.toolCount !== 1 ? 's' : ''}`);
  }
  if (modelAgentCounts.councilCount > 0) {
    summaryParts.push(`Council (${modelAgentCounts.councilCount})`);
  } else if (modelAgentCounts.adHocCount > 0) {
    summaryParts.push(`${modelAgentCounts.adHocCount} model${modelAgentCounts.adHocCount === 1 ? '' : 's'}`);
  }
  const summaryText = summaryParts.length > 0 ? summaryParts.join(' · ') : 'Activity';

  const runningAgentCount = subAgentTimeline?.runningCount ?? 0;
  const runningAgentSummary = runningAgentCount > 0
    ? `${runningAgentCount} agent${runningAgentCount !== 1 ? 's' : ''} working`
    : null;

  return (
    <section
      className={sectionClassName}
      aria-label="Agent steps"
      aria-expanded={headless ? undefined : (hasExpandableContent ? !isCollapsed : undefined)}
      onClick={!headless && hasExpandableContent && isCollapsed ? handleToggleCollapse : undefined}
      onKeyDown={
        !headless && hasExpandableContent && isCollapsed
          ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleToggleCollapse(); }
          : undefined
      }
      role={!headless && hasExpandableContent && isCollapsed ? 'button' : undefined}
      tabIndex={!headless && hasExpandableContent && isCollapsed ? 0 : undefined}
      ref={(node) => {
        containerRef?.(node);
      }}
      style={headless ? { margin: 0, background: 'transparent', border: 'none' } : undefined}
    >
      {!headless && (
        <>
        <div className={styles.header}>
          <button
            type="button"
            className={styles.toggle}
            onClick={hasExpandableContent && !isCollapsed ? handleToggleCollapse : undefined}
            aria-expanded={hasExpandableContent ? !isCollapsed : undefined}
            aria-label={hasExpandableContent ? (isCollapsed ? 'Expand activity' : 'Collapse activity') : undefined}
            tabIndex={hasExpandableContent ? (isCollapsed ? -1 : 0) : -1}
            disabled={!hasExpandableContent}
          >
            <span className={styles.eyebrow}>
              {isThinking ? (
                <>
                  {(() => {
                    const routerPhase = getRouterPhase(thinkingHeadline);
                    if (routerPhase !== 'default') {
                      return <RouterPhaseIcon phase={routerPhase} />;
                    }
                    if (thinkingHeadline && isTipContent(thinkingHeadline)) {
                      return <Info size={14} className={styles.headlineTipIcon} aria-hidden />;
                    }
                    return (
                      <img
                        src={loadingGif}
                        alt=""
                        aria-hidden="true"
                        className={styles.thinkingGif}
                      />
                    );
                  })()}
                  {thinkingHeadline ? (
                    <span
                      className={cn(
                        styles.headlineText,
                        getRouterPhase(thinkingHeadline) === 'direct' && styles.headlineTextDirect,
                        isTipContent(thinkingHeadline) && styles.headlineTextTip,
                      )}
                    >
                      <HeadlineWithBold text={thinkingHeadline} />
                    </span>
                  ) : (
                    <span className={styles.headlineText}>Thinking</span>
                  )}
                </>
              ) : isCollapsed ? (
                summaryText
              ) : (
                'Activity'
              )}
            </span>
            {isThinking && thinkingElapsedLabel && (
              <span className={styles.elapsed}>{thinkingElapsedLabel}</span>
            )}
            {hasExpandableContent
              ? (isCollapsed
                ? <ChevronRight className={styles.chevron} aria-hidden />
                : <ChevronDown className={styles.chevron} aria-hidden />)
              : null}
          </button>
        </div>
        {isCollapsed && runningAgentSummary && (
          <span className={styles.collapsedAgentSummary}>{runningAgentSummary}</span>
        )}
        </>
      )}
      {!isCollapsed && (isLiveWithPendingSubAgents || steps.length > 0 || orphanSubAgents.length > 0) && (
        <div 
          ref={scrollContainerRef}
          className={cn(
            styles.scrollContainer,
            scrollState === 'top' && styles.scrollFadeBottom,
            scrollState === 'bottom' && styles.scrollFadeTop,
            scrollState === 'middle' && styles.scrollFadeBoth
          )}
          onScroll={handleScroll}
          style={headless ? { overscrollBehavior: 'contain' } : undefined}
        >
          <div className={styles.list} role="list">
            {isLiveWithPendingSubAgents ? (
              <div className={cn(styles.step, styles.stepPending)}>
                <div className={styles.subagents}>
                  {subAgentTimeline?.items.map((item) => (
                    <SubAgentPill
                      key={item.id}
                      item={item}
                      toolChips={item.toolSummaries.filter(chip => chip.toolUseId !== item.toolUseId)}
                      onFocus={onFocusSubAgentRange}
                      onOpenConversation={onOpenConversation}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {(() => { const turnSeenLabels = new Set<string>(); let lastShownModel: string | undefined; return steps.map((step, stepIndex) => {
              const stepNumber = stepIndex + 1;
              const stepSubAgents = subAgentsByStep.get(stepNumber) ?? [];
              const isSelected = selectedStepNumber === stepNumber;
              const isHighlighted = Boolean(
                highlightedRange &&
                  stepNumber >= highlightedRange.start &&
                  stepNumber <= highlightedRange.end
              );
              const rawText = 'text' in step ? step.text : '';
              const rawSnippet = rawText.trim() ? createMessageSnippet(rawText, 120) : null;
              const snippet = rawSnippet ? humanizeLabel(rawSnippet) : null;
              const allChips = toolSummariesByStep.get(stepNumber) ?? [];
              const chips = subAgentOwnedSteps.has(stepNumber)
                ? []
                : allChips.filter((chip) => !(chip.toolUseId && subAgentToolUseIds.has(chip.toolUseId)));

              const hasTaskOrMissionDisplay = (taskProgress && taskProgress.length > 0) || missionContext != null;
              const deEmphasizedChips = hasTaskOrMissionDisplay
                ? chips.map((chip) =>
                    chip.toolName && TASK_MISSION_TOOL_NAMES.has(chip.toolName)
                      ? { ...chip, emphasis: 'subtle' as const }
                      : chip
                  )
                : chips;
              // Detect parallel execution: multiple non-subtle tools in one step came from the
              // same model response and were dispatched concurrently via Promise.all.
              const primaryChipCount = deEmphasizedChips.filter(c => c.emphasis !== 'subtle').length;
              const isMultiToolStep = primaryChipCount > 1;
              // turnSeenLabels tracks labels across the entire turn for cross-step dedup.
              // In multi-tool steps, allow duplicate primary tools (parallel execution
              // feedback), but still filter duplicate subtle/housekeeping tools
              // (TodoWrite, TaskUpdate) that add noise without new information.
              const toolEntries = deEmphasizedChips.filter((chip) => {
                const displayLabel = humanizeToolDisplay(chip);
                const isDuplicate = turnSeenLabels.has(displayLabel);
                turnSeenLabels.add(displayLabel);
                if (isMultiToolStep && chip.emphasis !== 'subtle') return true;
                return !isDuplicate;
              });
              const hasTools = toolEntries.length > 0;

              // Dedup snippets the same way as tools to prevent the same
              // humanized label from reappearing via the snippet fallback path.
              const isSnippetDuplicate = snippet ? turnSeenLabels.has(snippet) : false;
              if (snippet && !isSnippetDuplicate) turnSeenLabels.add(snippet);
              const showSnippet = snippet && !isSnippetDuplicate && !hasTools && stepSubAgents.length === 0;

              // Compute images before the skip check (they come from visible tools).
              // Build grid items per-tool so each tool's refs map to its own session-scoped
              // asset URLs, then flatten with a key prefix to keep React reconciliation stable
              // across tools that may produce overlapping positional indices.
              const stepImages: ImageGridItem[] = toolEntries.flatMap((tool) =>
                imageGridSourceFromEvent(
                  { imageContent: tool.imageContent, imageRef: tool.imageRef },
                  sessionId,
                  {
                    altPrefix: `${tool.label} result image`,
                    keyPrefix: tool.toolUseId ?? `${tool.toolName ?? 'tool'}-${tool.emissionIndex ?? 0}`,
                  },
                ),
              );
              const stepContentRefs = toolEntries.flatMap((tool, toolIndex) => (
                (tool.contentRef ?? []).flatMap((contentRef, refIndex) => (
                  contentRef
                    ? [{
                      key: `${tool.toolUseId ?? tool.toolName ?? 'tool'}-${toolIndex}-content-ref-${refIndex}-${contentRef.contentId}`,
                      contentRef,
                      fallbackSummary: typeof contentRef.summary === 'string' ? contentRef.summary : undefined,
                    }]
                    : []
                ))
              ));

              // Skip empty steps where everything was deduped
              if (!showSnippet && !hasTools && stepSubAgents.length === 0 && stepImages.length === 0 && stepContentRefs.length === 0) {
                return null;
              }

              return (
                <div
                  className={cn(
                    styles.step,
                    isHighlighted && styles.stepHighlighted
                  )}
                  key={`inline-step-${step.timestamp}-${stepIndex}`}
                >
                  {/* Model routing indicator — shows model name on first occurrence, · on same */}
                  {(() => {
                    if (!modelByStep || modelByStep.size === 0) return null;
                    const stepModel = modelByStep.get(stepNumber);
                    if (!stepModel) return null;
                    const isNewModel = stepModel !== lastShownModel;
                    lastShownModel = stepModel;
                    return (
                      <Tooltip content={stepModel} placement="top" delayShow={300}>
                        <span className={cn(styles.modelLabel, !isNewModel && styles.modelLabelContinuation)}>
                          {isNewModel ? shortModelName(stepModel) : '·'}
                        </span>
                      </Tooltip>
                    );
                  })()}
                  {showSnippet ? (
                    <button
                      type="button"
                      className={cn(styles.select, isSelected && styles.selectActive)}
                      aria-pressed={isSelected}
                      aria-label={`Step ${stepNumber}`}
                      onClick={() => onSelectStep(isSelected ? null : stepNumber)}
                    >
                      <span className={styles.snippet}>
                        {snippet}
                        {snippet && (turnLabelCounts.get(snippet) ?? 0) > 1 && (
                          <span className={styles.repeatCount}>{` \u00d7${turnLabelCounts.get(snippet)}`}</span>
                        )}
                      </span>
                    </button>
                  ) : null}
                  {stepSubAgents.length > 0 ? (
                    <div className={styles.subagents}>
                      {stepSubAgents.map((item) => (
                        <SubAgentPill
                          key={item.id}
                          item={item}
                          toolChips={item.toolSummaries.filter(chip => chip.toolUseId !== item.toolUseId)}
                          onFocus={onFocusSubAgentRange}
                          onOpenConversation={onOpenConversation}
                        />
                      ))}
                    </div>
                  ) : null}
                  {hasTools ? (
                    <div className={styles.toolsList}>
                      {(() => {
                        const renderToolItem = (tool: StepToolSummary, toolIndex: number) => {
                          const isLastTool = toolIndex === toolEntries.length - 1;
                          const showDots = tool.status === 'running' || tool.status === 'pending'
                            || (isThinking && isLastTool);
                          // Render a "Checking this is safe…" subline when the
                          // Safety Prompt evaluator is in flight for this tool.
                          // Keyed by toolUseId so parallel tools don't collide.
                          const evalInFlight = tool.toolUseId ? safetyEvalInFlight[tool.toolUseId] : undefined;
                          const showSafetyEvalSubline = Boolean(evalInFlight) && (tool.status === 'running' || tool.status === 'pending');
                          const safetyEvalCopy = evalInFlight && evalInFlight.attempt > 1
                            ? 'Still checking — retrying…'
                            : 'Checking this is safe…';
                          return (
                            <div
                              key={tool.toolUseId ?? `${tool.label}-${toolIndex}`}
                              className={cn(
                                styles.toolItem,
                                tool.emphasis === 'subtle' && styles.toolItemSubtle,
                                tool.status === 'error' && styles.toolItemError
                              )}
                            >
                              {showDots
                                ? <span className={styles.statusIconSpacer} />
                                : <StatusIcon status={tool.status} />}
                              <Tooltip
                                content={getToolTooltipContent(tool)}
                                maxWidth="500px"
                                delayShow={300}
                              >
                                <span className={styles.toolLabel}>
                                  {humanizeToolDisplay(tool)}
                                  {(() => {
                                    const repeatCount = turnLabelCounts.get(humanizeToolDisplay(tool)) ?? 0;
                                    return !showDots && repeatCount > 1
                                      ? <span className={styles.repeatCount}>{` \u00d7${repeatCount}`}</span>
                                      : null;
                                  })()}
                                  {showDots ? (
                                    <span className={styles.toolDots} aria-hidden>
                                      <span>.</span><span>.</span><span>.</span>
                                    </span>
                                  ) : null}
                                  {showSafetyEvalSubline ? (
                                    <span className={styles.toolSafetyEvalSubline} aria-live="polite">
                                      {safetyEvalCopy}
                                    </span>
                                  ) : null}
                                </span>
                              </Tooltip>
                            </div>
                          );
                        };

                        return isMultiToolStep ? (
                          <div className={styles.parallelBatch} role="group" aria-label={`Working on ${toolEntries.length} things at once`}>
                            <span className={styles.parallelLabel}>
                              Working on {toolEntries.length} things at once
                            </span>
                            {toolEntries.map(renderToolItem)}
                          </div>
                        ) : (
                          toolEntries.map(renderToolItem)
                        );
                      })()}
                    </div>
                  ) : null}
                  {stepImages.length > 0 ? <ImageGrid images={stepImages} /> : null}
                  {sessionId && stepContentRefs.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {stepContentRefs.map((entry) => (
                        <ToolResultContent
                          key={entry.key}
                          sessionId={sessionId}
                          contentRef={entry.contentRef}
                          fallbackSummary={entry.fallbackSummary}
                        />
                      ))}
                    </div>
                  ) : null}
                  {/* MCP Apps views are rendered at message level in MessageItem, not here */}
                  {/* Divider between steps */}
                  {stepIndex < steps.length - 1 && <hr className={styles.divider} />}
                </div>
              );
            }); })()}
            {orphanSubAgents.map((item) => (
              <div
                className={cn(styles.step, styles.stepSubagent)}
                key={`orphan-subagent-${item.id}`}
              >
                <SubAgentPill
                  item={item}
                  toolChips={item.toolSummaries.filter(chip => chip.toolUseId !== item.toolUseId)}
                  onFocus={onFocusSubAgentRange}
                  onOpenConversation={onOpenConversation}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
});
