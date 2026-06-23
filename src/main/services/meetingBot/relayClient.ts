/**
 * Bot Relay WebSocket Client
 * 
 * Manages WebSocket connection between desktop app and the bot relay (Durable Object).
 * Enables Tier 2 features: dynamic TTS, state control, real-time transcript forwarding.
 * 
 * Uses Node.js built-in WebSocket (available in Node 22+) or falls back to global WebSocket.
 */

import { createScopedLogger } from '@core/logger';

// Use global WebSocket (available in modern Node.js and Electron)
const WS = globalThis.WebSocket;

const log = createScopedLogger({ service: 'bot-relay-client' });

// Message types (must match relay.ts on worker)
interface RelayMessage {
  v: 1;
  type: string;
  [key: string]: unknown;
}

interface AuthMessage extends RelayMessage {
  type: 'auth';
  token: string;
  role: 'desktop';
}

interface AuthOkMessage extends RelayMessage {
  type: 'auth_ok';
  botId: string;
  connectedPeers: number;
  avatarConnected?: boolean;
  jwtRole?: 'owner' | 'viewer';
  desktopCount?: number;
}

interface StateMessage extends RelayMessage {
  type: 'state';
  state: string;
  status?: string;
}

interface PlayAudioMessage extends RelayMessage {
  type: 'play_audio';
  url: string;
  status?: string;
  keepAnimation?: boolean;
  text?: string;
}

export interface RelayClientCallbacks {
  onConnected?: (botId: string, connectedPeers: number) => void;
  onDisconnected?: (reason: string, code: number, willReconnect: boolean) => void;
  onAvatarConnected?: () => void;
  onAvatarDisconnected?: () => void;
  onTranscript?: (segments: unknown[]) => void;
  onTranscriptBuffer?: (segments: unknown[]) => void;
  onChatMessage?: (message: unknown) => void;
  onAudioEnded?: () => void;
  onError?: (error: string) => void;
}

export class BotRelayClient {
  private ws: WebSocket | null = null;
  private botId: string;
  private sessionToken: string;
  private relayUrl: string;
  private callbacks: RelayClientCallbacks;
  
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private isConnected = false;
  private isAuthenticated = false;
  private avatarConnectedNotified = false; // Prevents duplicate onAvatarConnected calls
  
