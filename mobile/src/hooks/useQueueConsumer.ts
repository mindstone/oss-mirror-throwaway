import {
  useAuthStore,
  useSessionStore,
  createLogger,
  hashForBreadcrumb,
} from '@rebel/cloud-client';
import type {
  QueueItem,
  QueueConsumerResult,
  WebFileAttachment,
  CloudMeetingSessionId,
} from '@rebel/cloud-client';
import type { MeetingCompanionTriggerMeta } from '@shared/types';
import { generateMobileSessionId } from '../utils/sessionId';
import { recordContinuityBreadcrumb } from '../utils/continuityBreadcrumbs';
import {
  submitTurnViaSocket,
  PersistedAckMissingError,
  TurnInFlightError,
  SessionTombstonedError,
  TurnFailedError,
} from '../utils/submitTurnViaSocket';

export interface QueueConsumerMetadataBase {
  sessionId: string | null;
  clientTurnId?: string;
  /** Cloud meeting session id (branded — a local recording id cannot be passed). */
  meetingSessionId?: CloudMeetingSessionId;
  recordingActive?: boolean;
  triggerMeta?: MeetingCompanionTriggerMeta;
}

export interface QueueCompletionEvent {
  itemId: string;
  sessionId: string;
  originalSessionId: string | null;
  recreatedSession: boolean;
}

export interface QueueTurnInput {
  prompt: string;
  attachments?: WebFileAttachment[];
}

interface QueueConsumerProcessContext<
  TMetadata extends QueueConsumerMetadataBase,
  TPrepared,
> {
  item: QueueItem;
  metadata: TMetadata;
  payloadUri: string | null;
  signal?: AbortSignal;
  prepared: TPrepared;
  sessionId: string;
  cloudUrl: string;
  token: string;
}

interface QueueConsumerPrepareContext<TMetadata extends QueueConsumerMetadataBase> {
  item: QueueItem;
  metadata: TMetadata;
  payloadUri: string | null;
  signal?: AbortSignal;
}

interface CreateQueueConsumerOptions<
  TMetadata extends QueueConsumerMetadataBase,
  TPrepared,
> {
  loggerName: string;
  sourceLabel: string;
  sourcePresentParticiple?: string;
  prepare?: (
    context: QueueConsumerPrepareContext<TMetadata>,
  ) => TPrepared | QueueConsumerResult | Promise<TPrepared | QueueConsumerResult>;
  buildTurnInput: (
    context: QueueConsumerProcessContext<TMetadata, TPrepared>,
  ) => QueueTurnInput | QueueConsumerResult | Promise<QueueTurnInput | QueueConsumerResult>;
  getAttemptLogData?: (
    context: QueueConsumerPrepareContext<TMetadata>,
  ) => Record<string, unknown> | undefined;
  getSuccessLogData?: (
    context: QueueConsumerProcessContext<TMetadata, TPrepared> & {
      turnInput: QueueTurnInput;
    },
  ) => Record<string, unknown> | undefined;
  onCompletion?: (event: QueueCompletionEvent) => void;
}

function isQueueConsumerResult(value: unknown): value is QueueConsumerResult {
  return (
    typeof value === 'object'
    && value !== null
    && 'success' in value
    && typeof (value as { success?: unknown }).success === 'boolean'
  );
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return (
    typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function'
  );
}

function resolveTargetSessionId(
  itemId: string,
  sourceLabel: string,
  requestedSessionId: string | null,
  log: ReturnType<typeof createLogger>,
): {
  sessionId: string;
  originalSessionId: string | null;
  recreatedSession: boolean;
} {
  const sessionStore = useSessionStore.getState();

  let sessionId = requestedSessionId;
  const originalSessionId = sessionId;
  let recreatedSession = false;

  if (sessionId) {
    // Only recreate on a *positive* deletion signal (a tombstone). A requested
    // id that is merely absent from the local store is the normal new-conversation
    // case: brand-new mobile conversations are mint-and-navigate, so the id isn't
    // in `sessions[]`/`currentSession` until the cloud persists a turn and a
    // `fetchSessions` round-trip returns it. The server creates the session on the
    // first turn for any client-minted id, so we submit to the requested id unchanged.
    // Inferring "deleted" from absence false-recreated the first send of every new
    // conversation. See docs/plans/260622_mobile-record-recreated-session/PLAN.md (Thread B).
    if (sessionStore.isSessionTombstoned(sessionId)) {
      sessionId = generateMobileSessionId();
      recreatedSession = true;
      log.info(`Original session was tombstoned (deleted); routing queued ${sourceLabel} to a new session`, {
        id: itemId,
        originalSessionId,
        sessionId,
        reason: 'session-tombstoned',
      });
    }
  }

  if (!sessionId) {
    sessionId = generateMobileSessionId();
    log.info(`Generated new session ID for queued ${sourceLabel}`, {
      id: itemId,
      sessionId,
    });
  }

  return { sessionId, originalSessionId, recreatedSession };
}

