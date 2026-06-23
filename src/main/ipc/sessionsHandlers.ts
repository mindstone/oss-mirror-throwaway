/**
 * Sessions Domain IPC Handlers
 *
 * Handles agent session persistence and upstream session restoration.
 * Includes both legacy handlers (sessions:load, sessions:save) and new
 * lazy-loading handlers (sessions:list, sessions:get, sessions:upsert, sessions:delete).
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import type { AgentEvent, AgentSession } from '@shared/types';
import {
  deriveInteractionTimestamp,
  REPLAY_OPTIONS,
  updateConversationWithEvent,
  type ConversationStateShape,
} from '@shared/utils/conversationState';
import {
  getContentEquivalenceKey,
  getEventIdentity,
  unionEventsByIdentity,
  type SequencedAgentEvent,
} from '@shared/utils/eventIdentity';
import { validateEventForSession } from '@shared/utils/eventSessionValidation';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import { nextContentUpdatedAt } from '@shared/utils/sessionTimestamps';
import { getErrorReporter } from '@core/errorReporter';
import { registerHandler } from './utils/registerHandler';
import { clearSessionApprovals } from '../services/toolSafetyService';
import { onSessionsSaved } from '../services/conversationIndexService';
import { mcpAppModelContextStore } from '../services/mcpAppModelContextStore';
import {
  cleanupConversation as cleanupMcpAppTrustPermissionsForConversation,
  invalidateForConversation as invalidateMcpAppNoncesForConversation,
  invalidateForSession as invalidateMcpAppNoncesForSession,
} from '../services/mcpAppsTrust';
import { getIncrementalSessionStore } from '../services/incrementalSessionStore';
import type { SessionsSyncUpsertOutcome } from '@core/services/incrementalSessionStore';
import { getDiagnosticSummary } from '../services/diagnosticContextService';
import { generateConversationSummary } from '../services/conversationSummaryService';
import { generateNarrativeAnalysis } from '@core/services/narrativeAnalysisService';
import { exportConversationLogs } from '../services/conversationLogExportService';
import { getSettings } from '../settingsStore';
import { logger } from '@core/logger';
import { AgentSessionSchema } from '@shared/ipc/schemas/agent';
import { observingSafeParse } from '@shared/ipc/schemas/utils/observingSafeParse';
import { z } from 'zod';
import { getContentStore } from '@core/contentStore';
import { recordContentResolutionFailure } from '@core/services/contentResolutionFailureRecorder';
import { updateSessionWithReload } from '@core/services/lockedSessionPersistence';
import type { OwnerKind } from '@core/services/superMcpOwnerRegistry';
import type { SessionLockManager } from '@core/utils/sessionFileLock';

export interface SessionsHandlerDeps {
  loadAgentSessions: () => AgentSession[];
  /**
   * Stage 3: may return the batch upsert outcome so `sessions:save` fires
   * embedding hooks ONLY for sessions that actually persisted (tombstoned ids
   * are dropped at the store). Implementations that fire-and-forget (cloud
   * bootstrap) may still return void — the handler then preserves the
   * pre-Stage-3 hook behavior (drops remain protected by construction at the
   * store chokepoints either way).
   */
  saveAgentSessions: (
    sessions: AgentSession[],
  ) => void | SessionsSyncUpsertOutcome | Promise<void | SessionsSyncUpsertOutcome>;
  /**
   * Must surface the store's discriminated upsert outcome (Stage 2, 260612
   * recs-round5) so a dropped write (read-only store, corrupt-index abort,
   * version-forward index) is not reported to the renderer as `{success:true}`.
   * Both desktop (src/main/index.ts) and cloud (cloud-service/src/bootstrap.ts)
   * wire this through `upsertSessionsWithLocks`, which returns the outcome.
   */
  upsertAgentSession: (session: AgentSession) => Promise<SessionsSyncUpsertOutcome>;
  sessionLockManager: SessionLockManager;
  sessionLockOwnerKind: OwnerKind;
  /** Called after sessions are saved locally — triggers cloud outbox enqueue. */
  onSessionsSavedLocally?: (sessions: AgentSession[]) => void;
  /** Called after a session is deleted locally — propagates deletion to cloud. */
  onSessionDeletedLocally?: (sessionId: string) => void | Promise<void>;
}

