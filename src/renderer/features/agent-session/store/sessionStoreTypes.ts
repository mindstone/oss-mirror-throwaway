/**
 * Type declarations for the renderer session store.
 *
 * Extracted from `sessionStore.ts` (behavior-preserving Stage 1) so the large
 * action-closure file holds runtime logic only. `sessionStore.ts` re-exports
 * the externally-consumed types so the 49 non-test importers + 84 test
 * import-sites keep resolving from the canonical `.../store/sessionStore` path.
 *
 * @see ./sessionStore.ts — the store implementation that consumes these types
 * @see docs/plans/260622_refactor-session-store/PLAN.md — extraction plan
 */
import type {
  AgentEvent,
  AgentSession,
  AgentSessionSummary,
  AgentTurnMessage,
  MemoryUpdateStatus,
  TimeSavedStatus,
  CompactionBoundary,
  ConversationAnnotation,
} from "@shared/types";
import type { AgentSessionWithRuntime } from "../types";
import type {
  ConversationStateShape,
  SessionRuntimeState,
} from "./reducers";
import type { ValidatedSessionWriteScope } from '@shared/utils/eventSessionValidation';
import type { DerivedLiveness } from '@core/services/conversationState';

/**
 * Recovery exhaustion reason carried on `recovery:failed` events. Derived from
 * the shared event union (single source of truth in `@shared/types`) so the
 * renderer never re-enumerates the reason literals and stays lockstep with the
 * cross-process contract. Used to render reason-aware recovery copy.
 */
export type ExhaustedReason = Extract<AgentEvent, { type: 'recovery:failed' }>['exhaustedReason'];

/** Fields that can be updated on a session summary via metadata operations */
export type SummaryMetadataFields = Pick<
  AgentSessionSummary,
  "doneAt" | "starredAt" | "deletedAt" | "title" | "isBusy" | "activeTurnId"
>;

/** Meeting companion metadata for meeting-linked sessions */
export type MeetingCompanionMeta = {
  /** Meeting URL - stable identifier */
  meetingUrl: string;
  /** Current bot ID (may change on retry) */
  botId?: string;
  /** Meeting title for display */
  meetingTitle: string;
  /** When the companion session started */
  startedAt: number;
  /** Coach configuration (optional) */
  coach?: {
    skillPath: string;
    skillName: string;
    showAllChecks?: boolean;
  };
};

export type SessionMetaState = {
  currentSessionId: string;
  currentSessionTitle: string;
  /**
   * Mirrors `NormalizedSessionOrigin` so the renderer state covers every
   * `SessionOrigin` the wire schema can produce. Widening to the full union
   * prevents the normalizer from silently collapsing values like
   * `mcp-tool` / `operator-personalisation` to `'manual'` on hydration.
   */
  currentSessionOrigin: NormalizedSessionOrigin;
  currentSessionResolvedAt: number | null;
  /** Lifecycle: `null` = Active, non-null timestamp = Done. Polarity matches
   *  `starredAt`/`deletedAt` (affirmative action). The renderer derives the
   *  `isActive` bool via `isSessionActive`. See
   *  docs/plans/260614_done-state-rename/PLAN.md. */
  currentSessionDoneAt: number | null;
  currentSessionStarredAt: number | null;
  /** Private mode: forces cautious tool safety + cautious memory safety (always ask before actions/writes) */
  privateMode: boolean;
  /** Council mode: dispatch parallel subagents on different model providers for next message */
  councilMode: boolean;
  /** Per-conversation working model override (Claude model string) */
  sessionWorkingModel: string | undefined;
  /** Per-conversation thinking model override (Claude model string) */
  sessionThinkingModel: string | undefined;
  /** Per-conversation working profile ID override */
  sessionWorkingProfileId: string | undefined;
  /** Per-conversation thinking profile ID override */
  sessionThinkingProfileId: string | undefined;
  /** Per-conversation thinking effort override */
  sessionThinkingEffort: import("@shared/types").ThinkingEffort | undefined;
  /** Auto-done toggle: mark session as done when current turn completes successfully (fire & forget mode) */
  autoDoneEnabled: boolean;
  /** Stable creation timestamp for current session (prevents createdAt instability for draft-only sessions) */
  currentSessionCreatedAt: number;
  /** Meeting companion metadata (if this is a meeting-linked session) */
  currentSessionMeetingCompanion: MeetingCompanionMeta | null;
  /** Setup metadata tied to the current session lifecycle. */
  currentSessionSetupContext: AgentSession["setupContext"] | null;
  /**
   * User-set "Finish line" criterion for the current conversation.
   * `null` = unset. Fed into the auto-continue evaluator + system prompt so
   * Rebel stops when the criterion is met. Persisted on `AgentSession.finishLine`.
   * See `docs/plans/260515_finish_line.md`.
   */
  currentSessionFinishLine: string | null;
};

