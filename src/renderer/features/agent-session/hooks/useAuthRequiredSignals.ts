import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import {
  buildAuthRequiredKey,
  extractLatestAuthRequiredByPackage,
  type AuthRequiredSignal,
} from '@shared/utils/authRequiredSignal';
import { generateWorkspaceInstanceId } from '@shared/utils/mcpInstanceUtils';
import { isOAuthSetupGuidance } from '@renderer/features/settings/hooks/useConnectorSetupGuidance';
type SlackWorkspaceStatus =
  | 'connected'
  | 'needs_reconnect'
  | 'disconnecting'
  | 'disconnected';

interface SlackWorkspaceChangedPayload {
  teamId: string;
  teamName: string;
  status: SlackWorkspaceStatus;
  occurredAt: number;
}

interface SlackWorkspaceSubscriptionsLike {
  onSlackWorkspaceChanged?: (
    callback: (payload: SlackWorkspaceChangedPayload) => void,
  ) => () => void;
}

type AuthRequiredCardState = 'idle' | 'reconnecting' | 'success' | 'error';

interface ReconnectState {
  status: AuthRequiredCardState;
  errorMessage?: string;
}

export interface AuthRequiredCardInfo {
  signal: AuthRequiredSignal;
  state: AuthRequiredCardState;
  errorMessage?: string;
}

const SUCCESS_STATE_VISIBLE_MS = 1500;