function applyTurnEventUnionToSession(
  session: AgentSession,
  turnId: string,
  events: AgentEvent[],
): AgentSession {
  if (events.length === 0) {
    return session;
  }

  // Stage 19a (260506 Stage 3 — main-process union ingress): drop any event
  // whose own provenance sessionId is foreign to the session being persisted.
  // Fail-closed + structured telemetry; never throws. Legacy (no-sessionId)
  // events pass (counted) until the union requires sessionId everywhere.
  const validatedEvents = events.filter((event) => {
    const result = validateEventForSession(
      event as SequencedAgentEvent<AgentEvent>,
      session.id,
      { turnId, source: 'sessions-handler-union' },
    );
    if (result.ok || result.outcome.kind !== 'rejected-foreign') {
      return true;
    }
    getErrorReporter().addBreadcrumb({
      category: 'cross-session-event-dropped',
      message: 'Dropped foreign-session event during IPC turn-event union',
      level: 'warning',
      data: {
        source: 'sessions-handler-union',
        eventType: event.type,
        turnIdHash: hashSessionIdForBreadcrumb(turnId),
        targetSessionIdHash: hashSessionIdForBreadcrumb(result.outcome.targetSessionId),
        eventSessionIdHash: hashSessionIdForBreadcrumb(result.outcome.eventSessionId),
      },
    });
    return false;
  });

  if (validatedEvents.length === 0) {
    return session;
  }

  const baseEvents = session.eventsByTurn[turnId] ?? [];
  const unionedEvents = unionEventsByIdentity(turnId, baseEvents, validatedEvents, {
    onLegacyFallbackIdentityUsed: ({ legacyEventCount }) => {
      getErrorReporter().addBreadcrumb({
        category: 'event-identity-legacy-fallback',
        message: 'Legacy event identity fallback used during union',
        level: 'info',
        data: {
          turnIdHash: hashSessionIdForBreadcrumb(turnId),
          legacyEventCount,
        },
      });
    },
    onSeqGapDetected: ({ gaps }) => {
      const gapRanges = gaps.map((gap) => (
        gap.start === gap.end ? `${gap.start}` : `${gap.start}-${gap.end}`
      ));
      getErrorReporter().addBreadcrumb({
        category: 'event-identity-seq-gap',
        message: 'Event seq gap detected during union',
        level: 'warning',
        data: {
          turnIdHash: hashSessionIdForBreadcrumb(turnId),
          gapCount: gaps.length,
          gapRanges,
        },
      });
    },
    onContentEquivalentRestampCollapsed: ({ droppedSeq, retainedSeq }) => {
      logger.warn(
        {
          turnIdHash: hashSessionIdForBreadcrumb(turnId),
          droppedSeq,
          retainedSeq,
        },
        'Collapsed content-equivalent restamped event during IPC union persist',
      );
      getErrorReporter().addBreadcrumb({
        category: 'event-content-equivalent-restamp-collapsed',
        message: 'Content-equivalent restamped event collapsed during union',
        level: 'warning',
        data: {
          turnIdHash: hashSessionIdForBreadcrumb(turnId),
          droppedSeq,
          retainedSeq,
        },
      });
    },
  });

  const baseIdentities = new Set(baseEvents.map((event) => getEventIdentity(turnId, event)));
  const baseContentKeys = new Set(
    baseEvents
      .map((event) => getContentEquivalenceKey(turnId, event))
      .filter((key): key is string => key !== null),
  );
  const seen = new Set(baseIdentities);
  const seenContent = new Set(baseContentKeys);
  const novelEvents: AgentEvent[] = [];
  for (const event of validatedEvents) {
    const identity = getEventIdentity(turnId, event);
    if (seen.has(identity)) {
      continue;
    }
    const contentKey = getContentEquivalenceKey(turnId, event);
    if (contentKey !== null && seenContent.has(contentKey)) {
      continue;
    }
    seen.add(identity);
    if (contentKey !== null) seenContent.add(contentKey);
    novelEvents.push(event);
  }

  if (novelEvents.length === 0 && unionedEvents.length === baseEvents.length) {
    return session;
  }

  let conversationState: ConversationStateShape = {
    messages: session.messages,
    eventsByTurn: session.eventsByTurn,
    activeTurnId: session.activeTurnId ?? null,
    focusedTurnId: null,
    isBusy: session.isBusy ?? Boolean(session.activeTurnId),
    lastError: session.lastError ?? null,
    lastErrorSource: null,
    terminatedTurnIds: new Set(),
  };

  for (const event of novelEvents) {
    conversationState = updateConversationWithEvent(
      conversationState,
      turnId,
      event,
      REPLAY_OPTIONS,
    );
  }

  const terminalEvent = [...novelEvents].reverse().find(
    (event): event is Extract<AgentEvent, { type: 'result' | 'error' }> =>
      event.type === 'result' || event.type === 'error',
  );

  const previousTimestamp = session.updatedAt ?? session.createdAt ?? Date.now();
  const interactionTimestamp = deriveInteractionTimestamp(
    conversationState.messages,
    previousTimestamp,
  );
  const monotonicNow = nextContentUpdatedAt(previousTimestamp);
  const updatedAt = Math.max(interactionTimestamp, monotonicNow);

  return {
    ...session,
    messages: conversationState.messages,
    eventsByTurn: {
      ...conversationState.eventsByTurn,
      [turnId]: unionedEvents,
    },
    // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- IPC turn-event union replay writes projected liveness in-memory before updateSessionWithReload persists through store stamping.
    activeTurnId: conversationState.activeTurnId,
    // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- Replay-normalized busy scalar is accepted here; IncrementalSessionStore re-derives on disk write.
    isBusy: conversationState.isBusy,
    lastError: conversationState.lastError,
    resolvedAt: terminalEvent ? terminalEvent.timestamp : session.resolvedAt,
    updatedAt,
  };
}

