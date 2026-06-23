// mobile/src/utils/sendAndDone.ts

/**
 * Fire-and-forget "send and done": opens a detached WebSocket turn,
 * waits for the server to confirm the turn, then marks the session done via
 * `updateSession()`.
 *
 * The socket is NOT tied to any React component — it survives unmount.
 * Callers navigate away immediately after invoking this.
 *
 * History: this used to mark the session done on `turn_started` and close the
 * socket immediately. That was a silent-failure bug: a turn that started but
 * then hit a *terminal provider-route error* (e.g. the Mindstone managed
 * subscription is unreachable from cloud → `missing-mindstone`) persists with
 * `outcome:"error"` AFTER the ack, and a deleted session emits
 * `session_tombstoned`. Closing on `turn_started` meant those signals never
 * arrived, so the user saw their recording "sent and done" with no response and
 * no error. We now wait for `turn_persisted` to learn the real outcome, mark
 * done only on a successful result, and surface a failure recoverably (via
 * `onTerminalFailure`). The caller's recovery differs by kind: a terminal-error
 * (the turn ran and persisted an error) is shown as a toast and is NOT
 * re-enqueued (retrying the identical turn just re-persists the same error); a
 * session-tombstoned or delivery-failed (the turn never ran / outcome unknown)
 * is re-enqueued so the offline queue redelivers it through the recreate /
 * ack-guarded path. See docs/plans/260622_mobile-record-recreated-session/PLAN.md
 * (Stage 2b / Stage 2c F1).
 */

import {
  createAgentTurnSocket,
  updateSession,
} from '@rebel/cloud-client';
import type { WebFileAttachment, CloudMeetingSessionId } from '@rebel/cloud-client';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { resolveTurnFailureUserMessage } from './turnFailureCopy';

type CreateSocketFn = typeof createAgentTurnSocket;
type UpdateSessionFn = typeof updateSession;

/**
 * Why a send-and-done turn failed AFTER the server acknowledged it
 * (`turn_started` fired), so it never produced an assistant response.
 *
 *   - 'terminal-error' — the turn persisted with `outcome:"error"` (a terminal
 *     provider-route decision: managed subscription unreachable from cloud, a
 *     provider needs reconnecting, an unsupported model, …). No model ran.
 *   - 'session-tombstoned' — the target session was deleted server-side; the
 *     turn never ran. The caller should recreate (re-enqueue mints a fresh id).
 *   - 'delivery-failed' — a CURRENT server (advertised `supportsPersistedAck`)
 *     acknowledged the turn (`turn_started`) but the socket then closed or
 *     timed out WITHOUT a `turn_persisted` ack. The outcome is unknown — this is
 *     an abnormal/failed delivery, not success. The caller should recover (e.g.
 *     re-enqueue so the offline queue redelivers with its own ack guard); we do
 *     NOT mark the session done. Legacy/unknown servers (no `supportsPersistedAck`)
 *     keep the best-effort mark-done fallback instead. Mirrors
 *     `submitTurnViaSocket`'s `PersistedAckMissingError`.
 */
export interface SendAndDoneTerminalFailure {
  kind: 'terminal-error' | 'session-tombstoned' | 'delivery-failed';
  /** Plain-English, recoverable copy chosen for the mobile surface. */
  userMessage: string;
  /** Provider name, if the server streamed an `error` event. */
  provider?: string;
  /** Structural classification, if the server streamed an `error` event. */
  errorKind?: string;
}

interface SendAndDoneDeps {
  createSocket?: CreateSocketFn;
  updateSessionFn?: UpdateSessionFn;
  /** Cloud meeting session id (branded — a local recording id cannot be passed). */
  meetingSessionId?: CloudMeetingSessionId;
  recordingActive?: boolean;
  onArchiveError?: (message: string) => void;
  /**
   * Fires when the socket closes or errors BEFORE `turn_started` was received.
   * At that point the server never acknowledged the turn — the caller has
   * already cleared its composer, so the draft is at risk of loss.
   *
   * The callback receives a `reason` describing why we didn't ack:
   *   - 'error' — socket raised an error event
   *   - 'timeout' — safety timeout fired before ack
   *   - 'closed' — socket closed (local or remote) before ack
   */
  onFailureBeforeAck?: (reason: 'error' | 'timeout' | 'closed') => void;
  /**
   * Fires when the turn was acknowledged (`turn_started`) but then FAILED
   * terminally — it persisted with `outcome:"error"`, or the session was
   * tombstoned. The turn produced no assistant reply, so the caller must NOT
   * treat it as success: surface the failure recoverably (e.g. re-enqueue the
   * prompt so the offline queue drains it through the existing failed-chip /
   * recreate affordances). The session is NOT marked done in this case.
   *
   * Fires at most once, and mutually-exclusively with `onFailureBeforeAck`.
   */
  onTerminalFailure?: (failure: SendAndDoneTerminalFailure) => void;
}