const getSlackWorkspaceSubscriptions = (): SlackWorkspaceSubscriptionsLike | null => {
  const w = window as Window & { appBridgeSubscriptions?: SlackWorkspaceSubscriptionsLike };
  return w.appBridgeSubscriptions ?? null;
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Reconnect failed';

export function useAuthRequiredSignals(
  eventsByTurn: Record<string, AgentEvent[]>,
  visibleMessages: AgentTurnMessage[],
  resolveTurnIdForMessage: (message: AgentTurnMessage) => string | null,
): {
  cardByMessageIndex: Map<number, AuthRequiredCardInfo[]>;
  pendingFooterCard: AuthRequiredCardInfo | null;
  startReconnect: (packageId: string) => Promise<void>;
  cancelReconnect: (packageId: string) => Promise<void>;
} {
  const [connectedPackages, setConnectedPackages] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [reconnectStateByPackage, setReconnectStateByPackage] = useState<
    Record<string, ReconnectState>
  >({});
  const successTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const attemptTokenRef = useRef<Map<string, number>>(new Map());

  const clearSuccessTimeout = useCallback((packageId: string) => {
    const timeout = successTimeoutsRef.current.get(packageId);
    if (!timeout) return;
    clearTimeout(timeout);
    successTimeoutsRef.current.delete(packageId);
  }, []);

  const setReconnectState = useCallback(
    (
      packageId: string,
      status: AuthRequiredCardState,
      errorMessage?: string,
    ) => {
      setReconnectStateByPackage((prev) => {
        const current = prev[packageId];
        if (current?.status === status && current?.errorMessage === errorMessage) {
          return prev;
        }
        return {
          ...prev,
          [packageId]: {
            status,
            ...(errorMessage ? { errorMessage } : {}),
          },
        };
      });
    },
    [],
  );

  const markConnected = useCallback((packageId: string, occurredAt: number) => {
    setConnectedPackages((prev) => {
      const existing = prev.get(packageId);
      if (existing !== undefined && existing >= occurredAt) return prev;
      const next = new Map(prev);
      next.set(packageId, occurredAt);
      return next;
    });
  }, []);

  const scheduleSuccessReset = useCallback(
    (packageId: string) => {
      clearSuccessTimeout(packageId);
      const timeout = setTimeout(() => {
        setReconnectStateByPackage((prev) => {
          const current = prev[packageId];
          if (!current || current.status !== 'success') return prev;
          return {
            ...prev,
            [packageId]: { status: 'idle' },
          };
        });
        successTimeoutsRef.current.delete(packageId);
      }, SUCCESS_STATE_VISIBLE_MS);
      successTimeoutsRef.current.set(packageId, timeout);
    },
    [clearSuccessTimeout],
  );

  useEffect(() => {
    const subscriptions = getSlackWorkspaceSubscriptions();
    const subscribe = subscriptions?.onSlackWorkspaceChanged;
    if (!subscribe) return;

    return subscribe((payload) => {
      if (payload.status !== 'connected') return;
      const packageId = generateWorkspaceInstanceId('Slack', payload.teamName);
      markConnected(packageId, payload.occurredAt);
      setReconnectState(packageId, 'success');
      scheduleSuccessReset(packageId);
    });
  }, [markConnected, scheduleSuccessReset, setReconnectState]);

  useEffect(() => () => {
    for (const timeout of successTimeoutsRef.current.values()) {
      clearTimeout(timeout);
    }
    successTimeoutsRef.current.clear();
  }, []);

  const startReconnect = useCallback(
    (packageId: string): Promise<void> => {
      const myToken = (attemptTokenRef.current.get(packageId) ?? 0) + 1;
      attemptTokenRef.current.set(packageId, myToken);
      clearSuccessTimeout(packageId);
      setReconnectState(packageId, 'reconnecting');

      void window.slackApi
        .startAuth()
        .then((result) => {
          if (attemptTokenRef.current.get(packageId) !== myToken) {
            return;
          }

          if (!result.success) {
            // Broken-by-default (no OAuth client credentials): the structured guidance message is
            // more actionable than the raw error string. Surface it on the reconnect card. (This
            // in-conversation card has no modal host; the full ConnectorSetupDialog is reachable
            // from the Settings connect surfaces.)
            const guidanceMessage = isOAuthSetupGuidance(result.setupGuidance)
              ? result.setupGuidance.message
              : undefined;
            setReconnectState(
              packageId,
              'error',
              guidanceMessage ?? result.error ?? 'Reconnect failed',
            );
            return;
          }

          const resolvedTeamName =
            typeof result.teamName === 'string' ? result.teamName.trim() : '';
          const resolvedId = resolvedTeamName
            ? generateWorkspaceInstanceId('Slack', resolvedTeamName)
            : packageId;
          const occurredAt = Date.now();

          if (attemptTokenRef.current.get(packageId) !== myToken) {
            return;
          }

          markConnected(resolvedId, occurredAt);
          if (attemptTokenRef.current.get(packageId) !== myToken) {
            return;
          }
          setReconnectState(resolvedId, 'success');
          if (attemptTokenRef.current.get(packageId) !== myToken) {
            return;
          }
          scheduleSuccessReset(resolvedId);
          if (resolvedId !== packageId) {
            if (attemptTokenRef.current.get(packageId) !== myToken) {
              return;
            }
            setReconnectState(packageId, 'idle');
          }
        })
        .catch((error) => {
          if (attemptTokenRef.current.get(packageId) !== myToken) {
            return;
          }
          setReconnectState(packageId, 'error', toErrorMessage(error));
        });

      return Promise.resolve();
    },
    [
      clearSuccessTimeout,
      markConnected,
      scheduleSuccessReset,
      setReconnectState,
    ],
  );

  const cancelReconnect = useCallback(
    async (packageId: string): Promise<void> => {
      const nextToken = (attemptTokenRef.current.get(packageId) ?? 0) + 1;
      attemptTokenRef.current.set(packageId, nextToken);
      clearSuccessTimeout(packageId);
      try {
        await window.slackApi.cancelAuth();
        if (attemptTokenRef.current.get(packageId) !== nextToken) {
          return;
        }
        setReconnectState(packageId, 'idle');
      } catch (error) {
        if (attemptTokenRef.current.get(packageId) !== nextToken) {
          return;
        }
        setReconnectState(packageId, 'error', toErrorMessage(error));
      }
    },
    [clearSuccessTimeout, setReconnectState],
  );

  const cardByMessageIndex = useMemo(() => {
    const cards = new Map<number, AuthRequiredCardInfo[]>();
    const latestByPackage = extractLatestAuthRequiredByPackage(eventsByTurn);
    if (latestByPackage.size === 0) return cards;

    for (const signal of latestByPackage.values()) {
      const reconnectState = reconnectStateByPackage[signal.packageId];
      const connectedAt = connectedPackages.get(signal.packageId);
      const shouldSuppress =
        connectedAt !== undefined
        && connectedAt >= signal.timestamp
        && reconnectState?.status !== 'success';
      if (shouldSuppress) {
        continue;
      }

      let anchorIndex = -1;
      for (let i = visibleMessages.length - 1; i >= 0; i -= 1) {
        const message = visibleMessages[i];
        if (message.role !== 'assistant' && message.role !== 'result') continue;
        const turnId = resolveTurnIdForMessage(message);
        if (turnId !== signal.turnId) continue;
        anchorIndex = i;
        break;
      }
      if (anchorIndex < 0) continue;

      const cardInfo: AuthRequiredCardInfo = {
        signal,
        state: reconnectState?.status ?? 'idle',
        ...(reconnectState?.errorMessage
          ? { errorMessage: reconnectState.errorMessage }
          : {}),
      };

      const existing = cards.get(anchorIndex);
      if (!existing) {
        cards.set(anchorIndex, [cardInfo]);
      } else {
        existing.push(cardInfo);
      }
    }

    for (const cardsAtIndex of cards.values()) {
      cardsAtIndex.sort((a, b) => {
        if (a.signal.timestamp !== b.signal.timestamp) {
          return a.signal.timestamp - b.signal.timestamp;
        }
        const aKey = buildAuthRequiredKey(a.signal.packageId, a.signal.reason);
        const bKey = buildAuthRequiredKey(b.signal.packageId, b.signal.reason);
        return aKey.localeCompare(bKey);
      });
    }

    return cards;
  }, [
    connectedPackages,
    eventsByTurn,
    reconnectStateByPackage,
    resolveTurnIdForMessage,
    visibleMessages,
  ]);

  const pendingFooterCard = useMemo(() => {
    let latestCard: AuthRequiredCardInfo | null = null;
    for (const cards of cardByMessageIndex.values()) {
      for (const card of cards) {
        if (!latestCard) {
          latestCard = card;
          continue;
        }
        if (card.signal.timestamp > latestCard.signal.timestamp) {
          latestCard = card;
          continue;
        }
        if (card.signal.timestamp < latestCard.signal.timestamp) {
          continue;
        }
        const cardKey = buildAuthRequiredKey(card.signal.packageId, card.signal.reason);
        const latestKey = buildAuthRequiredKey(
          latestCard.signal.packageId,
          latestCard.signal.reason,
        );
        if (cardKey > latestKey) {
          latestCard = card;
        }
      }
    }
    return latestCard;
  }, [cardByMessageIndex]);

  return {
    cardByMessageIndex,
    pendingFooterCard,
    startReconnect,
    cancelReconnect,
  };
}
