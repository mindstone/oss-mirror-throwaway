import { useCallback } from 'react';
import type { AgentEvent, AgentSession } from '@shared/types';

import type { EmitLogFn } from '@renderer/contexts';
import type { SessionStore } from '../store/sessionStore';
import { buildRuntimeFromSnapshot, toastNotifications } from '../store';

type RecoveryEvent = Extract<AgentEvent, { type:
  | 'recovery:started'
  | 'recovery:fallback_attempting'
  | 'recovery:fallback_succeeded'
  | 'recovery:compacting'
  | 'recovery:summary_ready'
  | 'recovery:retrying'
  | 'recovery:skeleton_attempting'
  | 'recovery:depth4_attempting'
  | 'recovery:succeeded'
  | 'recovery:failed'
  | 'recovery:last_resort_skipped'
}>;

type SessionStoreApi = {
  getState: () => SessionStore;
  setState: (partial: Partial<SessionStore> | ((state: SessionStore) => Partial<SessionStore>)) => void;
};

function targetLabel(target: Extract<RecoveryEvent, { type: 'recovery:fallback_attempting' }>['target']): string {
  if (target.kind === 'profile') return target.profileName ?? target.profileId ?? 'the recovery profile';
  return target.modelName ?? 'the recovery model';
}

async function reloadCanonicalSession(store: SessionStoreApi, sessionId: string): Promise<void> {
  const session = await window.sessionsApi.get({ id: sessionId });
  if (!session) return;
  const snapshot = session as AgentSession;
  const runtime = buildRuntimeFromSnapshot(snapshot.activeTurnId, snapshot.eventsByTurn);
  store.getState().cacheSession({ ...snapshot, runtime });
}

function evictLoadedSession(store: SessionStoreApi, sessionId: string): void {
  store.setState((state) => {
    if (!state.loadedSessions.has(sessionId)) return {};
    const loadedSessions = new Map(state.loadedSessions);
    loadedSessions.delete(sessionId);
    return { loadedSessions };
  });
}

export function applyRecoveryEventToStore(
  store: SessionStoreApi,
  event: RecoveryEvent,
  emitLog?: EmitLogFn,
): void {
  const state = store.getState();
  const isCurrentSession = event.originalSessionId === state.currentSessionId;

  if (!isCurrentSession && event.type !== 'recovery:succeeded') {
    emitLog?.({
      level: 'debug',
      message: 'Recovery event routed away from foreground overlay',
      turnId: event.turnId,
      sessionId: event.originalSessionId,
      context: { eventType: event.type },
      timestamp: Date.now(),
    });
    return;
  }

  switch (event.type) {
    case 'recovery:started':
      store.getState().startCompaction(event.depth, event.originalSessionId, event.turnId);
      break;
    case 'recovery:fallback_attempting':
      store.getState().setCompactionFallbackTarget(targetLabel(event.target), event.turnId, event.originalSessionId);
      break;
    case 'recovery:fallback_succeeded':
    case 'recovery:compacting':
      break;
    case 'recovery:skeleton_attempting':
      store.getState().setCompactionSkeleton(event.turnId, event.originalSessionId);
      break;
    case 'recovery:summary_ready':
      store.getState().setCompactionSummary(
        event.summary || 'Conversation context preserved',
        event.turnId,
        event.originalSessionId,
        event.revealDurationMs,
      );
      break;
    case 'recovery:retrying':
      store.getState().markCompactionRetrying(event.turnId, event.originalSessionId);
      break;
    case 'recovery:depth4_attempting':
      store.getState().setCompactionDepth4Attempt(event.modelName, event.turnId, event.originalSessionId);
      break;
    case 'recovery:succeeded':
      if (isCurrentSession) {
        store.getState().completeCompaction(event.turnId, event.originalSessionId);
        void reloadCanonicalSession(store, event.originalSessionId).finally(() => {
          setTimeout(() => {
            store.getState().resetCompaction();
            toastNotifications.notifyContextCompacted();
          }, 300);
        });
      } else {
        evictLoadedSession(store, event.originalSessionId);
      }
      break;
    case 'recovery:failed':
      {
        const compaction = store.getState().compaction;
        if (
          compaction.turnId === event.turnId &&
          compaction.phase !== 'idle' &&
          compaction.phase !== 'continuing' &&
          compaction.phase !== 'error'
        ) {
          store.getState().setCompactionError(event.error, event.turnId, event.originalSessionId, event.exhaustedReason);
        } else {
          emitLog?.({
            level: 'warn',
            message: 'Ignored recovery:failed event because compaction was not active for this turn',
            turnId: event.turnId,
            sessionId: event.originalSessionId,
            context: {
              eventType: event.type,
              exhaustedReason: event.exhaustedReason,
              compactionPhase: compaction.phase,
              compactionTurnId: compaction.turnId,
            },
            timestamp: Date.now(),
          });
        }
      }
      break;
    case 'recovery:last_resort_skipped':
      store.getState().setCompactionUnavailable(event.userFacingMessage, event.turnId, event.originalSessionId);
      break;
  }
}

export function useRecoveryAdapter(params: {
  store: SessionStoreApi;
  emitLog?: EmitLogFn;
}): (event: RecoveryEvent) => void {
  const { store, emitLog } = params;
  return useCallback((event: RecoveryEvent) => {
    applyRecoveryEventToStore(store, event, emitLog);
  }, [emitLog, store]);
}
