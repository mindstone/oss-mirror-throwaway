/**
 * Agent route handlers — stop turn + WebSocket agent turn execution.
 *
 * The cloud-service is responsible for persisting sessions after agent turns.
 * handleAgentTurnWs is a WS-specific wrapper around submitAgentTurnInternal(),
 * which owns shared turn-submission/persistence logic for both WS and internal
 * in-process callers.
 */

import http from 'node:http';
import WebSocket from 'ws';
import { readBody, sendJson, log, sendRouteError, RouteError } from '../httpUtils';
import type { CloudServiceDeps } from '../bootstrap';
import type { AgentEvent } from '@shared/types';
import { getTurnIdempotencyIndex } from '@core/services/continuity/turnIdempotencyIndex';
import { getSessionSeqIndex } from '@core/services/continuity/sessionSeqIndex';
import { stopAgentTurn } from '@core/services/agentTurnService';
import { AgentTurnRequestSchema } from '@shared/ipc/schemas/agent';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import {
  submitAgentTurnInternal,
  SessionTombstonedError,
  TURN_CHECKPOINT_INTERVAL_MS,
  TURN_CHECKPOINT_TOOL_RESULT_THRESHOLD,
  _resetTranscriptUnavailableRateLimitForTesting,
} from '../services/agentTurnSubmissionService';

export const TURN_WS_PING_INTERVAL_MS = 30_000;
export const TURN_WS_PONG_TIMEOUT_MS = 10_000;
export {
  TURN_CHECKPOINT_INTERVAL_MS,
  TURN_CHECKPOINT_TOOL_RESULT_THRESHOLD,
  _resetTranscriptUnavailableRateLimitForTesting,
};

export async function handleAgentStop(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST' }));
  const body = await readBody(req) as { turnId?: string } | null;
  if (!body?.turnId) return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Missing turnId' }));

  const result = stopAgentTurn(body.turnId);
  if (result.status === 'not_found') {
    return sendRouteError(res, undefined, new RouteError('TURN_NOT_FOUND', { status: 404, message: `No active turn with id ${body.turnId}` }));
  }
  return sendJson(res, 200, { success: true });
}

