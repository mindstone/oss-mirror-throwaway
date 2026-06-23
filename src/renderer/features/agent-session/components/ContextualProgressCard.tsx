/**
 * ContextualProgressCard — collapsed status bar + expandable 3-section card.
 *
 * Replaces the previous stacked MissionProgressCard + TurnStepsInline layout
 * with a compact, non-intimidating presentation that builds user mental models.
 *
 * @see docs/plans/260413_thinking_panel_ux_redesign.md
 * @see FOX-3050
 */

import { memo, useMemo, useState, useCallback, useRef, useEffect, type MouseEvent } from 'react';
import { ChevronRight, Check, AlertTriangle, RefreshCw, Brain, StopCircle, MessageSquare, Info, Bot, WifiOff, Clock, Power, RotateCcw } from 'lucide-react';
import { analytics } from '@renderer/src/analytics';
import { cn } from '@renderer/lib/utils';
import { Button, Tooltip } from '@renderer/components/ui';
import { useNavigationSafe } from '@renderer/contexts/NavigationContext';
import { TutorialNudge } from '@renderer/features/tutorials';
import type { ChangelogHighlight } from '@renderer/features/whats-new/utils/changelogParser';
import type { AgentEvent } from '@shared/types';
import type { SnapshotCounts } from '@rebel/shared';
import { isTipContent } from '@shared/data/tips';
import { assertNever } from '@shared/utils/assertNever';
import { formatConnectorDisplayName } from '@shared/utils/formatConnectorDisplayName';
import type { TurnEndingInput } from '@shared/utils/turnEndingClassification';
import type { FileOperationsByStep } from '../work-surface';
import type { StepToolSummary } from '../utils/toolChips';
import type { SubAgentStepRange, SubAgentTimeline } from '../utils/subAgentTimeline';
import type { MissionContextData, TaskModelRoutingInfo, TaskProgressItem } from '../utils/turnStepContext';
import { deriveCurrentActivity, deriveCollapsedSummary, shouldShowPersonaQuip, type McpBuildActivity } from '../utils/activityDerivation';
import { deriveTurnActivityRecap, type TurnActivityRecapInput } from '../utils/turnActivityRecap';
import { detectSilentStop, getResultTurnEndReason } from '../utils/detectSilentStop';
import { deriveProgressPresentation, type ProgressIconKind } from '../utils/progressPresentation';
import { MissionProgressCard } from './MissionProgressCard';
import { TurnStepsInline } from './TurnStepsInline';
import styles from './ContextualProgressCard.module.css';
import loadingGif from '@renderer/assets/animations/loading.gif';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type ContextualProgressCardProps = {
  // MissionProgressCard props
  missionContext?: MissionContextData | null;
  taskProgress?: TaskProgressItem[];
  snapshotCounts?: SnapshotCounts;
  modelByTaskId?: Map<string, TaskModelRoutingInfo>;

  // TurnStepsInline props
  steps: AgentEvent[];
  fileOperationsByStep: FileOperationsByStep;
  toolSummariesByStep: Map<number, StepToolSummary[]>;
  modelByStep?: Map<number, string>;
  selectedStepNumber: number | null;
  highlightedRange?: SubAgentStepRange | null;
  subAgentTimeline?: SubAgentTimeline | null;

  // State
  isThinking?: boolean;
  isBusy?: boolean;
  isPaused?: boolean;
  sessionId?: string;
  thinkingHeadline?: string;
  thinkingElapsedLabel?: string;
  /**
   * Live MCP connector build activity (writing / testing a new connector).
   * When set, takes priority in the Doing-right-now line so the user sees
   * "Writing <name>" or "Testing <name>" instead of lower-level tool chatter.
   * Replaces the legacy footer progress card for the `building` phase.
   */
  mcpBuildActivity?: McpBuildActivity | null;

  /**
   * Per-turn activity recap (Stage 6, finished-result surfacing). When the turn
   * has CLEANLY completed (`isComplete` and no silent-stop classification), the
   * collapsed bar swaps "Done — …" for this recap: the AI one-sentence `summary`
   * when present, else the deterministic count-line derived from the numeric
   * inputs (files/tools/duration/errors). Absent / no-activity → the collapsed
   * bar behaves exactly as before (shows "Done — …"). The numeric inputs mirror
   * the inline work disclosure's recap (deduped per-step tools; see
   * `turnActivityRecap.ts`). The `summary` arrives async via the
   * `session:activity-summary-generated` broadcast, so the count-line shows
   * first and the sentence swaps in.
   */
  activityRecap?: {
    /** AI one-sentence summary for this turn, when generated. */
    summary?: string;
    /** Tool calls shown in the inline work disclosure (deduped; excludes primary MCP-app views). */
    toolCount: number;
    /** Distinct file paths touched this turn. */
    filesTouched: number;
    /** Turn duration in ms (first-event → result). Omitted when not computable. */
    durationMs?: number;
    /** Number of errors this turn. Shown only when > 0, as a muted "hiccup". */
    errors: number;
  };

  // Silent stop classification (Stage 2+3)
  /** Events for this turn — used for stop-reason classification */
  turnEvents?: AgentEvent[];
  /** Whether the user pressed Stop (live turns only) */
  isStopping?: boolean;

  /**
   * Terminal classification from the result message. When `'transient_error'`,
   * the card renders the `interrupted` state instead of inheriting the
   * "complete" UI that `isComplete` would otherwise drive.
   *
   * The `interrupted` render state has two distinct presentations (FOX-2771
   * follow-up):
   *  - Genuine transient-network drop (this prop = `'transient_error'`, no
   *    app-close silent stop): WifiOff icon + "Rebel was interrupted" header +
   *    "Connection dropped" copy — the connectivity metaphor is correct here.
   *  - App-close interruption (the silent-stop classifier returns `'interrupted'`
   *    from the synthetic shutdown status; see detectSilentStop.ts): a NON-network
   *    icon and source-aware copy keyed on `silentStop.interruptionSource` —
   *    `'shutdown'` → Power + "Rebel was closed" / "Closed", `'startup-correction'`
   *    → RotateCcw + "Rebel restarted" / "Restarted", and `undefined`
   *    (pre-discriminator session) → Power + the generic "Rebel was interrupted" /
   *    "Interrupted". Never WifiOff or "Connection dropped" for app-close.
   */
  endedWith?: TurnEndingInput;

  // Callbacks
  onOpenConversation?: (sessionId: string) => void;
  onSelectStep: (stepNumber: number | null) => void;
  onFocusSubAgentRange?: (range: SubAgentStepRange | null) => void;
  onContinue?: () => void;
  /**
   * Called when the user clicks a changelog-highlight discovery nudge inside
   * the TutorialNudge rendered by this card. Threaded straight through.
   */
  onTryChangelog?: (highlight: ChangelogHighlight) => void;
  containerRef?: (element: HTMLElement | null) => void;
};

