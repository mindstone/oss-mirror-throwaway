import { useEffect, useRef } from 'react';
import type { ConnectorStatusChangedPayload } from '@shared/ipc/channels/appBridge';
import type { EmitLogFn, ShowToastFn } from '@renderer/contexts';
import { getSessionStoreState } from '../store';
import { materializeConnectorStatusForActiveSession, type RetryConfigureWithRebelFn } from './connectorStatusEffects';

interface AppBridgeSubscriptionsLike {
  onConnectorStatusChanged: (
    callback: (payload: ConnectorStatusChangedPayload) => void,
  ) => () => void;
}

const getAppBridgeSubscriptions = (): AppBridgeSubscriptionsLike | null => {
  const w = window as Window & {
    appBridgeSubscriptions?: AppBridgeSubscriptionsLike;
  };
  return w.appBridgeSubscriptions ?? null;
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

export function useConnectorStatusWatcher(options: {
  retryConfigureWithRebel: RetryConfigureWithRebelFn;
  showToast: ShowToastFn;
  emitLog: EmitLogFn;
}): void {
  const { retryConfigureWithRebel, showToast, emitLog } = options;
  const processedEventIdsRef = useRef(new Set<string>());
  const retryConfigureWithRebelRef = useRef(retryConfigureWithRebel);
  const showToastRef = useRef(showToast);
  const emitLogRef = useRef(emitLog);

  useEffect(() => {
    retryConfigureWithRebelRef.current = retryConfigureWithRebel;
    showToastRef.current = showToast;
    emitLogRef.current = emitLog;
  }, [retryConfigureWithRebel, showToast, emitLog]);

  useEffect(() => {
    const subscriptions = getAppBridgeSubscriptions();
    if (!subscriptions) {
      // Cross-surface graceful no-op: preload not present on cloud/mobile.
      // useEffect with [] deps guarantees this fires at most once per mount.
      emitLogRef.current({
        level: 'info',
        message: 'Connector status watcher unavailable on this surface',
        timestamp: Date.now(),
      });
      return;
    }

    const unsubscribe = subscriptions.onConnectorStatusChanged((event) => {
      try {
        if (processedEventIdsRef.current.has(event.eventId)) {
          return;
        }
        processedEventIdsRef.current.add(event.eventId);

        const state = getSessionStoreState();
        let ownerSessionId: string | null = null;
        let ownerSetupContext = null as
          | {
              kind: 'bundled-app-bridge';
              pairSessionId?: string;
              pendingAnnouncement?: {
                status: 'connected' | 'expired' | 'cancelled';
                emittedAt: number;
              };
            }
          | null;

        if (
          state.currentSessionSetupContext?.kind === 'bundled-app-bridge' &&
          state.currentSessionSetupContext.pairSessionId === event.pairSessionId
        ) {
          ownerSessionId = state.currentSessionId;
          ownerSetupContext = state.currentSessionSetupContext;
        }

        for (const summary of state.sessionSummaries) {
          if (ownerSessionId) {
            break;
          }
          const setupContext =
            state.loadedSessions.get(summary.id)?.setupContext ?? null;

          if (
            setupContext?.kind === 'bundled-app-bridge' &&
            setupContext.pairSessionId === event.pairSessionId
          ) {
            ownerSessionId = summary.id;
            ownerSetupContext = setupContext;
            break;
          }
        }

        if (!ownerSessionId || !ownerSetupContext) {
          emitLogRef.current({
            level: 'debug',
            message: 'Unmatched connector status event',
            context: {
              pairSessionId: event.pairSessionId,
              status: event.status,
              eventId: event.eventId,
            },
            timestamp: Date.now(),
          });
          return;
        }

        if (ownerSessionId === state.currentSessionId) {
          materializeConnectorStatusForActiveSession({
            status: event.status,
            pairSessionId: event.pairSessionId,
            emittedAt: event.emittedAt,
            showToast: showToastRef.current,
            emitLog: emitLogRef.current,
            retryConfigureWithRebel: retryConfigureWithRebelRef.current,
          });
          return;
        }

        getSessionStoreState().setSetupContextForSession(ownerSessionId, {
          ...ownerSetupContext,
          pendingAnnouncement: {
            status: event.status,
            emittedAt: event.emittedAt,
          },
        });
      } catch (error) {
        emitLogRef.current({
          level: 'error',
          message: 'Failed to process connector status event',
          context: {
            pairSessionId: event.pairSessionId,
            status: event.status,
            eventId: event.eventId,
            error: serializeError(error),
          },
          timestamp: Date.now(),
        });
      }
    });

    return unsubscribe;
  }, []);
}
