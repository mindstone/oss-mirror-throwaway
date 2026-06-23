// cloud-client/src/stores/sessionStore.ts

import { create } from 'zustand';
import * as cloudClient from '../cloudClient';
import type {
  SessionSummary,
  SessionMessage,
  FullSession,
  SessionToolEvent,
  ImageContentBlock,
  ImageRef,
  SessionUserQuestionEvent,
  SessionUserQuestionAnsweredEvent,
} from '../types';
import type { AgentEvent } from '@shared/types';
import { ExternalContext as ExternalContextSchema, type ExternalContext } from '@rebel/shared';
// Import CompletedStep from the canonical reducer module rather than going via
// useAgentTurn — useAgentTurn imports from this store, so re-importing the type
// from there creates a circular dependency that madge flags.
import type { CompletedStep } from '@core/services/agentTurnReducer';
import { createLogger } from '../utils/logger';
import type { MissionContext, TaskProgressItem } from '../utils/missionTaskExtraction';
import { buildCacheKey, hydrateStore, persistStore, cancelAndRemoveKey } from '../persistence/persistenceHelpers';
import { getPersistence } from '../persistence/persistenceRegistry';
import { hashForBreadcrumb, type ContinuityTransitionEvent } from '../observability/continuityEvents';
import {
  decideSessionContentRegression,
  type RegressionGuardDecision,
} from './sessionContentRegressionGuard';

const log = createLogger('sessionStore');

let fetchSessionsTimer: ReturnType<typeof setTimeout> | null = null;
const FETCH_SESSIONS_DEBOUNCE_MS = 1_500;
const MAX_CACHED_CONVERSATIONS = 10;
/**
 * Bound on the in-memory set of positively-deleted (tombstoned) session ids.
 * Tombstones are a *positive* deletion signal used to decide whether a queued
 * turn targeting an absent session was genuinely deleted (recreate) vs simply
 * not-yet-synced (submit to the requested id). We retain only a recent window —
 * stale-queued-item drains happen close in time to the deletion — and evict
 * oldest-first to keep memory bounded over long-lived sessions.
 */
const MAX_TOMBSTONED_SESSION_IDS = 200;

/**
 * Adds session ids to the tombstone set, evicting oldest-first when over the
 * bound. Returns a new Set (referentially distinct so Zustand notifies) only
 * when something changed; otherwise returns the existing set unchanged.
 */
