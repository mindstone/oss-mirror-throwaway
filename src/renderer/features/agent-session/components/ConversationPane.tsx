import { forwardRef, memo, useMemo, useState, useEffect, useRef, useCallback, useImperativeHandle } from "react";
import { computeTaskDisplayProps } from '@rebel/shared';
import { useIpcEvent } from "@renderer/hooks/useIpcEvent";
import { useVirtualizer, elementScroll, defaultRangeExtractor } from "@tanstack/react-virtual";
import type { VirtualizerOptions } from "@tanstack/react-virtual";
import { cn } from "@renderer/lib/utils";
import type {
  AgentEvent,
  AgentTurnMessage,
  CompactionBoundary as CompactionBoundaryType,
  CommunitySharePreview,
} from "@shared/types";
import type { ChangelogHighlight } from "@renderer/features/whats-new/utils/changelogParser";
import { ContextualProgressCard } from "./ContextualProgressCard";
import { EmptyConversationState } from "./EmptyConversationState";
import { FirstBigWinCard } from "./FirstBigWinCard";
import { CommunityWinCard } from "./CommunityWinCard";
import {
  MCPBuildCard,
  type MCPBuildCardActionHandlers,
  type MCPBuildCardState,
} from "./MCPBuildCard";
import { MCPAuthRequiredCard } from "./MCPAuthRequiredCard";
import { MessageItem } from "./MessageItem";
import { UserQuestionCard } from "./UserQuestionCard";
import { OnboardingCoachIntro } from "./OnboardingCoachIntro";
import { FocusContextCard } from "../../focus/components/FocusContextCard";
import { getConversationMeasureCache, setMeasureCacheEntryLru } from "../utils/lruMeasureCache";
import { useCommunityShare } from "../hooks/useCommunityShare";
import { useMemoryUpdateStatus } from "../hooks/useMemoryUpdateStatus";
import { useTimeSavedStatus } from "../hooks/useTimeSavedStatus";
import { useActivitySummary } from "../hooks/useActivitySummary";
import { useSessionStore } from "../store/sessionStore";
import { extractQuestionBatches, extractAnsweredBatches, buildQuestionBatchStates, type QuestionBatchState } from "../hooks/useUserQuestions";
import { useScrollToAnswer, computeScrollToAnswerIndex } from "../hooks/useScrollToAnswer";
import type { AuthRequiredCardInfo } from "../hooks/useAuthRequiredSignals";
import type { TurnStepContext } from "../utils/turnStepContext";
import type { SubAgentTimeline } from "../utils/subAgentTimeline";
import type { McpBuildActivity } from "../utils/activityDerivation";
import type { PrimitiveDiagnostics } from "../dev/switchTimingProbe";
import { shouldHandleConversationPaneTimeSavedStatus } from '@renderer/utils/timeSavedStatusRouting';
import styles from "./ConversationPane.module.css";

// Stable empty array reference to prevent React.memo invalidation when turnEvents is undefined
const EMPTY_EVENTS: AgentEvent[] = [];
const EMPTY_AUTH_REQUIRED_CARD_MAP: ReadonlyMap<number, AuthRequiredCardInfo[]> = new Map();

// Stable fallback for onSubmitPrompt — keeps EmptyConversationState's memo
// boundary from invalidating when the prop isn't wired by the caller.
const noopSubmitPrompt = (_prompt: string): void => {
  void _prompt;
};
const noopReconnect = (_packageId: string): Promise<void> => Promise.resolve();

const SETTLING_SKELETON_ROWS: ReadonlyArray<{
  alignment: 'assistant' | 'user';
  width: string;
  minHeight: string;
  lines: readonly string[];
  chipWidths?: readonly string[];
}> = [
  {
    alignment: 'assistant',
    width: '48%',
    minHeight: '112px',
    lines: ['34%', '92%', '66%'],
  },
  {
    alignment: 'user',
    width: '40%',
    minHeight: '84px',
    lines: ['78%', '54%'],
  },
  {
    alignment: 'assistant',
    width: '60%',
    minHeight: '148px',
    lines: ['42%', '96%', '86%', '62%'],
    chipWidths: ['92px', '74px'],
  },
  {
    alignment: 'user',
    width: '34%',
    minHeight: '72px',
    lines: ['68%'],
  },
  {
    alignment: 'assistant',
    width: '52%',
    minHeight: '102px',
    lines: ['84%', '58%'],
  },
];

function buildSettlingTurnEventsCacheKey(events: AgentEvent[]): string {
  const last = events[events.length - 1] as
    | (AgentEvent & { timestamp?: number; id?: string; type?: string })
    | undefined;
  return `${events.length}:${last?.timestamp ?? ''}:${last?.id ?? ''}:${last?.type ?? ''}`;
}

function estimateUncachedMessageHeight(message: AgentTurnMessage): number {
  const text = message.displayText ?? message.text ?? '';
  const lineCount = Math.max(1, text.split('\n').length);
  const textUnits = Math.ceil(text.length / 120);

  if (message.role === 'user') {
    return Math.min(260, 88 + lineCount * 16 + textUnits * 8);
  }

  const attachmentCount = message.attachments?.length ?? 0;
  const attachmentBoost = attachmentCount > 0 ? 80 : 0;
  return Math.min(760, 220 + lineCount * 18 + textUnits * 22 + attachmentBoost);
}

// Idle scheduler with setTimeout fallback. Same pattern as
// `MessageMarkdown.tsx` — kept local to avoid a dependency cycle.
const scheduleIdle = (callback: () => void, options?: { timeout?: number }): number => {
  if ('requestIdleCallback' in window) {
    return window.requestIdleCallback(callback, options);
  }
  return setTimeout(callback, 100) as unknown as number;
};
const cancelIdle = (id: number): void => {
  if ('requestIdleCallback' in window) {
    window.cancelIdleCallback(id);
  } else {
    clearTimeout(id);
  }
};

// Note: MultiStepStreamingContainer was removed. Duplicate text prevention is now
// handled by MessageItem, which conditionally hides MessageMarkdown content when
// it duplicates the step snippets shown in TurnStepsInline.

// ── `scrollToBottomUntilStable` tuning constants ─────────────────────────────
// Hoisted to module scope per Stage 1 review follow-up (Opus S1). Keeps the
// full tuning surface greppable and importable from tests.
// See `docs/plans/260420_scroll_to_bottom_primitive_refactor.md` §Stage 1.
/** Pixels of tolerance when deciding whether `scrollTop` is "at bottom". */
export const SCROLL_SETTLE_TOLERANCE_PX = 2;
/** Consecutive rAF frames of full stability required before resolving `stable`. */
export const SCROLL_SETTLE_STABLE_FRAMES = 3;
/** Additional hold window (ms) after stability is first reached.
 *  Guards against immediate post-stable virtualizer corrections that can
 *  otherwise cause visible up/down jitter right after reveal. */
export const SCROLL_SETTLE_FINAL_HOLD_MS = 180;
/** Minimum quiet window (ms since last virtualizer/layout activity) before a
 *  frame counts toward `stable`. */
export const SCROLL_SETTLE_QUIESCENCE_MS = 100;
/** Inter-rAF gap threshold (ms). Gaps > this imply the main thread was
 *  blocked — that frame's "quiet" observation is a lie; do not count it. */
export const SCROLL_SETTLE_GAP_THRESHOLD_MS = 48;
/** Default wall-clock cap on one primitive's life.
 *  Settling resolves as soon as stability is reached, so raising this cap
 *  only affects pathological long-thread cases where measurement commits
 *  and async tail content need extra time.
 *
 *  Two upstream changes still keep mount cost low:
 *  (a) the primitive pre-seeds the virtualizer's render window to the
 *      bottom via `scrollToIndex(lastIndex, { align: 'end' })` before
 *      the chase loop starts, so only the items around the bottom
 *      mount — not from the top down;
 *  (b) `SETTLING_OVERSCAN_CAP` drops from 500 → 50, limiting the
 *      synchronous render burst to ~50 `MessageItem` components
 *      regardless of thread length.
 *  Together these prevent multi-second freezes while preserving headroom
 *  for worst-case long sessions. See
 *  `docs-private/investigations/260420_long_restored_conversation_scroll_short.md`. */
export const SCROLL_SETTLE_MAX_WALL_MS = 5000;

/**
 * Outcome reasons for `scrollToBottomUntilStable`.
 *
 * See `docs/plans/260420_scroll_to_bottom_primitive_refactor.md` for the
 * full design rationale.
 */
export type ScrollSettleReason =
  /** Geometry + measurement-commit gates all cleared for STABLE_FRAMES rAFs in a row. */
  | 'stable'
  /** Hit `maxWallMs` without stability. `landedAtBottom` reflects the final at-bottom check. */
  | 'timeout'
  /** The caller-supplied `AbortSignal` fired (session switch, new navigation, unmount). */
  | 'aborted'
  /** The user scrolled (wheel / touchmove / pointerdown) during the chase. */
  | 'user-scrolled'
  /** The scroll container was torn down mid-primitive. */
  | 'unmounted'
  /** No messages to scroll to, or virtualizer not initialised. */
  | 'empty';

export interface ScrollSettleResult {
  /**
   * `true` iff the final at-bottom geometry check passed within
   * `SETTLE_TOLERANCE_PX`. For `stable` always `true`. For `empty` also
   * `true` (trivially "at the end" when there's no content). For all other
   * reasons, may be `true` (timeout-but-close) or `false`.
   */
  landedAtBottom: boolean;
  reason: ScrollSettleReason;
  /** Dev-only timing diagnostics, populated only under VITE_PERFORMANCE. */
  diagnostics?: PrimitiveDiagnostics;
}

export interface ScrollToBottomUntilStableOptions {
  /** Abort the chase early. Resolves with `reason: 'aborted'`. */
  signal?: AbortSignal;
  /** Hard cap. Default: 5000ms. */
  maxWallMs?: number;
}

/** Extended ref handle for virtualized conversation pane */
export interface ConversationPaneHandle {
  /** Scroll to a specific message index */
  scrollToIndex: (index: number, options?: { behavior?: 'auto' | 'smooth'; align?: 'start' | 'center' | 'end' }) => void;
  /** Scroll to the bottom of the conversation */
  scrollToBottom: (options?: { behavior?: 'auto' | 'smooth' }) => void;
  /**
   * Promise-returning settling primitive. Pins `scrollTop` to the bottom
   * per rAF while the virtualizer's measurement pipeline converges, then
   * resolves with a structured outcome once stability criteria are met
   * (or the chase is aborted / times out / the user scrolls away).
   *
   * Non-optional by design — tests that mock `ConversationPaneHandle` must
   * provide a stub; dev-mode fallbacks are loud precisely so missing
   * implementations can't hide as silent no-ops.
   *
   * See `docs/plans/260420_scroll_to_bottom_primitive_refactor.md`.
   */
  scrollToBottomUntilStable: (
    options?: ScrollToBottomUntilStableOptions,
  ) => Promise<ScrollSettleResult>;
  /** Get the underlying scroll element for direct scroll position access */
  getScrollElement: () => HTMLDivElement | null;
  /** Get the indices of currently visible items (virtualization-safe) */
  getVisibleRange: () => { startIndex: number; endIndex: number } | null;
  /**
   * True while a programmatic scroll is actively writing `scrollTop`
   * (either `useScrollToAnswer`'s smooth scroll via the custom `scrollToFn`,
   * or `scrollToBottomUntilStable`'s per-rAF pin). `useConversationAutoScroll`
   * consults this to short-circuit its sticky-scroll-away latch so per-frame
   * writes aren't mistaken for a user scroll-up.
   *
   * Counter-backed (not boolean): begin increments, end decrements. The
   * getter returns `count > 0`. This prevents the race where one actor's
   * end-callback would clear the flag while another programmatic actor is
   * still driving scroll. Backward-compatible with consumers that check
   * truthiness.
   *
   * Optional so omission (e.g. test doubles) is a no-op.
   * See `docs-private/investigations/260416_answered_question_card_not_visible.md`
   * and `docs/plans/260420_scroll_to_bottom_primitive_refactor.md` (Invariant #6).
   */
  isProgrammaticScrollInFlight?: () => boolean;
}

