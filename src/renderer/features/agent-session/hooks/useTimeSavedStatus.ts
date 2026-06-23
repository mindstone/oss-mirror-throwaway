import { useEffect, useCallback } from 'react';
import type { TimeSavedStatus } from '@shared/types';
import { analytics } from '@renderer/src/analytics';
import { recordRendererBreadcrumb } from '@renderer/src/sentry';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import { classifyTimeSavedStatusRoute } from '@renderer/utils/timeSavedStatusRouting';
import { useSessionStore } from '../store/sessionStore';

type Listener = () => void;

const realtimeListeners: Set<Listener> = new Set();
let ipcListenerInitialized = false;
const warnedKeys = new Set<string>();

type ApplyTimeSavedStatusToSession = (payload: {
  sessionId: string;
  turnId: string;
  status: TimeSavedStatus;
}) => Promise<{ ok: boolean; error?: string; context?: Record<string, unknown> }>;

export type TimeSavedStatusRoutingResult =
  | 'applied-active'
  | 'routed-cross-session'
  | 'dropped-legacy';

const notifyListeners = () => {
  realtimeListeners.forEach((listener) => listener());
};

function warnOnce(key: string, message: string, data: Record<string, unknown>): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message, data);
}

function emitCrossSessionRoutingRejectedTelemetry(params: {
  eventType: 'time-saved:status';
  activeSessionId: string;
  originalSessionId: string;
  turnId: string;
}): void {
  const activeSessionIdHash = hashSessionIdForBreadcrumb(params.activeSessionId);
  const originalSessionIdHash = hashSessionIdForBreadcrumb(params.originalSessionId);
  const turnIdHash = hashSessionIdForBreadcrumb(params.turnId);

  recordRendererBreadcrumb({
    category: 'cross-session-routing-rejected',
    level: 'warning',
    data: {
      eventType: params.eventType,
      activeSessionIdHash,
      originalSessionIdHash,
      turnIdHash,
    },
  });
  analytics.track('timeSaved.crossSessionRoutingRejected', {
    eventType: params.eventType,
    activeSessionIdHash,
    originalSessionIdHash,
    turnIdHash,
  });
}

function emitLegacyBroadcastDroppedTelemetry(params: {
  eventType: 'time-saved:status';
  activeSessionId: string;
  turnId: string;
}): void {
  const activeSessionIdHash = hashSessionIdForBreadcrumb(params.activeSessionId);
  const turnIdHash = hashSessionIdForBreadcrumb(params.turnId);

  recordRendererBreadcrumb({
    category: 'legacy-broadcast-without-originalSessionId',
    level: 'warning',
    data: {
      eventType: params.eventType,
      activeSessionIdHash,
      turnIdHash,
    },
  });
  analytics.track('timeSaved.legacyBroadcastWithoutOriginalSessionId', {
    eventType: params.eventType,
    activeSessionIdHash,
    turnIdHash,
  });
}

export function routeIncomingTimeSavedStatus(params: {
  status: TimeSavedStatus;
  activeSessionId: string;
  setTimeSavedStatus: (status: TimeSavedStatus) => void;
  setTimeSavedStatusForSession: (sessionId: string, status: TimeSavedStatus) => void;
  applyStatusToSession: ApplyTimeSavedStatusToSession;
}): TimeSavedStatusRoutingResult {
  const {
    status,
    activeSessionId,
    setTimeSavedStatus,
    setTimeSavedStatusForSession,
    applyStatusToSession,
  } = params;
  const safeActiveSessionId = activeSessionId || 'unknown-session';
  const routingDecision = classifyTimeSavedStatusRoute(status, safeActiveSessionId);
  if (routingDecision === 'drop') {
    emitLegacyBroadcastDroppedTelemetry({
      eventType: 'time-saved:status',
      activeSessionId: safeActiveSessionId,
      turnId: status.turnId,
    });
    warnOnce(
      `time-saved-legacy:${status.turnId}`,
      '[time-saved-status] Dropped legacy broadcast without originalSessionId',
      {
        turnIdHash: hashSessionIdForBreadcrumb(status.turnId),
        activeSessionIdHash: hashSessionIdForBreadcrumb(safeActiveSessionId),
      },
    );
    return 'dropped-legacy';
  }

  const originalSessionId = status.originalSessionId as string;
  if (routingDecision === 'route') {
    emitCrossSessionRoutingRejectedTelemetry({
      eventType: 'time-saved:status',
      activeSessionId: safeActiveSessionId,
      originalSessionId,
      turnId: status.turnId,
    });
    warnOnce(
      `time-saved-cross-session:${originalSessionId}:${safeActiveSessionId}:${status.turnId}`,
      '[time-saved-status] Routed cross-session status through main-process IPC',
      {
        originalSessionIdHash: hashSessionIdForBreadcrumb(originalSessionId),
        activeSessionIdHash: hashSessionIdForBreadcrumb(safeActiveSessionId),
        turnIdHash: hashSessionIdForBreadcrumb(status.turnId),
      },
    );
  }

  const isActiveSessionStatus = routingDecision === 'apply';
  if (isActiveSessionStatus) {
    setTimeSavedStatus(status);
  } else {
    setTimeSavedStatusForSession(originalSessionId, status);
  }

  void applyStatusToSession({
    sessionId: originalSessionId,
    turnId: status.turnId,
    status,
  }).then((result) => {
    if (!result.ok) {
      console.warn('[time-saved-status] Failed to persist status through IPC', {
        error: result.error,
        context: result.context,
        originalSessionIdHash: hashSessionIdForBreadcrumb(originalSessionId),
        turnIdHash: hashSessionIdForBreadcrumb(status.turnId),
      });
    }
  }).catch((error) => {
    console.warn('[time-saved-status] applyStatusToSession rejected', {
      error: error instanceof Error ? error.message : String(error),
      originalSessionIdHash: hashSessionIdForBreadcrumb(originalSessionId),
      turnIdHash: hashSessionIdForBreadcrumb(status.turnId),
    });
  });

  return isActiveSessionStatus ? 'applied-active' : 'routed-cross-session';
}

const initializeIpcListener = () => {
  if (ipcListenerInitialized) return;
  ipcListenerInitialized = true;

  window.api.onTimeSavedStatus((status) => {
    const state = useSessionStore.getState();
    const routed = routeIncomingTimeSavedStatus({
      status,
      activeSessionId: state.currentSessionId,
      setTimeSavedStatus: state.setTimeSavedStatus,
      setTimeSavedStatusForSession: state.setTimeSavedStatusForSession,
      applyStatusToSession: (payload) =>
        window.api.timeSaved?.applyStatusToSession(payload)
          ?? Promise.resolve({ ok: false, error: 'ipc-unavailable' }),
    });
    if (routed === 'applied-active') {
      notifyListeners();
    }
  });
};

export const useTimeSavedStatus = () => {
  const timeSavedStatusByTurn = useSessionStore((state) => state.timeSavedStatusByTurn);

  useEffect(() => {
    initializeIpcListener();
  }, []);

  const getStatusForTurn = useCallback(
    (turnId: string): TimeSavedStatus | undefined => {
      return timeSavedStatusByTurn[turnId];
    },
    [timeSavedStatusByTurn]
  );

  return { statusByTurn: timeSavedStatusByTurn, getStatusForTurn };
};
