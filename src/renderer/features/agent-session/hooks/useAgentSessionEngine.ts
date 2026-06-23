/**
 * Session-turn orchestration hook that keeps event sequencing and runtime
 * transitions consistent across streaming, recovery, and persistence paths.
 *
 * @see ../../../../../docs/project/UI_CONVERSATIONS.md — turn/timeline semantics
 * @see ../../../../../docs/project/ARCHITECTURE_AGENT_TURN_EXECUTION.md — upstream turn lifecycle
 * @see ../store/sessionStore.ts — shared conversation state contract
 */
import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTimeoutRef } from '@renderer/hooks/useTimeoutRef';
import { useIntervalRef } from '@renderer/hooks/useIntervalRef';
import type {
  AgentAttachmentMeta,
  AnyAttachmentPayload,
  AgentEvent,
  AgentSession,
  AgentSessionSummary,
  AgentTurnRequest,
  AgentTurnMessage,
  RendererSessionType
} from '@shared/types';
import type { EmitLogFn, RecordBreadcrumbFn } from '@renderer/contexts';
import {
  isTextAttachment,
  isImageAttachment,
  isDocumentAttachment,
  isExtractedPdfAttachment,
  isOfficeDocumentAttachment,
  isTextFileAttachment,
  isBinaryFileAttachment,
} from '@shared/types';
import { TURN_ID_FALLBACK } from '@renderer/constants';
import { truncateForLog } from '@renderer/utils/formatters';

import { captureRendererException } from '@renderer/src/sentry';
import { deriveInteractionTimestamp } from '@shared/utils/conversationState';
import { attachRequeueMessageId, isTargetBusyRejection } from '@shared/utils/agentTurnAdmission';
import { createId } from '@shared/utils/id';
import { COUNCIL_REVIEW_PROMPT, isSessionActive, isSessionDone } from '@rebel/shared';
import { sanitizeEventForRenderer } from '@shared/utils/eventSanitization';
import { createSessionTitle } from '../utils/sessionTitle';
import { buildSessionModelOverrides } from '../utils/sessionOverrides';
import { primeRuntimeForTurn, createRuntimeState, isTurnStale, type SessionRuntimeState } from '../utils/runtimeState';
import type { AgentSessionWithRuntime } from '../types';
import {
  useSessionStore,
  persistenceManager,
  analyticsTracker,
  toastNotifications,
  buildRuntimeFromSnapshot
} from '../store';
import {
  type BufferedEvent,
  appendRendererLocalTerminalEvent,
  appendRendererOptimisticTurnStartedEvent,
  getCurrentSessionProjectedLiveness,
  takeBackgroundEventBuffer,
  applyBufferedEventUnionToSession,
  persistBufferedEventUnionForSession,
  getCurrentSessionEvents,
  getCurrentSessionEventsForTurn,
  getCurrentSessionEventsVersion,
  isCurrentSessionProjectionBusy,
  removeAllRendererOptimisticTurnStartedEvents,
  removeRendererOptimisticTurnStartedEvent,
  subscribeToCurrentSessionEventsVersion,
  flushPendingEventsVersionNotification,
  setCurrentSessionEvents,
  clearCurrentSessionEvents,
  normalizeCurrentSessionOrigin,
  isRendererOptimisticTurnStartedEvent,
  stripRuntime,
} from '../store/sessionStore';
import { beginValidatedSessionWrite } from '@shared/utils/eventSessionValidation';
import { useFolderStore } from '../store/folderStore';
import {
  extractPairSessionIdFromToolDetail,
  toolDetailHasPairedClients,
  toolDetailHasPairedEvent,
} from './toolDetailParsing';
import { useRecoveryAdapter } from './useRecoveryAdapter';
import {
  parseRoleNotConfiguredStatusMessage,
  roleLabel,
} from '@core/rebelCore/modelRoleResolver';
import { markEngineOpenDone } from '../dev/switchTimingProbe';

type PendingOptimisticTurnStart = {
  clientTurnId: string;
  sessionId: string;
  sentAt: number;
};

type AgentTurnStartRequest = Omit<AgentTurnRequest, 'clientTurnId'>;

type OptimisticTurnLifecycleManager = {
  getActiveSessionId: () => string | null;
  pushOptimisticStartForSession: (targetSessionId: string, activeSessionId: string) => string | null;
  bindOptimisticStartToRealTurn: (realTurnId: string, optimisticTurnId: string | null) => void;
  clearOptimisticStartById: (optimisticTurnId: string | null) => void;
};

type SharedOptimisticTurnStartArgs = {
  turnRequest: AgentTurnStartRequest;
  targetSessionId: string;
  activeSessionId: string;
  lifecycleManager: OptimisticTurnLifecycleManager;
};

export type SystemContinuationTurnStartRequest = {
  sessionId: string;
  prompt: string;
  attachments?: AnyAttachmentPayload[];
  continuationContext?: AgentTurnRequest['continuationContext'];
};

let systemContinuationOptimisticLifecycleManager: OptimisticTurnLifecycleManager | null = null;

const startTurnWithOptimisticLifecycleShared = async (
  args: SharedOptimisticTurnStartArgs,
): Promise<{ turnId: string; optimisticTurnId: string | null }> => {
  const {
    turnRequest,
    targetSessionId,
    activeSessionId,
    lifecycleManager,
  } = args;
  const optimisticTurnId = lifecycleManager.pushOptimisticStartForSession(
    targetSessionId,
    activeSessionId,
  );
  try {
    const { turnId } = await window.agentApi.turn({
      ...turnRequest,
      ...(optimisticTurnId ? { clientTurnId: optimisticTurnId } : {}),
    });
    lifecycleManager.bindOptimisticStartToRealTurn(turnId, optimisticTurnId);
    return { turnId, optimisticTurnId };
  } catch (error) {
    lifecycleManager.clearOptimisticStartById(optimisticTurnId);
    throw error;
  }
};

export const registerSystemContinuationOptimisticLifecycleManager = (
  lifecycleManager: OptimisticTurnLifecycleManager | null,
): void => {
  systemContinuationOptimisticLifecycleManager = lifecycleManager;
};

export const startSystemContinuationTurnWithOptimisticLifecycle = async (
  request: SystemContinuationTurnStartRequest,
): Promise<void> => {
  const lifecycleManager = systemContinuationOptimisticLifecycleManager;
  if (!lifecycleManager) {
    throw new Error('[useAgentSessionEngine] System continuation starter not registered');
  }
  await startTurnWithOptimisticLifecycleShared({
    turnRequest: {
      sessionId: request.sessionId,
      prompt: request.prompt,
      attachments: request.attachments && request.attachments.length > 0 ? request.attachments : undefined,
      isSystemContinuation: true,
      ...(request.continuationContext ? { continuationContext: request.continuationContext } : {}),
    },
    targetSessionId: request.sessionId,
    activeSessionId: lifecycleManager.getActiveSessionId() ?? request.sessionId,
    lifecycleManager,
  });
};

/**
 * Check whether a new summary differs from the existing one in fields that
 * affect sidebar display. Draft-related fields (hasDraft, draftPreview,
 * draftUpdatedAt, updatedAt) are intentionally excluded because
 * setDraftForSession already handles draft presence flips in sessionSummaries.
 */
const hasMeaningfulSummaryChange = (
  existing: AgentSessionSummary | undefined,
  next: AgentSessionSummary
): boolean => {
  if (!existing) return true;
  return (
    existing.title !== next.title
    || existing.messageCount !== next.messageCount
    || existing.isBusy !== next.isBusy
    || existing.activeTurnId !== next.activeTurnId
    || existing.lastError !== next.lastError
    || existing.resolvedAt !== next.resolvedAt
    || existing.doneAt !== next.doneAt
    || existing.starredAt !== next.starredAt
    || existing.deletedAt !== next.deletedAt
    || existing.preview !== next.preview
    || existing.origin !== next.origin
    || existing.isCorrupted !== next.isCorrupted
    || existing.interruptedTurnId !== next.interruptedTurnId
    || existing.meetingCompanion?.meetingUrl !== next.meetingCompanion?.meetingUrl
  );
};

/**
 * Layer B ratchet for sidebar sort key (260427_sidebar_concurrent_swap_groundup_fix.md):
 * never let `summary.updatedAt` regress below the existing summary's value.
 *
 * `summary.updatedAt` is derived from the (text-aggregated) last message createdAt,
 * which can lag behind values bumped by cloud-sync's wholesale `setSessionSummaries`
 * replace or `processHistoryEvent`'s `Date.now()` throttled writes. Without this guard
 * the focused session's `updatedAt` seesaws against cloud-sync bumps, swapping sidebar
 * positions at ~3 Hz when two conversations stream concurrently and one is focused.
 *
 * Mirrors the proven Apr 24 fix at `addOrUpdateHistorySession.replace`.
 */
export const ratchetSummaryUpdatedAt = (
  next: AgentSessionSummary,
  existing: AgentSessionSummary | undefined,
): AgentSessionSummary => {
  const ratchetedUpdatedAt = Math.max(next.updatedAt, existing?.updatedAt ?? 0);
  return ratchetedUpdatedAt !== next.updatedAt
    ? { ...next, updatedAt: ratchetedUpdatedAt }
    : next;
};

export const applySessionSwitchBufferedUnion = (
  session: AgentSessionWithRuntime,
  bufferedEvents: BufferedEvent[],
): AgentSessionWithRuntime =>
  applyBufferedEventUnionToSession(session, bufferedEvents);

export const persistSessionSwitchBufferedUnion = (
  sessionId: string,
  bufferedEvents: BufferedEvent[],
): void => {
  persistBufferedEventUnionForSession(sessionId, bufferedEvents);
};

/**
 * Stage 19a refinement (Fix 1): a queued live event plus the envelope
 * `eventSessionId` provenance captured at enqueue. Storing the provenance
 * ALONGSIDE the event lets the pending-queue flush validate the event against
 * its TRUE origin (same as the immediate path) instead of falling back to
 * `event.sessionId` / `accepted-legacy`.
 */
export interface PendingAgentEvent {
  event: AgentEvent;
  eventSessionId?: string;
}

/**
 * Flush a turn's queued events through the dispatcher, THREADING the envelope
 * provenance captured at enqueue. Extracted as a pure function so the
 * provenance-threading contract is directly testable (and RED-without-fix):
 * if the captured `eventSessionId` is dropped here, an envelope-only-foreign
 * queued event would no longer be validated against its true origin on flush.
 *
 * `dispatch` is the engine's `processAgentEvent(turnId, sessionId, event,
 * eventSessionId?)`. Ordering is preserved (FIFO over `pending`).
 */
export const dispatchPendingEventsForTurn = (
  turnId: string,
  sessionId: string,
  pending: PendingAgentEvent[],
  dispatch: (
    turnId: string,
    sessionId: string,
    event: AgentEvent,
    eventSessionId?: string,
  ) => void,
): void => {
  for (const { event, eventSessionId } of pending) {
    dispatch(turnId, sessionId, event, eventSessionId);
  }
};

/**
 * Module-level flag to prevent the load effect from re-running on component remount.
 * This survives React component remounts (dev HMR, component tree changes) but resets
 * on full page reload - which is correct behavior since a fresh JS context should load
 * from disk. See docs/plans/finished/251211_session_persistence_fixes.md Stage 1.
 */
let sessionsLoadedInContext = false;

/**
 * Module-level flag to track when session loading has COMPLETED (not just started).
 * CRITICAL: The persistence subscription must not save until this is true, otherwise
 * it can save an empty agentSessions array before load completes, causing main process
 * to delete all existing sessions. See incident 2026-01-11 where 452 sessions were lost.
 */
let sessionsLoadCompleteInContext = false;

/**
 * Module-level flag to track when cache warming has been triggered.
 * Prevents re-warming on HMR/remount. Warming should only happen once per cold start.
 */
let cacheWarmedInContext = false;

/** Number of pinned sessions to prioritize during startup cache warming. */
const CACHE_WARM_PINNED_COUNT = 5;
/** Number of recently updated sessions to include so first open is less often cold. */
const CACHE_WARM_RECENT_COUNT = 5;
/** Keep below the loaded-session LRU cap (10) so warming cannot crowd out active work. */
const CACHE_WARM_MAX_CANDIDATES = 8;

/**
 * Monotonic counter for lazy session loading requests.
 * Used to handle race conditions when user rapidly switches between sessions.
 * Each load request gets a unique ID; if a newer request comes in while one is pending,
 * the older request's result is ignored.
 * Bumped in two places inside openHistorySession: at miss-path entry (request id
 * capture) and immediately before the shared store apply — applies supersede all
 * in-flight loads; failed opens do NOT (see the apply-site comment).
 */
let sessionLoadRequestCounter = 0;

/**
 * Builds a conversation context preamble for edit message rerun.
 * When editing a message, we reset the agent session but need to provide
 * prior conversation context so Claude understands the history.
 */
