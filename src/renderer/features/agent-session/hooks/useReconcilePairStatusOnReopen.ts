import { useEffect } from 'react';
import type { EmitLogFn, ShowToastFn } from '@renderer/contexts';
import { getSessionStoreState, useSessionStore } from '../store';
import {
  materializeConnectorStatusForActiveSession,
  type RetryConfigureWithRebelFn,
} from './connectorStatusEffects';

interface AppBridgeApiLike {
  checkPairStatus: (request: { pairSessionId: string }) => Promise<{
    paired: Array<{ appId: string; clientId: string }>;
    pairSessionExpired?: boolean;
    pairSessionNotFound?: boolean;
  }>;
}

const getAppBridgeApi = (): AppBridgeApiLike | null => {
  const w = window as Window & { appBridgeApi?: AppBridgeApiLike };
  return w.appBridgeApi ?? null;
};

const serializeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
};

export function useReconcilePairStatusOnReopen(options: {
  retryConfigureWithRebel: RetryConfigureWithRebelFn;
  showToast: ShowToastFn;
  emitLog: EmitLogFn;
}): void {
  const { retryConfigureWithRebel, showToast, emitLog } = options;
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSessionSetupContext = useSessionStore((state) => state.currentSessionSetupContext);
  const pairSessionId =
    currentSessionSetupContext?.kind === 'bundled-app-bridge'
      ? currentSessionSetupContext.pairSessionId
      : undefined;
  const pendingAnnouncement =
    currentSessionSetupContext?.kind === 'bundled-app-bridge'
      ? currentSessionSetupContext.pendingAnnouncement
      : undefined;

  useEffect(() => {
    if (
      currentSessionSetupContext?.kind !== 'bundled-app-bridge' ||
      !pairSessionId
    ) {
      return;
    }

    if (pendingAnnouncement) {
      materializeConnectorStatusForActiveSession({
        status: pendingAnnouncement.status,
        pairSessionId,
        emittedAt: pendingAnnouncement.emittedAt,
        showToast,
        emitLog,
        retryConfigureWithRebel,
      });
      return;
    }

    const api = getAppBridgeApi();
    if (!api) {
      emitLog({
        level: 'info',
        message: 'Pair-status reconciliation unavailable on this surface',
        context: { pairSessionId, sessionId: currentSessionId },
        timestamp: Date.now(),
      });
      return;
    }

    let cancelled = false;

    void api
      .checkPairStatus({ pairSessionId })
      .then((result) => {
        if (cancelled) {
          return;
        }

        if (result.paired.length > 0) {
          materializeConnectorStatusForActiveSession({
            status: 'connected',
            pairSessionId,
            emittedAt: Date.now(),
            showToast,
            emitLog,
            retryConfigureWithRebel,
          });
          return;
        }

        if (result.pairSessionExpired || result.pairSessionNotFound) {
          getSessionStoreState().setSetupContext(null);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        emitLog({
          level: 'warn',
          message: 'Failed to reconcile pair status on session reopen',
          context: {
            pairSessionId,
            sessionId: currentSessionId,
            error: serializeError(error),
          },
          timestamp: Date.now(),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    currentSessionId,
    currentSessionSetupContext?.kind,
    emitLog,
    pairSessionId,
    pendingAnnouncement,
    pendingAnnouncement?.emittedAt,
    pendingAnnouncement?.status,
    retryConfigureWithRebel,
    showToast,
  ]);
}