  // For tracking pending audio playback
  private pendingAudioResolve: (() => void) | null = null;
  private pendingAudioTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    botId: string,
    sessionToken: string,
    relayUrl: string,
    callbacks: RelayClientCallbacks = {}
  ) {
    this.botId = botId;
    this.sessionToken = sessionToken;
    this.relayUrl = relayUrl;
    this.callbacks = callbacks;
  }

  /**
   * Connect to the relay
   */
  connect(): void {
    if (this.ws) {
      log.debug({ botId: this.botId }, 'Already connected or connecting');
      return;
    }

    this.shouldReconnect = true;
    this.doConnect();
  }

  private doConnect(): void {
    log.info({ botId: this.botId, relayUrl: this.relayUrl }, 'Connecting to relay');

    try {
      this.ws = new WS(this.relayUrl);

      this.ws.onopen = () => {
        log.info({ botId: this.botId }, 'WebSocket connected, sending auth');
        this.isConnected = true;
        this.reconnectDelay = 1000; // Reset backoff on successful connect
        
        // Send auth message (token not in URL for security)
        const authMsg: AuthMessage = {
          v: 1,
          type: 'auth',
          token: this.sessionToken,
          role: 'desktop',
        };
        this.send(authMsg);
      };

      this.ws.onmessage = (event: MessageEvent) => {
        const data = typeof event.data === 'string' ? event.data : event.data.toString();
        this.handleMessage(data);
      };

      this.ws.onclose = (event: CloseEvent) => {
        const reasonStr = event.reason || 'unknown';
        const willReconnect = this.shouldReconnect && event.code !== 1000;
        const logFn = willReconnect ? log.warn : log.info;
        logFn({ botId: this.botId, code: event.code, reason: reasonStr, willReconnect }, 'WebSocket closed');
        
        this.isConnected = false;
        this.isAuthenticated = false;
        this.ws = null;
        // Reset avatar notification flag so reconnect can re-trigger if avatar is still present
        this.avatarConnectedNotified = false;
        
        this.callbacks.onDisconnected?.(reasonStr, event.code, willReconnect);
        
        // Reconnect if appropriate
        if (willReconnect) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (_event: Event) => {
        log.error({ botId: this.botId }, 'WebSocket error');
        this.callbacks.onError?.('WebSocket error');
      };
    } catch (error) {
      log.error({ botId: this.botId, error }, 'Failed to create WebSocket');
      this.scheduleReconnect();
    }
  }

  private handleMessage(data: string): void {
    let msg: RelayMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      log.warn({ botId: this.botId, data }, 'Invalid JSON from relay');
      return;
    }

    log.debug({ botId: this.botId, type: msg.type }, 'Received relay message');

    switch (msg.type) {
      case 'auth_ok': {
        const authOk = msg as AuthOkMessage;
        this.isAuthenticated = true;
        log.info({ botId: this.botId, connectedPeers: authOk.connectedPeers, avatarConnected: authOk.avatarConnected, jwtRole: authOk.jwtRole, desktopCount: authOk.desktopCount }, 'Authenticated with relay');
        this.callbacks.onConnected?.(authOk.botId, authOk.connectedPeers);
        // If avatar is already connected when we auth (e.g., after reconnect), trigger onAvatarConnected
        // Use explicit avatarConnected field from new DO, fall back to legacy connectedPeers heuristic for old DOs
        const avatarIsConnected = authOk.avatarConnected ?? (authOk.connectedPeers >= 2);
        if (avatarIsConnected && !this.avatarConnectedNotified) {
          log.info({ botId: this.botId, avatarConnected: authOk.avatarConnected, connectedPeers: authOk.connectedPeers }, 'Avatar already connected on auth');
          this.avatarConnectedNotified = true;
          this.callbacks.onAvatarConnected?.();
        }
        break;
      }

      case 'auth_error':
        log.error({ botId: this.botId, error: msg.error }, 'Auth failed');
        this.callbacks.onError?.(`Auth failed: ${msg.error}`);
        this.shouldReconnect = false; // Don't reconnect on auth failure
        this.ws?.close();
        break;

      case 'avatar_connected':
        if (!this.avatarConnectedNotified) {
          log.info({ botId: this.botId }, 'Avatar connected to relay');
          this.avatarConnectedNotified = true;
          this.callbacks.onAvatarConnected?.();
        } else {
          log.debug({ botId: this.botId }, 'Avatar connected (already notified, skipping callback)');
        }
        break;

      case 'avatar_disconnected':
        log.info({ botId: this.botId }, 'Avatar disconnected from relay');
        this.avatarConnectedNotified = false; // Reset so next connect triggers callback
        this.callbacks.onAvatarDisconnected?.();
        break;

      case 'transcript':
        this.callbacks.onTranscript?.(msg.segments as unknown[]);
        break;

      case 'transcript_buffer':
        log.info({ botId: this.botId, segmentCount: Array.isArray(msg.segments) ? (msg.segments as unknown[]).length : 0 }, 'Received transcript buffer from relay');
        this.callbacks.onTranscriptBuffer?.(msg.segments as unknown[]);
        break;

      case 'chat_message':
        this.callbacks.onChatMessage?.(msg);
        break;

      case 'audio_ended':
        log.debug({ botId: this.botId }, 'Audio playback ended on avatar');
        // Resolve pending audio promise if any
        if (this.pendingAudioResolve) {
          this.pendingAudioResolve();
          this.pendingAudioResolve = null;
          // Clear timeout since we resolved normally
          if (this.pendingAudioTimeout) {
            clearTimeout(this.pendingAudioTimeout);
            this.pendingAudioTimeout = null;
          }
        }
        this.callbacks.onAudioEnded?.();
        break;

      case 'audio_stopped':
        // User said "stop" (detected locally or via Recall) - treat same as audio_ended
        log.debug({ botId: this.botId, reason: (msg as { reason?: string }).reason }, 'Audio stopped by user');
        if (this.pendingAudioResolve) {
          this.pendingAudioResolve();
          this.pendingAudioResolve = null;
          if (this.pendingAudioTimeout) {
            clearTimeout(this.pendingAudioTimeout);
            this.pendingAudioTimeout = null;
          }
        }
        this.callbacks.onAudioEnded?.();
        break;

      case 'pong':
      case 'server_ping':
        // Heartbeat messages, ignore
        break;

      default:
        log.debug({ botId: this.botId, type: msg.type }, 'Unknown message type');
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    log.info({ botId: this.botId, delay: this.reconnectDelay }, 'Scheduling reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  /**
   * Send a message to the relay
   */
  private send(msg: RelayMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn({ botId: this.botId, type: msg.type }, 'Cannot send, not connected');
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Set avatar state (idle, listening, thinking, speaking, etc.)
   */
  setState(state: string, status?: string): void {
    log.info({ botId: this.botId, state, status }, 'setState called - sending to avatar');
    const msg: StateMessage = {
      v: 1,
      type: 'state',
      state,
      status,
    };
    this.send(msg);
  }

  /**
   * Play TTS audio on the avatar
   * @param keepAnimation - If true, don't switch to speaking animation (for wave/goodbye)
   * @param text - Optional spoken text for captions (displayed on audio.onplay, not on receipt)
   */
  playAudio(url: string, status?: string, keepAnimation?: boolean, text?: string): void {
    log.info({ botId: this.botId, urlLength: url?.length, status, keepAnimation, hasCaption: !!text }, 'playAudio called - sending to avatar');
    const msg: PlayAudioMessage = {
      v: 1,
      type: 'play_audio',
      url,
      status,
      keepAnimation,
      text,
    };
    this.send(msg);
    log.info({ botId: this.botId }, 'play_audio message sent');
  }

  /**
   * Play TTS audio on the avatar and wait for it to finish
   * Returns a promise that resolves when the audio ends
   * Times out after 30 seconds to prevent hanging
   * @param keepAnimation - If true, don't switch to speaking animation (for wave/goodbye)
   * @param text - Optional spoken text for captions (displayed on audio.onplay, not on receipt)
   */
  playAudioAndWait(url: string, status?: string, keepAnimation?: boolean, text?: string): Promise<void> {
    return new Promise((resolve) => {
      // Clear any existing pending audio state
      if (this.pendingAudioTimeout) {
        clearTimeout(this.pendingAudioTimeout);
      }
      
      // Set up resolver before sending
      this.pendingAudioResolve = resolve;
      
      // Send the audio
      this.playAudio(url, status, keepAnimation, text);
      
      // Timeout after 30 seconds (safety net)
      this.pendingAudioTimeout = setTimeout(() => {
        if (this.pendingAudioResolve) {
          log.warn({ botId: this.botId }, 'Audio playback timed out after 30s');
          this.pendingAudioResolve();
          this.pendingAudioResolve = null;
          this.pendingAudioTimeout = null;
        }
      }, 30000);
    });
  }

  /**
   * Trigger wave animation (on join)
   */
  wave(): void {
    log.info({ botId: this.botId }, 'Sending wave animation to avatar');
    this.send({ v: 1, type: 'wave' });
  }

  /**
   * Trigger celebration animation
   */
  celebrate(): void {
    log.info({ botId: this.botId }, 'Sending celebration animation to avatar');
    this.send({ v: 1, type: 'celebrate' });
  }

  /**
   * Trigger goodbye animation (before leaving)
   */
  goodbye(): void {
    log.info({ botId: this.botId }, 'Sending goodbye animation to avatar');
    this.send({ v: 1, type: 'goodbye' });
  }

  /**
   * Stop audio playback immediately (interrupt)
   * Sends stop command to avatar and resolves any pending audio promise
   */
  stopAudio(): void {
    log.info({ botId: this.botId }, 'Sending stop_audio to avatar');
    this.send({ v: 1, type: 'stop_audio' });

    // Resolve any pending audio promise immediately
    if (this.pendingAudioResolve) {
      this.pendingAudioResolve();
      this.pendingAudioResolve = null;
      if (this.pendingAudioTimeout) {
        clearTimeout(this.pendingAudioTimeout);
        this.pendingAudioTimeout = null;
      }
    }
  }

  /**
   * Toggle knowledge base access
   */
  setKnowledgeAccess(enabled: boolean): void {
    this.send({ v: 1, type: 'knowledge_access', enabled });
  }

  /**
   * Send ping (heartbeat)
   */
  ping(): void {
    this.send({ v: 1, type: 'ping' });
  }

  /**
   * Disconnect from the relay
   */
  disconnect(): void {
    log.info({ botId: this.botId }, 'Disconnecting from relay');
    
    this.shouldReconnect = false;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting');
      this.ws = null;
    }
    
    this.isConnected = false;
    this.isAuthenticated = false;
  }

  /**
   * Check if connected and authenticated
   */
  get connected(): boolean {
    return this.isConnected && this.isAuthenticated;
  }
}

// Active relay connections (one per bot)
const relayConnections = new Map<string, BotRelayClient>();

/**
 * Connect to a bot's relay
 */
export function connectToRelay(
  botId: string,
  sessionToken: string,
  relayUrl: string,
  callbacks: RelayClientCallbacks = {}
): BotRelayClient {
  // Close existing connection if any
  const existing = relayConnections.get(botId);
  if (existing) {
    existing.disconnect();
  }

  const client = new BotRelayClient(botId, sessionToken, relayUrl, callbacks);
  relayConnections.set(botId, client);
  client.connect();
  
  return client;
}

/**
 * Get active relay connection for a bot
 */
export function getRelayClient(botId: string): BotRelayClient | undefined {
  return relayConnections.get(botId);
}

/**
 * Disconnect from a bot's relay
 */
export function disconnectFromRelay(botId: string): void {
  const client = relayConnections.get(botId);
  if (client) {
    client.disconnect();
    relayConnections.delete(botId);
  }
}

/**
 * Disconnect from all relays
 */
export function disconnectAllRelays(): void {
  for (const [botId, client] of relayConnections) {
    client.disconnect();
    relayConnections.delete(botId);
  }
}