function isTargetSessionBusy(sessionId: string): boolean {
  const sessionStore = useSessionStore.getState();
  if (sessionStore.currentSession?.id === sessionId && sessionStore.currentSession.isBusy) {
    return true;
  }

  const targetSession = sessionStore.sessions.find((session) => session.id === sessionId);
  return Boolean(targetSession && 'isBusy' in targetSession && targetSession.isBusy);
}

export function createQueueConsumer<
  TMetadata extends QueueConsumerMetadataBase,
  TPrepared = void,
>(
  options: CreateQueueConsumerOptions<TMetadata, TPrepared>,
): (
  item: QueueItem,
  payloadUri: string | null,
  signal?: AbortSignal,
) => Promise<QueueConsumerResult> {
  const log = createLogger(options.loggerName);
  const sourceLabel = options.sourceLabel;
  const sourcePresentParticiple = options.sourcePresentParticiple
    ?? `${sourceLabel} processing`;

  return async (
    item: QueueItem,
    payloadUri: string | null,
    signal?: AbortSignal,
  ): Promise<QueueConsumerResult> => {
    const metadata = item.metadata as unknown as TMetadata;
    const itemId = item.id;
    const clientTurnId = metadata.clientTurnId ?? `turn-${itemId}`;
    metadata.clientTurnId = clientTurnId;

    log.info(`Processing ${sourceLabel} queue item`, {
      id: itemId,
      sessionId: metadata.sessionId,
      attempt: item.attempts + 1,
      ...(options.getAttemptLogData?.({ item, metadata, payloadUri, signal }) ?? {}),
    });

    const preparedCandidate = options.prepare
      ? options.prepare({ item, metadata, payloadUri, signal })
      : (undefined as TPrepared);
    const preparedResult = isPromiseLike<TPrepared | QueueConsumerResult>(preparedCandidate)
      ? await preparedCandidate
      : preparedCandidate;
    if (isQueueConsumerResult(preparedResult)) {
      return preparedResult;
    }
    const prepared = preparedResult as TPrepared;

    const { cloudUrl, token } = useAuthStore.getState();
    if (!cloudUrl || !token) {
      log.warn(`Not authenticated, deferring ${sourceLabel} queue item`, { id: itemId });
      return {
        success: false,
        error: 'Not connected to cloud',
        errorCategory: 'auth',
      };
    }

    const resolved = resolveTargetSessionId(itemId, sourceLabel, metadata.sessionId, log);
    let sessionId = resolved.sessionId;
    const originalSessionId = resolved.originalSessionId;
    let recreatedSession = resolved.recreatedSession;

    if (isTargetSessionBusy(sessionId)) {
      log.info(`Target session is busy, deferring ${sourceLabel} queue item`, {
        id: itemId,
        sessionId,
      });
      return {
        success: false,
        error: 'Session is busy',
        errorCategory: 'session-state',
      };
    }

    const turnInputCandidate = options.buildTurnInput({
      item,
      metadata,
      payloadUri,
      signal,
      prepared,
      sessionId,
      cloudUrl,
      token,
    });
    const turnInputResult = isPromiseLike<QueueTurnInput | QueueConsumerResult>(turnInputCandidate)
      ? await turnInputCandidate
      : turnInputCandidate;

    if (isQueueConsumerResult(turnInputResult)) {
      return turnInputResult;
    }

    const turnInput = turnInputResult;

    try {
      let submitResult;
      try {
        submitResult = await submitTurnViaSocket(sessionId, turnInput.prompt, {
          clientTurnId,
          meetingSessionId: metadata.meetingSessionId,
          recordingActive: metadata.recordingActive,
          triggerMeta: metadata.triggerMeta,
          attachments: turnInput.attachments,
        });
      } catch (submitErr) {
        if (submitErr instanceof SessionTombstonedError) {
          // The server confirmed the target session was deleted, so the turn
          // never ran. Recreate the conversation under a fresh id and resubmit
          // once so the user's turn lands on a visible session (restores the
          // intended "started a new one" behaviour for genuinely-deleted
          // sessions, without the false-positive of inferring deletion from a
          // not-yet-synced id). A new clientTurnId avoids colliding with the
          // tombstoned-id idempotency entry on the server.
          const recreatedId = generateMobileSessionId();
          log.info(`Server reported target session deleted; recreating ${sourceLabel} under a new session`, {
            id: itemId,
            originalSessionId,
            tombstonedSessionId: sessionId,
            sessionId: recreatedId,
            reason: 'session-tombstoned-server',
          });
          sessionId = recreatedId;
          recreatedSession = true;
          submitResult = await submitTurnViaSocket(sessionId, turnInput.prompt, {
            clientTurnId: `${clientTurnId}-recreated`,
            meetingSessionId: metadata.meetingSessionId,
            recordingActive: metadata.recordingActive,
            triggerMeta: metadata.triggerMeta,
            attachments: turnInput.attachments,
          });
        } else {
          throw submitErr;
        }
      }
      if (submitResult.degraded) {
        log.warn(`${sourcePresentParticiple} completed without persistence ack (degraded compatibility path)`, {
          id: itemId,
          sessionId,
        });
      }

      try {
        options.onCompletion?.({
          itemId,
          sessionId,
          originalSessionId,
          recreatedSession,
        });
      } catch {
        // Non-critical: never fail queue completion due to listener errors.
      }

      log.info(`${sourcePresentParticiple} processed successfully`, {
        id: itemId,
        sessionId,
        ...(options.getSuccessLogData?.({
          item,
          metadata,
          payloadUri,
          signal,
          prepared,
          sessionId,
          cloudUrl,
          token,
          turnInput,
        }) ?? {}),
      });
      return { success: true };
    } catch (err) {
      if (err instanceof TurnInFlightError) {
        log.info(`${sourcePresentParticiple} still in flight on server; deferring retry`, {
          id: itemId,
          sessionId,
        });
        return {
          success: false,
          error: 'Turn is already in flight on the server',
          errorCategory: 'defer',
        };
      }

      if (err instanceof PersistedAckMissingError) {
        recordContinuityBreadcrumb({
          family: 'outbox',
          message: 'failed',
          level: 'warning',
          data: {
            sessionIdHash: hashForBreadcrumb(sessionId),
            turnIdHash: hashForBreadcrumb(err.details.turnId ?? clientTurnId),
            clientTurnId,
            attempt: item.attempts + 1,
            errorCategory: 'timeout',
          },
        });
        log.warn(`${sourcePresentParticiple} missing persistence ack on ack-capable server; retrying`, {
          id: itemId,
          sessionId,
          clientTurnId,
        });
        return {
          success: false,
          error: 'Persistence acknowledgement missing',
          errorCategory: 'temporary',
        };
      }

      if (err instanceof TurnFailedError) {
        // The server persisted the turn as an error (a terminal provider-route
        // decision — e.g. the Mindstone managed subscription is unreachable from
        // cloud, or a provider needs reconnecting). No model ran, so retrying the
        // identical turn cannot help: classify it `permanent` so the queue stops
        // retrying and the conversation surfaces the failure honestly (the
        // `failed` chip shows `error`) instead of silently draining as success.
        // (The attributable `turn-persisted-error` breadcrumb is emitted at the
        // detection point in submitTurnViaSocket.)
        log.warn(`${sourcePresentParticiple} turn persisted as an error; surfacing recoverable failure`, {
          id: itemId,
          sessionId,
          clientTurnId,
          provider: err.details.provider,
          errorKind: err.details.errorKind,
        });
        return {
          success: false,
          error: err.details.userMessage,
          errorCategory: 'permanent',
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      log.error(`${sourcePresentParticiple} turn submission failed`, {
        id: itemId,
        sessionId,
        error: message,
      });
      return {
        success: false,
        error: `Turn submission failed: ${message}`,
        errorCategory: 'temporary',
      };
    }
  };
}
