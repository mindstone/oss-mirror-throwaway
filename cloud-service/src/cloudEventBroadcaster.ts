/**
 * Cloud Event Broadcaster
 *
 * Manages persistent WebSocket connections from desktop clients and pushes
 * events that would normally go through `webContents.send()`. Also provides
 * a virtual BrowserWindow-like object that code using `win.webContents.send()`
 * or `BrowserWindow.getAllWindows()` can call transparently.
 */

import WebSocket from 'ws';
import { sendPushNotification } from './services/pushNotificationService';
import {
  buildApprovalPush,
  buildCoachingPush,
} from '@shared/schemas/pushNotifications';

function log(data: { level: string; msg: string; [key: string]: unknown }): void {
  const { level, msg, ...rest } = data;
  const ts = new Date().toISOString();
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
  console.log(`[${ts}] [${level.toUpperCase()}] [cloudEventBroadcaster] ${msg}${extra}`);
}

const PONG_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;

interface VirtualWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

type ChannelListener = (channel: string, ...args: unknown[]) => void;
type ClientConnectedListener = () => void;

class CloudEventBroadcaster {
  private clients = new Set<WebSocket>();
  private pingIntervals = new Map<WebSocket, NodeJS.Timeout>();
  private pongTimeouts = new Map<WebSocket, NodeJS.Timeout>();
  private channelListeners = new Map<string, Set<ChannelListener>>();
  private clientConnectedListeners = new Set<ClientConnectedListener>();

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    log({ level: 'info', msg: 'Event client connected', clientCount: this.clients.size });

    for (const listener of [...this.clientConnectedListeners]) {
      try {
        listener();
      } catch (err) {
        log({
          level: 'warn',
          msg: 'onClientConnected listener failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    ws.on('close', () => this.removeClient(ws));
    ws.on('error', (err) => {
      log({ level: 'warn', msg: 'Event client error', error: err.message });
      this.removeClient(ws);
    });
    ws.on('pong', () => {
      const timeout = this.pongTimeouts.get(ws);
      if (timeout) {
        clearTimeout(timeout);
        this.pongTimeouts.delete(ws);
      }
    });

    const pingInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        this.removeClient(ws);
        return;
      }
      ws.ping();
      const pongTimeout = setTimeout(() => {
        log({ level: 'warn', msg: 'Pong timeout, closing dead connection' });
        ws.terminate();
        this.removeClient(ws);
      }, PONG_TIMEOUT_MS);
      this.pongTimeouts.set(ws, pongTimeout);
    }, PING_INTERVAL_MS);

    this.pingIntervals.set(ws, pingInterval);
  }

  removeClient(ws: WebSocket): void {
    if (!this.clients.has(ws)) return;
    this.clients.delete(ws);

    const pingInterval = this.pingIntervals.get(ws);
    if (pingInterval) {
      clearInterval(pingInterval);
      this.pingIntervals.delete(ws);
    }
    const pongTimeout = this.pongTimeouts.get(ws);
    if (pongTimeout) {
      clearTimeout(pongTimeout);
      this.pongTimeouts.delete(ws);
    }

    log({ level: 'info', msg: 'Event client disconnected', clientCount: this.clients.size });
  }

  onChannel(channel: string, listener: ChannelListener): () => void {
    const listeners = this.channelListeners.get(channel) ?? new Set<ChannelListener>();
    listeners.add(listener);
    this.channelListeners.set(channel, listeners);

    return () => {
      const channelListeners = this.channelListeners.get(channel);
      if (!channelListeners) return;
      channelListeners.delete(listener);
      if (channelListeners.size === 0) {
        this.channelListeners.delete(channel);
      }
    };
  }