export type ConversationPaneProps = {
  visibleMessages: AgentTurnMessage[];
  eventsByTurn: Record<string, AgentEvent[]>;
  visibleTurnId: string;
  /** The turn currently focused in the transcript (if any) */
  focusedTurnId: string | null;
  /** The turn the agent runtime is actively processing (from runtime state).
   *  Unlike focusedTurnId (which changes on user click/focus), this only changes
   *  when the agent starts or finishes a turn. Used for thinking indicators. (FOX-2505) */
  processingTurnId: string | null;
  editingMessageId: string | null;
  /** Whether the agent is actively processing a turn */
  isBusy: boolean;
  isStopping: boolean;
  /** Whether the conversation is settling after loading history (hidden during this time) */
  isSettling?: boolean;
  /** Whether the transcript should remain visually masked while settling runs. */
  isRevealMasked?: boolean;
  /** When true, keep the viewport at the start of the latest answer instead of re-pinning to bottom. */
  suspendBottomAnchor?: boolean;
  /** Current session ID - used to detect session switches for animation tracking */
  currentSessionId: string;
  isTextMode: boolean;
  /** When true, the turn is waiting on blocking approval and should look paused, not actively thinking. */
  isPausedForApproval?: boolean;
  turnStepContextByTurn: Record<string, TurnStepContext>;
  subAgentTimelineByTurn: Map<string, SubAgentTimeline>;
  activeStepByTurn: Record<string, number | null>;
  /** Headline text to show while thinking (e.g., "Translating bullet chaos...") */
  thinkingHeadline?: string;
  /** Elapsed time label while thinking (e.g., "10s") */
  thinkingElapsedLabel?: string;
  /** Compaction boundaries marking where context was compacted */
  compactionBoundaries?: CompactionBoundaryType[];
  resolveTurnIdForMessage: (message: AgentTurnMessage) => string | null;
  onBeginEditMessage: (messageId: string) => void;
  onRetryMessage?: (messageId: string) => void;
  /** Stage 1b: stop the live turn — powers the soft "still waiting" affordance (State B). */
  onStopActiveTurn?: () => void;
  onSelectInlineStep: (turnId: string, stepNumber: number | null) => void;
  onFocusTurn: (turnId: string) => void;
  onOpenFile: (path: string) => void;
  onOpenFolder?: (folderPath: string) => void;
  onOpenConversation?: (sessionId: string) => void;
  onNavigate?: (url: string) => void;
  onOpenTutorial?: (tutorialPath: string) => void;
  onCopyToClipboard: (text: string) => void;
  showToast?: (options: { title: string }) => void;
  coreDirectory?: string;
  onOpenInLibrary?: (filePath: string, isFolder: boolean) => void;
  /** Whether onboarding coach is active - suppresses celebratory UI like FirstBigWinCard */
  isOnboardingCoachActive?: boolean;
  /** Community share callbacks — passed from SessionSurfaceContent */
  onSharePreview?: () => Promise<CommunitySharePreview | null>;
  onShareOpen?: () => Promise<void>;
  onShareDismiss?: () => void;
  onShareOptOut?: () => void;
  /** When true, removes content max-width constraints for tables and wide content */
  isWideMode?: boolean;
  /** When true, the transcript is sharing space with a document preview drawer. */
  isDocumentPreviewOpen?: boolean;
  /** Optional visual shell for the MCP setup flow. Harry wires the state later. */
  mcpBuildCardState?: MCPBuildCardState | null;
  /** Optional MCP build callbacks — currently UI-only hooks for Harry to wire later. */
  onMcpBuildCardActions?: MCPBuildCardActionHandlers;
  /** True for OSS builds, where contribution sharing is unavailable. */
  isOssBuild?: boolean;
  authRequiredCardByMessageIndex?: ReadonlyMap<number, AuthRequiredCardInfo[]>;
  onStartAuthReconnect?: (packageId: string) => Promise<void>;
  onCancelAuthReconnect?: (packageId: string) => Promise<void>;
  /** Set of batch IDs suppressed from the pending footer queue */
  dismissedBatchIds?: Set<string>;
  /** Undo dismiss — restore batch to pending footer queue */
  onUndoDismiss?: (batchId: string) => void;
  /** Callback to continue working on incomplete tasks — wired to silent stop Continue button */
  onContinueIncomplete?: () => void;
  /**
   * Submit a prompt from the empty-conversation-state conversation starters.
   * Routes through the existing message queue in SessionSurfaceContent.
   */
  onSubmitPrompt?: (prompt: string) => void;
  /**
   * Called when the user clicks a changelog-highlight discovery whisper/nudge.
   * Starts a fresh "What's New" session for the selected feature.
   * If omitted, changelog highlights are suppressed so no dead button renders.
   */
  onTryChangelog?: (highlight: ChangelogHighlight) => void;
};

export function shouldRenderInlineQuestionBatch(questionBatch: QuestionBatchState): boolean {
  return questionBatch.isAnswered;
}

const ConversationPaneComponent = forwardRef<
  ConversationPaneHandle,
  ConversationPaneProps
