import { createAgentTurnSocket, hashForBreadcrumb } from '@rebel/cloud-client';
import type { WebFileAttachment, CloudMeetingSessionId } from '@rebel/cloud-client';
import type { MeetingCompanionTriggerMeta } from '@shared/types';
import { recordContinuityBreadcrumb } from './continuityBreadcrumbs';
import { resolveTurnFailureUserMessage } from './turnFailureCopy';

// Re-exported so existing consumers (and tests) keep importing it from here.
export { resolveTurnFailureUserMessage };

const TURN_STARTED_TIMEOUT_MS = 30_000;
const TURN_PERSISTED_ACK_TIMEOUT_MS = 60_000;

type SocketEvent = {
  type?: string;
  turnId?: string;
  supportsPersistedAck?: boolean;
  /** Present on `turn_persisted`: distinguishes a real assistant reply from a persisted error turn. */
  outcome?: 'result' | 'error';
  /** Present on a streamed `error` event: the user-facing failure message. */
  error?: string;
  /** Present on a streamed `error` event: structural classification (e.g. 'connection-not-configured'). */
  errorKind?: string;
  /** Present on a streamed `error` event: provider name (e.g. 'Mindstone'). */
  provider?: string;
};

export interface SubmitTurnViaSocketOptions {
  clientTurnId?: string;
  /** Cloud meeting session id (branded — a local recording id cannot be passed). */
  meetingSessionId?: CloudMeetingSessionId;
  recordingActive?: boolean;
  triggerMeta?: MeetingCompanionTriggerMeta;
  attachments?: WebFileAttachment[];
  onTurnStarted?: (turnId: string | null) => void;
}

export interface SubmitTurnViaSocketResult {
  clientTurnId: string;
  turnId: string | null;
  degraded?: boolean;
  idempotentReplay?: boolean;
}

export class PersistedAckMissingError extends Error {
  readonly details: {
    clientTurnId: string;
    sessionId: string;
    turnId: string | null;
    elapsedMs: number;
  };

  constructor(details: {
    clientTurnId: string;
    sessionId: string;
    turnId: string | null;
    elapsedMs: number;
  }) {
    super('Expected turn_persisted acknowledgement was not received');
    this.name = 'PersistedAckMissingError';
    this.details = details;
  }
}

/**
 * Rejected when the server reports the target session has been deleted
 * (tombstoned) — the turn never ran. The queue consumer recreates the
 * conversation under a fresh id so the user's turn is not silently lost.
 */
export class SessionTombstonedError extends Error {
  readonly details: {
    clientTurnId: string;
    sessionId: string;
  };

  constructor(details: { clientTurnId: string; sessionId: string }) {
    super('Target session has been deleted');
    this.name = 'SessionTombstonedError';
    this.details = details;
  }
}

/**
 * Rejected when the server persisted the turn with `outcome: "error"` — a
 * terminal provider-route decision (e.g. the Mindstone managed subscription is
 * unreachable from cloud, or a provider needs reconnecting) ran no model, so
 * there is no assistant reply. Without this, the client resolved success on
 * `turn_persisted` and the user saw their message "sent" with no response and
 * no error (the error only surfaced later when the transcript synced to
 * desktop). The queue consumer surfaces `userMessage` as a recoverable failure.
 */
export class TurnFailedError extends Error {
  readonly details: {
    clientTurnId: string;
    sessionId: string;
    turnId: string | null;
    /** Provider-supplied error text, if the server streamed an `error` event. */
    providerMessage?: string;
    errorKind?: string;
    provider?: string;
    /** Plain-English, recoverable copy chosen for the mobile/cloud surface. */
    userMessage: string;
  };

  constructor(details: {
    clientTurnId: string;
    sessionId: string;
    turnId: string | null;
    providerMessage?: string;
    errorKind?: string;
    provider?: string;
    userMessage: string;
  }) {
    super(details.userMessage);
    this.name = 'TurnFailedError';
    this.details = details;
  }
}

export class TurnInFlightError extends Error {
  readonly details: {
    clientTurnId: string;
    sessionId: string;
    turnId: string | null;
  };

  constructor(details: {
    clientTurnId: string;
    sessionId: string;
    turnId: string | null;
  }) {
    super('Turn is already in flight on the server');
    this.name = 'TurnInFlightError';
    this.details = details;
  }
}