export function handleAgentTurnWs(ws: WebSocket, deps: CloudServiceDeps): void {
  let turnId: string | null = null;
  let sessionId: string | null = null;
  let clientTurnId: string | null = null;
  let closed = false;
  let startupComplete = false;
  let completionClosePending = false;
  const pendingStartupEvents: AgentEvent[] = [];
  let pingInterval: NodeJS.Timeout | null = null;
  let pongTimeout: NodeJS.Timeout | null = null;
  const turnIdempotencyIndex = getTurnIdempotencyIndex();
  const sessionSeqIndex = getSessionSeqIndex();

  const clearTurnWsKeepalive = () => {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    if (pongTimeout) {
      clearTimeout(pongTimeout);
      pongTimeout = null;
    }
  };

  const scheduleCompletionClose = () => {
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Turn completed');
    }, 100);
  };

  const cleanup = () => {
    clearTurnWsKeepalive();
    if (closed) return;
    closed = true;
    // We intentionally do NOT abort the turn when the WS closes. The WS is a
    // streaming pipe, not a kill switch. The turn runs to completion server-side,
    // the session is persisted, and the event channel notifies reconnecting clients.
    // Intentional cancellation uses POST /api/agent/stop.
    if (turnId) {
      log({ level: 'info', msg: 'Turn WS disconnected while turn active — turn continues server-side', turnId, sessionId });
    }
  };
  ws.on('close', cleanup);
  ws.on('error', (err) => {
    log({ level: 'warn', msg: 'Agent WS error', error: err.message });
    cleanup();
  });
  ws.on('pong', () => {
    if (!pongTimeout) return;
    clearTimeout(pongTimeout);
    pongTimeout = null;
  });

  pingInterval = setInterval(() => {
    if (closed || ws.readyState !== WebSocket.OPEN) {
      cleanup();
      return;
    }

    ws.ping();
    if (pongTimeout) clearTimeout(pongTimeout);
    pongTimeout = setTimeout(() => {
      log({ level: 'warn', msg: 'Dead turn WS connection detected', turnId, sessionId });
      ws.terminate();
      cleanup();
    }, TURN_WS_PONG_TIMEOUT_MS);
    pongTimeout.unref?.();
  }, TURN_WS_PING_INTERVAL_MS);
  pingInterval.unref?.();

  ws.once('message', (data) => {
    const messageTask = (async () => {
    let rawRequest: unknown;
    try {
      rawRequest = JSON.parse(data.toString('utf-8'));
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      ws.close(1003, 'Invalid JSON');
      return;
    }

    const requestParse = AgentTurnRequestSchema.safeParse(rawRequest);
    if (!requestParse.success) {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid request body' }));
      ws.close(1003, 'Invalid request body');
      return;
    }
    const request = requestParse.data;
    sessionId = request.sessionId;
    clientTurnId = typeof request.clientTurnId === 'string' && request.clientTurnId.trim().length > 0
      ? request.clientTurnId.trim()
      : null;

    if (clientTurnId) {
      const lookup = turnIdempotencyIndex.getForSession(clientTurnId, request.sessionId);
      if (lookup.ownership === 'collision') {
        log({
          level: 'warn',
          msg: 'Rejected cross-session clientTurnId collision',
          clientTurnId,
          requestSessionId: request.sessionId,
          existingSessionId: lookup.entry?.sessionId,
        });
        ws.send(JSON.stringify({
          type: 'error',
          error: 'clientTurnId belongs to a different session',
        }));
        ws.close(1008, 'Cross-session clientTurnId collision');
        return;
      }
      const existing = lookup.entry;
      if (existing?.status === 'persisted') {
        const replaySeq = sessionSeqIndex.getCurrentSeq(request.sessionId);
        ws.send(JSON.stringify({
          type: 'turn_persisted',
          clientTurnId: existing.clientTurnId,
          turnId: existing.turnId,
          sessionId: existing.sessionId,
          status: existing.status,
          outcome: existing.outcome,
          ...(replaySeq > 0 ? { seq: replaySeq } : {}),
          idempotentReplay: true,
        }));
        ws.close(1000, 'Turn already persisted (idempotent replay)');
        return;
      }
      if (existing?.status === 'in_flight') {
        ws.send(JSON.stringify({
          type: 'turn_in_flight',
          clientTurnId: existing.clientTurnId,
          turnId: existing.turnId || undefined,
          sessionId: existing.sessionId || request.sessionId,
          status: existing.status,
        }));
        ws.close(1000, 'Turn already in flight');
        return;
      }
      turnIdempotencyIndex.markInFlight(clientTurnId, { sessionId: request.sessionId });
    }

    let turnStartedSuccessfully = false;
    let unsubscribeStreamListener: (() => void) | null = null;
    try {
      const submission = await submitAgentTurnInternal({
        deps,
        request,
      });
      turnId = submission.turnId;
      if (clientTurnId) {
        turnIdempotencyIndex.setTurnInfo(clientTurnId, {
          turnId,
          sessionId: request.sessionId,
        });
      }
      turnStartedSuccessfully = true;

      unsubscribeStreamListener = submission.subscribe((event) => {
        if (event.type === 'result' || event.type === 'error') {
          clearTurnWsKeepalive();
        }

        if (!closed && ws.readyState === WebSocket.OPEN) {
          if (startupComplete) {
            ws.send(JSON.stringify(event));
          } else {
            pendingStartupEvents.push(event);
          }
        }
      });

      fireAndForget(
        submission.completion
          .then((completion) => {
            if (!clientTurnId || !turnId) return;

            if (!completion.persisted) {
              turnIdempotencyIndex.markErrored(clientTurnId, {
                turnId,
                sessionId: request.sessionId,
                outcome: completion.outcome,
              });
              return;
            }
            const persistedEntry = turnIdempotencyIndex.markPersisted(clientTurnId, {
              turnId,
              sessionId: request.sessionId,
              outcome: completion.outcome,
            });
            if (!closed && ws.readyState === WebSocket.OPEN) {
              const persistedSeq = sessionSeqIndex.getCurrentSeq(request.sessionId);
              ws.send(JSON.stringify({
                type: 'turn_persisted',
                clientTurnId: persistedEntry.clientTurnId,
                turnId: persistedEntry.turnId,
                sessionId: persistedEntry.sessionId,
                status: persistedEntry.status,
                outcome: persistedEntry.outcome,
                ...(persistedSeq > 0 ? { seq: persistedSeq } : {}),
              }));
            }
          })
          .finally(() => {
            unsubscribeStreamListener?.();
            unsubscribeStreamListener = null;
            if (startupComplete) {
              scheduleCompletionClose();
            } else {
              completionClosePending = true;
            }
          }),
        'cloud.agentTurnWs.completion',
      );

      await submission.startup;

      ws.send(JSON.stringify({
        type: 'turn_started',
        turnId,
        ...(clientTurnId ? { clientTurnId } : {}),
        supportsPersistedAck: true,
      }));
      startupComplete = true;

      // Flush any events the executor emitted before turn_started was sent
      for (const pending of pendingStartupEvents) {
        if (!closed && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(pending));
        }
      }
      pendingStartupEvents.length = 0;
      if (completionClosePending) {
        completionClosePending = false;
        scheduleCompletionClose();
      }

      log({ level: 'info', msg: 'Agent turn started', turnId, sessionId: request.sessionId });
    } catch (err) {
      const errorMessage = (err as Error).message;
      if (clientTurnId && !turnStartedSuccessfully) {
        turnIdempotencyIndex.markErrored(clientTurnId, {
          turnId: turnId ?? undefined,
          sessionId: request.sessionId,
        });
      }

      // Tombstoned session: the turn never ran (gated before any persistence).
      // Send a distinct signal so the client recreates the conversation under a
      // fresh, visible id rather than treating it as a generic error/retry.
      // Mirrors the session-events 410 tombstone semantics for the WS path.
      if (err instanceof SessionTombstonedError) {
        log({ level: 'info', msg: 'Agent turn gated: session tombstoned', sessionId: request.sessionId });
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: 'session_tombstoned',
              sessionId: request.sessionId,
              ...(clientTurnId ? { clientTurnId } : {}),
            }));
            ws.close(1000, 'Session deleted');
          } catch (closeErr) {
            ignoreBestEffortCleanup(closeErr, {
              operation: 'agentTurnWs.sendTombstoneSignal',
              reason: 'WS already closing/closed when signalling tombstone',
            });
          }
        }
      } else {
        if (turnStartedSuccessfully) {
          log({
            level: 'warn',
            msg: 'Post-start setup failed but turn continues',
            turnId,
            sessionId: request.sessionId,
            error: errorMessage,
          });
        } else {
          log({ level: 'error', msg: 'Failed to start turn', error: errorMessage });
        }

        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'error', error: errorMessage }));
            ws.close(1011, turnStartedSuccessfully ? 'Turn startup post-start failed' : 'Turn start failed');
          } catch (closeErr) {
            ignoreBestEffortCleanup(closeErr, {
              operation: 'agentTurnWs.sendErrorSignal',
              reason: 'WS already closing/closed when signalling turn error',
            });
          }
        }
      }
    }
    })();
    fireAndForget(messageTask, 'cloud.agentTurnWs.message');
    return messageTask as unknown as void;
  });
}
