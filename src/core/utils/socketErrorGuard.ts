import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { createScopedLogger, type Logger } from '@core/logger';

const defaultLog = createScopedLogger({ service: 'socketErrorGuard' });

/**
 * Socket error codes that mean "the peer went away mid-write" — the normal,
 * expected outcome of a client disconnect (turn-cancel, tab/app close, aborted
 * SSE stream), not a bug on our side.
 */
const BENIGN_SOCKET_ERROR_CODES = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED']);

/** True for socket errors caused by the peer closing the connection. */
export function isBenignSocketError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' && BENIGN_SOCKET_ERROR_CODES.has(code);
}

/**
 * Attach a per-connection `'error'` handler to an `http.Server` so an async
 * socket write that fails after the peer closed its read end (EPIPE /
 * ECONNRESET / ECONNABORTED) is handled at the socket layer instead of
 * escalating to `process.on('uncaughtException')` — which the main process
 * reports at `level=fatal` (REBEL-5J5).
 *
 * This is the single chokepoint for the crash class: it covers per-request
 * response sockets AND WebSocket-upgrade sockets (both arrive via the server's
 * `'connection'` event), so no individual `res.write` / `socket.write` site can
 * leak an unhandled socket error again. Listen-level `server.on('error')`
 * (EADDRINUSE etc.) is a different concern and is left untouched.
 *
 * A non-benign socket error is logged at `warn` and still swallowed at the
 * socket layer: an unhandled socket `'error'` has no safe escalation, and
 * crashing the Electron main process over one dropped connection is worse.
 */
export function attachBenignSocketErrorGuard(server: Server, log: Logger = defaultLog): void {
  server.on('connection', (socket: Socket) => {
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (isBenignSocketError(err)) return;
      log.warn({ err, code: err?.code }, 'Non-benign socket error (handled; connection dropped)');
    });
  });
}