>(
  (
    {
      visibleMessages,
      eventsByTurn,
      visibleTurnId,
      focusedTurnId,
      processingTurnId,
      editingMessageId,
      isBusy,
      isStopping,
      isSettling = false,
      isRevealMasked = false,
      suspendBottomAnchor = false,
      currentSessionId,
      isTextMode,
      isPausedForApproval = false,
      turnStepContextByTurn,
      subAgentTimelineByTurn,
      activeStepByTurn,
      thinkingHeadline,
      thinkingElapsedLabel,
      compactionBoundaries = [],
      resolveTurnIdForMessage,
      onBeginEditMessage,
      onRetryMessage,
      onStopActiveTurn,
      onSelectInlineStep,
      onFocusTurn,
      onOpenFile,
      onOpenFolder,
      onOpenConversation,
      onNavigate,
      onOpenTutorial,
      onCopyToClipboard,
      showToast,
      coreDirectory,
      onOpenInLibrary,
      isOnboardingCoachActive = false,
      onSharePreview,
      onShareOpen,
      onShareDismiss,
      onShareOptOut,
      isWideMode = false,
      isDocumentPreviewOpen = false,
      mcpBuildCardState = null,
      onMcpBuildCardActions,
      isOssBuild = false,
      authRequiredCardByMessageIndex = EMPTY_AUTH_REQUIRED_CARD_MAP,
      onStartAuthReconnect = noopReconnect,
      onCancelAuthReconnect = noopReconnect,
      dismissedBatchIds,
      onUndoDismiss: _onUndoDismiss,
      onContinueIncomplete,
      onSubmitPrompt,
      onTryChangelog,
    },
    ref,
  ) => {
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    /**
     * Callback-ref-backed state for the inner `.virtualListContainer` div.
     *
     * Why a state value (not a plain `useRef`): the bottom-anchor effect
     * below needs to run when this element actually mounts. A plain `useRef`
     * is set silently during render and won't retrigger effects. For long
     * sessions the pane can render briefly without the virtual list (e.g.
     * while `visibleMessages` is still empty during a session load), and by
     * the time the virtual list mounts the effect — keyed only on
     * `currentSessionId` — would have already run and bailed. State-backed
     * ref fixes that: the `set` call triggers a render, the effect's
     * dependency on `virtualListEl` changes, the anchor attaches cleanly.
     */
    const [virtualListEl, setVirtualListEl] = useState<HTMLDivElement | null>(null);
    const { statusByTurn: memoryStatusByTurn } = useMemoryUpdateStatus();
    const { statusByTurn: timeSavedStatusByTurn } = useTimeSavedStatus();
    const { summaryByTurn: activitySummaryByTurn } = useActivitySummary();
    const communityShareEligibility = useCommunityShare(currentSessionId);

    // Derive the Doing-right-now build activity from `mcpBuildCardState`.
    // Folded into the thinking card so the user sees one unified activity
    // anchor instead of a separate footer progress card that could linger
    // if the contribution store got stuck in `testing` (see
    // docs/plans/260420_simplify_mcp_build_flow.md and the CHIEF_BUGFIXER
    // diagnosis of session c19ef9cb-4a3a).
    //
    // Three gates live here:
    //   1) Primitive-dep memo — `mcpBuildCardState` reference can churn every
    //      poll (~2s) even when the user-visible values are identical. We
    //      extract primitives so callers downstream only re-render when the
    //      subphase or connector actually changes.
    //   2) Processing-turn presence — without an active turn, there is no
    //      thinking card to embed in; keeps the row tied to a live surface.
    //   3) Origin-turn match — the contribution store is session-global; if
    //      a previous turn left it stuck in `building` and the user starts
    //      an unrelated turn, gate (2) alone would still leak "Testing X"
    //      into the new turn. We capture the processing turn id the first
    //      time we observe `building` during a live turn (`buildOrigin.turnId`)
    //      and only surface the activity when the current processing turn
    //      matches. If we ever saw `building` without a processing turn
    //      (app load / session switch into a pre-stuck state), we mark
    //      `stuckFromStart` and refuse to capture an origin until the phase
    //      leaves `building`. Either way, a `console.warn` fires once per
    //      stuck episode so the underlying regression stays observable.
    const buildPhase = mcpBuildCardState?.phase ?? null;
    const buildSubphase = mcpBuildCardState?.phase === 'building' ? mcpBuildCardState.subphase : null;
    const buildConnectorName = mcpBuildCardState?.phase === 'building' ? mcpBuildCardState.connectorName : null;

    const [buildOrigin, setBuildOrigin] = useState<{ turnId: string | null; stuckFromStart: boolean }>(
      { turnId: null, stuckFromStart: false },
    );

    useEffect(() => {
      setBuildOrigin(prev => {
        if (buildPhase !== 'building') {
          if (prev.turnId === null && !prev.stuckFromStart) return prev;
          return { turnId: null, stuckFromStart: false };
        }
        if (!processingTurnId) {
          return prev.stuckFromStart ? prev : { ...prev, stuckFromStart: true };
        }
        if (prev.stuckFromStart || prev.turnId !== null) return prev;
        return { turnId: processingTurnId, stuckFromStart: false };
      });
    }, [buildPhase, processingTurnId]);

    const mcpBuildActivity = useMemo<McpBuildActivity | null>(() => {
      if (!buildSubphase || !buildConnectorName) return null;
      if (!processingTurnId) return null;
      if (buildOrigin.turnId === null || buildOrigin.turnId !== processingTurnId) return null;
      return {
        subphase: buildSubphase,
        connectorName: buildConnectorName,
      };
    }, [buildSubphase, buildConnectorName, processingTurnId, buildOrigin.turnId]);

    const loggedStuckBuildRef = useRef(false);
    useEffect(() => {
      if (buildPhase !== 'building') {
        loggedStuckBuildRef.current = false;
        return;
      }
      const suppressedForNoTurn = !processingTurnId;
      const suppressedForOriginMismatch = Boolean(processingTurnId)
        && (buildOrigin.turnId === null || buildOrigin.turnId !== processingTurnId);
      if (!suppressedForNoTurn && !suppressedForOriginMismatch) return;
      if (loggedStuckBuildRef.current) return;
      loggedStuckBuildRef.current = true;
      console.warn(
        '[mcp-build] phase=building suppressed on activity row — likely stuck contribution state',
        {
          reason: suppressedForNoTurn ? 'no-processing-turn' : 'origin-turn-mismatch',
          subphase: buildSubphase,
          connectorName: buildConnectorName,
          originTurnId: buildOrigin.turnId,
          processingTurnId: processingTurnId ?? null,
          stuckFromStart: buildOrigin.stuckFromStart,
        },
      );
    }, [buildPhase, processingTurnId, buildSubphase, buildConnectorName, buildOrigin.turnId, buildOrigin.stuckFromStart]);

    // User question cards — pure computation only (no side effects).
    // The interactive hook lives in SessionSurfaceContent (footer card).
    // ConversationPane only renders answered/skipped cards inline.
    const questionBatches = useMemo(() => {
      const batches = extractQuestionBatches(eventsByTurn, currentSessionId);
      // Pass currentSessionId so cross-session answered events are filtered
      // symmetrically with question events. See
      // docs-private/investigations/260424_user_question_cross_session_routing_leak.md.
      const answered = extractAnsweredBatches(eventsByTurn, currentSessionId);
      return buildQuestionBatchStates(batches, answered, dismissedBatchIds?.size ? { dismissedBatchIds } : undefined);
    }, [eventsByTurn, currentSessionId, dismissedBatchIds]);

    // Pre-compute which message indices should show a question card.
    // For each question batch, find the LAST message whose turn matches the batch's turnId.
    // When a batch's turn has no visible messages (e.g. system-continuation turns where
    // the only user message is isHidden), fall back to the closest preceding visible message.
    const questionCardByMessageIndex = useMemo(() => {
      const map = new Map<number, QuestionBatchState[]>();
      if (questionBatches.length === 0) return map;

      const batchesByTurnId = new Map<string, QuestionBatchState[]>();
      for (const qb of questionBatches) {
        const existing = batchesByTurnId.get(qb.batch.turnId) ?? [];
        existing.push(qb);
        batchesByTurnId.set(qb.batch.turnId, existing);
      }

      // Walk backwards to find the last message for each question-bearing turn
      for (let i = visibleMessages.length - 1; i >= 0; i--) {
        const msg = visibleMessages[i];
        const turnId = resolveTurnIdForMessage(msg);
        if (turnId && batchesByTurnId.has(turnId)) {
          const batches = batchesByTurnId.get(turnId);
          if (batches) map.set(i, batches);
          batchesByTurnId.delete(turnId);
        }
        if (batchesByTurnId.size === 0) break;
      }

      // Orphaned batches: turns with no visible messages (e.g. the only user
      // message was isHidden/system-continuation). Anchor them to the closest
      // preceding visible message by timestamp.
      if (batchesByTurnId.size > 0) {
        const orphanedBatches = [...batchesByTurnId.values()]
          .flat()
          .sort((a, b) => a.batch.timestamp - b.batch.timestamp);

        for (const orphan of orphanedBatches) {
          let bestIndex = -1;
          for (let i = visibleMessages.length - 1; i >= 0; i--) {
            const msgTime = visibleMessages[i].createdAt ?? 0;
            if (msgTime <= orphan.batch.timestamp) {
              bestIndex = i;
              break;
            }
          }
          // Last resort: append after the final visible message
          if (bestIndex < 0 && visibleMessages.length > 0) {
            bestIndex = visibleMessages.length - 1;
          }
          if (bestIndex >= 0) {
            const existing = map.get(bestIndex) ?? [];
            existing.push(orphan);
            map.set(bestIndex, existing);
          }
        }
      }

      return map;
    }, [questionBatches, visibleMessages, resolveTurnIdForMessage]);

    // Track if onboarding coach intro has been dismissed
    const [isOnboardingIntroDismissed, setIsOnboardingIntroDismissed] = useState(false);

    // First Big Win celebration state (declared early — needed by virtualizer phantom row logic)
    const [showFirstBigWin, setShowFirstBigWin] = useState(false);
    const [firstBigWinMinutes, setFirstBigWinMinutes] = useState(0);
    const firstBigWinCheckedRef = useRef(false);

    // Smooth scroll support - tracks current animation to allow cancellation
    const scrollingRef = useRef<number>(0);

    // Custom scroll function for smooth animated scrolling (when requested)
    const scrollToFn: VirtualizerOptions<HTMLDivElement, Element>['scrollToFn'] = useCallback(
      (offset, canSmooth, instance) => {
        if (!canSmooth) {
          // Instant scroll - use default behavior
          elementScroll(offset, canSmooth, instance);
          return;
        }

        // Smooth scroll with easing
        const duration = 300; // Match CSS animation duration
        const start = scrollContainerRef.current?.scrollTop ?? 0;
        const startTime = (scrollingRef.current = Date.now());

        // Ease-out cubic for natural deceleration
        const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

        const animate = () => {
          if (scrollingRef.current !== startTime) return; // Cancelled
          const now = Date.now();
          const elapsed = now - startTime;
          const progress = easeOutCubic(Math.min(elapsed / duration, 1));
          const interpolated = start + (offset - start) * progress;

          if (elapsed < duration) {
            elementScroll(interpolated, {}, instance);
            requestAnimationFrame(animate);
          } else {
            elementScroll(offset, {}, instance);
          }
        };

        requestAnimationFrame(animate);
      },
      []
    );

    // Determine if we need a phantom "thinking" row at the end of the virtualized list.
    // This keeps the thinking indicator inside the virtualized layout to prevent overlap bugs.
    // Uses processingTurnId (runtime state) instead of focusedTurnId (UI focus) so that
    // clicking previous messages doesn't remove the thinking row. (FOX-2505)
    const showThinkingUi = isBusy && !isPausedForApproval;
    const rawShowStarting = showThinkingUi && !processingTurnId && !isStopping;

    // Debounce the "Starting" indicator by 150ms to avoid a flash during queue drain
    // and other rapid isBusy transitions (e.g., auto-continue). The phantom row adds
    // height that triggers aggressive auto-scroll before the turn is actually assigned.
    const [debouncedShowStarting, setDebouncedShowStarting] = useState(false);
    const startingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      if (rawShowStarting) {
        startingTimerRef.current = setTimeout(() => {
          setDebouncedShowStarting(true);
        }, 150);
      } else {
        if (startingTimerRef.current) {
          clearTimeout(startingTimerRef.current);
          startingTimerRef.current = null;
        }
        setDebouncedShowStarting(false);
      }
      return () => {
        if (startingTimerRef.current) {
          clearTimeout(startingTimerRef.current);
        }
      };
    }, [rawShowStarting, currentSessionId]);

    const showStartingIndicator = debouncedShowStarting;
    const showStandaloneThinking = showThinkingUi && processingTurnId && !isStopping && !visibleMessages.some(
      (m) => (m.role === "assistant" || m.role === "result") && m.turnId === processingTurnId
    );
    // Streaming text appears inside the ContextualProgressCard (which contains TurnStepsInline)
    // rather than a separate streaming container, to avoid duplicate text.
    const hasPhantomThinkingRow = showStartingIndicator || showStandaloneThinking;

    // Celebration cards are also rendered as phantom rows inside the virtualizer to prevent
    // overlap bugs (same class of issue the thinking row fix addresses — the virtualizer's
    // getTotalSize() can be stale when message heights change, causing siblings placed after
    // the virtualListContainer to overlap with absolutely-positioned messages).
    const hasFirstBigWinRow = showFirstBigWin && !isOnboardingCoachActive;
    const hasCommunityShareRow = Boolean(
      communityShareEligibility && !showFirstBigWin && !isOnboardingCoachActive && !isBusy &&
      onSharePreview && onShareOpen && onShareDismiss && onShareOptOut
    );
    // Render the submitted phantom row as soon as the state-machine reaches
    // `submitted`, even if `prUrl` hasn't propagated yet (or is missing due
    // to the rare `ready_to_submit → submitted` transition-rejection fallback
    // in contributionHandlers.ts). MCPBuildCard's submitted variant degrades
    // gracefully without prUrl (hides the "View on GitHub" button).
    // See docs-private/investigations/260416_mcp_submit_loading_then_nothing.md.
    //
    // Stage 3 (260420): the renderer-driven `testing` phase was removed —
    // the agent now owns testing end-to-end via SKILL.md DoD + bridge
    // evidence gate, so there's no testing-phase card to render a phantom
    // row for. `testing-error` renders inline via the transcript already.
    //
    // 260424 PR-template revamp follow-up (addendum #2): the `github-check`
    // phase is handled entirely by the footer question batch. The inline
    // card for that phase was removed along with the "One more thing" form,
    // so there's no inline row to render.
    const hasMcpBuildRow = Boolean(
      mcpBuildCardState && mcpBuildCardState.phase === 'submitted',
    );

    const virtualItemCount = visibleMessages.length
      + (hasPhantomThinkingRow ? 1 : 0)
      + (hasFirstBigWinRow ? 1 : 0)
      + (hasCommunityShareRow ? 1 : 0)
      + (hasMcpBuildRow ? 1 : 0);

    // ── Stable virtualizer callbacks via refs ──────────────────────────
    // TanStack Virtual's internal `getMeasurementOptions` memo depends on
    // `getItemKey` by reference. When it changes, ALL item positions are
    // recalculated from index 0. Previously, `getItemKey` was a useCallback
    // with [visibleMessages, ...] deps, meaning every new message triggered
    // a full recalculation. Combined with `useFlushSync: false` (async
    // position corrections), this created a window where stale translateY
    // values could cause visible message overlap.
    //
    // Fix: read volatile values from refs so the callback reference is
    // permanently stable. Full recalculations now only happen when `count`
    // changes (unavoidable and correct).
    const visibleMessagesRef = useRef(visibleMessages);
    visibleMessagesRef.current = visibleMessages;
    const processingTurnIdKeyRef = useRef(processingTurnId);
    processingTurnIdKeyRef.current = processingTurnId;
    const phantomFlagsRef = useRef({
      hasPhantomThinkingRow,
      hasFirstBigWinRow,
      hasCommunityShareRow,
      hasMcpBuildRow,
    });
    phantomFlagsRef.current = {
      hasPhantomThinkingRow,
      hasFirstBigWinRow,
      hasCommunityShareRow,
      hasMcpBuildRow,
    };

    // External measurement cache — survives across virtualizer recalculations
    // AND across session switches. When `count` changes and positions are
    // recalculated, items that were previously measured get their real height
    // from this cache via `estimateSize` instead of the 150px default,
    // dramatically reducing the magnitude of position corrections needed.
    //
    // Persisting across session switches (no per-switch clear) is safe because
    // message IDs are globally unique UUIDs — a height cached under one session's
    // message ID cannot collide with another session's messages. Keeping the cache
    // warm means switch-back to a long thread hits accurate estimates immediately
    // and `scrollToBottom`'s 25-RAF chase loop converges reliably. Clearing here
    // (removed Apr 2026, shipped in v0.4.25) caused the "scroll jumps near top"
    // amplifier on long threads — see
    // docs-private/investigations/260416_thread_scroll_jumps_to_top_on_switch.md.
    const measureCacheRef = useRef(getConversationMeasureCache());
    const suspendBottomAnchorRef = useRef(suspendBottomAnchor);
    suspendBottomAnchorRef.current = suspendBottomAnchor;

    // Bounded LRU cap: prevents unbounded growth across very long sessions or
    // long-lived app sessions. Cap chosen empirically: 2,000 entries is large
    // enough to cover the longest practical threads while bounding memory.
    // See `setMeasureCacheEntryLru` for implementation.
    const MEASURE_CACHE_MAX_ENTRIES = 2000;
    const setMeasureCacheEntry = useCallback((id: string, size: number) => {
      setMeasureCacheEntryLru(measureCacheRef.current, id, size, MEASURE_CACHE_MAX_ENTRIES);
    }, []);

    // Stable key function — uses refs so TanStack Virtual never sees a new
    // function reference, preventing unnecessary full position recalculations.
    // See: https://github.com/TanStack/virtual/issues/1092
    const getItemKey = useCallback((index: number) => {
      const msgs = visibleMessagesRef.current;
      if (index < msgs.length) {
        return msgs[index]?.id ?? `msg-${index}`;
      }
      const flags = phantomFlagsRef.current;
      let phantomSlot = 0;
      const phantomOffset = index - msgs.length;
      if (flags.hasPhantomThinkingRow) {
        if (phantomOffset === phantomSlot) return `__thinking__:${processingTurnIdKeyRef.current ?? 'starting'}`;
        phantomSlot++;
      }
      if (flags.hasFirstBigWinRow) {
        if (phantomOffset === phantomSlot) return '__firstBigWin__';
        phantomSlot++;
      }
      if (flags.hasCommunityShareRow) {
        if (phantomOffset === phantomSlot) return '__communityShare__';
        phantomSlot++;
      }
      if (flags.hasMcpBuildRow) {
        if (phantomOffset === phantomSlot) return '__mcpBuild__';
        phantomSlot++;
      }
      return `__phantom__:${index}`;
    }, []);

    // Stable estimateSize — returns previously-measured height when available.
    // This is the second line of defense: even when the virtualizer does a
    // full recalculation (e.g., count change), items that were previously
    // measured get accurate initial positions instead of 150px.
    const estimateSize = useCallback((index: number) => {
      const msgs = visibleMessagesRef.current;
      if (index < msgs.length) {
        const id = msgs[index]?.id;
        if (id) {
          const cached = measureCacheRef.current.get(id);
          if (cached !== undefined) return cached;
        }
      }
      const message = msgs[index];
      if (message) return estimateUncachedMessageHeight(message);
      return 150;
    }, []);

    const getScrollElement = useCallback(() => scrollContainerRef.current, []);

    // Dynamic overscan during the settling window (pane hidden).
    //
    // Why: `useVirtualizer` computes `getTotalSize()` by summing each item's
    // height — measured size if rendered, otherwise `estimateSize()` (150px
    // for uncached items). At steady state only viewport+5-overscan items are
    // rendered and measured; items above stay at 150px. When actual row
    // heights are ~400-800px (ContextualProgressCard, tutorial nudges, MCP
    // build cards, markdown code blocks, etc.), `getTotalSize()` is 3-5x
    // smaller than the true content height. The chase loop in
    // `scrollToBottom` converges to `scrollHeight - clientHeight` which
    // reflects this wrong total — so the last message APPEARS to be at the
    // bottom of the viewport, but the user is actually stranded in the middle
    // of the real content range. (See
    // docs-private/investigations/260420_scroll_to_bottom_still_broken.md.)
    //
    // Fix: during settling (pane hidden via `.settling` opacity:0), bump
    // overscan to cover every message so each row mounts, measures via
    // ResizeObserver, and populates the external cache. `getTotalSize()` then
    // reflects real heights and the chase lands at the true bottom.
    //
    // The cap `SETTLING_OVERSCAN_CAP` prevents mounting an unbounded number
    // of MessageItems on very long threads. For threads longer than the cap,
    // the last N messages still measure correctly — the user lands at the
    // true bottom of that region. Items above the cap stay estimated; they
    // will measure when the user scrolls up.
    //
    // Dropped 500 → 50 (Apr 2026) because the primitive now pre-seeds the
    // virtualizer's render window to the bottom via `scrollToIndex(lastIndex,
    // { align: 'end' })` before the chase loop starts. With the render window
    // anchored at the bottom, an overscan of ~50 covers the bottom region
    // exactly — there's no need to mount 500 rows starting from the top.
    // The old 500 cap was generating ~1s+ main-thread long tasks on threads
    // with many turns (see the diagnosis in
    // `docs-private/investigations/260420_long_restored_conversation_scroll_short.md`).
    //
    const SETTLING_OVERSCAN_CAP = 50;
    const activeOverscan = isSettling
      ? Math.min(visibleMessages.length, SETTLING_OVERSCAN_CAP)
      : 5;

    // Pane-level activity signal for `scrollToBottomUntilStable`.
    //
    // The primitive subscribes by setting this ref to its own callback and
    // clears it on resolution. The virtualizer's `onChange` hook reads the
    // ref each time TanStack Virtual notifies (measurement commits, range
    // recalculations, etc.) — this is our primary "something just moved in
    // the virtualizer" pulse.
    //
    // Do NOT expand `handleVirtualizerChange`'s body. It runs inside
    // TanStack Virtual's synchronous useLayoutEffect chain (notify →
    // onChange), the same hot path that the `measureCacheRef` sync
    // `useEffect` below is deliberately written to AVOID (see that
    // comment). One ref read + one optional-call is safe because
    // `primitiveActivityListenerRef.current` only does `performance.now()`
    // and a single assignment. Anything heavier here will re-introduce
    // the multi-second UI freeze that motivated the post-paint sync.
    const primitiveActivityListenerRef = useRef<(() => void) | null>(null);
    const anchorActivityListenerRef = useRef<(() => void) | null>(null);
    const handleVirtualizerChange = useCallback(() => {
      primitiveActivityListenerRef.current?.();
      anchorActivityListenerRef.current?.();
    }, []);

    // Progressive idle-time measurement.
    //
    // Why: `estimateSize` returns a flat 150px for unmeasured rows, but real
    // assistant messages (ContextualProgressCard + markdown) are routinely
    // 400-800px tall. When the user scrolls upward, unmeasured items
    // entering the 5-row overscan above the viewport get mounted and
    // measured by ResizeObserver. Each new measurement makes
    // `getTotalSize()` grow, so TanStack Virtual applies a translateY
    // correction to every item below — fighting the user's upward scroll
    // and producing jarring stutter at message boundaries. Downward scroll
    // doesn't suffer this because measuring rows below the viewport
    // doesn't shift items already rendered above.
    //
    // Fix: after settling completes, walk the list bottom→top during
    // browser idle time. The custom `rangeExtractor` below silently
    // includes a sliding batch above the viewport so those rows mount and
    // get measured. Each idle tick advances `progressiveFrontierRef`
    // upward by `PROGRESSIVE_BATCH_SIZE`, until index 0 is reached.
    //
    // Cost: each batch mounts ~10 MessageItems briefly. Real height
    // populates the LRU cache via `measureElementRef`-equivalent path
    // (the effect below this block syncs `virtualizer.getVirtualItems()`
    // sizes to `setMeasureCacheEntry`). Once the frontier reaches 0,
    // `getTotalSize()` reflects true heights and upward scrolling becomes
    // smooth — no more first-measurement jumps.
    //
    // See FOX-3147 / `docs/plans/260427_scrolling_stage0_and_paths.md`.
    const PROGRESSIVE_BATCH_SIZE = 10;
    const progressiveFrontierRef = useRef<number>(virtualItemCount);
    // Clamp the frontier so it never exceeds current count (e.g., session
    // switch shortens the list).
    if (progressiveFrontierRef.current > virtualItemCount) {
      progressiveFrontierRef.current = virtualItemCount;
    }
    // Tick state that forces a re-render whenever the idle driver advances
    // the frontier. TanStack Virtual reads `rangeExtractor` lazily — bumping
    // the ref alone won't cause it to recompute the visible range. A render
    // makes it call `rangeExtractor(range)` again with the updated frontier.
    const [, forceProgressiveKick] = useState(0);
    const rangeExtractor = useCallback(
      (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
        const defaultRange = defaultRangeExtractor(range);
        const frontier = progressiveFrontierRef.current;
        // Frontier is the lowest unmeasured index. If it's already at or
        // below the visible/overscan range, nothing extra to mount.
        if (frontier <= 0 || frontier <= range.startIndex) {
          return defaultRange;
        }
        const batchEnd = frontier - 1;
        const batchStart = Math.max(0, frontier - PROGRESSIVE_BATCH_SIZE);
        const seen = new Set<number>(defaultRange);
        const merged: number[] = defaultRange.slice();
        for (let i = batchStart; i <= batchEnd; i += 1) {
          if (!seen.has(i)) {
            merged.push(i);
            seen.add(i);
          }
        }
        merged.sort((a, b) => a - b);
        return merged;
      },
      [],
    );

    // Virtual list for efficient rendering of long conversations
    // virtualizer-remount-reviewed: Stage 5 keyed ConversationPane by currentSessionId at SessionSurfaceContent mount site.
    const virtualizer = useVirtualizer({
      count: virtualItemCount,
      getScrollElement,
      estimateSize,
      overscan: activeOverscan,
      scrollToFn,
      getItemKey,
      rangeExtractor,
      // Disable flushSync to avoid "flushSync was called from inside a lifecycle method" React errors.
      // This occurs when TanStack Virtual's sync scroll corrections conflict with React's render phase,
      // causing state updates to be dropped (e.g., "agent is working" indicator not showing).
      // Tradeoff: potentially slightly more whitespace during fast scrolling with dynamic items.
      // See: https://github.com/TanStack/virtual/issues/1094, PR #1100
      useFlushSync: false,
      onChange: handleVirtualizerChange,
    });

    // Sync virtualizer measurements to external cache so that items scrolled
    // out and back in get accurate estimates instead of 150px.
    // IMPORTANT: This must be a post-paint useEffect, NOT a useVirtualizer
    // onChange callback. onChange runs inside TanStack Virtual's synchronous
    // useLayoutEffect chain (notify → onChange), which blocks the main thread
    // before paint. For long conversations, this causes a multi-second UI
    // freeze when sending messages. The depless useEffect defers this cheap
    // sync (~15-20 visible items) to after paint, avoiding the blockage.
    useEffect(() => {
      const items = virtualizer.getVirtualItems();
      const msgs = visibleMessagesRef.current;
      let lowestMeasured = Number.POSITIVE_INFINITY;
      for (const item of items) {
        if (item.index < msgs.length) {
          const id = msgs[item.index]?.id;
          if (id && item.size > 0) {
            setMeasureCacheEntry(id, item.size);
            if (item.index < lowestMeasured) lowestMeasured = item.index;
          }
        }
      }
      // Advance the progressive frontier downward as soon as upper
      // batches finish measuring. The frontier always tracks the lowest
      // index that still needs progressive measurement.
      if (Number.isFinite(lowestMeasured) && lowestMeasured < progressiveFrontierRef.current) {
        progressiveFrontierRef.current = lowestMeasured;
      }
    });

    // Drive the progressive frontier upward during browser idle time.
    //
    // Each idle tick decrements the frontier by `PROGRESSIVE_BATCH_SIZE`.
    // The custom `rangeExtractor` reads the new frontier on the next
    // virtualizer recalc and includes that batch in the rendered range.
    // ResizeObserver populates measurements; the post-paint sync effect
    // above advances `progressiveFrontierRef` to the lowest measured
    // index. We loop on `requestAnimationFrame` chained with
    // `requestIdleCallback` until the frontier reaches 0.
    //
    // Wait until settling completes — settling already mounts the bottom
    // 50 rows for the chase loop; running progressive measurement
    // concurrently would be redundant work and risk fighting the
    // settling pass.
    useEffect(() => {
      if (isSettling) return;
      if (virtualItemCount === 0) return;

      let cancelled = false;
      let idleId: number | null = null;

      const tick = () => {
        if (cancelled) return;
        if (progressiveFrontierRef.current <= 0) return;
        const next = Math.max(0, progressiveFrontierRef.current - PROGRESSIVE_BATCH_SIZE);
        progressiveFrontierRef.current = next;
        // Re-render so TanStack Virtual recomputes the range and our
        // `rangeExtractor` sees the updated frontier. Without this the
        // ref change is invisible to the virtualizer's range memo.
        forceProgressiveKick((n) => n + 1);

        if (next > 0) {
          idleId = scheduleIdle(tick, { timeout: 500 });
        }
      };

      idleId = scheduleIdle(tick, { timeout: 500 });
      return () => {
        cancelled = true;
        if (idleId !== null) cancelIdle(idleId);
      };
    }, [isSettling, virtualItemCount, currentSessionId]);

    // Programmatic-scroll coordination with useConversationAutoScroll.
    // Non-zero while any programmatic scroll actor is writing scrollTop:
    //   - `useScrollToAnswer`'s smooth scroll (begin/end callbacks).
    //   - `scrollToBottomUntilStable`'s per-rAF pin (increments on start,
    //     decrements in its `settle()` helper).
    //
    // Counter (not boolean) so concurrent actors don't race: one ending its
    // scroll must not clear the flag while another is still pinning. The
    // getter exposed on the handle returns `count > 0` which is
    // backward-compatible with all existing truthiness consumers — grep for
    // `isProgrammaticScrollInFlight` in `useConversationAutoScroll.ts` and
    // the test files confirms this.
    //
    // See `docs-private/investigations/260416_answered_question_card_not_visible.md`
    // and `docs/plans/260420_scroll_to_bottom_primitive_refactor.md`
    // (Invariant #6).
    const programmaticScrollInFlightRef = useRef(0);
    const handleBeginProgrammaticScroll = useCallback(() => {
      programmaticScrollInFlightRef.current += 1;
    }, []);
    const handleEndProgrammaticScroll = useCallback(() => {
      const next = programmaticScrollInFlightRef.current - 1;
      if (next < 0 && import.meta.env.DEV) {
        console.warn(
          '[scroll-settle] programmatic-scroll counter underflow in handleEndProgrammaticScroll — begin/end calls are unbalanced.',
        );
      }
      programmaticScrollInFlightRef.current = Math.max(0, next);
    }, []);

    // Expose scroll methods via imperative handle
    useImperativeHandle(ref, () => ({
      scrollToIndex: (index: number, options?: { behavior?: 'auto' | 'smooth'; align?: 'start' | 'center' | 'end' }) => {
        // Guard: ensure scroll container is mounted and index is valid
        if (!scrollContainerRef.current || index < 0 || index >= visibleMessages.length) {
          return;
        }
        virtualizer.scrollToIndex(index, { align: options?.align ?? 'end', behavior: options?.behavior ?? 'auto' });
      },
      scrollToBottom: (options?: { behavior?: 'auto' | 'smooth' }) => {
        // Guard: ensure scroll container is mounted and there are messages
        if (!scrollContainerRef.current || visibleMessages.length === 0) {
          return;
        }
        
        const container = scrollContainerRef.current;
        const isSmooth = options?.behavior === 'smooth';
        
        // Custom RAF-based smooth scroll instead of native behavior:'smooth'.
        // Native smooth scroll gets interrupted by TanStack Virtual's scroll
        // corrections (item measurement changes scrollHeight mid-animation),
        // causing visible jitter. This custom animation controls scrollTop
        // directly and recalculates the target each frame, so it adapts
        // smoothly to scrollHeight changes from virtualization.
        if (isSmooth) {
          const LERP_FACTOR = 0.16;
          const MIN_STEP = 4;
          const SNAP_THRESHOLD = 1;
          const MAX_FRAMES = 120;
          let frames = 0;

          let smoothAborted = false;
          const abortSmooth = () => { smoothAborted = true; };
          container.addEventListener('wheel', abortSmooth, { passive: true, once: true });
          container.addEventListener('touchmove', abortSmooth, { passive: true, once: true });
          container.addEventListener('pointerdown', abortSmooth, { passive: true, once: true });

          const cleanupSmooth = () => {
            container.removeEventListener('wheel', abortSmooth);
            container.removeEventListener('touchmove', abortSmooth);
            container.removeEventListener('pointerdown', abortSmooth);
          };

          const animateSmooth = () => {
            if (!scrollContainerRef.current || smoothAborted) {
              cleanupSmooth();
              return;
            }

            const target = container.scrollHeight - container.clientHeight;
            const gap = target - container.scrollTop;

            if (Math.abs(gap) < SNAP_THRESHOLD || frames >= MAX_FRAMES) {
              container.scrollTop = target;
              cleanupSmooth();
              return;
            }

            const step = gap * LERP_FACTOR;
            const minStep = Math.sign(gap) * Math.min(Math.abs(gap), MIN_STEP);
            container.scrollTop += Math.abs(step) > Math.abs(minStep) ? step : minStep;

            frames++;
            requestAnimationFrame(animateSmooth);
          };

          requestAnimationFrame(animateSmooth);
          return;
        }
        
        // For instant scroll, use the "chase the bottom" loop because with virtualization:
        // - Most items start with estimated heights (150px)
        // - When we scroll down, new items render and get measured
        // - If actual heights > estimates, scrollHeight grows
        // - A single scroll lands at the OLD bottom, not the new one
        // - We need to keep chasing until measurements stabilize
        //
        // Convergence strategy (revised Apr 2026, see
        // docs-private/investigations/260420_scroll_to_bottom_still_broken.md):
        //   - Exit only after STABLE_FRAMES consecutive frames with (a) stable
        //     scrollHeight AND (b) already at bottom. The previous "exit when
        //     !scrollHeightChanged && !notAtBottom" was brittle: with
        //     `useFlushSync: false` the virtualizer's `scrollHeight` can
        //     appear stable for a frame or two while late measurements are
        //     pending, causing the loop to exit short. The stability
        //     threshold absorbs that jitter.
        //   - Use a wall-clock deadline (MAX_WALL_MS) instead of a fixed RAF
        //     count. Tall rows (ContextualProgressCard, inline tutorial
        //     nudges, MCP build cards) plus deferred turn-event heights
        //     (`useDeferredValue(eventsByTurnVersion)`) can keep growing
        //     well past 400ms.
        //
        // Note: TanStack Virtual regression in v3.13.8+ where scrollToIndex
        // doesn't correctly scroll to the bottom with dynamic height items.
        // See: https://github.com/TanStack/virtual/issues/1001
        const MAX_WALL_MS = 2000;
        const STABLE_FRAMES = 3;
        const SETTLE_TOLERANCE_PX = 2;
        const startedAt = performance.now();
        let stableFrames = 0;
        let lastScrollHeight = 0;

        let aborted = false;
        const abortOnUserScroll = () => { aborted = true; };
        container.addEventListener('wheel', abortOnUserScroll, { passive: true, once: true });
        container.addEventListener('touchmove', abortOnUserScroll, { passive: true, once: true });
        container.addEventListener('pointerdown', abortOnUserScroll, { passive: true, once: true });

        const cleanupAbort = () => {
          container.removeEventListener('wheel', abortOnUserScroll);
          container.removeEventListener('touchmove', abortOnUserScroll);
          container.removeEventListener('pointerdown', abortOnUserScroll);
        };

        const scrollToEnd = () => {
          if (!scrollContainerRef.current || aborted) {
            cleanupAbort();
            return;
          }

          const targetTop = container.scrollHeight - container.clientHeight;
          const currentTop = container.scrollTop;
          const scrollHeightChanged = container.scrollHeight !== lastScrollHeight;
          lastScrollHeight = container.scrollHeight;

          if (Math.abs(targetTop - currentTop) > SETTLE_TOLERANCE_PX) {
            container.scrollTo({
              top: targetTop,
              behavior: 'auto'
            });
          }

          const notAtBottom = Math.abs(targetTop - container.scrollTop) > SETTLE_TOLERANCE_PX;
          const convergedThisFrame = !scrollHeightChanged && !notAtBottom;

          if (convergedThisFrame) {
            stableFrames++;
          } else {
            stableFrames = 0;
          }

          const elapsed = performance.now() - startedAt;
          const done = stableFrames >= STABLE_FRAMES || elapsed >= MAX_WALL_MS;

          if (!done) {
            requestAnimationFrame(scrollToEnd);
          } else {
            cleanupAbort();
          }
        };

        scrollToEnd();
      },
      scrollToBottomUntilStable: (options?: ScrollToBottomUntilStableOptions): Promise<ScrollSettleResult> => {
        return new Promise<ScrollSettleResult>((resolve) => {
          // Tuning constants are module-scoped (see top of file) so Stage 3
          // tests can import them and so the full tuning surface is greppable
          // in one place. Per-call overrides come only via `options`.
          const maxWallMs = options?.maxWallMs ?? SCROLL_SETTLE_MAX_WALL_MS;
          const signal = options?.signal;
          // Early-return: already aborted by the caller.
          //
          // Ordered BEFORE the empty check (Behavioral Safety Stage 1 Issue
          // 2): respects caller cancellation intent even when the
          // conversation happens to be empty. Otherwise a session-switch
          // abort on an empty pane would look like a successful settle to
          // the caller.
          if (signal?.aborted) {
            resolve({ landedAtBottom: false, reason: 'aborted' });
            return;
          }

          const container = scrollContainerRef.current;

          // Early-return: empty / not initialised.
          // No counter touch (we never incremented).
          if (!container || visibleMessagesRef.current.length === 0) {
            resolve({ landedAtBottom: true, reason: 'empty' });
            return;
          }

          // Opus NEW-4: increment the programmatic-scroll counter BEFORE
          // attaching listeners or scheduling the first rAF. Ordering
          // matters: the counter must already be non-zero by the time any
          // observable side-effect (scrollTop pin, scroll event) could be
          // attributed to this primitive, or `useConversationAutoScroll`'s
          // scroll handler will engage the sticky latch against us.
          programmaticScrollInFlightRef.current += 1;

          // Pre-seed the virtualizer's render window to the bottom BEFORE
          // the chase loop starts. Without this, the render window sits
          // around the current `scrollTop` (initially 0 on first mount),
          // so `SETTLING_OVERSCAN_CAP` only mounts items near the TOP.
          // On long threads (hundreds of messages, tens of thousands of
          // pixels tall), the items that actually need to measure — the
          // bottom ones — never mount during the budget window, and
          // `getTotalSize()` stays short by hundreds of percent (150px
          // estimate × hundreds of rows vs ~400–600px real heights).
          //
          // Calling `virtualizer.scrollToIndex(lastIndex, { align: 'end' })`
          // moves the render window to the bottom region. Combined with
          // the reduced `SETTLING_OVERSCAN_CAP` (50, not 500), this means
          // only ~50 items around the bottom mount synchronously — a ~10×
          // reduction in the synchronous-mount cost that was producing
          // multi-second main-thread long tasks on long threads. The
          // `canSmooth:false` path in `scrollToFn` (an `elementScroll`
          // call) is cheap — no animation, just a `scrollTop` assignment
          // that the chase loop's own pin will immediately correct if
          // measurements disagree.
          //
          // Safe now that the programmatic-scroll counter is already
          // incremented — the resulting scroll event is attributed to
          // this primitive, not a user gesture.
          //
          // We read `virtualItemCount` from the closure rather than
          // `virtualizer.options.count` because the latter isn't
          // universally present on mocked virtualizers in unit tests
          // (and `virtualItemCount` is recomputed each render from
          // `visibleMessages` + phantom flags, which is already exactly
          // the value passed as `count` to `useVirtualizer`).
          const lastIndex = virtualItemCount - 1;
          if (lastIndex >= 0) {
            virtualizer.scrollToIndex(lastIndex, { align: 'end', behavior: 'auto' });
          }

          let settled = false;
          let rafId: number | null = null;
          let stableFrames = 0;
          let holdStableSinceAt: number | null = null;
          const startedAt = performance.now();
          let previousRafAt = startedAt;
          let previousScrollHeight = container.scrollHeight;
          let lastActivityAt = startedAt;
          const diagnostics: PrimitiveDiagnostics | undefined =
            import.meta.env.VITE_PERFORMANCE === 'true'
              ? {
                  primTotalMs: 0,
                  msToFirstTerminalRow: null,
                  msToFirstAtBottomGeometry: null,
                  msToFirstStableFrame: null,
                  msToHoldStart: null,
                  finalHoldMs: null,
                  maxFrameGapMs: 0,
                  framesOverGapThreshold: 0,
                  resetsGeometryGap: 0,
                  resetsTerminalRowMissing: 0,
                  resetsQuiescenceFailed: 0,
                  resetsResumedFromBlock: 0,
                  activityScrollHeightChanges: 0,
                  activityVirtualizerOnChange: 0,
                  finalMessageCount: 0,
                  finalTerminalIndex: 0,
                }
              : undefined;

          // Cleanup registry. Populated as listeners are attached so that
          // `settle()` doesn't textually reference the handler variables
          // directly (they reference `settle`, creating a circular-def
          // no-use-before-define lint complaint). Each entry is idempotent.
          const cleanupFns: Array<() => void> = [];

          // Single `settle()` sink (v3 spec). All resolution paths route
          // through here. The `settled` flag is the idempotency guard:
          // wheel + abort race, or timeout + abort race, would otherwise
          // double-decrement the programmatic-scroll counter and silently
          // regress Invariant #6 for the NEXT primitive.
          const settle = (reason: ScrollSettleReason, landedAtBottom: boolean) => {
            if (settled) return;
            settled = true;
            if (diagnostics) {
              const now = performance.now();
              const flags = phantomFlagsRef.current;
              const terminalIndex = Math.max(
                visibleMessagesRef.current.length
                  + (flags.hasPhantomThinkingRow ? 1 : 0)
                  + (flags.hasFirstBigWinRow ? 1 : 0)
                  + (flags.hasCommunityShareRow ? 1 : 0)
                  + (flags.hasMcpBuildRow ? 1 : 0)
                  - 1,
                0,
              );
              diagnostics.primTotalMs = now - startedAt;
              diagnostics.finalHoldMs =
                holdStableSinceAt == null ? null : now - holdStableSinceAt;
              diagnostics.finalMessageCount = visibleMessagesRef.current.length;
              diagnostics.finalTerminalIndex = terminalIndex;
            }

            if (rafId != null) {
              cancelAnimationFrame(rafId);
              rafId = null;
            }

            // `{ once: true }` listeners auto-remove on fire; these
            // cleanup callbacks are idempotent no-ops when that has
            // already happened, and do real work when it hasn't.
            for (const fn of cleanupFns) {
              fn();
            }
            cleanupFns.length = 0;

            primitiveActivityListenerRef.current = null;

            // Counter decrement with underflow clamp + dev-warn (v3 spec).
            const next = programmaticScrollInFlightRef.current - 1;
            if (next < 0 && import.meta.env.DEV) {
              console.warn(
                '[scroll-settle] programmatic-scroll counter underflow in settle() — primitive begin/end pairing broken.',
              );
            }
            programmaticScrollInFlightRef.current = Math.max(0, next);

            resolve({ landedAtBottom, reason, diagnostics });
          };

          const onUserScroll = () => {
            settle('user-scrolled', false);
          };
          const onAbort = () => {
            settle('aborted', false);
          };

          // v3 Issue-3 / Behavioral Safety #3: attach user-scroll listeners
          // BEFORE scheduling the first rAF. Otherwise a wheel/touch that
          // arrives before the first frame is missed and we'd pin against
          // a user gesture.
          //
          // Listen set is `wheel` / `touchmove` / `pointerdown`. NOT
          // `keydown` — the scroll container has no tabIndex so keydown
          // never fires on it (the existing `scrollToBottom` chase also
          // doesn't listen for keydown; this is not a regression).
          container.addEventListener('wheel', onUserScroll, { passive: true, once: true });
          container.addEventListener('touchmove', onUserScroll, { passive: true, once: true });
          container.addEventListener('pointerdown', onUserScroll, { passive: true, once: true });
          cleanupFns.push(() => container.removeEventListener('wheel', onUserScroll));
          cleanupFns.push(() => container.removeEventListener('touchmove', onUserScroll));
          cleanupFns.push(() => container.removeEventListener('pointerdown', onUserScroll));

          if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
            cleanupFns.push(() => signal.removeEventListener('abort', onAbort));
          }

          // Register the activity listener for virtualizer `onChange`
          // pulses (measurement commits, range changes). Cleared in
          // `settle()`.
          primitiveActivityListenerRef.current = () => {
            lastActivityAt = performance.now();
            if (diagnostics) diagnostics.activityVirtualizerOnChange++;
          };

          const scrollToEnd = () => {
            if (settled) return;
            rafId = null;

            const c = scrollContainerRef.current;
            // New `unmounted` reason (v2 amendment): pane torn down
            // mid-primitive. Consumer's `.then()` handler treats this as
            // "no further state mutation is safe or useful".
            if (!c) {
              settle('unmounted', false);
              return;
            }

            // Defensive: if the caller aborted between frames, resolve
            // now rather than do one more pin.
            if (signal?.aborted) {
              settle('aborted', false);
              return;
            }

            const now = performance.now();
            const frameGap = now - previousRafAt;
            previousRafAt = now;
            if (diagnostics) {
              diagnostics.maxFrameGapMs = Math.max(diagnostics.maxFrameGapMs, frameGap);
              if (frameGap > SCROLL_SETTLE_GAP_THRESHOLD_MS) {
                diagnostics.framesOverGapThreshold++;
              }
            }

            // Wall-cap: `maxWallMs` from start. Before resolving, force
            // one last pin to the best-known bottom — on pathological
            // threads where convergence didn't finish in budget, the
            // user is strictly better off starting at (a best-effort)
            // bottom than stranded mid-thread. Any post-resolve
            // virtualizer correction will still happen, but the initial
            // visible position after the mask lifts is the bottom.
            if (now - startedAt >= maxWallMs) {
              const targetTop = c.scrollHeight - c.clientHeight;
              if (Math.abs(targetTop - c.scrollTop) > SCROLL_SETTLE_TOLERANCE_PX) {
                c.scrollTop = Math.max(0, targetTop);
              }
              const atBottom =
                Math.abs(targetTop - c.scrollTop) <= SCROLL_SETTLE_TOLERANCE_PX;
              if (import.meta.env.VITE_PERFORMANCE === 'true') {
                const flags = phantomFlagsRef.current;
                const terminalIndex = Math.max(
                  visibleMessagesRef.current.length
                    + (flags.hasPhantomThinkingRow ? 1 : 0)
                    + (flags.hasFirstBigWinRow ? 1 : 0)
                    + (flags.hasCommunityShareRow ? 1 : 0)
                    + (flags.hasMcpBuildRow ? 1 : 0)
                    - 1,
                  0,
                );
                const terminalRowRendered = virtualizer
                  .getVirtualItems()
                  .some((item) => item.index === terminalIndex);
                console.warn(
                  `[scroll-settle] primitive TIMEOUT: wallMs=${(now - startedAt).toFixed(0)} ` +
                  `scrollTop=${Math.round(c.scrollTop)} scrollHeight=${Math.round(c.scrollHeight)} ` +
                  `clientHeight=${Math.round(c.clientHeight)} geometryGap=${Math.round(Math.abs(targetTop - c.scrollTop))} ` +
                  `atBottom=${atBottom} terminalRowRendered=${terminalRowRendered} ` +
                  `messages=${visibleMessagesRef.current.length}`,
                );
              }
              settle('timeout', atBottom);
              return;
            }

            // First post-block rAF: frames don't fire during main-thread
            // long tasks, so `frameGap > GAP_THRESHOLD_MS` means we just
            // resumed. That frame's "quiet" observation is a lie —
            // activity likely happened during the block but we couldn't
            // observe it. Skip counting it as stable. This is the key
            // anti-false-positive mechanism (per the investigation doc).
            const resumedFromBlock = frameGap > SCROLL_SETTLE_GAP_THRESHOLD_MS;

            // scrollHeight diff acts as a secondary activity signal
            // (complements `onChange`). If the total size grew this
            // frame, something measured; refresh `lastActivityAt`.
            const scrollHeightDelta = Math.abs(c.scrollHeight - previousScrollHeight);
            const scrollHeightChanged = scrollHeightDelta > SCROLL_SETTLE_TOLERANCE_PX;
            if (scrollHeightChanged) {
              lastActivityAt = now;
              previousScrollHeight = c.scrollHeight;
              if (diagnostics) diagnostics.activityScrollHeightChanges++;
            }

            const targetTop = c.scrollHeight - c.clientHeight;
            const geometryGap = Math.abs(targetTop - c.scrollTop);

            // Not at bottom: pin and reset the stability counter. The
            // per-rAF pin is how we cooperate with TanStack Virtual's
            // `useFlushSync: false` corrections — corrections land
            // between rAFs and we re-pin next frame.
            if (geometryGap > SCROLL_SETTLE_TOLERANCE_PX) {
              c.scrollTop = targetTop;
              stableFrames = 0;
              holdStableSinceAt = null;
              if (diagnostics) diagnostics.resetsGeometryGap++;
              rafId = requestAnimationFrame(scrollToEnd);
              return;
            }

            // Geometry is at bottom. Evaluate the full stability gate.
            //
            // Tail-readiness gate:
            // We intentionally key this on "terminal row is currently mounted"
            // (virtualizer.getVirtualItems includes the current terminal index),
            // NOT on `measureCacheRef.has(lastMessageId)`.
            //
            // `measureCacheRef` is a post-paint estimate cache and can lag the
            // primitive by multiple frames. Using it as a correctness gate makes
            // settle latency depend on cache bookkeeping rather than actual tail
            // render state, which can force unnecessary 5s wall-cap timeouts on
            // repeated chat opens.
            //
            // Keep `measureCacheRef` for estimate quality; gate stability on direct
            // render evidence instead.
            const flags = phantomFlagsRef.current;
            const terminalIndex = Math.max(
              visibleMessagesRef.current.length
                + (flags.hasPhantomThinkingRow ? 1 : 0)
                + (flags.hasFirstBigWinRow ? 1 : 0)
                + (flags.hasCommunityShareRow ? 1 : 0)
                + (flags.hasMcpBuildRow ? 1 : 0)
                - 1,
              0,
            );
            const terminalRowRendered = virtualizer
              .getVirtualItems()
              .some((item) => item.index === terminalIndex);
            const quiescent = now - lastActivityAt >= SCROLL_SETTLE_QUIESCENCE_MS;
            if (diagnostics) {
              if (diagnostics.msToFirstAtBottomGeometry == null) {
                diagnostics.msToFirstAtBottomGeometry = now - startedAt;
              }
              if (terminalRowRendered && diagnostics.msToFirstTerminalRow == null) {
                diagnostics.msToFirstTerminalRow = now - startedAt;
              }
            }

            // Stage 1f (260521 switch-speed): direct evidence beats a broad
            // time-since-onChange gate. TanStack Virtual can emit `onChange`
            // pulses for range/measurement bookkeeping even when the DOM
            // geometry is already at bottom and `scrollHeight` did not change.
            // The previous `!quiescent` reset made those harmless pulses extend
            // a switch by hundreds of milliseconds. Still reset on real height
            // growth, missing terminal row, or long-task resume.
            const stableThisFrame =
              terminalRowRendered && !resumedFromBlock && !scrollHeightChanged;

            if (!stableThisFrame) {
              stableFrames = 0;
              holdStableSinceAt = null;
              if (diagnostics) {
                if (resumedFromBlock) diagnostics.resetsResumedFromBlock++;
                if (!quiescent || scrollHeightChanged) diagnostics.resetsQuiescenceFailed++;
                if (!terminalRowRendered) diagnostics.resetsTerminalRowMissing++;
              }
            } else {
              stableFrames += 1;
              if (diagnostics && diagnostics.msToFirstStableFrame == null) {
                diagnostics.msToFirstStableFrame = now - startedAt;
              }
            }

            if (stableFrames >= SCROLL_SETTLE_STABLE_FRAMES) {
              if (holdStableSinceAt == null) {
                holdStableSinceAt = now;
                if (diagnostics && diagnostics.msToHoldStart == null) {
                  diagnostics.msToHoldStart = now - startedAt;
                }
              } else if (now - holdStableSinceAt >= SCROLL_SETTLE_FINAL_HOLD_MS) {
                settle('stable', true);
                return;
              }
            }

            rafId = requestAnimationFrame(scrollToEnd);
          };

          rafId = requestAnimationFrame(scrollToEnd);
        });
      },
      getScrollElement: () => scrollContainerRef.current,
      getVisibleRange: () => {
        const items = virtualizer.getVirtualItems();
        if (items.length === 0) return null;
        return { startIndex: items[0].index, endIndex: items[items.length - 1].index };
      },
      isProgrammaticScrollInFlight: () => programmaticScrollInFlightRef.current > 0,
    }), [virtualizer, visibleMessages.length, virtualItemCount]);

    // ── Persistent bottom anchor ─────────────────────────────────────────
    //
    // Keeps the scroll container pinned to its true bottom any time the
    // virtualizer's total size changes, as long as the user hasn't
    // intentionally scrolled away. Replaces the bounded settle-and-give-up
    // heuristics that used to lose ground whenever late content arrived
    // or the virtualizer's size recomputed.
    //
    // ### Why it's tricky, and what this implementation guards against
    //
    // 1. **Mount-timing race.** The effect depends on `virtualListEl`, a
    //    state-backed callback ref (not a plain `useRef`). For long
    //    sessions the pane briefly renders without the virtual list
    //    (while `visibleMessages` is still empty during session load);
    //    a plain-ref effect keyed only on `currentSessionId` would run
    //    before the virtual list mounts and never re-run. State-backed
    //    ref causes the effect to re-run on attach.
    //
    // 2. **Programmatic scroll events can't disarm the anchor.** The
    //    virtualizer's internal sub-frame scroll corrections (enabled by
    //    `useFlushSync: false`) emit `scroll` events that are NOT bracketed
    //    by `programmaticScrollInFlightRef`. A previous version used the
    //    `scroll` event to flip `isAnchored=false` when distance exceeded
    //    150px; that silently disarmed us whenever a virtualizer correction
    //    transiently moved scrollTop away from the bottom. We now only
    //    flip `isAnchored=false` when we observe a user gesture event
    //    (wheel / touchmove / pointerdown / keydown) immediately before
    //    the scroll. Scroll events RE-ARM the anchor when the user returns
    //    near the bottom, but never disarm it.
    //
    // 3. **Observing both content and viewport.** The content
    //    (`virtualListEl`) grows with `getTotalSize()`. The viewport
    //    (`scrollEl`) changes on window/pane resize. Either can shift the
    //    bottom target; both are observed.
    //
    // Cooperates with `useConversationAutoScroll`'s sticky-latch logic
    // by (a) ignoring its own pins via `programmaticScrollInFlightRef`
    // and (b) treating a user gesture as the sole disarm signal, which
    // is the same signal the hook uses.
    useEffect(() => {
      const scrollEl = scrollContainerRef.current;
      if (!scrollEl || !virtualListEl) {
        return;
      }

      // Hysteresis: tight threshold for "still at bottom" so trivial
      // sub-pixel rounding / fractional reflow doesn't release the anchor;
      // looser threshold for "scrolled away" so a quick trackpad nudge
      // doesn't immediately disarm it.
      const AT_BOTTOM_THRESHOLD_PX = 32;
      const SCROLLED_AWAY_THRESHOLD_PX = 150;
      // How long a user-gesture event is considered "recent" for the
      // purposes of attributing a subsequent `scroll` event to the user.
      // Scroll events arrive shortly after wheel / touchmove / keydown.
      // 250ms covers the gap even on slow frames without letting stale
      // gestures influence later programmatic scrolls.
      const USER_GESTURE_WINDOW_MS = 250;

      // On session switch / mount we assume the user just landed at the
      // bottom (the primitive / fast-path just placed them there). Only
      // a real user gesture can disarm us; scroll events alone cannot.
      let isAnchored = true;
      let pinInFlight = false;
      let lastUserGestureAt = 0;
      let lastDriftLogAt = 0;
      let lastSkipReason: 'disarmed' | 'suspended' | 'programmatic' | null = null;
      let scheduledPinRafId: number | null = null;

      const logPinSkipReason = (reason: 'disarmed' | 'suspended' | 'programmatic') => {
        if (lastSkipReason === reason) return;
        lastSkipReason = reason;
      };

      const clearPinSkipReason = () => {
        lastSkipReason = null;
      };

      const schedulePinToBottom = () => {
        if (scheduledPinRafId != null) return;
        scheduledPinRafId = requestAnimationFrame(() => {
          scheduledPinRafId = null;
          pinToBottom();
        });
      };

      const markUserGesture = () => {
        lastUserGestureAt = performance.now();
      };

      const onScroll = () => {
        if (programmaticScrollInFlightRef.current > 0 || pinInFlight) return;
        const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
        const withinGestureWindow = performance.now() - lastUserGestureAt < USER_GESTURE_WINDOW_MS;

        if (
          !withinGestureWindow &&
          distance > SCROLLED_AWAY_THRESHOLD_PX &&
          performance.now() - lastDriftLogAt > 200
        ) {
          lastDriftLogAt = performance.now();
        }

        if (withinGestureWindow && distance > SCROLLED_AWAY_THRESHOLD_PX) {
          // User gesture produced this scroll, and it moved us away from
          // the bottom. Release the anchor so we don't fight their intent.
          isAnchored = false;
        } else if (distance <= AT_BOTTOM_THRESHOLD_PX) {
          // Scrolled back near the bottom — re-arm. This fires for both
          // user-initiated and programmatic scrolls; either way, once we
          // are actually near the bottom again, we can resume anchoring.
          isAnchored = true;
        }
        // Between the two thresholds (or a far-from-bottom scroll that
        // isn't within the user-gesture window): preserve current state.
      };

      const pinToBottom = () => {
        if (!isAnchored) {
          logPinSkipReason('disarmed');
          return;
        }
        if (suspendBottomAnchorRef.current) {
          logPinSkipReason('suspended');
          return;
        }
        if (programmaticScrollInFlightRef.current > 0) {
          logPinSkipReason('programmatic');
          return;
        }
        clearPinSkipReason();

        const target = scrollEl.scrollHeight - scrollEl.clientHeight;
        if (target < 0) return;
        const delta = Math.abs(scrollEl.scrollTop - target);
        if (delta < 1) return;

        // Mark our own scroll so `onScroll` below doesn't confuse it for
        // a programmatic-correction-then-scroll-event sequence.
        programmaticScrollInFlightRef.current += 1;
        pinInFlight = true;
        scrollEl.scrollTop = target;
        requestAnimationFrame(() => {
          const next = programmaticScrollInFlightRef.current - 1;
          if (next < 0 && import.meta.env.DEV) {
            console.warn(
              '[scroll-anchor] programmatic-scroll counter underflow after anchor pin',
            );
          }
          programmaticScrollInFlightRef.current = Math.max(0, next);
          pinInFlight = false;
        });
      };

      // TanStack Virtual can apply async scrollTop corrections without a paired
      // ResizeObserver pulse. The `71e263816`-wired path coalesced those pulses
      // onto the next frame to re-pin (`anchorActivityListenerRef = schedulePinToBottom`).
      //
      // 2026-04-27: Disabled by default after Stage -1 falsification (see
      // `docs/plans/260427_scrolling_stage0_and_paths.md` §Stage -1) found that
      // disabling this path did not visibly regress session-switch / long-thread
      // reopen for the test user, while the 2026-04-23 manual-scroll jumpiness
      // regression appeared adjacent to this commit. Shipping default-disabled
      // as a Stage -1 partial outcome; revisit per Stage 0 evidence if symptoms
      // recur.
      //
      // Kill-switch — if regressions are reported (e.g. late virtualizer
      // corrections cause drift on long-thread reopen, or session-switch lands
      // mid-thread), re-enable in DevTools with:
      //   localStorage.setItem('scrollDebug.enableAnchorOnChange', '1');
      //   location.reload();
      // and report the regression so the rethink can scope Path A/B properly.
      const enableAnchorOnChange =
        typeof window !== 'undefined' &&
        window.localStorage?.getItem('scrollDebug.enableAnchorOnChange') === '1';

      if (enableAnchorOnChange) {
        if (import.meta.env.DEV) {
          console.warn(
            '[scroll-anchor] anchorActivityListenerRef RE-ENABLED via scrollDebug.enableAnchorOnChange kill-switch. virtualizer.onChange WILL trigger anchor re-pin (legacy 71e263816 behavior).',
          );
        }
        anchorActivityListenerRef.current = schedulePinToBottom;
      }
      // Default: listener intentionally NOT assigned. virtualizer.onChange will
      // not trigger anchor re-pin. ResizeObservers on content + viewport remain
      // active and can still pin via `pinToBottom` when the anchor is armed.

      const contentObserver = new ResizeObserver(pinToBottom);
      contentObserver.observe(virtualListEl);

      // Observe the scroll container too — on window/pane resize the
      // visible area changes and the anchor's target value moves, even
      // though the content itself didn't grow.
      const viewportObserver = new ResizeObserver(pinToBottom);
      viewportObserver.observe(scrollEl);

      scrollEl.addEventListener('scroll', onScroll, { passive: true });
      // Attach user-gesture listeners to `window` (not just the scroll
      // container) so momentum/inertia scrolls initiated anywhere in the
      // app aren't missed. Passive keeps them non-blocking.
      scrollEl.addEventListener('wheel', markUserGesture, { passive: true });
      scrollEl.addEventListener('touchmove', markUserGesture, { passive: true });
      scrollEl.addEventListener('pointerdown', markUserGesture, { passive: true });
      scrollEl.addEventListener('keydown', markUserGesture);

      return () => {
        anchorActivityListenerRef.current = null;
        if (scheduledPinRafId != null) {
          cancelAnimationFrame(scheduledPinRafId);
          scheduledPinRafId = null;
        }
        contentObserver.disconnect();
        viewportObserver.disconnect();
        scrollEl.removeEventListener('scroll', onScroll);
        scrollEl.removeEventListener('wheel', markUserGesture);
        scrollEl.removeEventListener('touchmove', markUserGesture);
        scrollEl.removeEventListener('pointerdown', markUserGesture);
        scrollEl.removeEventListener('keydown', markUserGesture);
      };
    }, [currentSessionId, virtualListEl]);

    // Scroll-to-answer: when a question batch newly transitions unanswered →
    // answered, smooth-scroll the anchored answered card into view. Keeps the
    // asking-turn anchor intact. See
    // docs-private/investigations/260416_answered_question_card_not_visible.md.
    const scrollToIndexForAnswer = useCallback(
      (
        index: number,
        options: { align: 'start' | 'center' | 'end'; behavior: 'auto' | 'smooth' },
      ) => {
        if (!scrollContainerRef.current || index < 0 || index >= visibleMessages.length) {
          return;
        }
        virtualizer.scrollToIndex(index, options);
      },
      [virtualizer, visibleMessages.length],
    );
    useScrollToAnswer({
      questionBatches,
      questionCardByMessageIndex,
      currentSessionId,
      scrollToIndex: scrollToIndexForAnswer,
      onBeginProgrammaticScroll: handleBeginProgrammaticScroll,
      onEndProgrammaticScroll: handleEndProgrammaticScroll,
    });

    // Message entrance animation tracking
    // Track known message IDs to only animate genuinely new messages
    const knownMessageIdsRef = useRef<Set<string>>(new Set());
    // Track messages currently animating (keeps class applied for full animation duration)
    const animatingMessageIdsRef = useRef<Set<string>>(new Set());
    // Store timer IDs for cleanup
    const animationTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const prevSessionIdRef = useRef<string | null>(null);
    const prevIsSettlingRef = useRef<boolean>(isSettling);
    const settlingTurnEventsCloneCacheRef = useRef<Map<string, { cacheKey: string; events: AgentEvent[] }>>(new Map());

    // Synchronous state change detection during render
    const justSwitchedSession = currentSessionId !== prevSessionIdRef.current;
    const justFinishedSettling = prevIsSettlingRef.current && !isSettling;

    // Reset known messages when session changes or settling completes
    if (justSwitchedSession || justFinishedSettling) {
      knownMessageIdsRef.current = new Set(visibleMessages.map(m => m.id));
      // Clear animation state on session switch
      animatingMessageIdsRef.current.clear();
      animationTimersRef.current.forEach(timer => clearTimeout(timer));
      animationTimersRef.current.clear();
    }

    if (justSwitchedSession || !isSettling) {
      settlingTurnEventsCloneCacheRef.current.clear();
    }

    // NOTE: We intentionally DO NOT clear `measureCacheRef` on session switch.
    // Message IDs are globally unique UUIDs (no cross-session pollution is
    // possible), and keeping heights warm means switch-back to a long thread
    // has accurate estimates immediately — letting `scrollToBottom`'s chase
    // loop converge on the actual bottom instead of landing mid-scroll.
    // The cache is bounded via `setMeasureCacheEntry` (LRU cap above).
    // Previous clear (introduced in 9c2b98d75, v0.4.25) was an amplifier of
    // the "thread jumps to top on switch" bug. See
    // docs-private/investigations/260416_thread_scroll_jumps_to_top_on_switch.md.

    // Update refs for next render
    prevSessionIdRef.current = currentSessionId;
    prevIsSettlingRef.current = isSettling;

    // Cleanup animation timers on unmount
    useEffect(() => {
      const timers = animationTimersRef.current;
      return () => {
        timers.forEach(timer => clearTimeout(timer));
      };
    }, []);

    // Check if a message should show the entrance animation
    // Returns true if: starting new animation OR currently animating
    const getIsNewMessage = useCallback((messageId: string): boolean => {
      // Already animating - keep showing animation class
      if (animatingMessageIdsRef.current.has(messageId)) {
        return true;
      }
      // During settling or already known - no animation
      if (isSettling || knownMessageIdsRef.current.has(messageId)) {
        return false;
      }
      // Start new animation
      knownMessageIdsRef.current.add(messageId);
      animatingMessageIdsRef.current.add(messageId);
      // Clear animation flag after CSS animation completes (300ms + 50ms buffer)
      const timerId = setTimeout(() => {
        animatingMessageIdsRef.current.delete(messageId);
        animationTimersRef.current.delete(messageId);
      }, 350);
      animationTimersRef.current.set(messageId, timerId);
      return true;
    }, [isSettling]);

    // Turn completion spotlight tracking
    // Track which turn just completed for spotlight animation.
    // Uses processingTurnId (runtime) so clicking messages doesn't trigger spotlight. (FOX-2505)
    const [spotlightTurnId, setSpotlightTurnId] = useState<string | null>(null);
    const prevProcessingTurnIdRef = useRef<string | null>(null);
    const spotlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Detect when a turn completes (processingTurnId goes from a value to null while not stopping)
    useEffect(() => {
      const prevTurnId = prevProcessingTurnIdRef.current;
      prevProcessingTurnIdRef.current = processingTurnId;

      // Turn just completed: had a processingTurnId, now null, and not due to stopping
      if (prevTurnId && !processingTurnId && !isStopping) {
        setSpotlightTurnId(prevTurnId);
        // Clear spotlight after animation completes (800ms + buffer)
        if (spotlightTimerRef.current) {
          clearTimeout(spotlightTimerRef.current);
        }
        spotlightTimerRef.current = setTimeout(() => {
          setSpotlightTurnId(null);
          spotlightTimerRef.current = null;
        }, 900);
      }
    }, [processingTurnId, isStopping]);

    // Cleanup spotlight timer
    useEffect(() => {
      return () => {
        if (spotlightTimerRef.current) {
          clearTimeout(spotlightTimerRef.current);
        }
      };
    }, []);

    // Check for first big win when new time saved estimate arrives
    useIpcEvent(window.api.onTimeSavedStatus, (status) => {
      const activeSessionId = useSessionStore.getState().currentSessionId;
      if (!shouldHandleConversationPaneTimeSavedStatus(status, activeSessionId)) {
        return;
      }

      const checkFirstBigWin = async () => {
        if (firstBigWinCheckedRef.current) return;

        try {
          const shouldShow = await window.api.shouldShowFirstBigWin();
          if (shouldShow) {
            const todayMinutes = await window.api.getTodayMinutes();
            setFirstBigWinMinutes(todayMinutes);
            setShowFirstBigWin(true);
            firstBigWinCheckedRef.current = true;
          }
        } catch (error) {
          console.error('Failed to check first big win:', error);
        }
      };
      checkFirstBigWin();
    }, []);

    const handleDismissFirstBigWin = useCallback(async () => {
      setShowFirstBigWin(false);
      try {
        await window.api.markFirstBigWinShown();
      } catch (error) {
        console.error('Failed to mark first big win shown:', error);
      }
    }, []);

    // Build a map of message indices that have boundaries after them
    const boundaryByMessageIndex = useMemo(() => {
      const map = new Map<number, CompactionBoundaryType>();
      for (const boundary of compactionBoundaries) {
        map.set(boundary.afterMessageIndex, boundary);
      }
      return map;
    }, [compactionBoundaries]);

    // Conversation feedback: show inline within the final assistant message card.
    // We pick the last assistant/result message so we don't show feedback after a trailing user message.
    const lastAssistantMessageAnchor = useMemo(() => {
      for (let i = visibleMessages.length - 1; i >= 0; i--) {
        const m = visibleMessages[i];
        if (m?.role === 'assistant' || m?.role === 'result') {
          return {
            messageId: m.id,
            messageIndex: i,
            turnId: resolveTurnIdForMessage(m),
          };
        }
      }
      return null;
    }, [resolveTurnIdForMessage, visibleMessages]);
    const lastAssistantMessageId = lastAssistantMessageAnchor?.messageId ?? null;
    const lastAssistantMessageIndex = lastAssistantMessageAnchor?.messageIndex ?? null;
    const lastAssistantTurnId = lastAssistantMessageAnchor?.turnId ?? null;
    const retrySourceMessageIdByTurn = useMemo(() => {
      const map = new Map<string, string>();
      for (const candidate of visibleMessages) {
        if (candidate.role !== 'user') continue;
        const candidateTurnId = resolveTurnIdForMessage(candidate);
        if (!candidateTurnId || map.has(candidateTurnId)) continue;
        map.set(candidateTurnId, candidate.id);
      }
      return map;
    }, [resolveTurnIdForMessage, visibleMessages]);

    /**
     * Explicit copy handler for Cmd/Ctrl+C within the conversation pane.
     * 
     * Problem: Cmd+C can fail intermittently because:
     * 1. Message wrappers have tabIndex={0} for turn selection, which can steal focus
     * 2. CSS `contain: strict` on .sessionLog may interfere with selection propagation
     * 3. Virtualization can unmount selected DOM nodes when scrolling
     * 
     * Solution: Intercept the copy event and explicitly set clipboard data when there's
     * a valid text selection within the conversation. Uses synchronous clipboardData API
     * which is more reliable than async navigator.clipboard in Electron copy handlers.
     * 
     * Note: TextSelectionMenu.tsx uses async navigator.clipboard.writeText for its copy
     * action since it's not within a copy event handler.
     * 
     * @see TextSelectionMenu.tsx for the right-click copy implementation
     */
    const handleCopy = useCallback((e: React.ClipboardEvent) => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      
      const text = selection.toString();
      if (!text) return;
      
      const container = scrollContainerRef.current;
      if (!container) return;
      
      // Determine if the selection is related to this container.
      // We check both endpoints of the selection (anchorNode and focusNode) as well as
      // the range containers to handle all cases including virtualization where nodes
      // may be detached but the selection still originated from conversation content.
      const range = selection.getRangeAt(0);
      const anchorNode = selection.anchorNode;
      const focusNode = selection.focusNode;
      const startContainer = range.startContainer;
      const endContainer = range.endContainer;
      
      // Check if any selection node is within this container
      const anchorInContainer = anchorNode && container.contains(anchorNode);
      const focusInContainer = focusNode && container.contains(focusNode);
      const startInContainer = container.contains(startContainer);
      const endInContainer = container.contains(endContainer);
      
      // Accept if at least one endpoint is in the container
      // This handles partial selections and virtualization edge cases
      const selectionInContainer = anchorInContainer || focusInContainer || startInContainer || endInContainer;
      
      if (!selectionInContainer) return;
      
      e.preventDefault();
      e.clipboardData.setData('text/plain', text);
    }, []);

    if (visibleMessages.length === 0 && !isBusy && !isRevealMasked) {
      return (
        <div className={styles.sessionLog} ref={scrollContainerRef} onCopy={handleCopy}>
          <EmptyConversationState
            key={currentSessionId}
            isTextMode={isTextMode}
            onSubmitPrompt={onSubmitPrompt ?? noopSubmitPrompt}
            currentSessionId={currentSessionId}
            onTryChangelog={onTryChangelog}
          />
        </div>
      );
    }

    const virtualItems = virtualizer.getVirtualItems();

    return (
      <div
        className={cn(
          styles.sessionLogShell,
          isRevealMasked && styles.sessionLogShellSettling,
        )}
      >
        {isRevealMasked && (
          <div className={styles.settlingSkeletonOverlay} aria-hidden="true">
            <div className={styles.settlingSkeletonList}>
              {SETTLING_SKELETON_ROWS.map((row, index) => (
                <div
                  key={`${row.alignment}-${index}`}
                  className={cn(
                    styles.settlingSkeletonRow,
                    row.alignment === 'user'
                      ? styles.settlingSkeletonRowUser
                      : styles.settlingSkeletonRowAssistant,
                  )}
                >
                  <div
                    className={cn(
                      styles.settlingSkeletonBubble,
                      row.alignment === 'user'
                        ? styles.settlingSkeletonBubbleUser
                        : styles.settlingSkeletonBubbleAssistant,
                    )}
                    style={{ width: row.width, minHeight: row.minHeight }}
                  >
                    <div className={styles.settlingSkeletonBubbleContent}>
                      {row.lines.map((lineWidth, lineIndex) => (
                        <div
                          key={`${index}-${lineIndex}`}
                          className={styles.settlingSkeletonLine}
                          style={{ width: lineWidth }}
                        />
                      ))}
                      {row.chipWidths?.length ? (
                        <div className={styles.settlingSkeletonChipRow}>
                          {row.chipWidths.map((chipWidth, chipIndex) => (
                            <div
                              key={`${index}-chip-${chipIndex}`}
                              className={styles.settlingSkeletonChip}
                              style={{ width: chipWidth }}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div
          className={cn(
            styles.sessionLog,
            isRevealMasked && styles.settling,
            isWideMode && styles.wideMode,
            isDocumentPreviewOpen && styles.documentPreviewMode,
          )}
          ref={scrollContainerRef}
          onCopy={handleCopy}
        >
        {/* Onboarding coach intro - shown at the start of onboarding coach conversation */}
        {isOnboardingCoachActive && !isOnboardingIntroDismissed && (
          <OnboardingCoachIntro
            onDismiss={() => setIsOnboardingIntroDismissed(true)}
            showDismiss={true}
          />
        )}
        {/* Focus context card - shown at the top of focus-origin conversations */}
        <FocusContextCard />
        {/* Virtualized message list container */}
        <div
          ref={setVirtualListEl}
          className={styles.virtualListContainer}
          style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
        >
          {virtualItems.map((virtualRow) => {
            const isPhantomRow = virtualRow.index >= visibleMessages.length;
            
            // Phantom rows: thinking indicator, FirstBigWin card, or CommunityWinCard.
            // All rendered inside the virtualizer to prevent overlap bugs caused by
            // stale getTotalSize() when message heights change asynchronously.
            if (isPhantomRow) {
              let phantomSlot = 0;
              const phantomOffset = virtualRow.index - visibleMessages.length;

              const isThinkingRow = hasPhantomThinkingRow && phantomOffset === phantomSlot;
              if (hasPhantomThinkingRow) phantomSlot++;
              const isFirstBigWinRow = hasFirstBigWinRow && phantomOffset === phantomSlot;
              if (hasFirstBigWinRow) phantomSlot++;
              const isCommunityShareRow = hasCommunityShareRow && phantomOffset === phantomSlot;
              if (hasCommunityShareRow) phantomSlot++;
              const isMcpBuildRow = hasMcpBuildRow && phantomOffset === phantomSlot;

              // Thinking row — uses processingTurnId (runtime state) for step data lookup. (FOX-2505)
              if (isThinkingRow) {
                const thinkingTurnSteps = processingTurnId ? turnStepContextByTurn[processingTurnId] : undefined;
                const thinkingSubAgentTimeline = processingTurnId ? subAgentTimelineByTurn.get(processingTurnId) : undefined;

                // Compute display props for the thinking row.
                // We use the full snapshot (not the filtered active-mode list) so
                // completed tasks remain visible with checkmarks and the progress
                // count matches the visible list.
                const thinkingDelta = thinkingTurnSteps?.turnTaskDelta ?? null;
                const thinkingDisplayProps = computeTaskDisplayProps(
                  thinkingDelta,
                  thinkingTurnSteps?.missionContext ?? null,
                  true,
                );
                const thinkingFullSnapshot = thinkingDelta?.snapshot ?? thinkingDisplayProps?.displayTasks;

                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className={styles.virtualItem}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {showStartingIndicator && (
                      <article
                        className={cn(
                          "agent-turn-message",
                          styles.message,
                          styles.assistant,
                          styles.thinkingPlaceholder,
                        )}
                        data-selectable-content="copy,reply"
                      >
                        <header className={styles.header}>
                          <span className={styles.label}>Rebel</span>
                        </header>
                        <div className={styles.body}>
                          <p className={styles.thinkingPlaceholderText}>
                            <span className={styles.thinkingIcon} />
                            <span className={styles.thinkingLabel}>On it...</span>
                          </p>
                        </div>
                      </article>
                    )}
                    {showStandaloneThinking && processingTurnId && (
                      <article
                        className={cn(
                          "agent-turn-message",
                          styles.message,
                          styles.assistant,
                          styles.thinkingPlaceholder,
                        )}
                        data-selectable-content="copy,reply"
                      >
                        <header className={styles.header}>
                          <span className={styles.label}>Rebel</span>
                        </header>
                        <div className={styles.body}>
                          <ContextualProgressCard
                            missionContext={thinkingDisplayProps?.displayMission ?? thinkingTurnSteps?.missionContext}
                            taskProgress={thinkingFullSnapshot}
                            snapshotCounts={thinkingDisplayProps?.snapshotCounts}
                            steps={thinkingTurnSteps?.assistantSteps ?? []}
                            fileOperationsByStep={thinkingTurnSteps?.fileOperationsByStep ?? new Map()}
                            toolSummariesByStep={thinkingTurnSteps?.toolSummariesByStep ?? new Map()}
                            modelByStep={thinkingTurnSteps?.modelByStep ?? new Map()}
                            modelByTaskId={thinkingTurnSteps?.modelByTaskId}
                            selectedStepNumber={activeStepByTurn[processingTurnId] ?? null}
                            subAgentTimeline={thinkingSubAgentTimeline ?? null}
                            isThinking={true}
                            isBusy={true}
                            isPaused={isPausedForApproval}
                            sessionId={currentSessionId}
                            thinkingHeadline={thinkingHeadline}
                            thinkingElapsedLabel={thinkingElapsedLabel}
                            mcpBuildActivity={mcpBuildActivity}
                            turnEvents={eventsByTurn[processingTurnId] ?? []}
                            isStopping={isStopping}
                            onOpenConversation={onOpenConversation}
                            onSelectStep={(stepNumber) => onSelectInlineStep(processingTurnId, stepNumber)}
                            onTryChangelog={onTryChangelog}
                          />
                        </div>
                      </article>
                    )}
                  </div>
                );
              }

              // First Big Win celebration card
              if (isFirstBigWinRow) {
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className={styles.virtualItem}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <FirstBigWinCard
                      todayMinutes={firstBigWinMinutes}
                      onDismiss={handleDismissFirstBigWin}
                    />
                  </div>
                );
              }

              // Community share celebration card
              if (
                isCommunityShareRow &&
                communityShareEligibility &&
                onSharePreview &&
                onShareOpen &&
                onShareDismiss &&
                onShareOptOut
              ) {
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className={styles.virtualItem}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div className={styles.communityShareContainer}>
                      <CommunityWinCard
                        eligibility={communityShareEligibility}
                        onPreviewAndShare={onSharePreview}
                        onOpenDiscourse={onShareOpen}
                        onDismiss={onShareDismiss}
                        onOptOut={onShareOptOut}
                      />
                    </div>
                  </div>
                );
              }

              if (isMcpBuildRow && mcpBuildCardState) {
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className={styles.virtualItem}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div className={styles.mcpBuildCardContainer}>
                      {/*
                        Keyed on sessionId so a session switch cleanly
                        unmounts + remounts the card. Prevents the Stage 5a
                        5-second visibility timer (and any other instance
                        state) from leaking across sessions when two
                        sessions happen to build the same connector name.
                        Per Gemini reviewer MEDIUM finding.
                      */}
                      <MCPBuildCard
                        key={currentSessionId}
                        state={mcpBuildCardState}
                        isOssBuild={isOssBuild}
                        onRunTest={onMcpBuildCardActions?.onRunTest}
                        onReRunTest={onMcpBuildCardActions?.onReRunTest}
                        onSubmitToCommunity={onMcpBuildCardActions?.onSubmitToCommunity}
                        // Stage 1.1 C4 (260420 OSS MCP backend relay): forward all
                        // three attribution options to the inline github-check card,
                        // not just GitHub. Previously this card left Rebel-name and
                        // Anonymous disabled, so users scrolled up into the transcript
                        // and could only pick GitHub — silently diverging from the
                        // footer card's 3-way picker.
                        onUseRebelName={onMcpBuildCardActions?.onUseRebelName}
                        onAnonymous={onMcpBuildCardActions?.onAnonymous}
                        onGitHubYes={onMcpBuildCardActions?.onGitHubYes}
                        onMakeChanges={onMcpBuildCardActions?.onMakeChanges}
                        onRefreshStatus={onMcpBuildCardActions?.onRefreshStatus}
                        isRefreshing={onMcpBuildCardActions?.isRefreshing}
                        onViewOnGitHub={onMcpBuildCardActions?.onViewOnGitHub}
                        onViewInSettings={onMcpBuildCardActions?.onViewInSettings}
                      />
                    </div>
                  </div>
                );
              }

              return null;
            }
            
            // Regular message row
            const message = visibleMessages[virtualRow.index];
            const messageIndex = virtualRow.index;
            // Only pass thinking status props to the processing turn's message to avoid
            // re-rendering ALL messages when the elapsed timer updates every second.
            // Uses processingTurnId so clicking other messages doesn't move the thinking UI. (FOX-2505)
            const isActiveTurnMessage = Boolean(processingTurnId && message.turnId === processingTurnId);
            // Pre-compute per-message slices to enable React.memo on MessageItem
            // This prevents ALL messages from re-rendering when any event arrives.
            //
            // NOTE: the `[...rawEvents]` spread is intentional and load-bearing.
            // sessionStore mutates event arrays in place (`existing.push(event)`
            // for O(1) appends — see `appendEventToCurrentSession` in sessionStore.ts).
            // That means `eventsByTurn[turnId]` returns the SAME array reference
            // even after new events are appended, which would break downstream
            // `useMemo([turnEvents])` consumers (e.g. MessageItem's `usageData`).
            // Cloning here gives those memos a fresh reference per render, which
            // is correct given the in-place mutation invariant. The "remount
            // amplifier" concern (REBEL-4ZV / FOX-3174) is already handled at
            // the source by stable `markdownComponents` in MessageMarkdown.
            const resolvedTurnId = resolveTurnIdForMessage(message);
            const rawEvents = resolvedTurnId ? (eventsByTurn[resolvedTurnId] ?? EMPTY_EVENTS) : EMPTY_EVENTS;
            let turnEvents: AgentEvent[];
            if (!isSettling || rawEvents === EMPTY_EVENTS || !resolvedTurnId) {
              turnEvents = rawEvents === EMPTY_EVENTS ? EMPTY_EVENTS : [...rawEvents];
            } else {
              const cacheKey = buildSettlingTurnEventsCacheKey(rawEvents);
              const cached = settlingTurnEventsCloneCacheRef.current.get(resolvedTurnId);
              if (cached?.cacheKey === cacheKey) {
                turnEvents = cached.events;
              } else {
                turnEvents = [...rawEvents];
                settlingTurnEventsCloneCacheRef.current.set(resolvedTurnId, { cacheKey, events: turnEvents });
              }
            }
            const turnStepContext = resolvedTurnId ? turnStepContextByTurn[resolvedTurnId] : undefined;
            const subAgentTimeline = resolvedTurnId ? subAgentTimelineByTurn.get(resolvedTurnId) : undefined;
            const retrySourceMessageId = resolvedTurnId
              ? retrySourceMessageIdByTurn.get(resolvedTurnId)
              : undefined;
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className={styles.virtualItem}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <MessageItem
                  message={message}
                  isNewMessage={getIsNewMessage(message.id)}
                  isSpotlighted={Boolean(spotlightTurnId && message.turnId === spotlightTurnId && message.role !== 'user')}
                  boundaryAfterThis={boundaryByMessageIndex.get(messageIndex)}
                  messageCount={visibleMessages.length}
                  sessionIdForFeedback={currentSessionId}
                  showConversationFeedback={Boolean(
                    lastAssistantMessageId &&
                      message.id === lastAssistantMessageId &&
                      !isBusy &&
                      !isOnboardingCoachActive
                  )}
                  conversationFeedbackAnchor={
                    lastAssistantMessageId &&
                    lastAssistantMessageIndex !== null &&
                    message.id === lastAssistantMessageId
                      ? {
                          anchorMessageId: message.id,
                          anchorTurnId: lastAssistantTurnId ?? resolvedTurnId,
                          anchorMessageIndex: lastAssistantMessageIndex,
                        }
                      : undefined
                  }
                  resolvedTurnId={resolvedTurnId}
                  turnEvents={turnEvents}
                  turnStepContext={turnStepContext}
                  subAgentTimeline={subAgentTimeline}
                  activeStepByTurn={activeStepByTurn}
                  memoryStatusByTurn={memoryStatusByTurn}
                  timeSavedStatusByTurn={timeSavedStatusByTurn}
                  activitySummaryByTurn={activitySummaryByTurn}
                  visibleTurnId={visibleTurnId}
                  focusedTurnId={focusedTurnId}
                  processingTurnId={processingTurnId}
                  editingMessageId={editingMessageId}
                  isBusy={isBusy}
                  isPausedForApproval={isPausedForApproval}
                  isStopping={isStopping}
                  thinkingHeadline={isActiveTurnMessage ? thinkingHeadline : undefined}
                  thinkingElapsedLabel={isActiveTurnMessage ? thinkingElapsedLabel : undefined}
                  mcpBuildActivity={isActiveTurnMessage ? mcpBuildActivity : undefined}
                  onFocusTurn={onFocusTurn}
                  onBeginEditMessage={onBeginEditMessage}
                  onRetryMessage={onRetryMessage}
                  onSelectInlineStep={onSelectInlineStep}
                  onOpenFile={onOpenFile}
                  onOpenFolder={onOpenFolder}
                  onOpenConversation={onOpenConversation}
                  onNavigate={onNavigate}
                  onOpenTutorial={onOpenTutorial}
                  onCopyToClipboard={onCopyToClipboard}
                  showToast={showToast}
                  coreDirectory={coreDirectory}
                  onOpenInLibrary={onOpenInLibrary}
                  onContinueIncomplete={messageIndex === visibleMessages.length - 1 ? onContinueIncomplete : undefined}
                  retrySourceMessageId={retrySourceMessageId}
                  onStopActiveTurn={isActiveTurnMessage ? onStopActiveTurn : undefined}
                />
                {(() => {
                  const authRequiredCards = authRequiredCardByMessageIndex.get(messageIndex);
                  if (!authRequiredCards || authRequiredCards.length === 0) return null;
                  return (
                    <div className={styles.mcpBuildCardContainer}>
                      {authRequiredCards.map((authRequiredCard) => (
                        <MCPAuthRequiredCard
                          key={authRequiredCard.signal.packageId}
                          card={authRequiredCard}
                          onReconnect={onStartAuthReconnect}
                          onCancel={onCancelAuthReconnect}
                        />
                      ))}
                    </div>
                  );
                })()}
                {/* Inline question card — answered/skipped only (pending renders in footer) */}
                {(() => {
                  const qbs = questionCardByMessageIndex.get(messageIndex);
                  if (!qbs || qbs.length === 0) return null;
                  const inlineBatches = qbs.filter(shouldRenderInlineQuestionBatch);
                  if (inlineBatches.length === 0) return null;
                  const noopAsync = async () => {};
                  return (
                    <div
                      className={styles.answeredQuestionCardContainer}
                      data-testid="answered-question-card-container"
                    >
                      {inlineBatches.map((questionBatch) => (
                        <UserQuestionCard
                          key={questionBatch.batch.batchId}
                          batch={questionBatch.batch}
                          isAnswered={questionBatch.isAnswered}
                          answers={questionBatch.answers}
                          skipped={questionBatch.skipped}
                          onSubmit={noopAsync}
                          onDismiss={() => {}}
                          onUndoDismiss={() => {}}
                          isSubmitting={false}
                        />
                      ))}
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
          {/* FirstBigWinCard and CommunityWinCard are now rendered as phantom rows
              inside the virtualizer above to prevent overlap with messages. */}
        </div>
      </div>
    );
  },
);

ConversationPaneComponent.displayName = "ConversationPane";

export const ConversationPane = memo(ConversationPaneComponent);

// Re-export for existing test imports — the canonical home is `useScrollToAnswer.ts`.
// See docs-private/investigations/260416_answered_question_card_not_visible.md.
export { computeScrollToAnswerIndex };