const buildConversationContextForEdit = (
  messages: AgentTurnMessage[],
  upToIndex: number
): string => {
  if (upToIndex <= 0) return '';

  const contextMessages = messages.slice(0, upToIndex);
  if (contextMessages.length === 0) return '';

  const lines: string[] = ['[Previous conversation:]'];

  for (const msg of contextMessages) {
    const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${roleLabel}: ${msg.text}`);
  }

  lines.push('[End of previous conversation]');
  lines.push('');

  return lines.join('\n');
};

/** Strip large data fields from attachment payloads for session metadata storage */
const stripAttachmentData = (attachment: AnyAttachmentPayload): Omit<AnyAttachmentPayload, 'content' | 'base64Data' | 'extractedText'> => {
  if (isTextAttachment(attachment)) {
    const { content: _content, ...meta } = attachment;
    return meta;
  }
  if (isImageAttachment(attachment)) {
    const { base64Data: _base64Data, ...meta } = attachment;
    return meta;
  }
  if (isDocumentAttachment(attachment)) {
    const { base64Data: _base64Data, extractedText: _extractedText, ...meta } = attachment;
    return meta;
  }
  if (isOfficeDocumentAttachment(attachment)) {
    const { extractedText: _extractedText, base64Data: _base64Data, ...meta } = attachment;
    return meta;
  }
  if (isExtractedPdfAttachment(attachment)) {
    const { extractedText: _extractedText, base64Data: _base64Data, ...meta } = attachment;
    return meta;
  }
  if (isTextFileAttachment(attachment)) {
    const { content: _content, ...meta } = attachment;
    return meta;
  }
  if (isBinaryFileAttachment(attachment)) {
    const { base64Data: _base64Data, ...meta } = attachment;
    return meta;
  }
  return attachment;
};

type AgentSessionEngineOptions = {
  emitLog: EmitLogFn;
  recordBreadcrumb: RecordBreadcrumbFn;
  showToast: (message: { title: string }) => void;
  isViewingConversation?: boolean;
};

export type AgentSessionEngineApi = {
  messages: AgentTurnMessage[];
  eventsByTurn: Record<string, AgentEvent[]>;
  activeTurnId: string | null;
  focusedTurnId: string | null;
  currentSessionId: string;
  currentSessionTitle: string;
  currentSessionOrigin:
    | 'manual'
    | 'automation'
    | 'role'
    | 'mcp-tool'
    | 'inbound-trigger'
    | 'plugin'
    | 'focus'
    | 'browser-extension'
    | 'operator-personalisation';
  error: string | null;
  lastErrorSource: 'main' | 'renderer' | null;
  isBusy: boolean;
  isStopping: boolean;
  currentRuntime: SessionRuntimeState;
  currentSessionResolvedAt: number | null;
  /** Lifecycle: `null` = Active, non-null = Done. See sessionStore. */
  currentSessionDoneAt: number | null;
  currentSessionStarredAt: number | null;
  showConversation: boolean;
  setShowConversation: (value: boolean) => void;
  setAgentError: (value: string | null) => void;
  handleVoiceRunFailure: (message: string) => void;
  handleUserMessage: (
    text: string,
    source?: 'text' | 'voice',
    attachments?: AnyAttachmentPayload[],
    existingMessageId?: string,
    targetSessionId?: string,
    options?: { isSystemContinuation?: boolean; modelOverride?: string; thinkingModelOverride?: string; doneAfterComplete?: boolean; unleashedMode?: boolean; sessionType?: 'manual' | 'automation'; bypassToolSafety?: boolean; isHidden?: boolean; messageOrigin?: AgentTurnMessage['messageOrigin']; continuationContext?: import('@shared/types').AgentTurnRequest['continuationContext']; supersedePolicy?: import('@shared/types').AgentTurnRequest['supersedePolicy'] }
  ) => Promise<void>;
  editingMessageId: string | null;
  beginEditLastUserMessage: () => AgentTurnMessage | null;
  cancelEditMessage: () => void;
  beginEditMessage: (messageId: string) => AgentTurnMessage | null;
  rerunEditedMessage: (
    targetMessageId: string,
    newText: string,
    source: 'text' | 'voice',
    attachments?: AnyAttachmentPayload[]
  ) => Promise<void>;
  stopActiveTurn: () => Promise<void>;
  snapshotCurrentConversation: () => AgentSessionWithRuntime | null;
  resetSessionState: () => string;
  /**
   * Raw engine-level history session opener.
   *
   * **@internal — do NOT call directly from UI navigation code paths.** For any
   * user-initiated conversation open (sidebar click, deep link, inbox, task
   * toast, meeting companion, etc.) use the canonical
   * `navigateToConversation(sessionId, source?)` helper exposed by `App.tsx`
   * (or `executeOpenHistorySession` / `handleOpenHistorySession`) instead.
   *
   * The wrapped helpers apply the scroll-settling contract
   * (`markPendingHistoryScroll` + pane hide + scroll-to-latest) so the user
   * lands at the latest turn. Calling this raw opener skips that contract
   * and leaves the reused `ConversationPane` at its previous scroll position
   * (often `scrollTop = 0`), producing the "thread jumps to the top" bug.
   *
   * Intentionally-raw (non-UI) callers: network reconnect-resume batch flow
   * in `useNetworkReconnectResume`. See
   * docs-private/investigations/260416_thread_scroll_jumps_to_top_on_switch.md.
   */
  openHistorySession: (sessionId: string) => Promise<boolean>;
  deleteHistorySession: (sessionId: string) => { success: boolean; wasActive: boolean };
  togglePinSession: (sessionId: string) => void;
  toggleStarSession: (sessionId: string) => void;
  softDeleteSession: (sessionId: string) => void;
  restoreSession: (sessionId: string) => void;
  emptyTrash: () => void;
  renameSession: (sessionId: string, newTitle: string) => void;
  focusTurn: (turnId: string) => void;
  ingestExternalSessions: (sessions: AgentSession[]) => void;
  // Compaction overlay handlers
  executeCompactionContinue: () => Promise<void>;
  dismissCompaction: () => void;
  // Private mode
  privateMode: boolean;
  setPrivateMode: (enabled: boolean) => void;
  // Council mode
  councilMode: boolean;
  setCouncilMode: (enabled: boolean) => void;
  requestCouncilReview: () => void;
  // Auto-done toggle (fire & forget mode)
  autoDoneEnabled: boolean;
  setAutoDoneEnabled: (enabled: boolean) => void;
  // Finish line (user-set success criterion)
  finishLine: string | null;
  setFinishLine: (value: string | null) => void;
  // Diagnostic callback for FOX-3518 within-session leak investigation.
  // Returns cheap cardinality counters for hook-internal refs that are NOT
  // visible to sessionStore's getCheapLeakCounters(). Called from App.tsx's
  // "Renderer memory diagnostic" prod-tier emitLog (every 5 min).
  getEngineLeakCounters: () => {
    pendingEventsTurns: number;
    pendingEventsTotal: number;
    pendingEventsKB: number;
    turnSessionMapSize: number;
    turnStartTimesSize: number;
  };
};

export const useAgentSessionEngine = ({
  emitLog,
  recordBreadcrumb,
  showToast,
}: AgentSessionEngineOptions): AgentSessionEngineApi => {
  const store = useSessionStore;

  const {
    messages,
    eventsByTurnVersion,
    activeTurnId: declaredActiveTurnId,
    focusedTurnId,
    currentSessionId,
    currentSessionTitle,
    currentSessionOrigin,
    lastError: error,
    lastErrorSource,
    isStopping,
    runtime: currentRuntime,
    currentSessionResolvedAt,
    currentSessionDoneAt,
    currentSessionStarredAt,
    showConversation,
    editingMessageId,
    privateMode,
    councilMode,
    autoDoneEnabled,
    finishLine
  } = store(
    useShallow((s) => ({
      messages: s.messages,
      eventsByTurnVersion: s.eventsByTurnVersion,
      activeTurnId: s.activeTurnId,
      focusedTurnId: s.focusedTurnId,
      currentSessionId: s.currentSessionId,
      currentSessionTitle: s.currentSessionTitle,
      currentSessionOrigin: s.currentSessionOrigin,
      lastError: s.lastError,
      lastErrorSource: s.lastErrorSource,
      isStopping: s.isStopping,
      runtime: s.runtime,
      currentSessionResolvedAt: s.currentSessionResolvedAt,
      currentSessionDoneAt: s.currentSessionDoneAt,
      currentSessionStarredAt: s.currentSessionStarredAt,
      showConversation: s.showConversation,
      editingMessageId: s.editingMessageId,
      privateMode: s.privateMode,
      councilMode: s.councilMode,
      autoDoneEnabled: s.autoDoneEnabled,
      finishLine: s.currentSessionFinishLine
    }))
  );

  useSyncExternalStore(
    subscribeToCurrentSessionEventsVersion,
    getCurrentSessionEventsVersion,
    getCurrentSessionEventsVersion,
  );
  const projectedLiveness = getCurrentSessionProjectedLiveness(declaredActiveTurnId);
  const activeTurnId = projectedLiveness.activeTurnId;
  const isBusy = projectedLiveness.status === 'running';

  // Defer the version counter so React can batch rapid event bursts.
  // During heavy tool activity (e.g., deep research with 100+ tool results),
  // each event bumps eventsByTurnVersion. Without deferral, every bump triggers
  // Object.fromEntries() on the full event Map — creating ~1MB snapshots per event.
  // useDeferredValue lets React coalesce rapid bumps into fewer snapshots,
  // reducing allocation pressure from ~200MB to a handful during bursts.
  //
  // Stage 5 (260508 active-work rebuild, R2-9): `eventsByTurnVersion` is the
  // **Zustand-stored coalesced value** — it lags the synchronous
  // `currentSessionEventsVersion` counter by ≤1 microtask thanks to
  // `bumpVersion`'s microtask scheduler. That double deferral (microtask +
  // React deferred) is intentional here: this consumer already opted into
  // stale-while-pending semantics. Consumers needing tearing-free synchronous
  // correctness must subscribe via
  // `useSyncExternalStore(subscribe, getCurrentSessionEventsVersion)` instead.
  const deferredEventsByTurnVersion = useDeferredValue(eventsByTurnVersion);

  // Snapshot external events when deferred version changes (cheap: Map→Record conversion)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting getCurrentSessionEvents because deferredEventsByTurnVersion is the coalesced snapshot trigger
  const eventsByTurn = useMemo(() => getCurrentSessionEvents(), [deferredEventsByTurnVersion]);

  const turnSessionMapRef = useRef<Record<string, string>>({});
  // Stage 19a refinement: queue the envelope `eventSessionId` provenance
  // ALONGSIDE each pending event so that when a turn is later assigned to a
  // session and the queue is flushed, the events are validated against their
  // TRUE provenance (same as the immediate path) rather than falling back to
  // `event.sessionId`/`accepted-legacy`.
  const pendingEventsRef = useRef<Record<string, PendingAgentEvent[]>>({});
  const stoppedTurnsRef = useRef<Set<string>>(new Set());
  const preAckStopIntentByClientTurnIdRef = useRef<Record<string, number>>({});
  const optimisticTurnIdByRealTurnIdRef = useRef<Record<string, string>>({});
  const pendingOptimisticStartByClientTurnIdRef = useRef<Record<string, PendingOptimisticTurnStart>>({});
  const preAckRealTurnSeenAtRef = useRef<Record<string, number>>({});
  const stoppingTurnIdRef = useRef<string | null>(null);
  const stoppingTimer = useTimeoutRef();
  const stopAbortWatchdog = useTimeoutRef();
  const sessionTitleOverridesRef = useRef<Record<string, string>>({});
  const turnStartTimesRef = useRef<Record<string, number>>({});
  const turnFirstResponseTimesRef = useRef<Record<string, number>>({});
  /** Track turns with explicit doneAfterComplete (e.g., Inbox execution) vs toggle-sourced */
  const explicitDoneRequestsRef = useRef<Set<string>>(new Set());
  const cleanupInterval = useIntervalRef();
  const staleBusyHealInterval = useIntervalRef();

  // Uncounted engine refs (FOX-3518 within-session leak suspects).
  // These plain-JS refs hold in-flight state that the cheap leak counters in
  // sessionStore's getCheapLeakCounters() never see. getEngineLeakCounters()
  // surfaces them into the "Renderer memory diagnostic" log so we can confirm
  // whether pendingEventsRef accumulates events from unresolvable/background
  // turns (the leading hypothesis per the Decision Log in PLAN.md 2026-06-22).
  //
  // Cost budget: runs in the prod-tier diagnostic (every 5 min), so must stay
  // O(1)-ish. turnSessionMapRef/turnStartTimesRef are pure key-counts.
  // pendingEventsRef iterates turn-buckets for total-event sum and a
  // capped-sample byte estimate (≤50 events per turn stringified, then
  // extrapolated) — see inline comments.
  const getEngineLeakCounters = useCallback((): {
    pendingEventsTurns: number;
    pendingEventsTotal: number;
    pendingEventsKB: number;
    turnSessionMapSize: number;
    turnStartTimesSize: number;
  } => {
    const pendingMap = pendingEventsRef.current;
    const turnIds = Object.keys(pendingMap);
    const pendingEventsTurns = turnIds.length;
    let pendingEventsTotal = 0;
    let sampledBytes = 0;
    let sampledCount = 0;
    const SAMPLE_CAP = 50; // max events to stringify per turn for byte estimate

    for (const turnId of turnIds) {
      const queue = pendingMap[turnId];
      pendingEventsTotal += queue.length;
      // Bounded per-turn sample: stringify up to SAMPLE_CAP events and
      // extrapolate to the full queue length. This keeps the diagnostic
      // O(1)-ish even if one turn has thousands of queued events.
      const sampleSize = Math.min(queue.length, SAMPLE_CAP);
      for (let i = 0; i < sampleSize; i++) {
        sampledBytes += JSON.stringify(queue[i]).length;
        sampledCount++;
      }
    }

    // Extrapolate total bytes from the sampled subset, then convert to KB.
    // If no events were sampled (all queues empty) the result is 0.
    const extrapolatedBytes = sampledCount > 0
      ? (sampledBytes / sampledCount) * pendingEventsTotal
      : 0;
    const pendingEventsKB = Math.round(extrapolatedBytes / 1024);

    return {
      pendingEventsTurns,
      pendingEventsTotal,
      pendingEventsKB,
      turnSessionMapSize: Object.keys(turnSessionMapRef.current).length,
      turnStartTimesSize: Object.keys(turnStartTimesRef.current).length,
    };
  // Refs are stable (never reassigned) — no deps needed.
  }, []);

  const pushOptimisticStartForSession = useCallback(
    (targetSessionId: string, activeSessionId: string): string | null => {
      if (targetSessionId !== activeSessionId) {
        return null;
      }
      const clientTurnId = createId();
      appendRendererOptimisticTurnStartedEvent(clientTurnId);
      pendingOptimisticStartByClientTurnIdRef.current[clientTurnId] = {
        clientTurnId,
        sessionId: targetSessionId,
        sentAt: Date.now(),
      };
      return clientTurnId;
    },
    [],
  );

  const clearOptimisticStartById = useCallback((optimisticTurnId: string | null) => {
    if (!optimisticTurnId) return;
    removeRendererOptimisticTurnStartedEvent(optimisticTurnId);
    delete pendingOptimisticStartByClientTurnIdRef.current[optimisticTurnId];
    for (const [realTurnId, linkedOptimisticTurnId] of Object.entries(optimisticTurnIdByRealTurnIdRef.current)) {
      if (linkedOptimisticTurnId === optimisticTurnId) {
        delete optimisticTurnIdByRealTurnIdRef.current[realTurnId];
      }
    }
  }, []);

  const clearOptimisticStartsOnly = useCallback(() => {
    removeAllRendererOptimisticTurnStartedEvents();
    pendingOptimisticStartByClientTurnIdRef.current = {};
    optimisticTurnIdByRealTurnIdRef.current = {};
    preAckRealTurnSeenAtRef.current = {};
  }, []);

  const bindOptimisticStartToRealTurn = useCallback(
    (realTurnId: string, optimisticTurnId: string | null) => {
      if (!optimisticTurnId) return;
      const hasPendingOptimisticStart = Boolean(
        pendingOptimisticStartByClientTurnIdRef.current[optimisticTurnId],
      );
      const hasPreAckStopIntent = Object.prototype.hasOwnProperty.call(
        preAckStopIntentByClientTurnIdRef.current,
        optimisticTurnId,
      );
      if (!hasPendingOptimisticStart && !hasPreAckStopIntent) {
        return;
      }
      if (hasPendingOptimisticStart) {
        optimisticTurnIdByRealTurnIdRef.current[realTurnId] = optimisticTurnId;
      }
      if (Object.prototype.hasOwnProperty.call(preAckRealTurnSeenAtRef.current, realTurnId)) {
        clearOptimisticStartById(optimisticTurnId);
        delete preAckRealTurnSeenAtRef.current[realTurnId];
      }
      if (hasPreAckStopIntent) {
        delete preAckStopIntentByClientTurnIdRef.current[optimisticTurnId];
        stoppedTurnsRef.current.delete(optimisticTurnId);
        stoppedTurnsRef.current.add(realTurnId);

        const now = Date.now();
        const realTurnEvents = getCurrentSessionEventsForTurn(realTurnId);
        const hasTerminalEvent = realTurnEvents.some(
          (event) => event.type === 'result' || event.type === 'error',
        );
        if (!hasTerminalEvent) {
          appendRendererLocalTerminalEvent(
            realTurnId,
            now,
            'Stop requested before turn acknowledgement',
          );
        }
        store.getState().clearBusy();

        void window.agentApi.stopTurn(realTurnId).catch((error) => {
          emitLog({
            level: 'warn',
            message: 'Deferred pre-ack stop failed for correlated real turn',
            turnId: realTurnId,
            context: {
              error: error instanceof Error ? error.message : String(error),
            },
            timestamp: Date.now(),
          });
        });
      }
    },
    [clearOptimisticStartById, emitLog, store],
  );

  const clearOptimisticStartForRealTurn = useCallback(
    (realTurnId: string) => {
      const optimisticTurnId = optimisticTurnIdByRealTurnIdRef.current[realTurnId];
      if (!optimisticTurnId) {
        // Real events can arrive before `agentApi.turn()` resolves; keep a marker
        // so the eventual ack can still clear the matching optimistic synthetic.
        preAckRealTurnSeenAtRef.current[realTurnId] = Date.now();
        return;
      }
      clearOptimisticStartById(optimisticTurnId);
    },
    [clearOptimisticStartById],
  );

  const optimisticTurnLifecycleManager = useMemo<OptimisticTurnLifecycleManager>(
    () => ({
      getActiveSessionId: () => store.getState().currentSessionId,
      pushOptimisticStartForSession,
      bindOptimisticStartToRealTurn,
      clearOptimisticStartById,
    }),
    [
      bindOptimisticStartToRealTurn,
      clearOptimisticStartById,
      pushOptimisticStartForSession,
      store,
    ],
  );

  useEffect(() => {
    registerSystemContinuationOptimisticLifecycleManager(optimisticTurnLifecycleManager);
    return () => {
      registerSystemContinuationOptimisticLifecycleManager(null);
    };
  }, [optimisticTurnLifecycleManager]);

  const startTurnWithOptimisticLifecycle = useCallback(
    (
      turnRequest: AgentTurnStartRequest,
      targetSessionId: string,
      activeSessionId: string,
    ) => startTurnWithOptimisticLifecycleShared({
      turnRequest,
      targetSessionId,
      activeSessionId,
      lifecycleManager: optimisticTurnLifecycleManager,
    }),
    [optimisticTurnLifecycleManager],
  );

  const forceTerminalizeCurrentProjectedTurn = useCallback(
    (errorMessage: string) => {
      const state = store.getState();
      const projected = getCurrentSessionProjectedLiveness(state.activeTurnId);
      const projectedTurnWasOptimisticOnly = Boolean(
        projected.status === 'running'
        && projected.activeTurnId
        && getCurrentSessionEventsForTurn(projected.activeTurnId).length > 0
        && getCurrentSessionEventsForTurn(projected.activeTurnId).every(
          isRendererOptimisticTurnStartedEvent,
        ),
      );
      clearOptimisticStartsOnly();
      if (
        projected.status === 'running'
        && projected.activeTurnId
        && !projectedTurnWasOptimisticOnly
      ) {
        appendRendererLocalTerminalEvent(
          projected.activeTurnId,
          Date.now(),
          errorMessage,
        );
      }
      state.clearBusy();
    },
    [clearOptimisticStartsOnly, store],
  );

  useEffect(() => {
    toastNotifications.setToastHandler(showToast);
    return () => toastNotifications.clearToastHandler();
  }, [showToast]);

  // Periodic cleanup of orphaned turn tracking refs to prevent memory leaks in long sessions
  useEffect(() => {
    const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    const ORPHAN_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

    cleanupInterval.set(() => {
      const now = Date.now();
      const orphanCutoff = now - ORPHAN_THRESHOLD_MS;

      for (const [turnId, startTime] of Object.entries(turnStartTimesRef.current)) {
        if (startTime < orphanCutoff) {
          delete turnStartTimesRef.current[turnId];
          delete turnSessionMapRef.current[turnId];
          delete pendingEventsRef.current[turnId];
          delete optimisticTurnIdByRealTurnIdRef.current[turnId];
          delete turnFirstResponseTimesRef.current[turnId];
          explicitDoneRequestsRef.current.delete(turnId);
        }
      }

      for (const [clientTurnId, pending] of Object.entries(pendingOptimisticStartByClientTurnIdRef.current)) {
        if (pending.sentAt < orphanCutoff) {
          clearOptimisticStartById(clientTurnId);
        }
      }

      for (const [turnId, seenAt] of Object.entries(preAckRealTurnSeenAtRef.current)) {
        if (seenAt < orphanCutoff) {
          delete preAckRealTurnSeenAtRef.current[turnId];
        }
      }

      for (const [clientTurnId, intentAt] of Object.entries(preAckStopIntentByClientTurnIdRef.current)) {
        if (intentAt < orphanCutoff) {
          delete preAckStopIntentByClientTurnIdRef.current[clientTurnId];
        }
      }

      // Clean up sessionTitleOverridesRef for deleted sessions
      const state = store.getState();
      const validSessionIds = new Set(state.sessionSummaries.map((s) => s.id));
      for (const sessionId of Object.keys(sessionTitleOverridesRef.current)) {
        if (sessionId !== state.currentSessionId && !validSessionIds.has(sessionId)) {
          delete sessionTitleOverridesRef.current[sessionId];
        }
      }
    }, CLEANUP_INTERVAL_MS);
  }, [cleanupInterval, clearOptimisticStartById, store]);

  const handleRecoveryEvent = useRecoveryAdapter({ store, emitLog });

  const executeCompactionContinue = useCallback(async () => {
    const state = store.getState();
    const { enhancedPrompt, depth, summary } = state.compaction;

    if (!enhancedPrompt || !summary) {
      emitLog({
        level: 'error',
        message: 'executeCompactionContinue called without enhanced prompt or summary',
        timestamp: Date.now()
      });
      store.getState().resetCompaction();
      return;
    }

    // Perform in-place compaction and transition to continuing phase
    store.getState().performCompaction(summary, depth);
    store.getState().completeCompaction();

    const capturedSessionId = store.getState().currentSessionId;
    const userMessage = store.getState().addUserMessage(enhancedPrompt);
    let optimisticTurnId: string | null = null;

    try {
      const execCompactionState = store.getState();
      optimisticTurnId = pushOptimisticStartForSession(
        capturedSessionId,
        execCompactionState.currentSessionId,
      );
      const { turnId: actualTurnId } = await window.agentApi.turn({
        prompt: enhancedPrompt,
        resetConversation: true,
        sessionId: capturedSessionId,
        ...(optimisticTurnId ? { clientTurnId: optimisticTurnId } : {}),
        privateMode: execCompactionState.privateMode || undefined,
        councilMode: execCompactionState.councilMode || undefined,
        isSystemContinuation: true,
        ...buildSessionModelOverrides(execCompactionState),
        origin: execCompactionState.currentSessionOrigin !== 'manual' ? execCompactionState.currentSessionOrigin : undefined,
        finishLine: execCompactionState.currentSessionFinishLine ?? undefined,
      });
      bindOptimisticStartToRealTurn(actualTurnId, optimisticTurnId);
      
      store.getState().assignTurnToMessage(userMessage.id, actualTurnId, Date.now());

      emitLog({
        level: 'info',
        message: 'Compacted turn started successfully (same session)',
        turnId: actualTurnId,
        sessionId: capturedSessionId,
        context: { compactionDepth: depth },
        timestamp: Date.now()
      });

    } catch (turnError: unknown) {
      clearOptimisticStartById(optimisticTurnId);
      const errorMessage = turnError instanceof Error ? turnError.message : 'Unknown error';
      emitLog({
        level: 'error',
        message: 'Failed to start compacted turn',
        context: { error: errorMessage },
        timestamp: Date.now()
      });
      captureRendererException(turnError, {
        tags: { area: 'agent', component: 'compaction' },
        extra: { sessionId: capturedSessionId, depth, phase: 'turn-restart' }
      });
      store.getState().setError("Couldn't continue after summarizing. Try again — your message is safe.");
    } finally {
      // Close the overlay, then show success toast (after overlay is gone)
      setTimeout(() => {
        store.getState().resetCompaction();
        toastNotifications.notifyContextCompacted();
      }, 400);
    }
  }, [bindOptimisticStartToRealTurn, clearOptimisticStartById, emitLog, pushOptimisticStartForSession, store]);

  const dismissCompaction = useCallback(() => {
    store.getState().resetCompaction();
  }, [store]);

  /**
   * Mark a session as done by setting `doneAt`.
   * No-op if session is already Done (`doneAt != null`).
   * Handles both current session and history sessions.
   */
  const markSessionDone = useCallback(
    (sessionId: string) => {
      const state = store.getState();

      // Check if this is the current session
      if (sessionId === state.currentSessionId) {
        // Already Done (`doneAt != null`)
        if (state.currentSessionDoneAt != null) {
          return;
        }
        // Mark as done by toggling pin
        store.getState().togglePinSession(sessionId);
        recordBreadcrumb({
          type: 'session-action',
          message: 'Mark-done after turn triggered for session',
          timestamp: Date.now(),
          data: { sessionId, wasCurrentSession: true }
        });
        return;
      }

      // Check in session summaries (Stage 7b: only need metadata for done check)
      const sessionSummary = state.sessionSummaries.find((s) => s.id === sessionId);
      if (!sessionSummary) {
        emitLog({
          level: 'warn',
          message: 'markSessionDone: session not found',
          sessionId,
          timestamp: Date.now()
        });
        return;
      }

      // Already Done (`doneAt != null`)
      if (isSessionDone(sessionSummary)) {
        return;
      }

      // Mark as done by toggling pin
      store.getState().togglePinSession(sessionId);
      recordBreadcrumb({
        type: 'session-action',
        message: 'Mark-done after turn triggered for session',
        timestamp: Date.now(),
        data: { sessionId, wasCurrentSession: false }
      });
    },
    [emitLog, recordBreadcrumb, store]
  );

  /**
   * Re-escalate a session by reopening it if it's currently Done (`doneAt != null`).
   * Used when the done safety check determines the task wasn't actually completed --
   * ensures nothing slips through the cracks.
   */
  const reopenSessionIfDone = useCallback(
    (sessionId: string) => {
      const state = store.getState();

      if (sessionId === state.currentSessionId) {
        if (state.currentSessionDoneAt == null) return;
        store.getState().togglePinSession(sessionId);
        recordBreadcrumb({
          type: 'session-action',
          message: 'Re-escalated session: task not completed, reopened from done',
          timestamp: Date.now(),
          data: { sessionId, wasCurrentSession: true }
        });
        return;
      }

      const summary = state.sessionSummaries.find((s) => s.id === sessionId);
      if (!summary || isSessionActive(summary)) return;
      store.getState().togglePinSession(sessionId);
      recordBreadcrumb({
        type: 'session-action',
        message: 'Re-escalated session: task not completed, reopened from done',
        timestamp: Date.now(),
        data: { sessionId, wasCurrentSession: false }
      });
    },
    [recordBreadcrumb, store]
  );

  const processAgentEvent = useCallback(
    (turnId: string, sessionId: string, event: AgentEvent, eventSessionId?: string) => {
      // Stage 4 (H6/H7): remove the renderer-local optimistic start as soon as
      // any real event arrives for this turn. Explicit removal is load-bearing:
      // a no-seq synthetic start can otherwise sort after a real terminal and
      // re-prime `running` under global ordering.
      clearOptimisticStartForRealTurn(turnId);

      // Ignore in-flight events from stopped turns (including streaming deltas)
      if (stoppedTurnsRef.current.has(turnId) &&
          (event.type === 'assistant' || event.type === 'assistant_delta' ||
           event.type === 'thinking_delta' || event.type === 'tool' || event.type === 'status' ||
           event.type === 'turn_started' || event.type === 'answer_phase_started')) {
        emitLog({
          level: 'debug',
          message: 'Ignoring in-flight event from stopped run',
          turnId,
          sessionId,
          context: { eventType: event.type },
          timestamp: Date.now()
        });
        return;
      }

      // PERF: Skip delta processing entirely for background sessions.
      // Background sessions don't need streaming/thinking buffers (not visible).
      const activeSessionId = store.getState().currentSessionId;
      if (
        sessionId !== activeSessionId
        && (event.type === 'thinking_delta'
          || event.type === 'assistant_delta'
          || event.type === 'answer_phase_started')
      ) {
        return;
      }

      // Handle thinking deltas (extended thinking mode) - separate buffer from answer
      if (event.type === 'thinking_delta') {
        store.getState().appendThinkingDelta(turnId, event.text);
        return;
      }

      // 260508 Stage 2 (R2-3): the dispatcher emits a single per-turn
      // `answer_phase_started` desktop-renderer-IPC-only marker on the FIRST
      // assistant_delta of each turn. This is the answer-phase barrier that
      // tells the renderer "thinking phase is done, drop the transient
      // buffer." The dispatcher no longer broadcasts the per-delta payload
      // (deltas reach CLI/cloud/mobile via separate channels — see
      // `agentEventDispatcher.ts` `assistant_delta` branch).
      if (event.type === 'answer_phase_started') {
        store.getState().clearThinkingBuffer(turnId);
        // Stage 1b (260617): first token received → clear the soft "still
        // waiting" affordance immediately (the load-bearing invariant: never
        // show "still waiting" once text is appearing). `answer_phase_started`
        // is the real first-token marker the renderer processes — `assistant_delta`
        // is NOT broadcast here, and the rolled-up `assistant` event can land
        // many seconds later, so we must clear on this marker, not on the rollup.
        store.getState().markAnswerStreaming(turnId);
        return;
      }

      // Streaming deltas should NEVER reach the renderer over `agent:event`
      // post-Stage-2. If one slips through (e.g. an out-of-band test fixture
      // or a future regression), drop it — the visible consumer is the rolled-
      // up `assistant` event, not the per-delta payload. This is a debug-only
      // observation point; no user-visible side effect.
      if (event.type === 'assistant_delta') {
        emitLog({
          level: 'debug',
          message: 'Renderer received assistant_delta after Stage 2 collapse — dropping',
          turnId,
          sessionId,
          timestamp: Date.now(),
        });
        return;
      }

      if (event.type === 'context_overflow') {
        emitLog({
          level: 'debug',
          message: 'Context overflow observed; unified recovery pipeline owns retry',
          turnId,
          sessionId,
          timestamp: Date.now(),
        });
        return;
      }

      if (event.type.startsWith('recovery:')) {
        handleRecoveryEvent(event as Parameters<typeof handleRecoveryEvent>[0]);
        return;
      }

      if (event.type === 'status') {
        const role = parseRoleNotConfiguredStatusMessage(event.message);
        if (role) {
          if (store.getState().markRoleNotConfiguredToastSeen(sessionId, role)) {
            toastNotifications.showToast({
              title: `${roleLabel(role)} model needs setup`,
              description: 'Open Settings → Models and pick a model for this role.',
            });
          }
          return;
        }
      }

      // Handle turn supersession - the new turn is now active, no toast needed
      // (the UI already reflects the new request being processed)
      if (event.type === 'turn_superseded') {
        emitLog({
          level: 'info',
          message: 'Turn superseded by newer request',
          turnId,
          sessionId,
          context: { newTurnId: event.newTurnId },
          timestamp: event.timestamp
        });
        // Stage 5 (F9 boundary flush): terminal turn event. Drain pending
        // eventsByTurnVersion notification before refs and store-level state
        // are cleaned up, so persistence subscribers observe the trailing-edge
        // counter for the superseded turn before the new turn's events arrive.
        flushPendingEventsVersionNotification();
        // Clean up refs for the cancelled turn
        delete turnSessionMapRef.current[turnId];
        delete pendingEventsRef.current[turnId];
        delete turnStartTimesRef.current[turnId];
        clearOptimisticStartById(optimisticTurnIdByRealTurnIdRef.current[turnId] ?? null);
        delete preAckRealTurnSeenAtRef.current[turnId];
        delete turnFirstResponseTimesRef.current[turnId];
        store.getState().clearAnswerStreaming(turnId); // Stage 1b cleanup
        explicitDoneRequestsRef.current.delete(turnId);
        // Clean up done intent for superseded turn (won't complete, so shouldn't mark done)
        store.getState().removeDoneAfterTurnId(turnId);
        // Clean up transient thinking buffer (may have accumulated before supersession)
        store.getState().clearThinkingBuffer(turnId);
        return;
      }

      // PERF: Sanitize tool events ONCE at the IPC boundary.
      // Truncates large detail strings (>50KB) to prevent unbounded memory growth.
      // Covers all downstream paths: processEvent, processHistoryEvent, bufferBackgroundEvent.
      const sanitizedEvent = sanitizeEventForRenderer(event);

      const state = store.getState();

      const context: Record<string, unknown> = {};
      if (sanitizedEvent.type === 'assistant') {
        context.preview = truncateForLog(sanitizedEvent.text, 160);
      } else if (sanitizedEvent.type === 'result') {
        context.preview = truncateForLog(sanitizedEvent.text, 180);
        context.usage = sanitizedEvent.usage ?? undefined;
      } else if (sanitizedEvent.type === 'status') {
        context.status = sanitizedEvent.message;
      } else if (sanitizedEvent.type === 'error') {
        context.error = sanitizedEvent.error;
      }

      emitLog({
        level: sanitizedEvent.type === 'error' ? 'error' : sanitizedEvent.type === 'status' || sanitizedEvent.type === 'result' ? 'info' : 'debug',
        message: `Agent event: ${sanitizedEvent.type}`,
        turnId,
        sessionId,
        context,
        timestamp: sanitizedEvent.timestamp
      });
      recordBreadcrumb({
        type: 'agent-event',
        message: `processed:${sanitizedEvent.type}`,
        timestamp: sanitizedEvent.timestamp,
        data: { turnId, sessionId, activeSessionId }
      });

      // Done-after-turn check: MUST run BEFORE background-session early return
      // to handle both current and background session completions
      if ((sanitizedEvent.type === 'result' || sanitizedEvent.type === 'error') && state.doneAfterTurnIds.has(turnId)) {
        // Clear flag immediately to prevent double-firing
        store.getState().removeDoneAfterTurnId(turnId);

        // Only mark done on successful completion (result), not on error or manual stop
        // Clean up explicit tracking immediately for non-applicable cases (error, stopped)
        if (sanitizedEvent.type === 'error' || stoppedTurnsRef.current.has(turnId)) {
          explicitDoneRequestsRef.current.delete(turnId);
        }

        if (sanitizedEvent.type === 'result' && !stoppedTurnsRef.current.has(turnId)) {
          const capturedSessionId = sessionId;
          explicitDoneRequestsRef.current.delete(turnId);

          // All auto-done paths go through the safety check.
          // Even explicit "send and mark done" must verify the task actually completed --
          // the agent may have drafted but asked for confirmation instead of executing.
          const responseText = sanitizedEvent.text || '';
          const targetSessionMessages = capturedSessionId === state.currentSessionId
            ? state.messages
            : state.loadedSessions.get(capturedSessionId)?.messages ?? [];
          const lastUserMessage = targetSessionMessages
            .filter((m) => m.role === 'user')
            .pop()?.text || '';

          // Snapshot the lifecycle (`doneAt`) before the async call so we can
          // detect manual user changes during the evaluation window (prevents
          // stale results from overriding user intent).
          const doneAtBefore = capturedSessionId === state.currentSessionId
            ? state.currentSessionDoneAt
            : state.sessionSummaries.find((s) => s.id === capturedSessionId)?.doneAt ?? undefined;

          void (async () => {
            try {
              const result = await window.agentApi.evaluateDoneSafety({
                lastUserMessage,
                responseText,
              });

              const currentState = store.getState();
              if (currentState.isBusy && currentState.currentSessionId === capturedSessionId) {
                return;
              }

              // If session state was changed manually while the safety check was in flight,
              // respect the user's action and don't override it
              const doneAtNow = capturedSessionId === currentState.currentSessionId
                ? currentState.currentSessionDoneAt
                : currentState.sessionSummaries.find((s) => s.id === capturedSessionId)?.doneAt ?? undefined;
              if (doneAtBefore !== doneAtNow) {
                return;
              }

              if (result.safeToMarkDone) {
                markSessionDone(capturedSessionId);
                toastNotifications.notifyAutoDone();
              } else {
                // Re-escalate: ensure the session stays active (reopen if already done)
                reopenSessionIfDone(capturedSessionId);
                toastNotifications.notifyDoneSkipped(result.reason);
              }
            } catch (error) {
              emitLog({
                level: 'warn',
                message: 'Done safety evaluation failed',
                sessionId: capturedSessionId,
                error: error instanceof Error
                  ? { name: error.name, message: error.message, stack: error.stack }
                  : { message: String(error) },
                timestamp: Date.now(),
              });
              // On failure, don't mark done -- keep conversation visible
            }
          })();
        }
      }

      if (
        sanitizedEvent.type === 'tool' &&
        sanitizedEvent.stage === 'end' &&
        (sanitizedEvent.toolName === 'rebel_bridge_prepare_install' ||
          sanitizedEvent.toolName === 'rebel_bridge_extract_extension' ||
          sanitizedEvent.toolName === 'rebel_bridge_start_pairing')
      ) {
        const pairSessionId = extractPairSessionIdFromToolDetail(sanitizedEvent.detail);
        if (pairSessionId) {
          store.getState().setSetupContextForSession(sessionId, { kind: 'bundled-app-bridge', pairSessionId });
        }
      }

      if (sessionId !== activeSessionId) {
        // Stage 19c: thread the authoritative provenance (envelope sessionId,
        // falling back to the event's own sessionId) into the BACKGROUND
        // routing path, mirroring the foreground sibling below (~L941). The
        // `sessionId` here is the RESOLVED routing target, NOT valid
        // provenance — so we pass the envelope value to let the store's
        // ingress guard reject a foreign-routed background event instead of
        // falling to `accepted-legacy`.
        const backgroundProvenanceSessionId =
          eventSessionId
          ?? (sanitizedEvent as { sessionId?: string }).sessionId;
        store.getState().processHistoryEvent(
          sessionId,
          turnId,
          sanitizedEvent,
          backgroundProvenanceSessionId,
        );
        if (sanitizedEvent.type === 'result' || sanitizedEvent.type === 'error') {
          // Clear transient thinking buffer for background sessions (prevent memory leak)
          store.getState().clearThinkingBuffer(turnId);
          delete turnSessionMapRef.current[turnId];
          delete pendingEventsRef.current[turnId];
          clearOptimisticStartById(optimisticTurnIdByRealTurnIdRef.current[turnId] ?? null);
          delete preAckRealTurnSeenAtRef.current[turnId];
        }
        // Dock badge handles background notification — no toast needed
        return;
      }

      // Stage 19a: pass the authoritative provenance (envelope sessionId,
      // falling back to the event's own sessionId) so the store's foreground
      // ingress can drop a foreign-session event before it lands in the
      // shared `currentSessionEvents` Map. `sessionId` here is the RESOLVED
      // routing id (always === activeSessionId on this branch), so it is NOT a
      // valid provenance source — use the envelope value instead.
      const provenanceSessionId =
        eventSessionId
        ?? (sanitizedEvent as { sessionId?: string }).sessionId;
      store.getState().processEvent(turnId, sanitizedEvent, provenanceSessionId);

      // Stage 5 (F9 boundary flush): tool:start is a renderer-state-resetting
      // boundary — the UI transitions from "streaming text" to "tool running"
      // and any pending eventsByTurnVersion notification should fire before
      // downstream consumers observe the post-tool-start state.
      //
      // Phase 6 remediation (260508 Stage 5) — flush AFTER processEvent so the
      // post-tool-start bump (from `appendEventToCurrentSession` inside
      // `processEvent`) collapses into the SAME coalesced notification as
      // any pending pre-tool-start bumps. This intentionally trades one extra
      // pre-tool-start microtask delay for halving the boundary's Zustand
      // fan-out cost. Subscribers consistently observe the "post tool:start"
      // version once both the prior streaming-text bumps and the tool:start
      // bump have landed.
      if (sanitizedEvent.type === 'tool' && sanitizedEvent.stage === 'start') {
        flushPendingEventsVersionNotification();
      }

      if (
        sanitizedEvent.type === 'tool' &&
        sanitizedEvent.stage === 'end' &&
        (sanitizedEvent.toolName === 'rebel_bridge_wait_pair_event' ||
          sanitizedEvent.toolName === 'rebel_bridge_check_pair_status')
      ) {
        const currentSetupContext = store.getState().currentSessionSetupContext;
        const currentPairSessionId =
          currentSetupContext?.kind === 'bundled-app-bridge'
            ? currentSetupContext.pairSessionId
            : undefined;
        const detailPairSessionId = extractPairSessionIdFromToolDetail(sanitizedEvent.detail);

        const matchesCurrentSession =
          currentPairSessionId !== undefined &&
          detailPairSessionId === currentPairSessionId;
        const pairingSucceeded =
          sanitizedEvent.toolName === 'rebel_bridge_wait_pair_event'
            ? toolDetailHasPairedEvent(sanitizedEvent.detail)
            : toolDetailHasPairedClients(sanitizedEvent.detail);

        if (matchesCurrentSession && pairingSucceeded) {
          store.getState().setSetupContext(null);
        }
      }

      // Track first assistant response for this turn
      if (sanitizedEvent.type === 'assistant') {
        // 260508 Stage 2 (R2-5): idempotent fallback for the
        // `answer_phase_started` barrier marker. The dispatcher emits the
        // marker on the first assistant_delta of each turn so the renderer
        // can drop its transient thinking buffer at the correct moment.
        // This fallback covers the rare case where the renderer remounts
        // (or the marker is dropped by IPC backpressure) and the first
        // event observed for the turn is an `assistant` rollup. Calling
        // `clearThinkingBuffer` is idempotent — clearing twice is harmless
        // — so we run it unconditionally on the first assistant event of
        // each turn (gated by `turnFirstResponseTimesRef`).
        if (!turnFirstResponseTimesRef.current[turnId]) {
          store.getState().clearThinkingBuffer(turnId);
          turnFirstResponseTimesRef.current[turnId] = sanitizedEvent.timestamp;
          analyticsTracker.trackAgentReplyStarted(turnId, sessionId);
        }
        // Stage 1b: belt for the dropped-`answer_phase_started` case — the
        // rolled-up `assistant` event also marks the answer phase (idempotent).
        store.getState().markAnswerStreaming(turnId);
      }

      if (sanitizedEvent.type === 'result' || sanitizedEvent.type === 'error') {
        // Stage 5 (F9 boundary flush): terminal turn event. Drain any pending
        // microtask-coalesced eventsByTurnVersion notification so persistence
        // subscribers see the final terminal-event version BEFORE the
        // snapshotCurrentSession() call further down (which itself flushes,
        // but flushing here keeps cleanup ordering observable).
        flushPendingEventsVersionNotification();
        // Clear transient thinking buffer on turn completion or error
        store.getState().clearThinkingBuffer(turnId);
        // Stage 1b: drop the answer-phase marker on terminal (cleanup; the
        // detector also clears State B on the stored result/error event).
        store.getState().clearAnswerStreaming(turnId);

        const turnStartTime = turnStartTimesRef.current[turnId] ?? sanitizedEvent.timestamp;
        const firstResponseTime = turnFirstResponseTimesRef.current[turnId] ?? sanitizedEvent.timestamp;
        const totalDurationMs = sanitizedEvent.timestamp - turnStartTime;
        const timeToFirstResponseMs = firstResponseTime - turnStartTime;

        delete turnSessionMapRef.current[turnId];
        delete pendingEventsRef.current[turnId];
        delete turnStartTimesRef.current[turnId];
        delete turnFirstResponseTimesRef.current[turnId];

        if (sanitizedEvent.type === 'result') {
          analyticsTracker.trackAgentReplyDelivered(turnId, sessionId, timeToFirstResponseMs, totalDurationMs);
          analyticsTracker.trackTurnCompleted(turnId, sessionId, sanitizedEvent, totalDurationMs);

          // Dock badge handles background notification — no toast needed
        } else {
          analyticsTracker.trackTurnError(turnId, sessionId, 'agent_error');

          // Network-failed turn detection: When an error event has isTransient flag,
          // check if it's safe to auto-retry and store pending turn info for later retry.
          // This enables automatic resume when network connectivity returns.
          if (sanitizedEvent.isTransient) {
            // Get events for this turn to check for tool usage
            const turnEvents = getCurrentSessionEventsForTurn(turnId);
            const hasToolEvents = turnEvents.some(e => e.type === 'tool');

            // Get user message to check for attachments
            const userMessage = state.messages.find(
              m => m.turnId === turnId && m.role === 'user'
            );
            const hasAttachments = (userMessage?.attachments?.length ?? 0) > 0;

            // Only set pending if safe to auto-retry (no tools, no attachments)
            // Attachments can't be auto-resumed because full payloads aren't stored in session
            // (only metadata is stored - see AgentTurnMessage.attachments type)
            if (!hasToolEvents && !hasAttachments && userMessage?.text) {
              store.getState().setPendingTurnForSession(sessionId, {
                sessionId,
                turnId,
                userMessageText: userMessage.text,
                failedAt: Date.now(),
                retryCount: 0,
              });
            } else {
              // NOT safe to auto-retry - add inline status event so user knows
              store.getState().processEvent(turnId, {
                type: 'status',
                message: hasToolEvents
                  ? 'Connection lost after actions were taken. Please review and retry if needed.'
                  : 'Connection lost. Attachments need to be re-added to retry.',
                timestamp: Date.now(),
              });
            }
          }
        }

        // Persist current session to history after turn completes.
        // This ensures the session is saved to disk immediately rather than
        // relying solely on beforeunload, which can fail during crashes or
        // race with main process shutdown.
        const turnEndSnapshot = store.getState().snapshotCurrentSession();
        if (turnEndSnapshot) {
          store.getState().addOrUpdateHistorySession(turnEndSnapshot, true);
        }

        if (stoppingTurnIdRef.current === turnId) {
          store.getState().setIsStopping(false);
          stoppingTurnIdRef.current = null;
          stoppingTimer.clear();
          stopAbortWatchdog.clear();
          if (stoppedTurnsRef.current.has(turnId)) {
            toastNotifications.notifyRunStopped();
          }
        }

        setTimeout(() => {
          stoppedTurnsRef.current.delete(turnId);
        }, 5000);
      }
    },
    [
      clearOptimisticStartById,
      clearOptimisticStartForRealTurn,
      markSessionDone,
      reopenSessionIfDone,
      emitLog,
      handleRecoveryEvent,
      recordBreadcrumb,
      store,
      stoppingTimer,
      stopAbortWatchdog,
    ]
  );

  const assignTurnToSession = useCallback(
    (turnId: string, sessionId: string) => {
      turnSessionMapRef.current[turnId] = sessionId;
      const pending = pendingEventsRef.current[turnId];
      if (pending?.length) {
        delete pendingEventsRef.current[turnId];
        // Stage 19a refinement (Fix 1): thread the captured envelope provenance
        // so each queued live event is validated against its TRUE origin on
        // flush (same as the immediate path), not the `event.sessionId`/
        // accepted-legacy fallback.
        dispatchPendingEventsForTurn(turnId, sessionId, pending, processAgentEvent);
      }
      emitLog({
        level: 'debug',
        message: 'Run assigned to session',
        turnId,
        sessionId,
        context: { pendingEventsFlushed: pending?.length ?? 0 },
        timestamp: Date.now()
      });
    },
    [processAgentEvent, emitLog]
  );

  const resolveSessionId = useCallback(
    (turnId: string): string | null => {
      const direct = turnSessionMapRef.current[turnId];
      if (direct) return direct;

      const state = store.getState();
      if (getCurrentSessionEventsForTurn(turnId).length > 0) {
        assignTurnToSession(turnId, state.currentSessionId);
        return state.currentSessionId;
      }

      // Check sessionSummaries for activeTurnId match (covers most cases)
      // This is the primary lookup path for lazy loading - summaries contain activeTurnId
      const summaryMatch = state.sessionSummaries.find(s => s.activeTurnId === turnId);
      if (summaryMatch) {
        assignTurnToSession(turnId, summaryMatch.id);
        return summaryMatch.id;
      }

      // Check loaded sessions for eventsByTurn match (rare case - handles already-loaded sessions)
      for (const [id, session] of state.loadedSessions) {
        if (session.eventsByTurn?.[turnId]) {
          assignTurnToSession(turnId, id);
          return id;
        }
      }

      if (state.activeTurnId === turnId) {
        assignTurnToSession(turnId, state.currentSessionId);
        return state.currentSessionId;
      }

      return null;
    },
    [assignTurnToSession, store]
  );

  const handleVoiceRunFailure = useCallback(
    (message: string) => {
      store.getState().setError(message);
    },
    [store]
  );

  const initiateAgentTurn = useCallback(
    async (
      prompt: string,
      userMessage: AgentTurnMessage,
      resetConversation: boolean | undefined,
      capturedSessionId: string,
      source: 'voice' | 'text',
      attachments?: AnyAttachmentPayload[],
      options?: { isSystemContinuation?: boolean; proceedWithoutChiefOfStaff?: boolean; modelOverride?: string; thinkingModelOverride?: string; workingProfileOverrideId?: string; thinkingProfileOverrideId?: string; doneAfterComplete?: boolean; unleashedMode?: boolean; sessionType?: 'manual' | 'automation'; bypassToolSafety?: boolean; councilModeOverride?: boolean; continuationContext?: import('@shared/types').AgentTurnRequest['continuationContext']; supersedePolicy?: import('@shared/types').AgentTurnRequest['supersedePolicy'] }
    ) => {
      let optimisticTurnId: string | null = null;
      try {
        // Read session-level model overrides from store (fallback when no explicit per-turn override)
        const turnState = store.getState();

        // Resolve origin for the TARGET session, not the currently viewed session.
        // For cross-session turns (voice, queue drain, automation), the viewed session's
        // origin may differ from the target session's origin.
        let effectiveOrigin: typeof turnState.currentSessionOrigin;
        if (capturedSessionId !== turnState.currentSessionId) {
          const targetSummary = turnState.sessionSummaries.find((s) => s.id === capturedSessionId);
          effectiveOrigin = targetSummary
            ? normalizeCurrentSessionOrigin(targetSummary.origin, capturedSessionId)
            : 'manual';
        } else {
          effectiveOrigin = turnState.currentSessionOrigin;
        }

        const targetLoadedSession = turnState.loadedSessions.get(capturedSessionId);
        const sessionSystemPromptPrefix = targetLoadedSession?.systemPromptPrefix?.trim();
        const turnStart = await startTurnWithOptimisticLifecycle(
          {
            prompt,
            resetConversation,
            sessionId: capturedSessionId,
            attachments: attachments && attachments.length > 0 ? attachments : undefined,
            privateMode: turnState.privateMode || undefined,
            councilMode: options?.councilModeOverride ?? (turnState.councilMode || undefined),
            isSystemContinuation: options?.isSystemContinuation,
            // 260622 Stage 4: per-turn Chief-of-Staff admission bypass (recovery
            // escape). Set only when the user clicked "Run without my
            // instructions"; never persisted on the session.
            ...(options?.proceedWithoutChiefOfStaff ? { proceedWithoutChiefOfStaff: true } : {}),
            ...buildSessionModelOverrides(turnState, options ?? {}),
            unleashedMode: options?.unleashedMode,
            inputSource: source,
            sessionType: options?.sessionType,
            bypassToolSafety: options?.bypassToolSafety,
            origin: effectiveOrigin !== 'manual' ? effectiveOrigin : undefined,
            finishLine: turnState.currentSessionFinishLine ?? undefined,
            ...(options?.continuationContext ? { continuationContext: options.continuationContext } : {}),
            // Queue-intent admission policy ('reject' for non-interrupt sends —
            // never derived from messageOrigin). See useMessageQueue stamping +
            // docs/plans/260610_queue-drain-cancels-turn/PLAN.md Stage 3.
            ...(options?.supersedePolicy ? { supersedePolicy: options.supersedePolicy } : {}),
            ...(sessionSystemPromptPrefix ? { systemPromptPrefix: sessionSystemPromptPrefix } : {}),
          },
          capturedSessionId,
          turnState.currentSessionId,
        );
        const { turnId } = turnStart;
        optimisticTurnId = turnStart.optimisticTurnId;

        if (sessionSystemPromptPrefix) {
          turnState.clearSystemPromptPrefixForSession(capturedSessionId);
        }
        const runStartedAt = Date.now();
        turnStartTimesRef.current[turnId] = runStartedAt;

        // CRITICAL: Set doneAfterTurnId BEFORE assignTurnToSession to avoid race condition.
        // assignTurnToSession flushes pending events which could include the 'result' event.
        // If we set the flag after assignTurnToSession, the result handler might have already
        // run and the mark-done would never trigger.
        // Check both explicit doneAfterComplete option AND the toggle state for THIS session
        // (using per-session map to handle non-current sessions correctly)
        const sessionAutoDone = store.getState().autoDoneBySessionId[capturedSessionId] ?? false;
        if (options?.doneAfterComplete || sessionAutoDone) {
          store.getState().addDoneAfterTurnId(turnId);
          // Track explicit requests (e.g., Inbox execution) separately from toggle-sourced
          // so we can bypass the toggle re-check for explicit requests
          if (options?.doneAfterComplete) {
            explicitDoneRequestsRef.current.add(turnId);
          }
        }

        const state = store.getState();
        const sessionChanged = state.currentSessionId !== capturedSessionId;

        if (sessionChanged) {
          // Stage 7b: Check loadedSessions first, then try disk, then create new session
          let existingSession = state.loadedSessions.get(capturedSessionId);

          // If not in cache, attempt to load from disk unconditionally
          // (Don't gate on sessionSummaries - summaries could be incomplete/stale)
          if (!existingSession) {
            try {
              const loaded = await window.sessionsApi.get({ id: capturedSessionId });
              if (loaded) {
                // Session exists on disk - hydrate runtime and use it
                const runtime = buildRuntimeFromSnapshot(loaded.activeTurnId ?? null, loaded.eventsByTurn);
                existingSession = { ...loaded, runtime } as AgentSessionWithRuntime;
              }
              // If loaded is null/undefined, session truly doesn't exist - fall through to stub creation
            } catch (err) {
              // IPC error - log and fall through to stub creation (matches existing behavior)
              console.warn('[initiateAgentTurn] Failed to load session from disk, creating new session', {
                sessionId: capturedSessionId,
                error: err instanceof Error ? err.message : String(err)
              });
            }
          }

          // Only create new session if truly doesn't exist (not in cache AND not on disk)
          const targetSession: AgentSessionWithRuntime = existingSession ?? {
            id: capturedSessionId,
            title: createSessionTitle([userMessage], store.getState()._getSessionCounter()),
            createdAt: userMessage.createdAt,
            updatedAt: userMessage.createdAt,
            messages: [userMessage],
            eventsByTurn: {},
            activeTurnId: null,
            isBusy: false,
            lastError: null,
            resolvedAt: null,
            // New session is Active (doneAt null = Active).
            doneAt: null
          };

          // Check if user message exists in target session's messages.
          // If not found (e.g., message was added to current session via addUserMessage),
          // we need to INSERT it into the target session's messages.
          const messageExistsInTarget = targetSession.messages.some((msg) => msg.id === userMessage.id);
          let updatedMessages: AgentTurnMessage[];

          if (messageExistsInTarget) {
            // Message exists - just update it with turnId
            updatedMessages = targetSession.messages.map((msg) =>
              msg.id === userMessage.id ? { ...msg, turnId } : msg
            );
          } else {
            // Message doesn't exist in target session - INSERT it with turnId
            updatedMessages = [...targetSession.messages, { ...userMessage, turnId }];
          }

          const updatedSession: AgentSessionWithRuntime = {
            ...targetSession,
            messages: updatedMessages,
            eventsByTurn: { ...targetSession.eventsByTurn, [turnId]: [] },
            // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- Renderer optimistic turn-start marks the initiating turn active; durable write flows through sessionsApi.upsert -> IncrementalSessionStore stamp.
            activeTurnId: turnId,
            // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- Optimistic runtime start needs immediate busy UI state; persistence path re-derives/stamps liveness from events.
            isBusy: true,
            updatedAt: deriveInteractionTimestamp(updatedMessages, runStartedAt),
            runtime: primeRuntimeForTurn(turnId, runStartedAt)
          };

          store.getState().addOrUpdateHistorySession(updatedSession, true);
          assignTurnToSession(turnId, capturedSessionId);

          emitLog({
            level: 'info',
            message: `Agent run initiated from ${source} (session changed during IPC)`,
            turnId,
            sessionId: capturedSessionId,
            context: {
              promptLength: prompt.length,
              attachments: attachments?.length ?? 0,
              messageInserted: !messageExistsInTarget,
              targetMessageCount: updatedMessages.length,
              currentSessionId: state.currentSessionId,
            },
            timestamp: Date.now()
          });
        } else {
          store.getState().assignTurnToMessage(userMessage.id, turnId, runStartedAt);
          assignTurnToSession(turnId, capturedSessionId);

          emitLog({
            level: 'info',
            message: `Agent run initiated from ${source}`,
            turnId,
            sessionId: capturedSessionId,
            context: { promptLength: prompt.length, attachments: attachments?.length ?? 0 },
            timestamp: Date.now()
          });
        }
      } catch (err) {
        clearOptimisticStartById(optimisticTurnId);
        if (isTargetBusyRejection(err)) {
          // Typed admission refusal: the target session has an active turn and
          // this was a queue-mode (reject-policy) send. NOT a failure — the
          // queue requeues the message and retries when the target goes idle,
          // so no setError / no "run failed" toast; rethrow for the dispatch
          // site. Cross-session sends leave no orphan message here (the target
          // insert happens only in the post-IPC sessionChanged branch above).
          // See docs/plans/260610_queue-drain-cancels-turn/PLAN.md Stage 3.
          emitLog({
            level: 'info',
            message: 'Agent turn refused at admission: target session busy (queue-mode send never supersedes)',
            sessionId: capturedSessionId,
            context: { source },
            timestamp: Date.now()
          });
          throw err;
        }
        store.getState().setError(err instanceof Error ? err.message : String(err));
        emitLog({
          level: 'error',
          message: `Failed to launch agent run from ${source}`,
          context: { error: err instanceof Error ? err.message : String(err) },
          timestamp: Date.now()
        });
        toastNotifications.notifyRunFailed();
      }
    },
    [assignTurnToSession, clearOptimisticStartById, emitLog, startTurnWithOptimisticLifecycle, store]
  );

  /**
   * Validates and resolves the target session for a message.
   * If the target session was explicitly deleted (soft-deleted), falls back to current session with a toast.
   * If the target session simply doesn't exist in history (e.g., brand-new session that was never
   * snapshotted because it had no content), we TRUST the targetSessionId and let initiateAgentTurn
   * create the session on-the-fly.
   * This MUST be called BEFORE any store mutations to prevent messages going to deleted sessions.
   */
  const resolveTargetSession = useCallback(
    (targetSessionId?: string): string => {
      const state = store.getState();

      // No target specified - use current (backward compat)
      if (!targetSessionId) return state.currentSessionId;

      // Target is current - no lookup needed
      if (targetSessionId === state.currentSessionId) return targetSessionId;

      // Stage 7b: Look up target in summaries (only need deletedAt for this check)
      const sessionSummary = state.sessionSummaries.find((s) => s.id === targetSessionId);

      // CRITICAL FIX: Only fallback if session is EXPLICITLY soft-deleted.
      // If session simply doesn't exist in history (e.g., brand-new empty session that was
      // discarded when user switched away), trust the targetSessionId and let initiateAgentTurn
      // create/resurrect it. This fixes the bug where voice transcripts for new sessions
      // would incorrectly route to the current session.
      if (sessionSummary?.deletedAt) {
        showToast({ title: 'Original conversation was deleted. Added to current conversation.' });
        emitLog({
          level: 'info',
          message: 'Voice transcript fallback: original session was soft-deleted',
          context: { originalSessionId: targetSessionId, fallbackSessionId: state.currentSessionId },
          timestamp: Date.now()
        });
        return state.currentSessionId;
      }

      // Session exists and is not deleted, OR session doesn't exist in summaries
      // (will be created by initiateAgentTurn)
      if (!sessionSummary) {
        emitLog({
          level: 'info',
          message: 'Target session not in history, will be created on-the-fly',
          context: { targetSessionId },
          timestamp: Date.now()
        });
      }

      return targetSessionId;
    },
    [emitLog, showToast, store]
  );

  const processMessage = useCallback(
    async (
      messageText: string,
      source: 'voice' | 'text' = 'text',
      attachments?: AnyAttachmentPayload[],
      existingMessageId?: string,
      targetSessionId?: string,
      options?: { isSystemContinuation?: boolean; proceedWithoutChiefOfStaff?: boolean; modelOverride?: string; thinkingModelOverride?: string; doneAfterComplete?: boolean; unleashedMode?: boolean; sessionType?: RendererSessionType; bypassToolSafety?: boolean; councilModeOverride?: boolean; isHidden?: boolean; displayText?: string; messageOrigin?: import('@shared/types').AgentTurnMessage['messageOrigin']; continuationContext?: import('@shared/types').AgentTurnRequest['continuationContext']; supersedePolicy?: import('@shared/types').AgentTurnRequest['supersedePolicy'] }
    ) => {
      // Validate and resolve target session FIRST - before any store mutations.
      // This handles the edge case where the original session was deleted while
      // transcription was in progress (voice mode session switching bug).
      const resolvedSessionId = resolveTargetSession(targetSessionId);

      // Clear any pending network retry for this session - user's new message
      // supersedes it. For reject-policy (queue-mode) dispatches the clear is
      // DEFERRED until the turn is actually admitted: with deleteCache=true the
      // eager clear irreversibly deletes persisted retry state + attachment
      // cache, so a typed admission refusal would silently kill the interrupted
      // turn's auto-resume (FMM 14, GPT F4 — plan 260610_queue-drain-cancels-turn).
      const isRejectPolicyDispatch = options?.supersedePolicy === 'reject';
      if (!isRejectPolicyDispatch) {
        store.getState().clearPendingTurnForSession(resolvedSessionId, true);
      }

      // Extract metadata for store (exclude large content/data fields)
      const attachmentMeta = attachments?.map(stripAttachmentData);

      // Collect extracted text from document attachments for session recovery.
      // When the session is lost, buildConversationHistoryContext uses this
      // to include document content that would otherwise be lost.
      let attachmentTexts: Record<string, string> | undefined;
      if (attachments) {
        for (const att of attachments) {
          if (isDocumentAttachment(att) && att.extractedText) {
            attachmentTexts ??= {};
            attachmentTexts[att.name] = att.extractedText;
          } else if (isExtractedPdfAttachment(att)) {
            attachmentTexts ??= {};
            attachmentTexts[att.name] = att.extractedText;
          } else if (isOfficeDocumentAttachment(att)) {
            attachmentTexts ??= {};
            attachmentTexts[att.name] = att.extractedText;
          } else if (isTextFileAttachment(att)) {
            attachmentTexts ??= {};
            attachmentTexts[att.name] = att.content;
          }
        }
      }

      const state = store.getState();

      // Use resolved session ID (already validated - falls back to current if deleted)
      const effectiveSessionId = resolvedSessionId;
      const isTargetingDifferentSession = resolvedSessionId !== state.currentSessionId;

      let userMessage = store.getState().messages.find((m) => m.id === existingMessageId && m.role === 'user');

      if (!userMessage) {
        if (isTargetingDifferentSession) {
          // CRITICAL: When targeting a different session, DO NOT add to current session's store.
          // Create the message object directly - it will be inserted into the target session
          // by the sessionChanged branch in initiateAgentTurn.
          userMessage = {
            // Reuse a provided-but-not-found existingMessageId (e.g. refusal
            // requeue re-drained after a session switch): a stable id lets
            // initiateAgentTurn's messageExistsInTarget check dedup against a
            // message already persisted to the target session (FMM 9).
            id: existingMessageId ?? createId(),
            turnId: TURN_ID_FALLBACK,
            role: 'user' as const,
            text: messageText,
            createdAt: Date.now(),
            attachments: attachmentMeta && attachmentMeta.length > 0 ? attachmentMeta as AgentAttachmentMeta[] : undefined,
            attachmentTexts,
            isHidden: options?.isHidden,
            displayText: options?.displayText,
            messageOrigin: options?.messageOrigin,
          };
          // Clear the draft for the target session IF the draft text matches the
          // outgoing message. This targets the queue-drain-after-session-switch case
          // (where the draft IS the message) without wiping unrelated drafts for other
          // cross-session senders (voice transcripts, network reconnect, automation).
          const targetDraft = store.getState().draftsBySessionId[effectiveSessionId];
          if (targetDraft?.text?.trim() === messageText.trim()) {
            store.getState().setDraftForSession(effectiveSessionId, '');
          }
        } else {
          // Normal case: add to current session
          userMessage = store.getState().addUserMessage(messageText, attachmentMeta as AgentAttachmentMeta[], { attachmentTexts, isHidden: options?.isHidden, displayText: options?.displayText, messageOrigin: options?.messageOrigin });
        }
      }

      // userMessage is always assigned above — either found, created for cross-session, or added to store
      if (!userMessage) throw new Error('Invariant: userMessage must be set after message creation');

      // Diagnostic: log message routing for cross-session turns (helps debug message cross-contamination)
      if (isTargetingDifferentSession) {
        emitLog({
          level: 'info',
          message: 'Cross-session message routed',
          context: {
            targetSessionId: effectiveSessionId,
            currentSessionId: state.currentSessionId,
            currentMessageCount: state.messages.length,
            messagePreview: messageText.slice(0, 60),
          },
          timestamp: Date.now()
        });
      }

      recordBreadcrumb({
        type: 'user-input',
        message: `${source}-prompt-queued`,
        timestamp: userMessage.createdAt,
        data: { length: messageText.length, attachments: attachmentMeta?.length ?? 0, resolvedSessionId, isTargetingDifferentSession }
      });

      analyticsTracker.trackMessageSent({
        source,
        sessionId: effectiveSessionId,
        hasAttachments: Boolean(attachments?.length),
        attachmentCount: attachments?.length ?? 0,
        isEdit: false,
        charCount: messageText.length
      });

      // Track file mentions (count @`path/to/file` patterns in the message)
      const fileMentionMatches = messageText.match(/@`[^`]+`/g);
      if (fileMentionMatches && fileMentionMatches.length > 0) {
        analyticsTracker.trackFileMentioned(effectiveSessionId, fileMentionMatches.length);
      }

      try {
        await initiateAgentTurn(
          messageText,
          userMessage,
          undefined, // Main process determines resetConversation from session index
          effectiveSessionId,
          source,
          attachments,
          options as Parameters<typeof initiateAgentTurn>[6],
        );
      } catch (err) {
        if (isTargetBusyRejection(err)) {
          // Same-session dispatches persisted the user message (addUserMessage)
          // BEFORE the IPC call; attach its id so the queue's requeue carries
          // existingMessageId and the re-drain dedups instead of duplicating
          // the message (FMM 9). Renderer-side enrichment — never crosses IPC.
          throw attachRequeueMessageId(err, userMessage.id);
        }
        throw err;
      }

      if (isRejectPolicyDispatch) {
        // Deferred clear (see top of processMessage): the turn was admitted
        // without a typed refusal, so the new message now genuinely supersedes
        // any pending network-retry state for this session.
        store.getState().clearPendingTurnForSession(resolvedSessionId, true);
      }
    },
    [emitLog, initiateAgentTurn, recordBreadcrumb, resolveTargetSession, store]
  );

  const requestCouncilReview = useCallback(() => {
    processMessage(COUNCIL_REVIEW_PROMPT, 'text', undefined, undefined, undefined, { councilModeOverride: true });
  }, [processMessage]);

  const beginEditMessage = useCallback(
    (messageId: string): AgentTurnMessage | null => {
      const state = store.getState();
      // Allow edit mode entry anytime - even while agent is busy.
      // This enables a "draft overlay" UX: user can enter edit mode while agent runs,
      // prepare their edit, then either:
      // - Submit: useMessageQueue queues the edit, stops agent, then processes it
      // - Cancel: exits edit mode, agent continues (or shows completed response)
      // The actual stop + truncate + rerun happens on submission, not on edit entry.
      const message = state.messages.find((m) => m.id === messageId);
      if (!message || message.role !== 'user') {
        emitLog({
          level: 'warn',
          message: 'beginEditMessage: target message not found or not user message',
          context: { messageId },
          timestamp: Date.now()
        });
        return null;
      }
      store.getState().setEditingMessageId(messageId);
      analyticsTracker.trackMessageEditStarted(messageId, state.currentSessionId);
      return message;
    },
    [emitLog, store]
  );

  const beginEditLastUserMessage = useCallback((): AgentTurnMessage | null => {
    const state = store.getState();
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'user') {
        return beginEditMessage(state.messages[i].id);
      }
    }
    return null;
  }, [beginEditMessage, store]);

  const cancelEditMessage = useCallback(() => {
    const state = store.getState();
    const editingId = state.editingMessageId;
    if (editingId) {
      analyticsTracker.trackMessageEditCancelled(editingId, state.currentSessionId);
    }
    store.getState().setEditingMessageId(null);
  }, [store]);

  const rerunEditedMessage = useCallback(
    async (targetMessageId: string, newText: string, source: 'text' | 'voice', attachments?: AnyAttachmentPayload[]) => {
      // If we're in stopping state, clear it since the user's edit supersedes the stop.
      // This prevents stale stopping handlers from interfering with the new turn.
      const currentState = store.getState();
      if (currentState.isStopping) {
        store.getState().setIsStopping(false);
        stoppingTimer.clear();
        stopAbortWatchdog.clear();
        stoppingTurnIdRef.current = null;
      }

      const trimmed = newText.trim();
      if (!trimmed) return;

      const state = store.getState();
      const targetIndex = state.messages.findIndex((m) => m.id === targetMessageId);

      // Clear any pending network retry for current session - user's edit supersedes it
      store.getState().clearPendingTurnForSession(state.currentSessionId, true);
      if (targetIndex === -1 || state.messages[targetIndex].role !== 'user') {
        store.getState().setEditingMessageId(null);
        return;
      }

      // Track message edit submitted
      const originalText = state.messages[targetIndex].text;
      const charDelta = trimmed.length - originalText.length;
      analyticsTracker.trackMessageEditSubmitted(targetMessageId, state.currentSessionId, charDelta);

      // Build conversation context from messages before the edited message.
      // This is needed because we reset the agent session, so Claude won't have
      // prior context unless we embed it in the prompt.
      const contextPreamble = buildConversationContextForEdit(state.messages, targetIndex);
      const promptWithContext = contextPreamble ? `${contextPreamble}${trimmed}` : trimmed;

      // Extract metadata for store (exclude large content/data fields)
      const attachmentMeta = attachments?.map(stripAttachmentData);
      store.getState().truncateToMessage(targetMessageId, trimmed, attachmentMeta as AgentAttachmentMeta[]);

      let optimisticTurnId: string | null = null;
      try {
        const capturedSessionId = store.getState().currentSessionId;
        // Use resetConversation: true to clear agent session state.
        // Prior context is embedded in promptWithContext.
        const editTurnState = store.getState();
        optimisticTurnId = pushOptimisticStartForSession(
          capturedSessionId,
          editTurnState.currentSessionId,
        );
        const { turnId } = await window.agentApi.turn({
          prompt: promptWithContext,
          resetConversation: true,
          sessionId: capturedSessionId,
          ...(optimisticTurnId ? { clientTurnId: optimisticTurnId } : {}),
          attachments: attachments && attachments.length > 0 ? attachments : undefined,
          privateMode: editTurnState.privateMode || undefined,
          councilMode: editTurnState.councilMode || undefined,
          inputSource: source,
          ...buildSessionModelOverrides(editTurnState),
          origin: editTurnState.currentSessionOrigin !== 'manual' ? editTurnState.currentSessionOrigin : undefined,
          finishLine: editTurnState.currentSessionFinishLine ?? undefined,
        });
        bindOptimisticStartToRealTurn(turnId, optimisticTurnId);
        const runStartedAt = Date.now();
        turnStartTimesRef.current[turnId] = runStartedAt;

        // Add to doneAfterTurnIds if auto-done is enabled for THIS session (same as initiateAgentTurn).
        // CRITICAL: Must be set BEFORE assignTurnToSession to avoid race with event flush.
        // Use per-session map for correct behavior when editing non-current session.
        const sessionAutoDone = store.getState().autoDoneBySessionId[capturedSessionId] ?? false;
        if (sessionAutoDone) {
          store.getState().addDoneAfterTurnId(turnId);
        }

        store.getState().assignTurnToMessage(targetMessageId, turnId, runStartedAt);
        assignTurnToSession(turnId, capturedSessionId);

        emitLog({
          level: 'info',
          message: `Agent run initiated from edited ${source} message`,
          turnId,
          sessionId: capturedSessionId,
          context: { targetMessageId, promptLength: promptWithContext.length, hasContextPreamble: !!contextPreamble },
          timestamp: Date.now()
        });
      } catch (err) {
        clearOptimisticStartById(optimisticTurnId);
        store.getState().setError(err instanceof Error ? err.message : String(err));
        emitLog({
          level: 'error',
          message: 'Failed to launch agent run from edited message',
          context: { error: err instanceof Error ? err.message : String(err) },
          timestamp: Date.now()
        });
        toastNotifications.notifyEditedRunFailed();
      } finally {
        store.getState().setEditingMessageId(null);
      }
    },
    [
      assignTurnToSession,
      bindOptimisticStartToRealTurn,
      clearOptimisticStartById,
      emitLog,
      pushOptimisticStartForSession,
      store,
      stoppingTimer,
      stopAbortWatchdog,
    ]
  );

  const stopActiveTurn = useCallback(async () => {
    const state = store.getState();
    const projectedLiveness = getCurrentSessionProjectedLiveness(state.activeTurnId);
    const projectedBusy = projectedLiveness.status === 'running';

    // Guard against double-click: if already stopping, don't re-enter
    if (state.isStopping) {
      return;
    }

    if (!projectedBusy) {
      emitLog({ level: 'warn', message: 'Attempted to stop run but no active run found', timestamp: Date.now() });
      return;
    }

    // Use the runtime shadow first, then state.activeTurnId (processing) as fallback.
    // During the C-lite transition both values should converge on the processing turn.
    const processingTurnId = state.runtime.activeTurnId ?? projectedLiveness.activeTurnId;

    // Zombie-state recovery: if the UI is busy but we don't have a turnId, we cannot
    // send a stop IPC. Clear busy so queued messages can drain (starting a new turn
    // will still cancel any existing active turn server-side via deduplication).
    if (!processingTurnId) {
      emitLog({
        level: 'warn',
        message: 'Stop requested while busy but no activeTurnId - clearing busy state',
        sessionId: state.currentSessionId,
        context: {
          isBusy: projectedBusy,
          activeTurnId: state.activeTurnId,
          runtimeActiveTurnId: state.runtime.activeTurnId,
          projectedActiveTurnId: projectedLiveness.activeTurnId,
        },
        timestamp: Date.now()
      });
      forceTerminalizeCurrentProjectedTurn('Stop requested without active turn id');
      return;
    }

    const turnId = processingTurnId;
    const turnIdSource = state.runtime.activeTurnId ? 'runtime' : 'fallback';
    const sessionId = state.currentSessionId;
    const turnStartTime = turnStartTimesRef.current[turnId] ?? Date.now();
    const elapsedMs = Date.now() - turnStartTime;

    store.getState().setIsStopping(true);
    toastNotifications.notifyStoppingRun();
    stoppingTurnIdRef.current = turnId;

    // Track turn interrupted
    analyticsTracker.trackTurnInterrupted(turnId, sessionId, elapsedMs, 'user');

    stoppingTimer.set(async () => {
      // Turn still active after 10s — retry stop IPC which will escalate to force-kill
      // via Query.close() in the main process (re-stop on already-aborted controller)
      const turnStillBusy = isCurrentSessionProjectionBusy(store.getState());
      if (turnStillBusy && turnId) {
        try {
          await window.agentApi.stopTurn(turnId);
        } catch { /* ignore — force-kill is best-effort */ }
      }
      store.getState().setIsStopping(false);
      stoppingTurnIdRef.current = null;
    }, 10000);

    // Stage 3 Phase 6 — Abort-path orphan attribute hazard (Behavioral-safety, HIGH).
    // The dispatcher emits a terminal `result`/`error` event after force-kill (`agentTurnService.ts:309-342`)
    // which clears `isBusy` via the renderer's processEvent. But if main hangs, the IPC
    // bridge crashes, or the event is dropped, neither stoppingTimer nor the existing
    // 15s self-heal watchdog (which only triggers when a terminal IS in events but state
    // didn't update) covers the case where no terminal event arrives at all. The body
    // `[data-active-work]` attribute orphans, leaving the UI stuck in busy state.
    //
    // 30s renderer-side fallback: if the same `turnId` is still busy after 30s, append
    // a renderer-local terminal marker and clear optimistic runtime state. This keeps
    // the projection from re-priming `running` while preserving idempotence. The watchdog
    // is cleared at every site that already clears `stoppingTimer`
    // (terminal-event path, rerun-edited-message, stopTurn-not-found, stopTurn-IPC-exception)
    // so legitimate paths never trip it.
    stopAbortWatchdog.set(() => {
      const watchdogState = store.getState();
      const watchdogLiveness = getCurrentSessionProjectedLiveness(
        watchdogState.activeTurnId,
      );
      if (
        watchdogLiveness.status === 'running'
        && watchdogLiveness.activeTurnId === turnId
      ) {
        emitLog({
          level: 'warn',
          message: 'Stop watchdog: terminal event never arrived after retry IPC; force-clearing isBusy',
          turnId,
          sessionId: watchdogState.currentSessionId,
          context: { turnIdSource },
          timestamp: Date.now(),
        });
        captureRendererException(
          new Error('Stop watchdog fired: terminal event never arrived after retry IPC'),
          { tags: { turnId, sessionId: watchdogState.currentSessionId ?? undefined } },
        );
        forceTerminalizeCurrentProjectedTurn('Stop watchdog terminalized projected turn');
      }
    }, 30_000);

    try {
      stoppedTurnsRef.current.add(turnId);

      // Clear transient thinking buffer before recovery fallback runs
      store.getState().clearThinkingBuffer(turnId);

      // Recover partial assistant text from eventsByTurn if no message was preserved.
      // When thinking-style text is removed by isThinkingStyle on tool start, there is
      // no trace of the agent's work otherwise.
      // NOTE: processEvent for 'assistant' sets isBusy=true as a side effect. This is safe
      // because isStopping is already true and the subsequent stopTurn IPC will trigger a
      // result event that clears isBusy.
      const hasMessageForTurn = store.getState().messages.some(
        (m) => m.turnId === turnId && (m.role === 'assistant' || m.role === 'result')
      );
      if (!hasMessageForTurn) {
        const turnEvents = getCurrentSessionEventsForTurn(turnId);
        const assistantTexts = turnEvents
          .filter((e): e is Extract<AgentEvent, { type: 'assistant' }> =>
            e.type === 'assistant' && Boolean(e.text?.trim())
          )
          .map((e) => e.text.trim());
        const lastAssistantText = assistantTexts[assistantTexts.length - 1];
        if (lastAssistantText) {
          store.getState().processEvent(turnId, {
            type: 'assistant',
            text: lastAssistantText,
            timestamp: Date.now()
          });
          emitLog({
            level: 'debug',
            message: 'Recovered partial assistant text from eventsByTurn on stop',
            turnId,
            context: { textLength: lastAssistantText.length },
            timestamp: Date.now()
          });
        }
      }

      const result = await window.agentApi.stopTurn(turnId);
      if (!result.success) {
        // "Not found" means turn already completed or was never started - treat as success.
        // This handles race conditions where:
        // 1. Turn completes between stop click and IPC handler (completion race)
        // 2. Tool/memory approval flow ended turn before stop click (zombie busy state)
        // The turn IS stopped (or was never running), so clear state without error toast.
        emitLog({
          level: 'info',
          message: 'Stop turn returned not found - turn already completed',
          turnId,
          sessionId,
          context: { turnIdSource },
          timestamp: Date.now()
        });
        const wasOptimisticOnlyTurnId = Boolean(
          pendingOptimisticStartByClientTurnIdRef.current[turnId],
        );
        if (wasOptimisticOnlyTurnId) {
          preAckStopIntentByClientTurnIdRef.current[turnId] = Date.now();
        } else {
          stoppedTurnsRef.current.delete(turnId);
        }
        store.getState().setIsStopping(false);
        stoppingTurnIdRef.current = null;
        stoppingTimer.clear();
        stopAbortWatchdog.clear();
        // Force-clear busy state to resync UI (turn is gone, UI should reflect that)
        forceTerminalizeCurrentProjectedTurn('Stop returned not found');
      }
    } catch (err) {
      // Stop IPC itself threw an exception (rare). Possible causes:
      // 1. Electron IPC bridge error (context isolation failure, renderer crash)
      // 2. Main handler threw (e.g., invalid turnId validation - indicates a bug)
      // 3. Serialization error in IPC contract
      //
      // In ALL these cases, we cannot reliably know if the turn was stopped.
      // We force-clear state because:
      // - Leaving UI stuck in "busy" forever is worse UX than clearing
      // - If turn is still running, it will complete and fire events (eventual consistency)
      // - User is notified via toast so they know something unusual happened
      emitLog({
        level: 'error',
        message: 'Stop turn IPC exception - force-clearing busy state',
        turnId,
        sessionId,
        context: {
          turnIdSource,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined
        },
        timestamp: Date.now()
      });
      recordBreadcrumb({
        type: 'ipc-error',
        message: 'stopTurn IPC exception',
        timestamp: Date.now(),
        data: { turnId, error: err instanceof Error ? err.message : String(err) }
      });
      stoppedTurnsRef.current.delete(turnId);
      store.getState().setIsStopping(false);
      stoppingTurnIdRef.current = null;
      stoppingTimer.clear();
      stopAbortWatchdog.clear();
      // Force-clear busy state to resync UI and notify user
      forceTerminalizeCurrentProjectedTurn('Stop IPC exception');
      toastNotifications.notifyStopRequestFailed();
    }
  }, [emitLog, forceTerminalizeCurrentProjectedTurn, recordBreadcrumb, store, stoppingTimer, stopAbortWatchdog]);

  const snapshotCurrentConversation = useCallback((): AgentSessionWithRuntime | null => {
    return store.getState().snapshotCurrentSession();
  }, [store]);

  /** Foreground session reset: snapshots current session, creates a new one, and switches to it.
   * For background session creation without switching, use store.createBackgroundSession(). */
  const resetSessionState = useCallback((): string => {
    console.warn('[useAgentSessionEngine] resetSessionState called');
    const snapshot = snapshotCurrentConversation();
    if (snapshot) {
      sessionTitleOverridesRef.current[snapshot.id] = snapshot.title;
    }
    const nextSessionId = store.getState().resetSession();
    delete sessionTitleOverridesRef.current[nextSessionId];

    // Clear turn tracking refs for clean slate on new session
    turnSessionMapRef.current = {};
    pendingEventsRef.current = {};
    turnStartTimesRef.current = {};
    optimisticTurnIdByRealTurnIdRef.current = {};
    pendingOptimisticStartByClientTurnIdRef.current = {};
    preAckRealTurnSeenAtRef.current = {};
    preAckStopIntentByClientTurnIdRef.current = {};
    turnFirstResponseTimesRef.current = {};
    stoppedTurnsRef.current.clear();

    emitLog({ level: 'info', message: 'Conversation reset', sessionId: currentSessionId, timestamp: Date.now() });
    return nextSessionId;
  }, [currentSessionId, emitLog, snapshotCurrentConversation, store]);

  const openHistorySession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      // PERF INSTRUMENTATION
      const engineStart = performance.now();

      // Captured BEFORE any await for the miss-path origin guard: if the
      // current session changes while our IPC load is in flight via a door
      // that doesn't bump the request counter (new chat / resetSession,
      // deletion, clear-all), the user navigated away and this load lost.
      const originSessionId = store.getState().currentSessionId;

      // INVARIANT: The buffer flush and store.openHistorySession() call must happen
      // without any await between them (cache-hit path). For cache-miss, a second
      // flush after the IPC await handles events that arrived during the load.

      // PERF: Flush any buffered background events before switching to this session.
      // processHistoryEvent batches non-terminal events for background sessions.
      // Without this flush, the LRU cache entry would be stale (missing recent events).
      const bufferedEvents = takeBackgroundEventBuffer(sessionId);
      if (bufferedEvents.length > 0) {
        // Use fresh state to avoid stale reads if a concurrent terminal event updated the cache
        const freshState = store.getState();
        const cached = freshState.loadedSessions.get(sessionId);
        if (cached) {
          const updated = applySessionSwitchBufferedUnion(cached, bufferedEvents);
          freshState.cacheSession(updated);
        }
        persistSessionSwitchBufferedUnion(sessionId, bufferedEvents);
        emitLog({
          level: 'debug',
          message: 'Flushed background event buffer on session switch',
          sessionId,
          context: { eventCount: bufferedEvents.length },
          timestamp: Date.now()
        });
      }

      // Step 1: Check LRU cache first (fastest path)
      let session = store.getState().getLoadedSession(sessionId);
      const wasCacheHit = session !== undefined;

      // Full-fidelity events from disk (not compacted by LRU cache).
      // The LRU cache strips tool detail via compactCompletedTurns for memory,
      // but we need full detail for the active session's external event Map
      // so persistence doesn't lose data. See eventCompaction.ts.
      let fullFidelityEvents: Record<string, AgentEvent[]> | undefined;
      let cacheHitDiskEventsPromise: Promise<Record<string, AgentEvent[]> | null> | null = null;

      // Step 2: If not found, load via IPC (lazy loading)
      if (!session) {
        // Capture request ID for race condition handling
        sessionLoadRequestCounter += 1;
        const thisRequestId = sessionLoadRequestCounter;

        // Set loading state
        store.getState().setLoadingSession(sessionId);

        // PERF INSTRUMENTATION
        const ipcStart = performance.now();
        try {
          let loaded = await window.sessionsApi.get({ id: sessionId });
          const ipcEnd = performance.now();
          if (import.meta.env.VITE_PERFORMANCE === 'true') {
            console.warn(`[PERF] IPC sessions:get took ${(ipcEnd - ipcStart).toFixed(1)}ms`);
          }

          // Race condition check: if a newer request came in, abort this one
          if (sessionLoadRequestCounter !== thisRequestId) {
            emitLog({
              level: 'debug',
              message: 'Session load abandoned - newer request in flight',
              sessionId,
              context: { thisRequestId, currentRequestId: sessionLoadRequestCounter },
              timestamp: Date.now()
            });
            // Do NOT clear loading state here: the newer request that bumped
            // the counter owns it now — for a same-session duplicate open,
            // loadingSessionId === sessionId belongs to THAT request, and a
            // different-session/apply winner manages it in its own branches.
            return false;
          }

          // Origin guard: the current session changed while this load was in
          // flight via a flow that doesn't participate in the counter
          // protocol (new chat / resetSession, deletion, clear-all). The
          // user's last navigation wins; this load must not apply over it.
          if (store.getState().currentSessionId !== originSessionId) {
            emitLog({
              level: 'debug',
              message: 'Session load abandoned - current session changed during load',
              sessionId,
              context: { originSessionId, currentSessionId: store.getState().currentSessionId },
              timestamp: Date.now()
            });
            if (store.getState().loadingSessionId === sessionId) {
              store.getState().setLoadingSession(null);
            }
            return false;
          }

          // Clear loading state
          store.getState().setLoadingSession(null);

          if (!loaded) {
            emitLog({ level: 'warn', message: 'Session not found via IPC', sessionId, timestamp: Date.now() });
            return false;
          }

          // CRITICAL: Rebuild runtime from events to detect active turns
          // Without this, sessions with active turns show stuck spinners
          const sessionRuntime = buildRuntimeFromSnapshot(
            loaded.activeTurnId ?? null,
            loaded.eventsByTurn
          );
          const isStale = isTurnStale(sessionRuntime);

          // Check for interrupted turns (app crash mid-turn)
          if (loaded.activeTurnId) {
            const turnEvents = loaded.eventsByTurn?.[loaded.activeTurnId] ?? [];
            const turnCompleted = turnEvents.some(e => e.type === 'result' || e.type === 'error');
            if (!turnCompleted) {
              if (isStale) {
                // Stale interrupted turn — last event is older than threshold.
                // The main process can't still be running this turn; clear busy state
                // so the user doesn't see a timer counting from hours/days ago (FOX-2884).
                emitLog({
                  level: 'info',
                  message: 'Cleared stale interrupted turn',
                  sessionId,
                  context: {
                    turnId: loaded.activeTurnId,
                    lastActivityAt: sessionRuntime.lastActivityAt,
                    startedAt: sessionRuntime.startedAt,
                  },
                  timestamp: Date.now()
                });
                loaded = {
                  ...loaded,
                  isBusy: false,
                  activeTurnId: null,
                };
                // Persist correction so it survives app restart
                window.sessionsApi.upsert(
                  stripRuntime({ ...loaded, runtime: sessionRuntime }),
                )
                  .then((r) => { if (r && !r.success) console.warn(`[useAgentSessionEngine] persist failed for ${sessionId}`, r?.error); })
                  .catch((err) => { console.warn(`[useAgentSessionEngine] persist rejected for ${sessionId}`, err); });
              } else {
                emitLog({
                  level: 'info',
                  message: 'Loaded session with interrupted turn (recent — may still be active)',
                  sessionId,
                  context: { turnId: loaded.activeTurnId },
                  timestamp: Date.now()
                });
              }
            }
          }

          // Reset runtime when stale turn was cleared
          const effectiveRuntime = isStale ? createRuntimeState() : sessionRuntime;
          session = { ...loaded, runtime: effectiveRuntime };

          // Capture full-fidelity events BEFORE cacheSession compacts them
          fullFidelityEvents = session.eventsByTurn;

          // Cache the loaded session (compacts completed turn events for memory)
          store.getState().cacheSession(session);

          // Flush any events that arrived during the IPC await (race condition prevention)
          const lateBuffered = takeBackgroundEventBuffer(sessionId);
          if (lateBuffered.length > 0) {
            const cached = store.getState().loadedSessions.get(sessionId);
            if (cached) {
              const updated = applySessionSwitchBufferedUnion(cached, lateBuffered);
              store.getState().cacheSession(updated);
            }
            persistSessionSwitchBufferedUnion(sessionId, lateBuffered);
            emitLog({
              level: 'debug',
              message: 'Flushed late background events after IPC load',
              sessionId,
              context: { eventCount: lateBuffered.length },
              timestamp: Date.now()
            });
          }

        } catch (err) {
          // Clear loading state on error — only if this request still owns
          // the protocol (no newer request bumped the counter) AND loading
          // still points at our session. A stale request's late failure must
          // not stomp a newer load's state — including a same-session
          // duplicate open, whose loadingSessionId equals ours (reviewer F1).
          if (
            sessionLoadRequestCounter === thisRequestId &&
            store.getState().loadingSessionId === sessionId
          ) {
            store.getState().setLoadingSession(null);
          }
          emitLog({
            level: 'error',
            message: 'Failed to load session via IPC',
            sessionId,
            context: { error: err instanceof Error ? err.message : String(err) },
            timestamp: Date.now()
          });
          return false;
        }
      }
      // Cache-hit optimization (Phase 2): don't block session open on disk fetch.
      // We still fetch full-fidelity events in the background and hydrate the
      // currently-open session once they arrive.
      if (wasCacheHit && !fullFidelityEvents) {
        cacheHitDiskEventsPromise = window.sessionsApi.get({ id: sessionId })
          .then((diskSession) => diskSession?.eventsByTurn ?? null)
          .catch(() => null);
      }

      // Now we have a session - check if it's valid
      if (session.isCorrupted) {
        toastNotifications.notifyCorruptedSession();
        return false;
      }

      // Deleted (soft-deleted) sessions are allowed to open read-only: the
      // conversation surface shows a Trash banner and disables the composer
      // (see `isCurrentSessionTrashed` / `selectedTrashedSessionId`). Restoring
      // is offered from that banner. We no longer block the load here.

      // Preserve title override for current session before switching
      const currentId = store.getState().currentSessionId;
      sessionTitleOverridesRef.current[currentId] = store.getState().currentSessionTitle;

      // Switch to the loaded session via store action
      // PERF INSTRUMENTATION
      const storeStart = performance.now();
      // Applies supersede ALL in-flight loads: any open that reaches this
      // apply (cache hit or miss) invalidates every pending miss-path
      // continuation via its stale-counter check. Failed opens (corrupted /
      // not-found, returned false above) do NOT supersede — the asymmetry
      // with the miss path's entry bump is intentional and
      // preservation-tested. Miss opens thereby bump twice (entry + apply);
      // harmless: the counter's only consumer is the inequality stale-check.
      // Must be synchronous and BEFORE startTransition (the callback body
      // runs synchronously, but the supersede must not depend on that).
      sessionLoadRequestCounter += 1;
      let selected: AgentSessionWithRuntime | null = null;
      startTransition(() => {
        selected = store.getState().openHistorySession(sessionId, fullFidelityEvents);
      });
      const storeEnd = performance.now();
      if (!selected) return false;
      const openedSession = selected as AgentSessionWithRuntime;

      // A superseded in-flight load's spinner must not outlive this apply:
      // its own abort/catch may run unboundedly late (slow or hung IPC), so
      // clear any loading state that isn't this open's own.
      if (store.getState().loadingSessionId !== null) {
        // Even a same-session in-flight miss is superseded: this apply bumped
        // the counter, so that request will abort without clearing.
        store.getState().setLoadingSession(null);
      }

      // Preserve title override for the opened session
      sessionTitleOverridesRef.current[openedSession.id] = openedSession.title;

      Object.keys(openedSession.eventsByTurn).forEach((turnId) => assignTurnToSession(turnId, openedSession.id));

      // Backfill full-fidelity events asynchronously for cache-hit opens.
      // Guardrails:
      // - only apply if the same session is still active;
      // - merge against live in-memory events so we never clobber newer events
      //   that arrived after the open started.
      if (cacheHitDiskEventsPromise) {
        void cacheHitDiskEventsPromise.then((diskEvents) => {
          if (!diskEvents) return;

          const currentState = store.getState();
          if (currentState.currentSessionId !== sessionId) return;

          const liveEvents = getCurrentSessionEvents();
          const mergedEvents: Record<string, AgentEvent[]> = { ...diskEvents };
          for (const [turnId, liveTurnEvents] of Object.entries(liveEvents)) {
            const diskTurnEvents = diskEvents[turnId] ?? [];
            if (liveTurnEvents.length > diskTurnEvents.length) {
              mergedEvents[turnId] = liveTurnEvents;
            }
          }

          // Stage 19a: validate the merged disk+live events against the
          // session we re-confirmed is still active (L2072 guard), dropping
          // any foreign-stamped event before it lands in the shared Map.
          setCurrentSessionEvents(
            mergedEvents,
            beginValidatedSessionWrite(sessionId, 'cache-hit-backfill'),
          );
          // Stage 5 (F9 boundary flush): direct setState path. setCurrentSessionEvents
          // calls bumpVersion() which schedules a coalesced microtask; flushing
          // synchronously here ensures the Zustand state's eventsByTurnVersion
          // matches the counter immediately, so any concurrent merge or persistence
          // subscriber sees a consistent value rather than racing the microtask.
          flushPendingEventsVersionNotification();
        });
      }
      
      // PERF INSTRUMENTATION
      const engineEnd = performance.now();
      if (import.meta.env.VITE_PERFORMANCE === 'true') {
        console.warn(
          `[PERF] Engine openHistorySession total: ${(engineEnd - engineStart).toFixed(1)}ms ` +
          `(cache ${wasCacheHit ? 'HIT' : 'MISS'}, store action: ${(storeEnd - storeStart).toFixed(1)}ms)`
        );
      }
      markEngineOpenDone(openedSession.id, { wasCacheHit });
      
      emitLog({ level: 'info', message: 'Opened history session', sessionId: openedSession.id, timestamp: Date.now() });
      return true;
    },
    [assignTurnToSession, emitLog, store]
  );

  const deleteHistorySession = useCallback(
    (sessionId: string): { success: boolean; wasActive: boolean } => {
      const state = store.getState();
      const isDeletingActive = sessionId === state.currentSessionId;
      // Stage 7b: Use summaries for title lookup
      const sessionTitle = state.sessionSummaries.find((s) => s.id === sessionId)?.title ?? state.currentSessionTitle;

      store.getState().removeHistorySession(sessionId);
      delete sessionTitleOverridesRef.current[sessionId];

      // Fire-and-forget: Call the proper IPC delete to ensure file is removed from disk.
      // This supplements the bulk save mechanism which has weaker error handling.
      // Without this, deleted sessions can reappear after restart due to orphan recovery.
      // Both operations use the same writeQueue so they're serialized.
      // See docs/plans/obsolete/260109_session_deletion_resurrection_fix.md
      window.sessionsApi.delete({ id: sessionId }).then((res) => {
        if (!res.success) {
          emitLog({
            level: 'warn',
            message: 'Failed to delete session file from disk',
            sessionId,
            context: { error: res.error?.message },
            timestamp: Date.now()
          });
        }
      });

      if (isDeletingActive) {
        // Clear conversation state BEFORE resetSession to prevent snapshotCurrentSession
        // from re-adding the deleted session back to history.
        // Both messages and external events must be empty so snapshot returns null.
        // Phase 6 remediation (260508 Stage 5): drain any prior pending
        // bumps before the new bump so subscribers observe the outgoing
        // session's trailing-edge counter before the clear.
        flushPendingEventsVersionNotification();
        clearCurrentSessionEvents();
        // Phase 6 remediation: include the trailing-edge counter in the
        // synchronous setState so visible state (messages/eventsByTurn) and
        // version update atomically. Without this, Zustand subscribers
        // briefly see emptied messages with the previous tick's stale
        // version. The trailing flush below drains the just-scheduled
        // microtask so it becomes a tail no-op rather than a redundant
        // setState fan-out.
        store.setState({
          messages: [],
          eventsByTurn: {},
          eventsByTurnVersion: getCurrentSessionEventsVersion(),
        });
        flushPendingEventsVersionNotification();
        store.getState().resetSession();
        toastNotifications.notifySessionDeleted(true);
      } else {
        toastNotifications.notifySessionDeleted(false);
      }

      emitLog({
        level: 'info',
        message: 'Session deleted',
        sessionId,
        context: { title: sessionTitle, wasActive: isDeletingActive },
        timestamp: Date.now()
      });
      return { success: true, wasActive: isDeletingActive };
    },
    [emitLog, store]
  );

  const togglePinSession = useCallback(
    (sessionId: string) => {
      store.getState().togglePinSession(sessionId);
      emitLog({ level: 'info', message: 'Toggled pin for session', sessionId, timestamp: Date.now() });
    },
    [emitLog, store]
  );

  const toggleStarSession = useCallback(
    (sessionId: string) => {
      store.getState().toggleStarSession(sessionId);
      emitLog({ level: 'info', message: 'Toggled star for session', sessionId, timestamp: Date.now() });
    },
    [emitLog, store]
  );

  const softDeleteSession = useCallback(
    (sessionId: string) => {
      store.getState().softDeleteSession(sessionId);
      emitLog({ level: 'info', message: 'Soft deleted session (moved to trash)', sessionId, timestamp: Date.now() });
    },
    [emitLog, store]
  );

  const restoreSession = useCallback(
    (sessionId: string) => {
      store.getState().restoreSession(sessionId);
      emitLog({ level: 'info', message: 'Restored session from trash', sessionId, timestamp: Date.now() });
    },
    [emitLog, store]
  );

  const emptyTrash = useCallback(() => {
    store.getState().emptyTrash();
    emitLog({ level: 'info', message: 'Emptied trash', timestamp: Date.now() });
  }, [emitLog, store]);

  const renameSession = useCallback(
    (sessionId: string, newTitle: string) => {
      sessionTitleOverridesRef.current[sessionId] = newTitle;
      store.getState().renameSession(sessionId, newTitle);
      emitLog({ level: 'info', message: 'Renamed session', sessionId, context: { newTitle }, timestamp: Date.now() });
    },
    [emitLog, store]
  );

  const focusTurn = useCallback(
    (turnId: string) => {
      if (!turnId || turnId === TURN_ID_FALLBACK) return;
      const state = store.getState();
      if (state.focusedTurnId === turnId) return;
      if (getCurrentSessionEventsForTurn(turnId).length === 0) return;

      const sessionId = resolveSessionId(turnId);
      if (!sessionId) return;

      store.getState().setFocusedTurnId(turnId);
      emitLog({ level: 'info', message: 'Run focused', turnId, sessionId, timestamp: Date.now() });
    },
    [emitLog, resolveSessionId, store]
  );

  const ingestExternalSessions = useCallback(
    (sessions: AgentSession[]) => {
      if (!sessions?.length) return;
      const activeSnapshot = store.getState().ingestExternalSessions(sessions);
      if (activeSnapshot) {
        sessionTitleOverridesRef.current[activeSnapshot.id] = activeSnapshot.title;
      }
      for (const session of sessions) {
        if (session.id) {
          sessionTitleOverridesRef.current[session.id] = session.title;
        }
      }
    },
    [store]
  );

  useEffect(() => {
    const unsubscribe = window.api.onAgentEvent(({ turnId, event, sessionId: eventSessionId }) => {
      // Skip breadcrumb for high-frequency streaming deltas (fire per-token, causes CPU/allocation burn)
      if (event.type !== 'assistant_delta' && event.type !== 'thinking_delta') {
        recordBreadcrumb({ type: 'agent:event', message: event.type, timestamp: event.timestamp, data: { turnId } });
      }
      
      // If main process provided a sessionId (e.g., for live coach tips to non-active session),
      // pre-map the turn to that session before resolution to ensure correct routing.
      if (eventSessionId && !turnSessionMapRef.current[turnId]) {
        assignTurnToSession(turnId, eventSessionId);
      }
      
      const sessionId = resolveSessionId(turnId);

      if (!sessionId) {
        const queue = pendingEventsRef.current[turnId] ?? [];
        // Stage 19a refinement: preserve the envelope provenance alongside the
        // bare event so the flush (assignTurnToSession) can validate against the
        // event's TRUE origin instead of falling back to accepted-legacy.
        queue.push({ event, eventSessionId });
        pendingEventsRef.current[turnId] = queue;
        return;
      }
      // Stage 19a: forward the envelope provenance (`eventSessionId`) so the
      // store's foreground ingress can validate it against the active session.
      processAgentEvent(turnId, sessionId, event, eventSessionId);
    });
    return unsubscribe;
  }, [assignTurnToSession, processAgentEvent, recordBreadcrumb, resolveSessionId]);

  // Listen for server-side auto-generated session titles
  useEffect(() => {
    const unsubscribe = window.api.onSessionTitleGenerated((data) => {
      sessionTitleOverridesRef.current[data.sessionId] = data.title;
      store.getState().applyAutoGeneratedTitle(data.sessionId, data.title, {
        autoTitleGeneratedAt: data.autoTitleGeneratedAt ?? Date.now(),
        autoTitleTurnCount: data.autoTitleTurnCount ?? 0,
      });
    });
    return unsubscribe;
  }, [store]);

  // Listen for the per-turn AI activity summary (260618 show-more-activity).
  // Mirrors the title-generated listener above: a fresh summary persisted in
  // core arrives here so the memoised work-disclosure label repaints from the
  // deterministic count-line to the sentence WITHOUT a reload. The store setter
  // routes by the broadcast's authoritative sessionId (current session → live
  // top-level map; otherwise the loaded-session map).
  useEffect(() => {
    const unsubscribe = window.api.onSessionActivitySummaryGenerated((data) => {
      store.getState().setActivitySummaryForSession(data.sessionId, data.turnId, data.summary);
    });
    return unsubscribe;
  }, [store]);

  // Safety-eval progress: drive the "Checking this is safe…" subline on the
  // running tool row. Broadcast-only — not recorded in eventsByTurn. Paired
  // cleanup: `-complete` clears directly; `tool` stage:'end' clears via
  // processEvent belt-and-braces in sessionStore.
  useEffect(() => {
    const unsubscribeEval = window.api.onSafetyEvaluating(({ toolUseId, attempt, startedAt, toolName }) => {
      store.getState().setSafetyEvalInFlight(toolUseId, { attempt, startedAt, toolName });
    });
    const unsubscribeComplete = window.api.onSafetyEvaluatingComplete(({ toolUseId }) => {
      store.getState().clearSafetyEvalInFlight(toolUseId);
    });
    return () => {
      unsubscribeEval();
      unsubscribeComplete();
    };
  }, [store]);

  useEffect(() => {
    const state = store.getState();
    const override = sessionTitleOverridesRef.current[state.currentSessionId];
    if (override && state.currentSessionTitle !== override) {
      store.getState().setCurrentSessionMeta({ currentSessionTitle: override });
      return;
    }
    // If the session already has a persisted generated title (not the default),
    // seed the overrides ref so subsequent effects treat it as "already titled"
    // and don't overwrite it with the first-message fallback.
    if (!override && state.currentSessionTitle && state.currentSessionTitle !== 'New Agent Run' && state.currentSessionTitle !== 'New conversation') {
      sessionTitleOverridesRef.current[state.currentSessionId] = state.currentSessionTitle;
      return;
    }
    if (!override && state.messages.length > 0) {
      const fallbackTitle = createSessionTitle(state.messages, state.sessionSummaries.length + 1);
      if (state.currentSessionTitle !== fallbackTitle) {
        store.getState().setCurrentSessionMeta({ currentSessionTitle: fallbackTitle });
      }
    }
  }, [messages, currentSessionId, store]);

  // Auto-title generation has been centralized to the main process (conversationTitleService).
  // The renderer no longer drives title generation — it receives generated titles
  // via the 'session:title-generated' IPC event handled above.

  // busyElapsedMs timer removed — now computed locally in useWorkSurfaceView
  // (PERF: eliminates 12 Zustand writes/min during active turns)

  useEffect(() => {
    if (!error) return;
    recordBreadcrumb({ type: 'ui-error', message: error, timestamp: Date.now() });
    emitLog({ level: 'error', message: 'Renderer error state updated', context: { error }, timestamp: Date.now() });
  }, [emitLog, error, recordBreadcrumb]);

  // Self-healing: detect when isBusy is stuck but the turn's events already
  // contain a terminal event (result/error). This catches the race where the
  // main process dispatched the result but the Zustand state transition was
  // lost (event-loop congestion, concurrent persistence write, etc.).
  // See: docs/plans/partway/260307_cloud_turn_sync_data_loss.md (Bug 4)
  useEffect(() => {
    if (!isBusy || isStopping) {
      staleBusyHealInterval.clear();
      return;
    }

    staleBusyHealInterval.set(() => {
      const state = store.getState();
      if (!isCurrentSessionProjectionBusy(state) || state.isStopping) {
        staleBusyHealInterval.clear();
        return;
      }
      const turnId = getCurrentSessionProjectedLiveness(
        state.activeTurnId,
      ).activeTurnId;
      if (!turnId) return;

      const turnEvents = getCurrentSessionEventsForTurn(turnId);
      const hasTerminal = turnEvents.some(
        (e) => e.type === 'result' || e.type === 'error',
      );
      if (!hasTerminal) return;

      emitLog({
        level: 'warn',
        message: 'Self-healing stale isBusy: terminal event found in events but isBusy still true',
        sessionId: state.currentSessionId,
        context: { turnId },
        timestamp: Date.now(),
      });
      captureRendererException(
        new Error('Self-healing stale isBusy: terminal event present but isBusy stuck'),
        { tags: { turnId, sessionId: state.currentSessionId } },
      );
      forceTerminalizeCurrentProjectedTurn('Stale busy self-heal');
      staleBusyHealInterval.clear();
    }, 15_000);

    return () => staleBusyHealInterval.clear();
  }, [isBusy, isStopping, store, emitLog, forceTerminalizeCurrentProjectedTurn, staleBusyHealInterval]);

  useEffect(() => {
    // Guard: Only load once per JS context to prevent overwrites on React remount
    if (sessionsLoadedInContext) return;
    sessionsLoadedInContext = true;

    // Stage 7b: Only load summaries at startup - sessions load on-demand when opened.
    // This is the key optimization that reduces memory from 5.5GB to ~31MB for 720 sessions.
    // Full session data (messages, events) is loaded via sessions:get when user opens a session.
    persistenceManager.loadSessionSummaries()
      .then((summaries) => {
        // Populate sessionSummaries for sidebar display
        if (summaries.length > 0) {
          store.getState().setSessionSummaries(summaries);
          emitLog({ level: 'info', message: 'Session summaries loaded (lazy loading)', context: { count: summaries.length }, timestamp: Date.now() });
        }

        // CRITICAL: Mark load complete so persistence subscription knows sessions are initialized.
        // This prevents the race condition that deleted 452 sessions.
        sessionsLoadCompleteInContext = true;

        // Cache warming: Pre-load pinned sessions during idle time for faster switching.
        // With Stage 7b lazy loading, this is essential for avoiding IPC latency on first open.
        // See docs/plans/finished/260126_session_cache_warming.md
        if (!cacheWarmedInContext && summaries.length > 0) {
          cacheWarmedInContext = true;

          const warmCache = async () => {
            const state = store.getState();

            const warmableSummaries = state.sessionSummaries
              .filter((s) => !s.deletedAt && !s.isCorrupted)
              .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
            const candidateMap = new Map<string, AgentSessionSummary>();
            for (const summary of warmableSummaries.filter((s) => isSessionActive(s)).slice(0, CACHE_WARM_PINNED_COUNT)) {
              candidateMap.set(summary.id, summary);
            }
            for (const summary of warmableSummaries.slice(0, CACHE_WARM_RECENT_COUNT)) {
              candidateMap.set(summary.id, summary);
            }
            const candidates = Array.from(candidateMap.values()).slice(0, CACHE_WARM_MAX_CANDIDATES);

            let warmedCount = 0;
            for (const summary of candidates) {
              // Re-check state per iteration (user may have clicked)
              const currentState = store.getState();
              if (currentState.loadedSessions.has(summary.id)) continue;
              if (currentState.loadingSessionId === summary.id) continue;

              // Load via IPC and cache
              try {
                const session = await window.sessionsApi.get({ id: summary.id });
                // Re-check after async - user may have loaded this session while we waited
                if (session && !store.getState().loadedSessions.has(summary.id)) {
                  const runtime = buildRuntimeFromSnapshot(session.activeTurnId ?? null, session.eventsByTurn);
                  store.getState().cacheSession({ ...session, runtime });
                  warmedCount++;
                }
              } catch {
                // Silently ignore - cache warming is best-effort
              }
            }

            if (warmedCount > 0) {
              emitLog({ level: 'debug', message: 'Cache warming completed', context: { count: warmedCount }, timestamp: Date.now() });
            }
          };

          // Defer to idle time
          if (typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(() => warmCache(), { timeout: 5000 });
          } else {
            window.setTimeout(warmCache, 1000);
          }
        }
      })
      .catch((err) => {
        // Even on load failure, mark complete to allow new sessions to be saved.
        // The main process safeguard will prevent catastrophic deletion if there's
        // a mismatch between loaded state and disk state.
        emitLog({
          level: 'error',
          message: 'Failed to load session history',
          context: { error: err instanceof Error ? err.message : String(err) },
          timestamp: Date.now()
        });
        sessionsLoadCompleteInContext = true;
      });
  }, [emitLog, store]);

  // Persistence subscription - saves current session on message/draft/annotation changes.
  // Uses requestIdleCallback to defer snapshot computation to idle time.
  //
  // Stage 9: Removed agentSessions subscription (now dead code since store actions
  // no longer update agentSessions). Metadata changes (pin/star/rename) on both
  // current and non-current sessions now persist via explicit async IPC upsert
  // in the store actions themselves.
  //
  // See docs/plans/finished/260126_renderer_lazy_session_loading.md for full migration history.
  useEffect(() => {
    let pendingIdleCallback: number | null = null;

    // Track which sessions' drafts changed so we can persist them even if the user
    // switched sessions before the (throttled) draft update fired.
    let pendingDraftSaveSessionIds = new Set<string>();
    let pendingAnnotationSaveSessionIds = new Set<string>();

    /**
     * Save a single session via upsert and update its summary in sessionSummaries.
     * This is the primary save path for lazy loading - incremental, not bulk.
     */
    const saveSessionAndUpdateSummary = async (session: AgentSessionWithRuntime) => {
      // Merge local per-session fields if present
      const state = store.getState();
      const draft = state.draftsBySessionId[session.id];
      const hasAnnotations = Object.prototype.hasOwnProperty.call(
        state.annotationsBySessionId,
        session.id,
      );
      const annotations = state.annotationsBySessionId[session.id] ?? [];
      const sessionWithDraft = {
        ...session,
        ...(draft ? { draft } : {}),
        ...(hasAnnotations
          ? { annotations: annotations.length > 0 ? [...annotations] : undefined }
          : {}),
      };

      // Save via upsert (async, but fire-and-forget for performance)
      const success = await persistenceManager.saveSession(sessionWithDraft);

      if (success) {
        // Optimistically update sessionSummaries to stay in sync.
        // PERF: Skip the update when only draft-related fields changed —
        // setDraftForSession already handles draft presence flips in sessionSummaries,
        // so a redundant updateSessionSummary here would trigger a second App re-render
        // and expensive sidebar recomputation (730-1,337ms with 700+ sessions).
        const summary = persistenceManager.createSummaryFromSession(sessionWithDraft);
        const existing = store.getState().sessionSummaries.find((s) => s.id === summary.id);

        if (hasMeaningfulSummaryChange(existing, summary)) {
          // Layer B ratchet — see `ratchetSummaryUpdatedAt` doc comment for why.
          const ratchetedSummary = ratchetSummaryUpdatedAt(summary, existing);
          store.getState().updateSessionSummary(ratchetedSummary);
        }
      }
    };

    const saveSessionByIdAndUpdateSummary = async (sessionId: string) => {
      try {
        const state = store.getState();

        // Load from cache or IPC
        const cached = state.loadedSessions.get(sessionId);
        const loaded = cached ?? ((await window.sessionsApi.get({ id: sessionId })) as AgentSessionWithRuntime | null);
        if (!loaded) return;

        const draft = state.draftsBySessionId[sessionId];
        const hasDraft = Boolean(draft?.text?.trim());
        const hasAnnotations = Object.prototype.hasOwnProperty.call(
          state.annotationsBySessionId,
          sessionId,
        );
        const annotations = state.annotationsBySessionId[sessionId] ?? [];
        const latestAnnotationCreatedAt = annotations.length > 0
          ? Math.max(...annotations.map((annotation) => annotation.createdAt))
          : 0;

        const now = Date.now();

        const updatedAt = Math.max(
          loaded.updatedAt ?? loaded.createdAt,
          draft?.updatedAt ?? 0,
          latestAnnotationCreatedAt,
          now
        );

        const sessionWithDraft: AgentSessionWithRuntime = {
          ...loaded,
          updatedAt,
          draft: hasDraft ? draft : undefined,
          ...(hasAnnotations
            ? { annotations: annotations.length > 0 ? [...annotations] : undefined }
            : {}),
        };

        const success = await persistenceManager.saveSession(sessionWithDraft);
        if (success) {
          // PERF: Same skip logic as saveSessionAndUpdateSummary —
          // only update sessionSummaries when meaningful fields changed.
          const summary = persistenceManager.createSummaryFromSession(sessionWithDraft);
          const existing = store.getState().sessionSummaries.find((s) => s.id === summary.id);

          if (hasMeaningfulSummaryChange(existing, summary)) {
            // Layer B ratchet — see `ratchetSummaryUpdatedAt` doc comment for why.
            const ratchetedSummary = ratchetSummaryUpdatedAt(summary, existing);
            store.getState().updateSessionSummary(ratchetedSummary);
          }
        }
      } catch {
        // Ignore - draft persistence is best-effort and already guarded by quit-time save.
      }
    };

    // Execute the actual save. Shared between the idle-callback path and the
    // visibilitychange:hidden safety net (FOX-3148 D1).
    const doSave = () => {
      pendingIdleCallback = null;
      const state = store.getState();

      // Capture and clear pending local-state saves atomically (avoid missing rapid updates)
      const draftIdsToSave = pendingDraftSaveSessionIds;
      const annotationIdsToSave = pendingAnnotationSaveSessionIds;
      pendingDraftSaveSessionIds = new Set<string>();
      pendingAnnotationSaveSessionIds = new Set<string>();
      const snapshot = state.snapshotCurrentSession();

      // LAZY LOADING: Save current session only via upsert (not bulk save)
      // This is the incremental save approach - other sessions are already persisted
      if (snapshot) {
        void saveSessionAndUpdateSummary(snapshot);
      }

      // Persist draft/annotation updates for non-current sessions (rare, but possible due to throttling)
      const nonCurrentSessionIdsToSave = new Set([
        ...draftIdsToSave,
        ...annotationIdsToSave,
      ]);
      for (const sessionId of nonCurrentSessionIdsToSave) {
        if (sessionId === state.currentSessionId) continue;
        void saveSessionByIdAndUpdateSummary(sessionId);
      }
    };

    const cancelPendingIdleCallback = () => {
      if (pendingIdleCallback === null) return;
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(pendingIdleCallback);
      } else {
        window.clearTimeout(pendingIdleCallback);
      }
      pendingIdleCallback = null;
    };

    // Use requestIdleCallback to defer snapshot computation to idle time
    // Falls back to setTimeout for browsers without requestIdleCallback
    const scheduleIdleSave = () => {
      // CRITICAL GUARD: Do not save until sessions have been loaded from disk.
      // Without this guard, the subscription can fire before loadAgentSessions() completes,
      // saving an empty agentSessions array that causes main process to delete all sessions.
      // This race condition deleted 452 sessions on 2026-01-11.
      if (!sessionsLoadCompleteInContext) {
        return;
      }

      // Cancel any pending idle callback to coalesce rapid changes
      cancelPendingIdleCallback();

      if (typeof window.requestIdleCallback === 'function') {
        pendingIdleCallback = window.requestIdleCallback(doSave, { timeout: 500 });
      } else {
        // Fallback: use setTimeout with small delay to batch rapid changes
        pendingIdleCallback = window.setTimeout(doSave, 50);
      }
    };

    // FOX-3148 D1: Save immediately when the window becomes hidden (app backgrounded).
    // `requestIdleCallback` is throttled by the OS while hidden, so a long idle
    // window may not arrive and pending writes can sit in memory until the app is
    // killed. If there's a pending save, cancel the idle callback and flush now.
    // Idempotent upsert makes an extra save safe.
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') return;
      if (!sessionsLoadCompleteInContext) return;
      if (pendingIdleCallback === null) return; // no unsaved changes
      cancelPendingIdleCallback();
      doSave();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Subscribe to messages, drafts, and annotations - save current session via upsert
    const unsubscribeMessages = store.subscribe(
      (state) => state.messages.length,
      scheduleIdleSave
    );
    const unsubscribeDrafts = store.subscribe(
      (state) => state.draftsBySessionId,
      (nextDrafts, prevDrafts) => {
        const next = nextDrafts ?? {};
        const prev = prevDrafts ?? {};

        // Track changed session IDs only (avoid saving everything)
        const ids = new Set<string>([...Object.keys(next), ...Object.keys(prev)]);
        for (const id of ids) {
          const nextUpdatedAt = next[id]?.updatedAt;
          const prevUpdatedAt = prev[id]?.updatedAt;
          const nextText = next[id]?.text;
          const prevText = prev[id]?.text;
          if (nextUpdatedAt !== prevUpdatedAt || nextText !== prevText) {
            pendingDraftSaveSessionIds.add(id);
          }
        }

        scheduleIdleSave();
      }
    );
    const unsubscribeAnnotations = store.subscribe(
      (state) => state.annotationsBySessionId,
      (nextAnnotations, prevAnnotations) => {
        const next = nextAnnotations ?? {};
        const prev = prevAnnotations ?? {};

        const ids = new Set<string>([...Object.keys(next), ...Object.keys(prev)]);
        for (const id of ids) {
          const nextValue = next[id] ?? [];
          const prevValue = prev[id] ?? [];
          if (
            nextValue.length !== prevValue.length ||
            nextValue.some((annotation, index) => {
              const previous = prevValue[index];
              return (
                !previous ||
                annotation.id !== previous.id ||
                annotation.messageId !== previous.messageId ||
                annotation.text !== previous.text ||
                annotation.comment !== previous.comment ||
                annotation.createdAt !== previous.createdAt ||
                annotation.startOffset !== previous.startOffset ||
                annotation.endOffset !== previous.endOffset
              );
            })
          ) {
            pendingAnnotationSaveSessionIds.add(id);
          }
        }

        scheduleIdleSave();
      }
    );
    // Subscribe to eventsByTurnVersion changes - captures turn progress and completion
    // FIX: Without this, agent work (tool calls, results) goes to external event Map but
    // never triggers a save because messages.length doesn't change during a turn.
    // Uses version counter instead of reference equality (events now live outside Zustand).
    // See docs/plans/finished/260128_Session_Persistence_Gap_Investigation.md
    const unsubscribeEvents = store.subscribe(
      (state) => state.eventsByTurnVersion,
      scheduleIdleSave
    );

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      cancelPendingIdleCallback();
      unsubscribeMessages();
      unsubscribeDrafts();
      unsubscribeAnnotations();
      unsubscribeEvents();
    };
  }, [store]);

  // beforeunload handler for quit-time flush.
  // LAZY LOADING (Stage 5): Save only the current session, not all sessions.
  // Other sessions are already persisted via incremental upserts during normal operation.
  // This simplifies the beforeunload logic and reduces the sync save payload.
  // See docs/plans/finished/260126_renderer_lazy_session_loading.md Stage 5.
  useEffect(() => {
    const handleBeforeUnload = () => {
      // Flush debounced folder state before quit (folders.json)
      useFolderStore.getState().flushFolderState();

      // Stage 5 (F9 boundary flush): drain any pending microtask-coalesced
      // eventsByTurnVersion notification before composing the quit-time
      // snapshot so the trailing-edge counter is observable to any
      // persistence subscriber and the snapshot itself reflects the latest
      // version state.
      flushPendingEventsVersionNotification();

      const state = store.getState();
      const snapshot = snapshotCurrentConversation();

      // Only save current session - other sessions are already persisted via upsert
      if (snapshot) {
        // Merge local per-session fields if present
        const draft = state.draftsBySessionId[snapshot.id];
        const hasAnnotations = Object.prototype.hasOwnProperty.call(
          state.annotationsBySessionId,
          snapshot.id,
        );
        const annotations = state.annotationsBySessionId[snapshot.id] ?? [];
        const sessionWithDraft = {
          ...snapshot,
          ...(draft ? { draft } : {}),
          ...(hasAnnotations
            ? { annotations: annotations.length > 0 ? [...annotations] : undefined }
            : {}),
        };
        // Sync save - acceptable here since app is quitting anyway
        persistenceManager.saveSessionsSync([sessionWithDraft]);
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [snapshotCurrentConversation, store]);

  // Stable setter callbacks - these were previously inline functions that caused
  // callback chains to become unstable (breaking React.memo in MessageItem)
  const setShowConversationStable = useCallback(
    (v: boolean) => store.getState().setShowConversation(v),
    [store]
  );
  const setAgentErrorStable = useCallback(
    (v: string | null) => store.getState().setError(v),
    [store]
  );
  const setPrivateModeStable = useCallback(
    (enabled: boolean) => store.getState().setPrivateMode(enabled),
    [store]
  );
  const setCouncilModeStable = useCallback(
    (enabled: boolean) => store.getState().setCouncilMode(enabled),
    [store]
  );
  const setAutoDoneEnabledStable = useCallback(
    (enabled: boolean) => store.getState().setAutoDoneEnabled(enabled),
    [store]
  );
  const setFinishLineStable = useCallback(
    (value: string | null) => store.getState().setFinishLine(value),
    [store]
  );

  return {
    messages,
    eventsByTurn,
    activeTurnId,
    focusedTurnId,
    currentSessionId,
    currentSessionTitle,
    currentSessionOrigin,
    error,
    lastErrorSource,
    isBusy,
    isStopping,
    currentRuntime,
    currentSessionResolvedAt,
    currentSessionDoneAt,
    currentSessionStarredAt,
    showConversation,
    setShowConversation: setShowConversationStable,
    setAgentError: setAgentErrorStable,
    handleVoiceRunFailure,
    handleUserMessage: processMessage,
    editingMessageId,
    beginEditLastUserMessage,
    beginEditMessage,
    cancelEditMessage,
    rerunEditedMessage,
    stopActiveTurn,
    snapshotCurrentConversation,
    resetSessionState,
    openHistorySession,
    deleteHistorySession,
    togglePinSession,
    toggleStarSession,
    softDeleteSession,
    restoreSession,
    emptyTrash,
    renameSession,
    focusTurn,
    ingestExternalSessions,
    executeCompactionContinue,
    dismissCompaction,
    privateMode,
    setPrivateMode: setPrivateModeStable,
    councilMode,
    setCouncilMode: setCouncilModeStable,
    requestCouncilReview,
    autoDoneEnabled,
    setAutoDoneEnabled: setAutoDoneEnabledStable,
    finishLine: finishLine ?? null,
    setFinishLine: setFinishLineStable,
    // Diagnostic callback for FOX-3518 within-session leak investigation.
    // See "Uncounted engine refs" comment near getEngineLeakCounters above.
    getEngineLeakCounters,
  };
};