const SOCKET_TIMEOUT_MS = 30_000;
// After `turn_started`, wait this long for `turn_persisted` to learn the real
// outcome. If it never arrives (legacy server that closes after result/error
// without a persisted ack), fall back to marking done — preserving the old
// best-effort behaviour rather than dropping a likely-successful turn.
const PERSISTED_ACK_TIMEOUT_MS = 60_000;

interface StreamedErrorEvent {
  error?: string;
  errorKind?: string;
  provider?: string;
}

/**
 * Send a prompt in the background and mark the session as done.
 *
 * - Opens a detached `createAgentTurnSocket` (independent of component lifecycle).
 * - Waits for `turn_started` (ack), then for `turn_persisted` to learn the
 *   outcome:
 *     - `outcome:"result"` (or absent) → marks the session done via
 *       `updateSession()` with `{ doneAt, resolvedAt, updatedAt }`.
 *     - `outcome:"error"` → fires `onTerminalFailure({ kind:'terminal-error' })`
 *       and does NOT mark done (no assistant reply was produced).
 * - `session_tombstoned` → fires `onTerminalFailure({ kind:'session-tombstoned' })`.
 * - Safety timeouts: 30s for `turn_started`; after the ack, 60s for
 *   `turn_persisted`. If `turn_persisted` never arrives (close or timeout): a
 *   legacy/unknown server falls back to marking done; a current server (one that
 *   advertised `supportsPersistedAck` on `turn_started`) surfaces a recoverable
 *   `delivery-failed` failure instead of silently archiving as success.
 * - Returns `{ close }` for optional cancellation.
 */