export type UIState = {
  showConversation: boolean;
  editingMessageId: string | null;
  isStopping: boolean;
};

export type RoleNotConfiguredToastRole = import("@shared/types").ModelRoleTier;

export type NormalizedSessionOrigin =
  | "manual"
  | "automation"
  | "role"
  | "mcp-tool"
  | "inbound-trigger"
  | "plugin"
  | "focus"
  | "browser-extension"
  | "operator-personalisation";

export type CompactionPhase =
  | "idle"
  | "compacting"
  | "revealing"
  | "continuing"
  | "skeleton"
  | "recovery_model"
  | "unavailable"
  | "error";

export type CompactionState = {
  phase: CompactionPhase;
  statusMessage: string;
  summary: string | null;
  depth: number;
  enhancedPrompt: string | null;
  originalSessionId: string | null;
  turnId: string | null;
  fallbackTarget: string | null;
  depth4ProfileName: string | null;
  revealDurationMs: number | null;
  /**
   * The terminal exhaustion reason when phase === 'error'. Drives reason-aware
   * recovery copy in the overlay (e.g. `agent_loop_error_after_recovery` shows a
   * "cleanup worked, next step tripped" message instead of "still too large").
   * Null until an error with a known reason is recorded.
   */
  reason: ExhaustedReason | null;
};

/** Draft content for a session (stored in draftsBySessionId map) */
export type DraftContent = {
  text: string;
  updatedAt: number;
};

/**
 * Pending turn that should be retried when network connectivity returns.
 * Persisted to localStorage so pending retries survive app restarts.
 */
export interface PendingNetworkRetryTurn {
  sessionId: string;
  turnId: string;
  userMessageText: string;
  failedAt: number;
  /** UUIDs of cached attachments in userData/attachment-cache/ */
  attachmentCacheIds?: string[];
  /** Number of retry attempts for this turn */
  retryCount: number;
}

/**
 * Events are stored as {turnId, event} tuples because a session can receive
 * events from multiple turns (e.g. retry/restart), and historyReducer needs
 * the correct turnId for each event.
 */
export interface BufferedEvent {
  turnId: string;
  event: AgentEvent;
}

export interface PendingQuestionEventSnapshot {
  turnId: string;
  event: Extract<AgentEvent, { type: 'user_question' }>;
}

export type SummaryLivenessScalars = {
  isBusy: boolean;
  activeTurnId: string | null;
  lastActivityAt: number | null;
};

export interface EventsVersionCounters {
  versionBumps: number;
  scheduledNotifications: number;
  actualNotifications: number;
  coalescingRatio: number;
}

/**
 * Provenance for a cross-session event-ingress write into the module-level
 * `currentSessionEvents` Map (the W3 contamination surface).
 *
 * Stage 19a (260506 Stages 2–4): wires `validateEventForSession` at the
 * renderer ingress so a foreign-session event is DROPPED + telemetered
 * (fail-closed) instead of contaminating the shared Map. Provenance is
 * OPTIONAL: when omitted the write behaves exactly as before (no validation,
 * the legacy/coalescing-test path). When supplied, the event's provenance
 * sessionId (`eventSessionId`, falling back to `event.sessionId` inside the
 * validator) is checked against `currentSessionId`.
 */