function generateClientTurnId(): string {
  const globalCrypto = typeof globalThis !== 'undefined'
    ? (globalThis as typeof globalThis & { crypto?: { randomUUID?: () => string } }).crypto
    : undefined;
  if (globalCrypto?.randomUUID) {
    return globalCrypto.randomUUID();
  }
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Submit an agent turn via WebSocket and resolve when server persistence is acknowledged.
 *
 * - Normal path: resolves on `turn_persisted`.
 * - In-flight conflict: rejects with `TurnInFlightError` on `turn_in_flight`.
 * - Older server fallback: if `turn_persisted` never arrives within 60s after
 *   `turn_started`, resolves with `{ degraded: true }` when
 *   `supportsPersistedAck` is absent/false.
 * - Ack-capable server failure: rejects with `PersistedAckMissingError` if
 *   `supportsPersistedAck === true` and the 60s ack timer elapses.
 */
export function submitTurnViaSocket(
  sessionId: string,
  prompt: string,
  options: SubmitTurnViaSocketOptions = {},
): Promise<SubmitTurnViaSocketResult> {
  const clientTurnId = options.clientTurnId ?? generateClientTurnId();

  return new Promise<SubmitTurnViaSocketResult>((resolve, reject) => {
    let settled = false;
    let sawTurnStarted = false;
    let turnId: string | null = null;
    let turnStartedAtMs: number | null = null;
    let supportsPersistedAck: boolean | null = null;
    // Capture a streamed `error` event so a subsequent persisted-error outcome
    // can surface the actual provider reason instead of a generic failure.
    let lastErrorEvent: { error?: string; errorKind?: string; provider?: string } | null = null;
    let turnStartedTimeout: ReturnType<typeof setTimeout> | null = null;
    let persistedAckTimeout: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (turnStartedTimeout) {
        clearTimeout(turnStartedTimeout);
        turnStartedTimeout = null;
      }
      if (persistedAckTimeout) {
        clearTimeout(persistedAckTimeout);
        persistedAckTimeout = null;
      }
    };

    const settleResolve = (result: SubmitTurnViaSocketResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      socket.close();
      resolve(result);
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      socket.close();
      reject(error);
    };

    const turnRequest: {
      sessionId: string;
      prompt: string;
      clientTurnId: string;
      meetingSessionId?: string;
      recordingActive?: boolean;
      triggerMeta?: MeetingCompanionTriggerMeta;
      attachments?: WebFileAttachment[];
    } = { sessionId, prompt, clientTurnId };
    if (options.meetingSessionId) {
      turnRequest.meetingSessionId = options.meetingSessionId;
    }
    if (typeof options.recordingActive === 'boolean') {
      turnRequest.recordingActive = options.recordingActive;
    }
    if (options.triggerMeta) {
      turnRequest.triggerMeta = options.triggerMeta;
    }
    if (Array.isArray(options.attachments) && options.attachments.length > 0) {
      turnRequest.attachments = options.attachments;
    }

    const socket = createAgentTurnSocket(
      turnRequest,
      (event: unknown) => {
        const ev = event as SocketEvent;
        if (!ev?.type) return;

        if (ev.type === 'error') {
          // Streamed terminal/error event from the executor. Record it; the
          // turn still persists with outcome:"error", and we reject on that
          // persisted ack so the queue surfaces a recoverable failure. (We do
          // not settle here — the connection stays open until persistence is
          // acknowledged, matching the happy path.)
          lastErrorEvent = {
            error: typeof ev.error === 'string' ? ev.error : undefined,
            errorKind: typeof ev.errorKind === 'string' ? ev.errorKind : undefined,
            provider: typeof ev.provider === 'string' ? ev.provider : undefined,
          };
          return;
        }

        if (ev.type === 'turn_started') {
          sawTurnStarted = true;
          if (typeof ev.turnId === 'string' && ev.turnId.length > 0) {
            turnId = ev.turnId;
          }
          supportsPersistedAck = ev.supportsPersistedAck === true ? true : false;
          turnStartedAtMs = Date.now();
          clearTimers();
          options.onTurnStarted?.(turnId);
          persistedAckTimeout = setTimeout(() => {
            const elapsedMs = turnStartedAtMs ? Date.now() - turnStartedAtMs : TURN_PERSISTED_ACK_TIMEOUT_MS;
            if (supportsPersistedAck) {
              recordContinuityBreadcrumb({
                family: 'outbox',
                message: 'persisted-ack-missing',
                level: 'error',
                data: {
                  clientTurnIdHash: hashForBreadcrumb(clientTurnId),
                  elapsedMs,
                },
              });
              settleReject(new PersistedAckMissingError({
                clientTurnId,
                sessionId,
                turnId,
                elapsedMs,
              }));
              return;
            }
            recordContinuityBreadcrumb({
              family: 'outbox',
              message: 'persisted-ack-missing',
              level: 'warning',
              data: {
                clientTurnIdHash: hashForBreadcrumb(clientTurnId),
                elapsedMs,
              },
            });
            settleResolve({
              clientTurnId,
              turnId,
              degraded: true,
            });
          }, TURN_PERSISTED_ACK_TIMEOUT_MS);
          return;
        }

        if (ev.type === 'turn_persisted') {
          if (typeof ev.turnId === 'string' && ev.turnId.length > 0) {
            turnId = ev.turnId;
          }

          // The turn was persisted as an error (e.g. a terminal provider-route
          // decision: the managed subscription is unreachable from cloud, or a
          // provider needs reconnecting). No model ran, so there is no assistant
          // reply. Reject as a recoverable failure rather than resolving success
          // — otherwise the user's message appears "sent" with no response and
          // no error (the silent no-response this fix removes).
          if (ev.outcome === 'error') {
            const userMessage = resolveTurnFailureUserMessage({
              provider: lastErrorEvent?.provider,
              errorKind: lastErrorEvent?.errorKind,
              providerMessage: lastErrorEvent?.error,
            });
            recordContinuityBreadcrumb({
              family: 'outbox',
              message: 'turn-persisted-error',
              level: 'warning',
              data: {
                clientTurnIdHash: hashForBreadcrumb(clientTurnId),
                turnIdHash: turnId ? hashForBreadcrumb(turnId) : undefined,
                sessionIdHash: hashForBreadcrumb(sessionId),
                errorKind: lastErrorEvent?.errorKind,
                provider: lastErrorEvent?.provider,
                idempotentReplay: !sawTurnStarted,
              },
            });
            settleReject(new TurnFailedError({
              clientTurnId,
              sessionId,
              turnId,
              providerMessage: lastErrorEvent?.error,
              errorKind: lastErrorEvent?.errorKind,
              provider: lastErrorEvent?.provider,
              userMessage,
            }));
            return;
          }

          if (!sawTurnStarted) {
            recordContinuityBreadcrumb({
              family: 'outbox',
              message: 'idempotent-replay',
              level: 'info',
              data: {
                clientTurnIdHash: hashForBreadcrumb(clientTurnId),
                turnIdHash: turnId ? hashForBreadcrumb(turnId) : undefined,
              },
            });
          } else {
            const elapsedMs = turnStartedAtMs ? Date.now() - turnStartedAtMs : 0;
            recordContinuityBreadcrumb({
              family: 'outbox',
              message: 'turn-persisted',
              data: {
                clientTurnIdHash: hashForBreadcrumb(clientTurnId),
                turnIdHash: turnId ? hashForBreadcrumb(turnId) : undefined,
                sessionIdHash: hashForBreadcrumb(sessionId),
                elapsedMs,
              },
            });
          }

          settleResolve({
            clientTurnId,
            turnId,
            idempotentReplay: !sawTurnStarted,
          });
          return;
        }

        if (ev.type === 'session_tombstoned') {
          recordContinuityBreadcrumb({
            family: 'outbox',
            message: 'session-tombstoned',
            level: 'info',
            data: {
              clientTurnIdHash: hashForBreadcrumb(clientTurnId),
              sessionIdHash: hashForBreadcrumb(sessionId),
            },
          });
          settleReject(new SessionTombstonedError({
            clientTurnId,
            sessionId,
          }));
          return;
        }

        if (ev.type === 'turn_in_flight') {
          if (typeof ev.turnId === 'string' && ev.turnId.length > 0) {
            turnId = ev.turnId;
          }
          recordContinuityBreadcrumb({
            family: 'outbox',
            message: 'in-flight-conflict',
            level: 'info',
            data: {
              clientTurnIdHash: hashForBreadcrumb(clientTurnId),
            },
          });
          settleReject(new TurnInFlightError({
            clientTurnId,
            sessionId,
            turnId,
          }));
        }
      },
      (err: Error) => {
        settleReject(err);
      },
      (_code: number, _reason: string) => {
        if (settled) return;
        if (sawTurnStarted) {
          // Legacy servers close after `result`/`error` without `turn_persisted`.
          // Keep waiting for the 60s persistence-ack fallback timer.
          return;
        }
        settleReject(new Error('WebSocket closed before turn_started'));
      },
    );

    turnStartedTimeout = setTimeout(() => {
      settleReject(new Error('Turn submission timed out'));
    }, TURN_STARTED_TIMEOUT_MS);
  });
}