  /**
   * Returns true iff at least one client has WebSocket.OPEN readyState.
   *
   * CONNECTING clients deliberately do NOT count: broadcast() only sends to
   * OPEN sockets, so a snapshot for "would broadcast deliver to anyone right
   * now?" must use the same gate.
   */
  hasOpenClient(): boolean {
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  /**
   * Register a listener invoked once per successful addClient. Returns an
   * unsubscribe function. Used by Slack inbound replay to re-drive entries
   * that were broadcast-dropped during a no-client window.
   */
  onClientConnected(listener: ClientConnectedListener): () => void {
    this.clientConnectedListeners.add(listener);
    return () => {
      this.clientConnectedListeners.delete(listener);
    };
  }

  // Channels that have their own dedicated transport (turn WS) and must NOT
  // be duplicated through the event channel.
  private static readonly EXCLUDED_CHANNELS = new Set([
    'agent:event',  // streamed via /api/agent/turn WS
  ]);

  broadcast(channel: string, ...args: unknown[]): void {
    if (CloudEventBroadcaster.EXCLUDED_CHANNELS.has(channel)) return;

    const listeners = this.channelListeners.get(channel);
    if (listeners && listeners.size > 0) {
      for (const listener of [...listeners]) {
        try {
          listener(channel, ...args);
        } catch (err) {
          log({
            level: 'warn',
            msg: 'Channel listener failed',
            channel,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Send push notification for tool approval requests when no WS clients
    // are connected (avoids double-notification when app is in foreground).
    if (channel === 'tool-safety:approval-request' && this.clients.size === 0) {
      const approval = args[0] as Record<string, unknown> | undefined;
      sendPushNotification({
        title: 'Rebel needs your approval',
        body: (approval?.toolName as string) || 'Tool approval needed',
        data: buildApprovalPush({
          kind: 'tool-approval',
          sessionId: approval?.sessionId as string | undefined,
        }),
      }).catch(() => {});
    }

    if (channel === 'memory:write-approval-request' && this.clients.size === 0) {
      const payload = args[0] as Record<string, unknown> | undefined;
      const dest = payload?.destination as Record<string, unknown> | undefined;
      sendPushNotification({
        title: 'Memory approval needed',
        body: (dest?.spaceName as string) || 'Rebel wants to save to memory',
        data: buildApprovalPush({
          kind: 'memory-approval',
          sessionId: payload?.originalSessionId as string | undefined,
        }),
      }).catch(() => {});
    }

    if (channel === 'memory:file-staged' && this.clients.size === 0) {
      const payload = args[0] as Record<string, unknown> | undefined;
      sendPushNotification({
        title: 'File ready to save',
        body: (payload?.spaceName as string) || 'Rebel staged a file for your review',
        data: buildApprovalPush({ kind: 'staged-file' }),
      }).catch(() => {});
    }

    // Push notification fallback for coaching cards when backgrounded (F5)
    if (channel === 'meeting:coaching-card' && this.clients.size === 0) {
      const payload = args[0] as Record<string, unknown> | undefined;
      sendPushNotification({
        title: 'Meeting Coach',
        body: (payload?.tip as string) || 'New coaching tip',
        data: buildCoachingPush({
          sessionId: payload?.sessionId as string | undefined,
        }),
      }).catch(() => {});
    }

    if (this.clients.size === 0) return;

    // Always send args as an array to preserve arity across the WS boundary.
    // The desktop side spreads them back into webContents.send(channel, ...args).
    const msg = JSON.stringify({ channel, args });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(msg);
        } catch (err) {
          log({ level: 'warn', msg: 'Failed to send event to client', channel, error: (err as Error).message });
        }
      }
    }
  }

  get virtualWindow(): VirtualWindow {
    return this._virtualWindow;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const ws of this.clients) {
      ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    for (const interval of this.pingIntervals.values()) clearInterval(interval);
    this.pingIntervals.clear();
    for (const timeout of this.pongTimeouts.values()) clearTimeout(timeout);
    this.pongTimeouts.clear();
    this.channelListeners.clear();
    this.clientConnectedListeners.clear();
  }

  private _virtualWindow: VirtualWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, ...args: unknown[]) => this.broadcast(channel, ...args),
    },
  };
}

export const cloudEventBroadcaster = new CloudEventBroadcaster();