// Technical details persistence key
const TECH_DETAILS_KEY = 'rebel-technical-details-visible';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function stepsRemaining(count: number): string {
  return `${count} step${count !== 1 ? 's' : ''} remaining`;
}

// `finished_with_handoff` copy — verbatim from chief-designer decision in
// docs/plans/260528_rebel-h5-stopped-finished/PLAN.md. Keep these helpers
// adjacent so future copy edits stay aligned across collapsed / banner / ARIA.
function nextStepsForYouCollapsed(count: number): string {
  return count === 1 ? 'Finished — 1 next step for you' : `Finished — ${count} next steps for you`;
}

function nextStepsForYouBanner(count: number): string {
  return count === 1 ? 'Next step for you — 1 item' : `Next steps for you — ${count} items`;
}

function nextStepsForYouAria(count: number): string {
  return count === 1
    ? 'Activity: Rebel finished and left 1 next step for you. Click to expand.'
    : `Activity: Rebel finished and left ${count} next steps for you. Click to expand.`;
}

export const ContextualProgressCard = memo(({
  missionContext,
  taskProgress,
  snapshotCounts,
  modelByTaskId,
  steps,
  fileOperationsByStep,
  toolSummariesByStep,
  modelByStep,
  selectedStepNumber,
  highlightedRange,
  subAgentTimeline,
  isThinking = false,
  isBusy = false,
  isPaused = false,
  sessionId,
  thinkingHeadline,
  thinkingElapsedLabel,
  mcpBuildActivity,
  activityRecap,
  turnEvents = [],
  isStopping = false,
  endedWith,
  onOpenConversation,
  onSelectStep,
  onFocusSubAgentRange,
  onContinue,
  onTryChangelog,
  containerRef,
}: ContextualProgressCardProps) => {
  const hasMission = missionContext != null;
  const hasTasks = taskProgress != null && taskProgress.length > 0;
  const hasSteps = steps.length > 0 || toolSummariesByStep.size > 0;
  const hasSubAgents = subAgentTimeline && subAgentTimeline.items.length > 0;
  // `mcpBuildActivity` must gate the render guard so the card stays visible
  // during early build (contribution store has transitioned to 'draft'/'testing'
  // but no tools have fired yet, so `hasSteps` is false). Without this, the
  // user would see nothing — strictly worse than the old footer card.
  const hasContent = hasMission || hasTasks || hasSteps || Boolean(hasSubAgents)
    || isThinking || isPaused || Boolean(mcpBuildActivity);

  // Expand/collapse state — auto-expand during thinking
  const [userExpandedOverride, setUserExpandedOverride] = useState<boolean | null>(null);
  const isExpanded = userExpandedOverride !== null ? userExpandedOverride : (isThinking || isPaused);
  const navigation = useNavigationSafe();

  // Technical details always start collapsed — user can expand per-session
  const [techDetailsOpen, setTechDetailsOpen] = useState(false);

  // Track whether we ever had activity (preserve card after brief turns)
  const [hadActivity, setHadActivity] = useState(false);
  useEffect(() => {
    if (isThinking || hasSteps || Boolean(hasSubAgents)) {
      setHadActivity(true);
    }
  }, [isThinking, hasSteps, hasSubAgents]);

  // Reset expand override when a new turn starts thinking
  const wasThinkingRef = useRef(false);
  useEffect(() => {
    if (isThinking && !wasThinkingRef.current) {
      setUserExpandedOverride(null);
    }
    wasThinkingRef.current = isThinking;
  }, [isThinking]);

  // Derive activity state. `activity` keeps the full ladder (incl. the
  // `thinkingHeadline` gap filler) for the collapsed bar + presentation
  // derivation — preserving existing behaviour there.
  const activity = useMemo(
    () => deriveCurrentActivity({
      toolSummariesByStep,
      taskProgress,
      subAgentTimeline,
      thinkingHeadline,
      mcpBuildActivity,
    }),
    [toolSummariesByStep, taskProgress, subAgentTimeline, thinkingHeadline, mcpBuildActivity],
  );

  // Stage 4 — "one thing at a time": the PRIMARY live line is the concrete
  // activity (a real tool / sub-agent / build / error / task), derived WITHOUT
  // the rotating persona quip so the primary never becomes entertainment and so
  // its static-age can accumulate (the quip rotation would otherwise reset it
  // every few seconds). In a genuine gap this falls through to "Getting started".
  const primaryActivity = useMemo(
    () => deriveCurrentActivity({
      toolSummariesByStep,
      taskProgress,
      subAgentTimeline,
      thinkingHeadline: undefined,
      mcpBuildActivity,
    }),
    [toolSummariesByStep, taskProgress, subAgentTimeline, mcpBuildActivity],
  );

  // Track how long the PRIMARY (concrete) line has sat unchanged, so a long,
  // single-activity wait can re-engage with a quiet quip (DA SHOULD-4) instead
  // of feeling more stuck. Keyed on the concrete statusLine only — never on the
  // quip — so there's no feedback loop with the gating decision below.
  const [activityStaticForMs, setActivityStaticForMs] = useState(0);
  const primaryStatusLineRef = useRef(primaryActivity.statusLine);
  const primaryStaticSinceRef = useRef<number>(Date.now());
  const staticAgeWasThinkingRef = useRef(false);
  useEffect(() => {
    if (!isThinking) {
      staticAgeWasThinkingRef.current = false;
      setActivityStaticForMs(0);
      return;
    }
    // Reset the static clock on the thinking RISING EDGE (new turn) as well as
    // whenever the concrete line changes — so the age is measured per-turn, not
    // carried over from the previous turn's idle tail (which can share the same
    // 'Getting started' fallback string and otherwise dodge the change check).
    const enteredThinking = !staticAgeWasThinkingRef.current;
    staticAgeWasThinkingRef.current = true;
    if (enteredThinking || primaryStatusLineRef.current !== primaryActivity.statusLine) {
      primaryStatusLineRef.current = primaryActivity.statusLine;
      primaryStaticSinceRef.current = Date.now();
      setActivityStaticForMs(0);
    }
    const tick = () => {
      setActivityStaticForMs(Math.max(0, Date.now() - primaryStaticSinceRef.current));
    };
    tick();
    // Tick on the same coarse 5s cadence the elapsed bucket uses — fine enough
    // for the ~25s long-wait threshold without adding per-second re-renders to a
    // memoised card.
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, [isThinking, primaryActivity.statusLine]);

  // Whether the rotating persona quip is allowed to surface as a quiet,
  // secondary fallback line (silence-filler / long-wait reassurance). The
  // concrete line stays the single primary signal; the quip never competes.
  const showPersonaQuip =
    Boolean(thinkingHeadline)
    && shouldShowPersonaQuip({
      isThinking,
      activitySource: primaryActivity.source,
      activityStaticForMs,
    });

  // The persona quip/tip carried on `thinkingHeadline` (entertainment, demoted
  // to the secondary slot). `isTip` only paints the Info affordance on the
  // SECONDARY quip line — never on a concrete primary line (the old `isTip`
  // leaked the tip icon onto running-tool lines).
  const personaQuipIsTip = isThinking && thinkingHeadline ? isTipContent(thinkingHeadline) : false;

  // `isComplete` goes true on terminal-error turns too
  // (`!isThinking && !isBusy && hadActivity`); the presentation derivation gives
  // `interrupted` precedence over `complete` (via classifyTurnEnding(endedWith))
  // so a transient-error turn does NOT inherit the "Done"/green-Check success
  // treatment — the MA-2 bug class. See progressPresentation.ts.
  const isComplete = !isThinking && !isBusy && !isPaused && hadActivity;

  // Collapsed-bar summary uses the CONCRETE primary line (`primaryActivity`),
  // not the quip-carrying `activity.statusLine`. The collapsed bar is a live
  // region (aria-live), so feeding it the rotating persona quip would announce
  // flavour text to screen readers and diverge from the expanded primary line.
  // Stage 4 keeps both surfaces on the same single concrete signal.
  const collapsedText = useMemo(
    () => deriveCollapsedSummary({
      taskProgress,
      currentActivity: primaryActivity.statusLine,
      isThinking,
      isComplete,
      isPaused,
      endedWith,
    }),
    [taskProgress, primaryActivity.statusLine, isThinking, isComplete, isPaused, endedWith],
  );

  // Silent stop classification — see detectSilentStop.ts
  const silentStop = useMemo(
    () => detectSilentStop({ taskProgress, isThinking, isBusy, turnEvents, isStopping }),
    [taskProgress, isThinking, isBusy, turnEvents, isStopping],
  );

  // Stage 6 — finished-result recap on the ordinary-turn host. The deterministic
  // count-line (or its empty result for a no-work turn) is derived purely from
  // the recap inputs; the AI sentence, when present, takes precedence. This is
  // surfaced ONLY on a CLEANLY-completed turn (`isComplete` + classification
  // 'none'); every silent-stop / interrupted / error arm keeps its own copy.
  // When there is no recap (no tools, no files, no summary) we fall back to the
  // existing `collapsedText` ("Done — …") so older callers / trivial turns are
  // byte-identical to today.
  const completedRecap = useMemo(() => {
    if (!activityRecap) return null;
    const recapInput: TurnActivityRecapInput = {
      filesTouched: activityRecap.filesTouched,
      toolCount: activityRecap.toolCount,
      durationMs: activityRecap.durationMs,
      errors: activityRecap.errors,
    };
    const deterministic = deriveTurnActivityRecap(recapInput);
    const summary = activityRecap.summary?.trim() || undefined;
    // No renderable recap: no summary AND no deterministic terms (all-zero
    // input → empty label). The caller's count-line fallback ("Done — …") wins.
    if (!summary && !deterministic.label) return null;
    return {
      // Prefer the AI sentence; otherwise the deterministic count-line.
      text: summary ?? deterministic.label,
      // The orienting aria phrasing wraps the sentence; the deterministic line
      // carries its own naturally-read aria label.
      ariaLabel: summary
        ? `Show how Rebel worked: ${summary}`
        : deterministic.ariaLabel,
    };
  }, [activityRecap]);

  // The recap only replaces the collapsed "Done — …" on a clean finish. Any
  // silent-stop / interrupted classification keeps its existing copy (those
  // arms own the collapsed text below), so a stopped/handoff/interrupted turn
  // never reads as "look at all it did".
  const showCompletedRecap =
    isComplete && silentStop.classification === 'none' && completedRecap !== null;

  const turnEndReason = useMemo(
    () => getResultTurnEndReason(turnEvents),
    [turnEvents],
  );

  // Single source-of-truth presentation derivation — see progressPresentation.ts.
  // Replaces the duplicated icon/text/CSS-gate ladders that were scattered across
  // ~8 render branches. Memoised on the same signals those branches read so the
  // per-render cost is one classify + lookup (net flat-to-lower vs the prior
  // scattered ternaries). The `data-state` attribute is derived from this.
  const hasRunningSubAgents = Boolean(activity.subAgents && activity.subAgents.runningCount > 0);
  const presentation = useMemo(
    () => deriveProgressPresentation({
      isThinking,
      isPaused,
      isComplete,
      endedWith,
      silentStop: {
        hasSilentStop: silentStop.hasSilentStop,
        classification: silentStop.classification,
        interruptionSource: silentStop.interruptionSource,
      },
      hasError: activity.hasError,
      hasRunningSubAgents,
    }),
    [
      isThinking,
      isPaused,
      isComplete,
      endedWith,
      silentStop.hasSilentStop,
      silentStop.classification,
      silentStop.interruptionSource,
      activity.hasError,
      hasRunningSubAgents,
    ],
  );

  // Track silent stop surfaced once
  const silentStopTrackedRef = useRef(false);
  useEffect(() => {
    if (silentStop.hasSilentStop && !silentStopTrackedRef.current) {
      silentStopTrackedRef.current = true;
      analytics.track('Turn Stopped With Incomplete Tasks', {
        incompleteTaskCount: silentStop.incompleteTaskCount,
        classification: silentStop.classification,
        turnEndReason,
      });
    }
    if (!silentStop.hasSilentStop) {
      silentStopTrackedRef.current = false;
    }
  }, [silentStop.hasSilentStop, silentStop.incompleteTaskCount, silentStop.classification, turnEndReason]);

  // Progress badge — use taskProgress.length when available to avoid
  // showing "2/11" when only 5 task items are populated yet.
  const taskLen = taskProgress?.length ?? 0;
  const completedCount = snapshotCounts?.completed
    ?? (taskProgress?.filter(t => t.status === 'completed').length ?? 0);
  const totalCount = taskLen > 0 ? taskLen : (snapshotCounts?.total ?? 0);
  const showProgressBadge = totalCount >= 2;

  // Expand time tracking for analytics
  const expandStartRef = useRef<number>(0);

  // Handlers
  const handleToggle = useCallback(() => {
    const willExpand = !isExpanded;
    setUserExpandedOverride(prev => prev === null ? !isExpanded : !prev);

    if (willExpand) {
      expandStartRef.current = Date.now();
      analytics.track('Contextual Card Expanded', {
        hasTask: hasTasks,
        hasMission,
      });
    } else {
      const timeExpanded = expandStartRef.current > 0
        ? Math.round((Date.now() - expandStartRef.current) / 1000)
        : 0;
      analytics.track('Contextual Card Collapsed', {
        timeExpandedSeconds: timeExpanded,
        techDetailsViewed: techDetailsOpen,
      });
    }
  }, [isExpanded, hasTasks, hasMission, techDetailsOpen]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleToggle();
    }
    if (e.key === 'Escape' && isExpanded) {
      e.preventDefault();
      setUserExpandedOverride(false);
    }
  }, [handleToggle, isExpanded]);

  const handleTechToggle = useCallback(() => {
    setTechDetailsOpen(prev => {
      const next = !prev;
      try { localStorage.setItem(TECH_DETAILS_KEY, String(next)); } catch { /* ignore */ }
      analytics.track('Technical Details Toggled', { opened: next });
      return next;
    });
  }, []);

  const handleOperatorSetupClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const deepLink = activity.operatorSetupAffordance?.deepLink;
    if (!deepLink) return;
    void (navigation?.navigate(deepLink) ?? globalThis.__rebelNavigateForTool?.(deepLink) ?? Promise.resolve(false));
  }, [activity.operatorSetupAffordance?.deepLink, navigation]);

  const handleContinue = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    analytics.track('Turn Continued After Incomplete Tasks', {
      fromCard: true,
      incompleteTaskCount: silentStop.incompleteTaskCount,
      classification: silentStop.classification,
      turnEndReason,
    });
    onContinue?.();
  }, [onContinue, silentStop.incompleteTaskCount, silentStop.classification, turnEndReason]);

  // Don't render if there's nothing to show
  if (!hasContent && !hadActivity) {
    return null;
  }

  // Card header text — "Rebel's thinking" during, "How Rebel did this" after
  // Card header text \u2014 driven by the presentation's short header ladder
  // (interrupted -> paused -> complete -> thinking; no silentStop/hasError arm).
  const cardHeaderText = presentation.headerText;

  // Shared icon for silent stop classifications (used in both collapsed and expanded headers)
  const renderSilentStopIcon = () => {
    if (silentStop.classification === 'unexpected_stop') {
      return <AlertTriangle className={styles.statusIconSilentStop} aria-hidden />;
    }
    if (silentStop.classification === 'awaiting_user') {
      return <MessageSquare className={styles.statusIconInfo} aria-hidden />;
    }
    if (silentStop.classification === 'finished_with_handoff') {
      return <MessageSquare className={styles.statusIconInfo} aria-hidden />;
    }
    return <StopCircle className={styles.statusIconInfo} aria-hidden />;
  };

  const renderAssistantIndicator = (iconSize: number, iconClass: string) => (
    <span
      className={styles.assistantIndicator}
      aria-label={activity.subAgents ? `${activity.subAgents.runningCount} assistant${activity.subAgents.runningCount !== 1 ? 's' : ''} working` : undefined}
    >
      <Bot size={iconSize} className={iconClass} aria-hidden />
      {activity.subAgents && activity.subAgents.runningCount >= 2 && (
        <span className={styles.assistantBadge} aria-hidden>
          {activity.subAgents.badgeLabel}
        </span>
      )}
    </span>
  );

  // Header status icon (collapsed bar + expanded header) — selected structurally
  // from the presentation's full icon ladder. `placement` only differs for the
  // thinking/fallback arms: collapsed shows the loading GIF / RefreshCw, while the
  // expanded header shows no icon during active thinking (the GIF lives in the
  // "Doing right now" line). All other arms are byte-identical across placements.
  const renderHeaderIndicator = (kind: ProgressIconKind, placement: 'collapsed' | 'expanded') => {
    switch (kind) {
      case 'silent_stop':
        return renderSilentStopIcon();
      case 'interrupted':
        // Transient-network drop only (genuine connectivity loss). App-close
        // interruptions use the non-network `closed`/`restarted` icons below.
        return <WifiOff className={styles.statusIconError} aria-hidden />;
      case 'closed':
        return <Power className={styles.statusIconError} aria-hidden />;
      case 'restarted':
        return <RotateCcw className={styles.statusIconError} aria-hidden />;
      case 'complete':
        return <Check className={styles.statusIconDone} aria-hidden />;
      case 'error':
        return <AlertTriangle className={styles.statusIconError} aria-hidden />;
      case 'paused':
        return <Brain className={cn(styles.statusIndicator)} aria-hidden />;
      case 'sub_agents':
        return renderAssistantIndicator(14, styles.assistantIconCollapsed);
      case 'thinking':
        if (placement === 'expanded') return null;
        return (
          <img
            src={loadingGif}
            alt=""
            aria-hidden="true"
            className={styles.statusGif}
          />
        );
      case 'fallback':
        if (placement === 'expanded') return null;
        return <RefreshCw className={cn(styles.statusIndicator)} aria-hidden />;
      default:
        return assertNever(kind, 'renderHeaderIndicator');
    }
  };

  const renderCollapsedIndicator = () => renderHeaderIndicator(presentation.iconKind, 'collapsed');

  const renderExpandedHeaderIndicator = () => renderHeaderIndicator(presentation.iconKind, 'expanded');

  /**
   * Render the live-status text. Normally just a string, but for MCP build
   * activity we split the "Writing/Testing <name>" line so the connector
   * name can carry the reassurance tooltip that used to live on the footer
   * MCPBuildCard's `helperText`. The verb stays plain text.
   */
  const renderLiveTextContent = () => {
    // App-closed interruption (silent-stop classification) shares the
    // `interrupted` presentation state with transient-error turns but the
    // "Connection dropped" copy would be wrong — the connection was fine,
    // the app closed. See detectSilentStop.ts (Stage 1a).
    if (presentation.liveTextKind === 'interrupted') {
      // App-close interruption: say closed/restarted, never "Connection dropped"
      // (the connection was fine — the app closed). "Connection dropped" is
      // reserved for the genuine transient-network case below.
      if (silentStop.classification === 'interrupted') {
        return silentStop.interruptionSource === 'shutdown'
          ? 'Closed before finishing'
          : silentStop.interruptionSource === 'startup-correction'
            ? 'Restarted before finishing'
            : 'Interrupted before finishing';
      }
      return 'Connection dropped';
    }
    if (presentation.liveTextKind === 'complete') return 'Finished';
    if (activity.mcpBuild) {
      // The connector-name span is the Tooltip trigger. We give it
      // `tabIndex=0` + `role=button` + an aria-label containing the
      // reassurance copy so keyboard users (and screen readers) can reach
      // the copy that used to live inline on the footer MCPBuildCard.
      //
      // We deliberately skip the tip icon here even if `isTip` is true:
      // the live line is showing a build status, not a persona-rotation
      // tip, so the icon would be misleading.
      const mcpDisplayName = formatConnectorDisplayName(activity.mcpBuild.connectorName);
      return (
        <>
          {`${activity.mcpBuild.verb} `}
          <Tooltip content={activity.mcpBuild.helperText} placement="top" delayShow={300}>
            <span
              className={styles.liveTextConnector}
              tabIndex={0}
              role="button"
              aria-label={`${mcpDisplayName} — ${activity.mcpBuild.helperText}`}
            >
              {mcpDisplayName}
            </span>
          </Tooltip>
        </>
      );
    }
    // Stage 4: the primary live line is the CONCRETE activity (no rotating
    // quip, no tip icon). The persona quip/tip is demoted to its own quiet,
    // gated secondary line (renderPersonaQuipFallback) so there is one primary
    // signal at a time.
    return primaryActivity.statusLine;
  };

  /**
   * Quiet, secondary persona-quip fallback line (Stage 4). Surfaces ONE rotating
   * quip/tip below the primary activity line, but only when `showPersonaQuip`
   * (genuine idle gap, or a long static wait that risks feeling stuck). It is
   * presentational only: `aria-hidden` + no `aria-live`, so screen readers are
   * never spammed with rotating flavour text — the single primary live region
   * carries the announcement.
   */
  const renderPersonaQuipFallback = () => {
    if (!showPersonaQuip || !thinkingHeadline) return null;
    const quipText = thinkingHeadline.replace(/\*\*(.+?)\*\*/g, '$1').trim();
    if (!quipText) return null;
    return (
      <div className={styles.personaQuip} aria-hidden="true">
        {personaQuipIsTip && <Info size={12} className={styles.tipIcon} aria-hidden />}
        <span className={styles.personaQuipText}>{quipText}</span>
      </div>
    );
  };

  // Live-section indicator — driven by the presentation's `liveIconKind`, which
  // is the icon ladder WITHOUT the silentStop arm (existing #6 divergence: a
  // silent-stop turn shows the silentStop icon in the header but falls through to
  // Check/WifiOff/Brain here). `silent_stop` therefore never reaches this switch.
  const renderLiveIndicator = () => {
    switch (presentation.liveIconKind) {
      case 'interrupted':
        return <WifiOff className={cn(styles.liveIcon, styles.liveIconError)} aria-hidden />;
      case 'closed':
        return <Power className={cn(styles.liveIcon, styles.liveIconError)} aria-hidden />;
      case 'restarted':
        return <RotateCcw className={cn(styles.liveIcon, styles.liveIconError)} aria-hidden />;
      case 'complete':
        return <Check className={cn(styles.liveIcon, styles.liveIconDone)} aria-hidden />;
      case 'error':
        return <AlertTriangle className={cn(styles.liveIcon, styles.liveIconError)} aria-hidden />;
      case 'paused':
        return (
          <Brain
            className={cn(styles.liveIcon, styles.liveIconStatic)}
            aria-hidden
          />
        );
      case 'sub_agents':
        return renderAssistantIndicator(14, styles.assistantIconLive);
      case 'thinking':
        return (
          <img
            src={loadingGif}
            alt=""
            aria-hidden="true"
            className={styles.liveGif}
          />
        );
      // `silent_stop` is dead-by-construction here: the live icon ladder (#6)
      // has no silentStop arm, so `deriveLiveIconKind` never returns it. Kept in
      // the switch for type-completeness with the shared icon-kind union.
      case 'silent_stop':
      case 'fallback':
        return (
          <Brain
            className={cn(styles.liveIcon, styles.liveIconStatic)}
            aria-hidden
          />
        );
      default:
        return assertNever(presentation.liveIconKind, 'renderLiveIndicator');
    }
  };

  const renderOperatorSetupAffordance = () => {
    if (!activity.operatorSetupAffordance) return null;
    return (
      <Button
        type="button"
        size="xs"
        variant="secondary"
        onClick={handleOperatorSetupClick}
        aria-label={`${activity.operatorSetupAffordance.label} in Operators`}
      >
        {activity.operatorSetupAffordance.label}
      </Button>
    );
  };

  // ── Collapsed state ──
  if (!isExpanded) {
    // App-closed interruption collapsed copy — shared by the visible text AND
    // the aria-label below. Without the aria branch, screen readers got the
    // `deriveCollapsedSummary` "Done…" copy while sighted users saw
    // "Interrupted…" (review F1: aria/visible divergence).
    // Source-aware app-close label: "Closed" (quit) / "Restarted" (crash
    // recovery) / "Interrupted" (pre-discriminator session, generic). Never a
    // network-implying word — the app closed, the connection was fine.
    const interruptedLabel =
      silentStop.interruptionSource === 'shutdown'
        ? 'Closed'
        : silentStop.interruptionSource === 'startup-correction'
          ? 'Restarted'
          : 'Interrupted';
    const collapsedInterruptedText =
      silentStop.incompleteTaskCount > 0
        ? `${interruptedLabel} — ${stepsRemaining(silentStop.incompleteTaskCount)}`
        : `${interruptedLabel} before finishing`;
    return (
      <div className={styles.card} data-state={presentation.dataState} ref={containerRef}>
        <div
          className={styles.collapsedBar}
          role="button"
          tabIndex={0}
          aria-expanded={false}
          aria-label={
            silentStop.classification === 'finished_with_handoff'
              ? nextStepsForYouAria(silentStop.incompleteTaskCount)
              : silentStop.classification === 'interrupted'
                ? `Activity: ${collapsedInterruptedText}. Click to expand.`
                : showCompletedRecap
                  // Reuse the recap's naturally-read aria text (which already
                  // carries the "Show how Rebel worked" framing) so the spoken
                  // label matches the shown recap, not the "Done — …" copy.
                  ? `${completedRecap.ariaLabel} Click to expand.`
                  : `Activity: ${collapsedText}. Click to expand.`
          }
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
        >
          <span className={styles.statusIndicator}>
            {renderCollapsedIndicator()}
          </span>
          <span
            className={cn(
              styles.statusText,
              presentation.cssGates.collapsedStatusComplete && styles.statusTextComplete,
              silentStop.classification === 'unexpected_stop' && styles.statusTextWarning,
              (silentStop.classification === 'user_stopped'
                || silentStop.classification === 'awaiting_user'
                || silentStop.classification === 'finished_with_handoff'
                || silentStop.classification === 'interrupted')
                && styles.statusTextInfo,
            )}
            aria-live="polite"
          >
            {silentStop.classification === 'user_stopped'
              ? `Stopped by you — ${stepsRemaining(silentStop.incompleteTaskCount)}`
              : silentStop.classification === 'awaiting_user'
                ? `Waiting for you — ${stepsRemaining(silentStop.incompleteTaskCount)}`
                : silentStop.classification === 'unexpected_stop'
                  ? `Stopped — ${stepsRemaining(silentStop.incompleteTaskCount)}`
                  : silentStop.classification === 'finished_with_handoff'
                    ? nextStepsForYouCollapsed(silentStop.incompleteTaskCount)
                    : silentStop.classification === 'interrupted'
                      ? collapsedInterruptedText
                      // Stage 6: on a clean finish, surface the recap (AI
                      // sentence, else deterministic count-line) instead of the
                      // "Done — …" template. The label is single-line clamped
                      // (CSS) so a late summary swap is a pure text change.
                      : showCompletedRecap
                        ? completedRecap.text
                        : collapsedText}
          </span>
          {showProgressBadge && (
            <span className={styles.progressBadge}>{completedCount}/{totalCount}</span>
          )}
          {isThinking && thinkingElapsedLabel && (
            <span className={styles.elapsed}>{thinkingElapsedLabel}</span>
          )}
          <ChevronRight className={styles.chevron} aria-hidden />
        </div>
      </div>
    );
  }

  // ── Expanded state ──
  const hasExpandableSteps = hasSteps || Boolean(hasSubAgents);

  return (
    <div className={styles.card} data-state={presentation.dataState} ref={containerRef}>
      <div
        className={styles.expandedContent}
        role="region"
        aria-label="Agent activity details"
      >
        <div className={styles.expandedInner}>
          {/* Header — click to collapse */}
          <button
            type="button"
            className={styles.expandedHeader}
            onClick={handleToggle}
            aria-expanded={true}
            aria-label={`${cardHeaderText}. Click to collapse.`}
          >
            {(() => {
              const icon = renderExpandedHeaderIndicator();
              return icon ? <span className={styles.statusIndicator}>{icon}</span> : null;
            })()}
            <span className={styles.expandedHeaderText}>{cardHeaderText}</span>
            {isThinking && thinkingElapsedLabel && (
              <span className={styles.elapsed}>{thinkingElapsedLabel}</span>
            )}
            <ChevronRight className={cn(styles.chevron, styles.chevronOpen)} aria-hidden />
          </button>

          {/* Divider between header and content sections */}
          <hr className={styles.sectionDivider} />

          {isThinking && sessionId && (
            <TutorialNudge
              isThinking={isThinking}
              sessionId={sessionId}
              onTryChangelog={onTryChangelog}
            />
          )}

          {/* Section 1: Planning — tasks and goal */}
          {(hasMission || hasTasks) && (
            <div className={styles.planSection}>
              <span className={styles.sectionLabel}>
                Planning
                {showProgressBadge && (
                  <span className={styles.sectionCount}>{completedCount}/{totalCount}</span>
                )}
              </span>
              <MissionProgressCard
                missionContext={missionContext}
                taskProgress={taskProgress}
                snapshotCounts={snapshotCounts}
                modelByTaskId={modelByTaskId}
                isThinking={isThinking}
                embedded
              />
            </div>
          )}

          {/* Section 2: Right now (live activity line) */}
          <div className={styles.liveSection}>
            <span className={cn(styles.sectionLabel, presentation.cssGates.sectionLabelComplete && styles.sectionLabelComplete)}>
              {silentStop.classification === 'finished_with_handoff'
                ? 'Rebel finished'
                : presentation.sectionLabelText}
            </span>
            {hasExpandableSteps ? (
              <button
                type="button"
                className={styles.liveActivityButton}
                onClick={handleTechToggle}
                aria-expanded={techDetailsOpen}
                aria-controls="contextual-tech-details"
              >
                <span className={styles.liveActivityLine}>
                  {renderLiveIndicator()}
                  <span
                    className={cn(
                      styles.liveText,
                      presentation.cssGates.liveTextDone && styles.liveTextDone,
                    )}
                    aria-live="polite"
                  >
                    {renderLiveTextContent()}
                  </span>
                </span>
                <ChevronRight
                  className={cn(
                    styles.liveActivityChevron,
                    techDetailsOpen && styles.liveActivityChevronOpen,
                  )}
                  aria-hidden
                />
              </button>
            ) : (
              <div className={styles.liveActivityLine}>
                {renderLiveIndicator()}
                <span
                  className={cn(
                    styles.liveText,
                    presentation.cssGates.liveTextDone && styles.liveTextDone,
                  )}
                  aria-live="polite"
                >
                  {renderLiveTextContent()}
                </span>
              </div>
            )}
            {/* Stage 4: quiet, gated persona-quip fallback (silence-filler /
                long-wait reassurance). Never competes with the concrete line. */}
            {renderPersonaQuipFallback()}
            {renderOperatorSetupAffordance()}
            {/* Stage 4 ("one thing at a time"): the compact assistant preview
                chips no longer stack in the calm default — when sub-agents are
                running, the primary live line already names that activity
                (deriveCurrentActivity Priority 4) and the assistant
                icon+badge carry the count. The full per-assistant chips remain
                reachable in the Technical details panel (SubAgentPills below),
                so no detail is lost — just demoted. */}
            {hasExpandableSteps && techDetailsOpen && (
              <div
                id="contextual-tech-details"
                className={styles.technicalContent}
              >
                <TurnStepsInline
                  steps={steps}
                  fileOperationsByStep={fileOperationsByStep}
                  toolSummariesByStep={toolSummariesByStep}
                  modelByStep={modelByStep}
                  selectedStepNumber={selectedStepNumber}
                  highlightedRange={highlightedRange}
                  subAgentTimeline={subAgentTimeline}
                  isThinking={isThinking}
                  thinkingHeadline={thinkingHeadline}
                  thinkingElapsedLabel={thinkingElapsedLabel}
                  missionContext={missionContext}
                  taskProgress={taskProgress}
                  sessionId={sessionId}
                  onOpenConversation={onOpenConversation}
                  onSelectStep={onSelectStep}
                  onFocusSubAgentRange={onFocusSubAgentRange}
                  headless
                />
              </div>
            )}
          </div>

          {/* Silent stop banner — differentiated by classification.
              Also rendered for continue-eligible timeout errors (Stage 1b):
              `error_exit` keeps hasSilentStop false (the error banner owns the
              failure display) but gains a Continue affordance here. */}
          {(silentStop.hasSilentStop || silentStop.errorContinueEligible) && (() => {
            // Continue-eligible timeout/stall error (watchdog, response-stalled,
            // extended-silence) — additive to the existing error banner/Try-again.
            // DISTINCT presentation from app-close interruption (Composer F4):
            // a timeout kill is not "Rebel closed".
            const isErrorContinue =
              !silentStop.hasSilentStop && silentStop.errorContinueEligible;
            const isAppCloseInterrupted = silentStop.classification === 'interrupted';
            const isWarning = silentStop.classification === 'unexpected_stop';
            // `finished_with_handoff` and `awaiting_user` are user-owned next steps,
            // not failures — don't offer "Continue" (would re-run the agent over a
            // queued user task). See PLAN.md (REBEL-H5). `error_exit` only offers
            // Continue when the terminal error is timeout/stall shaped — same
            // predicate as the banner gate, kept aligned here so the two cannot
            // drift (Composer F2).
            const showContinue =
              silentStop.classification !== 'awaiting_user'
              && silentStop.classification !== 'finished_with_handoff'
              && (silentStop.classification !== 'error_exit' || silentStop.errorContinueEligible)
              && onContinue;
            // App-close banner icon is source-aware and NON-network (FOX-2771
            // follow-up): Power for a quit, RotateCcw for crash recovery, Power
            // for pre-discriminator (unknown) — never WifiOff, which reads as a
            // connectivity drop the user never had.
            const BannerIcon =
              isAppCloseInterrupted
                ? (silentStop.interruptionSource === 'startup-correction' ? RotateCcw : Power)
              : isErrorContinue ? Clock
              : silentStop.classification === 'user_stopped' ? StopCircle
              : silentStop.classification === 'awaiting_user' ? MessageSquare
              : silentStop.classification === 'finished_with_handoff' ? MessageSquare
              : AlertTriangle;
            // Banner copy: finished_with_handoff uses verbatim chief-designer copy
            // ("Next step for you — N items"). Others keep "<label> — N steps remaining".
            // App-close banner copy is source-aware: name WHAT happened (closed
            // vs restarted) instead of the network-implying "Interrupted".
            const appCloseBannerLead =
              silentStop.interruptionSource === 'shutdown'
                ? 'Rebel was closed before this finished'
                : silentStop.interruptionSource === 'startup-correction'
                  ? 'Rebel restarted before this finished'
                  : 'Rebel was interrupted before this finished';
            const bannerText =
              silentStop.classification === 'finished_with_handoff'
                ? nextStepsForYouBanner(silentStop.incompleteTaskCount)
                : isAppCloseInterrupted
                  ? (silentStop.incompleteTaskCount > 0
                      ? `${appCloseBannerLead} — ${stepsRemaining(silentStop.incompleteTaskCount)}`
                      : appCloseBannerLead)
                  : isErrorContinue
                    // error_exit is only reachable with incomplete tasks, so the
                    // count is always meaningful here.
                    ? `Timed out — ${stepsRemaining(silentStop.incompleteTaskCount)}`
                    : `${
                        silentStop.classification === 'user_stopped' ? 'Stopped by you'
                        : silentStop.classification === 'awaiting_user' ? 'Waiting for you'
                        : 'Stopped'
                      } — ${stepsRemaining(silentStop.incompleteTaskCount)}`;

            return (
              <div
                className={isWarning ? styles.silentStopBanner : styles.silentStopBannerInfo}
                {...(isWarning ? { role: 'alert' as const } : {})}
              >
                <BannerIcon
                  className={isWarning ? styles.statusIconSilentStop : styles.statusIconInfo}
                  aria-hidden
                />
                <span className={isWarning ? styles.silentStopText : styles.silentStopTextInfo}>
                  {bannerText}
                </span>
                {showContinue && (
                  <button
                    type="button"
                    className={styles.silentStopContinue}
                    onClick={handleContinue}
                  >
                    Continue
                  </button>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
});

ContextualProgressCard.displayName = 'ContextualProgressCard';