function addTombstonedSessionIds(
  existing: Set<string>,
  sessionIds: Iterable<string>,
): Set<string> {
  let next: Set<string> | null = null;
  for (const id of sessionIds) {
    if (!id) continue;
    if (existing.has(id) && next === null) continue;
    if (next === null) next = new Set(existing);
    next.add(id);
  }
  if (next === null) return existing;
  while (next.size > MAX_TOMBSTONED_SESSION_IDS) {
    // Sets preserve insertion order; the first key is the oldest.
    const oldest = next.values().next().value as string | undefined;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

/** If the watermark (max updatedAt) is older than this, do a full refresh instead of incremental. */
const FULL_REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const SEQ_UNAVAILABLE_BREADCRUMB_THROTTLE_MS = 60 * 60 * 1000;

type SessionTombstone = {
  sessionId: string;
  deletedAt: number;
  deletedBy: 'desktop' | 'mobile' | 'cloud';
  ttlExpiresAt: number;
};

let continuityRecorder: ((event: ContinuityTransitionEvent) => void) | null = null;
let lastSeqUnavailableBreadcrumbAt = 0;

export function setSessionContinuityRecorder(
  recorder: ((event: ContinuityTransitionEvent) => void) | null,
): void {
  continuityRecorder = recorder;
}

function emitContinuityTransition(event: ContinuityTransitionEvent): void {
  if (!continuityRecorder) return;
  try {
    continuityRecorder(event);
  } catch (err) {
    log.warn('Session continuity recorder failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Observable signal when the content-regression guard refuses a same-session
 * `currentSession` replace (silent failure is a bug — mirrors the desktop
 * `ingest-regression-refused` breadcrumb intent). `log.warn` routes to both the
 * console and, where wired, a Sentry breadcrumb (`category: log.sessionStore`,
 * level `warning`) via the logger's error reporter. The session id is hashed.
 */
function emitContentRegressionRefused(
  sessionId: string,
  site: 'cache' | 'rest',
  decision: RegressionGuardDecision,
): void {
  log.warn('fetchSession refused content-regressing currentSession replace', {
    sessionIdHash: hashForBreadcrumb(sessionId),
    site,
    reason: decision.reason,
    liveNonUserCount: decision.liveNonUserCount,
    incomingNonUserCount: decision.incomingNonUserCount,
    appliedSeq: decision.appliedSeq,
    incomingMaxSeq: decision.incomingMaxSeq,
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function assignEventProvenance(
  target: SessionUserQuestionEvent | SessionUserQuestionAnsweredEvent,
  candidate: Record<string, unknown>,
): void {
  if (typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0) {
    target.sessionId = candidate.sessionId;
  }
  if (isPositiveInteger(candidate.seq)) {
    target.seq = candidate.seq;
  }
}

function compareEventsBySeq(a: AgentEvent, b: AgentEvent): number {
  const aSeq = isPositiveInteger(a.seq) ? a.seq : Number.MAX_SAFE_INTEGER;
  const bSeq = isPositiveInteger(b.seq) ? b.seq : Number.MAX_SAFE_INTEGER;
  if (aSeq !== bSeq) return aSeq - bSeq;
  return a.timestamp - b.timestamp;
}

function getSessionOrderTimestamp(session: Pick<SessionSummary, 'updatedAt' | 'cloudUpdatedAt'>): number {
  return isFiniteNumber(session.cloudUpdatedAt) ? session.cloudUpdatedAt : session.updatedAt;
}

function withoutAppliedSeq(state: Record<string, number>, sessionId: string): Record<string, number> {
  if (!(sessionId in state)) return state;
  const { [sessionId]: _removed, ...rest } = state;
  return rest;
}

function mapImageContent(rawImageContent: unknown): ImageContentBlock[] | undefined {
  if (!Array.isArray(rawImageContent)) return undefined;

  const imageContent: ImageContentBlock[] = [];

  for (const block of rawImageContent) {
    if (!block || typeof block !== 'object') continue;

    const candidate = block as Record<string, unknown>;
    if (candidate.type !== 'image') continue;
    if (typeof candidate.data !== 'string' || candidate.data.length === 0) continue;
    if (typeof candidate.mimeType !== 'string') continue;

    imageContent.push({
      type: 'image',
      data: candidate.data,
      mimeType: candidate.mimeType,
    });
  }

  return imageContent.length > 0 ? imageContent : undefined;
}

function mapImageRefs(rawImageRef: unknown): (ImageRef | null)[] | undefined {
  if (!Array.isArray(rawImageRef)) return undefined;

  const refs: (ImageRef | null)[] = [];
  let sawRef = false;

  for (const entry of rawImageRef) {
    if (entry === null || entry === undefined) {
      refs.push(null);
      continue;
    }
    if (typeof entry !== 'object') {
      refs.push(null);
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.assetId !== 'string' || candidate.assetId.length === 0) {
      refs.push(null);
      continue;
    }
    if (typeof candidate.mimeType !== 'string' || candidate.mimeType.length === 0) {
      refs.push(null);
      continue;
    }
    if (typeof candidate.byteSize !== 'number' || !Number.isFinite(candidate.byteSize)) {
      refs.push(null);
      continue;
    }

    sawRef = true;
    // Preserve unknown fields per the additive ImageRef schema policy (D3).
    refs.push({ ...candidate } as ImageRef);
  }

  return sawRef ? refs : undefined;
}

function mapExternalContext(rawExternalContext: unknown): ExternalContext | undefined {
  if (rawExternalContext === undefined || rawExternalContext === null) return undefined;

  const result = ExternalContextSchema.safeParse(rawExternalContext);
  if (result.success) return result.data;

  log.warn('Dropping malformed session externalContext', {
    issueCount: result.error.issues.length,
  });
  return undefined;
}

/**
 * Extract `user_question` / `user_question_answered` events from the lean
 * session payload. Pair of {@link mapToolEventsByTurn} — both draw from the
 * same server-side `eventsByTurn` blob.
 *
 * Rehydration-only: the live path is still the WS / turn event stream. On
 * mount, the mobile hook merges this with live state, deduping by batchId.
 *
 * See docs/plans/260420_user_question_cross_surface_resilience.md (Stage 7).
 */
function mapUserQuestionEventsByTurn(
  rawEventsByTurn: unknown,
): Record<
  string,
  Array<SessionUserQuestionEvent | SessionUserQuestionAnsweredEvent>
> | undefined {
  if (!rawEventsByTurn || typeof rawEventsByTurn !== 'object') return undefined;

  const out: Record<
    string,
    Array<SessionUserQuestionEvent | SessionUserQuestionAnsweredEvent>
  > = {};

  for (const [turnId, events] of Object.entries(rawEventsByTurn as Record<string, unknown>)) {
    if (!Array.isArray(events)) continue;

    const mapped: Array<SessionUserQuestionEvent | SessionUserQuestionAnsweredEvent> = [];
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const candidate = event as Record<string, unknown>;
      const batchId = candidate.batchId;
      const timestamp = candidate.timestamp;
      if (typeof batchId !== 'string' || batchId.length === 0) continue;
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue;

      if (candidate.type === 'user_question') {
        const toolUseId = candidate.toolUseId;
        if (typeof toolUseId !== 'string' || toolUseId.length === 0) continue;
        if (!Array.isArray(candidate.questions)) continue;
        const mappedEvent: SessionUserQuestionEvent = {
          type: 'user_question',
          batchId,
          toolUseId,
          questions: candidate.questions as SessionUserQuestionEvent['questions'],
          timestamp,
        };
        assignEventProvenance(mappedEvent, candidate);
        mapped.push(mappedEvent);
        continue;
      }

      if (candidate.type === 'user_question_answered') {
        if (!Array.isArray(candidate.answers)) continue;
        const mappedEvent: SessionUserQuestionAnsweredEvent = {
          type: 'user_question_answered',
          batchId,
          answers: candidate.answers as SessionUserQuestionAnsweredEvent['answers'],
          timestamp,
        };
        assignEventProvenance(mappedEvent, candidate);
        if (candidate.skipped === true) {
          mappedEvent.skipped = true;
        }
        mapped.push(mappedEvent);
      }
    }

    if (mapped.length > 0) {
      out[turnId] = mapped;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function mapToolEventsByTurn(rawEventsByTurn: unknown): Record<string, SessionToolEvent[]> | undefined {
  if (!rawEventsByTurn || typeof rawEventsByTurn !== 'object') return undefined;

  const toolEventsByTurn: Record<string, SessionToolEvent[]> = {};

  for (const [turnId, events] of Object.entries(rawEventsByTurn as Record<string, unknown>)) {
    if (!Array.isArray(events)) continue;

    const toolEvents: SessionToolEvent[] = [];
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const candidate = event as Record<string, unknown>;
      if (candidate.type !== 'tool') continue;
      if (typeof candidate.toolName !== 'string') continue;
      if (candidate.stage !== 'start' && candidate.stage !== 'end') continue;
      if (typeof candidate.timestamp !== 'number' || !Number.isFinite(candidate.timestamp)) continue;

      const imageContent = mapImageContent(candidate.imageContent);
      const imageRef = mapImageRefs(candidate.imageRef);

      const mappedEvent: SessionToolEvent = {
        type: 'tool',
        toolName: candidate.toolName,
        detail: typeof candidate.detail === 'string' ? candidate.detail : '',
        stage: candidate.stage,
        isError: typeof candidate.isError === 'boolean' ? candidate.isError : undefined,
        toolUseId: typeof candidate.toolUseId === 'string' ? candidate.toolUseId : undefined,
        parentToolUseId: typeof candidate.parentToolUseId === 'string' ? candidate.parentToolUseId : undefined,
        timestamp: candidate.timestamp,
      };

      if (imageContent) {
        mappedEvent.imageContent = imageContent;
      }
      if (imageRef) {
        mappedEvent.imageRef = imageRef;
      }
      if (candidate.mcpAppUiMeta && typeof candidate.mcpAppUiMeta === 'object') {
        mappedEvent.mcpAppUiMeta = candidate.mcpAppUiMeta as SessionToolEvent['mcpAppUiMeta'];
      }
      if (candidate.toolResult && typeof candidate.toolResult === 'object') {
        mappedEvent.toolResult = candidate.toolResult as SessionToolEvent['toolResult'];
      }

      toolEvents.push(mappedEvent);
    }

    if (toolEvents.length > 0) {
      toolEventsByTurn[turnId] = toolEvents;
    }
  }

  return Object.keys(toolEventsByTurn).length > 0 ? toolEventsByTurn : undefined;
}

function validateCachedSessions(data: unknown): SessionSummary[] | null {
  if (!Array.isArray(data)) return null;

  for (const item of data) {
    if (!item || typeof item !== 'object') return null;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== 'string') return null;
    if (typeof candidate.title !== 'string') return null;
    if (typeof candidate.updatedAt !== 'number' || !Number.isFinite(candidate.updatedAt)) return null;
  }

  return data as SessionSummary[];
}

function validateCachedConversation(data: unknown): FullSession | null {
  if (!data || typeof data !== 'object') return null;
  const candidate = data as Record<string, unknown>;
  if (typeof candidate.id !== 'string') return null;
  if (!Array.isArray(candidate.messages)) return null;
  return data as FullSession;
}

function validateCachedConversationOrder(data: unknown): string[] | null {
  if (!Array.isArray(data)) return null;
  if (data.some((item) => typeof item !== 'string')) return null;
  return data as string[];
}

function buildConversationCacheKey(cachePrefix: string | null, sessionId: string): string | null {
  if (!cachePrefix) return null;
  return `${cachePrefix}${sessionId}`;
}

async function removeCachedConversation(cachePrefix: string | null, sessionId: string): Promise<void> {
  const cacheKey = buildConversationCacheKey(cachePrefix, sessionId);
  if (!cacheKey) return;

  try {
    await cancelAndRemoveKey(cacheKey);
  } catch (err) {
    log.warn('Failed to remove cached conversation key', {
      cacheKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function isDefinitiveSessionFetchError(err: unknown): boolean {
  if (err instanceof cloudClient.CloudClientError) {
    return err.statusCode === 401 || err.statusCode === 404;
  }

  if (err instanceof Error) {
    return /session not found/i.test(err.message);
  }

  return false;
}

export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected';

interface SessionState {
  sessions: SessionSummary[];
  isLoading: boolean;
  error: string | null;
  currentSession: FullSession | null;
  isLoadingSession: boolean;
  completedStepsByTurnId: Record<string, CompletedStep[]>;
  missionTaskByTurnId: Record<string, {
    mission: MissionContext | null;
    tasks: TaskProgressItem[];
    hasMissionSet?: boolean;
    touchedTaskIds?: string[];
  }>;
  /** Tracks the last fetchSessions options so event-driven refetches use the same filter.
   *  Note: forceFullRefresh is intentionally stripped before persisting. */
  _lastFetchOptions: { activeOnly?: boolean } | undefined;
  /** Internal cache key for persisted session summaries. */
  _cacheKey: string | null;
  /** Internal cache key prefix for per-conversation SWR cache entries (`conversation:{id}`). */
  _conversationCacheKeyPrefix: string | null;
  /** Internal cache key for persisted LRU order. */
  _conversationOrderKey: string | null;
  /** MRU-first order of cached conversation ids. */
  _conversationOrder: string[];
  /** Monotonic counter to guard against stale fetchSession responses overwriting newer data. */
  _fetchSessionGeneration: number;
  /** Cursor for incremental tombstone pull (`/api/sessions/tombstones?since=`). */
  lastTombstoneSyncAt: number | null;
  /**
   * In-memory set of session ids that have been *positively* tombstoned
   * (deleted) this runtime. Used to distinguish a genuinely-deleted session
   * (recreate a queued turn elsewhere) from a not-yet-synced new session
   * (submit to the requested id). Bounded by {@link MAX_TOMBSTONED_SESSION_IDS}
   * and cleared on {@link resetStore}; never inferred from store absence.
   */
  tombstonedSessionIds: Set<string>;
  /** Highest applied server event seq per session. */
  appliedSeq: Record<string, number>;
  /** Internal coalescing flags for event-driven current-session refetches. */
  _sessionFetchInFlight: boolean;
  _sessionFetchDirty: boolean;
  /** WebSocket connection state for the real-time event channel. */
  connectionState: ConnectionState;
  /**
   * Imperative reconnect trigger registered by EventBridge.
   * Stored here so non-React code (AppState handlers, NetInfo callbacks) can trigger
   * an immediate event channel reconnect without going through React.
   */
  forceEventReconnect: (() => void) | null;

  hydrate: (cloudUrl: string) => Promise<void>;
  fetchSessions: (options?: { activeOnly?: boolean; forceFullRefresh?: boolean }) => Promise<void>;
  fetchSession: (id: string) => Promise<void>;
  snapshotCompletedSteps: (turnId: string, steps: CompletedStep[]) => void;
  snapshotMissionTask: (turnId: string, mission: MissionContext | null, tasks: TaskProgressItem[], opts?: { hasMissionSet?: boolean; touchedTaskIds?: string[] }) => void;
  applyEventIfNew: (sessionId: string, event: { seq?: number } | null | undefined) => boolean;
  recordAppliedSeq: (sessionId: string, event: { seq?: number } | null | undefined) => boolean;
  applyCatchUpEvents: (sessionId: string, events: AgentEvent[]) => { addedEvents: number; highestSeq: number };
  recordContinuityEvent: (event: ContinuityTransitionEvent) => void;
  deleteSessionOptimistically: (sessionId: string, surface?: 'mobile' | 'desktop') => Promise<void>;
  clearCurrentSession: () => void;
  resetStore: () => void;
  handleSessionChanged: (sessionId: string, action: string) => void;
  handleSessionTombstoned: (tombstone: SessionTombstone) => void;
  /** True iff the session id has been positively tombstoned (deleted) this runtime. */
  isSessionTombstoned: (sessionId: string) => boolean;
  setConnectionState: (state: ConnectionState) => void;
  setForceEventReconnect: (fn: (() => void) | null) => void;
}

function getInitialSessionState(): Pick<
  SessionState,
  | 'sessions'
  | 'isLoading'
  | 'error'
  | 'currentSession'
  | 'isLoadingSession'
  | 'completedStepsByTurnId'
  | 'missionTaskByTurnId'
  | '_lastFetchOptions'
  | '_cacheKey'
  | '_conversationCacheKeyPrefix'
  | '_conversationOrderKey'
  | '_conversationOrder'
  | '_fetchSessionGeneration'
  | 'lastTombstoneSyncAt'
  | 'tombstonedSessionIds'
  | 'appliedSeq'
  | '_sessionFetchInFlight'
  | '_sessionFetchDirty'
  | 'connectionState'
  | 'forceEventReconnect'
> {
  return {
    sessions: [],
    isLoading: false,
    error: null,
    currentSession: null,
    isLoadingSession: false,
    completedStepsByTurnId: {},
    missionTaskByTurnId: {},
    _lastFetchOptions: undefined,
    _cacheKey: null,
    _conversationCacheKeyPrefix: null,
    _conversationOrderKey: null,
    _conversationOrder: [],
    _fetchSessionGeneration: 0,
    lastTombstoneSyncAt: null,
    tombstonedSessionIds: new Set<string>(),
    appliedSeq: {},
    _sessionFetchInFlight: false,
    _sessionFetchDirty: false,
    connectionState: 'disconnected',
    forceEventReconnect: null,
  };
}

export const useSessionStore = create<SessionState>((set, get) => ({
  ...getInitialSessionState(),

  hydrate: async (cloudUrl: string) => {
    const cacheKey = buildCacheKey(cloudUrl, 'sessions');
    const conversationCacheKeyPrefix = buildCacheKey(cloudUrl, 'conversation:');
    const conversationOrderKey = buildCacheKey(cloudUrl, 'conversationOrder');
    set({
      _cacheKey: cacheKey,
      _conversationCacheKeyPrefix: conversationCacheKeyPrefix,
      _conversationOrderKey: conversationOrderKey,
    });

    const [cachedSessions, cachedConversationOrder] = await Promise.all([
      hydrateStore(cacheKey, validateCachedSessions),
      hydrateStore(conversationOrderKey, validateCachedConversationOrder),
    ]);

    if (cachedConversationOrder !== null) {
      set({ _conversationOrder: cachedConversationOrder });
    }
    if (cachedSessions !== null) {
      set({ sessions: cachedSessions });
    }

    const tombstoneSince = get().lastTombstoneSyncAt ?? undefined;
    try {
      const tombstoneResponse = await cloudClient.getTombstones(tombstoneSince);
      const tombstones = tombstoneResponse.tombstones;
      const hasServerNow = typeof tombstoneResponse.serverNow === 'number' && Number.isFinite(tombstoneResponse.serverNow);
      if (tombstones.length === 0) {
        if (hasServerNow) {
          set((state) => ({
            lastTombstoneSyncAt: Math.max(state.lastTombstoneSyncAt ?? 0, tombstoneResponse.serverNow!),
          }));
        }
        return;
      }

      const sessionIds = new Set(tombstones.map((t) => t.sessionId));
      const stateBefore = get();
      const hadSessions = new Set(stateBefore.sessions.map((s) => s.id));
      const currentSessionId = stateBefore.currentSession?.id ?? null;
      let maxDeletedAt = tombstones.reduce((max, t) => Math.max(max, t.deletedAt), stateBefore.lastTombstoneSyncAt ?? 0);
      if (hasServerNow) {
        maxDeletedAt = Math.max(maxDeletedAt, tombstoneResponse.serverNow!);
      }

      set((state) => {
        const updatedSessions = state.sessions.filter((session) => !sessionIds.has(session.id));
        const updatedOrder = state._conversationOrder.filter((cachedId) => !sessionIds.has(cachedId));
        const clearsCurrent = state.currentSession ? sessionIds.has(state.currentSession.id) : false;
        let nextAppliedSeq = state.appliedSeq;
        for (const removedSessionId of sessionIds) {
          const updatedAppliedSeq = withoutAppliedSeq(nextAppliedSeq, removedSessionId);
          if (updatedAppliedSeq !== nextAppliedSeq) {
            nextAppliedSeq = updatedAppliedSeq;
          }
        }

        return {
          sessions: updatedSessions,
          _conversationOrder: updatedOrder,
          currentSession: clearsCurrent ? null : state.currentSession,
          completedStepsByTurnId: clearsCurrent ? {} : state.completedStepsByTurnId,
          missionTaskByTurnId: clearsCurrent ? {} : state.missionTaskByTurnId,
          lastTombstoneSyncAt: maxDeletedAt,
          appliedSeq: nextAppliedSeq,
          tombstonedSessionIds: addTombstonedSessionIds(state.tombstonedSessionIds, sessionIds),
        };
      });

      const stateAfter = get();
      if (stateAfter._cacheKey) {
        persistStore(stateAfter._cacheKey, stateAfter.sessions);
      }
      if (stateAfter._conversationOrderKey) {
        persistStore(stateAfter._conversationOrderKey, stateAfter._conversationOrder);
      }

      for (const tombstone of tombstones) {
        void removeCachedConversation(stateAfter._conversationCacheKeyPrefix, tombstone.sessionId);
        if (hadSessions.has(tombstone.sessionId) || currentSessionId === tombstone.sessionId) {
          emitContinuityTransition({
            family: 'continuity-state',
            message: 'transition',
            data: {
              sessionIdHash: hashForBreadcrumb(tombstone.sessionId),
              from: 'cloud_active',
              to: 'local_only',
              reason: 'tombstone-applied',
              direction: 'mobile-pull',
              tombstoneCount: tombstones.length,
              lastTombstoneSyncAt: maxDeletedAt,
            },
          });
        }
        if (currentSessionId === tombstone.sessionId) {
          emitContinuityTransition({
            family: 'continuity-state',
            message: 'transition',
            level: 'warning',
            data: {
              sessionIdHash: hashForBreadcrumb(tombstone.sessionId),
              from: 'cloud_active',
              to: 'local_only',
              reason: 'tombstone-race-detected',
              direction: 'mobile-pull',
              tombstoneCount: tombstones.length,
              lastTombstoneSyncAt: maxDeletedAt,
            },
          });
        }
      }
    } catch (err) {
      log.warn('Failed to hydrate tombstones', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  fetchSessions: async (options?: { activeOnly?: boolean; forceFullRefresh?: boolean }) => {
    // Strip forceFullRefresh from persisted options so debounced refetches
    // (handleSessionChanged) don't inherit a one-shot full refresh.
    const { forceFullRefresh: _strip, ...persistedOptions } = options ?? {};
    set({ isLoading: true, error: null, _lastFetchOptions: Object.keys(persistedOptions).length > 0 ? persistedOptions : undefined });

    const { sessions } = get();
    const orderingWatermark = sessions.length > 0 ? Math.max(...sessions.map(getSessionOrderTimestamp)) : null;
    // IMPORTANT: `cloudUpdatedAt` is a server-monotonic ordering token, not wall-clock time.
    // We intentionally use client `updatedAt` for this local freshness heuristic.
    const freshnessWatermark = sessions.length > 0 ? Math.max(...sessions.map((s) => s.updatedAt)) : null;

    // Decide incremental vs full fetch
    const useIncremental =
      !options?.forceFullRefresh &&
      orderingWatermark != null &&
      freshnessWatermark != null &&
      Date.now() - freshnessWatermark <= FULL_REFRESH_THRESHOLD_MS;

    // Build API options (exclude forceFullRefresh — it's store-level only)
    const baseApiOptions: { activeOnly?: boolean } | undefined = options?.activeOnly ? { activeOnly: true } : undefined;

    if (useIncremental) {
      const incrementalOptions = { ...baseApiOptions, modifiedSince: orderingWatermark };
      log.info('fetchSessions: incremental', {
        orderingWatermark,
        freshnessWatermark,
        age: freshnessWatermark != null ? Date.now() - freshnessWatermark : null,
      });
      try {
        const { sessions: data, totalCount } = await cloudClient.getSessions(incrementalOptions);
        const typedData = data as SessionSummary[];

        // Merge: upsert returned sessions into existing ones by id
        const sessionMap = new Map(sessions.map(s => [s.id, s]));
        for (const session of typedData) {
          sessionMap.set(session.id, session);
        }
        const merged = Array.from(sessionMap.values()).sort((a, b) => getSessionOrderTimestamp(b) - getSessionOrderTimestamp(a));

        if (merged.length === totalCount) {
          set({ sessions: merged, isLoading: false });
          const cacheKey = get()._cacheKey;
          if (cacheKey) {
            persistStore(cacheKey, merged);
          }
          return;
        }

        // Count mismatch — stale sessions in local store. Fall through to full refresh.
        log.info('fetchSessions: count mismatch after incremental merge, triggering full refresh', {
          localCount: merged.length,
          serverTotalCount: totalCount,
        });
      } catch (err) {
        // Incremental failed — fall back to full fetch
        log.warn('fetchSessions: incremental failed, falling back to full', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      log.info('fetchSessions: full', {
        reason: options?.forceFullRefresh ? 'forceFullRefresh' : orderingWatermark == null ? 'no sessions' : 'stale watermark',
        orderingWatermark,
        freshnessWatermark,
      });
    }

    // Full fetch (either by decision or as fallback from failed incremental)
    try {
      const { sessions: data } = await cloudClient.getSessions(baseApiOptions);
      const sorted = (data as SessionSummary[]).sort((a, b) => getSessionOrderTimestamp(b) - getSessionOrderTimestamp(a));
      set({ sessions: sorted, isLoading: false });
      const cacheKey = get()._cacheKey;
      if (cacheKey) {
        persistStore(cacheKey, sorted);
      }
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to load sessions',
      });
    }
  },

  fetchSession: async (id: string) => {
    // Increment monotonic generation counter to guard against stale responses.
    // If another fetchSession call arrives before this one resolves, our
    // generation will be stale and we skip writing to currentSession.
    const generation = get()._fetchSessionGeneration + 1;
    set({ error: null, _fetchSessionGeneration: generation });

    const conversationCacheKeyPrefix = get()._conversationCacheKeyPrefix;
    const conversationCacheKey = buildConversationCacheKey(conversationCacheKeyPrefix, id);
    if (conversationCacheKey) {
      const cachedConversation = await hydrateStore(conversationCacheKey, validateCachedConversation);
      if (cachedConversation) {
        if (get()._fetchSessionGeneration !== generation) return;
        // Content-regression guard: a stale per-conversation cache (validated for
        // id+messages only) must not clobber a live transcript already enriched by
        // reconnect catch-up messageDelta. Refuse only a strict same-session shrink.
        const cacheState = get();
        const cacheDecision = decideSessionContentRegression(
          cacheState.currentSession,
          cachedConversation,
          cacheState.appliedSeq[id] ?? 0,
        );
        if (cacheDecision.refuse) {
          emitContentRegressionRefused(id, 'cache', cacheDecision);
        } else {
          set({ currentSession: cachedConversation });
        }
      }
    }

    if (get()._fetchSessionGeneration !== generation) return;
    set({ isLoadingSession: true });
    try {
      const raw = (await cloudClient.getSession(id)) as Record<string, unknown>;
      const toolEventsByTurn = mapToolEventsByTurn(raw.eventsByTurn);
      const userQuestionEventsByTurn = mapUserQuestionEventsByTurn(raw.eventsByTurn);
      const cloudUpdatedAt = isFiniteNumber(raw.cloudUpdatedAt) ? raw.cloudUpdatedAt : undefined;
      const rawMaxSeq = isPositiveInteger(raw.maxSeq) ? raw.maxSeq : undefined;
      const externalContext = mapExternalContext(raw.externalContext);
      // Map the full AgentSession to our lean FullSession shape
      const meetingCompanion = raw.meetingCompanion && typeof raw.meetingCompanion === 'object'
        ? (raw.meetingCompanion as { meetingUrl: string })
        : undefined;
      const finishLine = typeof raw.finishLine === 'string' && raw.finishLine.length > 0
        ? raw.finishLine
        : undefined;
      // Lifecycle fields must survive into currentSession or the detail view's
      // Mark-as-done ⇄ Reopen toggle never sees Done state (it reads doneAt via
      // strict null). Carry a numeric timestamp or an explicit null; treat any
      // other shape as absent. See docs/plans/260614_done-state-rename.
      const doneAt = isFiniteNumber(raw.doneAt) ? raw.doneAt : raw.doneAt === null ? null : undefined;
      const starredAt = isFiniteNumber(raw.starredAt) ? raw.starredAt : raw.starredAt === null ? null : undefined;
      const data: FullSession = {
        id: (raw.id as string) ?? id,
        title: (raw.title as string) ?? 'Untitled',
        messages: (raw.messages as SessionMessage[]) ?? [],
        ...(cloudUpdatedAt !== undefined ? { cloudUpdatedAt } : {}),
        activeTurnId: (raw.activeTurnId as string | null) ?? null,
        isBusy: (raw.isBusy as boolean) ?? false,
        lastError: (raw.lastError as string | null) ?? null,
        ...(rawMaxSeq !== undefined ? { maxSeq: rawMaxSeq } : {}),
        ...(externalContext ? { externalContext } : {}),
        toolEventsByTurn,
        ...(userQuestionEventsByTurn ? { userQuestionEventsByTurn } : {}),
        ...(meetingCompanion ? { meetingCompanion } : {}),
        ...(finishLine !== undefined ? { finishLine } : {}),
        ...(doneAt !== undefined ? { doneAt } : {}),
        ...(starredAt !== undefined ? { starredAt } : {}),
      };
      let restRefused = false;
      let staleGeneration = false;
      set((state) => {
        // Guard against stale fetch overwriting a newer request
        if (state._fetchSessionGeneration !== generation) {
          // A newer fetchSession superseded us. This obsolete response was
          // blocked from currentSession; it must ALSO be blocked from the
          // per-conversation cache below, or it would poison the cache with a
          // snapshot the store already decided not to trust.
          staleGeneration = true;
          return state;
        }

        const currentAppliedSeq = state.appliedSeq[id] ?? 0;

        // Content-regression guard (defense-in-depth): even the server REST
        // snapshot must not regress a live transcript enriched by reconnect
        // catch-up. The server is authoritative + seq-monotonic, so a richer or
        // equal snapshot always wins. The REST branch refuses ONLY on the robust
        // seq signal (`maxSeq < appliedSeq`) — NOT on message count, since a
        // fresh authoritative server snapshot may legitimately have fewer
        // messages and refusing it would strand the view on stale data.
        // appliedSeq still advances to max(current, rawMaxSeq) so a refusal never
        // drags the dedupe baseline down.
        const restDecision = decideSessionContentRegression(state.currentSession, data, currentAppliedSeq, {
          useMessageCountSignal: false,
        });
        const nextAppliedSeqValue = rawMaxSeq !== undefined ? Math.max(currentAppliedSeq, rawMaxSeq) : currentAppliedSeq;
        const nextAppliedSeq = nextAppliedSeqValue !== currentAppliedSeq
          ? { ...state.appliedSeq, [id]: nextAppliedSeqValue }
          : state.appliedSeq;

        if (restDecision.refuse) {
          // Keep the live transcript; still clear the loading flag and advance
          // the dedupe baseline. Defer the breadcrumb out of the reducer.
          restRefused = true;
          queueMicrotask(() => emitContentRegressionRefused(id, 'rest', restDecision));
          return {
            isLoadingSession: false,
            appliedSeq: nextAppliedSeq,
          };
        }

        const completedStepsByTurnId = { ...state.completedStepsByTurnId };
        if (toolEventsByTurn) {
          for (const turnId of Object.keys(toolEventsByTurn)) {
            delete completedStepsByTurnId[turnId];
          }
        }
        // Note: missionTaskByTurnId is NOT evicted here — WS snapshots have
        // full-fidelity data while REST tool event details are truncated to
        // 500 chars. Snapshots are only cleared on session clear/delete.

        return {
          currentSession: data,
          isLoadingSession: false,
          completedStepsByTurnId,
          appliedSeq: nextAppliedSeq,
        };
      });

      // Skip cache-persist when the REST snapshot was refused as a regression
      // (persisting the poorer `data` would re-poison the per-conversation
      // cache) or when a newer fetch superseded this generation (an obsolete
      // response must not persist either).
      if (!restRefused && !staleGeneration && !data.isBusy && conversationCacheKey) {
        const {
          toolEventsByTurn: _stripTool,
          userQuestionEventsByTurn: _stripUq,
          ...cacheableSession
        } = data;
        persistStore(conversationCacheKey, cacheableSession);

        const conversationOrderKey = get()._conversationOrderKey;
        let evictedConversationId: string | null = null;
        let nextConversationOrder: string[] = [];
        set((state) => {
          const dedupedOrder = state._conversationOrder.filter((cachedId) => cachedId !== id);
          nextConversationOrder = [id, ...dedupedOrder];

          if (nextConversationOrder.length > MAX_CACHED_CONVERSATIONS) {
            evictedConversationId = nextConversationOrder.pop() ?? null;
          }

          return { _conversationOrder: nextConversationOrder };
        });

        if (conversationOrderKey) {
          persistStore(conversationOrderKey, nextConversationOrder);
        }

        if (evictedConversationId) {
          await removeCachedConversation(conversationCacheKeyPrefix, evictedConversationId);
        }
      }
    } catch (err) {
      // Guard against stale fetch overwriting a newer request
      if (get()._fetchSessionGeneration !== generation) return;

      const definitiveError = isDefinitiveSessionFetchError(err);
      if (definitiveError) {
        set({
          currentSession: null,
          isLoadingSession: false,
          completedStepsByTurnId: {},
          missionTaskByTurnId: {},
          error: err instanceof Error ? err.message : 'Failed to load session',
        });
        return;
      }

      set({
        isLoadingSession: false,
        error: err instanceof Error ? err.message : 'Failed to load session',
      });
    }
  },

  snapshotCompletedSteps: (turnId: string, steps: CompletedStep[]) => {
    if (!turnId || steps.length === 0) return;
    set((state) => ({
      completedStepsByTurnId: {
        ...state.completedStepsByTurnId,
        [turnId]: steps.map((step) => ({ ...step })),
      },
    }));
  },

  snapshotMissionTask: (turnId, mission, tasks, opts) => {
    if (!turnId) return;
    set((state) => ({
      missionTaskByTurnId: {
        ...state.missionTaskByTurnId,
        [turnId]: {
          mission: mission ? { ...mission } : null,
          tasks: tasks.map((task) => ({ ...task })),
          hasMissionSet: opts?.hasMissionSet,
          touchedTaskIds: opts?.touchedTaskIds,
        },
      },
    }));
  },

  applyEventIfNew: (sessionId, event) => {
    if (!sessionId || !event) return true;
    const seq = event.seq;
    if (!isPositiveInteger(seq)) {
      const now = Date.now();
      if (now - lastSeqUnavailableBreadcrumbAt >= SEQ_UNAVAILABLE_BREADCRUMB_THROTTLE_MS) {
        lastSeqUnavailableBreadcrumbAt = now;
        emitContinuityTransition({
          family: 'continuity-state',
          message: 'transition',
          level: 'warning',
          data: {
            sessionIdHash: hashForBreadcrumb(sessionId),
            from: 'cloud_active',
            to: 'cloud_active',
            reason: 'seq-unavailable',
            direction: 'mobile-turn-event',
          },
        });
      }
      return true;
    }

    const currentAppliedSeq = get().appliedSeq[sessionId] ?? 0;
    if (seq > currentAppliedSeq + 1) {
      emitContinuityTransition({
        family: 'catch-up',
        message: 'seq-gap-detected',
        level: 'warning',
        data: {
          sessionIdHash: hashForBreadcrumb(sessionId),
          reason: 'seq-gap-detected',
          seq,
          appliedSeq: currentAppliedSeq,
          missedCount: seq - currentAppliedSeq - 1,
        },
      });
    }

    if (seq <= currentAppliedSeq) {
      emitContinuityTransition({
        family: 'catch-up',
        message: 'seq-already-applied',
        data: {
          sessionIdHash: hashForBreadcrumb(sessionId),
          reason: 'seq-already-applied',
          incomingSeq: seq,
          appliedSeq: currentAppliedSeq,
        },
      });
      return false;
    }
    set((state) => ({
      appliedSeq: {
        ...state.appliedSeq,
        [sessionId]: seq,
      },
    }));
    return true;
  },

  recordAppliedSeq: (sessionId, event) => {
    return get().applyEventIfNew(sessionId, event);
  },

  applyCatchUpEvents: (sessionId, events) => {
    if (!sessionId || !Array.isArray(events) || events.length === 0) {
      const highestSeq = sessionId ? (get().appliedSeq[sessionId] ?? 0) : 0;
      return { addedEvents: 0, highestSeq };
    }

    const orderedEvents = [...events].sort(compareEventsBySeq);
    let addedEvents = 0;
    for (const event of orderedEvents) {
      if (get().applyEventIfNew(sessionId, event)) {
        addedEvents += 1;
      }
    }

    const highestSeq = get().appliedSeq[sessionId] ?? 0;
    if (addedEvents > 0) {
      get().handleSessionChanged(sessionId, 'upserted');
    }

    return { addedEvents, highestSeq };
  },

  recordContinuityEvent: (event) => {
    emitContinuityTransition(event);
  },

  deleteSessionOptimistically: async (sessionId: string, surface?: 'mobile' | 'desktop') => {
    const previous = get();
    const updatedSessions = previous.sessions.filter((session) => session.id !== sessionId);
    const updatedOrder = previous._conversationOrder.filter((cachedId) => cachedId !== sessionId);
    const clearsCurrent = previous.currentSession?.id === sessionId;

    set({
      sessions: updatedSessions,
      _conversationOrder: updatedOrder,
      currentSession: clearsCurrent ? null : previous.currentSession,
      completedStepsByTurnId: clearsCurrent ? {} : previous.completedStepsByTurnId,
      missionTaskByTurnId: clearsCurrent ? {} : previous.missionTaskByTurnId,
      appliedSeq: withoutAppliedSeq(previous.appliedSeq, sessionId),
      tombstonedSessionIds: addTombstonedSessionIds(previous.tombstonedSessionIds, [sessionId]),
    });

    if (previous._cacheKey) {
      persistStore(previous._cacheKey, updatedSessions);
    }
    if (previous._conversationOrderKey) {
      persistStore(previous._conversationOrderKey, updatedOrder);
    }

    try {
      const deleteResult = await cloudClient.deleteSession(sessionId, surface);
      const previousCursor = previous.lastTombstoneSyncAt;
      const serverCursor = isFiniteNumber(deleteResult.tombstone?.deletedAt)
        ? deleteResult.tombstone.deletedAt
        : isFiniteNumber(deleteResult.serverNow)
          ? deleteResult.serverNow
          : null;
      const nextCursor = serverCursor === null
        ? previousCursor
        : Math.max(previousCursor ?? 0, serverCursor);

      if (nextCursor !== previousCursor) {
        set({ lastTombstoneSyncAt: nextCursor });
      }

      if (serverCursor === null) {
        emitContinuityTransition({
          family: 'continuity-state',
          message: 'transition',
          level: 'warning',
          data: {
            sessionIdHash: hashForBreadcrumb(sessionId),
            from: 'cloud_active',
            to: 'cloud_active',
            reason: 'tombstone-cursor-missing-server-time',
            direction: surface ? `${surface}-delete` : 'cloud-delete',
            tombstoneCount: 1,
            ...(previousCursor !== null ? { lastTombstoneSyncAt: previousCursor } : {}),
          },
        });
      }

      emitContinuityTransition({
        family: 'continuity-state',
        message: 'transition',
        data: {
          sessionIdHash: hashForBreadcrumb(sessionId),
          from: 'cloud_active',
          to: 'local_only',
          reason: 'tombstone-added',
          direction: surface ? `${surface}-delete` : 'cloud-delete',
          tombstoneCount: 1,
          ...(nextCursor !== null ? { lastTombstoneSyncAt: nextCursor } : {}),
        },
      });

      void removeCachedConversation(previous._conversationCacheKeyPrefix, sessionId);
    } catch (err) {
      // Optimistic delete failed -> roll back, including the tombstone marker so
      // a still-valid session isn't misclassified as deleted on a later drain.
      set({
        sessions: previous.sessions,
        _conversationOrder: previous._conversationOrder,
        currentSession: previous.currentSession,
        completedStepsByTurnId: previous.completedStepsByTurnId,
        missionTaskByTurnId: previous.missionTaskByTurnId,
        appliedSeq: previous.appliedSeq,
        tombstonedSessionIds: previous.tombstonedSessionIds,
      });
      if (previous._cacheKey) {
        persistStore(previous._cacheKey, previous.sessions);
      }
      if (previous._conversationOrderKey) {
        persistStore(previous._conversationOrderKey, previous._conversationOrder);
      }
      throw err;
    }
  },

  clearCurrentSession: () => set((state) => ({
    currentSession: null,
    completedStepsByTurnId: {},
    missionTaskByTurnId: {},
    // Bump generation to invalidate any in-flight fetchSession from the
    // previous conversation — prevents stale data from repopulating.
    _fetchSessionGeneration: state._fetchSessionGeneration + 1,
  })),

  resetStore: () => {
    if (fetchSessionsTimer) {
      clearTimeout(fetchSessionsTimer);
      fetchSessionsTimer = null;
    }
    lastSeqUnavailableBreadcrumbAt = 0;
    set(getInitialSessionState());
  },

  handleSessionChanged: (sessionId: string, action: string) => {
    if (action === 'deleted') {
      const state = get();
      const updatedSessions = state.sessions.filter((s) => s.id !== sessionId);
      const hadSession = updatedSessions.length !== state.sessions.length;
      const updatedOrder = state._conversationOrder.includes(sessionId)
        ? state._conversationOrder.filter((cachedId) => cachedId !== sessionId)
        : state._conversationOrder;
      const clearsCurrent = state.currentSession?.id === sessionId;

      set((prev) => ({
        sessions: updatedSessions,
        _conversationOrder: updatedOrder,
        currentSession: clearsCurrent ? null : prev.currentSession,
        completedStepsByTurnId: clearsCurrent ? {} : prev.completedStepsByTurnId,
        missionTaskByTurnId: clearsCurrent ? {} : prev.missionTaskByTurnId,
        appliedSeq: withoutAppliedSeq(prev.appliedSeq, sessionId),
        tombstonedSessionIds: addTombstonedSessionIds(prev.tombstonedSessionIds, [sessionId]),
        _fetchSessionGeneration: prev._fetchSessionGeneration + 1,
        _sessionFetchDirty: false,
        isLoadingSession: false,
      }));

      const nextState = get();
      if (nextState._cacheKey) {
        persistStore(nextState._cacheKey, nextState.sessions);
      }
      if (nextState._conversationOrderKey) {
        persistStore(nextState._conversationOrderKey, nextState._conversationOrder);
      }

      void removeCachedConversation(nextState._conversationCacheKeyPrefix, sessionId);

      if (hadSession || clearsCurrent) {
        emitContinuityTransition({
          family: 'continuity-state',
          message: 'transition',
          data: {
            sessionIdHash: hashForBreadcrumb(sessionId),
            from: 'cloud_active',
            to: 'local_only',
            reason: 'tombstone-applied',
            direction: 'mobile-pull',
          },
        });
      }
      return;
    }
    // Upserted -- debounce refetch to avoid hammering during rapid events.
    // Re-use the same filter the active screen last requested.
    if (fetchSessionsTimer) clearTimeout(fetchSessionsTimer);
    fetchSessionsTimer = setTimeout(() => {
      get().fetchSessions(get()._lastFetchOptions);
    }, FETCH_SESSIONS_DEBOUNCE_MS);
    // If we're viewing this session, refresh with coalescing:
    // allow only one in-flight fetch and run one trailing fetch if more events arrive.
    const current = get().currentSession;
    if (current?.id === sessionId) {
      const fetchCurrentSessionCoalesced = () => {
        const state = get();
        if (state._sessionFetchInFlight) {
          set({ _sessionFetchDirty: true });
          return;
        }

        set({ _sessionFetchInFlight: true });
        void state.fetchSession(sessionId).finally(() => {
          set({ _sessionFetchInFlight: false });

          if (!get()._sessionFetchDirty) return;
          set({ _sessionFetchDirty: false });

          if (get().currentSession?.id === sessionId) {
            fetchCurrentSessionCoalesced();
          }
        });
      };

      fetchCurrentSessionCoalesced();
    }
  },

  handleSessionTombstoned: (tombstone: SessionTombstone) => {
    if (!tombstone?.sessionId) return;

    const state = get();
    const updatedSessions = state.sessions.filter((s) => s.id !== tombstone.sessionId);
    const hadSession = updatedSessions.length !== state.sessions.length;
    const updatedOrder = state._conversationOrder.filter((cachedId) => cachedId !== tombstone.sessionId);
    const clearsCurrent = state.currentSession?.id === tombstone.sessionId;
    const nextCursor = Math.max(state.lastTombstoneSyncAt ?? 0, tombstone.deletedAt);

    set({
      sessions: updatedSessions,
      _conversationOrder: updatedOrder,
      currentSession: clearsCurrent ? null : state.currentSession,
      completedStepsByTurnId: clearsCurrent ? {} : state.completedStepsByTurnId,
      missionTaskByTurnId: clearsCurrent ? {} : state.missionTaskByTurnId,
      appliedSeq: withoutAppliedSeq(state.appliedSeq, tombstone.sessionId),
      lastTombstoneSyncAt: nextCursor,
      tombstonedSessionIds: addTombstonedSessionIds(state.tombstonedSessionIds, [tombstone.sessionId]),
      _fetchSessionGeneration: state._fetchSessionGeneration + 1,
      _sessionFetchDirty: false,
      isLoadingSession: false,
    });

    const nextState = get();
    if (nextState._cacheKey) {
      persistStore(nextState._cacheKey, nextState.sessions);
    }
    if (nextState._conversationOrderKey) {
      persistStore(nextState._conversationOrderKey, nextState._conversationOrder);
    }

    void removeCachedConversation(nextState._conversationCacheKeyPrefix, tombstone.sessionId);

    emitContinuityTransition({
      family: 'continuity-state',
      message: 'transition',
      data: {
        sessionIdHash: hashForBreadcrumb(tombstone.sessionId),
        from: 'cloud_active',
        to: 'local_only',
        reason: 'tombstone-broadcast-received',
        direction: 'mobile-pull',
        tombstoneCount: 1,
        lastTombstoneSyncAt: nextCursor,
      },
    });

    if (hadSession || clearsCurrent) {
      emitContinuityTransition({
        family: 'continuity-state',
        message: 'transition',
        data: {
          sessionIdHash: hashForBreadcrumb(tombstone.sessionId),
          from: 'cloud_active',
          to: 'local_only',
          reason: 'tombstone-applied',
          direction: 'mobile-pull',
          tombstoneCount: 1,
          lastTombstoneSyncAt: nextCursor,
        },
      });
    }

    if (clearsCurrent) {
      emitContinuityTransition({
        family: 'continuity-state',
        message: 'transition',
        level: 'warning',
        data: {
          sessionIdHash: hashForBreadcrumb(tombstone.sessionId),
          from: 'cloud_active',
          to: 'local_only',
          reason: 'tombstone-race-detected',
          direction: 'mobile-pull',
          tombstoneCount: 1,
          lastTombstoneSyncAt: nextCursor,
        },
      });
    }
  },

  isSessionTombstoned: (sessionId: string): boolean => {
    if (!sessionId) return false;
    return get().tombstonedSessionIds.has(sessionId);
  },

  setConnectionState: (state: ConnectionState) => set({ connectionState: state }),
  setForceEventReconnect: (fn) => set({ forceEventReconnect: fn }),
}));

export function __resetSessionStoreSeqTrackingForTests(): void {
  lastSeqUnavailableBreadcrumbAt = 0;
}
