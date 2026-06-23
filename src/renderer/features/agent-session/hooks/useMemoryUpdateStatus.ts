import { useEffect, useCallback } from 'react';
import type { MemoryUpdateStatus } from '@shared/types';
import { analytics } from '@renderer/src/analytics';
import { recordRendererBreadcrumb } from '@renderer/src/sentry';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import { useSessionStore } from '../store/sessionStore';

type Listener = () => void;

// Module-level for real-time updates (before they hit the store)
const realtimeListeners: Set<Listener> = new Set();
let ipcListenerInitialized = false;
const warnedKeys = new Set<string>();

export type MemoryUpdateStatusRoutingResult =
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
  eventType: 'memory:update-status';
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
  analytics.track('memoryUpdate.crossSessionRoutingRejected', {
    eventType: params.eventType,
    activeSessionIdHash,
    originalSessionIdHash,
    turnIdHash,
  });
}

function emitLegacyBroadcastDroppedTelemetry(params: {
  eventType: 'memory:update-status';
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
  analytics.track('memoryUpdate.legacyBroadcastWithoutOriginalSessionId', {
    eventType: params.eventType,
    activeSessionIdHash,
    turnIdHash,
  });
}

export function routeIncomingMemoryUpdateStatus(params: {
  status: MemoryUpdateStatus;
  activeSessionId: string;
  setMemoryUpdateStatus: (status: MemoryUpdateStatus) => void;
  setMemoryUpdateStatusForSession: (sessionId: string, status: MemoryUpdateStatus) => void;
}): MemoryUpdateStatusRoutingResult {
  const {
    status,
    activeSessionId,
    setMemoryUpdateStatus,
    setMemoryUpdateStatusForSession,
  } = params;
  const safeActiveSessionId = activeSessionId || 'unknown-session';
  const originalSessionId = status.originalSessionId;

  if (!originalSessionId) {
    emitLegacyBroadcastDroppedTelemetry({
      eventType: 'memory:update-status',
      activeSessionId: safeActiveSessionId,
      turnId: status.originalTurnId,
    });
    warnOnce(
      `memory-update-legacy:${status.originalTurnId}`,
      '[memory-update-status] Dropped legacy broadcast without originalSessionId',
      {
        turnIdHash: hashSessionIdForBreadcrumb(status.originalTurnId),
        activeSessionIdHash: hashSessionIdForBreadcrumb(safeActiveSessionId),
      },
    );
    return 'dropped-legacy';
  }

  if (originalSessionId !== safeActiveSessionId) {
    emitCrossSessionRoutingRejectedTelemetry({
      eventType: 'memory:update-status',
      activeSessionId: safeActiveSessionId,
      originalSessionId,
      turnId: status.originalTurnId,
    });
    warnOnce(
      `memory-update-cross-session:${originalSessionId}:${safeActiveSessionId}:${status.originalTurnId}`,
      '[memory-update-status] Received cross-session memory status (in-memory only; terminal state persisted by the executing surface in core)',
      {
        originalSessionIdHash: hashSessionIdForBreadcrumb(originalSessionId),
        activeSessionIdHash: hashSessionIdForBreadcrumb(safeActiveSessionId),
        turnIdHash: hashSessionIdForBreadcrumb(status.originalTurnId),
      },
    );
  }

  // Live UI only: update the in-memory store so the indicator reflects the
  // status immediately. Persistence is NO LONGER done here (260619): the
  // executing surface (desktop AND cloud) now persists the TERMINAL status in
  // core (memoryUpdateService.persistTerminalMemoryStatus), and the cross-surface
  // merge propagates it. This makes core the single writer of
  // memoryUpdateStatusByTurn (no dual read-modify-write with the renderer) and
  // fixes the cloud catch-up gap where a missed broadcast left no durable record.
  // `running` is transient and intentionally lives only in this in-memory store.
  const isActiveSessionStatus = originalSessionId === safeActiveSessionId;
  if (isActiveSessionStatus) {
    setMemoryUpdateStatus(status);
  } else {
    setMemoryUpdateStatusForSession(originalSessionId, status);
  }

  return isActiveSessionStatus ? 'applied-active' : 'routed-cross-session';
}

const initializeIpcListener = () => {
  if (ipcListenerInitialized) return;
  ipcListenerInitialized = true;

  window.api.onMemoryUpdateStatus((status) => {
    const state = useSessionStore.getState();
    const routed = routeIncomingMemoryUpdateStatus({
      status,
      activeSessionId: state.currentSessionId,
      setMemoryUpdateStatus: state.setMemoryUpdateStatus,
      setMemoryUpdateStatusForSession: state.setMemoryUpdateStatusForSession,
    });
    if (routed === 'applied-active') {
      notifyListeners();
    }
  });
};

export const useMemoryUpdateStatus = () => {
  const memoryUpdateStatusByTurn = useSessionStore((state) => state.memoryUpdateStatusByTurn);

  useEffect(() => {
    initializeIpcListener();
  }, []);

  const getStatusForTurn = useCallback(
    (turnId: string): MemoryUpdateStatus | undefined => {
      return memoryUpdateStatusByTurn[turnId];
    },
    [memoryUpdateStatusByTurn]
  );

  return { statusByTurn: memoryUpdateStatusByTurn, getStatusForTurn };
};
