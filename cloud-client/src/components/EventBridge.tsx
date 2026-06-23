// cloud-client/src/components/EventBridge.tsx
// Shared component that wires the real-time event channel into session and approval stores.
// Mount inside the authenticated branch of the app tree.

import { useCallback, useEffect, useRef } from 'react';
import type { AgentEvent } from '@shared/types';
import { useAuthStore } from '../auth/createAuthStore';
import { CloudClientError, SessionTombstonedError, catchUpContinuity, catchUpSession, isNetworkError } from '../cloudClient';
import { useEventChannel } from '../hooks/useEventChannel';
import { useSessionStore } from '../stores/sessionStore';
import type { ConnectionState } from '../stores/sessionStore';
import type { SessionMessage } from '../types';
import { useApprovalStore } from '../stores/approvalStore';
import { useInboxStore } from '../stores/inboxStore';
import { useStagedFilesStore } from '../stores/stagedFilesStore';
import { useSessionConflictStore } from '../stores/sessionConflictStore';
import { hashForBreadcrumb, type ContinuityErrorCategory, type ContinuityTransitionEvent } from '../observability/continuityEvents';
import {
  meetingEventEmitter,
  type CoachingCardEvent,
  type CompanionTurnStartedEvent,
  type TriggerDroppedEvent,
  type TriggerHeardEvent,
  type TriggerRateLimitExceededEvent,
} from '../utils/meetingEventEmitter';
import { getSessionMutex } from '../utils/sessionMutex';
import { safetyPromptEventEmitter } from '../utils/safetyPromptEventEmitter';
import type { SafetyPromptUpdatedEvent } from '../transport/approvalTransport';

const CATCH_UP_MAX_ATTEMPTS = 3;
const CATCH_UP_RETRY_BASE_MS = 750;
const CATCH_UP_UNUSUALLY_LARGE_THRESHOLD = 1_000;
const SERVER_RESTART_SEQ_GAP_THRESHOLD = 100;
const sessionMutex = getSessionMutex();

type BufferedLiveEvent = {
  channel: string;
  args: unknown[];
  index: number;
};

type SessionSeqEntry = [sessionId: string, appliedSeq: number];