export function sendAndDoneInBackground(
  sessionId: string,
  prompt: string,
  attachments?: WebFileAttachment[],
  deps?: SendAndDoneDeps,
): { close: () => void } {
  const socketFn = deps?.createSocket ?? createAgentTurnSocket;
  const markDoneFn = deps?.updateSessionFn ?? updateSession;
  let markedDone = false;
  // Tracks whether we ever saw turn_started. If not by the time the socket
  // closes or times out, the server never acknowledged — surface that to the
  // caller via onFailureBeforeAck so drafts can be restored.
  let ackReceived = false;
  // Whether the server advertised persisted-ack support on `turn_started`. A
  // current server (true) that never sends `turn_persisted` is an abnormal/failed
  // delivery (surface recoverably); a legacy/unknown server (null/false) keeps the
  // best-effort mark-done fallback. Mirrors submitTurnViaSocket's guard.
  let supportsPersistedAck = false;
  // One-shot guard: error → close and timeout → close can both fire for a
  // single failed attempt. We must only notify the caller once so they
  // don't toast twice or double-restore. This also guards onTerminalFailure
  // (mutually exclusive with onFailureBeforeAck and mark-done).
  let outcomeSettled = false;
  // Capture a streamed `error` event so a subsequent persisted-error outcome
  // can surface the actual provider reason instead of a generic failure.
  let lastErrorEvent: StreamedErrorEvent | null = null;

  const notifyFailure = (reason: 'error' | 'timeout' | 'closed') => {
    if (outcomeSettled || ackReceived || markedDone) return;
    outcomeSettled = true;
    try {
      deps?.onFailureBeforeAck?.(reason);
    } catch (e) {
      ignoreBestEffortCleanup(e, { operation: 'sendAndDone.onFailureBeforeAck', reason: 'caller callback must not break the detached socket' });
    }
  };

  const notifyTerminalFailure = (failure: SendAndDoneTerminalFailure) => {
    if (outcomeSettled || markedDone) return;
    outcomeSettled = true;
    try {
      deps?.onTerminalFailure?.(failure);
    } catch (e) {
      ignoreBestEffortCleanup(e, { operation: 'sendAndDone.onTerminalFailure', reason: 'caller callback must not break the detached socket' });
    }
  };

  const markDone = () => {
    if (markedDone || outcomeSettled) return;
    markedDone = true;
    outcomeSettled = true;
    const now = Date.now();
    // Lifecycle DONE write via canonical `doneAt`. resolvedAt stays a
    // distinct co-write.
    markDoneFn(sessionId, {
      doneAt: now,
      resolvedAt: now,
      updatedAt: now,
    }).catch((_err) => {
      deps?.onArchiveError?.('Couldn\'t mark done — will stay in your conversations');
    });
  };

  // Post-ack close/timeout fallback: either mark the session done
  // (legacy/unknown server) or surface a recoverable delivery failure (current
  // server that advertised persisted-ack but never sent `turn_persisted`).
  const settlePostAckWithoutPersisted = () => {
    if (outcomeSettled || markedDone) return;
    if (supportsPersistedAck) {
      // Current server: missing turn_persisted is an abnormal/failed delivery,
      // NOT success. Surface recoverably instead of archiving as done.
      notifyTerminalFailure({
        kind: 'delivery-failed',
        userMessage: resolveTurnFailureUserMessage({}),
      });
      return;
    }
    // Legacy/unknown server (never advertised persisted-ack): preserve the prior
    // best-effort behaviour rather than dropping a likely-successful turn.
    markDone();
  };

  const socketRequest: {
    sessionId: string;
    prompt: string;
    attachments?: WebFileAttachment[];
    meetingSessionId?: string;
    recordingActive?: boolean;
  } = { sessionId, prompt };
  if (attachments && attachments.length > 0) {
    socketRequest.attachments = attachments;
  }
  if (deps?.meetingSessionId) {
    socketRequest.meetingSessionId = deps.meetingSessionId;
  }
  if (typeof deps?.recordingActive === 'boolean') {
    socketRequest.recordingActive = deps.recordingActive;
  }

  let startedTimeout: ReturnType<typeof setTimeout> | undefined;
  let persistedTimeout: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    if (startedTimeout) { clearTimeout(startedTimeout); startedTimeout = undefined; }
    if (persistedTimeout) { clearTimeout(persistedTimeout); persistedTimeout = undefined; }
  };

  const socket = socketFn(
    socketRequest,
    (event: unknown) => {
      const ev = event as {
        type?: string;
        outcome?: 'result' | 'error';
        error?: string;
        errorKind?: string;
        provider?: string;
        supportsPersistedAck?: boolean;
      };

      if (ev.type === 'error') {
        // Streamed terminal/error event from the executor. Record it; the turn
        // still persists with outcome:"error", and we surface a recoverable
        // terminal failure on that persisted ack. Do not settle here — keep the
        // connection open until persistence is acknowledged (matches the
        // submitTurnViaSocket happy path).
        lastErrorEvent = {
          error: typeof ev.error === 'string' ? ev.error : undefined,
          errorKind: typeof ev.errorKind === 'string' ? ev.errorKind : undefined,
          provider: typeof ev.provider === 'string' ? ev.provider : undefined,
        };
        return;
      }

      if (ev.type === 'turn_started' && !ackReceived && !outcomeSettled) {
        ackReceived = true;
        supportsPersistedAck = ev.supportsPersistedAck === true;
        if (startedTimeout) { clearTimeout(startedTimeout); startedTimeout = undefined; }
        // Wait for turn_persisted to learn the real outcome. A current server
        // (supportsPersistedAck) that never sends it surfaces a recoverable
        // delivery failure; a legacy/unknown server falls back to marking done.
        persistedTimeout = setTimeout(() => {
          if (!outcomeSettled) {
            settlePostAckWithoutPersisted();
            socket.close();
          }
        }, PERSISTED_ACK_TIMEOUT_MS);
        return;
      }

      if (ev.type === 'session_tombstoned' && !outcomeSettled) {
        clearTimers();
        notifyTerminalFailure({
          kind: 'session-tombstoned',
          userMessage: resolveTurnFailureUserMessage({}),
        });
        socket.close();
        return;
      }

      if (ev.type === 'turn_persisted' && !outcomeSettled) {
        clearTimers();
        if (ev.outcome === 'error') {
          // Terminal provider-route error: persisted, but no model ran → no
          // assistant reply. Surface it recoverably; do NOT mark done.
          notifyTerminalFailure({
            kind: 'terminal-error',
            userMessage: resolveTurnFailureUserMessage({
              provider: lastErrorEvent?.provider,
              errorKind: lastErrorEvent?.errorKind,
              providerMessage: lastErrorEvent?.error,
            }),
            provider: lastErrorEvent?.provider,
            errorKind: lastErrorEvent?.errorKind,
          });
          socket.close();
          return;
        }
        // Successful result (or older server with no outcome field): mark done.
        markDone();
        socket.close();
        return;
      }
    },
    (_err: unknown) => {
      // Socket raised an error. If we haven't acked yet, the caller needs
      // to restore its draft. The subsequent onClose will be a no-op via
      // the one-shot guard.
      notifyFailure('error');
    },
    () => {
      // Socket closed. If we'd already acked but never learned the outcome:
      //   - legacy/unknown server (closed after result/error without
      //     turn_persisted) → fall back to marking done rather than dropping a
      //     likely-successful turn;
      //   - current server (advertised supportsPersistedAck) → an abnormal/failed
      //     delivery → surface a recoverable failure, NOT success.
      if (ackReceived && !outcomeSettled) {
        clearTimers();
        settlePostAckWithoutPersisted();
        return;
      }
      clearTimers();
      notifyFailure('closed');
    },
  );

  startedTimeout = setTimeout(() => {
    if (!ackReceived && !outcomeSettled) {
      notifyFailure('timeout');
      socket.close();
    }
  }, SOCKET_TIMEOUT_MS);

  return {
    close: () => {
      clearTimers();
      socket.close();
    },
  };
}