export function registerSessionsHandlers(deps: SessionsHandlerDeps): void {
  const { loadAgentSessions, saveAgentSessions, upsertAgentSession } = deps;

  registerHandler('sessions:load', (_event: HandlerInvokeEvent) => {
    return loadAgentSessions();
  });

  registerHandler('sessions:save', async (_event: HandlerInvokeEvent, sessions: AgentSession[]) => {
    // Observability-only AgentSession validation at the IPC boundary
    // (260523 sweep Stage 7, Behavioral Safety F1). Logs structured
    // warnings on schema mismatch but does NOT throw — flipping to
    // enforce mode is a Phase 3 STOP trigger (user-visible behavior
    // change) deferred to a future stage after observe-mode collects
    // evidence that no caller is silently sending malformed payloads.
    // observe-mode only: schema mismatch warning must not block session persistence.
    void observingSafeParse({
      schema: z.array(AgentSessionSchema),
      payload: sessions,
      channel: 'sessions:save',
      log: logger,
    });

    const saveOutcome = await saveAgentSessions(sessions);

    // Note: Approval cleanup removed from bulk save — with upsert-only semantics,
    // the incoming batch is not the full truth. Approvals are cleaned up per-session
    // in sessions:delete instead.

    // Stage 3: fire embedding hooks ONLY for sessions that actually persisted
    // (a partial batch can have tombstoned ids dropped at the store). When the
    // dep returns no outcome (fire-and-forget impls), keep prior behavior.
    let sessionsForHooks = sessions;
    if (saveOutcome && typeof saveOutcome === 'object') {
      if (saveOutcome.outcome === 'persisted') {
        const persistedIds = new Set(saveOutcome.persistedSessionIds);
        sessionsForHooks = sessions.filter((session) => persistedIds.has(session.id));
      } else if (saveOutcome.outcome !== 'noop-empty-batch') {
        sessionsForHooks = [];
      }
    }

    // Trigger conversation embedding asynchronously (don't block save response)
    if (sessionsForHooks.length > 0) {
      onSessionsSaved(sessionsForHooks).catch((err) => {
        logger.warn({ err }, 'Failed to process sessions for conversation embedding');
      });
    }
    
    // Cloud sync for sessions:save is triggered from saveAgentSessions (index.ts)
    // AFTER the async disk write completes. This avoids a race where the outbox
    // drain reads stale data from disk before the write finishes.
    
    return { success: true };
  });

  // session:restore-upstream removed — Rebel Core is the sole runtime and does
  // not support server-side session resume. Stale SDK upstream IDs are no longer
  // restored. See: docs/plans/260406_fix_sdk_conversation_amnesia.md

  // ===========================================================================
  // New Lazy Loading Handlers (Stage 2 of session history lazy loading)
  // ===========================================================================

  /**
   * Load lightweight session summaries for sidebar display.
   * Returns only metadata, not full session content.
   */
  registerHandler('sessions:list', (_event: HandlerInvokeEvent) => {
    // Sidebar/UI endpoint: keep default filtering for internal delete-eligible sessions.
    return getIncrementalSessionStore().listSessions();
  });

  /**
   * Load full session content by ID (on-demand loading).
   */
  registerHandler(
    'sessions:get',
    async (_event: HandlerInvokeEvent, payload: { id: string }) => {
      return getIncrementalSessionStore().getSession(payload.id);
    }
  );

  /**
   * Save or update a single session.
   * Writes the session file and updates the index.
   * 
   * Side effects (matching sessions:save behavior):
   * - Triggers conversation embedding asynchronously
   * 
   * Note: We don't filter stale approvals here because we don't have the full
   * session list. Stale approval cleanup happens during bulk saves.
   */
  registerHandler(
    'sessions:upsert',
    async (_event: HandlerInvokeEvent, session: AgentSession) => {
      // Observability-only AgentSession validation at the IPC boundary
      // (260523 sweep Stage 7, Behavioral Safety F1). See sessions:save
      // for rationale and upgrade path.
      // observe-mode only: schema mismatch warning must not block session persistence.
      void observingSafeParse({
        schema: AgentSessionSchema,
        payload: session,
        channel: 'sessions:upsert',
        log: logger,
      });

      try {
        const result = await upsertAgentSession(session);

        // Stage 2 (260612 recs-round5, item 4b): a dropped write must NOT be
        // reported as success — and must not fire embedding/cloud hooks — for
        // a session that never landed on disk. Drops happen when the store is
        // read-only (breaker trip, forward-version protection, shutdown latch)
        // or when a reload-upsert aborts on an unrecoverable corrupt index.
        if (result.outcome === 'dropped') {
          logger.error(
            { sessionId: session.id, reason: result.reason },
            'sessions:upsert dropped — store refused the write',
          );
          return {
            success: false,
            error: { message: `Session write was not persisted (${result.reason})` },
          };
        }

        // Stage 3: a tombstone-dropped write means the id was hard-deleted
        // (delete-wins). Surface the drop — no {success:true}, no
        // embedding/cloud hooks for a write that never landed.
        if (result.outcome === 'all-dropped-tombstoned') {
          logger.warn(
            { sessionId: session.id },
            'sessions:upsert dropped — session id is hard-delete tombstoned (delete-wins)',
          );
          return {
            success: false,
            error: { message: 'Session write was not persisted (hard-deleted session)' },
          };
        }

        // Trigger conversation embedding asynchronously (don't block save response)
        // Pass single session as array - onSessionsSaved handles embedding eligibility checks
        onSessionsSaved([session]).catch((err) => {
          logger.warn({ err, sessionId: session.id }, 'Failed to process session for conversation embedding');
        });

        // Trigger cloud sync for the upserted session
        deps.onSessionsSavedLocally?.([session]);

        return { success: true };
      } catch (err) {
        logger.error({ err, sessionId: session.id }, 'sessions:upsert failed');
        return { success: false, error: { message: (err as Error).message } };
      }
    }
  );

  // Stage 3 delete-wins note: this handler is safe against tombstoned ids BY
  // CONSTRUCTION — `updateSessionWithReload` reads via `getSession` (the read
  // chokepoint returns null for a hard-deleted id), the update callback
  // returns null on a missing session, and the reload-upsert outcome gate
  // below converts any non-persisted write into `{updated:false}`. Do not add
  // a caller-side tombstone guard here.
  registerHandler(
    'sessions:apply-turn-event-union',
    async (
      _event: HandlerInvokeEvent,
      payload: { sessionId: string; turnId: string; events: AgentEvent[] },
    ) => {
      let mergedSession: AgentSession | null = null;
      try {
        const result = await updateSessionWithReload({
          sessionId: payload.sessionId,
          store: getIncrementalSessionStore(),
          lockManager: deps.sessionLockManager,
          ownerKind: deps.sessionLockOwnerKind,
          update: (existing) => {
            if (!existing) return null;
            mergedSession = applyTurnEventUnionToSession(
              existing,
              payload.turnId,
              payload.events,
            );
            return mergedSession;
          },
        });

        if (!result.updated || !mergedSession) {
          return { success: false, error: { message: 'Session not found' } };
        }

        onSessionsSaved([mergedSession]).catch((err) => {
          logger.warn(
            { err, sessionId: payload.sessionId },
            'Failed to process session for conversation embedding after event union',
          );
        });

        deps.onSessionsSavedLocally?.([mergedSession]);
        return { success: true };
      } catch (err) {
        logger.error(
          { err, sessionId: payload.sessionId, turnId: payload.turnId },
          'sessions:apply-turn-event-union failed',
        );
        return { success: false, error: { message: (err as Error).message } };
      }
    },
  );

  /**
   * Delete a session by ID.
   * Removes the session file and index entry.
   */
  registerHandler(
    'sessions:delete',
    async (_event: HandlerInvokeEvent, payload: { id: string }) => {
      try {
        // Intent: 'user-delete' (Stage 3 classification table) — genuine user
        // deletion via the UI (desktop, and cloud-routed via cloudRouter).
        // Writes the durable hard-delete ledger: stale writes can never
        // resurrect this id on disk.
        await getIncrementalSessionStore().deleteSession(payload.id, { intent: 'user-delete' });
        // Clean up pending approvals/staged actions for the deleted session.
        clearSessionApprovals(payload.id);
        cleanupMcpAppTrustPermissionsForConversation(payload.id);
        mcpAppModelContextStore.cleanupConversation(payload.id);
        invalidateMcpAppNoncesForConversation(payload.id);
        invalidateMcpAppNoncesForSession(payload.id);
        // Propagate deletion to cloud (demote continuity state + outbox delete).
        // Stage 2 startup cleanup reuses this same callback path via
        // IncrementalSessionStore.cleanupLeakedSessions({ onSessionDeletedLocally }).
        await deps.onSessionDeletedLocally?.(payload.id);
        return { success: true };
      } catch (err) {
        logger.error({ err, sessionId: payload.id }, 'sessions:delete failed');
        return { success: false, error: { message: (err as Error).message } };
      }
    }
  );

  /**
   * Get diagnostic summary for conversation diagnosis.
   * Returns lightweight metrics and file paths for deeper investigation.
   */
  registerHandler(
    'sessions:get-diagnostic-summary',
    async (_event: HandlerInvokeEvent, payload: { sessionId: string }) => {
      try {
        const summary = await getDiagnosticSummary(payload.sessionId);
        return { summary };
      } catch (err) {
        logger.error({ err, sessionId: payload.sessionId }, 'sessions:get-diagnostic-summary failed');
        return { summary: null, error: (err as Error).message };
      }
    }
  );

  /**
   * Generate an AI summary for a conversation mention.
   * Uses Claude Haiku to create a comprehensive summary for context injection.
   * Falls back gracefully for OAuth-only users or API failures.
   */
  registerHandler(
    'sessions:generate-summary',
    async (_event: HandlerInvokeEvent, payload: { sessionId: string }) => {
      try {
        const settings = getSettings();
        const session = await getIncrementalSessionStore().getSession(payload.sessionId);

        if (!session) {
          return { summary: null, error: 'Session not found', fallbackUsed: true };
        }

        const summary = await generateConversationSummary(settings, session);
        return {
          summary,
          fallbackUsed: summary === null,
        };
      } catch (err) {
        logger.error({ err, sessionId: payload.sessionId }, 'sessions:generate-summary failed');
        return { summary: null, error: (err as Error).message, fallbackUsed: true };
      }
    }
  );

  /**
   * Generate an AI narrative analysis for conversation diagnostics.
   * Uses Claude Haiku to identify waste, inefficiency, and provide a verdict.
   */
  registerHandler(
    'sessions:generate-narrative',
    async (_event: HandlerInvokeEvent, payload: { sessionId: string }) => {
      try {
        const settings = getSettings();
        const session = await getIncrementalSessionStore().getSession(payload.sessionId);

        if (!session) {
          return { narrative: null, error: 'Session not found' };
        }

        const narrative = await generateNarrativeAnalysis(settings, session);
        return { narrative };
      } catch (err) {
        logger.error({ err, sessionId: payload.sessionId }, 'sessions:generate-narrative failed');
        return { narrative: null, error: (err as Error).message };
      }
    }
  );

  /**
   * Export all logs related to a specific conversation session.
   * Aggregates turn-specific logs from logs/sessions/ directory.
   */
  registerHandler(
    'sessions:export-logs',
    async (_event: HandlerInvokeEvent, payload: { sessionId: string }) => {
      try {
        return await exportConversationLogs(payload.sessionId);
      } catch (err) {
        logger.error({ err, sessionId: payload.sessionId }, 'sessions:export-logs failed');
        return { success: false, error: (err as Error).message };
      }
    }
  );

  registerHandler(
    'sessions:read-content',
    async (_event: HandlerInvokeEvent, payload: { sessionId: string; contentId: string }) => {
      try {
        const result = await getContentStore().readContent({
          sessionId: payload.sessionId,
          contentId: payload.contentId,
        });
        if (result.reason === 'ok') {
          return {
            reason: 'ok' as const,
            bytesBase64: result.bytes.toString('base64'),
            mimeType: result.mimeType,
          };
        }
        if (result.reason === 'not-found') {
          return { reason: 'missing' as const };
        }
        if (result.reason === 'corrupt') {
          return { reason: 'corrupt' as const };
        }
        return { reason: 'unknown' as const };
      } catch (err) {
        recordContentResolutionFailure({
          sessionId: payload.sessionId,
          contentId: payload.contentId,
          reason: 'unknown',
          details: { err: err instanceof Error ? err.message : String(err) },
        });
        return { reason: 'unknown' as const };
      }
    }
  );

  registerHandler(
    'content:read',
    async (_event: HandlerInvokeEvent, payload: { sessionId: string; contentId: string }) => {
      try {
        const result = await getContentStore().readContent({
          sessionId: payload.sessionId,
          contentId: payload.contentId,
        });
        if (result.reason === 'ok') {
          return {
            reason: 'ok' as const,
            bytesBase64: result.bytes.toString('base64'),
            mimeType: result.mimeType,
          };
        }
        if (result.reason === 'not-found') {
          return { reason: 'missing' as const };
        }
        if (result.reason === 'corrupt') {
          return { reason: 'corrupt' as const };
        }
        return { reason: 'unknown' as const };
      } catch (err) {
        recordContentResolutionFailure({
          sessionId: payload.sessionId,
          contentId: payload.contentId,
          reason: 'unknown',
          details: { err: err instanceof Error ? err.message : String(err) },
        });
        return { reason: 'unknown' as const };
      }
    }
  );
}