type CatchUpAuxiliaryPayload = {
  messageDelta?: SessionMessage[];
  messageDeletes?: string[];
  destructiveOpsApplied?: {
    truncatedTurns: string[];
    deletedEventIdentities: string[];
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBufferedEventSeq(event: BufferedLiveEvent): number | null {
  const firstArg = event.args[0];
  if (!firstArg || typeof firstArg !== 'object') return null;

  if (
    event.channel === 'cloud:session-event'
    && 'event' in firstArg
    && firstArg.event
    && typeof firstArg.event === 'object'
    && typeof (firstArg.event as { seq?: unknown }).seq === 'number'
  ) {
    return (firstArg.event as { seq: number }).seq;
  }

  if (typeof (firstArg as { seq?: unknown }).seq === 'number') {
    return (firstArg as { seq: number }).seq;
  }
  return null;
}

function categorizeCatchUpError(err: unknown): ContinuityErrorCategory {
  if (err instanceof CloudClientError) {
    if (err.statusCode === 401 || err.statusCode === 403) return 'auth';
    if (err.statusCode === 408) return 'timeout';
    if (err.statusCode !== undefined && err.statusCode >= 500) return 'server-5xx';
    if (err.statusCode !== undefined && err.statusCode >= 400) return 'server-4xx';
  }
  if (isNetworkError(err)) return 'network';
  return 'unknown';
}

function getCatchUpEventIdentity(turnId: string, event: AgentEvent): string {
  if (typeof event.seq === 'number' && Number.isInteger(event.seq) && event.seq > 0) {
    return `${turnId}:seq:${event.seq}`;
  }
  const candidate = event as AgentEvent & { clientOrdinal?: unknown };
  const ordinalSuffix = typeof candidate.clientOrdinal === 'number' && Number.isInteger(candidate.clientOrdinal) && candidate.clientOrdinal >= 0
    ? `:ord:${candidate.clientOrdinal}`
    : '';
  return `${turnId}:type:${event.type}:ts:${event.timestamp}${ordinalSuffix}`;
}

function deduplicateCatchUpMessages(
  existing: SessionMessage[],
  incoming: SessionMessage[],
): SessionMessage[] {
  const messageMap = new Map<string, SessionMessage>();
  for (const message of existing) {
    messageMap.set(message.id, message);
  }
  for (const message of incoming) {
    if (!messageMap.has(message.id)) {
      messageMap.set(message.id, message);
    }
  }
  return Array.from(messageMap.values()).sort((a, b) => a.createdAt - b.createdAt);
}

function updateCurrentSessionForCatchUp(
  sessionId: string,
  updater: (session: NonNullable<ReturnType<typeof useSessionStore.getState>['currentSession']>) => NonNullable<ReturnType<typeof useSessionStore.getState>['currentSession']>,
): void {
  useSessionStore.setState((state) => {
    if (!state.currentSession || state.currentSession.id !== sessionId) return state;
    return {
      currentSession: updater(state.currentSession),
    };
  });
}

function applyDestructiveOpsApplied(sessionId: string, ops: CatchUpAuxiliaryPayload['destructiveOpsApplied']): void {
  if (!ops || (ops.truncatedTurns.length === 0 && ops.deletedEventIdentities.length === 0)) return;
  const identityDeletes = new Set(ops.deletedEventIdentities);
  updateCurrentSessionForCatchUp(sessionId, (session) => {
    const sessionWithEvents = session as typeof session & { eventsByTurn?: Record<string, AgentEvent[]> };
    const eventsByTurn: Record<string, AgentEvent[]> = { ...(sessionWithEvents.eventsByTurn ?? {}) };
    for (const turnId of ops.truncatedTurns) {
      delete eventsByTurn[turnId];
    }
    if (identityDeletes.size > 0) {
      for (const [turnId, events] of Object.entries(eventsByTurn)) {
        eventsByTurn[turnId] = events.filter((event) => !identityDeletes.has(getCatchUpEventIdentity(turnId, event)));
      }
    }
    return { ...session, eventsByTurn };
  });
}

function applyCatchUpMessageDelta(sessionId: string, messageDelta: SessionMessage[] | undefined): void {
  if (!messageDelta || messageDelta.length === 0) return;
  updateCurrentSessionForCatchUp(sessionId, (session) => ({
    ...session,
    messages: deduplicateCatchUpMessages(session.messages ?? [], messageDelta),
  }));
}

function applyCatchUpMessageDeletes(sessionId: string, messageDeletes: string[] | undefined): void {
  if (!messageDeletes || messageDeletes.length === 0) return;
  const deleteSet = new Set(messageDeletes);
  updateCurrentSessionForCatchUp(sessionId, (session) => ({
    ...session,
    messages: (session.messages ?? []).filter((message) => !deleteSet.has(message.id)),
  }));
}

export function EventBridge() {
  const reconnectBarrierActiveRef = useRef(false);
  const reconnectTaskRef = useRef<Promise<void> | null>(null);
  const bufferedLiveEventsRef = useRef<BufferedLiveEvent[]>([]);
  const bufferedLiveEventIndexRef = useRef(0);
  const connectAtRef = useRef<number | null>(null);

  const dispatchEvent = useCallback((channel: string, args: unknown[]) => {
    if (channel === 'cloud:session-changed') {
      const payload = args[0] as { sessionId: string; action: string };
      if (payload?.sessionId) {
        if (payload.action === 'deleted') {
          useSessionConflictStore.getState().clearSessionConflict(payload.sessionId);
        }
        useSessionStore.getState().handleSessionChanged(payload.sessionId, payload.action);
      }
    } else if (channel === 'cloud:session-event') {
      const payload = args[0] as { sessionId?: string; event?: AgentEvent } | undefined;
      if (payload?.sessionId && payload?.event) {
        useSessionStore.getState().applyCatchUpEvents(payload.sessionId, [payload.event]);
      }
    } else if (channel === 'cloud:session-conflict') {
      const payload = args[0] as {
        sessionId?: string;
        conflictType?: unknown;
        fields?: unknown;
        detectedAt?: unknown;
      } | undefined;
      if (
        payload?.sessionId
        && (payload.conflictType === 'stale-metadata' || payload.conflictType === 'concurrent-edit')
      ) {
        useSessionConflictStore.getState().markSessionConflict({
          sessionId: payload.sessionId,
          conflictType: payload.conflictType,
          fields: Array.isArray(payload.fields)
            ? payload.fields.filter((field): field is string => typeof field === 'string' && field.length > 0)
            : [],
          detectedAt: typeof payload.detectedAt === 'number' ? payload.detectedAt : Date.now(),
        });
      }
    } else if (channel === 'cloud:session-tombstoned') {
      const payload = args[0] as { sessionId: string; deletedAt: number; deletedBy: 'desktop' | 'mobile' | 'cloud'; ttlExpiresAt: number };
      if (payload?.sessionId && typeof payload.deletedAt === 'number') {
        useSessionConflictStore.getState().clearSessionConflict(payload.sessionId);
        useSessionStore.getState().handleSessionTombstoned(payload);
      }
    } else if (channel.startsWith('tool-safety:')) {
      useApprovalStore.getState().handleApprovalEvent(channel, args);
    } else if (channel === 'memory:staged-files-changed') {
      useStagedFilesStore.getState().handleStagedFilesChanged();
    } else if (channel.startsWith('memory:')) {
      useApprovalStore.getState().handleMemoryEvent(channel, args);
    } else if (channel === 'inbox:state') {
      useInboxStore.getState().handleInboxEvent(args);
    } else if (channel === 'meeting:coaching-card') {
      // Forward coaching card events to the typed meeting event emitter (F16)
      const payload = args[0] as CoachingCardEvent | undefined;
      if (payload?.sessionId && payload?.tip) {
        meetingEventEmitter.emit('coaching-card', payload);
      }
    } else if (channel === 'meeting:trigger-heard') {
      const payload = args[0] as TriggerHeardEvent | undefined;
      if (
        payload?.sessionId
        && payload?.triggerExtracted
        && typeof payload.triggeredAt === 'number'
      ) {
        meetingEventEmitter.emit('trigger-heard', payload);
      }
    } else if (channel === 'meeting:companion-turn-started') {
      const payload = args[0] as CompanionTurnStartedEvent | undefined;
      if (
        payload?.sessionId
        && payload?.turnId
        && payload?.companionSessionId
        && typeof payload.triggeredAt === 'number'
      ) {
        meetingEventEmitter.emit('companion-turn-started', payload);
      }
    } else if (channel === 'meeting:trigger-rate-limit-exceeded') {
      const payload = args[0] as TriggerRateLimitExceededEvent | undefined;
      if (payload?.sessionId && typeof payload.resetsAt === 'number') {
        meetingEventEmitter.emit('trigger-rate-limit-exceeded', payload);
      }
    } else if (channel === 'meeting:trigger-dropped') {
      const payload = args[0] as TriggerDroppedEvent | undefined;
      if (
        payload?.sessionId
        && payload?.reason
        && payload?.triggerExtracted
        && typeof payload.triggeredAt === 'number'
      ) {
        meetingEventEmitter.emit('trigger-dropped', payload);
      }
    } else if (channel === 'safety-prompt:updated') {
      // Cross-surface safety-prompt invalidation (Stage 0 of
      // docs/plans/260416_centralize_approval_and_diff_viewing_ux.md).
      // Full runtime validation (F-R2-11): version, lastUpdatedAt, lastUpdatedBy.
      const raw = args[0] as Record<string, unknown> | undefined;
      if (
        raw &&
        typeof raw.version === 'number' &&
        typeof raw.lastUpdatedAt === 'number' &&
        typeof raw.lastUpdatedBy === 'string' &&
        (raw.lastUpdatedBy === 'user' || raw.lastUpdatedBy === 'system' || raw.lastUpdatedBy === 'migration')
      ) {
        safetyPromptEventEmitter.emit('safety-prompt:updated', raw as unknown as SafetyPromptUpdatedEvent);
      } else {
        console.warn('[EventBridge] Dropped malformed safety-prompt:updated payload:', raw);
      }
    }
  }, []);

  const flushBufferedLiveEvents = useCallback(() => {
    const buffered = bufferedLiveEventsRef.current;
    if (buffered.length === 0) return;

    bufferedLiveEventsRef.current = [];
    buffered.sort((a, b) => {
      const aSeq = getBufferedEventSeq(a);
      const bSeq = getBufferedEventSeq(b);
      if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
      if (aSeq !== null && bSeq === null) return -1;
      if (aSeq === null && bSeq !== null) return 1;
      return a.index - b.index;
    });

    for (const event of buffered) {
      dispatchEvent(event.channel, event.args);
    }
  }, [dispatchEvent]);

  const runReconnectCatchUp = useCallback(async () => {
    const appliedSeqEntries = Object.entries(useSessionStore.getState().appliedSeq)
      .filter(([sessionId, seq]) => sessionId.length > 0 && typeof seq === 'number' && Number.isFinite(seq) && seq >= 0);
    const missedSince = appliedSeqEntries.length > 0
      ? Math.min(...appliedSeqEntries.map(([, seq]) => seq))
      : null;
    const sessionIdCount = appliedSeqEntries.length;
    const catchUpStartedAt = connectAtRef.current ?? Date.now();
    const recordContinuityEvent = (event: ContinuityTransitionEvent) => {
      useSessionStore.getState().recordContinuityEvent(event);
    };
    const recordServerRestartDetected = (sessionId: string, appliedSeq: number, serverSeq: number) => {
      const seqGap = serverSeq - appliedSeq;
      if (seqGap <= SERVER_RESTART_SEQ_GAP_THRESHOLD) return;
      recordContinuityEvent({
        family: 'continuity-state',
        message: 'transition',
        level: 'warning',
        data: {
          sessionIdHash: hashForBreadcrumb(sessionId),
          from: 'cloud_active',
          to: 'cloud_active',
          reason: 'server-restart-detected',
          direction: 'event-channel-reconnect',
          label: `seq-gap-${seqGap}`,
        },
      });
    };
    const applyTombstone = (sessionId: string, tombstone: SessionTombstonedError['tombstone']) => {
      useSessionConflictStore.getState().clearSessionConflict(sessionId);
      useSessionStore.getState().handleSessionTombstoned({
        ...tombstone,
        sessionId,
      });
      recordContinuityEvent({
        family: 'catch-up',
        message: 'catch-up-session-tombstoned',
        data: {
          sessionIdHash: hashForBreadcrumb(sessionId),
          reason: 'session-tombstoned',
          deletedAt: tombstone.deletedAt,
        },
      });
    };
    const applyCatchUpEventsForSession = async (sessionId: string, events: AgentEvent[]) => {
      let addedEvents = 0;
      await sessionMutex.withLock(sessionId, async () => {
        const applied = useSessionStore.getState().applyCatchUpEvents(sessionId, events);
        addedEvents += applied.addedEvents;
      });
      return addedEvents;
    };
    const applyCatchUpResultForSession = async (
      sessionId: string,
      events: AgentEvent[],
      auxiliary: CatchUpAuxiliaryPayload = {},
    ) => {
      const destructiveOps = auxiliary.destructiveOpsApplied;
      if (destructiveOps && (destructiveOps.truncatedTurns.length > 0 || destructiveOps.deletedEventIdentities.length > 0)) {
        applyDestructiveOpsApplied(sessionId, destructiveOps);
        recordContinuityEvent({
          family: 'catch-up',
          message: 'session-catch-up:destructive-op-applied',
          data: {
            sessionIdHash: hashForBreadcrumb(sessionId),
            truncatedTurnCount: destructiveOps.truncatedTurns.length,
            deletedEventIdentityCount: destructiveOps.deletedEventIdentities.length,
          },
        });
      }

      const addedEvents = await applyCatchUpEventsForSession(sessionId, events);

      if (auxiliary.messageDelta && auxiliary.messageDelta.length > 0) {
        applyCatchUpMessageDelta(sessionId, auxiliary.messageDelta);
        recordContinuityEvent({
          family: 'catch-up',
          message: 'session-catch-up:message-delta-applied',
          data: {
            sessionIdHash: hashForBreadcrumb(sessionId),
            messageCount: auxiliary.messageDelta.length,
          },
        });
      }

      if (auxiliary.messageDeletes && auxiliary.messageDeletes.length > 0) {
        applyCatchUpMessageDeletes(sessionId, auxiliary.messageDeletes);
        recordContinuityEvent({
          family: 'catch-up',
          message: 'session-catch-up:message-delete-applied',
          data: {
            sessionIdHash: hashForBreadcrumb(sessionId),
            messageDeleteCount: auxiliary.messageDeletes.length,
          },
        });
      }

      return addedEvents;
    };
    const runPerSessionCatchUp = async (entries: SessionSeqEntry[]) => {
      let addedEvents = 0;

      for (const [sessionId, fallbackSeq] of entries) {
        const appliedSeq = useSessionStore.getState().appliedSeq[sessionId] ?? fallbackSeq;
        try {
          const catchUpResult = await catchUpSession(sessionId, appliedSeq);
          recordServerRestartDetected(sessionId, appliedSeq, catchUpResult.serverSeq);
          addedEvents += await applyCatchUpResultForSession(sessionId, catchUpResult.events, catchUpResult);
        } catch (err) {
          if (err instanceof SessionTombstonedError) {
            applyTombstone(sessionId, err.tombstone);
            continue;
          }

          const statusCode = err instanceof CloudClientError ? err.statusCode : undefined;
          if (statusCode === 404 || statusCode === 400) {
            recordContinuityEvent({
              family: 'catch-up',
              message: 'catch-up-unavailable',
              level: 'warning',
              data: {
                missedSince,
                sessionIdCount,
                errorCategory: categorizeCatchUpError(err),
                errorStatusCode: statusCode,
              },
            });
            return { addedEvents, unavailable: true as const };
          }

          throw err;
        }
      }

      return { addedEvents, unavailable: false as const };
    };

    recordContinuityEvent({
      family: 'catch-up',
      message: 'catch-up-started',
      data: {
        missedSince,
        sessionIdCount,
      },
    });

    let totalAddedEvents = 0;
    let completedAttempt = false;

    for (let attempt = 1; attempt <= CATCH_UP_MAX_ATTEMPTS; attempt += 1) {
      try {
        totalAddedEvents = 0;

        if (sessionIdCount > 0) {
          const sessionIds = appliedSeqEntries.map(([sessionId]) => sessionId);
          const sinceSeq = Object.fromEntries(appliedSeqEntries);
          const unresolvedEntries: SessionSeqEntry[] = [];

          try {
            const catchUpResult = await catchUpContinuity({
              sinceSeq,
              sessionIds,
            });

            for (const [sessionId, appliedSeq] of appliedSeqEntries) {
              const sessionCatchUp = catchUpResult.sessions[sessionId] ?? {
                events: [],
                maxSeq: 0,
              };
              recordServerRestartDetected(sessionId, appliedSeq, Math.max(sessionCatchUp.maxSeq, appliedSeq));
              totalAddedEvents += await applyCatchUpResultForSession(sessionId, sessionCatchUp.events, sessionCatchUp);

              if (sessionCatchUp.events.length === 0 && sessionCatchUp.maxSeq === 0) {
                unresolvedEntries.push([sessionId, useSessionStore.getState().appliedSeq[sessionId] ?? appliedSeq]);
              }
            }
          } catch (err) {
            const statusCode = err instanceof CloudClientError ? err.statusCode : undefined;
            if (statusCode === 404 || statusCode === 400) {
              const legacyCatchUpResult = await runPerSessionCatchUp(appliedSeqEntries);
              totalAddedEvents += legacyCatchUpResult.addedEvents;
              if (legacyCatchUpResult.unavailable) {
                return;
              }
            } else {
              throw err;
            }
          }

          if (unresolvedEntries.length > 0) {
            const unresolvedCatchUpResult = await runPerSessionCatchUp(unresolvedEntries);
            totalAddedEvents += unresolvedCatchUpResult.addedEvents;
            if (unresolvedCatchUpResult.unavailable) {
              return;
            }
          }
        }

        await useSessionStore.getState().fetchSessions({ forceFullRefresh: true });
        const currentSessionId = useSessionStore.getState().currentSession?.id;
        if (currentSessionId) {
          useSessionStore.getState().handleSessionChanged(currentSessionId, 'upserted');
        }

        completedAttempt = true;
        break;
      } catch (err) {
        const statusCode = err instanceof CloudClientError ? err.statusCode : undefined;
        const errorCategory = categorizeCatchUpError(err);
        if (attempt >= CATCH_UP_MAX_ATTEMPTS) {
          recordContinuityEvent({
            family: 'catch-up',
            message: 'catch-up-failed',
            level: 'error',
            data: {
              missedSince,
              sessionIdCount,
              attempts: attempt,
              errorCategory,
              ...(typeof statusCode === 'number' ? { errorStatusCode: statusCode } : {}),
            },
          });
          return;
        }

        await sleep(CATCH_UP_RETRY_BASE_MS * (2 ** (attempt - 1)));
      }
    }

    if (!completedAttempt) return;

    const latencyMs = Math.max(0, Date.now() - catchUpStartedAt);
    recordContinuityEvent({
      family: 'catch-up',
      message: 'catch-up-success',
      data: {
        missedSince,
        addedEvents: totalAddedEvents,
        sessionIdCount,
        latencyMs,
      },
    });

    if (totalAddedEvents > CATCH_UP_UNUSUALLY_LARGE_THRESHOLD) {
      recordContinuityEvent({
        family: 'catch-up',
        message: 'catch-up-unusually-large',
        level: 'warning',
        data: {
          addedEvents: totalAddedEvents,
          missedSince,
        },
      });
    }
  }, []);

  const handleReconnect = useCallback(() => {
    if (reconnectTaskRef.current) return;

    reconnectBarrierActiveRef.current = true;
    const reconnectTask = (async () => {
      try {
        await runReconnectCatchUp();
      } finally {
        reconnectBarrierActiveRef.current = false;
        flushBufferedLiveEvents();
      }
    })();

    reconnectTaskRef.current = reconnectTask;
    void reconnectTask.finally(() => {
      reconnectTaskRef.current = null;
    });
  }, [flushBufferedLiveEvents, runReconnectCatchUp]);

  const handleEvent = useCallback((channel: string, args: unknown[]) => {
    if (!useAuthStore.getState().isPaired) return;

    if (reconnectBarrierActiveRef.current) {
      bufferedLiveEventsRef.current.push({
        channel,
        args,
        index: bufferedLiveEventIndexRef.current,
      });
      bufferedLiveEventIndexRef.current += 1;
      return;
    }

    dispatchEvent(channel, args);
  }, [dispatchEvent]);

  const handleConnectionStateChange = useCallback((state: ConnectionState) => {
    if (state === 'connected') {
      connectAtRef.current = Date.now();
    }
    useSessionStore.getState().setConnectionState(state);
  }, []);

  const { forceReconnect } = useEventChannel(handleEvent, handleConnectionStateChange, handleReconnect);

  // Store forceReconnect on sessionStore so non-React code (AppState, etc.) can trigger it
  useEffect(() => {
    useSessionStore.getState().setForceEventReconnect(forceReconnect);
    return () => {
      reconnectBarrierActiveRef.current = false;
      bufferedLiveEventsRef.current = [];
      reconnectTaskRef.current = null;
      useSessionStore.getState().setForceEventReconnect(null);
    };
  }, [forceReconnect]);

  return null;
}