export interface EventIngressProvenance {
  /**
   * Stage 19b: the unforgeable proof-of-validation scope. Carries the target
   * session id (`scope.targetSessionId`, the session the foreground Map
   * currently belongs to) and the `source`. Because the ONLY way to obtain a
   * scope is `beginValidatedSessionWrite` (co-located with the validator), an
   * ingress write that did not go through the validator cannot construct this
   * provenance object — it is a COMPILE error.
   */
  scope: ValidatedSessionWriteScope;
  /**
   * Authoritative provenance sessionId for the event (envelope
   * `AgentTurnEvent.sessionId` / threaded arg). May be undefined for legacy
   * variants that carry no sessionId — those are accepted (legacy) and
   * counted so the legacy rate can be driven to ~0.
   */
  eventSessionId?: string;
}

export type CurrentSessionProjectedLivenessCache = {
  version: number;
  declaredActiveTurnId: string | null;
  timeBucket: number;
  liveness: DerivedLiveness;
};

export type ShadowBusyReflipProbe = {
  scope: 'current' | 'loaded';
  sessionId: string;
  turnId: string;
  eventsForTurn: AgentEvent[];
  terminatedTurnIds?: Set<string>;
};

export type SessionStoreState = ConversationStateShape &
  SessionMetaState &
  UIState & {
    runtime: SessionRuntimeState;
    /**
     * Change counter for current session events (external Map).
     * Zustand subscribers watch this instead of eventsByTurn (which is always `{}`).
     * NOTE: eventsByTurn (from ConversationStateShape) is kept for type compatibility
     * but is always empty. Use getCurrentSessionEvents() to read events.
     */
    eventsByTurnVersion: number;
    /** Lightweight session summaries for sidebar display (source of truth for sidebar) */
    // delete-authority: type (store field declaration, not a write)
    sessionSummaries: AgentSessionSummary[];
    /** LRU cache of fully-loaded sessions (capped at MAX_LOADED_SESSIONS) */
    loadedSessions: Map<string, AgentSessionWithRuntime>;
    /** Whether a session is currently being loaded from disk */
    isLoadingSession: boolean;
    /** Session ID currently being loaded (for race condition handling) */
    loadingSessionId: string | null;
    compaction: CompactionState;
    memoryUpdateStatusByTurn: Record<string, MemoryUpdateStatus>;
    timeSavedStatusByTurn: Record<string, TimeSavedStatus>;
    /**
     * Per-turn AI activity summary (260618 show-more-activity). One grounded
     * sentence keyed by turnId, generated post-`result` and surfaced as the
     * collapsed work-disclosure label (deterministic count-line is the fallback).
     */
    activitySummaryByTurn: Record<string, string>;
    compactionBoundaries: CompactionBoundary[];
    /** Draft text keyed by sessionId for crash resilience and multi-draft support */
    draftsBySessionId: Record<string, DraftContent>;
    /** Pending conversation annotations keyed by sessionId */
    annotationsBySessionId: Record<string, ConversationAnnotation[]>;
    /** Pending AskUserQuestion events for background/unloaded sessions, used by the notification drawer. */
    pendingQuestionEventsBySessionId: Record<string, PendingQuestionEventSnapshot[]>;
    /** Dismissed AskUserQuestion batch IDs keyed by sessionId, shared by chat and notifications. */
    dismissedQuestionBatchIdsBySessionId: Record<string, string[]>;
    /**
     * Transient: in-flight Safety Prompt evaluations keyed by `toolUseId`.
     * Populated by `tool-safety:evaluating` broadcasts and cleared on either the
     * paired `tool-safety:evaluating-complete` broadcast OR the matching `tool`
     * event `stage: 'end'` (belt-and-braces). NOT persisted into `eventsByTurn`
     * or session snapshots — this is a UX affordance only.
     *
     * See: docs/plans/260417_safety_eval_silent_lock_bugfix.md
     */
    safetyEvalInFlight: Record<string, { attempt: number; startedAt: number; toolName: string }>;
    /** Sessions with active voice recordings - prevents empty sessions from being discarded */
    pendingRecordingSessionIds: Set<string>;
    /** Streaming thinking buffer keyed by turnId for extended thinking mode (shown separately from answer) */
    thinkingTextByTurn: Record<string, string>;
    /**
     * Turn IDs that have entered the answer phase (first token received). Set on
     * the `answer_phase_started` lifecycle marker (the desktop renderer's real
     * first-token signal — `assistant_delta` is NOT broadcast to the renderer).
     * Stage 1b (260617): used to clear the soft "still waiting" affordance the
     * instant a turn starts answering, honouring the load-bearing UI invariant
     * "never show 'still waiting' while text is appearing" — we must not wait for
     * the rolled-up `assistant` event (which can be many seconds later).
     * Memory-only; cleared on turn terminal / supersede / new chat.
     */
    answerStreamingTurnIds: Set<string>;
    /** Turn IDs that should trigger marking done on successful completion (supports concurrent sessions) */
    doneAfterTurnIds: Set<string>;
    /** Dedup keys for role-not-configured toasts (`${sessionId}:${role}`) across hook remounts */
    roleNotConfiguredToastKeys: Set<string>;
    /** Auto-done toggle state keyed by sessionId (memory-only, survives session switches) */
    autoDoneBySessionId: Record<string, boolean>;
    /** Pending turns to retry when network connectivity returns, keyed by sessionId (memory-only, not persisted) */
    pendingNetworkRetryTurns: Record<string, PendingNetworkRetryTurn>;
    /** Whether resume-all is currently in progress (prevents double-click) */
    isResuming: boolean;
    /** Whether the resume modal has been snoozed (set on "Not Now", reset on offline→online transition) */
    resumeModalSnoozed: boolean;
  };

