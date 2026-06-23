/**
 * Pure, stateless helper utilities for the renderer session store.
 *
 * Extracted from `sessionStore.ts` (behavior-preserving Stage 2) so the large
 * action-closure file holds the Zustand store wiring only. Every function here
 * is pure — state is passed in by argument, nothing captures module-level
 * mutable state. `sessionStore.ts` imports them back and re-exports the three
 * with external importers (`stripRuntime`, `normalizeCurrentSessionOrigin`,
 * `buildRuntimeFromSnapshot`) so the canonical `.../store/sessionStore` import
 * path keeps resolving.
 *
 * @see ./sessionStore.ts — the store implementation that consumes these helpers
 * @see docs/plans/260622_refactor-session-store/PLAN.md — extraction plan
 */
import type {
  AgentEvent,
  AgentSession,
  AgentSessionSummary,
  ConversationAnnotation,
} from "@shared/types";
import { createId } from "@shared/utils/id";
import { isSessionActive } from "@rebel/shared";
import type { AgentSessionWithRuntime } from "../types";
import {
  conversationReducer,
  runtimeReducer,
  type SessionRuntimeState,
} from "./reducers";
import { deriveTurnLiveness, toPersistedBusyScalars } from '@core/services/conversationState';
import { STALE_TURN_THRESHOLD_MS } from '@core/services/agentTurnReducer/runtime';
import {
  type EgressSession,
  stripSessionForEgress,
} from './rendererLocalEventEgress';
import type {
  CompactionState,
  NormalizedSessionOrigin,
  SessionStoreState,
  SummaryLivenessScalars,
} from './sessionStoreTypes';

/**
 * Utility to omit a key from an object (used for draft cleanup).
 * Returns a new object without the specified key.
 */
export const omit = <T extends Record<string, unknown>>(obj: T, key: string): T => {
  const { [key]: _, ...rest } = obj;
  return rest as T;
};

