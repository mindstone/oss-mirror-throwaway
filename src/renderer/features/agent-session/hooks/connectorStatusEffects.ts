import type { ConnectorStatusChangedPayload } from '@shared/ipc/channels/appBridge';
import type { EmitLogFn, ShowToastFn } from '@renderer/contexts';
import { TURN_ID_FALLBACK } from '@renderer/constants';
import { getSessionStoreState, selectVisibleMessages } from '../store';
import { getCurrentSessionEvents, getCurrentSessionEventsForTurn } from '../store/sessionStore';
import { extractPairSessionIdFromToolDetail } from './toolDetailParsing';

export type ConnectorStatus = ConnectorStatusChangedPayload['status'];
export type RetryConfigureWithRebelFn = () => Promise<void>;

const CONNECTED_MESSAGE =
  'Rebel Browser is connected. You can now ask me to summarise a page, fill a form, extract details, or compare tabs.';
const EXPIRED_MESSAGE = 'Install window closed. Run the Rebel Browser install again.';
const CANCELLED_MESSAGE = 'Install cancelled.';

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

const isCompletedTurn = (turnId: string): boolean => {
  const events = getCurrentSessionEventsForTurn(turnId);
  return events.some((event) => event.type === 'result' || event.type === 'error');
};

const turnStartedInstall = (turnId: string, pairSessionId: string): boolean => {
  const events = getCurrentSessionEventsForTurn(turnId);
  return events.some(
    (event) =>
      event.type === 'tool' &&
      event.stage === 'end' &&
      (event.toolName === 'rebel_bridge_prepare_install' ||
        event.toolName === 'rebel_bridge_extract_extension' ||
        event.toolName === 'rebel_bridge_start_pairing') &&
      extractPairSessionIdFromToolDetail(event.detail) === pairSessionId,
  );
};

function resolveAnnouncementTurnId(pairSessionId: string): string | null {
  const state = getSessionStoreState();
  const visibleMessages = selectVisibleMessages(state.messages);
  const seenTurnIds = new Set<string>();

  for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
    const turnId = visibleMessages[index]?.turnId;
    if (!turnId || turnId === TURN_ID_FALLBACK || seenTurnIds.has(turnId)) {
      continue;
    }
    seenTurnIds.add(turnId);
    if (isCompletedTurn(turnId) && turnStartedInstall(turnId, pairSessionId)) {
      return turnId;
    }
  }

  for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
    const turnId = visibleMessages[index]?.turnId;
    if (turnId && turnId !== TURN_ID_FALLBACK) {
      return turnId;
    }
  }

  const eventTurnIds = Object.keys(getCurrentSessionEvents()).filter(
    (turnId) => turnId !== TURN_ID_FALLBACK,
  );
  return eventTurnIds.length > 0 ? eventTurnIds[eventTurnIds.length - 1] ?? null : null;
}

const getStatusMessage = (status: ConnectorStatus): string | null => {
  switch (status) {
    case 'connected':
      return CONNECTED_MESSAGE;
    case 'expired':
      return EXPIRED_MESSAGE;
    case 'cancelled':
      return CANCELLED_MESSAGE;
    default:
      return null;
  }
};

export function materializeConnectorStatusForActiveSession(options: {
  status: ConnectorStatus;
  pairSessionId: string;
  emittedAt: number;
  showToast: ShowToastFn;
  emitLog: EmitLogFn;
  retryConfigureWithRebel: RetryConfigureWithRebelFn;
}): void {
  const {
    status,
    pairSessionId,
    emittedAt,
    showToast,
    emitLog,
    retryConfigureWithRebel,
  } = options;
  const timestamp = Date.now();
  const message = getStatusMessage(status);

  if (!message) {
    emitLog({
      level: 'warn',
      message: 'Received unsupported connector status',
      context: { status, pairSessionId, emittedAt },
      timestamp,
    });
    return;
  }

  const store = getSessionStoreState();
  const targetTurnId = resolveAnnouncementTurnId(pairSessionId);
  const isTerminal = status === 'expired' || status === 'cancelled';

  // Plan invariant (F9): clear setupContext on ALL terminal verbs, even if
  // we couldn't resolve a target turn for the inline status event. Otherwise
  // a stale pairSessionId survives on the owning session and a retry finds
  // the wrong state. See planning doc §"Synthesis of Plan Critique" #9 and
  // §Failure Mode Matrix.
  if (targetTurnId) {
    store.processEvent(targetTurnId, {
      type: 'status',
      message,
      timestamp,
    });
  } else {
    emitLog({
      level: 'warn',
      message: 'Unable to resolve connector-status target turn; skipping inline announcement',
      context: { status, pairSessionId, emittedAt },
      timestamp,
    });
  }

  if (isTerminal) {
    showToast({
      title: status === 'expired' ? 'Install window closed' : 'Install cancelled',
      description:
        status === 'expired'
          ? 'That install window expired. Want to try again?'
          : 'Want to try again?',
      action: {
        label: 'Try again',
        onClick: () => {
          void retryConfigureWithRebel().catch((error) => {
            emitLog({
              level: 'error',
              message: 'Failed to retry Rebel Browser setup',
              context: {
                status,
                pairSessionId,
                emittedAt,
                error: serializeError(error),
              },
              timestamp: Date.now(),
            });
          });
        },
      },
    });
  }

  // Clear setupContext on all verbs — the 'connected' case is also terminal
  // from the install's perspective; dropping it is safe because reconcile
  // re-runs if we missed something. For 'expired'/'cancelled', clearing is
  // mandatory (plan F9) so the retry toast's Try-again opens a fresh flow.
  store.setSetupContext(null);
}