export type SessionStoreActions = {
  /**
   * Foreground live-event ingress. `eventSessionId` is the authoritative
   * provenance (envelope `AgentTurnEvent.sessionId`) used by Stage 19a's
   * cross-session validator to drop foreign-session events before they reach
   * the shared event Map. Optional for backward compat / legacy callers.
   */
  processEvent: (turnId: string, event: AgentEvent, eventSessionId?: string) => void;
  addUserMessage: (
    text: string,
    attachments?: {
      id: string;
      name: string;
      path: string;
      relativePath: string;
      size: number;
    }[],
    options?: { isHidden?: boolean; attachmentTexts?: Record<string, string>; displayText?: string; messageOrigin?: import('@shared/types').AgentTurnMessage['messageOrigin']; triggerMeta?: import('@shared/types').MeetingCompanionTriggerMeta },
  ) => AgentTurnMessage;
  addReceiptMessage: (text: string) => void;
  addReceiptMessageToSession: (sessionId: string, text: string) => Promise<boolean>;
  assignTurnToMessage: (
    messageId: string,
    turnId: string,
    startedAt: number,
  ) => void;
  truncateToMessage: (
    targetMessageId: string,
    newText: string,
    attachments?: {
      id: string;
      name: string;
      path: string;
      relativePath: string;
      size: number;
    }[],
  ) => void;
  setError: (error: string | null) => void;
  clearBusy: () => void;
  setFocusedTurnId: (turnId: string | null) => void;
  setIsStopping: (value: boolean) => void;
  setShowConversation: (value: boolean) => void;
  setEditingMessageId: (id: string | null) => void;
  setPrivateMode: (value: boolean) => void;
  setCouncilMode: (value: boolean) => void;
  /**
   * Set or clear the "Finish line" criterion for the current session.
   * Passes the value through `normalizeFinishLine` and persists via the
   * existing session-upsert flow. `null` (or any empty/whitespace string)
   * clears the criterion.
   */
  setFinishLine: (value: string | null) => void;
  /** Set per-conversation model overrides (all fields at once) */
  setSessionModelOverrides: (overrides: {
    workingModel?: string;
    thinkingModel?: string;
    workingProfileId?: string;
    thinkingProfileId?: string;
    thinkingEffort?: import("@shared/types").ThinkingEffort;
  }) => void;
  /**
   * FOX-3494 (round-2 M2): clear the conversation's per-session model/thinking
   * overrides AND persist the snapshot. Used by the claude-under-ChatGPT-Pro
   * "Switch to GPT" recovery so the stale session-level Claude selection can't
   * loop the immediate retry OR any future turn back into the same Anthropic
   * terminal (session overrides take precedence over global settings in core).
   */
  clearSessionModelOverridesForRecovery: () => void;
  setAutoDoneEnabled: (value: boolean) => void;
  /** Toggle showAllChecks for meeting companion coach */
  setShowAllChecks: (value: boolean) => void;
  /** Set meeting companion metadata for current session */
  setMeetingCompanion: (meta: MeetingCompanionMeta | null) => void;
  /** Update coach selection for meeting companion */
  setMeetingCompanionCoach: (
    coach: MeetingCompanionMeta["coach"] | null,
  ) => void;
  setSetupContext: (context: AgentSession["setupContext"] | null) => void;
  setSetupContextForSession: (sessionId: string, context: AgentSession["setupContext"] | null) => void;
  setSetupContextPairSessionId: (pairSessionId: string) => void;

  /** Create a new session and switch currentSessionId to it (foreground operation).
   * For background session creation without switching, use createBackgroundSession(). */
  resetSession: () => string;
  /** Test-only hard reset after E2E harness deletes persisted sessions.
   * `deletedSessionIds` is the full set of ids the main process deleted from
   * disk (returned by the e2e:clear-all-sessions IPC). Tombstoning that set —
   * rather than only the currently-visible summaries — prevents a stale async
   * save / disk-reconciliation for ANY just-deleted id from resurrecting it
   * into the sidebar (the :619 phantom "Session A ready" failure). */
  clearAllSessionsForE2E: (deletedSessionIds?: readonly string[]) => string;
  /** Create a background session with a pre-generated ID without switching currentSessionId.
   * Used by MCP tools (rebel_conversations_start) to spawn conversations that don't disrupt the user.
   * `externalContext` carries cloud-routed inbound provenance (e.g. Slack thread metadata)
   * onto the session record so cloud merges, retries, and replies stay scoped to the originating channel. */
  createBackgroundSession: (
    sessionId: string,
    origin?: AgentSession["origin"],
    externalContext?: AgentSession["externalContext"],
    options?: { systemPromptPrefix?: string },
  ) => void;
  /** Clear an Operator-personalisation `systemPromptPrefix` from a loaded session
   * once it has been consumed by the first turn. The prefix is turn-scoped and
   * never persisted, so subsequent turns must not re-send it. */
  clearSystemPromptPrefixForSession: (sessionId: string) => void;
  snapshotCurrentSession: () => AgentSessionWithRuntime | null;

  processHistoryEvent: (
    sessionId: string,
    turnId: string,
    event: AgentEvent,
    /**
     * Stage 19c: authoritative provenance (envelope `AgentTurnEvent.sessionId`)
     * for the background-routed event, threaded from the engine. Independent of
     * the `sessionId` routing target, so it lets the ingress guard REJECT a
     * foreign-routed event instead of falling to `accepted-legacy`. Optional —
     * callers that omit it preserve the prior legacy-accept behaviour.
     */
    eventSessionId?: string,
  ) => void;
  addOrUpdateHistorySession: (
    session: AgentSessionWithRuntime,
    prepend?: boolean,
  ) => void;
  removeHistorySession: (sessionId: string) => void;
  /** Set session summaries for sidebar display */
  setSessionSummaries: (summaries: AgentSessionSummary[]) => void;
  /** Update a single session summary (for incremental updates) */
  updateSessionSummary: (summary: AgentSessionSummary) => void;
  /** Add or update a session in the LRU cache (touches for recency, evicts if over limit) */
  cacheSession: (session: AgentSessionWithRuntime) => void;
  /** Get a loaded session from the LRU cache (returns undefined if not loaded) */
  getLoadedSession: (id: string) => AgentSessionWithRuntime | undefined;
  /** Set loading state for async session loading */
  setLoadingSession: (sessionId: string | null) => void;
  togglePinSession: (sessionId: string) => void;
  toggleStarSession: (sessionId: string) => void;
  softDeleteSession: (sessionId: string) => void;
  restoreSession: (sessionId: string) => void;
  emptyTrash: () => void;
  renameSession: (sessionId: string, newTitle: string) => void;
  applyAutoGeneratedTitle: (
    sessionId: string,
    title: string,
    metadata: { autoTitleGeneratedAt: number; autoTitleTurnCount: number },
  ) => void;

  openHistorySession: (
    sessionId: string,
    fullFidelityEvents?: Record<string, AgentEvent[]>,
  ) => AgentSessionWithRuntime | null;
  ingestExternalSessions: (sessions: AgentSession[]) => AgentSession | null;

  setCurrentSessionMeta: (meta: Partial<SessionMetaState>) => void;

  // Compaction actions
  startCompaction: (depth: number, originalSessionId: string, turnId?: string) => void;
  setCompactionFallbackTarget: (targetLabel: string, turnId: string, originalSessionId: string) => void;
  setCompactionSummary: (summary: string, enhancedPromptOrTurnId: string, originalSessionId?: string, revealDurationMs?: number) => void;
  markCompactionRetrying: (turnId: string, originalSessionId: string) => void;
  setCompactionSkeleton: (turnId: string, originalSessionId: string) => void;
  setCompactionDepth4Attempt: (profileName: string, turnId: string, originalSessionId: string) => void;
  setCompactionUnavailable: (userFacingMessage: string, turnId: string, originalSessionId: string) => void;
  setCompactionError: (error: string, turnId?: string, originalSessionId?: string, reason?: ExhaustedReason | null) => void;
  completeCompaction: (turnId?: string, originalSessionId?: string) => void;
  resetCompaction: () => void;
  /** Perform in-place compaction: keep session ID, clear old events, add boundary marker.
   * When targetSessionId is provided and differs from currentSessionId, operates on
   * loadedSessions instead of the active session state (background session compaction). */
  performCompaction: (
    summary: string,
    depth: number,
    targetSessionId?: string,
  ) => void;

  /** Add a user message to a loaded (background) session. Returns the message or null if session not loaded. */
  addUserMessageToLoadedSession: (
    sessionId: string,
    text: string,
  ) => AgentTurnMessage | null;

  /** Assign a turnId to a message in a loaded (background) session. */
  assignTurnToLoadedSessionMessage: (
    sessionId: string,
    messageId: string,
    turnId: string,
  ) => void;

  /** Clear isBusy on a loaded (background) session after a failed turn start. */
  clearLoadedSessionBusy: (sessionId: string) => void;

  /** Persist a loaded (background) session to disk immediately. */
  persistLoadedSession: (sessionId: string) => void;

  // Safety-eval in-flight tracking (transient, UX-only)
  /** Record/refresh an in-flight safety eval entry for a tool use. Replaces previous entry on retry. */
  setSafetyEvalInFlight: (
    toolUseId: string,
    data: { attempt: number; startedAt: number; toolName: string },
  ) => void;
  /** Clear an in-flight safety eval entry (no-op if absent). */
  clearSafetyEvalInFlight: (toolUseId: string) => void;

  // Memory update status
  setMemoryUpdateStatus: (status: MemoryUpdateStatus) => void;
  setMemoryUpdateStatusForSession: (sessionId: string, status: MemoryUpdateStatus) => void;

  // Time saved status
  setTimeSavedStatus: (status: TimeSavedStatus) => void;
  setTimeSavedStatusForSession: (sessionId: string, status: TimeSavedStatus) => void;

  // Activity summary (per-turn AI sentence; 260618 show-more-activity).
  // The live broadcast carries an explicit sessionId/turnId, so this is the
  // single setter (no current-session-only variant). Applies to the loaded
  // session map when off-screen, top-level map when it's the current session.
  setActivitySummaryForSession: (sessionId: string, turnId: string, summary: string) => void;

  // Draft management
  /** Set draft for a specific session (safe for throttled calls after session switch) */
  setDraftForSession: (sessionId: string, text: string) => void;
  /** Set draft for current session (convenience wrapper) */
  setDraft: (text: string) => void;
  /** Get draft for current session */
  getCurrentDraft: () => DraftContent | null;
  /** Set pending conversation annotations for a specific session */
  setAnnotationsForSession: (
    sessionId: string,
    annotations: ConversationAnnotation[],
  ) => void;
  /** Get pending conversation annotations for a specific session */
  getAnnotationsForSession: (sessionId: string) => ConversationAnnotation[];
  /** Mirror dismissed AskUserQuestion batches so notification surfaces react to chat dismissal. */
  setDismissedQuestionBatchIdsForSession: (
    sessionId: string,
    batchIds: readonly string[],
  ) => void;
  /**
   * Atomic compare-and-swap upsert with awaited durable-persist acknowledgement.
   *
   * Used by the localStorage→store migration in `useDraftPersistence.ts` so we
   * can guarantee:
   *   1. **Atomic CAS**: if `expectedCurrent` is provided and the current
   *      `draftsBySessionId[sessionId]?.text` differs from it, the write is
   *      rejected with `{ ok: false, reason: 'concurrent_write' }`. This wins
   *      the migration-vs-keystroke race in favour of the user's typing.
   *   2. **Awaited durable-persist**: caller `await`s the resolution and only
   *      removes the localStorage original on `{ ok: true }`.
   *
   * See Stage 6 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md`
   * (90%-push critique C3 + post-spike Opus-High atomic-CAS amendment).
   */
  upsertDraftDurable: (
    sessionId: string,
    text: string,
    expectedCurrent?: string,
  ) => Promise<
    | { ok: true }
    | { ok: false; reason: 'concurrent_write' | 'persist_failure' | 'timeout' }
  >;

  // Interrupted session resume
  /**
   * Clear ALL data for an interrupted turn before re-executing.
   * Removes all events AND all messages (including user message) for that turnId.
   * The resume flow will create a fresh user message via submitQueuedMessage.
   */
  clearInterruptedTurnData: (turnId: string) => void;

  // Pending recording tracking (prevents empty sessions from being discarded during voice recording)
  /** Mark a session as having an active voice recording */
  markSessionHasPendingRecording: (sessionId: string) => void;
  /** Clear the pending recording marker for a session */
  clearSessionPendingRecording: (sessionId: string) => void;

  // Thinking text buffer (for extended thinking mode - shown separately from answer)
  /** Append thinking delta text for a turn (extended thinking mode) */
  appendThinkingDelta: (turnId: string, delta: string) => void;
  /** Clear thinking buffer for a turn (when thinking completes or turn ends) */
  clearThinkingBuffer: (turnId: string) => void;

  // Answer-phase tracking (Stage 1b — soft "still waiting" clear)
  /** Mark a turn as having entered the answer phase (first token received). Idempotent. */
  markAnswerStreaming: (turnId: string) => void;
  /** Drop a turn's answer-phase marker (on terminal / supersede / cleanup). */
  clearAnswerStreaming: (turnId: string) => void;

  // Auto-done support (toggle or explicit doneAfterComplete)
  /** Add turnId to mark-done on successful completion (supports concurrent sessions) */
  addDoneAfterTurnId: (turnId: string) => void;
  /** Remove turnId from done tracking (on completion or toggle-off) */
  removeDoneAfterTurnId: (turnId: string) => void;
  /** Mark role-not-configured toast as emitted once per session/role key. Returns true only on first mark. */
  markRoleNotConfiguredToastSeen: (sessionId: string, role: RoleNotConfiguredToastRole) => boolean;

  // Network reconnect auto-resume (memory-only, not persisted)
  /** Set pending turn for a session to retry when network connectivity returns */
  setPendingTurnForSession: (
    sessionId: string,
    turn: PendingNetworkRetryTurn,
  ) => void;
  /** Clear pending turn for a specific session, optionally triggering cache deletion */
  clearPendingTurnForSession: (
    sessionId: string,
    deleteCache?: boolean,
  ) => void;
  /** Clear all pending turns, optionally triggering cache deletion for each */
  clearAllPendingTurns: (deleteCache?: boolean) => void;
  /** Get count of pending turns */
  getPendingTurnCount: () => number;
  /** Get all pending turns sorted by failedAt (oldest first) */
  getAllPendingTurns: () => PendingNetworkRetryTurn[];
  /** Set whether resume-all is in progress */
  setIsResuming: (value: boolean) => void;
  /** Set whether the resume modal is snoozed */
  setResumeModalSnoozed: (value: boolean) => void;

  // Legacy single-turn API (kept for backward compatibility during migration)
  /** @deprecated Use setPendingTurnForSession instead */
  setPendingNetworkRetryTurn: (turn: PendingNetworkRetryTurn | null) => void;
  /** @deprecated Use clearPendingTurnForSession instead */
  clearPendingNetworkRetryTurn: () => void;

  _getSessionCounter: () => number;
  _incrementSessionCounter: () => void;
};

export type SessionStore = SessionStoreState & SessionStoreActions;