export const hasOwn = <T extends object>(obj: T, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

export const getLiveOrPersistedAnnotations = (
  state: SessionStoreState,
  sessionId: string,
  persistedSession?: AgentSession | null,
): ConversationAnnotation[] => {
  if (hasOwn(state.annotationsBySessionId, sessionId)) {
    return state.annotationsBySessionId[sessionId] ?? [];
  }
  const cachedSession = state.loadedSessions.get(sessionId);
  if (cachedSession && hasOwn(cachedSession, 'annotations')) {
    return cachedSession.annotations ?? [];
  }
  return persistedSession?.annotations ?? [];
};

export const createDraftPreviewSnippet = (text: string, maxLength: number): string => {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed.length > maxLength
    ? `${trimmed.slice(0, maxLength).trim()}…`
    : trimmed;
};

/**
 * Strip runtime from session before persisting.
 * Runtime is rebuilt from events on load, so it shouldn't be stored.
 *
 * `systemPromptPrefix` is also stripped: it's a turn-scoped seed for the
 * first turn of an Operator personalisation conversation and is never
 * persisted to disk (it would otherwise re-apply on every subsequent turn
 * and bloat the on-disk session record). The trusted copy lives in
 * main-process memory until consumed by `agent:turn`.
 */
export const stripRuntime = (
  session: AgentSessionWithRuntime & {
    focusedTurnId?: string | null;
    systemPromptPrefix?: string | null;
  },
): EgressSession =>
  stripSessionForEgress(session);

/**
 * Identifies draft-only sessions that should be cleaned up when limit is exceeded.
 * A draft-only session is one with:
 * - 0 messages AND has draft text or pending annotations
 * - NOT Active (doneAt is non-null)
 * - NOT soft-deleted (deletedAt is null)
 *
 * Returns array of session IDs to delete, sorted by oldest first.
 *
 * Stage 9: Changed from AgentSessionWithRuntime[] to AgentSessionSummary[] to support
 * lazy loading (we don't have full sessions at cleanup time).
 */
export function getDraftOnlySessionsToCleanup(
  summaries: AgentSessionSummary[],
  currentSessionId: string,
  maxDraftSessions: number,
): string[] {
  // Find all draft/annotation-only sessions (excluding current and Active)
  const draftOnlySessions = summaries.filter((summary) => {
    // Skip current session - user is actively working on it
    if (summary.id === currentSessionId) return false;
    // Skip Active sessions - user explicitly wants to keep them
    if (isSessionActive(summary)) return false;
    // Skip soft-deleted sessions - already in trash
    if (summary.deletedAt != null) return false;
    // Must have 0 messages (Stage 9: use messageCount from summary)
    if ((summary.messageCount ?? 0) > 0) return false;
    // Must have draft text or annotations (persisted into summary so we don't need live maps)
    return summary.hasDraft || Boolean(summary.hasAnnotations);
  });

  // If within limit, nothing to clean up
  if (draftOnlySessions.length <= maxDraftSessions) {
    return [];
  }

  // Sort by updatedAt ascending (oldest first) to delete oldest drafts
  const sorted = [...draftOnlySessions].sort((a, b) => {
    const aUpdatedAt = a.updatedAt ?? a.createdAt;
    const bUpdatedAt = b.updatedAt ?? b.createdAt;
    return aUpdatedAt - bUpdatedAt;
  });

  // Return IDs of sessions to delete (those exceeding the limit)
  const countToDelete = sorted.length - maxDraftSessions;
  return sorted.slice(0, countToDelete).map((s) => s.id);
}

const NORMALIZED_SESSION_ORIGINS: ReadonlySet<NormalizedSessionOrigin> = new Set([
  "manual",
  "automation",
  "role",
  "mcp-tool",
  "inbound-trigger",
  "plugin",
  "focus",
  "browser-extension",
  "operator-personalisation",
]);

export const normalizeCurrentSessionOrigin = (
  origin: AgentSession["origin"] | undefined,
  sessionId: string,
): NormalizedSessionOrigin => {
  void sessionId;
  if (origin && NORMALIZED_SESSION_ORIGINS.has(origin as NormalizedSessionOrigin)) {
    return origin as NormalizedSessionOrigin;
  }
  return "manual";
};

export const deriveSummaryLivenessFromProjection = (
  eventsByTurn: Record<string, AgentEvent[]> | undefined,
  declaredActiveTurnId: string | null,
): SummaryLivenessScalars => {
  const derived = deriveTurnLiveness(eventsByTurn ?? {}, Date.now(), {
    declaredActiveTurnId,
  });
  const persistedScalars = toPersistedBusyScalars(derived);
  return {
    ...persistedScalars,
    lastActivityAt: derived.lastActivityAt ?? derived.startedAt ?? null,
  };
};

export const applySummaryBusyStaleness = (
  summary: Pick<AgentSessionSummary, 'isBusy' | 'activeTurnId' | 'lastActivityAt'>,
  now: number,
): SummaryLivenessScalars => {
  const lastActivityAt = typeof summary.lastActivityAt === 'number'
    ? summary.lastActivityAt
    : null;
  const shouldClearStaleBusy = Boolean(
    summary.isBusy &&
    summary.activeTurnId &&
    lastActivityAt !== null &&
    now - lastActivityAt > STALE_TURN_THRESHOLD_MS,
  );
  if (shouldClearStaleBusy) {
    return {
      isBusy: false,
      activeTurnId: null,
      lastActivityAt,
    };
  }
  return {
    isBusy: summary.isBusy,
    activeTurnId: summary.activeTurnId,
    lastActivityAt,
  };
};

export const createInitialCompactionState = (): CompactionState => ({
  phase: "idle",
  statusMessage: "",
  summary: null,
  depth: 0,
  enhancedPrompt: null,
  originalSessionId: null,
  turnId: null,
  fallbackTarget: null,
  depth4ProfileName: null,
  revealDurationMs: null,
  reason: null,
});

/**
 * Build runtime state from a snapshot's events.
 * Used when ingesting external sessions or loading sessions lazily
 * to properly reconstruct timer state.
 */
export const buildRuntimeFromSnapshot = (
  activeTurnId: string | null,
  eventsByTurn: Record<string, AgentEvent[]> | undefined,
): SessionRuntimeState => {
  if (!eventsByTurn) {
    return runtimeReducer.createRuntimeState();
  }

  const liveness = deriveTurnLiveness(eventsByTurn, Date.now(), {
    declaredActiveTurnId: activeTurnId,
  });

  if (
    (liveness.status === 'running' || liveness.status === 'interrupted') &&
    liveness.activeTurnId !== null &&
    liveness.startedAt !== null
  ) {
    return runtimeReducer.createRuntimeState({
      startedAt: liveness.startedAt,
      lastActivityAt: liveness.lastActivityAt ?? liveness.startedAt,
      activeTurnId: liveness.activeTurnId,
      terminated: false,
    });
  }

  return runtimeReducer.createRuntimeState();
};

export const createInitialState = (): SessionStoreState => ({
  ...conversationReducer.createInitialConversationState(),
  focusedTurnId: null,
  eventsByTurnVersion: 0,
  runtime: runtimeReducer.createInitialRuntimeState(),
  currentSessionId: createId(),
  currentSessionTitle: "New Agent Run",
  currentSessionOrigin: "manual",
  currentSessionResolvedAt: null,
  // New session is Active (doneAt null = Active).
  currentSessionDoneAt: null,
  currentSessionStarredAt: null,
  privateMode: false,
  councilMode: false,
  sessionWorkingModel: undefined,
  sessionThinkingModel: undefined,
  sessionWorkingProfileId: undefined,
  sessionThinkingProfileId: undefined,
  sessionThinkingEffort: undefined,
  autoDoneEnabled: false,
  currentSessionCreatedAt: Date.now(),
  currentSessionMeetingCompanion: null,
  currentSessionSetupContext: null,
  currentSessionFinishLine: null,
  // delete-authority: init (initial empty state, not a producer)
  sessionSummaries: [],
  loadedSessions: new Map(),
  isLoadingSession: false,
  loadingSessionId: null,
  showConversation: false,
  editingMessageId: null,
  isStopping: false,
  compaction: createInitialCompactionState(),
  memoryUpdateStatusByTurn: {},
  timeSavedStatusByTurn: {},
  activitySummaryByTurn: {},
  compactionBoundaries: [],
  draftsBySessionId: {},
  annotationsBySessionId: {},
  pendingQuestionEventsBySessionId: {},
  dismissedQuestionBatchIdsBySessionId: {},
  pendingRecordingSessionIds: new Set(),
  thinkingTextByTurn: {},
  answerStreamingTurnIds: new Set(),
  doneAfterTurnIds: new Set(),
  roleNotConfiguredToastKeys: new Set(),
  autoDoneBySessionId: {},
  pendingNetworkRetryTurns: {},
  isResuming: false,
  resumeModalSnoozed: false,
  safetyEvalInFlight: {},
});
