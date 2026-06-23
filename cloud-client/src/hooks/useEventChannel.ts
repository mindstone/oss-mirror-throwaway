// cloud-client/src/hooks/useEventChannel.ts

import { useEffect, useRef, useCallback } from 'react';
import * as cloudClient from '../cloudClient';
import { useAuthStore } from '../auth/createAuthStore';
import type { ConnectionState } from '../stores/sessionStore';
import { createLogger } from '../utils/logger';

type EventHandler = (channel: string, args: unknown[]) => void;
type ConnectionStateHandler = (state: ConnectionState) => void;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const log = createLogger('eventChannel');

/**
 * Persistent event channel with auto-reconnect and exponential backoff.
 * Connects when paired, disconnects on unpair or unmount.
 *
 * Returns `forceReconnect` — an imperative reconnect trigger that skips backoff.
 * Intended for use by AppState foreground handlers and NetInfo online transitions.
 *
 * @param onEvent — called for each received event
 * @param onConnectionStateChange — called when the WebSocket connection state transitions
 * @param onReconnect — called on successful reconnection (not initial connect) to allow catch-up
 */
export function useEventChannel(
  onEvent: EventHandler,
  onConnectionStateChange?: ConnectionStateHandler,
  onReconnect?: () => void,
): { forceReconnect: () => void } {
  const isPaired = useAuthStore((s) => s.isPaired);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  const connectionStateRef = useRef(onConnectionStateChange);
  connectionStateRef.current = onConnectionStateChange;

  const reconnectCallbackRef = useRef(onReconnect);
  reconnectCallbackRef.current = onReconnect;

  const socketRef = useRef<{ close: () => void } | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  /** Tracks whether we've received at least one message on the current socket. */
  const connectedRef = useRef(false);
  /** Set during forceReconnect to prevent onClose from scheduling a competing reconnect. */
  const intentionalCloseRef = useRef(false);
  /** Tracks whether the next onOpen is a reconnect (not the initial connect). */
  const isReconnectRef = useRef(false);
  /** Start timestamp for the current reconnect cycle (first close -> next open). */
  const reconnectCycleStartedAtRef = useRef<number | null>(null);
  /** Last scheduled reconnect delay for observability. */
  const lastScheduledBackoffMsRef = useRef<number>(0);

  const connect = useCallback(() => {
    if (!mountedRef.current || !cloudClient.isConfigured()) return;

    connectedRef.current = false;
    // Signal reconnecting when this is a retry attempt
    if (retryRef.current > 0) {
      connectionStateRef.current?.('reconnecting');
    }

    socketRef.current = cloudClient.createEventSocket(
      (channel, args) => {
        // Reset backoff on successful message (connection is alive)
        retryRef.current = 0;
        handlerRef.current(channel, args);
      },
      () => {
        // Error -- reconnect will happen via onClose
      },
      () => {
        // Closed -- schedule reconnect with backoff (only if still paired)
        socketRef.current = null;
        connectedRef.current = false;
        if (!mountedRef.current || !useAuthStore.getState().isPaired || intentionalCloseRef.current) {
          if (!intentionalCloseRef.current) connectionStateRef.current?.('disconnected');
          intentionalCloseRef.current = false;
          return;
        }
        connectionStateRef.current?.('reconnecting');
        if (retryRef.current === 0) {
          reconnectCycleStartedAtRef.current = Date.now();
        }
        const attempt = retryRef.current + 1;
        const baseDelay = Math.min(RECONNECT_BASE_MS * 2 ** retryRef.current, RECONNECT_MAX_MS);
        const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4)); // ±20% jitter
        lastScheduledBackoffMsRef.current = delay;
        log.info('Scheduled event-channel reconnect', { attempt, delayMs: delay, baseDelayMs: baseDelay });
        retryRef.current++;
        timerRef.current = setTimeout(connect, delay);
      },
      () => {
        // Opened -- signal connected immediately so the UI banner clears
        connectedRef.current = true;
        const reconnectAttempts = retryRef.current;
        retryRef.current = 0;
        intentionalCloseRef.current = false;
        connectionStateRef.current?.('connected');
        // On reconnect (not initial connect), trigger catch-up callback
        if (isReconnectRef.current) {
          const reconnectDurationMs = reconnectCycleStartedAtRef.current === null
            ? null
            : Math.max(0, Date.now() - reconnectCycleStartedAtRef.current);
          log.info('sse_reconnect', {
            attemptNum: reconnectAttempts,
            backoffMs: lastScheduledBackoffMsRef.current,
            disconnectedDurationMs: reconnectDurationMs ?? 0,
          });
          lastScheduledBackoffMsRef.current = 0;
          reconnectCycleStartedAtRef.current = null;
          reconnectCallbackRef.current?.();
        }
        isReconnectRef.current = true;
      },
    );
  }, []);

  const forceReconnect = useCallback(() => {
    // No-op if already connected and healthy
    if (connectedRef.current && socketRef.current) return;
    // No-op if not configured/paired
    if (!mountedRef.current || !cloudClient.isConfigured() || !useAuthStore.getState().isPaired) return;

    // Clear any pending reconnect timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Close existing socket with intentional flag to prevent onClose from scheduling competing reconnect
    if (socketRef.current) {
      intentionalCloseRef.current = true;
      const socket = socketRef.current;
      socketRef.current = null;
      connectedRef.current = false;
      queueMicrotask(() => {
        try { socket.close(); } catch { /* already invalidated */ }
      });
    }

    // Reset backoff and connect immediately
    retryRef.current = 0;
    reconnectCycleStartedAtRef.current = Date.now();
    lastScheduledBackoffMsRef.current = 0;
    log.info('Force reconnect requested for event channel');
    connect();
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    if (isPaired) connect();

    return () => {
      mountedRef.current = false;
      isReconnectRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      const socket = socketRef.current;
      socketRef.current = null;
      connectedRef.current = false;
      reconnectCycleStartedAtRef.current = null;
      connectionStateRef.current?.('disconnected');
      // Defer native close to next microtask to avoid TurboModule exceptions
      // during React's synchronous unmount phase.
      if (socket) {
        queueMicrotask(() => {
          try { socket.close(); } catch { /* already invalidated */ }
        });
      }
    };
  }, [isPaired, connect]);

  return { forceReconnect };
}
